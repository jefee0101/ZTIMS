/* ZTIMS's records, as the API reads and writes them.
 *
 * Each definition mirrors a Mongoose schema that used to live in server.js,
 * field for field: same names, same defaults, same limits, same messages. The
 * columns underneath are in db/schema.sql. Where a route needs a record
 * together with the one it points at — a listing with its establishment, a
 * booking with its destination and guide — the query is written out here, so
 * the joins are in one place and the routes keep their shape.
 */
const { Table, query, transaction, normaliseDbError, isId } = require('./db');

const text = (options = {}) => ({ type: 'string', default: '', ...options });
const required = (options = {}) => ({ type: 'string', required: true, ...options });
const number = (options = {}) => ({ type: 'number', default: 0, ...options });
const flag = (defaultValue, options = {}) => ({ type: 'boolean', default: defaultValue, ...options });
const when = () => ({ type: 'date', nullable: true });
const ref = () => ({ type: 'id', nullable: true });

const MAX_SPOT_IMAGES = 30;
const GUIDE_STATUSES = ['available', 'unavailable', 'inactive'];
// A guide's jurisdiction: the whole municipality, or one barangay.
const GUIDE_SCOPES = ['municipal', 'barangay'];
const GUIDE_REPORT_TYPES = ['tour_completed', 'headcount', 'incident', 'tourist_feedback'];
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MAX_GUIDE_LANGUAGES = 20;
const BOOKING_STATUSES = ['pending_payment', 'confirmed', 'cancelled', 'completed', 'no_show'];
const FEEDBACK_TOPICS = ['suggestion', 'listing', 'problem', 'booking', 'other'];
const FEEDBACK_STATUSES = ['new', 'read', 'resolved'];
const FEEDBACK_MESSAGE_MAX = 2000;

const email = () => required({ trim: true, lowercase: true });
const passwordHash = () => required({ column: 'password_hash' });
const resetFields = {
    resetTokenHash: { type: 'string', nullable: true },
    resetTokenExpires: when()
};
const SECRET = ['password', 'resetTokenHash', 'resetTokenExpires'];

/* Tourism Officers. MongoDB called this collection `admins`; the role is still
   'admin' in sign-in tokens, since changing that would sign everyone out. */
const officers = new Table('tourism_officers', {
    email: email(),
    password: passwordHash(),
    ...resetFields
}, { secret: SECRET });

/* Tourist Establishment Managers. MongoDB's `resortOwners`. */
const managers = new Table('establishment_managers', {
    email: email(),
    password: passwordHash(),
    establishmentName: required({ trim: true, requiredMessage: 'An establishment name is required.' }),
    managerName: text({ trim: true }),
    contactEmail: text({ trim: true, lowercase: true }),
    phone: text(),
    active: flag(true),
    operationalStatus: text({ default: 'active', enum: ['active', 'inactive', 'closed'] }),
    statusNeedsReview: flag(false),
    statusNote: text(),
    statusUpdatedAt: when(),
    ...resetFields
}, { secret: SECRET });

const spots = new Table('spots', {
    title: required(),
    location: required({ requiredMessage: 'Fill in the Location Information so the listing has a place to show.' }),
    category: required(),
    description: required(),
    imageUrl: text(),
    images: {
        type: 'strings', default: () => [], maxItems: MAX_SPOT_IMAGES,
        maxItemsMessage: `A spot can have at most ${MAX_SPOT_IMAGES} photos.`
    },
    bookingUrl: text(),
    type: text({ default: 'spot', enum: ['spot', 'accommodation'] }),
    label: text(),
    workingDays: text({ default: 'Everyday' }),
    workingTime: text({ default: 'All Day' }),
    travelFee: number(),
    entranceFee: number(),
    address: text(),
    barangay: text(),
    municipality: text({ default: 'Zamboanguita' }),
    province: text({ default: 'Negros Oriental' }),
    latitude: { type: 'number', nullable: true, min: -90, max: 90 },
    longitude: { type: 'number', nullable: true, min: -180, max: 180 },
    managedBy: ref(),
    status: text({ default: 'published', enum: ['published', 'unpublished', 'archived'] }),
    statusNote: text(),
    statusUpdatedAt: when(),
    requiresGuide: flag(false),
    // Attraction setup (see schema.sql): null means that price is not offered.
    studentFee: { type: 'number', nullable: true, min: 0 },
    childFee: { type: 'number', nullable: true, min: 0 },
    childAgeMax: { type: 'integer', nullable: true, min: 1, max: 17 },
    cancelKeepPercent: number({ min: 0, max: 100 })
});

