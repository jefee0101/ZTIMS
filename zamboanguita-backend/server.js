const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer'); // Added for handling Forgot Password emails
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { MongoRateLimitStore } = require('./rate-limit-store');
require('dotenv').config();

const app = express();

/* ==========================================
   1. MIDDLEWARE PIPELINES
========================================== */
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://127.0.0.1:5500,http://localhost:5500')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

// Vercel gives every branch and every redeploy its own preview hostname, so the
// production origin alone would break previews on each push.
const previewOriginPattern = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

const isAllowedOrigin = (origin) => allowedOrigins.includes(origin) || previewOriginPattern.test(origin);

if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be configured before starting the API.');
}

// Render terminates TLS at its edge proxy. Without this, every request looks like
// it comes from that one proxy IP and the rate limiters below bucket the entire
// internet together — 10 shared login attempts per 15 minutes for all visitors.
app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
    origin(origin, callback) {
        // No Origin header means a non-browser client (curl, Postman, health checks).
        if (!origin || isAllowedOrigin(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
// This blanket limit stays in each instance's own memory, deliberately. It runs
// on every request, including ones that never touch the database, and counting
// it in MongoDB would add a database round trip to all of them. It is a rough
// cushion against a flood, not a security control, so a count per instance is
// good enough. The limits that do guard something — login, password reset,
// the public forms, the metered routing providers — use sharedRateLimit below.
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 150, standardHeaders: true, legacyHeaders: false }));

/* A limit counted in MongoDB, so it holds across every running instance of the
   API rather than per instance (see rate-limit-store.js for why that matters
   on a serverless host). `name` must be unique to each limiter.

   If the database cannot be reached the request is let through rather than
   refused with a 500. Every limited route but directions needs the database
   itself, so it fails on its own anyway, and directions — which does not —
   keeps working through a database outage. */
function sharedRateLimit(name, options) {
    return rateLimit({
        standardHeaders: true,
        legacyHeaders: false,
        ...options,
        store: new MongoRateLimitStore(name),
        passOnStoreError: true
    });
}

// FORCE explicit body-parser rules across ALL incoming payload formats
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: false, parameterLimit: 1000 }));

/* ==========================================
   2. DATABASE CONFIGURATION & CONNECT
========================================== */
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/zamboanguita';

/* Connected once and remembered, rather than on every call.

   On a long-running host this is the same thing either way: the process starts,
   connects, and serves until it stops. On a serverless host it is not. Each
   instance runs this module from scratch, and an instance is reused for many
   requests before it is discarded — so connecting per request would open a new
   pool every time and leave it behind. A free Atlas cluster has a few hundred
   connections in total; that pattern exhausts them, and the failure looks like
   random timeouts rather than anything to do with connections.

   Holding the PROMISE rather than a boolean is what makes it safe: several
   requests can arrive on a cold instance before the first connection finishes,
   and they all wait on the same one instead of starting their own. A failure
   clears it, so the next request retries rather than being stuck for the life
   of the instance. */
let connectionPromise = null;

function connectToDatabase() {
    if (connectionPromise) return connectionPromise;

    connectionPromise = mongoose.connect(MONGO_URI, {
        // Small on purpose. Many short-lived instances each holding a large pool
        // is precisely what runs a free cluster out of connections.
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 10000
    })
        .then(connection => {
            console.log('✅ Connected safely to MongoDB database system.');
            return connection;
        })
        .catch(error => {
            connectionPromise = null;
            console.error('❌ MongoDB Connection Error Encountered:', error);
            throw error;
        });

    return connectionPromise;
}

/* Start connecting on the first request an instance sees, but do NOT hold the
   request up waiting for it.

   Awaiting here was the obvious version and the wrong one: it made every route
   depend on the database, including the ones that never touch it.
   /api/directions/capabilities just reports which travel modes are configured,
   and it answered perfectly well with the database down until the wait was put
   in front of it — the page that asks which modes to draw would have gone blank
   over an unrelated outage.

   Nothing is lost by not waiting. Mongoose queues model operations until the
   connection is ready, so a route that does query the database still waits for
   it, automatically, and one that does not answers immediately. */
app.use((req, res, next) => {
    // Already logged inside; swallowed here so a connection failure cannot
    // surface as an unhandled rejection.
    connectToDatabase().catch(() => {});
    next();
});

/* The three startup tasks are NOT run here any more.

   They were: two one-time reshapings of existing documents, and the creation of
   the first Tourism Officer. All three have already run against the live
   database. On a serverless host there is no startup to hang them on — they
   would re-run on every cold instance, and bootstrapAdmin would race with
   itself across instances that all believe they are first.

   They are `npm run migrate` now, run deliberately by a person. */
async function runMigrations() {
    await connectToDatabase();
    await migrateEstablishmentNames();
    await migrateSpotManagement();
    await bootstrapAdmin();
}

/* ==========================================
   3. DATA SCHEMA & MODELS
========================================== */

// 2. Admin Authentication Schema
const AdminSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    // See the password reset section: only the token's hash is ever stored.
    resetTokenHash: { type: String, default: null, select: false },
    resetTokenExpires: { type: Date, default: null, select: false }
}, { collection: 'admins' }); 

const Admin = mongoose.model('Admin', AdminSchema);



// 3b. Tourist Establishment Manager account (manages only their own tourist spots
//     and accommodations). Formerly called "Resort Owner" — the stored collection
//     keeps its original name on purpose: renaming it would orphan every account
//     already registered in Atlas. Only the wording and the code changed.
const EstablishmentManagerSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    establishmentName: { type: String, trim: true },
    // The pre-rename name of the same field. Still declared so accounts created
    // before the rename keep reading correctly even if the migration below has
    // not run yet; new accounts never write it.
    resortName: { type: String, trim: true },
    // The person who actually runs the place, and the address visitors should
    // write to. The email above is the sign-in address and is never shown
    // publicly; this one is, on listings that have no booking website.
    managerName: { type: String, default: "", trim: true },
    contactEmail: { type: String, default: "", lowercase: true, trim: true },
    phone: { type: String, default: "" },
    // Suspended accounts cannot sign in, and their listings drop off the public
    // site until the Tourist Officer restores them. Nothing is deleted, so a
    // seasonal closure or a change of management is reversible.
    active: { type: Boolean, default: true },

    // Whether the business is trading, which the establishment reports itself.
    // Deliberately separate from `active` above: that is the office's switch over
    // the account, this is the establishment's statement about its own operations.
    // Keeping them apart lets a place report that it has closed without that
    // reading as a sanction, and lets the office suspend an account that is
    // trading perfectly well.
    //   active   - operating normally
    //   inactive - temporarily not operating (off season, repairs)
    //   closed   - permanently stopped
    // A closure is recorded, never erased: the account and its listings remain.
    operationalStatus: {
        type: String,
        enum: ['active', 'inactive', 'closed'],
        default: 'active',
        index: true
    },
    // Raised when the establishment reports its own change, cleared once the
    // officer has acted. This is the queue that drives municipal oversight - it is
    // how a closure reaches the office instead of sitting unnoticed.
    statusNeedsReview: { type: Boolean, default: false },
    statusNote: { type: String, default: "" },
    statusUpdatedAt: { type: Date, default: null },
    resetTokenHash: { type: String, default: null, select: false },
    resetTokenExpires: { type: Date, default: null, select: false }
}, { collection: 'resortOwners', timestamps: true });

// One field, two possible spellings on disk. Everything downstream reads this.
EstablishmentManagerSchema.virtual('displayName').get(function () {
    return this.establishmentName || this.resortName || '';
});

// Written async rather than with a next() callback: Mongoose 9 — which this
// project installs — removed callback-style document middleware, and a hook
// declaring next there throws "next is not a function" on every single save.
EstablishmentManagerSchema.pre('validate', async function () {
    if (!this.establishmentName && this.resortName) this.establishmentName = this.resortName;
    if (!this.establishmentName) {
        throw new Error('An establishment name is required.');
    }
});

const EstablishmentManager = mongoose.model('EstablishmentManager', EstablishmentManagerSchema);

/**
 * One-time, idempotent rename of resortName -> establishmentName on existing
 * accounts. Runs at startup, costs nothing once there is nothing left to move,
 * and never blocks boot: if it fails, the schema above still reads the old field.
 */
async function migrateEstablishmentNames() {
    try {
        const result = await EstablishmentManager.collection.updateMany(
            { resortName: { $exists: true }, establishmentName: { $in: [null, ''] } },
            [{ $set: { establishmentName: '$resortName' } }]
        );
        if (result.modifiedCount) {
            console.log(`🔤 Renamed resortName -> establishmentName on ${result.modifiedCount} account(s).`);
        }
    } catch (error) {
        console.warn('⚠️ establishmentName migration skipped:', error.message);
    }
}

/**
 * Moves listings from the old `ownerId` field to `managedBy`.
 *
 * Nobody owns a listing in ZTIMS — a manager is assigned to maintain one — and
 * the old name said otherwise. Done in two steps on purpose: copy every value
 * across first, and only remove the old field from documents that now carry the
 * new one. A half-finished run therefore leaves listings readable under both
 * names rather than under neither.
 */
/**
 * Creates the first Tourism Officer account from the environment.
 *
 * .env.example has documented INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD
 * since the beginning, but nothing ever read them — and /api/admin/create is
 * behind requireAdmin, so an officer account could only be made by an officer
 * who already existed. With no admin in the database, or with the password
 * forgotten, there was no way in at all.
 *
 * Creating is safe to leave switched on: it only ever fills a gap. Changing the
 * password of an account that already exists is not, so that needs
 * ADMIN_PASSWORD_RESET=true set deliberately, and says so loudly when it runs.
 *
 * Remove all three variables once you are back in. While INITIAL_ADMIN_PASSWORD
 * sits in the environment, anyone who can read the environment knows it.
 */
async function bootstrapAdmin() {
    const email = String(process.env.INITIAL_ADMIN_EMAIL || '').toLowerCase().trim();
    const password = String(process.env.INITIAL_ADMIN_PASSWORD || '');
    const forceReset = String(process.env.ADMIN_PASSWORD_RESET || '').trim().toLowerCase() === 'true';

    if (!email || !password) return;

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        console.warn(`⚠️  INITIAL_ADMIN_EMAIL is not a valid email address — no account was created.`);
        return;
    }
    if (password.length < 10) {
        // Refused rather than trimmed to a warning: this account can edit every
        // listing in the municipality.
        console.warn('⚠️  INITIAL_ADMIN_PASSWORD is shorter than 10 characters — no account was created.');
        return;
    }

    try {
        const existing = await Admin.findOne({ email });

        if (!existing) {
            await new Admin({ email, password: await bcrypt.hash(password, 12) }).save();
            console.log(`🛡️  Tourism Officer account created for ${email}.`);
            console.log('    Sign in, then REMOVE INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD.');
            return;
        }

        if (forceReset) {
            existing.password = await bcrypt.hash(password, 12);
            // A forgotten password and a half-finished reset are different
            // problems; clearing this stops an old emailed link still working.
            existing.resetTokenHash = null;
            existing.resetTokenExpires = null;
            await existing.save();
            console.warn(`🔑 PASSWORD RESET: ${email} now uses INITIAL_ADMIN_PASSWORD.`);
            console.warn('    Remove ADMIN_PASSWORD_RESET, INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD now.');
            return;
        }

        console.log(`🛡️  ${email} already exists — left untouched.`);
        console.log('    To change its password, set ADMIN_PASSWORD_RESET=true and redeploy.');
    } catch (error) {
        console.error('❌ Could not create the Tourism Officer account:', error.message);
    }
}

async function migrateSpotManagement() {
    try {
        const copied = await Spot.collection.updateMany(
            { ownerId: { $exists: true }, managedBy: { $exists: false } },
            [{ $set: { managedBy: '$ownerId' } }]
        );
        if (copied.modifiedCount) {
            console.log(`🔤 Moved ownerId -> managedBy on ${copied.modifiedCount} listing(s).`);
        }

        const cleaned = await Spot.collection.updateMany(
            { ownerId: { $exists: true }, managedBy: { $exists: true } },
            { $unset: { ownerId: '' } }
        );
        if (cleaned.modifiedCount) {
            console.log(`🧹 Dropped the old ownerId field from ${cleaned.modifiedCount} listing(s).`);
        }
    } catch (error) {
        console.warn('⚠️ managedBy migration skipped:', error.message);
    }
}



const MAX_SPOT_IMAGES = 30;

