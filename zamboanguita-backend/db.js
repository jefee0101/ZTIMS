/* The connection to Postgres (Supabase), and the small layer every route
 * reads and writes through.
 *
 * Why a layer at all, rather than SQL in every route: ZTIMS moved here from
 * MongoDB, and the pages were written against the JSON MongoDB produced —
 * `_id`, camelCase names, nested objects where a record points at another.
 * Keeping that shape in ONE place is what let the move leave all 15 pages
 * untouched. Rows come out as the same plain objects the routes always
 * handled, and go back in through `save()`, which writes only what changed —
 * the way Mongoose did, so two people editing different fields of the same
 * record cannot overwrite each other's change.
 *
 * Validation is in two places on purpose. The table definitions in models.js
 * reject bad values with a message a person can act on, before anything is
 * sent. The constraints in db/schema.sql are the guarantee underneath: they
 * hold whatever writes to the database, including a script or the Supabase
 * table editor.
 */
const { Pool, types } = require('pg');

// numeric (fees, amounts) and bigint (counts) arrive as strings by default,
// because they can exceed a JavaScript number. None of ZTIMS's can, and the
// pages do arithmetic on them, so they are numbers here.
types.setTypeParser(1700, value => (value === null ? null : Number(value)));
types.setTypeParser(20, value => (value === null ? null : Number(value)));
// A date column (a booking's preferred date) stays the 'YYYY-MM-DD' string the
// form sent. Turned into a Date it would be midnight UTC, which is the previous
// evening in some timezones — the exact bug the booking route avoids.
types.setTypeParser(1082, value => value);

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/ztims';

/* Supabase requires TLS. Its certificate is signed by Supabase's own
   authority rather than a public one, so full verification needs that
   authority's certificate: download it from the Supabase dashboard (Database
   settings → SSL certificate) and put its contents in DATABASE_CA_CERT.
   Without it the connection is still encrypted, only not verified.

   sslmode is removed from the URL before it is used. node-postgres lets a
   connection string's sslmode override the ssl settings given here, and it
   reads sslmode=require as "verify against the public authorities" — which
   Supabase's certificate fails. That is a well-known way to lose an afternoon. */
function connectionConfig(urlString) {
    const url = new URL(urlString);
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(key);

    const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    const ca = (process.env.DATABASE_CA_CERT || '').replace(/\\n/g, '\n').trim();
    const ssl = local || process.env.DATABASE_SSL === 'false'
        ? false
        : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };

    return { connectionString: url.toString(), ssl };
}

/* One small pool per running instance, created on first use and reused.

   On a serverless host every warm instance holds its own pool, so each is kept
   small. Supabase's pooler (port 6543, "transaction" mode) is what lets many
   instances share a modest number of real database connections; use that
   connection string for the deployed API. node-postgres never uses named
   prepared statements unless told to, which is what transaction mode needs. */
let pool = null;

function getPool() {
    if (pool) return pool;
    pool = new Pool({
        ...connectionConfig(DATABASE_URL),
        max: 3,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 10000,
        // Lets a script (migrate, copy) finish without an explicit close.
        allowExitOnIdle: true
    });
    // An idle connection dropped by the server is not a request failing; the
    // pool replaces it. Logged, so it is not mistaken for silence.
    pool.on('error', error => console.error('⚠️  Idle database connection closed:', error.message));
    return pool;
}

function query(text, params, client) {
    return (client || getPool()).query(text, params);
}