/* The establishment's details a listing is allowed to carry. Never the
   sign-in email, never anything secret: GET /api/spots/:id is public. */
const MANAGER_SUMMARY = `case when m.id is null then null else jsonb_build_object(
    '_id', m.id,
    'establishmentName', m.establishment_name,
    'managerName', m.manager_name,
    'contactEmail', m.contact_email,
    'phone', m.phone,
    'active', m.active,
    'operationalStatus', m.operational_status
) end as manager_summary`;

/* Listings with their establishment's summary in managedBy, as Mongoose's
   populate() gave them, newest first. */
spots.findWithManagers = async function (filters = {}, { limit } = {}) {
    const { sql, params } = spots.where(filters, [], 's');
    let statement = `select s.*, ${MANAGER_SUMMARY}
        from spots s left join establishment_managers m on m.id = s.managed_by${sql}
        order by s.created_at desc`;
    if (limit) statement += ` limit ${Math.floor(limit)}`;
    const { rows } = await query(statement, params);
    return rows.map(row => {
        const spot = spots.fromRow(row);
        spot.managedBy = row.manager_summary;
        return spot;
    });
};

spots.findByIdWithManager = async function (id) {
    if (!isId(id)) return null;
    const [spot] = await spots.findWithManagers({ _id: String(id) }, { limit: 1 });
    return spot || null;
};

/* Tourist guides: records the Tourism Office keeps. A guide may also hold a
   sign-in for the guide portal — email and password are null until the office
   issues one, never '' (the unique index would let only one guide be blank). */
const guides = new Table('tourist_guides', {
    fullName: required({ trim: true }),
    photoUrl: text(),
    contactNumber: text(),
    location: text(),
    bio: text(),
    guideFee: number({ min: 0 }),
    maxGroupSize: { type: 'integer', default: 1, min: 1 },
    status: text({ default: 'available', enum: GUIDE_STATUSES }),
    // The guide's jurisdiction. `barangay` is set only for a barangay scope.
    scope: text({ default: 'municipal', enum: GUIDE_SCOPES }),
    barangay: text({ trim: true }),
    availableDays: { type: 'strings', default: () => WEEKDAYS.slice() },
    email: { type: 'string', nullable: true, trim: true, lowercase: true },
    password: { type: 'string', nullable: true, column: 'password_hash' },
    ...resetFields
}, { secret: SECRET });

/* A guide's assignedSpots live in their own table (tourist_guide_spots), so
   every entry is a destination that exists. Read and written with the guide,
   so to the routes it is still just a list of spot ids on the record. */
async function attachAssignedSpots(list, client) {
    if (!list.length) return list;
    const { rows } = await query(
        `select guide_id, spot_id from tourist_guide_spots where guide_id = any($1) order by position, spot_id`,
        [list.map(guide => guide._id)], client
    );
    const byGuide = new Map(list.map(guide => [guide._id, []]));
    for (const row of rows) byGuide.get(row.guide_id).push(row.spot_id);
    for (const guide of list) {
        guide.assignedSpots = byGuide.get(guide._id);
        guides.rememberAssigned(guide);
    }
    return list;
}

const assignedSnapshots = new WeakMap();
guides.rememberAssigned = guide => assignedSnapshots.set(guide, (guide.assignedSpots || []).slice());