// 5. Spot Schema — covers both tourist spots and accommodations, managed either by
//    the Tourist Officer (municipal-level, no manager) or by a Tourist Establishment
//    Manager account.
const SpotSchema = new mongoose.Schema({
    title: { type: String, required: true },
    // The short place label on cards and in search. Editors no longer ask for it
    // separately — it is filled from the Location Information below.
    location: { type: String, required: [true, 'Fill in the Location Information so the listing has a place to show.'] },
    category: { type: String, required: true },
    description: { type: String, required: true },
    // Cover image, shown on cards and at the top of the detail page. Kept as its own
    // field so spots created before galleries existed still display.
    imageUrl: { type: String },
    // The full gallery. Only the links live here — the files themselves are hosted
    // externally, since 30 photos inlined would exceed both the 1MB request limit
    // and MongoDB's 16MB document cap many times over.
    images: {
        type: [String],
        default: [],
        validate: {
            validator: list => list.length <= MAX_SPOT_IMAGES,
            message: `A spot can have at most ${MAX_SPOT_IMAGES} photos.`
        }
    },
    // Booking happens on the establishment's own website — this is where "Book Now" sends
    // the visitor. Blank means the detail page shows contact details instead.
    bookingUrl: { type: String, default: "" },
    // Whether this is a place to stay or a place to visit. Editors no longer ask
    // for it — it follows the category, which already carries ACCOMMODATION.
    type: { type: String, enum: ['spot', 'accommodation'], default: 'spot' },
    label: { type: String, default: "" },
    workingDays: { type: String, default: "Everyday" },
    workingTime: { type: String, default: "All Day" },
    travelFee: { type: Number, default: 0 },
    entranceFee: { type: Number, default: 0 },

    // Where this place actually is. The establishment or the Tourism Office records
    // it once; from then on every visitor's directions, distance and travel time are
    // worked out from it per request. Nothing about the journey is stored here —
    // there is deliberately no travelTime field, because the answer depends entirely
    // on who is asking and from where.
    //
    // All optional: listings published before this existed keep working and simply
    // have no directions until someone sets a point on the map.
    address: { type: String, default: "" },
    barangay: { type: String, default: "" },
    municipality: { type: String, default: "Zamboanguita" },
    province: { type: String, default: "Negros Oriental" },
    latitude: { type: Number, default: null, min: -90, max: 90 },
    longitude: { type: Number, default: null, min: -180, max: 180 },

    // Which Tourist Establishment Manager account is assigned to maintain this
    // listing. Null means the Tourism Office maintains it directly.
    //
    // Nobody owns anything here. ZTIMS records who is responsible for keeping a
    // listing accurate, and that is all this field means — which is why it is not
    // called an owner. The municipality's authority over the public listing does
    // not pass to whoever is assigned to it.
    managedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'EstablishmentManager', default: null, index: true },

    // Whether the public sees this listing. Municipal tourism records are taken
    // down by changing this, never by deleting them: a spot closed for a season,
    // or a festival site between years, has to be restorable, and the record has
    // to survive either way.
    //   published   - live on the public site
    //   unpublished - hidden for now, fully restorable
    //   archived    - retired; kept for the record
    // Only the Tourism Officer may change it; an establishment manages its
    // listing's information, not whether the municipality publishes it.
    status: { type: String, enum: ['published', 'unpublished', 'archived'], default: 'published', index: true },
    statusNote: { type: String, default: "" },
    statusUpdatedAt: { type: Date, default: null },

    // Whether the municipality requires a tourist guide here. A municipal
    // decision, so only the Tourism Office sets it — which guides serve the spot
    // is recorded on the guide, not duplicated into this document.
    requiresGuide: { type: Boolean, default: false, index: true }
}, { timestamps: true });

const Spot = mongoose.model('Spot', SpotSchema);

// 6. Tourist Guide — a municipal tourism record, not a ZTIMS account.
//    Guides do not sign in. The Tourism Office keeps these records the way it
//    keeps any other tourism information, which is why there is no password,
//    no email sign-in, and no role attached to them anywhere.
const GUIDE_STATUSES = ['available', 'unavailable', 'inactive'];

const TouristGuideSchema = new mongoose.Schema({
    fullName: { type: String, required: true, trim: true },
    photoUrl: { type: String, default: "" },
    contactNumber: { type: String, default: "" },
    // General area rather than a precise address: this is a person, and a pin on
    // their home is not tourism information.
    location: { type: String, default: "" },
    bio: { type: String, default: "" },
    guideFee: { type: Number, default: 0, min: 0 },
    maxGroupSize: { type: Number, default: 1, min: 1 },

    //   available   — can be assigned to new bookings
    //   unavailable — temporarily not taking work
    //   inactive    — no longer taking new bookings
    // Inactive never erases anything: past bookings keep pointing at the guide
    // who actually led them.
    status: { type: String, enum: GUIDE_STATUSES, default: 'available', index: true },

    // The spots this guide serves. Held here rather than on the spot so a guide's
    // details live in one place and a spot never carries a stale copy of them.
    assignedSpots: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Spot' }]
}, { timestamps: true });

const TouristGuide = mongoose.model('TouristGuide', TouristGuideSchema);

// 7. Guide booking — submitted by a visitor with no ZTIMS account.
//    The reference is the visitor's only handle on it: they quote it at the
//    Municipal Tourism Office, pay there, and the officer confirms it.
/* The set of ISO 3166-1 alpha-2 codes a booking's nationality may be. Mirrors
   the list in Zamboanguita-project/src/shared/countries.js, which also carries
   the display names the browser needs. The two deploy separately (Render and
   Vercel) so they cannot share a file; scripts/check-countries.cjs compares
   them, because a code the form offers and the API rejects is a booking a
   visitor cannot submit and cannot see why. */
const COUNTRY_CODES = new Set((
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ ' +
    'BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM ' +
    'DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS ' +
    'GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN ' +
    'KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ ' +
    'MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM ' +
    'PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV ' +
    'SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI ' +
    'VN VU WF WS YE YT ZA ZM ZW'
).trim().split(/\s+/));

const BOOKING_STATUSES = ['pending_payment', 'confirmed', 'cancelled', 'completed', 'no_show'];

const GuideBookingSchema = new mongoose.Schema({
    reference: { type: String, required: true, unique: true, index: true },

    // Where and when. The spot is fixed at submission; the visitor does not pick
    // a guide, so guideId stays null until the Tourism Office assigns one.
    spotId: { type: mongoose.Schema.Types.ObjectId, ref: 'Spot', required: true, index: true },
    guideId: { type: mongoose.Schema.Types.ObjectId, ref: 'TouristGuide', default: null, index: true },

    // Only what is needed to hold a booking and recognise the person at the
    // counter. No account is created from any of this.
    fullName: { type: String, required: true, trim: true },
    contactNumber: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },

    /* Nationality as an ISO 3166-1 alpha-2 code, because the office reports
       domestic and foreign arrivals upward and free text cannot be counted.
       The code outlives a country being renamed; the name is only presentation.

       Required by the POST route below, but deliberately NOT required here.
       Every booking the officer touches — assigning a guide, recording payment,
       changing status — goes through booking.save(), and a required field would
       make each of those throw on any booking taken before this existed. The
       officer would be unable to confirm them, which is a worse outcome than an
       older booking having no nationality on file. */
    nationality: { type: String, default: '', uppercase: true, trim: true, index: true },

    visitors: { type: Number, required: true, min: 1 },
    preferredDate: { type: String, required: true },   // YYYY-MM-DD, as the form sends it
    preferredTime: { type: String, required: true },   // HH:MM, 24-hour
    notes: { type: String, default: "" },

    //   pending_payment — submitted, not yet paid for at the office
    //   confirmed       — the officer recorded payment and accepted it
    //   cancelled / completed / no_show — after the fact
    // Nothing is ever deleted; a booking that came to nothing is recorded as such.
    status: { type: String, enum: BOOKING_STATUSES, default: 'pending_payment', index: true },
    statusNote: { type: String, default: "" },
    statusUpdatedAt: { type: Date, default: null }
}, { timestamps: true });

const GuideBooking = mongoose.model('GuideBooking', GuideBookingSchema);

// 8. Payment — kept separate from the booking, because it is a different event
//    with its own record: who took the money, when, against which receipt.
//    There is no online payment anywhere in ZTIMS; this is a record of cash
//    taken at the counter.
const PaymentSchema = new mongoose.Schema({
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'GuideBooking', required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, default: 'cash' },
    receiptNumber: { type: String, default: "" },
    paidAt: { type: Date, default: Date.now },
    // The officer who took it, kept by id and email so the record survives the
    // account being renamed later.
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    recordedByEmail: { type: String, default: "" },
    remarks: { type: String, default: "" }
}, { timestamps: true });

const Payment = mongoose.model('Payment', PaymentSchema);

// 9. Feedback — what a visitor sends from the public Contact Us page. No
//    account stands behind it, so it carries only what they chose to type:
//    a topic, the message, and a name and email if they want a reply.
//    Nothing is deleted; a message the office has dealt with is marked
//    resolved, the same way a booking that came to nothing is marked cancelled.
const FEEDBACK_TOPICS = ['suggestion', 'listing', 'problem', 'booking', 'other'];
const FEEDBACK_STATUSES = ['new', 'read', 'resolved'];
const FEEDBACK_MESSAGE_MAX = 2000;

const FeedbackSchema = new mongoose.Schema({
    topic: { type: String, enum: FEEDBACK_TOPICS, default: 'other', index: true },
    message: { type: String, required: true, trim: true, maxlength: FEEDBACK_MESSAGE_MAX },
    name: { type: String, default: '', trim: true, maxlength: 120 },
    email: { type: String, default: '', lowercase: true, trim: true, maxlength: 254 },
    // The page they came from, when the browser says. Helps an officer find
    // "the listing with the wrong fee" without asking which one.
    page: { type: String, default: '', trim: true, maxlength: 500 },

    status: { type: String, enum: FEEDBACK_STATUSES, default: 'new', index: true },
    statusUpdatedAt: { type: Date, default: null },
    // Who last changed the status, kept by email so the record survives the
    // account being renamed later.
    statusUpdatedByEmail: { type: String, default: '' }
}, { timestamps: true });

const Feedback = mongoose.model('Feedback', FeedbackSchema);

const requireAuth = (req, res, next) => {
    const authorization = req.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Authentication required.' });

    try {
        req.auth = jwt.verify(token, process.env.JWT_SECRET);
        return next();
    } catch {
        return res.status(401).json({ success: false, message: 'Invalid or expired session.' });
    }
};

const requireAdmin = [requireAuth, (req, res, next) => {
    if (req.auth.role !== 'admin') return res.status(403).json({ success: false, message: 'Tourist Officer access required.' });
    return next();
}];

// ZTIMS has three kinds of account: tourist, Establishment Manager, Tourism
// Officer. 'resort_owner' is not a fourth — it is the spelling this same account
// type carried in tokens issued before the rename, kept here only so a session
// signed in back then is not thrown out mid-visit. Nothing issues it any more.
const MANAGER_ROLES = ['establishment_manager', 'resort_owner'];
const isEstablishmentManager = role => MANAGER_ROLES.includes(role);

const requireEstablishmentManager = [requireAuth, (req, res, next) => {
    if (!isEstablishmentManager(req.auth.role)) {
        return res.status(403).json({ success: false, message: 'Tourist Establishment Manager access required.' });
    }
    return next();
}];


// Tourist Officer or Tourist Establishment Manager — used on routes both manage,
// each scoped to their own data.
const requireStaff = [requireAuth, (req, res, next) => {
    if (req.auth.role !== 'admin' && !isEstablishmentManager(req.auth.role)) {
        return res.status(403).json({ success: false, message: 'Staff access required.' });
    }
    return next();
}];

const optionalAuth = (req, res, next) => {
    const authorization = req.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (token) {
        try { req.auth = jwt.verify(token, process.env.JWT_SECRET); } catch { /* Public access remains available. */ }
    }
    return next();
};

const createToken = (account, role) => jwt.sign(
    { sub: account._id.toString(), role },
    process.env.JWT_SECRET,
    { expiresIn: '2h', issuer: 'ztims-api', audience: 'ztims-web' }
);


const RESET_TOKEN_TTL_MINUTES = 30;
const MIN_PASSWORD_LENGTH = 8;

const hashResetToken = token => crypto.createHash('sha256').update(token).digest('hex');

// Both reset routes answer the same way whether or not the email is registered,
// so neither can be used to discover who has an account here.
const GENERIC_RESET_REPLY = 'If that email has an account, a reset link is on its way. Check your inbox and spam folder.';

// Password reset is a high-value target, so it gets a tighter limit than login.
const resetRateLimit = sharedRateLimit('reset', {
    windowMs: 15 * 60 * 1000,
    limit: 5,
    message: { success: false, message: 'Too many password reset attempts. Please wait a few minutes and try again.' }
});

/* ==========================================
   4. API ROUTE HANDLERS
========================================== */

/**
 * 🌟 POST: Add and register a brand new Admin into MongoDB
 * Target URL: http://localhost:5000/api/admin/create
 */
