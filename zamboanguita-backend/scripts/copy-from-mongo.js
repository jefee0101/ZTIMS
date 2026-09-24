/* Copies every ZTIMS record from MongoDB into Postgres (Supabase).
 *
 *   MONGO_URI=… DATABASE_URL=… npm run copy-from-mongo -- --dry-run
 *   MONGO_URI=… DATABASE_URL=… npm run copy-from-mongo
 *   MONGO_URI=… DATABASE_URL=… npm run copy-from-mongo -- --replace
 *
 * --dry-run   reads MongoDB and reports what would be copied, and what would
 *             not and why. Writes nothing and needs no DATABASE_URL. Always
 *             run this first.
 * --replace   the Postgres tables already hold records: empty them, then copy.
 *             Without it, the script refuses to touch a database that is not
 *             empty — once the site runs on Postgres, its records are newer
 *             than MongoDB's, and copying over them would lose real changes.
 *
 * It is meant to be run twice: once to try it, and once more at the moment of
 * the switch, so nothing the live site recorded in between is left behind.
 * Every write happens in one transaction: the copy lands whole, or not at all.
 *
 * Where records go:
 *
 *   admins        → tourism_officers        (the live officer accounts)
 *   resortOwners  → establishment_managers  (the live manager accounts)
 *   spots         → spots
 *   touristguides → tourist_guides, and each guide's assignedSpots → tourist_guide_spots
 *   guidebookings → guide_bookings
 *   payments      → payments
 *   feedbacks     → feedback
 *
 * `tourismOfficers` and `establishmentManagers` are NOT copied. They are
 * leftovers the API never read; the accounts people actually sign in with are
 * in `admins` and `resortOwners`. Any account found only in a leftover is
 * reported, so nobody is dropped without it being said.
 *
 * Ids are kept, so shared links and signed-in sessions survive the move, and
 * so are password hashes, so every account signs in with the password it has.
 *
 * MongoDB never checked that one record's reference to another still pointed
 * at something. Postgres does, so each broken reference is handled on purpose:
 *
 *   - an optional one (a listing's establishment, a payment's officer) is
 *     cleared — which is exactly how the site already treated it, since
 *     looking up the missing record found nothing;
 *   - a required one (a booking's destination, a payment's booking) means the
 *     record cannot be copied. It is written to copy-skipped-<time>.json in the
 *     current folder, and listed in the report. Nothing is dropped silently.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const LEFTOVERS = { tourismOfficers: 'admins', establishmentManagers: 'resortOwners' };

// Fields every document has that are not data.
const IGNORED = new Set(['_id', '__v', 'createdAt', 'updatedAt']);

/* ---------- small helpers ---------- */