/* Several statements that must succeed or fail together. */
async function transaction(work) {
    const client = await getPool().connect();
    try {
        await client.query('begin');
        const result = await work(client);
        await client.query('commit');
        return result;
    } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function closePool() {
    if (!pool) return;
    const closing = pool;
    pool = null;
    await closing.end();
}

const describeDatabase = () => {
    try {
        const url = new URL(DATABASE_URL);
        return `${url.hostname}:${url.port || 5432}${url.pathname}`;
    } catch {
        return 'an unreadable DATABASE_URL';
    }
};


/* ---------------------------------------------------------------------------
   Errors: the same shapes the routes already handled from Mongoose.
   ------------------------------------------------------------------------ */

function validationError(message, key) {
    const error = new Error(message);
    error.name = 'ValidationError';
    error.errors = key ? { [key]: { message } } : {};
    return error;
}

/* Messages for constraint names in db/schema.sql, for the cases the table
   definitions do not catch first (a script, a race, a bug). */
const CONSTRAINT_MESSAGES = {
    spots_images_max: 'A spot can have at most 30 photos.',
    spots_coordinates_pair: 'Pick the location on the map — latitude and longitude must be a valid pair.',
    spots_managed_by_fkey: 'That establishment account does not exist.',
    tourist_guide_spots_spot_id_fkey: 'One of the assigned destinations no longer exists.',
    guide_bookings_spot_id_fkey: 'That destination could not be found.',
    guide_bookings_guide_id_fkey: 'That guide record no longer exists.',
    payments_booking_id_fkey: 'That booking no longer exists.',
    payments_booking_id_key: 'Payment for that booking was already recorded.'
};

/* Turns a Postgres error into what the routes expect:
     unique violation     → { code: 11000, keyPattern }  (MongoDB's duplicate key)
     a row still in use   → { code: 'STILL_REFERENCED' } (answered with 409)
     anything invalid     → a ValidationError            (answered with 400)
   Anything else passes through untouched. */
function normaliseDbError(error, table) {
    if (!error || typeof error.code !== 'string' || error.name === 'ValidationError') return error;
    const keyFor = column => (table && table.keyForColumn(column)) || column;

    if (error.code === '23505') {
        const column = (/Key \(([^)]+)\)/.exec(error.detail || '') || [])[1] || 'value';
        const key = keyFor(column);
        const specific = CONSTRAINT_MESSAGES[error.constraint];
        return Object.assign(new Error(specific || `That ${key} is already registered.`), {
            code: 11000, keyPattern: { [key]: 1 }, specific, cause: error
        });
    }
    if (error.code === '23503') {
        if (/still referenced/i.test(error.detail || '')) {
            return Object.assign(new Error('This record is still in use elsewhere, so it cannot be deleted.'), {
                code: 'STILL_REFERENCED', cause: error
            });
        }
        const column = (/Key \(([^)]+)\)/.exec(error.detail || '') || [])[1];
        return validationError(CONSTRAINT_MESSAGES[error.constraint] || `That ${keyFor(column || 'reference')} does not exist.`, column && keyFor(column));
    }
    if (error.code === '23514') {
        return validationError(CONSTRAINT_MESSAGES[error.constraint] || `That value is not allowed (${error.constraint}).`);
    }
    if (error.code === '23502') {
        const key = keyFor(error.column || 'value');
        return validationError(`Path \`${key}\` is required.`, key);
    }
    // Invalid text for a number, date, time, and so on.
    if (/^22/.test(error.code)) {
        return validationError(`Some of those details are not valid: ${error.message}`);
    }
    return error;
}


/* ---------------------------------------------------------------------------
   Field types: how a value from a request becomes a column value, the way
   Mongoose cast it — and refusing, with a readable message, what it refused.
   ------------------------------------------------------------------------ */

const TRUE_VALUES = new Set([true, 'true', 1, '1', 'yes']);
const FALSE_VALUES = new Set([false, 'false', 0, '0', 'no']);

function castField(key, spec, value) {
    const blank = value === undefined || value === null || (spec.type !== 'string' && value === '');

    if (blank) {
        if (spec.nullable) return null;
        if (spec.required) throw validationError(spec.requiredMessage || `Path \`${key}\` is required.`, key);
        if (spec.default !== undefined) return typeof spec.default === 'function' ? spec.default() : spec.default;
        throw validationError(`Path \`${key}\` is required.`, key);
    }

    switch (spec.type) {
        case 'string': {
            let text = String(value);
            if (spec.trim) text = text.trim();
            if (spec.lowercase) text = text.toLowerCase();
            if (spec.uppercase) text = text.toUpperCase();
            if (spec.required && text === '') {
                throw validationError(spec.requiredMessage || `Path \`${key}\` is required.`, key);
            }
            if (spec.enum && !spec.enum.includes(text)) {
                throw validationError(`\`${text}\` is not a valid enum value for path \`${key}\`.`, key);
            }
            if (spec.maxlength && text.length > spec.maxlength) {
                throw validationError(`Path \`${key}\` is longer than the maximum allowed length (${spec.maxlength}).`, key);
            }
            return text;
        }
        case 'number':
        case 'integer': {
            const number = Number(value);
            if (!Number.isFinite(number) || typeof value === 'boolean') {
                throw validationError(`Cast to Number failed for value "${value}" at path "${key}"`, key);
            }
            if (spec.type === 'integer' && !Number.isInteger(number)) {
                throw validationError(`Path \`${key}\` must be a whole number.`, key);
            }
            if (spec.min !== undefined && number < spec.min) {
                throw validationError(`Path \`${key}\` (${number}) is less than minimum allowed value (${spec.min}).`, key);
            }
            if (spec.max !== undefined && number > spec.max) {
                throw validationError(`Path \`${key}\` (${number}) is more than maximum allowed value (${spec.max}).`, key);
            }
            return number;
        }
        case 'boolean':
            if (TRUE_VALUES.has(value)) return true;
            if (FALSE_VALUES.has(value)) return false;
            throw validationError(`Cast to Boolean failed for value "${value}" at path "${key}"`, key);
        case 'date': {
            const date = value instanceof Date ? value : new Date(value);
            if (Number.isNaN(date.getTime())) throw validationError(`Cast to date failed for value "${value}" at path "${key}"`, key);
            return date;
        }
        case 'strings': {
            if (!Array.isArray(value)) throw validationError(`Path \`${key}\` must be a list.`, key);
            const list = value.map(item => String(item));
            if (spec.maxItems !== undefined && list.length > spec.maxItems) {
                throw validationError(spec.maxItemsMessage || `Path \`${key}\` has too many items.`, key);
            }
            return list;
        }
        case 'id':
            return idOf(value);
        default:
            return value;
    }
}