app.post('/api/admin/create', requireAdmin, async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Missing mandatory email or password parameters.' });
        }

        const normalizedEmail = email.toLowerCase().trim();

        // Check if an admin with this email already exists
        const existingAdmin = await Admin.findOne({ email: normalizedEmail });
        if (existingAdmin) {
            return res.status(409).json({ success: false, message: 'This email is already registered as an admin.' });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const newAdmin = new Admin({ 
            email: normalizedEmail, 
            password: passwordHash
        });
        
        await newAdmin.save();

        console.log(`🛡️ New Administrator saved directly to MongoDB 'admins' collection: ${normalizedEmail}`);
        return res.status(201).json({ success: true, message: 'New admin successfully added!' });
    } catch (error) {
        console.error("❌ Add Admin Endpoint Failure:", error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

/**
 * 🌟 GET: Fetch list of all system administrators from MongoDB
 * Target URL: http://localhost:5000/api/admin/list
 */
app.get('/api/admin/list', requireAdmin, async (req, res) => {
    try {
        const adminList = await Admin.find({}, { password: 0 });
        return res.status(200).json(adminList);
    } catch (error) {
        console.error("❌ Get Admin List Endpoint Failure:", error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

/**
 * POST: the Tourism Officer changes their own password.
 *
 * The officer's profile page had a Security panel with three password boxes and
 * nowhere to send them — no route existed, so the only way an officer could ever
 * change their own password was the forgot-password email, which needs SMTP
 * credentials that are not configured. Establishment managers have had
 * /api/establishment-managers/me/password all along; this is the same thing for
 * the account that oversees them, and deliberately mirrors it.
 *
 * The current password is required, and checked, for the same reason it is
 * there: an unattended signed-in browser must not be enough to lock the real
 * officer out of the account that administers the whole system.
 */
app.post('/api/admin/me/password', requireAdmin, resetRateLimit, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'Your current and new passwords are both required.' });
        }
        if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ success: false, message: `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        }

        const admin = await Admin.findById(req.auth.sub).select('+password');
        if (!admin) return res.status(404).json({ success: false, message: 'Account not found.' });

        if (!(await bcrypt.compare(currentPassword, admin.password))) {
            return res.status(401).json({ success: false, message: 'That current password is not right.' });
        }

        admin.password = await bcrypt.hash(newPassword, 12);
        admin.resetTokenHash = null;        // any reset link in flight is now void
        admin.resetTokenExpires = null;
        await admin.save();

        console.log(`🔑 Tourism Officer changed their own password: ${admin.email}`);
        return res.status(200).json({ success: true, message: 'Your password has been changed.' });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Officer password change failure:');
    }
});

/**
 * POST: Tourist Officer creates a Tourist Establishment Manager account (managers do
 * not self-register — the Tourist Officer oversees the whole system and issues these
 * accounts directly)
 * Target URL: http://localhost:5000/api/establishment-managers
 */
async function createEstablishmentManager(req, res) {
    try {
        const { email, password, phone, managerName } = req.body;
        // Either spelling is accepted so a page that has not been redeployed since
        // the rename still creates accounts correctly.
        const establishmentName = req.body.establishmentName || req.body.resortName;

        if (!email || !password || !establishmentName) {
            return res.status(400).json({ success: false, message: 'Missing mandatory email, password, or establishment name.' });
        }

        const normalizedEmail = email.toLowerCase().trim();
        const existingManager = await EstablishmentManager.findOne({ email: normalizedEmail });
        if (existingManager) {
            return res.status(409).json({ success: false, message: 'This email is already registered as an establishment manager.' });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const newManager = new EstablishmentManager({
            email: normalizedEmail,
            password: passwordHash,
            establishmentName: establishmentName.trim(),
            managerName: (managerName || "").trim(),
            // Left blank, the sign-in address doubles as the public one, so a
            // listing never ends up with no way to reach anybody.
            contactEmail: (req.body.contactEmail || normalizedEmail).toLowerCase().trim(),
            phone: phone || ""
        });
        await newManager.save();

        console.log(`🏨 New Tourist Establishment Manager account created by Tourist Officer: ${normalizedEmail}`);
        return res.status(201).json({ success: true, message: 'Establishment manager account created!' });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Create Establishment Manager Endpoint Failure:');
    }
}

/**
 * GET: Tourist Officer lists all establishment manager accounts
 * Target URL: http://localhost:5000/api/establishment-managers
 */
async function listEstablishmentManagers(req, res) {
    try {
        const managers = await EstablishmentManager.find({}, { password: 0 });
        // Always answer with establishmentName, whatever the document holds, so no
        // caller has to know which spelling it was saved under.
        return res.status(200).json(managers.map(manager => ({
            ...manager.toObject(),
            establishmentName: manager.displayName,
            contactEmail: manager.contactEmail || manager.email
        })));
    } catch (error) {
        console.error("❌ Get Establishment Manager List Endpoint Failure:", error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
}

app.post('/api/establishment-managers', requireAdmin, createEstablishmentManager);
app.get('/api/establishment-managers', requireAdmin, listEstablishmentManagers);

/* ---- The manager's own account ---------------------------------------------
   Everything here is scoped to req.auth.sub, so a manager can only ever read or
   change their own record — the id never comes from the request. Before these
   routes existed, an account was issued once and could never be corrected: a
   phone number that changed was wrong forever, and a forgotten password meant
   the account was gone for good. */

/**
 * Turns a failed write into an answer the officer can act on. "Internal Server
 * Error" is what hid a broken validate hook here until somebody reported it:
 * the reason existed, it just never left the server. These routes are all
 * staff-authenticated, so the real message is worth more than the little it
 * reveals.
 */
function reportWriteFailure(res, error, context) {
    console.error(context, error);

    if (error && error.name === 'ValidationError') {
        const detail = Object.values(error.errors || {}).map(one => one.message).join(' ');
        return res.status(400).json({ success: false, message: detail || error.message || 'Some of those details are not valid.' });
    }
    if (error && error.code === 11000) {
        const field = Object.keys(error.keyPattern || error.keyValue || {})[0] || 'value';
        return res.status(409).json({ success: false, message: `That ${field} is already registered.` });
    }
    return res.status(500).json({
        success: false,
        message: `The server could not complete that: ${(error && error.message) || 'unknown error'}`
    });
}

// Shape sent to whoever is allowed to see an account. Never includes the hash.
function managerProfile(manager) {
    return {
        _id: manager._id,
        establishmentName: manager.displayName,
        managerName: manager.managerName || '',
        email: manager.email,
        contactEmail: manager.contactEmail || manager.email,
        phone: manager.phone || '',
        active: manager.active !== false,
        operationalStatus: manager.operationalStatus || 'active',
        statusNeedsReview: Boolean(manager.statusNeedsReview),
        statusNote: manager.statusNote || '',
        statusUpdatedAt: manager.statusUpdatedAt || null,
        createdAt: manager.createdAt
    };
}

app.get('/api/establishment-managers/me', requireEstablishmentManager, async (req, res) => {
    try {
        const manager = await EstablishmentManager.findById(req.auth.sub);
        if (!manager) return res.status(404).json({ success: false, message: 'Account not found.' });
        return res.status(200).json({ success: true, manager: managerProfile(manager) });
    } catch (error) {
        console.error('❌ Manager profile read failure:', error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

/**
 * PATCH: the establishment reports whether it is operating.
 *
 * This is the establishment speaking about its own business, so it is theirs to
 * set. It deliberately cannot touch `active` — suspending an account is the
 * office's decision, and a place must not be able to lift its own suspension.
 *
 * Reporting a change raises statusNeedsReview, which is how a closure reaches the
 * Tourism Office rather than sitting unnoticed on a listing.
 */
app.patch('/api/establishment-managers/me/status', requireEstablishmentManager, async (req, res) => {
    try {
        const status = String(req.body.operationalStatus || '').trim();
        if (!['active', 'inactive', 'closed'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Choose whether the establishment is operating, temporarily closed, or permanently closed.' });
        }

        const manager = await EstablishmentManager.findById(req.auth.sub);
        if (!manager) return res.status(404).json({ success: false, message: 'Account not found.' });

        const changed = manager.operationalStatus !== status;
        manager.operationalStatus = status;
        manager.statusNote = String(req.body.statusNote || '').trim().slice(0, 500);
        manager.statusUpdatedAt = new Date();
        if (changed) manager.statusNeedsReview = true;
        await manager.save();

        const listings = await Spot.countDocuments({ managedBy: manager._id });
        console.log(`🏷️ ${manager.email} reported operationalStatus=${status}`);

        return res.status(200).json({
            success: true,
            message: status === 'active'
                ? 'Recorded as operating. Your listings are public again.'
                : `Recorded. Your ${listings} listing${listings === 1 ? '' : 's'} ${listings === 1 ? 'is' : 'are'} hidden from the public site, and the Tourism Office has been notified for review. Nothing has been deleted.`,
            manager: managerProfile(manager)
        });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Establishment status update failure:');
    }
});

/**
 * The details a manager maintains themselves. The sign-in email is deliberately
 * not among them: changing it would lock them out of the account they are
 * currently using if they mistype it, so only the Tourist Officer may do that.
 */
async function applyManagerDetails(manager, body) {
    if (typeof body.establishmentName === 'string') {
        const name = body.establishmentName.trim();
        if (!name) throw new Error('The establishment needs a name.');
        manager.establishmentName = name;
        manager.resortName = undefined;     // the pre-rename copy would go stale
    }
    if (typeof body.managerName === 'string') manager.managerName = body.managerName.trim();
    if (typeof body.phone === 'string') manager.phone = body.phone.trim();
    if (typeof body.contactEmail === 'string') {
        const contact = body.contactEmail.trim().toLowerCase();
        if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
            throw new Error('That contact email does not look like an email address.');
        }
        // Blank means "use the sign-in address", which is what the public side reads.
        manager.contactEmail = contact || manager.email;
    }
    await manager.save();
    return manager;
}

app.patch('/api/establishment-managers/me', requireEstablishmentManager, async (req, res) => {
    try {
        const manager = await EstablishmentManager.findById(req.auth.sub);
        if (!manager) return res.status(404).json({ success: false, message: 'Account not found.' });

        await applyManagerDetails(manager, req.body);
        return res.status(200).json({ success: true, message: 'Your details have been saved.', manager: managerProfile(manager) });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Manager profile update failure:');
    }
});

app.post('/api/establishment-managers/me/password', requireEstablishmentManager, resetRateLimit, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'Your current and new passwords are both required.' });
        }
        if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ success: false, message: `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        }

        const manager = await EstablishmentManager.findById(req.auth.sub).select('+password');
        if (!manager) return res.status(404).json({ success: false, message: 'Account not found.' });

        // Proving the current password is what stops a borrowed, still-signed-in
        // browser from being used to lock the real manager out.
        if (!(await bcrypt.compare(currentPassword, manager.password))) {
            return res.status(401).json({ success: false, message: 'That current password is not right.' });
        }

        manager.password = await bcrypt.hash(newPassword, 12);
        manager.resetTokenHash = null;      // any reset link in flight is now void
        manager.resetTokenExpires = null;
        await manager.save();

        console.log(`🔑 Establishment manager changed their own password: ${manager.email}`);
        return res.status(200).json({ success: true, message: 'Your password has been changed.' });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Manager password change failure:');
    }
});


/* ---- Officer-side account lifecycle ---------------------------------------- */

/**
 * PATCH: correct an account's details, or suspend and restore it.
 * Suspending blocks sign-in and takes the manager's listings off the public site
 * without deleting anything, so a closure or a change of management is reversible.
 */
app.patch('/api/establishment-managers/:id', requireAdmin, async (req, res) => {
    try {
        const manager = await EstablishmentManager.findById(req.params.id);
        if (!manager) return res.status(404).json({ success: false, message: 'That account no longer exists.' });

        if (typeof req.body.email === 'string' && req.body.email.trim()) {
            const email = req.body.email.trim().toLowerCase();
            if (email !== manager.email) {
                const taken = await EstablishmentManager.findOne({ email });
                if (taken) return res.status(409).json({ success: false, message: 'Another establishment already signs in with that email.' });
                manager.email = email;
            }
        }
        if (typeof req.body.active === 'boolean') manager.active = req.body.active;

        // Municipal oversight: the officer can set the operating status too, and
        // acting on a reported change clears it from the review queue.
        if (['active', 'inactive', 'closed'].includes(req.body.operationalStatus)) {
            manager.operationalStatus = req.body.operationalStatus;
            manager.statusUpdatedAt = new Date();
        }
        if (req.body.statusReviewed === true) manager.statusNeedsReview = false;

        await applyManagerDetails(manager, req.body);

        const listings = await Spot.countDocuments({ managedBy: manager._id });
        console.log(`🏨 Officer updated ${manager.email} (active: ${manager.active !== false})`);
        return res.status(200).json({
            success: true,
            message: manager.active === false
                ? `Account suspended. Its ${listings} listing${listings === 1 ? '' : 's'} are hidden from the public site.`
                : 'Account updated.',
            manager: managerProfile(manager)
        });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Officer manager update failure:');
    }
});

/**
 * POST: the Tourist Officer issues a new password for a manager who is locked out.
 * The new password is returned once so the officer can pass it on — it is stored
 * only as a hash and cannot be read back afterwards.
 */
