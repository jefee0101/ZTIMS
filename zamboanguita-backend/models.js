/* ZTIMS's records, as the API reads and writes them.
 *
 * Each definition mirrors a Mongoose schema that used to live in server.js,
 * field for field: same names, same defaults, same limits, same messages. The
 * columns underneath are in db/schema.sql. Where a route needs a record
 * together with the one it points at — a listing with its enterprise —
 * the query is written out here, so
 * the joins are in one place and the routes keep their shape.
 */
const { Table, query, transaction, normaliseDbError, isId, castField, sameValue } = require('./db');

const text = (options = {}) => ({ type: 'string', default: '', ...options });
const required = (options = {}) => ({ type: 'string', required: true, ...options });
const number = (options = {}) => ({ type: 'number', default: 0, ...options });
const flag = (defaultValue, options = {}) => ({ type: 'boolean', default: defaultValue, ...options });
const when = () => ({ type: 'date', nullable: true });
const ref = () => ({ type: 'id', nullable: true });

const MAX_SPOT_IMAGES = 30;
// 'closed': the office shut the destination that day; the visitor chooses a refund or a new date.
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
    fullName: text({ trim: true }),
    position: text({ trim: true }),
    contactNumber: text({ trim: true }),
    active: flag(true),
    lastSignInAt: when(),
    ...resetFields
}, { secret: SECRET });