const idOf = value => (value == null ? null : String(value._id || value.toHexString?.() || value));
const hexId = value => {
    const id = idOf(value);
    return id && /^[0-9a-f]{24}$/i.test(id) ? id.toLowerCase() : null;
};
const str = (value, fallback = '') => (value == null ? fallback : String(value));
const num = (value, fallback = 0) => {
    const n = Number(value);
    return value == null || value === '' || !Number.isFinite(n) ? fallback : n;
};
const bool = (value, fallback) => (value == null ? fallback : Boolean(value));
const date = value => {
    if (value == null || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
};
// An ObjectId carries the second it was made; used where a collection had no createdAt.
const idTime = value => {
    const id = hexId(value);
    return id ? new Date(parseInt(id.slice(0, 8), 16) * 1000) : null;
};
const stamps = doc => {
    const created = date(doc.createdAt) || idTime(doc._id) || new Date();
    return { created_at: created, updated_at: date(doc.updatedAt) || created };
};
const label = doc => {
    const bits = [doc.title, doc.fullName, doc.reference, doc.email, doc.establishmentName].filter(Boolean);
    return `${hexId(doc._id) || doc._id}${bits.length ? ` (${bits[0]})` : ''}`;
};

/* ---------- the transform: MongoDB documents → Postgres rows ----------

   Pure: takes what was read, returns rows and a report. Kept apart from the
   reading and writing so it can be tested without either database. */
function transform(source) {
    const report = { notes: [], repaired: [], skipped: [], unknownFields: {} };
    const rows = {
        tourism_officers: [], establishment_managers: [], spots: [], tourist_guides: [],
        tourist_guide_spots: [], guide_bookings: [], payments: [], feedback: []
    };
    const skip = (collection, doc, reason) => report.skipped.push({ collection, id: hexId(doc._id), label: label(doc), reason, document: doc });
    const repair = (collection, doc, what) => report.repaired.push({ collection, label: label(doc), what });

    const noteUnknown = (collection, docs, known) => {
        const extra = {};
        for (const doc of docs) {
            for (const key of Object.keys(doc)) {
                if (!IGNORED.has(key) && !known.includes(key)) extra[key] = (extra[key] || 0) + 1;
            }
        }
        if (Object.keys(extra).length) report.unknownFields[collection] = extra;
    };
    const requireText = (collection, doc, fields) => {
        const missing = fields.filter(field => !str(doc[field]).trim());
        if (missing.length) skip(collection, doc, `missing required ${missing.join(', ')}`);
        return missing.length === 0;
    };

    /* Accounts */
    const officerIds = new Set();
    const officerEmails = new Set();
    for (const doc of source.admins || []) {
        const id = hexId(doc._id);
        const email = str(doc.email).trim().toLowerCase();
        if (!id) { skip('admins', doc, 'its id is not an ObjectId'); continue; }
        if (!email || !doc.password) { skip('admins', doc, 'no email or no password hash'); continue; }
        if (officerEmails.has(email)) { skip('admins', doc, `a second account for ${email}`); continue; }
        officerIds.add(id); officerEmails.add(email);
        rows.tourism_officers.push({
            id, email, password_hash: String(doc.password),
            reset_token_hash: doc.resetTokenHash || null, reset_token_expires: date(doc.resetTokenExpires),
            ...stamps(doc)
        });
    }
    noteUnknown('admins', source.admins || [], ['email', 'password', 'resetTokenHash', 'resetTokenExpires']);

    const managerIds = new Set();
    const managerEmails = new Set();
    for (const doc of source.resortOwners || []) {
        const id = hexId(doc._id);
        const email = str(doc.email).trim().toLowerCase();
        // resortName is the field's name from before the rename.
        const name = str(doc.establishmentName || doc.resortName).trim();
        if (!id) { skip('resortOwners', doc, 'its id is not an ObjectId'); continue; }
        if (!email || !doc.password) { skip('resortOwners', doc, 'no email or no password hash'); continue; }
        if (!name) { skip('resortOwners', doc, 'no establishment name'); continue; }
        if (managerEmails.has(email)) { skip('resortOwners', doc, `a second account for ${email}`); continue; }
        const status = ['active', 'inactive', 'closed'].includes(doc.operationalStatus) ? doc.operationalStatus : 'active';
        if (doc.operationalStatus && status !== doc.operationalStatus) repair('resortOwners', doc, `unknown operationalStatus "${doc.operationalStatus}" read as active`);
        managerIds.add(id); managerEmails.add(email);
        rows.establishment_managers.push({
            id, email, password_hash: String(doc.password),
            establishment_name: name,
            manager_name: str(doc.managerName).trim(),
            contact_email: str(doc.contactEmail).trim().toLowerCase(),
            phone: str(doc.phone),
            active: bool(doc.active, true),
            operational_status: status,
            status_needs_review: bool(doc.statusNeedsReview, false),
            status_note: str(doc.statusNote),
            status_updated_at: date(doc.statusUpdatedAt),
            reset_token_hash: doc.resetTokenHash || null, reset_token_expires: date(doc.resetTokenExpires),
            ...stamps(doc)
        });
    }
    noteUnknown('resortOwners', source.resortOwners || [], [
        'email', 'password', 'establishmentName', 'resortName', 'managerName', 'contactEmail', 'phone', 'active',
        'operationalStatus', 'statusNeedsReview', 'statusNote', 'statusUpdatedAt', 'resetTokenHash', 'resetTokenExpires'
    ]);

    /* The leftovers: say whether anyone would be lost. */
    for (const [leftover, live] of Object.entries(LEFTOVERS)) {
        const docs = source[leftover] || [];
        const liveEmails = leftover === 'tourismOfficers' ? officerEmails : managerEmails;
        const onlyThere = docs.filter(doc => !liveEmails.has(str(doc.email).trim().toLowerCase()));
        report.notes.push(`${leftover}: ${docs.length} document(s), not copied (the live accounts are in ${live})` +
            (onlyThere.length ? ` — ${onlyThere.length} of them are NOT in ${live}: ${onlyThere.map(d => d.email || hexId(d._id)).join(', ')}` : ''));
        if (onlyThere.length) report.leftoverOnly = (report.leftoverOnly || []).concat(onlyThere.map(d => `${leftover}: ${d.email || hexId(d._id)}`));
    }

    /* Listings */
    const spotIds = new Set();
    const spotKnown = [
        'title', 'location', 'category', 'description', 'imageUrl', 'images', 'bookingUrl', 'type', 'label',
        'workingDays', 'workingTime', 'travelFee', 'entranceFee', 'address', 'barangay', 'municipality', 'province',
        'latitude', 'longitude', 'managedBy', 'ownerId', 'status', 'statusNote', 'statusUpdatedAt', 'requiresGuide'
    ];
    for (const doc of source.spots || []) {
        const id = hexId(doc._id);
        if (!id) { skip('spots', doc, 'its id is not an ObjectId'); continue; }
        if (!requireText('spots', doc, ['title', 'location', 'category', 'description'])) continue;

        const images = (Array.isArray(doc.images) ? doc.images : []).map(String).filter(Boolean);
        if (images.length > 30) { skip('spots', doc, `${images.length} photos; the limit is 30`); continue; }

        // ownerId is managedBy's name from before the rename.
        let managedBy = hexId(doc.managedBy) || hexId(doc.ownerId);
        if (managedBy && !managerIds.has(managedBy)) {
            repair('spots', doc, `assigned to establishment account ${managedBy}, which does not exist — now maintained by the Tourism Office, as the site already showed it`);
            managedBy = null;
        }

        let latitude = doc.latitude == null || doc.latitude === '' ? null : num(doc.latitude, null);
        let longitude = doc.longitude == null || doc.longitude === '' ? null : num(doc.longitude, null);
        if ((latitude == null) !== (longitude == null)
            || (latitude != null && (Math.abs(latitude) > 90 || Math.abs(longitude) > 180))) {
            repair('spots', doc, `unusable map point (${doc.latitude}, ${doc.longitude}) cleared; set it again on the map`);
            latitude = null; longitude = null;
        }

        const type = ['spot', 'accommodation'].includes(doc.type) ? doc.type : 'spot';
        const status = ['published', 'unpublished', 'archived'].includes(doc.status) ? doc.status : 'published';
        if (doc.status && status !== doc.status) repair('spots', doc, `unknown status "${doc.status}" read as published`);

        spotIds.add(id);
        rows.spots.push({
            id,
            title: str(doc.title), location: str(doc.location), category: str(doc.category), description: str(doc.description),
            image_url: str(doc.imageUrl), images, booking_url: str(doc.bookingUrl), type, label: str(doc.label),
            working_days: str(doc.workingDays, 'Everyday'), working_time: str(doc.workingTime, 'All Day'),
            travel_fee: num(doc.travelFee), entrance_fee: num(doc.entranceFee),
            address: str(doc.address), barangay: str(doc.barangay),
            municipality: str(doc.municipality, 'Zamboanguita'), province: str(doc.province, 'Negros Oriental'),
            latitude, longitude, managed_by: managedBy,
            status, status_note: str(doc.statusNote), status_updated_at: date(doc.statusUpdatedAt),
            requires_guide: bool(doc.requiresGuide, false),
            ...stamps(doc)
        });
    }
    noteUnknown('spots', source.spots || [], spotKnown);

    /* Guides, and which spots each serves */
    const guideIds = new Set();
    for (const doc of source.touristguides || []) {
        const id = hexId(doc._id);
        if (!id) { skip('touristguides', doc, 'its id is not an ObjectId'); continue; }
        if (!requireText('touristguides', doc, ['fullName'])) continue;

        let groupSize = num(doc.maxGroupSize, 1);
        if (!Number.isInteger(groupSize) || groupSize < 1) {
            const fixed = Math.max(1, Math.floor(groupSize));
            repair('touristguides', doc, `maxGroupSize ${doc.maxGroupSize} stored as ${fixed}`);
            groupSize = fixed;
        }
        const status = ['available', 'unavailable', 'inactive'].includes(doc.status) ? doc.status : 'available';

        guideIds.add(id);
        rows.tourist_guides.push({
            id, full_name: str(doc.fullName).trim(), photo_url: str(doc.photoUrl), contact_number: str(doc.contactNumber),
            location: str(doc.location), bio: str(doc.bio), guide_fee: Math.max(0, num(doc.guideFee)),
            max_group_size: groupSize, status, ...stamps(doc)
        });

        const seen = new Set();
        (Array.isArray(doc.assignedSpots) ? doc.assignedSpots : []).forEach(value => {
            const spotId = hexId(value);
            if (!spotId || seen.has(spotId)) return;
            if (!spotIds.has(spotId)) {
                repair('touristguides', doc, `assigned destination ${spotId} does not exist; left off the guide's list`);
                return;
            }
            seen.add(spotId);
            rows.tourist_guide_spots.push({ guide_id: id, spot_id: spotId, position: seen.size - 1 });
        });
    }
    noteUnknown('touristguides', source.touristguides || [], [
        'fullName', 'photoUrl', 'contactNumber', 'location', 'bio', 'guideFee', 'maxGroupSize', 'status', 'assignedSpots'
    ]);

    /* Bookings */
    const bookingIds = new Set();
    const references = new Set();
    for (const doc of source.guidebookings || []) {
        const id = hexId(doc._id);
        if (!id) { skip('guidebookings', doc, 'its id is not an ObjectId'); continue; }
        if (!requireText('guidebookings', doc, ['reference', 'fullName', 'contactNumber', 'email', 'preferredDate', 'preferredTime'])) continue;
        const spotId = hexId(doc.spotId);
        if (!spotId || !spotIds.has(spotId)) { skip('guidebookings', doc, `its destination ${spotId || '(none)'} does not exist`); continue; }
        if (references.has(doc.reference)) { skip('guidebookings', doc, `reference ${doc.reference} used twice`); continue; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(str(doc.preferredDate)) || !/^\d{2}:\d{2}$/.test(str(doc.preferredTime))) {
            skip('guidebookings', doc, `unreadable date/time "${doc.preferredDate} ${doc.preferredTime}"`); continue;
        }
        const visitors = Math.floor(num(doc.visitors, 0));
        if (visitors < 1) { skip('guidebookings', doc, `visitors is ${doc.visitors}`); continue; }

        let guideId = hexId(doc.guideId);
        if (guideId && !guideIds.has(guideId)) {
            repair('guidebookings', doc, `assigned guide ${guideId} does not exist — now unassigned`);
            guideId = null;
        }
        let nationality = str(doc.nationality).trim().toUpperCase();
        if (nationality && !/^[A-Z]{2}$/.test(nationality)) {
            repair('guidebookings', doc, `unreadable nationality "${doc.nationality}" cleared`);
            nationality = '';
        }
        const statuses = ['pending_payment', 'confirmed', 'cancelled', 'completed', 'no_show'];

        bookingIds.add(id); references.add(doc.reference);
        rows.guide_bookings.push({
            id, reference: str(doc.reference), spot_id: spotId, guide_id: guideId,
            full_name: str(doc.fullName).trim(), contact_number: str(doc.contactNumber).trim(),
            email: str(doc.email).trim().toLowerCase(), nationality, visitors,
            preferred_date: str(doc.preferredDate), preferred_time: str(doc.preferredTime), notes: str(doc.notes),
            status: statuses.includes(doc.status) ? doc.status : 'pending_payment',
            status_note: str(doc.statusNote), status_updated_at: date(doc.statusUpdatedAt),
            ...stamps(doc)
        });
    }
    noteUnknown('guidebookings', source.guidebookings || [], [
        'reference', 'spotId', 'guideId', 'fullName', 'contactNumber', 'email', 'nationality', 'visitors',
        'preferredDate', 'preferredTime', 'notes', 'status', 'statusNote', 'statusUpdatedAt'
    ]);

    /* Payments */
    const paidBookings = new Set();
    for (const doc of source.payments || []) {
        const id = hexId(doc._id);
        const bookingId = hexId(doc.bookingId);
        if (!id) { skip('payments', doc, 'its id is not an ObjectId'); continue; }
        if (!bookingId || !bookingIds.has(bookingId)) {
            skip('payments', doc, `its booking ${bookingId || '(none)'} does not exist`); continue;
        }
        if (paidBookings.has(bookingId)) { skip('payments', doc, `a second payment for booking ${bookingId}`); continue; }
        const amount = num(doc.amount, NaN);
        if (!Number.isFinite(amount) || amount < 0) { skip('payments', doc, `amount is ${doc.amount}`); continue; }

        let recordedBy = hexId(doc.recordedBy);
        if (recordedBy && !officerIds.has(recordedBy)) {
            repair('payments', doc, `recorded by officer ${recordedBy}, who does not exist — the recorded email is kept`);
            recordedBy = null;
        }
        paidBookings.add(bookingId);
        rows.payments.push({
            id, booking_id: bookingId, amount, method: str(doc.method, 'cash') || 'cash',
            receipt_number: str(doc.receiptNumber), paid_at: date(doc.paidAt) || stamps(doc).created_at,
            recorded_by: recordedBy, recorded_by_email: str(doc.recordedByEmail), remarks: str(doc.remarks),
            ...stamps(doc)
        });
    }
    noteUnknown('payments', source.payments || [], [
        'bookingId', 'amount', 'method', 'receiptNumber', 'paidAt', 'recordedBy', 'recordedByEmail', 'remarks'
    ]);

    /* Feedback */
    for (const doc of source.feedbacks || []) {
        const id = hexId(doc._id);
        const message = str(doc.message).trim();
        if (!id) { skip('feedbacks', doc, 'its id is not an ObjectId'); continue; }
        if (!message) { skip('feedbacks', doc, 'the message is empty'); continue; }
        if (message.length > 2000) { skip('feedbacks', doc, `the message is ${message.length} characters; the limit is 2000`); continue; }
        rows.feedback.push({
            id,
            topic: ['suggestion', 'listing', 'problem', 'booking', 'other'].includes(doc.topic) ? doc.topic : 'other',
            message, name: str(doc.name).trim().slice(0, 120), email: str(doc.email).trim().toLowerCase().slice(0, 254),
            page: str(doc.page).trim().slice(0, 500),
            status: ['new', 'read', 'resolved'].includes(doc.status) ? doc.status : 'new',
            status_updated_at: date(doc.statusUpdatedAt), status_updated_by_email: str(doc.statusUpdatedByEmail),
            ...stamps(doc)
        });
    }
    noteUnknown('feedbacks', source.feedbacks || [], [
        'topic', 'message', 'name', 'email', 'page', 'status', 'statusUpdatedAt', 'statusUpdatedByEmail'
    ]);

    return { rows, report };
}

/* ---------- reading ---------- */

const COLLECTIONS = [
    'admins', 'resortOwners', 'spots', 'touristguides', 'guidebookings', 'payments', 'feedbacks',
    ...Object.keys(LEFTOVERS)
];

async function readMongo(uri) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
    await client.connect();
    try {
        // With no database named in the URI, Mongoose used "test" — so does this.
        const database = client.db();
        const source = { databaseName: database.databaseName };
        for (const name of COLLECTIONS) source[name] = await database.collection(name).find({}).toArray();
        return source;
    } finally {
        await client.close();
    }
}