app.post('/api/establishment-managers/:id/password', requireAdmin, async (req, res) => {
    try {
        const manager = await EstablishmentManager.findById(req.params.id);
        if (!manager) return res.status(404).json({ success: false, message: 'That account no longer exists.' });

        const newPassword = String(req.body.newPassword || '').trim() || crypto.randomBytes(6).toString('base64url');
        if (newPassword.length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ success: false, message: `A password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        }

        manager.password = await bcrypt.hash(newPassword, 12);
        manager.resetTokenHash = null;
        manager.resetTokenExpires = null;
        await manager.save();

        console.log(`🔑 Officer issued a new password for ${manager.email}`);
        return res.status(200).json({
            success: true,
            message: 'A new password has been set. Pass it on — it cannot be read again.',
            email: manager.email,
            newPassword
        });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Officer password issue failure:');
    }
});

/**
 * DELETE: remove an account outright. Refused while listings are still assigned
 * to it, because deleting would leave those listings with nobody responsible for
 * them — suspend instead, or reassign the listings first, deliberately.
 */
app.delete('/api/establishment-managers/:id', requireAdmin, async (req, res) => {
    try {
        const manager = await EstablishmentManager.findById(req.params.id);
        if (!manager) return res.status(404).json({ success: false, message: 'That account no longer exists.' });

        const listings = await Spot.countDocuments({ managedBy: manager._id });
        if (listings > 0) {
            return res.status(409).json({
                success: false,
                message: `This account still has ${listings} listing${listings === 1 ? '' : 's'}. Suspend it instead, or take those listings down first.`
            });
        }

        await manager.deleteOne();
        console.log(`🗑️ Officer deleted establishment manager account ${manager.email}`);
        return res.status(200).json({ success: true, message: 'Account deleted.' });
    } catch (error) {
        console.error('❌ Officer manager delete failure:', error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});



/**
 * POST: Sign in. ZTIMS has two kinds of account: Tourism Officer and Tourist
 * Establishment Manager. Visitors browse without one.
 * Target URL: http://localhost:5000/api/login
 */
app.post('/api/login', sharedRateLimit('login', { windowMs: 15 * 60 * 1000, limit: 10 }), async (req, res) => {
    try {
        const { email, password, role } = req.body; 
        console.log(`➡️ Login attempt received for: ${email} | Role Context: ${role || 'staff'}`);

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Missing email or password.' });
        }

        const normalizedEmail = email.toLowerCase().trim();
        // 'staff' means the caller doesn't know which kind of staff account this is
        // — the shared staff sign-in page. We work it out rather than making the
        // person choose, since picking the wrong portal would reject a correct password.
        // ZTIMS has exactly two kinds of account. Anything else is refused here
        // rather than quietly searched for in a collection that no longer exists.
        const requestedRole = ['admin', 'establishment_manager', 'resort_owner', 'staff'].includes(role) ? role : null;
        if (!requestedRole) {
            return res.status(400).json({ success: false, message: 'Unknown sign-in type.' });
        }
        let account = null;
        let resolvedRole = requestedRole;

        if (requestedRole === 'staff') {
            account = await Admin.findOne({ email: normalizedEmail }).select('+password');
            resolvedRole = 'admin';

            if (!account) {
                account = await EstablishmentManager.findOne({ email: normalizedEmail }).select('+password');
                resolvedRole = 'establishment_manager';
            }
        } else if (requestedRole === 'admin') {
            account = await Admin.findOne({ email: normalizedEmail }).select('+password');
        } else {
            account = await EstablishmentManager.findOne({ email: normalizedEmail }).select('+password');
            resolvedRole = 'establishment_manager';
        }

        // A suspended account is told plainly, rather than being left to think
        // they are mistyping a password that is in fact correct.
        if (account && isEstablishmentManager(resolvedRole) && account.active === false) {
            return res.status(403).json({
                success: false,
                message: 'This account has been suspended by the Municipal Tourism Office. Please contact them to have it restored.'
            });
        }

        if (!account || !(await bcrypt.compare(password, account.password))) {
            // Deliberately the same wording whichever collection was searched, so the
            // response can't be used to discover which emails are registered.
            const audience = requestedRole === 'staff' ? 'staff'
                : resolvedRole === 'admin' ? 'Tourist Officer'
                : 'Tourist Establishment Manager';
            return res.status(401).json({
                success: false,
                message: `Authentication failed: Invalid ${audience} credentials.`
                });
        }

        // Base payload data structures object mapping logic
        const responseData = {
            success: true,
            message: `Login Successful! Welcome back.`,
            token: createToken(account, resolvedRole),
            role: resolvedRole,
            userId: account._id, // Sends valid object database identifier instead of 'anonymous_guest'
            user: {
                email: account.email,
                name: account.fullName || account.displayName || account.email.split('@')[0],
                fullName: account.fullName || "",
                phone: account.phone || "",
                nationality: account.nationality || "",
                establishmentName: account.displayName || "",
                // Pre-rename key, still sent so a page cached from before the rename
                // keeps showing the establishment's name instead of a blank.
                resortName: account.displayName || ""
            }
        };

        return res.status(200).json(responseData);
    } catch (error) {
        console.error("❌ Auth Route Error:", error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});


// Configure Nodemailer for Email Transports. Credentials come from the environment
// — the address and Gmail App Password must never be committed.
const mailConfigured = Boolean(process.env.MAIL_USER && process.env.MAIL_PASSWORD);

const transporter = mailConfigured
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASSWORD }
    })
    : null;

if (!mailConfigured) {
    console.warn('⚠️  MAIL_USER / MAIL_PASSWORD are not set — password reset emails are disabled.');
}

/* ==========================================
   PASSWORD RESET
   A reset must prove the person can read the account's inbox. The link carries
   a one-time token; only its hash is stored, it expires, and it is destroyed
   the moment it is used. Before this, /api/reset-password took an email and a
   new password and nothing else, so anyone who knew a registered address could
   take over that account.
========================================== */

/**
 * Reset covers every account type that signs in with a password, so staff are not
 * left with an account that dies the moment its password is forgotten. Tourists
 * who signed up through Google are skipped — they have no password here — and a
 * suspended manager cannot reset their way back in.
 * Returns the account document, or null.
 */
async function findResettableAccount(email, withResetFields) {
    const withFields = query => (withResetFields ? query.select('+resetTokenHash +resetTokenExpires') : query);

    const manager = await withFields(EstablishmentManager.findOne({ email }));
    if (manager) return manager.active === false ? null : manager;

    return withFields(Admin.findOne({ email }));
}

/**
 * POST: Send a password reset link
 * Target URL: http://localhost:5000/api/forgot-password
 */
app.post('/api/forgot-password', resetRateLimit, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, message: 'Email required.' });

        // Say so plainly rather than appearing to send an email that never arrives.
        if (!mailConfigured) {
            return res.status(503).json({
                success: false,
                message: "Password reset email isn't set up yet. Please contact the tourism office to have your password reset."
            });
        }

        const normalizedEmail = email.toLowerCase().trim();
        const user = await findResettableAccount(normalizedEmail, false);

        // An address with no resettable account gets exactly the same answer as
        // one that has, so this cannot be used to find out who is registered.
        if (!user) {
            return res.status(200).json({ success: true, message: GENERIC_RESET_REPLY });
        }

        const token = crypto.randomBytes(32).toString('hex');
        user.resetTokenHash = hashResetToken(token);
        user.resetTokenExpires = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);
        await user.save();

        // Must point at the deployed site, not a local dev server, or the link in
        // the email is useless to everyone but the developer.
        const siteUrl = (process.env.PUBLIC_SITE_URL || allowedOrigins[0] || '').replace(/\/$/, '');
        const resetLink = `${siteUrl}/src/user/reset_password.html?email=${encodeURIComponent(normalizedEmail)}&token=${token}`;

        try {
            await transporter.sendMail({
                from: `"Zamboanguita Tourism" <${process.env.MAIL_USER}>`,
                to: normalizedEmail,
                subject: 'Reset Password Request - Zamboanguita Tourism',
                html: `
                    <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                        <h2 style="color: #2E7D32;">Zamboanguita Tourism Portal</h2>
                        <p>Hello,</p>
                        <p>We received a request to change the password for your account.</p>
                        <p>Click the button below to create a new password. This link works once and expires in ${RESET_TOKEN_TTL_MINUTES} minutes.</p>
                        <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; color: white; background-color: #2E7D32; text-decoration: none; border-radius: 25px; font-weight: bold; margin: 15px 0;">Reset Password</a>
                        <p style="font-size: 12px; color: #666;">If the button doesn't work, paste this into your browser:<br>${resetLink}</p>
                        <p>If you didn't ask to change your password, you can ignore this email — your password stays as it is.</p>
                    </div>
                `
            });
        } catch (mailError) {
            // The token is useless if the email never left, so don't leave it live.
            user.resetTokenHash = null;
            user.resetTokenExpires = null;
            await user.save();
            console.error('Reset email failed to send:', mailError);
            return res.status(502).json({ success: false, message: 'Could not send the reset email just now. Please try again in a moment.' });
        }

        return res.status(200).json({ success: true, message: GENERIC_RESET_REPLY });
    } catch (error) {
        console.error('Forgot password error:', error);
        return res.status(500).json({ success: false, message: 'Server error sending email link.' });
    }
});

/**
 * POST: Set a new password, proving control of the mailbox with the emailed token
 * Target URL: http://localhost:5000/api/reset-password
 */
app.post('/api/reset-password', resetRateLimit, async (req, res) => {
    try {
        const { email, token, newPassword } = req.body;

        if (!email || !token || !newPassword) {
            return res.status(400).json({ success: false, message: 'The reset link, your email and a new password are all required.' });
        }

        if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ success: false, message: `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        }

        const user = await findResettableAccount(String(email).toLowerCase().trim(), true);

        // One message for every way this can fail — a wrong token, an expired one,
        // an already-used one or an unknown email are indistinguishable from outside.
        const refuse = () => res.status(400).json({
            success: false,
            message: 'That reset link is invalid or has expired. Please request a new one.'
        });

        if (!user || !user.resetTokenHash || !user.resetTokenExpires) return refuse();
        if (user.resetTokenExpires.getTime() < Date.now()) return refuse();

        const provided = Buffer.from(hashResetToken(String(token)), 'utf8');
        const stored = Buffer.from(user.resetTokenHash, 'utf8');
        // Compared in constant time so the comparison itself reveals nothing.
        if (provided.length !== stored.length || !crypto.timingSafeEqual(provided, stored)) return refuse();

        user.password = await bcrypt.hash(newPassword, 12);
        // Spent immediately, so the same link cannot be replayed.
        user.resetTokenHash = null;
        user.resetTokenExpires = null;
        await user.save();

        console.log(`🔑 Password reset completed for ${user.email}`);
        return res.status(200).json({ success: true, message: 'Your password has been changed. You can sign in with it now.' });
    } catch (error) {
        console.error('Reset password error:', error);
        return res.status(500).json({ success: false, message: 'Internal server update error.' });
    }
});







/* ==========================================
   ADDED: LIVE ANALYTICS MAPPER LINKS
========================================== */


/**
 * 🌟 GET & POST: Destination system endpoints to prevent dashboard client parsing error loops
 * Target URL: http://localhost:5000/api/spots
 *
 * GET stays public — guests browse tourist spots/accommodations without logging in.
 * Pass ?mine=true (Tourist Establishment Manager) to scope results to their own listings.
 */
app.get('/api/spots', optionalAuth, async (req, res) => {
    try {
        const query = {};
        if (req.query.mine === 'true' && isEstablishmentManager(req.auth?.role)) {
            // A manager asking for "mine" gets exactly the listings assigned to
            // them — the scope is applied in the query, not left to the caller.
            query.managedBy = req.auth.sub;
        }
        // The establishment's public-facing details come along so the officer's
        // oversight page can show who maintains each listing without a request per row.
        const foundSpots = await Spot.find(query)
            .populate('managedBy', 'establishmentName resortName managerName contactEmail phone active operationalStatus')
            .sort({ createdAt: -1 });

        // A suspended establishment's listings leave the public site, but the
        // Tourist Officer still sees them — otherwise the listings they just hid
        // would vanish from the very page they oversee them on.
        const visibleSpots = req.auth?.role === 'admin'
            ? foundSpots
            : foundSpots.filter(isPubliclyVisible);

        return res.status(200).json(visibleSpots.map(spot => {
            const plain = spot.toObject();
            const manager = plain.managedBy;
            return {
                ...plain,
                // No assigned manager means the Tourism Office maintains this listing.
                managerName: manager ? (manager.establishmentName || manager.resortName || '') : '',
                managerContact: manager ? (manager.managerName || '') : '',
                managerEmail: manager ? (manager.contactEmail || '') : '',
                managerPhone: manager ? (manager.phone || '') : ''
            };
        }));
    } catch (error) {
        return res.status(500).json([]);
    }
});

/**
 * Keeps the gallery and the cover image consistent no matter which editor sent the
 * payload: blanks and duplicates are dropped, the list is capped, and the cover is
 * always the first photo unless one was named explicitly.
 */
function normaliseSpotImages(payload) {
    if (!('images' in payload) && !('imageUrl' in payload)) return payload;

    const gallery = Array.isArray(payload.images) ? payload.images : [];
    const cleaned = [...new Set(
        gallery.map(url => String(url || '').trim()).filter(Boolean)
    )].slice(0, MAX_SPOT_IMAGES);

    const cover = String(payload.imageUrl || '').trim();

    return {
        ...payload,
        images: cleaned,
        // A cover that isn't in the gallery is still honoured — spots predating
        // galleries have only a cover, and the quick-add form only sets one.
        imageUrl: cover || cleaned[0] || ''
    };
}

/* ==========================================
   LISTING AUTHORIZATION
   ------------------------------------------
   One place decides who may touch a listing, so a route written later cannot
   quietly forget the rule. Every decision is made on ROLE and on the RESOURCE
   together: being an establishment manager is not enough on its own, the listing
   has to be one that manager is assigned to.

   None of this depends on the frontend. The portals hide actions the signed-in
   user cannot perform, but that is presentation. These functions are the
   authorization, and a hand-built request carrying someone else's listing id is
   refused here no matter what any page did or didn't show.
========================================== */

// What an establishment manager may write on a listing assigned to them: its
// tourism information, and nothing about who is responsible for it.
const MANAGER_WRITABLE_SPOT_FIELDS = [
    'title', 'location', 'category', 'description', 'imageUrl', 'images', 'bookingUrl',
    'type', 'label', 'workingDays', 'workingTime', 'travelFee', 'entranceFee',
    'address', 'barangay', 'municipality', 'province', 'latitude', 'longitude'
];
// Note what is absent: status, managedBy and requiresGuide. Publication and the
// guide requirement are municipal decisions, not an establishment's.

/**
 * Decides whether this caller may write to this listing.
 *
 * The Tourism Officer's authority covers every listing, including one a private
 * establishment maintains. That is the point of municipal oversight, and it does
 * not lapse because a manager has been assigned to the day-to-day upkeep.
 */
function authorizeSpotWrite(auth, spot) {
    if (!auth) return { allowed: false, status: 401, message: 'Authentication required.' };

    if (auth.role === 'admin') return { allowed: true, scope: 'officer' };

    if (isEstablishmentManager(auth.role)) {
        // Assigned to this exact listing, or not at all. An unassigned listing is
        // one the Tourism Office maintains, which is never a manager's to change.
        const assignedTo = spot.managedBy ? String(spot.managedBy._id || spot.managedBy) : '';
        if (!assignedTo || assignedTo !== String(auth.sub)) {
            return {
                allowed: false,
                status: 403,
                message: 'You may only manage listings assigned to your own establishment.'
            };
        }
        return { allowed: true, scope: 'manager' };
    }

    return { allowed: false, status: 403, message: 'Staff access required.' };
}

/**
 * Narrows a payload to the fields the caller's scope allows. An officer's passes
 * through whole; a manager's is reduced to their own establishment's information.
 *
 * Dropping beats rejecting here: the establishment's editor posts a whole listing
 * every time, and a field it never offered to change shouldn't fail the save.
 * What it must not set simply never reaches the document.
 */
function scopeSpotPayload(payload, scope) {
    if (scope === 'officer') return payload;

    const scoped = {};
    for (const field of MANAGER_WRITABLE_SPOT_FIELDS) {
        if (field in payload) scoped[field] = payload[field];
    }
    return scoped;
}

/**
 * The one rule for whether the public may see a listing, so the landing page, the
 * detail page and the officer's counts can never disagree about it.
 *
 * A listing drops off the public site while the account assigned to it is
 * suspended, and comes back when the office restores it. Nothing is deleted to
 * make that happen.
 */
function isPubliclyVisible(spot) {
    // The office's decision comes first and applies to every listing.
    if (spot.status && spot.status !== 'published') return false;

    const manager = spot.managedBy && typeof spot.managedBy === 'object' ? spot.managedBy : null;
    if (!manager) return true;              // maintained by the office; no account behind it

    if (manager.active === false) return false;     // account suspended by the office
    // A visitor should not be sent to a place that has told us it is shut, whether
    // or not the office has got round to reviewing it yet.
    return !['inactive', 'closed'].includes(manager.operationalStatus);
}

/**
 * Accepts a latitude/longitude pair only when it is genuinely usable, and returns
 * null rather than a guess when it isn't. Every routing request is checked through
 * here first, so a half-filled or out-of-range coordinate can never be sent to a
 * routing service or drawn on a map as though it meant something.
 */
