const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer'); // Added for handling Forgot Password emails
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config();

// Verifies Google ID tokens against Google's own public keys.
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 150, standardHeaders: true, legacyHeaders: false }));

// FORCE explicit body-parser rules across ALL incoming payload formats
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: false, parameterLimit: 1000 }));

/* ==========================================
   2. DATABASE CONFIGURATION & CONNECT
========================================== */
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/zamboanguita';

mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('✅ Connected safely to MongoDB database system.');
        return migrateEstablishmentNames().then(migrateSpotManagement);
    })
    .catch(err => console.error('❌ MongoDB Connection Error Encountered:', err));

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

// 3. User/Traveler Authentication Schema (🌟 UPGRADED TO ACCEPT AUTOFILL PROPERTIES)
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Google accounts have no password of their own, so this is only required for
    // accounts that actually sign in with one.
    password: {
        type: String,
        required: function () { return this.provider !== 'google'; },
        select: false
    },
    provider: { type: String, enum: ['local', 'google'], default: 'local' },
    // sparse: only documents that actually have a googleId take part in the unique
    // index, so the many password-only users don't collide on null.
    googleId: { type: String, default: null, unique: true, sparse: true },
    avatar: { type: String, default: "" },
    fullName: { type: String, default: "" },
    phone: { type: String, default: "" },
    nationality: { type: String, default: "" },
    // Password reset. Only the SHA-256 hash of the token is kept, so a leaked
    // database still cannot be used to reset anybody's password — the plain
    // token exists solely inside the email that was sent. select: false keeps
    // both fields out of every ordinary read.
    resetTokenHash: { type: String, default: null, select: false },
    resetTokenExpires: { type: Date, default: null, select: false }
}, { collection: 'users', timestamps: true });

const User = mongoose.model('User', UserSchema);

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

// 4. 🌟 UPDATED: Review Schema perfectly paired with frontend assets & text fields
const ReviewSchema = new mongoose.Schema({
    guestName: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    destinationId: { type: String, required: true }, // Holds selected location text
    // Reviews were originally matched to a spot by its name alone, which breaks as
    // soon as a spot is renamed. New reviews carry the real reference; the older
    // name-only ones still resolve through destinationId.
    spotId: { type: mongoose.Schema.Types.ObjectId, ref: 'Spot', default: null },
    comment: { type: String, required: true },
    imageURL: { type: String, required: false }, // Stores uploaded Base64 image snapshot strings
    status: { type: String, default: 'approved' } // 🌟 Support status transitions for moderation
}, { timestamps: true });

const Review = mongoose.model('Review', ReviewSchema);

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
    managedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'EstablishmentManager', default: null, index: true }
}, { timestamps: true });

const Spot = mongoose.model('Spot', SpotSchema);

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