/* ---------- writing ---------- */

// Parents before children, so every reference already has its row.
const TABLE_ORDER = [
    'tourism_officers', 'establishment_managers', 'spots', 'tourist_guides',
    'tourist_guide_spots', 'guide_bookings', 'payments', 'feedback'
];

async function writePostgres(rows, { replace }) {
    const { transaction, query, closePool } = require('../db');
    try {
        const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
        await query(schema);

        const counts = {};
        for (const table of TABLE_ORDER) counts[table] = (await query(`select count(*)::int as n from ${table}`)).rows[0].n;
        const occupied = Object.entries(counts).filter(([, n]) => n > 0);
        if (occupied.length && !replace) {
            throw new Error(
                `The Postgres database already has records (${occupied.map(([t, n]) => `${t}: ${n}`).join(', ')}).\n` +
                '   If the site is already running on it, those are newer than MongoDB\'s — do NOT replace them.\n' +
                '   If this is a practice copy you mean to redo, run again with --replace.'
            );
        }

        await transaction(async client => {
            if (occupied.length) {
                await client.query(`truncate ${[...TABLE_ORDER].reverse().join(', ')}`);
            }
            for (const table of TABLE_ORDER) {
                const list = rows[table];
                if (!list.length) continue;
                const columns = Object.keys(list[0]);
                for (let start = 0; start < list.length; start += 200) {
                    const chunk = list.slice(start, start + 200);
                    const params = [];
                    const values = chunk.map(row => '(' + columns.map(column => {
                        params.push(row[column]);
                        return `$${params.length}`;
                    }).join(', ') + ')');
                    await client.query(`insert into ${table} (${columns.join(', ')}) values ${values.join(', ')}`, params);
                }
            }
        });

        const after = {};
        for (const table of TABLE_ORDER) after[table] = (await query(`select count(*)::int as n from ${table}`)).rows[0].n;
        return after;
    } finally {
        await closePool();
    }
}