function parseCoordinate(latitudeInput, longitudeInput) {
    // Number('') is 0, so a half-filled pair would otherwise pass as a point on the
    // equator off Africa. A blank half means there is no location, full stop.
    const isBlank = value => value === '' || value === null || value === undefined;
    if (isBlank(latitudeInput) || isBlank(longitudeInput)) return null;

    const latitude = Number(latitudeInput);
    const longitude = Number(longitudeInput);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (latitude < -90 || latitude > 90) return null;
    if (longitude < -180 || longitude > 180) return null;
    // Null Island, off the coast of Africa. It is what an unset pair coerces to,
    // and it is never a real place anyone in Negros Oriental is standing.
    if (latitude === 0 && longitude === 0) return null;

    return { latitude, longitude };
}

/**
 * Cleans the location fields on a spot payload without inventing any.
 *
 * A field the editor did not send is left untouched, so the quick-add form — which
 * has no map — cannot blank a location someone already set. Latitude and longitude
 * are only accepted as a valid pair: half a pair would put a marker in the sea.
 */
/**
 * Fills in the short place label shown on cards from the Location Information the
 * editor already collects, so nobody is asked for the same place twice.
 *
 * It only ever fills a blank. A listing that already says "Zamboanguita Proper"
 * keeps saying that, rather than being quietly rewritten to its barangay the next
 * time somebody saves it.
 */
/**
 * Works out whether a listing is a place to stay or a place to visit, from the
 * category the editor already asked for. Editors no longer ask separately: with
 * ACCOMMODATION sitting in the category list, the two questions were the same one
 * twice, and nothing stopped them contradicting each other.
 *
 * An explicit type is still honoured, so anything posting one directly keeps
 * working, and a payload with no category at all leaves the stored value alone.
 */
function deriveSpotType(payload) {
    if (payload.type) return payload;
    if (!payload.category) return payload;

    const isStay = String(payload.category).trim().toUpperCase() === 'ACCOMMODATION';
    return { ...payload, type: isStay ? 'accommodation' : 'spot' };
}

function deriveSpotLocation(payload, existingLocation) {
    const current = String(payload.location ?? existingLocation ?? '').trim();
    if (current) return payload;

    const derived = [payload.barangay, payload.address, payload.municipality]
        .map(part => String(part || '').trim())
        .find(Boolean);

    return derived ? { ...payload, location: derived } : payload;
}

function normaliseSpotLocation(payload) {
    const result = { ...payload };

    for (const field of ['address', 'barangay', 'municipality', 'province']) {
        if (field in result) result[field] = String(result[field] ?? '').trim();
    }

    if (!('latitude' in result) && !('longitude' in result)) return result;

    const isBlank = value => value === '' || value === null || value === undefined;
    if (isBlank(result.latitude) && isBlank(result.longitude)) {
        // Clearing the point on purpose. Directions simply become unavailable.
        result.latitude = null;
        result.longitude = null;
        return result;
    }

    const point = parseCoordinate(result.latitude, result.longitude);
    if (!point) {
        const error = new Error('Pick the location on the map — latitude and longitude must be a valid pair.');
        error.name = 'ValidationError';
        throw error;
    }

    result.latitude = point.latitude;
    result.longitude = point.longitude;
    return result;
}

/* ==========================================
   PHOTO UPLOADS
   ------------------------------------------
   Photos go from the browser straight to Cloudinary — they are far too large to
   pass through this API, which accepts 1 MB bodies.

   What used to authorise that upload was an unsigned preset sitting in the page
   source. Unsigned presets are designed to be public, so that was not a leaked
   secret, but it did mean anyone who read the page could upload to the
   municipality's account for as long as the preset existed.

   Now the browser asks here first. This route is staff-only, so a signature is
   issued to a signed-in Tourism Officer or establishment manager and to nobody
   else. The API secret never leaves the server; only the resulting signature
   does, and it covers a fixed folder and a timestamp Cloudinary will reject once
   it is an hour old.

   Set CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET, then switch the preset to
   "signed" in the Cloudinary console. Until those are set the browser falls back
   to the old unsigned upload, so nothing breaks in the meantime.
   ========================================== */

const CLOUDINARY_CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const CLOUDINARY_API_KEY = (process.env.CLOUDINARY_API_KEY || '').trim();
const CLOUDINARY_API_SECRET = (process.env.CLOUDINARY_API_SECRET || '').trim();
const CLOUDINARY_FOLDER = (process.env.CLOUDINARY_FOLDER || 'ztims').trim();

const cloudinarySigningReady = Boolean(
    CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET
);

// Cloudinary signs the upload parameters sorted by name, joined as a query
// string, with the API secret appended — then SHA-1 of the lot.
function signCloudinaryParams(params) {
    const toSign = Object.keys(params)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('&');
    return crypto.createHash('sha1').update(toSign + CLOUDINARY_API_SECRET).digest('hex');
}

app.get('/api/uploads/signature', requireStaff, (req, res) => {
    if (!cloudinarySigningReady) {
        // Not an error: the browser reads this and uses the unsigned preset, so
        // uploads keep working until the two variables are set.
        return res.status(200).json({ success: true, signed: false });
    }

    const timestamp = Math.round(Date.now() / 1000);
    const params = { folder: CLOUDINARY_FOLDER, timestamp };

    return res.status(200).json({
        success: true,
        signed: true,
        cloudName: CLOUDINARY_CLOUD_NAME,
        apiKey: CLOUDINARY_API_KEY,
        folder: CLOUDINARY_FOLDER,
        timestamp,
        signature: signCloudinaryParams(params)
    });
});

app.post('/api/spots', requireStaff, async (req, res) => {
    try {
        // A manager's listing is assigned to them, whatever the request claims;
        // only the officer may assign a listing to an establishment.
        const managedBy = isEstablishmentManager(req.auth.role)
            ? req.auth.sub
            : (req.body.managedBy || null);
        const scoped = scopeSpotPayload(req.body, isEstablishmentManager(req.auth.role) ? 'manager' : 'officer');
        const prepared = deriveSpotType(deriveSpotLocation(normaliseSpotLocation(normaliseSpotImages(scoped)), ''));
        const newSpot = new Spot({ ...prepared, managedBy });
        const savedSpot = await newSpot.save();
        return res.status(201).json(savedSpot);
    } catch (error) {
        return reportWriteFailure(res, error, 'Publishing a spot failed:');
    }
});

/**
 * GET: Fetch a single spot by id (public — used to pre-fill a booking from the landing page)
 * Target URL: http://localhost:5000/api/spots/:id
 */
app.get('/api/spots/:id', async (req, res) => {
    try {
        // Only the establishment's public-facing contact details — never the
        // sign-in email or password hash, since this route is open to anyone.
        const spot = await Spot.findById(req.params.id).populate('managedBy', 'establishmentName resortName managerName contactEmail phone active operationalStatus');
        if (!spot) return res.status(404).json({ message: 'Spot not found.' });
        // The same single rule the listing page uses, so the two cannot disagree.
        if (!isPubliclyVisible(spot)) {
            return res.status(404).json({ message: 'This destination is not available right now.' });
        }
        return res.status(200).json(spot);
    } catch (error) {
        return res.status(404).json({ message: 'Spot not found.' });
    }
});

/**
 * PATCH: the Tourism Office decides whether a listing is public.
 *
 * Officer-only, on every listing including those a private establishment
 * maintains — that is what municipal oversight means, and it is the reason this
 * is separate from editing the listing's information. An establishment keeps its
 * own details accurate; the municipality decides what the public sees.
 *
 * Nothing is deleted. Archiving retires a listing while keeping the record.
 */