// Reviewing is a visitor's act. Without this, an establishment manager could post glowing
// reviews of their own listing, which is the one thing the ratings must not allow.
const requireTourist = [requireAuth, (req, res, next) => {
    if (req.auth.role !== 'user') {
        return res.status(403).json({ success: false, message: 'Only tourist accounts can do this.' });
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
const resetRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
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

/**
 * GET: every approved review across this manager's own listings, in one request.
 * Scoped to req.auth.sub like the rest of /me, so a manager can never read
 * another establishment's reviews. Approved only — what the manager sees is
 * exactly what visitors see.
 * Target URL: http://localhost:5000/api/establishment-managers/me/reviews
 */
app.get('/api/establishment-managers/me/reviews', requireEstablishmentManager, async (req, res) => {
    try {
        const spots = await Spot.find({ managedBy: req.auth.sub }).select('title type imageUrl');

        if (spots.length === 0) {
            return res.status(200).json({ success: true, listings: [], reviews: [], averageRating: null, total: 0 });
        }

        // Matched by reference and by name, because reviews written before reviews
        // carried a reference still only know the listing by its title.
        const reviews = await Review.find({
            status: 'approved',
            $or: [
                { spotId: { $in: spots.map(spot => spot._id) } },
                { destinationId: { $in: spots.map(spot => spot.title) } }
            ]
        }).sort({ createdAt: -1 });

        const byId = new Map(spots.map(spot => [String(spot._id), spot]));
        const byTitle = new Map(spots.map(spot => [spot.title, spot]));

        // Each review carries the listing it belongs to, so the page can group and
        // filter without matching titles again in the browser.
        const answered = reviews.map(review => {
            const spot = byId.get(String(review.spotId || '')) || byTitle.get(review.destinationId) || null;
            return {
                _id: review._id,
                guestName: review.guestName,
                rating: review.rating,
                comment: review.comment,
                imageURL: review.imageURL || '',
                createdAt: review.createdAt,
                spotId: spot ? spot._id : null,
                spotTitle: spot ? spot.title : review.destinationId
            };
        });

        const averageRating = answered.length
            ? Number((answered.reduce((sum, review) => sum + (review.rating || 0), 0) / answered.length).toFixed(1))
            : null;

        return res.status(200).json({
            success: true,
            listings: spots.map(spot => ({ _id: spot._id, title: spot.title, type: spot.type, imageUrl: spot.imageUrl })),
            reviews: answered,
            averageRating,
            total: answered.length
        });
    } catch (error) {
        console.error('❌ Manager reviews fetch failure:', error);
        return res.status(500).json({ success: false, message: 'Could not load your reviews just now.' });
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
 * POST: Register new traveler accounts into MongoDB (🌟 UPGRADED TO CAPTURE INPUT VALUES)
 * Target URL: http://localhost:5000/api/register
 */
app.post('/api/register', async (req, res) => {
    try {
        const { email, password, fullName, phone, nationality } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Missing mandatory email or password keys.' });
        }

        const normalizedEmail = email.toLowerCase().trim();

        // Prevent duplicate account registrations
        const existingUser = await User.findOne({ email: normalizedEmail });
        if (existingUser) {
            return res.status(409).json({ success: false, message: 'This email account is already registered.' });
        }

        // Create user with extended parameters map
        const passwordHash = await bcrypt.hash(password, 12);
        const newUser = new User({ 
            email: normalizedEmail, 
            password: passwordHash,
            fullName: fullName || "",
            phone: phone || "",
            nationality: nationality || ""
        });
        await newUser.save();

        console.log(`👤 New user saved directly to MongoDB collection with profile properties: ${normalizedEmail}`);
        return res.status(201).json({ success: true, message: 'Registration complete!' });
    } catch (error) {
        console.error("❌ Registration Endpoint Failure:", error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

/**
 * POST: Dynamic Authentication for both Admin and User Portals (🌟 UPGRADED TO RETURN USER PROFILE DETAILS)
 * Target URL: http://localhost:5000/api/login
 */
app.post('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
    try {
        const { email, password, role } = req.body; 
        console.log(`➡️ Login attempt received for: ${email} | Role Context: ${role || 'user'}`);

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Missing email or password.' });
        }

        const normalizedEmail = email.toLowerCase().trim();
        // 'staff' means the caller doesn't know which kind of staff account this is
        // — the shared staff sign-in page. We work it out rather than making the
        // person choose, since picking the wrong portal would reject a correct password.
        const requestedRole = ['admin', 'establishment_manager', 'resort_owner', 'staff'].includes(role) ? role : 'user';
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
        } else if (isEstablishmentManager(requestedRole)) {
            account = await EstablishmentManager.findOne({ email: normalizedEmail }).select('+password');
            resolvedRole = 'establishment_manager';
        } else {
            account = await User.findOne({ email: normalizedEmail }).select('+password');
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
                : isEstablishmentManager(resolvedRole) ? 'Tourist Establishment Manager'
                : 'User';
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

/**
 * 🌟 POST: Sign in (or register) a tourist with a Google account
 * The browser gets an ID token from Google and sends it here; this verifies that
 * token with Google directly, so a forged one can't get through.
 * Target URL: http://localhost:5000/api/auth/google
 */
app.post('/api/auth/google', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
    try {
        if (!process.env.GOOGLE_CLIENT_ID) {
            return res.status(503).json({ success: false, message: 'Google sign-in is not configured on the server yet.' });
        }

        const { credential } = req.body;
        if (!credential) {
            return res.status(400).json({ success: false, message: 'Missing Google credential.' });
        }

        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();

        if (!payload?.email_verified) {
            return res.status(401).json({ success: false, message: 'This Google account has no verified email address.' });
        }

        const email = payload.email.toLowerCase().trim();

        // Someone who already registered with a password keeps that one account —
        // signing in with the same Google email links the two rather than creating
        // a second account they'd never be able to find.
        let account = await User.findOne({ email });

        if (account) {
            if (!account.googleId) {
                account.googleId = payload.sub;
                account.avatar = account.avatar || payload.picture || "";
                if (!account.fullName) account.fullName = payload.name || "";
                await account.save();
            }
        } else {
            account = await new User({
                email,
                provider: 'google',
                googleId: payload.sub,
                avatar: payload.picture || "",
                fullName: payload.name || ""
            }).save();
        }

        console.log(`🔐 Google sign-in for ${email}`);
        return res.status(200).json({
            success: true,
            message: 'Signed in with Google.',
            token: createToken(account, 'user'),
            role: 'user',
            userId: account._id,
            user: {
                email: account.email,
                name: account.fullName || account.email.split('@')[0],
                fullName: account.fullName || "",
                phone: account.phone || "",
                nationality: account.nationality || "",
                avatar: account.avatar || ""
            }
        });
    } catch (error) {
        console.error("❌ Google Sign-In Failure:", error);
        return res.status(401).json({ success: false, message: 'Could not verify that Google account. Please try again.' });
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

    const user = await withFields(User.findOne({ email }));
    if (user) return user.provider === 'google' ? null : user;

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

/**
 * 🌟 GET: Fetch all user reviews from MongoDB
 * Target URL: http://localhost:5000/api/reviews
 */
app.get('/api/reviews', optionalAuth, async (req, res) => {
    try {
        const query = req.auth?.role === 'admin' ? {} : { status: 'approved' };
        const reviews = await Review.find(query).sort({ createdAt: -1 });
        return res.status(200).json(reviews);
    } catch (error) {
        console.error("❌ Review GET Fetch Failure:", error);
        return res.status(500).json({ error: 'Failed to fetch reviews matrix.', message: error.message });
    }
});

/**
 * 🌟 GET: Approved reviews for one spot, for its public detail page.
 * Matches on the spot reference and on the spot's name, so reviews written before
 * reviews carried a reference still show up.
 * Target URL: http://localhost:5000/api/spots/:id/reviews
 */
app.get('/api/spots/:id/reviews', async (req, res) => {
    try {
        const spot = await Spot.findById(req.params.id);
        if (!spot) return res.status(404).json({ message: 'Spot not found.' });

        const reviews = await Review.find({
            status: 'approved',
            $or: [{ spotId: spot._id }, { destinationId: spot.title }]
        }).sort({ createdAt: -1 });

        const averageRating = reviews.length
            ? Number((reviews.reduce((sum, review) => sum + (review.rating || 0), 0) / reviews.length).toFixed(1))
            : null;

        return res.status(200).json({ reviews, averageRating, total: reviews.length });
    } catch (error) {
        console.error("❌ Spot Reviews Fetch Failure:", error);
        return res.status(500).json({ reviews: [], averageRating: null, total: 0 });
    }
});

/**
 * 🌟 POST: Submit a new review into MongoDB 
 * Target URL: http://localhost:5000/api/reviews
 */
app.post('/api/reviews', requireTourist, async (req, res) => {
    try {
        console.log("➡️ Received Incoming Review Payload Data:", req.body);
        const { guestName, rating, destinationId, comment, imageURL, spotId } = req.body;

        // Exact validation criteria aligning with frontend payload structures
        if (!guestName || !rating || !destinationId || !comment) {
            return res.status(400).json({ message: 'Validation failed: Missing mandatory review payload keys.' });
        }

        const newReview = new Review({
            guestName,
            rating: Number(rating),
            destinationId,
            spotId: spotId || null,
            comment,
            imageURL: imageURL || "",
            status: 'approved' // Automatically default to approved state on submission
        });
        
        const savedReview = await newReview.save();
        
        console.log(`💬 New review committed safely from user: ${guestName} for location: ${destinationId}`);
        return res.status(201).json(savedReview);
    } catch (error) {
        console.error("❌ Review POST Submission Failure:", error);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
});

/**
 * 🌟 NEW HANDLER - PUT: Update review status filters (Approve/Hide)
 * Target URL: http://localhost:5000/api/reviews/:id/status
 */
app.put('/api/reviews/:id/status', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['approved', 'pending', 'hidden', 'reported'].includes(status)) {
            return res.status(400).json({ message: 'Invalid target status property.' });
        }

        const updatedReview = await Review.findByIdAndUpdate(
            id,
            { status: status },
            { new: true }
        );

        if (!updatedReview) {
            return res.status(404).json({ message: 'Review documentation tracker not found.' });
        }

        console.log(`🛡️ Review state toggled manually: ${id} changed to ${status}`);
        return res.status(200).json(updatedReview);
    } catch (error) {
        console.error("❌ Review Status PUT Failure:", error);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
});

/**
 * 🌟 NEW HANDLER - DELETE: Drop review entry records entirely from database
 * Target URL: http://localhost:5000/api/reviews/:id
 */
app.delete('/api/reviews/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const droppedRecord = await Review.findByIdAndDelete(id);

        if (!droppedRecord) {
            return res.status(404).json({ success: false, message: 'Review item identifier not found.' });
        }

        console.log(`🗑️ Review dropped from database completely: ${id}`);
        return res.status(200).json({ success: true, message: 'Review successfully deleted.' });
    } catch (error) {
        console.error("❌ Review Deletion System Interrupt:", error);
        return res.status(500).json({ success: false, error: 'Internal Server Error', message: error.message });
    }
});

/**
 * 🌟 NEW HANDLER - PATCH: Update a user's structural profile fields directly from booking form submissions
 * Target URL: http://localhost:5000/api/users/:id
 */
app.patch('/api/users/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.params.id;
        // This edits the tourist directory, so only a tourist editing themselves or
        // the Tourist Officer may touch it. An establishment manager was already refused by
        // the identity check below, but only as a side effect of their id never
        // matching a tourist's — saying so explicitly keeps that intentional.
        if (req.auth.role !== 'admin' && req.auth.role !== 'user') {
            return res.status(403).json({ error: 'Only tourist accounts have a profile here.' });
        }
        if (req.auth.role !== 'admin' && req.auth.sub !== userId) {
            return res.status(403).json({ error: 'You may only update your own profile.' });
        }
        const { fullName, phone, nationality } = req.body;

        // Find user by route identifier and update fields dynamically
        const updatedUser = await User.findByIdAndUpdate(
            userId,
            { 
                $set: { 
                    fullName: fullName,
                    phone: phone,
                    nationality: nationality 
                } 
            },
            { new: true, runValidators: true }
        );

        if (!updatedUser) {
            return res.status(404).json({ error: "User account document location not found." });
        }

        console.log(`👤 Profile updated for user ID: ${userId} [Name: ${fullName}, Phone: ${phone}, Nationality: ${nationality}]`);
        return res.status(200).json({ message: "User profile synchronized successfully.", user: updatedUser });
    } catch (err) {
        console.error("❌ Failed to run profile document amendment:", err);
        return res.status(500).json({ error: "Internal server update pipeline failure.", message: err.message });
    }
});

/* ==========================================
   ADDED: LIVE ANALYTICS MAPPER LINKS
========================================== */

/**
 * 🌟 GET: Fetch all active users for analytics tracking
 * Target URL: http://localhost:5000/api/users
 */
app.get('/api/users', requireAdmin, async (req, res) => {
    try {
        const usersList = await User.find({}, { password: 0 });
        return res.status(200).json(usersList);
    } catch (error) {
        return res.status(500).json([]);
    }
});

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
            .populate('managedBy', 'establishmentName resortName managerName contactEmail phone active')
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
    const manager = spot.managedBy && typeof spot.managedBy === 'object' ? spot.managedBy : null;
    if (!manager) return true;              // maintained by the office; no account behind it
    return manager.active !== false;
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
        const spot = await Spot.findById(req.params.id).populate('managedBy', 'establishmentName resortName managerName contactEmail phone active');
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

// Only modes the configured provider genuinely routes for are ever offered. A mode
// the service cannot compute would mean showing the visitor an invented number.
// OpenRouteService has no motorcycle profile, so no motorcycle option is offered.
// Showing one would mean handing the visitor a car's estimate under another name.
const ORS_MODES = {
    car: { profile: 'driving-car', label: 'Car' },
    bicycle: { profile: 'cycling-regular', label: 'Bicycle' },
    walking: { profile: 'foot-walking', label: 'Walking' }
};

// The public OSRM demo server only runs the car profile, so that is all it offers.
const OSRM_MODES = {
    car: { profile: 'driving', label: 'Car' }
};

const ROUTING_PROVIDER = ORS_API_KEY ? 'openrouteservice' : 'osrm';
const ROUTING_MODES = ORS_API_KEY ? ORS_MODES : OSRM_MODES;

// Identifies ZTIMS to OpenStreetMap's geocoder, which its usage policy requires.
const GEOCODER_USER_AGENT = `ZTIMS/1.0 (${process.env.PUBLIC_SITE_URL || 'https://ztims.vercel.app'})`;

const ROUTING_TIMEOUT_MS = 12000;

// Routing providers meter their free tiers, and each visitor action is one call.
// Generous enough to switch modes freely, tight enough that a loop cannot burn the
// day's quota. Keyed per IP by the trust-proxy setting configured at the top.
const directionsRateLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 40,
    standardHeaders: true,
    legacyHeaders: false,
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

async function routeWithOpenRouteService(from, to, mode) {
    const { profile } = ROUTING_MODES[mode];
    const data = await fetchJson(`https://api.openrouteservice.org/v2/directions/${profile}/geojson`, {
        method: 'POST',
        headers: { Authorization: ORS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ coordinates: [[from.longitude, from.latitude], [to.longitude, to.latitude]] })
    });

    const feature = data?.features?.[0];
    const summary = feature?.properties?.summary;
    // An empty summary is how OpenRouteService reports "these two points are not
    // connected by this kind of road" — an islet, or walking across a strait.
    if (!feature || !summary || !Number.isFinite(summary.distance)) return null;

    return {
        distanceMeters: summary.distance,
        durationSeconds: summary.duration,
        geometry: toLeafletLine(feature.geometry?.coordinates)
    };
}

async function routeWithOsrm(from, to, mode) {
    const { profile } = ROUTING_MODES[mode];
    const path = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    const data = await fetchJson(
        `https://router.project-osrm.org/route/v1/${profile}/${path}?overview=full&geometries=geojson`,
        { headers: { 'User-Agent': GEOCODER_USER_AGENT } }
    );

    const route = data?.code === 'Ok' ? data.routes?.[0] : null;
    if (!route || !Number.isFinite(route.distance)) return null;

    return {
        distanceMeters: route.distance,
        durationSeconds: route.duration,
        geometry: toLeafletLine(route.geometry?.coordinates)
    };
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
        modes: Object.entries(ROUTING_MODES).map(([id, mode]) => ({ id, label: mode.label }))
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

    try {
        const route = ROUTING_PROVIDER === 'openrouteservice'
            ? await routeWithOpenRouteService(from, to, mode)
            : await routeWithOsrm(from, to, mode);

        if (!route) {
            return res.status(404).json({
                success: false,
                message: 'No road route could be found between those two points for that way of travelling.'
            });
        }

        return res.status(200).json({
            success: true,
            mode,
            provider: ROUTING_PROVIDER,
            distanceMeters: Math.round(route.distanceMeters),
            durationSeconds: Math.round(route.durationSeconds),
            geometry: route.geometry
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
            const url = `https://api.openrouteservice.org/geocode/search?api_key=${encodeURIComponent(ORS_API_KEY)}`
                + `&text=${encodeURIComponent(text)}&boundary.country=PHL&size=6`;
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

        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=ph&limit=6`
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
app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(` 🚀 Server actively streaming data loops at:`);
    console.log(`     👉 http://localhost:${PORT}`);
    // Says which routing service this process actually loaded. ROUTING_PROVIDER is
    // decided once at startup from the environment, so a key added to the host after
    // the process began shows nothing until it restarts — this line is how you tell
    // the two apart without guessing.
    console.log(ORS_API_KEY
        ? ` 🧭 Travel directions: OpenRouteService (key ending ...${ORS_API_KEY.slice(-4)}) — car, bicycle, walking`
        : ` 🧭 Travel directions: OSRM demo server — car only. Set ORS_API_KEY for bicycle and walking.`);

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
});