/* ---------- the report ---------- */

const SOURCE_FOR = {
    tourism_officers: 'admins', establishment_managers: 'resortOwners', spots: 'spots',
    tourist_guides: 'touristguides', tourist_guide_spots: 'touristguides.assignedSpots',
    guide_bookings: 'guidebookings', payments: 'payments', feedback: 'feedbacks'
};

function printReport(source, rows, report, written) {
    console.log(`\nMongoDB database: ${source.databaseName}`);
    console.log('\n  from                          to                        read   copy' + (written ? '  in Postgres' : ''));
    for (const table of TABLE_ORDER) {
        const from = SOURCE_FOR[table];
        const read = table === 'tourist_guide_spots'
            ? (source.touristguides || []).reduce((n, g) => n + ((g.assignedSpots || []).length), 0)
            : (source[from] || []).length;
        const line = `  ${from.padEnd(30)}${table.padEnd(26)}${String(read).padStart(4)}   ${String(rows[table].length).padStart(4)}`;
        console.log(line + (written ? `  ${String(written[table]).padStart(11)}${written[table] === rows[table].length ? '  ✓' : '  ✗ MISMATCH'}` : ''));
    }
    for (const note of report.notes) console.log(`\n  • ${note}`);

    if (report.repaired.length) {
        console.log(`\nRepaired on the way (${report.repaired.length}) — the record is copied, with this changed:`);
        for (const r of report.repaired) console.log(`  • ${r.collection} ${r.label}: ${r.what}`);
    }
    if (report.skipped.length) {
        console.log(`\nNOT copied (${report.skipped.length}):`);
        for (const s of report.skipped) console.log(`  • ${s.collection} ${s.label}: ${s.reason}`);
    }
    const unknown = Object.entries(report.unknownFields);
    if (unknown.length) {
        console.log('\nFields present in MongoDB that have no column, so were not copied:');
        for (const [collection, fields] of unknown) {
            console.log(`  • ${collection}: ${Object.entries(fields).map(([f, n]) => `${f} (${n})`).join(', ')}`);
        }
    }
}