app.patch('/api/spots/:id/status', requireAdmin, async (req, res) => {
    try {
        const status = String(req.body.status || '').trim();
        if (!['published', 'unpublished', 'archived'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Choose published, unpublished, or archived.' });
        }

        const spot = await Spot.findById(req.params.id);
        if (!spot) return res.status(404).json({ success: false, message: 'Listing not found.' });

        spot.status = status;
        spot.statusNote = String(req.body.statusNote || '').trim().slice(0, 500);
        spot.statusUpdatedAt = new Date();
        await spot.save();

        console.log(`📋 Officer set ${spot.title} to ${status}`);
        return res.status(200).json({
            success: true,
            message: status === 'published'
                ? `${spot.title} is public again.`
                : status === 'unpublished'
                    ? `${spot.title} is hidden from the public site. The record is kept and can be restored.`
                    : `${spot.title} is archived. The record is kept for the municipality's files.`,
            spot
        });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Listing status update failure:');
    }
});

/**
 * PUT/DELETE: Establishment Managers manage only their own spot; the Tourist Officer manages any.
 * Target URL: http://localhost:5000/api/spots/:id
 */
app.put('/api/spots/:id', requireStaff, async (req, res) => {
    try {
        const spot = await Spot.findById(req.params.id);
        if (!spot) return res.status(404).json({ message: 'Spot not found.' });

        const verdict = authorizeSpotWrite(req.auth, spot);
        if (!verdict.allowed) return res.status(verdict.status).json({ success: false, message: verdict.message });

        // Which establishment maintains a listing is never reassigned from here.
        const { managedBy, ownerId, ...updates } = req.body;
        const prepared = normaliseSpotLocation(normaliseSpotImages(scopeSpotPayload(updates, verdict.scope)));
        Object.assign(spot, deriveSpotType(deriveSpotLocation(prepared, spot.location)));
        const savedSpot = await spot.save();
        return res.status(200).json(savedSpot);
    } catch (error) {
        return reportWriteFailure(res, error, 'Saving a spot failed:');
    }
});

app.delete('/api/spots/:id', requireStaff, async (req, res) => {
    try {
        const spot = await Spot.findById(req.params.id);
        if (!spot) return res.status(404).json({ message: 'Spot not found.' });

        const verdict = authorizeSpotWrite(req.auth, spot);
        if (!verdict.allowed) return res.status(verdict.status).json({ success: false, message: verdict.message });

        await spot.deleteOne();
        return res.status(200).json({ success: true, message: 'Spot deleted.' });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

/* ==========================================
   4a. TOURIST GUIDES
   ------------------------------------------
   Municipal tourism records, managed by the Tourism Office alone. A guide is
   not a ZTIMS user: there is no account, no password and no role for them
   anywhere, and an establishment has no access to any of this.

   Everything a visitor needs to see is served by one public route that reports
   the requirement without exposing a guide's contact details.
========================================== */

/**
 * Cleans a guide payload. Numbers are coerced, because a form sends strings and a
 * fee of "500" silently stored as text would break every comparison later.
 */
function applyGuideDetails(guide, body) {
    if (typeof body.fullName === 'string') {
        const name = body.fullName.trim();
        if (!name) throw Object.assign(new Error('The guide needs a name.'), { name: 'ValidationError' });
        guide.fullName = name;
    }
    for (const field of ['photoUrl', 'contactNumber', 'location', 'bio']) {
        if (typeof body[field] === 'string') guide[field] = body[field].trim();
    }
    if (body.guideFee !== undefined) {
        const fee = Number(body.guideFee);
        if (!Number.isFinite(fee) || fee < 0) {
            throw Object.assign(new Error('The guide fee must be zero or more.'), { name: 'ValidationError' });
        }
        guide.guideFee = fee;
    }
    if (body.maxGroupSize !== undefined) {
        const size = Math.floor(Number(body.maxGroupSize));
        if (!Number.isFinite(size) || size < 1) {
            throw Object.assign(new Error('The maximum group size must be at least one person.'), { name: 'ValidationError' });
        }
        guide.maxGroupSize = size;
    }
    if (body.status !== undefined) {
        if (!GUIDE_STATUSES.includes(body.status)) {
            throw Object.assign(new Error('Choose available, unavailable, or inactive.'), { name: 'ValidationError' });
        }
        guide.status = body.status;
    }
    if (Array.isArray(body.assignedSpots)) {
        // Only ids that are real, and each one once.
        const valid = body.assignedSpots
            .map(id => String(id || '').trim())
            .filter(id => mongoose.isValidObjectId(id));
        guide.assignedSpots = [...new Set(valid)];
    }
    return guide;
}

app.get('/api/guides', requireAdmin, async (req, res) => {
    try {
        const guides = await TouristGuide.find()
            .populate('assignedSpots', 'title location status')
            .sort({ fullName: 1 });
        return res.status(200).json(guides);
    } catch (error) {
        console.error('❌ Guide list failure:', error);
        return res.status(500).json([]);
    }
});

app.post('/api/guides', requireAdmin, async (req, res) => {
    try {
        const guide = applyGuideDetails(new TouristGuide(), req.body);
        await guide.save();
        console.log(`🧭 Officer added guide ${guide.fullName}`);
        return res.status(201).json({ success: true, message: `${guide.fullName} added.`, guide });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Guide create failure:');
    }
});

app.put('/api/guides/:id', requireAdmin, async (req, res) => {
    try {
        const guide = await TouristGuide.findById(req.params.id);
        if (!guide) return res.status(404).json({ success: false, message: 'That guide record no longer exists.' });

        applyGuideDetails(guide, req.body);
        await guide.save();
        return res.status(200).json({ success: true, message: `${guide.fullName} updated.`, guide });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Guide update failure:');
    }
});

/**
 * Status on its own, so marking a guide unavailable for a fortnight does not mean
 * resubmitting their whole record.
 */
app.patch('/api/guides/:id/status', requireAdmin, async (req, res) => {
    try {
        if (!GUIDE_STATUSES.includes(req.body.status)) {
            return res.status(400).json({ success: false, message: 'Choose available, unavailable, or inactive.' });
        }
        const guide = await TouristGuide.findById(req.params.id);
        if (!guide) return res.status(404).json({ success: false, message: 'That guide record no longer exists.' });

        guide.status = req.body.status;
        await guide.save();
        return res.status(200).json({ success: true, message: `${guide.fullName} is now ${guide.status}.`, guide });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Guide status failure:');
    }
});

/**
 * PUBLIC: what a visitor needs to know before asking for a guide.
 *
 * Deliberately no names, no phone numbers and no guide ids: a visitor does not
 * choose their guide, the office assigns one. Only the fee, the group size and
 * whether anyone is actually available leave this route.
 */
app.get('/api/spots/:id/guide-requirement', async (req, res) => {
    try {
        const spot = await Spot.findById(req.params.id).select('title requiresGuide status');
        if (!spot) return res.status(404).json({ success: false, message: 'Spot not found.' });

        if (!spot.requiresGuide) {
            return res.status(200).json({ success: true, requiresGuide: false });
        }

        const guides = await TouristGuide.find({ assignedSpots: spot._id, status: 'available' })
            .select('guideFee maxGroupSize');

        const fees = guides.map(g => g.guideFee).sort((a, b) => a - b);
        return res.status(200).json({
            success: true,
            requiresGuide: true,
            guidesAvailable: guides.length,
            // A range rather than one number, because two guides at one spot may
            // legitimately charge differently and quoting one of them would be wrong.
            feeFrom: fees.length ? fees[0] : null,
            feeTo: fees.length ? fees[fees.length - 1] : null,
            maxGroupSize: guides.length ? Math.max(...guides.map(g => g.maxGroupSize)) : null,
            payment: 'Onsite at the Municipal Tourism Office'
        });
    } catch (error) {
        console.error('❌ Guide requirement failure:', error);
        return res.status(500).json({ success: false, message: 'Could not read the guide requirement.' });
    }
});

/* ==========================================
   4c. GUIDE BOOKINGS AND ONSITE PAYMENT
   ------------------------------------------
   A visitor submits a request without any account, gets a reference, and takes
   it to the Municipal Tourism Office. The officer takes payment at the counter,
   records it, assigns a guide, and the booking becomes confirmed.

   ZTIMS takes no money. There is no payment gateway here and no field pretending
   otherwise — a Payment row is the record of cash that changed hands at a desk.
========================================== */

// Public submission is the one write anyone on the internet can make, so it is
// held tighter than the browsing routes.
const bookingRateLimit = sharedRateLimit('booking', {
    windowMs: 60 * 60 * 1000,
    limit: 10,
    message: { success: false, message: 'Too many booking requests from this connection. Please try again later, or call the Municipal Tourism Office.' }
});

/**
 * Builds the next reference for this year: TG-2026-00001, TG-2026-00002, …
 *
 * Reads the highest existing one rather than counting rows, so a cancelled or
 * deleted booking cannot cause a number to be handed out twice. The unique index
 * on the field is the real guarantee; the caller retries if two submissions race.
 */
async function nextBookingReference() {
    const prefix = `TG-${new Date().getFullYear()}-`;
    const latest = await GuideBooking
        .findOne({ reference: new RegExp('^' + prefix) })
        .sort({ reference: -1 })
        .select('reference')
        .lean();

    const previous = latest ? Number(String(latest.reference).slice(prefix.length)) : 0;
    return prefix + String((Number.isFinite(previous) ? previous : 0) + 1).padStart(5, '0');
}

// What a visitor may see by quoting a reference. Deliberately no name, phone or
// email: references run in sequence, so anyone could try the next one along.
// Enough to confirm the booking is real and know what to do next, nothing more.
function publicBookingView(booking, spotTitle) {
    return {
        reference: booking.reference,
        spot: spotTitle || '',
        preferredDate: booking.preferredDate,
        preferredTime: booking.preferredTime,
        visitors: booking.visitors,
        status: booking.status,
        payment: 'Onsite at the Municipal Tourism Office'
    };
}

/**
 * POST: a visitor asks for a guide. No account, no login, no payment.
 */
app.post('/api/guide-bookings', bookingRateLimit, async (req, res) => {
    try {
        const body = req.body || {};
        const fullName = String(body.fullName || '').trim();
        const contactNumber = String(body.contactNumber || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const nationality = String(body.nationality || '').trim().toUpperCase();
        const preferredDate = String(body.preferredDate || '').trim();
        const preferredTime = String(body.preferredTime || '').trim();
        const visitors = Math.floor(Number(body.visitors));

        if (!fullName) return res.status(400).json({ success: false, message: 'Please give the name the booking is under.' });
        if (!contactNumber) {
            return res.status(400).json({ success: false, message: 'A contact number is required so the office can reach you.' });
        }
        // The form sends the country code with the number. Checked here as well,
        // because a form is a convenience and this route is open to anyone.
        if (!/^\+\d{1,4}[\s-]?\d[\d\s-]{5,}$/.test(contactNumber)) {
            return res.status(400).json({
                success: false,
                message: 'Give the contact number with its country code, for example +63 917 123 4567.'
            });
        }
        if (!email) {
            return res.status(400).json({ success: false, message: 'An email address is required so the office can confirm your booking.' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, message: 'That email address does not look right.' });
        }
        // Required here rather than on the schema — see the field's own note.
        if (!nationality) {
            return res.status(400).json({ success: false, message: 'Please choose the visitor\'s nationality.' });
        }
        // The form offers a fixed list, but this route is open to anyone, so the
        // list is the authority rather than the dropdown.
        if (!COUNTRY_CODES.has(nationality)) {
            return res.status(400).json({ success: false, message: 'That is not a country ZTIMS recognises.' });
        }
        if (!Number.isFinite(visitors) || visitors < 1) {
            return res.status(400).json({ success: false, message: 'How many visitors are coming?' });
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(preferredDate)) {
            return res.status(400).json({ success: false, message: 'Please choose a date.' });
        }
        if (!/^\d{2}:\d{2}$/.test(preferredTime)) {
            return res.status(400).json({ success: false, message: 'Please choose a time.' });
        }
        // Compared as text against today in the same format, which avoids a
        // timezone turning "today" into yesterday for a visitor booking from abroad.
        if (preferredDate < new Date().toISOString().slice(0, 10)) {
            return res.status(400).json({ success: false, message: 'That date has already passed.' });
        }

        const spot = await Spot.findById(body.spotId).populate('managedBy', 'active operationalStatus');
        if (!spot) return res.status(404).json({ success: false, message: 'That destination could not be found.' });
        if (!spot.requiresGuide) {
            return res.status(400).json({ success: false, message: 'This destination does not require a tourist guide, so there is nothing to book.' });
        }
        if (!isPubliclyVisible(spot)) {
            return res.status(404).json({ success: false, message: 'This destination is not open for visits right now.' });
        }

        // A group larger than any available guide can take would be accepted and
        // then refused at the counter, so it is refused here instead.
        const guides = await TouristGuide.find({ assignedSpots: spot._id, status: 'available' }).select('maxGroupSize');
        if (guides.length === 0) {
            return res.status(409).json({
                success: false,
                message: 'No guide is available for this destination at the moment. Please contact the Municipal Tourism Office.'
            });
        }
        const largestGroup = Math.max(...guides.map(g => g.maxGroupSize || 1));
        if (visitors > largestGroup) {
            return res.status(400).json({
                success: false,
                message: `The largest group a guide here can take is ${largestGroup}. Please contact the Municipal Tourism Office to arrange a bigger party.`
            });
        }

        // Two submissions can land on the same number; the unique index catches it
        // and the next attempt reads a higher one.
        let booking = null;
        for (let attempt = 0; attempt < 5 && !booking; attempt++) {
            try {
                booking = await GuideBooking.create({
                    reference: await nextBookingReference(),
                    spotId: spot._id,
                    fullName, contactNumber, email, nationality, visitors, preferredDate, preferredTime,
                    notes: String(body.notes || '').trim().slice(0, 1000)
                });
            } catch (error) {
                if (error && error.code === 11000) continue;
                throw error;
            }
        }
        if (!booking) {
            return res.status(503).json({ success: false, message: 'The system is busy. Please try again in a moment.' });
        }

        console.log(`🎟️ Guide booking ${booking.reference} for ${spot.title}`);
        return res.status(201).json({
            success: true,
            message: 'Booking submitted.',
            booking: publicBookingView(booking, spot.title),
            instruction: 'Please proceed to the Municipal Tourism Office to complete payment and confirmation.'
        });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Guide booking failure:');
    }
});

/**
 * PUBLIC: check a booking by its reference. Non-personal fields only — see
 * publicBookingView above for why.
 */
app.get('/api/guide-bookings/reference/:reference', async (req, res) => {
    try {
        const reference = String(req.params.reference || '').trim().toUpperCase();
        const booking = await GuideBooking.findOne({ reference }).populate('spotId', 'title');
        if (!booking) return res.status(404).json({ success: false, message: 'No booking found with that reference.' });

        return res.status(200).json({
            success: true,
            booking: publicBookingView(booking, booking.spotId ? booking.spotId.title : '')
        });
    } catch (error) {
        console.error('❌ Booking lookup failure:', error);
        return res.status(500).json({ success: false, message: 'Could not look that up right now.' });
    }
});

/* ---- everything below is the Tourism Office's ---------------------------- */

app.get('/api/guide-bookings', requireAdmin, async (req, res) => {
    try {
        const query = {};
        if (BOOKING_STATUSES.includes(req.query.status)) query.status = req.query.status;

        const bookings = await GuideBooking.find(query)
            .populate('spotId', 'title location')
            .populate('guideId', 'fullName contactNumber guideFee maxGroupSize status')
            .sort({ createdAt: -1 })
            .limit(500);

        // The payment belongs to a separate record, so it is fetched alongside
        // rather than duplicated onto the booking.
        const payments = await Payment.find({ bookingId: { $in: bookings.map(b => b._id) } });
        const byBooking = new Map(payments.map(p => [String(p.bookingId), p]));

        return res.status(200).json(bookings.map(booking => ({
            ...booking.toObject(),
            payment: byBooking.get(String(booking._id)) || null
        })));
    } catch (error) {
        console.error('❌ Booking list failure:', error);
        return res.status(500).json([]);
    }
});

/**
 * PATCH: assign or change the guide on a booking.
 *
 * The overlap rule is deliberately narrow: it refuses a guide who already has a
 * confirmed booking at the same date and time. ZTIMS does not record how long a
 * tour runs, so anything wider would mean inventing a duration and refusing
 * bookings on a guess. Other bookings that guide has that day are returned as
 * information, for the officer to judge.
 */
app.patch('/api/guide-bookings/:id/assign', requireAdmin, async (req, res) => {
    try {
        const booking = await GuideBooking.findById(req.params.id);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });

        if (req.body.guideId === null || req.body.guideId === '') {
            booking.guideId = null;
            await booking.save();
            return res.status(200).json({ success: true, message: 'Guide unassigned.', booking });
        }

        const guide = await TouristGuide.findById(req.body.guideId);
        if (!guide) return res.status(404).json({ success: false, message: 'That guide record no longer exists.' });
        if (guide.status !== 'available') {
            return res.status(409).json({ success: false, message: `${guide.fullName} is marked ${guide.status} and cannot take new bookings.` });
        }
        if (!guide.assignedSpots.some(id => String(id) === String(booking.spotId))) {
            return res.status(409).json({ success: false, message: `${guide.fullName} is not assigned to this destination.` });
        }
        if (booking.visitors > guide.maxGroupSize) {
            return res.status(409).json({
                success: false,
                message: `This booking is for ${booking.visitors} visitors and ${guide.fullName} takes at most ${guide.maxGroupSize}.`
            });
        }

        const clash = await GuideBooking.findOne({
            _id: { $ne: booking._id },
            guideId: guide._id,
            status: 'confirmed',
            preferredDate: booking.preferredDate,
            preferredTime: booking.preferredTime
        }).select('reference');
        if (clash) {
            return res.status(409).json({
                success: false,
                message: `${guide.fullName} already has confirmed booking ${clash.reference} at that date and time.`
            });
        }

        booking.guideId = guide._id;
        await booking.save();

        const sameDay = await GuideBooking.find({
            _id: { $ne: booking._id },
            guideId: guide._id,
            status: 'confirmed',
            preferredDate: booking.preferredDate
        }).select('reference preferredTime');

        console.log(`🧭 ${guide.fullName} assigned to ${booking.reference}`);
        return res.status(200).json({
            success: true,
            message: `${guide.fullName} assigned to ${booking.reference}.`,
            booking,
            alsoThatDay: sameDay.map(b => ({ reference: b.reference, time: b.preferredTime }))
        });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Guide assignment failure:');
    }
});

/**
 * POST: record money taken at the counter, which confirms the booking.
 *
 * Only the Tourism Office can do this. A visitor cannot mark their own booking
 * paid — that is the whole point of the reference and the counter.
 */
app.post('/api/guide-bookings/:id/payment', requireAdmin, async (req, res) => {
    try {
        const booking = await GuideBooking.findById(req.params.id).populate('guideId', 'fullName');
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (booking.status === 'cancelled') {
            return res.status(409).json({ success: false, message: 'That booking was cancelled. Reinstate it before recording payment.' });
        }

        const existing = await Payment.findOne({ bookingId: booking._id });
        if (existing) {
            return res.status(409).json({ success: false, message: `Payment for ${booking.reference} was already recorded.` });
        }

        const amount = Number(req.body.amount);
        if (!Number.isFinite(amount) || amount < 0) {
            return res.status(400).json({ success: false, message: 'Enter the amount collected.' });
        }

        // Read from the account rather than the token: sessions carry only an id
        // and a role, and a receipt that cannot say who took the money is not a
        // record of anything.
        const officer = await Admin.findById(req.auth.sub).select('email');

        const payment = await Payment.create({
            bookingId: booking._id,
            amount,
            method: String(req.body.method || 'cash').trim() || 'cash',
            receiptNumber: String(req.body.receiptNumber || '').trim(),
            paidAt: req.body.paidAt ? new Date(req.body.paidAt) : new Date(),
            recordedBy: req.auth.sub,
            recordedByEmail: officer ? officer.email : '',
            remarks: String(req.body.remarks || '').trim().slice(0, 500)
        });

        booking.status = 'confirmed';
        booking.statusUpdatedAt = new Date();
        await booking.save();

        console.log(`💵 Payment recorded for ${booking.reference} by ${payment.recordedByEmail || req.auth.sub}`);
        return res.status(201).json({
            success: true,
            message: `Payment recorded. ${booking.reference} is confirmed.`,
            booking,
            payment
        });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Payment recording failure:');
    }
});

/**
 * PATCH: move a booking through the rest of its life — cancelled, completed,
 * or no show. Nothing here deletes a booking.
 */
app.patch('/api/guide-bookings/:id/status', requireAdmin, async (req, res) => {
    try {
        const status = String(req.body.status || '').trim();
        if (!BOOKING_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, message: 'That is not a booking status ZTIMS uses.' });
        }

        const booking = await GuideBooking.findById(req.params.id);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });

        // Confirmed means paid, and payment is a separate record that this route
        // does not create. Recording the payment is what confirms a booking.
        if (status === 'confirmed') {
            const paid = await Payment.findOne({ bookingId: booking._id });
            if (!paid) {
                return res.status(409).json({
                    success: false,
                    message: 'Record the onsite payment to confirm this booking.'
                });
            }
        }

        booking.status = status;
        booking.statusNote = String(req.body.statusNote || '').trim().slice(0, 500);
        booking.statusUpdatedAt = new Date();
        await booking.save();

        return res.status(200).json({ success: true, message: `${booking.reference} is now ${status.replace('_', ' ')}.`, booking });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Booking status failure:');
    }
});