async function writeAssignedSpots(guide, client) {
    const wanted = [...new Set((guide.assignedSpots || []).map(String))];
    await query(`delete from tourist_guide_spots where guide_id = $1`, [guide._id], client);
    if (wanted.length) {
        await query(
            `insert into tourist_guide_spots (guide_id, spot_id, position)
             select $1, spot_id, ordinality - 1 from unnest($2::text[]) with ordinality as t(spot_id, ordinality)`,
            [guide._id, wanted], client
        );
    }
    guide.assignedSpots = wanted;
}

const tableFind = Table.prototype.find;
guides.find = async function (filters = {}, options = {}) {
    // Filtering by a destination goes through the assignments table.
    const { assignedSpots: spotId, ...rest } = filters;
    let list;
    if (spotId !== undefined) {
        const { sql, params } = guides.where(rest, [String(spotId)], 'g');
        const joined = `select g.* from tourist_guides g
            join tourist_guide_spots a on a.guide_id = g.id and a.spot_id = $1${sql}`;
        const { rows } = await query(joined + guides.orderBy(options.sort), params, options.client);
        list = rows.map(row => guides.fromRow(row));
    } else {
        list = await tableFind.call(guides, rest, options);
    }
    return attachAssignedSpots(list, options.client);
};

const tableCreate = Table.prototype.create;
guides.create = async function (values) {
    return transaction(async client => {
        const guide = await tableCreate.call(guides, values, { client });
        guide.assignedSpots = values.assignedSpots || [];
        try {
            await writeAssignedSpots(guide, client);
        } catch (error) {
            throw normaliseDbError(error, guides);
        }
        guides.rememberAssigned(guide);
        return guide;
    });
};

const tableSave = Table.prototype.save;
guides.save = async function (guide) {
    return transaction(async client => {
        await tableSave.call(guides, guide, { client });
        const before = assignedSnapshots.get(guide) || [];
        const now = (guide.assignedSpots || []).map(String);
        if (before.length !== now.length || before.some((id, i) => id !== now[i])) {
            try {
                await writeAssignedSpots(guide, client);
            } catch (error) {
                throw normaliseDbError(error, guides);
            }
        }
        guides.rememberAssigned(guide);
        return guide;
    });
};

/* Every guide, with the destinations they serve summarised, by name. */
guides.listWithSpots = async function () {
    const { rows } = await query(`
        select g.*, coalesce((
            select jsonb_agg(jsonb_build_object('_id', s.id, 'title', s.title, 'location', s.location, 'status', s.status)
                             order by a.position, s.id)
            from tourist_guide_spots a join spots s on s.id = a.spot_id
            where a.guide_id = g.id
        ), '[]'::jsonb) as assigned,
        ${LANGUAGE_NAMES} as language_names
        from tourist_guides g
        order by g.full_name asc`);
    return rows.map(row => {
        const guide = guides.fromRow(row);
        guide.assignedSpots = row.assigned;
        // Whether a sign-in has been issued — never the hash itself.
        guide.hasAccount = row.password_hash != null;
        guide.languages = row.language_names;
        return guide;
    });
};

/* ---- Languages: languages + guide_languages ---------------------------------
   Written and read here, explicitly, rather than as a field on the guide: a
   guide's languages are rows in a join table, not a column save() could diff. */

// The same expression listWithSpots selects, so every guide read agrees.
const LANGUAGE_NAMES = `coalesce((
    select jsonb_agg(l.name order by lower(l.name))
    from guide_languages gl join languages l on l.id = gl.language_id
    where gl.guide_id = g.id
), '[]'::jsonb)`;

async function languagesOf(guideId, client) {
    const { rows } = await query(
        `select l.name from guide_languages gl join languages l on l.id = gl.language_id
         where gl.guide_id = $1 order by lower(l.name)`, [String(guideId)], client);
    return rows.map(row => row.name);
}