function saveSkipped(report) {
    if (!report.skipped.length) return null;
    const { EJSON } = require('mongodb').BSON;
    const file = path.resolve(`copy-skipped-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, EJSON.stringify(report.skipped, null, 2, { relaxed: true }));
    return file;
}

/* ---------- main ---------- */

async function main(argv) {
    const dryRun = argv.includes('--dry-run');
    const replace = argv.includes('--replace');
    if (!process.env.MONGO_URI) throw new Error('Set MONGO_URI to the MongoDB database to copy from.');
    if (!dryRun && !process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the Supabase database to copy into (or pass --dry-run).');

    console.log(`Reading MongoDB…`);
    const source = await readMongo(process.env.MONGO_URI);
    const { rows, report } = transform(source);

    if (dryRun) {
        printReport(source, rows, report, null);
        console.log('\nDry run: nothing was written. Run again without --dry-run to copy.');
    } else {
        console.log(`Writing to ${require('../db').describeDatabase()}…`);
        const written = await writePostgres(rows, { replace });
        printReport(source, rows, report, written);
        const mismatch = TABLE_ORDER.some(table => written[table] !== rows[table].length);
        if (mismatch) throw new Error('Postgres does not hold what was copied. See ✗ above.');
        console.log('\n✅ Copied.');
    }

    const skippedFile = saveSkipped(report);
    if (skippedFile) {
        console.log(`\nThe ${report.skipped.length} record(s) not copied are saved in full in:\n  ${skippedFile}\n` +
            '  It holds personal details — keep it out of git, and delete it once you have decided about them.');
    }
    if (report.leftoverOnly) {
        console.log(`\n⚠️  Accounts that exist ONLY in a leftover collection, and so were not copied:\n  ${report.leftoverOnly.join('\n  ')}`);
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).then(() => process.exit(0)).catch(error => {
        console.error(`\n❌ ${error.message}`);
        process.exit(1);
    });
}

module.exports = { transform, writePostgres, TABLE_ORDER };