/* ==========================================
   4d. VISITOR FEEDBACK
   ------------------------------------------
   The Contact Us page. A visitor types what is wrong or what they would like,
   and it lands in the Tourism Office's inbox in the portal. There is no email
   relay in between: the office reads it where it manages everything else, and
   a message cannot go astray because a mailbox was full or a password expired.
========================================== */

// The second write anyone on the internet can make (bookings are the first),
// so it is held exactly as tightly: ten an hour is plenty for a person, and a
// resort or the office itself behind one shared connection, and nothing for a
// script.
const feedbackRateLimit = sharedRateLimit('feedback', {
    windowMs: 60 * 60 * 1000,
    limit: 10,
    message: { success: false, message: 'That is a lot of messages from one connection. Please wait a while and try again, or visit the Municipal Tourism Office.' }
});

/**
 * POST: a visitor sends feedback. No account, no login.
 */
app.post('/api/feedback', feedbackRateLimit, async (req, res) => {
    try {
        const body = req.body || {};

        // The form carries a field no person can see. A submission that fills
        // it came from a bot, and is answered exactly as a real one would be so
        // the bot learns nothing — it is just never saved.
        if (String(body.website || '').trim()) {
            return res.status(201).json({ success: true, message: 'Thank you. Your feedback has been received.' });
        }

        const topic = String(body.topic || '').trim().toLowerCase();
        const message = String(body.message || '').trim();
        const name = String(body.name || '').trim().slice(0, 120);
        const email = String(body.email || '').trim().toLowerCase();
        const page = String(body.page || '').trim().slice(0, 500);

        if (message.length < 10) {
            return res.status(400).json({ success: false, message: 'Please write a little more, so the office knows what to look at.' });
        }
        if (message.length > FEEDBACK_MESSAGE_MAX) {
            return res.status(400).json({ success: false, message: `Please keep the message under ${FEEDBACK_MESSAGE_MAX} characters.` });
        }
        // Optional, but if given it has to be usable: an officer who replies to
        // a half-typed address is replying to nobody.
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, message: 'That email address does not look complete. Leave it blank if you do not want a reply.' });
        }

        const feedback = await Feedback.create({
            topic: FEEDBACK_TOPICS.includes(topic) ? topic : 'other',
            message,
            name,
            email,
            page
        });

        return res.status(201).json({
            success: true,
            message: 'Thank you. Your feedback has been received.',
            id: feedback._id
        });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Feedback submission failure:');
    }
});

/* ---- everything below is the Tourism Office's ---------------------------- */

app.get('/api/feedback', requireAdmin, async (req, res) => {
    try {
        const query = {};
        if (FEEDBACK_STATUSES.includes(req.query.status)) query.status = req.query.status;
        if (FEEDBACK_TOPICS.includes(req.query.topic)) query.topic = req.query.topic;

        const items = await Feedback.find(query).sort({ createdAt: -1 }).limit(500).lean();
        return res.status(200).json(items);
    } catch (error) {
        console.error('❌ Feedback list failure:', error);
        return res.status(500).json([]);
    }
});

/**
 * PATCH: the officer marks a message read or resolved, or reopens it.
 * Nothing is deleted — a resolved message is the record of what was fixed.
 */
app.patch('/api/feedback/:id/status', requireAdmin, async (req, res) => {
    try {
        const status = String((req.body || {}).status || '').trim();
        if (!FEEDBACK_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, message: `Status must be one of: ${FEEDBACK_STATUSES.join(', ')}.` });
        }

        const feedback = await Feedback.findById(req.params.id);
        if (!feedback) return res.status(404).json({ success: false, message: 'Feedback not found.' });

        const officer = await Admin.findById(req.auth.sub).select('email');
        feedback.status = status;
        feedback.statusUpdatedAt = new Date();
        feedback.statusUpdatedByEmail = officer ? officer.email : '';
        await feedback.save();

        return res.status(200).json({ success: true, message: `Marked ${status}.`, feedback });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Feedback status failure:');
    }
});

/* ==========================================
   4b. TRAVEL DIRECTIONS
   ------------------------------------------
   The establishment says where it is. The visitor's device — or a starting point
   they type themselves — says where they are. A routing service works out the road
   between the two. ZTIMS stores none of the journey: no travel times are kept, and
   the visitor's coordinates exist only for the length of one request.

   These go through the API rather than straight from the browser for one reason:
   the routing key belongs in the server's environment, not in page source anyone
   can read.
========================================== */

const ORS_API_KEY = (process.env.ORS_API_KEY || '').trim();

/* Valhalla, which is where the motorbike option comes from.
 *
 * Habal-habal is how most people actually reach these places, and it is not a
 * car: it takes tracks and narrow barangay roads a car cannot, and its time
 * over the same distance is genuinely different. OpenRouteService has no
 * motorcycle profile at all, so for as long as ORS was the only router there
 * was no honest way to offer the mode — a car's estimate under another name is
 * worse than no estimate.
 *
 * Valhalla has a real `motorcycle` costing model, which is why it is here
 * alongside ORS rather than replacing it. The default points at the FOSSGIS
 * community server, so this works with nothing to configure; it is a shared
 * volunteer-run service under a fair-use policy, so set VALHALLA_URL to your
 * own instance if this ever carries real traffic. Setting it to an empty
 * string turns the motorbike option off, and the browser stops offering it —
 * capabilities below is what the page renders.
 */
const VALHALLA_URL = (
    process.env.VALHALLA_URL !== undefined
        ? process.env.VALHALLA_URL
        : 'https://valhalla1.openstreetmap.de'
).trim().replace(/\/+$/, '');

/* One table now, because the modes no longer share a single provider. Each mode
 * lists the profile name every router it can use knows it by, and the resolver
 * below picks one per mode. A mode no configured router can compute is never
 * offered — that rule has not changed, it just applies per mode instead of
 * per site. */
const MODES = {
    car:       { label: 'Car',       ors: 'driving-car',     osrm: 'driving', valhalla: 'auto' },
    motorbike: { label: 'Motorbike',                                          valhalla: 'motorcycle' },
    bicycle:   { label: 'Bicycle',   ors: 'cycling-regular',                  valhalla: 'bicycle' },
    walking:   { label: 'Walking',   ors: 'foot-walking',                     valhalla: 'pedestrian' }
};

/* Preference order, most accurate first. ORS is preferred where it has a
 * profile because it is keyed and metered to this deployment rather than
 * shared; OSRM's public demo runs the car profile only; Valhalla picks up what
 * is left, which today means motorbike. */
function resolveMode(mode) {
    if (ORS_API_KEY && mode.ors) return { router: 'openrouteservice', profile: mode.ors };
    if (!ORS_API_KEY && mode.osrm) return { router: 'osrm', profile: mode.osrm };
    if (VALHALLA_URL && mode.valhalla) return { router: 'valhalla', profile: mode.valhalla };
    return null;
}

const ROUTING_MODES = Object.fromEntries(
    Object.entries(MODES)
        .map(([id, mode]) => {
            const resolved = resolveMode(mode);
            return resolved ? [id, { label: mode.label, ...resolved }] : null;
        })
        .filter(Boolean)
);

// Kept for the startup banner and the route response, which both named a single
// provider before any of this. It is the one serving the ordinary car route.
const ROUTING_PROVIDER = ROUTING_MODES.car ? ROUTING_MODES.car.router : 'none';

// Identifies ZTIMS to OpenStreetMap's geocoder, which its usage policy requires.
const GEOCODER_USER_AGENT = `ZTIMS/1.0 (${process.env.PUBLIC_SITE_URL || 'https://ztims.vercel.app'})`;

/* Every place ZTIMS lists is in one municipality, so a search that ranks the rest
   of the Philippines equally is answering a question nobody asked. Both geocoders
   below are pointed here first.

   This mirrors ZAMBOANGUITA_CENTER and ZAMBOANGUITA_BOUNDS in
   Zamboanguita-project/src/shared/spot-form.js. The two deploy separately — Render
   and Vercel — so they cannot share a file; if one moves, move the other. */
const ZAMBOANGUITA_CENTER = { latitude: 9.1005, longitude: 123.1994 };
const ZAMBOANGUITA_SEARCH_BOX = { minLat: 9.02, maxLat: 9.19, minLng: 123.09, maxLng: 123.27 };

const ROUTING_TIMEOUT_MS = 12000;

// Routing providers meter their free tiers, and each visitor action is one call.
// Generous enough to switch modes freely, tight enough that a loop cannot burn the
// day's quota. Keyed per IP by the trust-proxy setting configured at the top.
const directionsRateLimit = sharedRateLimit('directions', {
    windowMs: 60 * 1000,
    limit: 40,
    message: { success: false, message: 'Too many directions requests. Please wait a moment and try again.' }
});

async function fetchJson(url, options) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(ROUTING_TIMEOUT_MS) });
    const body = await response.text();

    let parsed = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }

    if (!response.ok) {
        const detail = parsed?.error?.message || parsed?.error || parsed?.message || `HTTP ${response.status}`;
        const error = new Error(typeof detail === 'string' ? detail : `HTTP ${response.status}`);
        error.upstreamStatus = response.status;
        throw error;
    }
    return parsed;
}

/**
 * Both providers answer in GeoJSON order — [longitude, latitude] — while Leaflet
 * draws in [latitude, longitude]. Flipping it here means the browser never has to
 * remember which way round a given service speaks.
 */
const toLeafletLine = coordinates => (coordinates || []).map(([lng, lat]) => [lat, lng]);

/**
 * Valhalla returns its geometry as an encoded polyline rather than GeoJSON, and
 * at six decimal places rather than the five the Google-derived format uses
 * everywhere else. Decoding at the wrong precision does not fail — it silently
 * produces a line about a tenth of a degree long, so it is stated explicitly at
 * the call site rather than defaulted.
 *
 * Yields [latitude, longitude], which is Leaflet's order already.
 */
function decodePolyline(encoded, precision) {
    const factor = Math.pow(10, precision);
    const points = [];
    let index = 0, lat = 0, lng = 0;

    while (index < encoded.length) {
        let result = 0, shift = 0, byte;
        do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
        lat += (result & 1) ? ~(result >> 1) : (result >> 1);

        result = 0; shift = 0;
        do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
        lng += (result & 1) ? ~(result >> 1) : (result >> 1);

        points.push([lat / factor, lng / factor]);
    }
    return points;
}