/* Replaces a guide's languages with `names` (already cleaned: trimmed, each
   once). A language nobody has listed before is added to `languages`; one
   already there is matched whatever its capitalisation, so the office's search
   finds "Korean" however it was typed. */
async function setGuideLanguages(guideId, names) {
    return transaction(async client => {
        await query(`delete from guide_languages where guide_id = $1`, [String(guideId)], client);
        for (const name of names) {
            const { rows } = await query(
                `insert into languages (name) values ($1)
                 on conflict (lower(name)) do update set name = languages.name
                 returning id`, [name], client);
            await query(
                `insert into guide_languages (guide_id, language_id) values ($1, $2) on conflict do nothing`,
                [String(guideId), rows[0].id], client);
        }
        return languagesOf(guideId, client);
    });
}

/* Guides who speak a language (matched whatever its capitalisation), with
   their languages filled in. Availability on a date is the caller's to judge. */
async function findGuidesSpeaking(language) {
    const { rows } = await query(`
        select g.*, ${LANGUAGE_NAMES} as language_names
        from tourist_guides g
        where exists (
            select 1 from guide_languages gl join languages l on l.id = gl.language_id
            where gl.guide_id = g.id and lower(l.name) = lower($1)
        )
        order by g.full_name asc`, [String(language).trim()]);
    const list = rows.map(row => {
        const guide = guides.fromRow(row);
        guide.languages = row.language_names;
        return guide;
    });
    return attachAssignedSpots(list);
}

/* What guides report to the office. */
const reports = new Table('guide_reports', {
    guideId: { type: 'id', required: true },
    bookingId: ref(),
    reportType: required({ enum: GUIDE_REPORT_TYPES }),
    reportDate: required(),      // YYYY-MM-DD
    headcount: { type: 'integer', nullable: true, min: 0 },
    barangay: text({ trim: true }),
    details: text({ trim: true, maxlength: 2000 }),
    status: text({ default: 'new', enum: ['new', 'reviewed'] }),
    reviewedByEmail: text(),
    reviewedAt: when()
});

/* Every report, newest first, with the guide and destination named — the
   office's inbox and the source of its per-barangay rollup. */
reports.listForOffice = async function (filters = {}) {
    const { sql, params } = reports.where(filters, [], 'r');
    const { rows } = await query(`
        select r.*, g.full_name as guide_name, g.scope as guide_scope, g.barangay as guide_barangay,
               b.reference as booking_reference, s.title as spot_title
        from guide_reports r
        join tourist_guides g on g.id = r.guide_id
        left join guide_bookings b on b.id = r.booking_id
        left join spots s on s.id = b.spot_id${sql}
        order by r.report_date desc, r.created_at desc
        limit 1000`, params);
    return rows.map(row => ({
        ...reports.fromRow(row),
        guide: { _id: row.guide_id, fullName: row.guide_name, scope: row.guide_scope, barangay: row.guide_barangay },
        bookingReference: row.booking_reference || '',
        spotTitle: row.spot_title || ''
    }));
};

const bookings = new Table('guide_bookings', {
    reference: required(),
    spotId: { type: 'id', required: true },
    guideId: ref(),
    fullName: required({ trim: true }),
    contactNumber: required({ trim: true }),
    email: required({ trim: true, lowercase: true }),
    nationality: text({ trim: true, uppercase: true }),
    visitors: { type: 'integer', required: true, min: 1 },
    preferredDate: required(),   // YYYY-MM-DD, stored as a date, read back as the same text
    preferredTime: required(),   // HH:MM, 24-hour
    notes: text(),
    status: text({ default: 'pending_payment', enum: BOOKING_STATUSES }),
    statusNote: text(),
    statusUpdatedAt: when(),
    isDemo: flag(false)
});

/* The Tourism Office's booking list: destination and guide summarised in
   spotId and guideId, as populate() gave them, newest first. */