/* Tourist Enterprise Managers. MongoDB's `resortOwners`. */
const managers = new Table('establishment_managers', {
    email: email(),
    password: passwordHash(),
    establishmentName: required({ trim: true, requiredMessage: 'An enterprise name is required.' }),
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

/* Every listing is in one municipality, so neither is stored; a listing still
   reads with both, for the pages that print an address. */
const MUNICIPALITY = 'Zamboanguita';
const PROVINCE = 'Negros Oriental';

/* What a listing is known for (see schema.sql, "Categories"): the main
   category is spots.category; any others are spot_more_categories rows. */
const CATEGORY_CODES = ['BEACH', 'DIVING', 'NATURE', 'ADVENTURE', 'CULTURE', 'FAITH', 'LEISURE'];
const MORE_CATEGORIES_OF = alias => `coalesce((select array_agg(c.category order by c.position) from spot_more_categories c
    where c.spot_id = ${alias}.id), '{}') as more_categories`;

/* A listing's gallery, in order, from spot_photos. */
const PHOTOS_OF = alias => `coalesce((select array_agg(p.url order by p.position) from spot_photos p
    where p.spot_id = ${alias}.id), '{}') as images`;

const spots = new Table('spots', {
    title: required(),
    location: required({ requiredMessage: 'Fill in the Location Information so the listing has a place to show.' }),
    category: required({ enum: CATEGORY_CODES }),
    // The other categories, in spot_more_categories; spots.create/save write it.
    moreCategories: { type: 'strings', default: () => [], maxItems: CATEGORY_CODES.length, external: true },
    description: required(),
    imageUrl: text(),
    // In spot_photos, one row per photo; spots.create/save write it.
    images: {
        type: 'strings', default: () => [], maxItems: MAX_SPOT_IMAGES, external: true,
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
    latitude: { type: 'number', nullable: true, min: -90, max: 90 },
    longitude: { type: 'number', nullable: true, min: -180, max: 180 },
    managedBy: ref(),
    status: text({ default: 'published', enum: ['published', 'unpublished', 'archived'] }),
    statusUpdatedAt: when(),
    // Attraction setup (see schema.sql): null means that price is not offered.
    studentFee: { type: 'number', nullable: true, min: 0 },
    childFee: { type: 'number', nullable: true, min: 0 },
    childAgeMax: { type: 'integer', nullable: true, min: 1, max: 17 },
    cancelKeepPercent: number({ min: 0, max: 100 })
}, {
    select: `select spots.*, ${PHOTOS_OF('spots')}, ${MORE_CATEGORIES_OF('spots')} from spots`,
    virtuals: {
        municipality: { read: () => MUNICIPALITY },
        province: { read: () => PROVINCE }
    }
});

/* Replaces a listing's gallery with `photos`, in order. */
async function writePhotos(spotId, photos, client) {
    await query('delete from spot_photos where spot_id = $1', [spotId], client);
    if (photos.length) {
        await query(
            `insert into spot_photos (spot_id, position, url)
             select $1, ord - 1, url from unnest($2::text[]) with ordinality as p(url, ord)`,
            [spotId, photos], client);
    }
}

/* Replaces a listing's other categories, in order, never repeating the main one. */
async function writeMoreCategories(spotId, main, more, client) {
    const list = [...new Set(more)].filter(code => code !== main);
    await query('delete from spot_more_categories where spot_id = $1', [spotId], client);
    if (list.length) {
        await query(
            `insert into spot_more_categories (spot_id, position, category)
             select $1, ord - 1, category from unnest($2::text[]) with ordinality as c(category, ord)`,
            [spotId, list], client);
    }
    return list;
}

/* A listing, its gallery and its other categories are written together, in
   one transaction. */
const createSpotRow = spots.create.bind(spots);
spots.create = async function (values, options = {}) {
    const photos = castField('images', spots.fields.images, values.images);
    const more = castField('moreCategories', spots.fields.moreCategories, values.moreCategories);
    const run = async client => {
        const spot = await createSpotRow(values, { ...options, client });
        await writePhotos(spot._id, photos, client);
        spot.images = photos;
        spots.rememberValue(spot, 'images', photos);
        spot.moreCategories = await writeMoreCategories(spot._id, spot.category, more, client);
        spots.rememberValue(spot, 'moreCategories', spot.moreCategories);
        return spot;
    };
    return options.client ? run(options.client) : transaction(run);
};

const saveSpotRow = spots.save.bind(spots);
spots.save = async function (spot, options = {}) {
    const photosChanged = spot.images !== undefined && !sameValue(spot.images, spots.savedValue(spot, 'images'));
    const moreChanged = spot.moreCategories !== undefined
        && (!sameValue(spot.moreCategories, spots.savedValue(spot, 'moreCategories'))
            || spot.category !== spots.savedValue(spot, 'category'));
    if (!photosChanged && !moreChanged) return saveSpotRow(spot, options);
    const run = async client => {
        await saveSpotRow(spot, { ...options, client });
        if (photosChanged) {
            const photos = castField('images', spots.fields.images, spot.images);
            await writePhotos(spot._id, photos, client);
            spot.images = photos;
            spots.rememberValue(spot, 'images', photos);
        }
        if (moreChanged) {
            const more = castField('moreCategories', spots.fields.moreCategories, spot.moreCategories);
            spot.moreCategories = await writeMoreCategories(spot._id, spot.category, more, client);
            spots.rememberValue(spot, 'moreCategories', spot.moreCategories);
        }
        return spot;
    };
    return options.client ? run(options.client) : transaction(run);
};

/* The enterprise's details a listing is allowed to carry. Never the
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

/* Listings with their enterprise's summary in managedBy, as Mongoose's
   populate() gave them, newest first. */
spots.findWithManagers = async function (filters = {}, { limit } = {}) {
    const { sql, params } = spots.where(filters, [], 's');
    let statement = `select s.*, ${PHOTOS_OF('s')}, ${MORE_CATEGORIES_OF('s')}, ${MANAGER_SUMMARY}
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

const payments = new Table('payments', {
    // For one ticket.
    ticketId: ref(),
    amount: { type: 'number', required: true, min: 0 },
    method: text({ default: 'cash' }),
    receiptNumber: text(),
    paidAt: { type: 'date', default: () => new Date() },
    recordedByEmail: text(),
    remarks: text(),
    // 'counter' (cash taken at the office) or 'online' (the gateway, test mode).
    channel: text({ default: 'counter', enum: ['counter', 'online'] }),
    gatewayRef: text(),
    refundedAt: when(),
    refundReason: text(),
    refundedByEmail: text(),
    refundAmount: { type: 'number', nullable: true, min: 0 },
    isDemo: flag(false)
});

/* An entrance ticket to an attraction the office runs. */
const VISITOR_KINDS = ['regular', 'student', 'child'];
const feeKey = kind => 'fee' + kind[0].toUpperCase() + kind.slice(1);   // 'child' → feeChild
const tickets = new Table('tickets', {
    code: required(),
    spotId: { type: 'id', required: true },
    visitDate: required(),   // YYYY-MM-DD
    // Worked out by the database from the counts and prices below.
    people: { type: 'integer', generated: true },
    amount: { type: 'number', generated: true },
    fullName: required({ trim: true }),
    email: required({ trim: true, lowercase: true }),
    contactNumber: text({ trim: true }),
    status: text({ default: 'pending_payment', enum: ['pending_payment', 'valid', 'used', 'cancelled', 'expired', 'closed'] }),
    usedAt: when(),
    usedByEmail: text(),
    isDemo: flag(false),
    // How many of each kind of visitor; they add up to `people`.
    countRegular: { type: 'integer', default: 0, min: 0 },
    countStudent: { type: 'integer', default: 0, min: 0 },
    countChild: { type: 'integer', default: 0, min: 0 },
    // The price each kind paid per person when the ticket was bought, one
    // column per kind (null: not offered). The routes see them as
    // feeBreakdown { regular: 20, child: 10, … } and unitFee (the regular price).
    ...Object.fromEntries(VISITOR_KINDS.map(kind => [feeKey(kind), { type: 'number', nullable: true, min: 0, hidden: true }]))
}, {
    virtuals: {
        feeBreakdown: {
            read: fields => Object.fromEntries(VISITOR_KINDS
                .filter(kind => fields[feeKey(kind)] !== null && fields[feeKey(kind)] !== undefined)
                .map(kind => [kind, fields[feeKey(kind)]])),
            write: fees => Object.fromEntries(VISITOR_KINDS.map(kind => [feeKey(kind),
                fees && fees[kind] !== undefined && fees[kind] !== null ? Number(fees[kind]) : null]))
        },
        unitFee: { read: fields => fields.feeRegular ?? 0 }
    }
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
    payments,
    tickets,
    checkouts,
    closedDates,
    feedback,
    MAX_SPOT_IMAGES,
    MUNICIPALITY,
    PROVINCE,
    FEEDBACK_TOPICS,
    FEEDBACK_STATUSES,
    FEEDBACK_MESSAGE_MAX
};