/* A reference may be the id itself, or the record it points at — a route that
   read a booking with its guide filled in, then saved it, hands back the whole
   guide. Mongoose accepted both; so does this. */
const idOf = value => (value && typeof value === 'object' && '_id' in value ? String(value._id) : String(value));

const sameValue = (a, b) => {
    if (a instanceof Date || b instanceof Date) {
        return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
    }
    return a === b;
};

const copyValue = value => (Array.isArray(value) ? value.slice() : value instanceof Date ? new Date(value) : value);

const isId = value => /^[0-9a-f]{24}$/i.test(String(value || ''));


/* ---------------------------------------------------------------------------
   A table.
   ------------------------------------------------------------------------ */

const IMPLICIT = { _id: 'id', createdAt: 'created_at', updatedAt: 'updated_at' };

// What each record looked like when it was read, so save() can tell what changed.
// Held outside the record, so it never appears in a response.
const snapshots = new WeakMap();

class Table {
    /**
     * @param name    the table in db/schema.sql
     * @param fields  { key: spec } — key is the name the API uses, spec.column
     *                the column (derived from the key when not given)
     * @param secret  keys never read unless asked for: password hashes and
     *                reset tokens, the equivalent of Mongoose's select: false
     */
    constructor(name, fields, { secret = [] } = {}) {
        this.name = name;
        this.fields = {};
        for (const [key, spec] of Object.entries(fields)) {
            this.fields[key] = { ...spec, column: spec.column || key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()) };
        }
        this.secret = new Set(secret);
        this.columnToKey = new Map([
            ...Object.entries(IMPLICIT).map(([key, column]) => [column, key]),
            ...Object.entries(this.fields).map(([key, spec]) => [spec.column, key])
        ]);
    }

    keyForColumn(column) {
        return this.columnToKey.get(column);
    }

    columnFor(key) {
        if (IMPLICIT[key]) return IMPLICIT[key];
        const spec = this.fields[key];
        if (!spec) throw new Error(`${this.name} has no field "${key}"`);
        return spec.column;
    }

    /* A row as the API has always shaped it. */
    fromRow(row, { secrets = false } = {}) {
        if (!row) return null;
        const doc = { _id: row.id };
        for (const [key, spec] of Object.entries(this.fields)) {
            if (this.secret.has(key) && !secrets) continue;
            if (spec.column in row) doc[key] = row[spec.column];
        }
        if ('created_at' in row) doc.createdAt = row.created_at;
        if ('updated_at' in row) doc.updatedAt = row.updated_at;
        this.remember(doc);
        return doc;
    }

    remember(doc) {
        const snapshot = {};
        for (const key of Object.keys(this.fields)) snapshot[key] = copyValue(doc[key]);
        snapshots.set(doc, snapshot);
    }

    /* { key: value } filters, joined with AND.
         value           equals (null means IS NULL)
         { in: [...] }   one of
         { ne: value }   not equal
         { like: '…' }   SQL LIKE */
    where(filters = {}, params = [], alias = '') {
        const prefix = alias ? alias + '.' : '';
        const clauses = [];
        for (const [key, condition] of Object.entries(filters)) {
            if (condition === undefined) continue;
            const column = prefix + this.columnFor(key);
            if (condition === null) {
                clauses.push(`${column} is null`);
            } else if (typeof condition === 'object' && !(condition instanceof Date) && !Array.isArray(condition)) {
                if ('in' in condition) {
                    params.push(condition.in.map(String));
                    clauses.push(`${column} = any($${params.length})`);
                }
                if ('ne' in condition) {
                    params.push(condition.ne);
                    clauses.push(`${column} is distinct from $${params.length}`);
                }
                if ('like' in condition) {
                    params.push(condition.like);
                    clauses.push(`${column} like $${params.length}`);
                }
            } else {
                params.push(condition);
                clauses.push(`${column} = $${params.length}`);
            }
        }
        return { sql: clauses.length ? ' where ' + clauses.join(' and ') : '', params };
    }

    orderBy(sort) {
        if (!sort) return '';
        return ' order by ' + Object.entries(sort)
            .map(([key, direction]) => `${this.columnFor(key)} ${direction < 0 ? 'desc' : 'asc'}`)
            .join(', ');
    }

    async find(filters = {}, { sort, limit, secrets = false, client } = {}) {
        const { sql, params } = this.where(filters);
        let text = `select * from ${this.name}${sql}${this.orderBy(sort)}`;
        if (limit) text += ` limit ${Math.floor(limit)}`;
        const { rows } = await query(text, params, client);
        return rows.map(row => this.fromRow(row, { secrets }));
    }

    async findOne(filters = {}, options = {}) {
        const [doc] = await this.find(filters, { ...options, limit: 1 });
        return doc || null;
    }

    async findById(id, options = {}) {
        // An id that could never exist is simply not found — MongoDB threw here.
        if (!isId(id)) return null;
        return this.findOne({ _id: String(id) }, options);
    }

    async count(filters = {}, { client } = {}) {
        const { sql, params } = this.where(filters);
        const { rows } = await query(`select count(*)::int as n from ${this.name}${sql}`, params, client);
        return rows[0].n;
    }

    /* Casts every field the caller supplied, and every required one. */
    valuesForInsert(values) {
        const columns = [];
        const params = [];
        if (values._id !== undefined && values._id !== null) {
            columns.push('id');
            params.push(String(values._id));
        }
        for (const [key, spec] of Object.entries(this.fields)) {
            if (values[key] === undefined && !spec.required) continue;
            columns.push(spec.column);
            params.push(castField(key, spec, values[key]));
        }
        return { columns, params };
    }

    async create(values, { client, secrets = false } = {}) {
        const { columns, params } = this.valuesForInsert(values);
        const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
        const text = columns.length
            ? `insert into ${this.name} (${columns.join(', ')}) values (${placeholders}) returning *`
            : `insert into ${this.name} default values returning *`;
        try {
            const { rows } = await query(text, params, client);
            return this.fromRow(rows[0], { secrets: secrets || Object.keys(values).some(key => this.secret.has(key)) });
        } catch (error) {
            throw normaliseDbError(error, this);
        }
    }

    /* Writes what changed since the record was read, and refreshes it in place —
       as a Mongoose document's save() did. Nothing changed: nothing is sent. */
    async save(doc, { client } = {}) {
        const snapshot = snapshots.get(doc);
        if (!snapshot) throw new Error(`save() needs a record read from ${this.name}; use create() for a new one.`);

        const sets = [];
        const params = [];
        for (const [key, spec] of Object.entries(this.fields)) {
            if (!(key in doc) && !(key in snapshot)) continue;
            const current = spec.type === 'id' && doc[key] != null ? idOf(doc[key]) : doc[key];
            const before = spec.type === 'id' && snapshot[key] != null ? idOf(snapshot[key]) : snapshot[key];
            if (sameValue(current, before)) continue;
            params.push(castField(key, spec, doc[key]));
            sets.push(`${spec.column} = $${params.length}`);
        }
        if (!sets.length) return doc;

        params.push(doc._id);
        try {
            const { rows } = await query(
                `update ${this.name} set ${sets.join(', ')} where id = $${params.length} returning *`,
                params, client
            );
            if (!rows[0]) throw validationError(`That ${this.name.replace(/_/g, ' ').replace(/s$/, '')} no longer exists.`);
            const withSecrets = [...this.secret].some(key => key in doc);
            const fresh = this.fromRow(rows[0], { secrets: withSecrets });
            // A reference that was filled in with the record it points at stays
            // filled in, as long as it still points there — Mongoose kept a
            // populated path populated across save(), and replies rely on it.
            for (const [key, spec] of Object.entries(this.fields)) {
                const held = doc[key];
                if (spec.type === 'id' && held && typeof held === 'object' && idOf(held) === fresh[key]) fresh[key] = held;
            }
            Object.assign(doc, fresh);
            this.remember(doc);
            return doc;
        } catch (error) {
            throw normaliseDbError(error, this);
        }
    }

    async deleteById(id, { client } = {}) {
        try {
            const { rowCount } = await query(`delete from ${this.name} where id = $1`, [String(id)], client);
            return rowCount > 0;
        } catch (error) {
            throw normaliseDbError(error, this);
        }
    }
}

module.exports = {
    query,
    transaction,
    getPool,
    closePool,
    describeDatabase,
    Table,
    castField,
    normaliseDbError,
    validationError,
    isId,
    DATABASE_URL
};