bookings.listForOffice = async function (filters = {}, { limit = 500 } = {}) {
    const { sql, params } = bookings.where(filters, [], 'b');
    const { rows } = await query(`
        select b.*,
            jsonb_build_object('_id', s.id, 'title', s.title, 'location', s.location) as spot_summary,
            case when g.id is null then null else jsonb_build_object(
                '_id', g.id, 'fullName', g.full_name, 'contactNumber', g.contact_number,
                'guideFee', g.guide_fee, 'maxGroupSize', g.max_group_size, 'status', g.status
            ) end as guide_summary
        from guide_bookings b
        join spots s on s.id = b.spot_id
        left join tourist_guides g on g.id = b.guide_id${sql}
        order by b.created_at desc
        limit ${Math.floor(limit)}`, params);
    return rows.map(row => {
        const booking = bookings.fromRow(row);
        booking.spotId = row.spot_summary;
        booking.guideId = row.guide_summary;
        return booking;
    });
};

/* The highest reference issued with this prefix, or null. */
bookings.latestReference = async function (prefix) {
    const { rows } = await query(
        `select reference from guide_bookings where reference like $1 order by reference desc limit 1`,
        [prefix + '%']
    );
    return rows[0] ? rows[0].reference : null;
};

/* The bookings assigned to one guide, oldest date first, with the destination
   named. What a guide needs to meet their visitors — never the visitor's email,
   and nothing about the payment. */
bookings.listForGuide = async function (guideId) {
    const { rows } = await query(`
        select b.id, b.reference, b.full_name, b.contact_number, b.nationality, b.visitors,
               b.preferred_date, b.preferred_time, b.notes, b.status, b.created_at,
               s.id as spot_id, s.title as spot_title, s.location as spot_location
        from guide_bookings b
        join spots s on s.id = b.spot_id
        where b.guide_id = $1
        order by b.preferred_date asc, b.preferred_time asc`, [String(guideId)]);
    return rows.map(row => ({
        _id: row.id,
        reference: row.reference,
        fullName: row.full_name,
        contactNumber: row.contact_number,
        nationality: row.nationality,
        visitors: row.visitors,
        preferredDate: row.preferred_date,
        preferredTime: row.preferred_time,
        notes: row.notes,
        status: row.status,
        createdAt: row.created_at,
        spot: { _id: row.spot_id, title: row.spot_title, location: row.spot_location }
    }));
};

/* Every guide booking inside a jurisdiction — one barangay, or the whole
   municipality when `barangay` is null — for a guide's dashboard. Deliberately
   no visitor name, phone or email: only the guide a booking is assigned to
   sees who it is for (listForGuide above). Matched on the destination's
   barangay, case- and space-insensitively, as the office's forms may differ. */
bookings.listInJurisdiction = async function (barangay) {
    const params = [];
    let where = '';
    if (barangay !== null && barangay !== undefined) {
        params.push(String(barangay));
        where = ` where lower(btrim(s.barangay)) = lower(btrim($1))`;
    }
    const { rows } = await query(`
        select b.id, b.status, b.visitors, b.nationality, b.preferred_date, b.guide_id,
               s.id as spot_id, s.title as spot_title, s.barangay as spot_barangay
        from guide_bookings b join spots s on s.id = b.spot_id${where}`, params);
    return rows.map(row => ({
        _id: row.id,
        status: row.status,
        visitors: row.visitors,
        nationality: row.nationality,
        preferredDate: row.preferred_date,
        guideId: row.guide_id,
        spot: { _id: row.spot_id, title: row.spot_title, barangay: row.spot_barangay }
    }));
};

bookings.findByReferenceWithSpot = async function (reference) {
    const { rows } = await query(
        `select b.*, s.title as spot_title from guide_bookings b join spots s on s.id = b.spot_id where b.reference = $1`,
        [reference]
    );
    if (!rows[0]) return null;
    const booking = bookings.fromRow(rows[0]);
    booking.spotId = { _id: rows[0].spot_id, title: rows[0].spot_title };
    return booking;
};