async function routeWithValhalla(from, to, mode) {
    const { profile } = ROUTING_MODES[mode];

    let data;
    try {
        data = await fetchJson(`${VALHALLA_URL}/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': GEOCODER_USER_AGENT },
            body: JSON.stringify({
                locations: [
                    { lat: from.latitude, lon: from.longitude },
                    { lat: to.latitude, lon: to.longitude }
                ],
                costing: profile,
                units: 'kilometers',
                // Two more to compare against, same as the other routers.
                alternates: 2,
                // Enough of the narrative to name the road a route mostly follows;
                // the written instructions themselves are never used.
                directions_type: 'maneuvers'
            })
        });
    } catch (error) {
        // Valhalla says "these points are not connected by this kind of road"
        // with a 4xx and an error code, not an empty result. That is the same
        // answer OpenRouteService gives by returning nothing, and the caller
        // already turns it into an honest "no route found" rather than
        // "the service is down".
        if (error.upstreamStatus >= 400 && error.upstreamStatus < 500) return [];
        throw error;
    }

    /* Valhalla puts the best route in `trip` and the rest in `alternates`, each
       wrapped in its own `trip`. Flattened here so the handler compares them all
       on equal terms rather than trusting the ordering. */
    const trips = [data?.trip, ...(data?.alternates || []).map(a => a?.trip)];

    return trips
        .filter(trip => Number.isFinite(trip?.summary?.length))
        .map(trip => ({
            // Requested in kilometres above; everything else in ZTIMS is metres.
            distanceMeters: trip.summary.length * 1000,
            durationSeconds: trip.summary.time,
            geometry: (trip.legs || []).flatMap(leg => (leg.shape ? decodePolyline(leg.shape, 6) : [])),
            via: viaRoadName(
                (trip.legs || []).flatMap(leg => (leg.maneuvers || []).map(m => ({
                    // Valhalla lists every name a road carries; the first is the
                    // one people use. Its lengths are in the requested units.
                    name: (m.street_names || [])[0],
                    distance: Number.isFinite(m.length) ? m.length * 1000 : NaN
                })))
            )
        }));
}

/* Every router below returns an ARRAY of candidate routes, and the handler picks
   the quickest. Each one used to take `routes[0]` and never ask for a second, so
   whatever the provider happened to list first was presented as the route — which
   for a coastal municipality with an inland road and a shore road is a real
   difference, not a rounding one. Asking for alternatives and comparing them is
   the only way "the fastest route" can mean anything.

   The comparison is on the provider's own numbers. Nothing here estimates. */

/**
 * The name to put on a route so it can be told apart from its alternative.
 * Picks the road the route spends most of its distance on, which is how anybody
 * would describe it out loud. Returns '' when the provider gives no names,
 * and the page then says nothing rather than inventing a description.
 */
function viaRoadName(legs) {
    const metresPerRoad = new Map();
    for (const { name, distance } of legs) {
        const road = String(name || '').trim();
        if (!road || !Number.isFinite(distance)) continue;
        metresPerRoad.set(road, (metresPerRoad.get(road) || 0) + distance);
    }
    let best = '', most = 0;
    for (const [road, metres] of metresPerRoad) {
        if (metres > most) { best = road; most = metres; }
    }
    return best;
}

async function routeWithOpenRouteService(from, to, mode) {
    const { profile } = ROUTING_MODES[mode];
    const coordinates = [[from.longitude, from.latitude], [to.longitude, to.latitude]];
    const url = `https://api.openrouteservice.org/v2/directions/${profile}/geojson`;
    const headers = { Authorization: ORS_API_KEY, 'Content-Type': 'application/json' };

    const ask = body => fetchJson(url, { method: 'POST', headers, body: JSON.stringify(body) });

    let data;
    try {
        data = await ask({
            coordinates,
            // Up to three, and only genuinely different ones: share_factor caps how
            // much road two alternatives may have in common, weight_factor how much
            // worse than the best an alternative may be before it is not worth
            // offering. Both are OpenRouteService's own defaults' territory.
            alternative_routes: { target_count: 3, share_factor: 0.6, weight_factor: 1.4 }
        });
    } catch (error) {
        // Not every profile accepts alternatives, and a refusal must not cost the
        // visitor their directions. One plain retry, then it is a real failure.
        if (error.upstreamStatus >= 400 && error.upstreamStatus < 500) {
            try { data = await ask({ coordinates }); }
            catch (retry) {
                if (retry.upstreamStatus >= 400 && retry.upstreamStatus < 500) return [];
                throw retry;
            }
        } else throw error;
    }

    // An empty summary is how OpenRouteService reports "these two points are not
    // connected by this kind of road" — an islet, or walking across a strait.
    return (data?.features || [])
        .filter(f => Number.isFinite(f?.properties?.summary?.distance))
        .map(f => ({
            distanceMeters: f.properties.summary.distance,
            durationSeconds: f.properties.summary.duration,
            geometry: toLeafletLine(f.geometry?.coordinates),
            via: viaRoadName(
                (f.properties.segments || []).flatMap(s => s.steps || [])
            )
        }));
}

async function routeWithOsrm(from, to, mode) {
    const { profile } = ROUTING_MODES[mode];
    const path = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    const data = await fetchJson(
        `https://router.project-osrm.org/route/v1/${profile}/${path}`
            + `?overview=full&geometries=geojson&alternatives=true&steps=true`,
        { headers: { 'User-Agent': GEOCODER_USER_AGENT } }
    );

    if (data?.code !== 'Ok') return [];

    return (data.routes || [])
        .filter(r => Number.isFinite(r.distance))
        .map(r => ({
            distanceMeters: r.distance,
            durationSeconds: r.duration,
            geometry: toLeafletLine(r.geometry?.coordinates),
            via: viaRoadName(
                (r.legs || []).flatMap(l => l.steps || [])
            )
        }));
}

/**
 * Tells the browser which provider is configured and, therefore, exactly which
 * transport modes it may offer. The page renders this list rather than a fixed one,
 * so a mode is never shown that nothing can actually calculate.
 */
app.get('/api/directions/capabilities', (req, res) => {
    return res.status(200).json({
        success: true,
        provider: ROUTING_PROVIDER,
        // The router is named per mode as well, because they can differ now.
        modes: Object.entries(ROUTING_MODES).map(([id, mode]) => ({
            id, label: mode.label, provider: mode.router
        }))
    });
});

app.get('/api/directions/route', directionsRateLimit, async (req, res) => {
    // Deliberately never logged and never written anywhere: the origin is the
    // visitor's own position, and it has no business outliving this request.
    const from = parseCoordinate(req.query.fromLat, req.query.fromLng);
    const to = parseCoordinate(req.query.toLat, req.query.toLng);

    if (!from) return res.status(400).json({ success: false, message: 'A valid starting point is required.' });
    if (!to) return res.status(400).json({ success: false, message: 'This destination has no location on file yet.' });

    const mode = String(req.query.mode || 'car');
    if (!ROUTING_MODES[mode]) {
        return res.status(400).json({ success: false, message: 'That way of travelling is not available here.' });
    }

    // Per mode, not per site: motorbike is served by a different router from the
    // one answering for car, and both can be configured at once.
    const router = ROUTING_MODES[mode].router;

    try {
        const routes = router === 'openrouteservice' ? await routeWithOpenRouteService(from, to, mode)
            : router === 'valhalla' ? await routeWithValhalla(from, to, mode)
            : await routeWithOsrm(from, to, mode);

        if (!routes || !routes.length) {
            return res.status(404).json({
                success: false,
                message: 'No road route could be found between those two points for that way of travelling.'
            });
        }

        /* Quickest wins, on the provider's own estimate — not the shortest, and
           not whichever the provider listed first. A route that is a kilometre
           longer along the highway beats one that is shorter through the
           barangay roads, which is the choice anybody driving would make.
           Distance breaks a tie so the answer cannot wobble between two routes
           the provider timed identically. */
        const route = routes.reduce((best, candidate) => {
            if (candidate.durationSeconds < best.durationSeconds) return candidate;
            if (candidate.durationSeconds > best.durationSeconds) return best;
            return candidate.distanceMeters < best.distanceMeters ? candidate : best;
        });

        const slowest = Math.max(...routes.map(r => r.durationSeconds));

        return res.status(200).json({
            success: true,
            mode,
            provider: router,
            distanceMeters: Math.round(route.distanceMeters),
            durationSeconds: Math.round(route.durationSeconds),
            geometry: route.geometry,
            // What the page needs to say which route this is and why it was
            // chosen, rather than presenting a number with no provenance.
            via: route.via || '',
            routesCompared: routes.length,
            // 0 when it was the only route, so the page can tell the difference
            // between "the fastest of three" and "the only one there is".
            secondsSavedOverSlowest: Math.round(slowest - route.durationSeconds)
        });
    } catch (error) {
        console.error('Routing request failed:', error.message);
        // Never fall back to a straight line dressed up as a travel time — an
        // honest "unavailable" beats a number the visitor would trust.
        return res.status(502).json({
            success: false,
            message: 'The routing service could not be reached. Please try again in a moment.'
        });
    }
});

/**
 * Address search, used by the establishment's location picker and by a visitor who
 * types a starting point instead of sharing their device location.
 */
app.get('/api/directions/search', directionsRateLimit, async (req, res) => {
    const text = String(req.query.q || '').trim();
    if (text.length < 3) {
        return res.status(400).json({ success: false, message: 'Type at least three characters to search.' });
    }

    try {
        if (ORS_API_KEY) {
            // focus.point biases the ranking toward Zamboanguita without hiding
            // anything: "wharf" should find the local one first, but a manager
            // whose landmark genuinely sits on the municipal edge still sees it.
            // boundary.rect would have excluded that second case outright.
            const url = `https://api.openrouteservice.org/geocode/search?api_key=${encodeURIComponent(ORS_API_KEY)}`
                + `&text=${encodeURIComponent(text)}&boundary.country=PHL&size=6`
                + `&focus.point.lat=${ZAMBOANGUITA_CENTER.latitude}&focus.point.lon=${ZAMBOANGUITA_CENTER.longitude}`;
            const data = await fetchJson(url, {});
            return res.status(200).json({
                success: true,
                results: (data?.features || []).map(feature => ({
                    label: feature.properties?.label || feature.properties?.name || text,
                    latitude: feature.geometry?.coordinates?.[1],
                    longitude: feature.geometry?.coordinates?.[0]
                })).filter(one => parseCoordinate(one.latitude, one.longitude))
            });
        }

        // viewbox without bounded=1 prefers this rectangle rather than restricting
        // to it, which is the same bargain focus.point strikes above.
        const box = ZAMBOANGUITA_SEARCH_BOX;
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=ph&limit=6`
            + `&viewbox=${box.minLng},${box.minLat},${box.maxLng},${box.maxLat}`
            + `&q=${encodeURIComponent(text)}`;
        const data = await fetchJson(url, { headers: { 'User-Agent': GEOCODER_USER_AGENT } });
        return res.status(200).json({
            success: true,
            results: (data || []).map(place => ({
                label: place.display_name,
                latitude: Number(place.lat),
                longitude: Number(place.lon)
            })).filter(one => parseCoordinate(one.latitude, one.longitude))
        });
    } catch (error) {
        console.error('Address search failed:', error.message);
        return res.status(502).json({ success: false, message: 'Address search is unavailable right now.' });
    }
});

/**
 * The reverse of the above: a point dropped on the map becomes a readable address,
 * so whoever is registering the place does not have to type it twice.
 */
app.get('/api/directions/reverse', directionsRateLimit, async (req, res) => {
    const point = parseCoordinate(req.query.lat, req.query.lng);
    if (!point) return res.status(400).json({ success: false, message: 'A valid point is required.' });

    try {
        if (ORS_API_KEY) {
            const url = `https://api.openrouteservice.org/geocode/reverse?api_key=${encodeURIComponent(ORS_API_KEY)}`
                + `&point.lat=${point.latitude}&point.lon=${point.longitude}&size=1`;
            const data = await fetchJson(url, {});
            const properties = data?.features?.[0]?.properties || {};
            return res.status(200).json({
                success: true,
                label: properties.label || '',
                barangay: properties.neighbourhood || properties.locality || '',
                municipality: properties.localadmin || properties.locality || '',
                province: properties.region || ''
            });
        }

        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2`
            + `&lat=${point.latitude}&lon=${point.longitude}&zoom=16`;
        const data = await fetchJson(url, { headers: { 'User-Agent': GEOCODER_USER_AGENT } });
        const parts = data?.address || {};
        return res.status(200).json({
            success: true,
            label: data?.display_name || '',
            barangay: parts.village || parts.suburb || parts.neighbourhood || parts.hamlet || '',
            municipality: parts.town || parts.municipality || parts.city || '',
            province: parts.province || parts.state || ''
        });
    } catch (error) {
        console.error('Reverse lookup failed:', error.message);
        return res.status(502).json({ success: false, message: 'Could not read an address for that point.' });
    }
});

/* ==========================================
   5. ERROR HANDLER
========================================== */

/**
 * Without this, a rejected CORS origin falls through to Express's default handler,
 * which answers with an HTML 500 carrying no CORS headers — so the browser reports
 * a confusing "no Access-Control-Allow-Origin" error instead of the real reason,
 * and the frontend's response.json() throws on the HTML body.
 */
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    const isCorsRejection = err && typeof err.message === 'string' && err.message.includes('not allowed by CORS');
    if (isCorsRejection) {
        console.warn(`🚫 Blocked request from disallowed origin: ${req.get('origin')}`);
        return res.status(403).json({
            success: false,
            message: `This site's address is not on the API's allowed list. Add it to the CORS_ORIGIN environment variable.`,
            origin: req.get('origin') || null
        });
    }

    console.error('❌ Unhandled server error:', err);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
});

/* ==========================================
   6. DEPLOYMENT PORT INITIALIZER
========================================== */
const PORT = Number(process.env.PORT) || 5000;

/* What the banner says, wherever this is running.

   `port` is given when this process owns a port and is listening on it, and
   left out on a serverless host, where there is no port to print and claiming
   one would be a lie. Everything else — which routing service loaded, whether
   uploads are signed — is worth printing in both cases, because it is how you
   tell a missing environment variable from a broken one without guessing. */
function printStartupBanner(port) {
    console.log(`=================================================`);
    if (port) {
        console.log(` 🚀 Server actively streaming data loops at:`);
        console.log(`     👉 http://localhost:${port}`);
    } else {
        console.log(` 🚀 Serverless instance started (no port of its own).`);
    }
    // Says which routing service this process actually loaded. ROUTING_PROVIDER is
    // decided once at startup from the environment, so a key added to the host after
    // the process began shows nothing until it restarts — this line is how you tell
    // the two apart without guessing.
    console.log(cloudinarySigningReady
        ? ` 📷 Photo uploads: signed — only a signed-in officer or manager can upload.`
        : ` 📷 Photo uploads: UNSIGNED preset — anyone reading the page can upload to this account.\n` +
          `    Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET, then\n` +
          `    switch the preset to "signed" in the Cloudinary console.`);

    /* Printed from the resolved table rather than restated, because the modes on
       offer now depend on two services and the banner was already one edit
       behind the code once. */
    const modesByRouter = Object.values(ROUTING_MODES).reduce((acc, mode) => {
        (acc[mode.router] = acc[mode.router] || []).push(mode.label.toLowerCase());
        return acc;
    }, {});
    const describe = router => ({
        openrouteservice: `OpenRouteService (key ending ...${ORS_API_KEY.slice(-4)})`,
        osrm: 'OSRM demo server',
        valhalla: `Valhalla (${VALHALLA_URL})`
    })[router] || router;

    console.log(` 🧭 Travel directions: ` + (
        Object.entries(modesByRouter)
            .map(([router, labels]) => `${describe(router)} — ${labels.join(', ')}`)
            .join('; ') || 'no routing service configured'
    ));

    if (!VALHALLA_URL) {
        console.log(`    ↳ Motorbike is off: VALHALLA_URL is empty. Unset it to use the community server.`);
    }

    if (!ORS_API_KEY) {
        // Separates "never set on this service" from "set under a slightly wrong
        // name", which look identical from the outside and have different fixes.
        // Names only — a value is never printed.
        const nearby = Object.keys(process.env).filter(name => /ORS|OPENROUTE|ROUTING/i.test(name));
        console.log(nearby.length
            ? `    Similar variable names found here: ${nearby.join(', ')}. It must be spelled exactly ORS_API_KEY.`
            : `    No variable named anything like ORS_API_KEY exists on this service.`);
        console.log(`    ${Object.keys(process.env).length} environment variables are visible to this process.`);
    }
    console.log(`=================================================`);
}

/* Two ways in, and which one is in use decides whether this process listens.

   Run directly — `npm start`, `npm run dev`, or the Dockerfile's `node
   server.js` — and it binds a port and serves, exactly as before.

   Required as a module — which is what a serverless host does, handing each
   request to the exported app — and it must NOT listen. There is no port to
   take, and binding one would either fail or hold the instance open. */
if (require.main === module) {
    app.listen(PORT, () => printStartupBanner(PORT));
} else {
    printStartupBanner();
}

module.exports = app;

// Hung off the app so `npm run migrate` can reach them without a second copy of
// the connection logic. An Express app is a function, so it carries properties.
module.exports.runMigrations = runMigrations;
module.exports.connectToDatabase = connectToDatabase;