const payments = new Table('payments', {
    // For one booking or one ticket, never both (payments_for_one).
    bookingId: ref(),
    ticketId: ref(),
    amount: { type: 'number', required: true, min: 0 },
    method: text({ default: 'cash' }),
    receiptNumber: text(),
    paidAt: { type: 'date', default: () => new Date() },
    recordedBy: ref(),
    recordedByEmail: text(),
    remarks: text(),
    // 'counter' (cash taken at the office) or 'online' (the gateway, test mode).
    channel: text({ default: 'counter', enum: ['counter', 'online'] }),
    gatewayRef: text(),
    refundedAt: when(),
    refundReason: text(),
    refundedByEmail: text(),
    isDemo: flag(false)
});

/* An entrance ticket to an attraction the office runs. */
const tickets = new Table('tickets', {
    code: required(),
    spotId: { type: 'id', required: true },
    visitDate: required(),   // YYYY-MM-DD
    people: { type: 'integer', required: true, min: 1 },
    unitFee: { type: 'number', required: true, min: 0 },
    amount: { type: 'number', required: true, min: 0 },
    fullName: required({ trim: true }),
    email: required({ trim: true, lowercase: true }),
    contactNumber: text({ trim: true }),
    status: text({ default: 'pending_payment', enum: ['pending_payment', 'valid', 'used', 'cancelled', 'expired'] }),
    usedAt: when(),
    usedByEmail: text(),
    isDemo: flag(false),
    // How many of each kind of visitor; they add up to `people`.
    countRegular: { type: 'integer', default: 0, min: 0 },
    countSenior: { type: 'integer', default: 0, min: 0 },
    countPwd: { type: 'integer', default: 0, min: 0 },
    countStudent: { type: 'integer', default: 0, min: 0 },
    countChild: { type: 'integer', default: 0, min: 0 },
    // The price each kind paid per person when the ticket was bought.
    feeBreakdown: { type: 'json', default: () => ({}) }
});

/* A date a destination is shut. */
const closedDates = new Table('spot_closed_dates', {
    spotId: { type: 'id', required: true },
    closedDate: required(),   // YYYY-MM-DD
    reason: text({ trim: true, maxlength: 200 }),
    createdByEmail: text()
});

/* One trip to the payment gateway's checkout page. */
const checkouts = new Table('online_checkouts', {
    kind: required({ enum: ['guide_booking', 'ticket'] }),
    bookingId: ref(),
    ticketId: ref(),
    amount: { type: 'number', required: true, min: 0 },
    sessionId: text(),
    checkoutUrl: text(),
    status: text({ default: 'pending', enum: ['pending', 'paid', 'expired', 'duplicate'] }),
    method: text(),
    paymentRef: text(),
    expiresAt: { type: 'date', required: true },
    paidAt: when(),
    isDemo: flag(true)
});

const feedback = new Table('feedback', {
    topic: text({ default: 'other', enum: FEEDBACK_TOPICS }),
    message: required({ trim: true, maxlength: FEEDBACK_MESSAGE_MAX }),
    name: text({ trim: true, maxlength: 120 }),
    email: text({ trim: true, lowercase: true, maxlength: 254 }),
    page: text({ trim: true, maxlength: 500 }),
    status: text({ default: 'new', enum: FEEDBACK_STATUSES }),
    statusUpdatedAt: when(),
    statusUpdatedByEmail: text()
});

module.exports = {
    officers,
    managers,
    spots,
    guides,
    reports,
    languagesOf,
    setGuideLanguages,
    findGuidesSpeaking,
    bookings,
    payments,
    tickets,
    checkouts,
    closedDates,
    feedback,
    MAX_SPOT_IMAGES,
    GUIDE_STATUSES,
    GUIDE_SCOPES,
    GUIDE_REPORT_TYPES,
    WEEKDAYS,
    MAX_GUIDE_LANGUAGES,
    BOOKING_STATUSES,
    FEEDBACK_TOPICS,
    FEEDBACK_STATUSES,
    FEEDBACK_MESSAGE_MAX
};
