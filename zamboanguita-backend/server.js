const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer'); // Added for handling Forgot Password emails
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
// Read before db.js, which takes DATABASE_URL from the environment as it loads.
require('dotenv').config();
const { PostgresRateLimitStore } = require('./rate-limit-store');
const db = require('./db');
// Named as the Mongoose models they replaced, so each route reads as it did.
// TourismOfficer was `Admin`; the table is tourism_officers.
const {
    officers: TourismOfficer,
    managers: EstablishmentManager,
    spots: Spot,
    guides: TouristGuide,
    reports: GuideReport,
    languagesOf, setGuideLanguages, findGuidesSpeaking,
    bookings: GuideBooking,
    payments: Payment,
    feedback: Feedback,
    MAX_SPOT_IMAGES, GUIDE_STATUSES, GUIDE_SCOPES, GUIDE_REPORT_TYPES, WEEKDAYS, MAX_GUIDE_LANGUAGES, BOOKING_STATUSES,
    FEEDBACK_TOPICS, FEEDBACK_STATUSES, FEEDBACK_MESSAGE_MAX
} = require('./models');
const { forgetOldVisitors } = require('./privacy');

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
// On Vercel the site and this API share one origin, and a page calling its own
// origin is not a cross-origin request at all. Browsers still send an Origin
// header on a same-origin POST, though, so without this check every login and
// every save would depend on the site's address also being on the allow-list —
// and would break the day the site moved to a custom domain. A page elsewhere
// cannot fake this: its browser sends its own Origin and the API's own Host.
const isSameOrigin = (req, origin) => origin === `${req.protocol}://${req.get('host')}`;

app.use(cors((req, callback) => {
    const origin = req.get('origin');
    // No Origin header means a non-browser client (curl, Postman, health checks).
    if (!origin || isSameOrigin(req, origin) || isAllowedOrigin(origin)) {
        return callback(null, {
            origin: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
            allowedHeaders: ['Content-Type', 'Authorization']
        });
    }
    return callback(new Error(`Origin ${origin} is not allowed by CORS`));
}));
// This blanket limit stays in each instance's own memory, deliberately. It runs
// on every request, including ones that never touch the database, and counting
// it in the database would add a database round trip to all of them. It is a rough
// cushion against a flood, not a security control, so a count per instance is
// good enough. The limits that do guard something — login, password reset,
// the public forms, the metered routing providers — use sharedRateLimit below.
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 150, standardHeaders: true, legacyHeaders: false }));

/* A limit counted in the database, so it holds across every running instance of the
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
        store: new PostgresRateLimitStore(name),
        passOnStoreError: true
    });
}

// FORCE explicit body-parser rules across ALL incoming payload formats
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: false, parameterLimit: 1000 }));

/* ==========================================
   2. DATABASE
========================================== */

/* Postgres, on Supabase. The connection is in db.js and the records in
   models.js; both explain themselves. Nothing connects here at startup: the
   pool opens its first connection when the first query needs one, which is
   the only moment a serverless instance reliably has. A route that never
   touches the database — /api/directions/capabilities — never waits on it.

   ZTIMS ran on MongoDB before this. db/schema.sql is the whole data model now,
   and scripts/copy-from-mongo.js is how the records came across. */

/* `npm run migrate`: creates any missing tables (db/schema.sql, which is safe
   to run again) and then the first Tourism Officer, if INITIAL_ADMIN_EMAIL and
   INITIAL_ADMIN_PASSWORD are set. Run by a person, deliberately — see
   migrate.js for why none of this happens at startup.

   MongoDB needed two more steps here, reshaping stored documents in place
   (resortName → establishmentName, ownerId → managedBy). In Postgres the table
   definitions are that history, and the copy script translated the old shapes
   on the way across, so neither exists any more. */
async function runMigrations() {
    const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
    await db.query(schema);
    console.log('🗄️  Tables are in place (db/schema.sql).');
    await bootstrapAdmin();
}

/* ==========================================
   3. RECORDS
   The definitions are in models.js, each one mirroring the Mongoose schema it
   replaced, field for field.
========================================== */

/**
 * Creates the first Tourism Officer account from the environment.
 *
 * .env.example has documented INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD
 * since the beginning, but nothing ever read them — and /api/admin/create is
 * behind requireAdmin, so an officer account could only be made by an officer
 * who already existed. With no officer in the database, or with the password
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
        const existing = await TourismOfficer.findOne({ email }, { secrets: true });

        if (!existing) {
            await TourismOfficer.create({ email, password: await bcrypt.hash(password, 12) });
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
            await TourismOfficer.save(existing);
            console.warn(`🔑 PASSWORD RESET: ${email} now uses INITIAL_ADMIN_PASSWORD.`);
            console.warn('    Remove ADMIN_PASSWORD_RESET, INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD now.');
            return;
        }

        console.log(`🛡️  ${email} already exists — left untouched.`);
        console.log('    To change its password, set ADMIN_PASSWORD_RESET=true and run npm run migrate again.');
    } catch (error) {
        console.error('❌ Could not create the Tourism Officer account:', error.message);
    }
}

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

// ZTIMS has three kinds of account: Tourism Officer ('admin'), Establishment
// Manager, and Tourist Guide ('tourist_guide'). 'resort_owner' is not a fourth — it is the spelling the
// manager account carried in tokens issued before the rename, kept here only so
// a session signed in back then is not thrown out mid-visit. Nothing issues it
// any more.
const MANAGER_ROLES = ['establishment_manager', 'resort_owner'];
const isEstablishmentManager = role => MANAGER_ROLES.includes(role);

const requireEstablishmentManager = [requireAuth, (req, res, next) => {
    if (!isEstablishmentManager(req.auth.role)) {
        return res.status(403).json({ success: false, message: 'Tourist Establishment Manager access required.' });
    }
    return next();
}];


// A Tourist Guide in their own portal. Deliberately NOT part of requireStaff
// below: a guide has no business creating listings or signing photo uploads.
const requireGuide = [requireAuth, (req, res, next) => {
    if (req.auth.role !== 'tourist_guide') {
        return res.status(403).json({ success: false, message: 'Tourist Guide access required.' });
    }
    return next();
}];

// Tourist Officer or Tourist Establishment Manager — used on routes both manage,
// each scoped to their own data. Guides are not staff in this sense.
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


/**
 * Which kind of account already signs in with this email, or null.
 *
 * The staff sign-in page does not ask which kind of account someone has; the
 * login route searches officers, then managers, then guides, and takes the
 * first match. Two accounts sharing an email would leave the later one unable
 * to ever sign in, so every place that issues or changes a sign-in email asks
 * this first. `except` is the record being edited, which may keep its own.
 */
async function emailTakenBy(email, except = {}) {
    const officer = await TourismOfficer.findOne({ email });
    if (officer && String(officer._id) !== String(except.officerId)) return 'a Tourism Officer';
    const manager = await EstablishmentManager.findOne({ email });
    if (manager && String(manager._id) !== String(except.managerId)) return 'an establishment manager';
    const guide = await TouristGuide.findOne({ email });
    if (guide && String(guide._id) !== String(except.guideId)) return 'a tourist guide';
    return null;
}

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
 * 🌟 POST: Add a new Tourism Officer account
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
        const existingAdmin = await TourismOfficer.findOne({ email: normalizedEmail });
        if (existingAdmin) {
            return res.status(409).json({ success: false, message: 'This email is already registered as an admin.' });
        }
        const takenBy = await emailTakenBy(normalizedEmail);
        if (takenBy) {
            return res.status(409).json({ success: false, message: `This email already signs in as ${takenBy}.` });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        await TourismOfficer.create({
            email: normalizedEmail,
            password: passwordHash
        });

        console.log(`🛡️ New Tourism Officer account created: ${normalizedEmail}`);
        return res.status(201).json({ success: true, message: 'New admin successfully added!' });
    } catch (error) {
        console.error("❌ Add Admin Endpoint Failure:", error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

/**
 * 🌟 GET: List every Tourism Officer account (never the password hashes)
 * Target URL: http://localhost:5000/api/admin/list
 */
app.get('/api/admin/list', requireAdmin, async (req, res) => {
    try {
        const adminList = await TourismOfficer.find({}, { sort: { createdAt: 1 } });
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

        const admin = await TourismOfficer.findById(req.auth.sub, { secrets: true });
        if (!admin) return res.status(404).json({ success: false, message: 'Account not found.' });

        if (!(await bcrypt.compare(currentPassword, admin.password))) {
            return res.status(401).json({ success: false, message: 'That current password is not right.' });
        }

        admin.password = await bcrypt.hash(newPassword, 12);
        admin.resetTokenHash = null;        // any reset link in flight is now void
        admin.resetTokenExpires = null;
        await TourismOfficer.save(admin);

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
        const takenBy = await emailTakenBy(normalizedEmail);
        if (takenBy) {
            return res.status(409).json({ success: false, message: `This email already signs in as ${takenBy}.` });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        await EstablishmentManager.create({
            email: normalizedEmail,
            password: passwordHash,
            establishmentName: establishmentName.trim(),
            managerName: (managerName || "").trim(),
            // Left blank, the sign-in address doubles as the public one, so a
            // listing never ends up with no way to reach anybody.
            contactEmail: (req.body.contactEmail || normalizedEmail).toLowerCase().trim(),
            phone: phone || ""
        });

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
        // Oldest first, the order MongoDB returned them in. Never the hashes.
        const managers = await EstablishmentManager.find({}, { sort: { createdAt: 1 } });
        return res.status(200).json(managers.map(manager => ({
            ...manager,
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
        // db.js names the specific case when it knows it ("Payment for that
        // booking was already recorded"); otherwise, the generic wording.
        return res.status(409).json({ success: false, message: error.specific || `That ${field} is already registered.` });
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
        establishmentName: manager.establishmentName,
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
        await EstablishmentManager.save(manager);

        const listings = await Spot.count({ managedBy: manager._id });
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
    await EstablishmentManager.save(manager);
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

        const manager = await EstablishmentManager.findById(req.auth.sub, { secrets: true });
        if (!manager) return res.status(404).json({ success: false, message: 'Account not found.' });

        // Proving the current password is what stops a borrowed, still-signed-in
        // browser from being used to lock the real manager out.
        if (!(await bcrypt.compare(currentPassword, manager.password))) {
            return res.status(401).json({ success: false, message: 'That current password is not right.' });
        }

        manager.password = await bcrypt.hash(newPassword, 12);
        manager.resetTokenHash = null;      // any reset link in flight is now void
        manager.resetTokenExpires = null;
        await EstablishmentManager.save(manager);

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
                const takenBy = await emailTakenBy(email, { managerId: manager._id });
                if (takenBy) return res.status(409).json({ success: false, message: `That email already signs in as ${takenBy}.` });
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

        const listings = await Spot.count({ managedBy: manager._id });
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
        await EstablishmentManager.save(manager);

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

        const listings = await Spot.count({ managedBy: manager._id });
        if (listings > 0) {
            return res.status(409).json({
                success: false,
                message: `This account still has ${listings} listing${listings === 1 ? '' : 's'}. Suspend it instead, or take those listings down first.`
            });
        }

        await EstablishmentManager.deleteById(manager._id);
        console.log(`🗑️ Officer deleted establishment manager account ${manager.email}`);
        return res.status(200).json({ success: true, message: 'Account deleted.' });
    } catch (error) {
        console.error('❌ Officer manager delete failure:', error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});



/**
 * POST: Sign in. ZTIMS has three kinds of account: Tourism Officer, Tourist
 * Establishment Manager and Tourist Guide. Visitors browse without one.
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
        // ZTIMS has exactly three kinds of account. Anything else is refused here
        // rather than quietly searched for in a collection that no longer exists.
        const requestedRole = ['admin', 'establishment_manager', 'resort_owner', 'tourist_guide', 'staff'].includes(role) ? role : null;
        if (!requestedRole) {
            return res.status(400).json({ success: false, message: 'Unknown sign-in type.' });
        }
        let account = null;
        let resolvedRole = requestedRole;

        if (requestedRole === 'staff') {
            account = await TourismOfficer.findOne({ email: normalizedEmail }, { secrets: true });
            resolvedRole = 'admin';

            if (!account) {
                account = await EstablishmentManager.findOne({ email: normalizedEmail }, { secrets: true });
                resolvedRole = 'establishment_manager';
            }
            if (!account) {
                account = await TouristGuide.findOne({ email: normalizedEmail }, { secrets: true });
                resolvedRole = 'tourist_guide';
            }
        } else if (requestedRole === 'admin') {
            account = await TourismOfficer.findOne({ email: normalizedEmail }, { secrets: true });
        } else if (requestedRole === 'tourist_guide') {
            account = await TouristGuide.findOne({ email: normalizedEmail }, { secrets: true });
        } else {
            account = await EstablishmentManager.findOne({ email: normalizedEmail }, { secrets: true });
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
        // An inactive guide no longer works for the office; the record stays,
        // the portal does not.
        if (account && resolvedRole === 'tourist_guide' && account.status === 'inactive') {
            return res.status(403).json({
                success: false,
                message: 'This guide account is marked inactive by the Municipal Tourism Office. Please contact them to have it restored.'
            });
        }

        // A guide record whose sign-in was withdrawn has no hash to compare.
        if (!account || !account.password || !(await bcrypt.compare(password, account.password))) {
            // Deliberately the same wording whichever collection was searched, so the
            // response can't be used to discover which emails are registered.
            const audience = requestedRole === 'staff' ? 'staff'
                : resolvedRole === 'admin' ? 'Tourist Officer'
                : resolvedRole === 'tourist_guide' ? 'Tourist Guide'
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
                name: account.fullName || account.establishmentName || account.email.split('@')[0],
                fullName: account.fullName || "",
                phone: account.phone || "",
                nationality: account.nationality || "",
                establishmentName: account.establishmentName || "",
                scope: account.scope || "",
                barangay: account.barangay || "",
                // Pre-rename key, still sent so a page cached from before the rename
                // keeps showing the establishment's name instead of a blank.
                resortName: account.establishmentName || ""
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
 * Returns { account, table } — the table being where the account is saved back —
 * or null.
 */
async function findResettableAccount(email, withResetFields) {
    const options = { secrets: Boolean(withResetFields) };

    const manager = await EstablishmentManager.findOne({ email }, options);
    if (manager) return manager.active === false ? null : { account: manager, table: EstablishmentManager };

    const officer = await TourismOfficer.findOne({ email }, options);
    if (officer) return { account: officer, table: TourismOfficer };

    // A guide can reset only a sign-in the office actually issued, and not while
    // the office has them marked inactive.
    const guide = await TouristGuide.findOne({ email }, { secrets: true });
    if (!guide || !guide.password || guide.status === 'inactive') return null;
    return { account: guide, table: TouristGuide };
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
        const found = await findResettableAccount(normalizedEmail, false);
        const user = found && found.account;

        // An address with no resettable account gets exactly the same answer as
        // one that has, so this cannot be used to find out who is registered.
        if (!user) {
            return res.status(200).json({ success: true, message: GENERIC_RESET_REPLY });
        }

        const token = crypto.randomBytes(32).toString('hex');
        user.resetTokenHash = hashResetToken(token);
        user.resetTokenExpires = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);
        await found.table.save(user);

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
            await found.table.save(user);
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

        const found = await findResettableAccount(String(email).toLowerCase().trim(), true);
        const user = found && found.account;

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
        await found.table.save(user);

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
        const foundSpots = await Spot.findWithManagers(query);

        // A suspended establishment's listings leave the public site, but the
        // Tourist Officer still sees them — otherwise the listings they just hid
        // would vanish from the very page they oversee them on.
        const visibleSpots = req.auth?.role === 'admin'
            ? foundSpots
            : foundSpots.filter(isPubliclyVisible);

        return res.status(200).json(visibleSpots.map(spot => {
            const manager = spot.managedBy;
            return {
                ...spot,
                // No assigned manager means the Tourism Office maintains this listing.
                managerName: manager ? (manager.establishmentName || '') : '',
                managerContact: manager ? (manager.managerName || '') : '',
                managerEmail: manager ? (manager.contactEmail || '') : '',
                managerPhone: manager ? (manager.phone || '') : ''
            };
        }));
    } catch (error) {
        console.error('❌ Listing list failure:', error);
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
    'address', 'barangay', 'latitude', 'longitude'
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
        // One establishment, one listing (spots_one_per_establishment holds it
        // too); said plainly here before anything is written.
        if (managedBy && await Spot.count({ managedBy })) {
            return res.status(409).json({
                success: false,
                message: isEstablishmentManager(req.auth.role)
                    ? 'Your establishment already has its listing. Edit that one instead of adding another.'
                    : 'That establishment already has its listing. An establishment keeps one listing.'
            });
        }
        // The record's identity and history are the database's to set, never a request's.
        const { _id, createdAt, updatedAt, ...body } = req.body;
        const scoped = scopeSpotPayload(body, isEstablishmentManager(req.auth.role) ? 'manager' : 'officer');
        const prepared = deriveSpotType(deriveSpotLocation(normaliseSpotLocation(normaliseSpotImages(scoped)), ''));
        const savedSpot = await Spot.create({ ...prepared, managedBy });
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
        const spot = await Spot.findByIdWithManager(req.params.id);
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
        spot.statusUpdatedAt = new Date();
        await Spot.save(spot);

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

        // Which establishment maintains a listing is never reassigned from here,
        // and a listing's id and history are never the request's to change: the
        // update is saved against the id in the URL, whatever the body carries.
        const { managedBy, ownerId, _id, createdAt, updatedAt, ...updates } = req.body;
        const prepared = normaliseSpotLocation(normaliseSpotImages(scopeSpotPayload(updates, verdict.scope)));
        Object.assign(spot, deriveSpotType(deriveSpotLocation(prepared, spot.location)));
        const savedSpot = await Spot.save(spot);
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

        await Spot.deleteById(spot._id);
        return res.status(200).json({ success: true, message: 'Spot deleted.' });
    } catch (error) {
        // MongoDB let a listing be deleted out from under its guide bookings;
        // the database refuses now, since those bookings must keep their destination.
        if (error && error.code === 'STILL_REFERENCED') {
            return res.status(409).json({
                success: false,
                message: 'This listing has guide bookings on record, so it cannot be deleted. Archive it instead — the record is kept and the public no longer sees it.'
            });
        }
        return res.status(500).json({ error: error.message });
    }
});

/* ==========================================
   4a. TOURIST GUIDES
   ------------------------------------------
   Municipal tourism records, managed by the Tourism Office. A guide may also
   be given a sign-in to the guide portal: one role, 'tourist_guide', whatever
   the guide's jurisdiction. The jurisdiction is the guide's SCOPE:

     municipal   the whole municipality; stationed at the Municipal Tourism Office
     barangay    one barangay (`barangay`), where they are stationed

   Every screen is the same for both; the scope only filters. A barangay guide's
   dashboard counts the bookings at destinations in their barangay, a municipal
   guide's counts them all — the same query with a different WHERE — and the
   office can only assign a barangay guide destinations in that barangay.

   Who decides what:
     the guide   proposes — their availability (status and working days) and
                 the languages they speak; keeps their own contact number and
                 bio; files reports
     the office  disposes — assigns every booking, reviews every report, and
                 alone sets name, scope, fee, group size, destinations, photo
                 and inactive

   Everything a visitor needs to see is served by one public route that reports
   the requirement without exposing a guide's contact details.
========================================== */

// Zamboanguita's barangays, the only ones a barangay scope can name. A copy of
// BARANGAYS in Zamboanguita-project/src/shared/spot-form.js, which fills every
// listing's barangay — keep the two in step (CLAUDE.md, "Duplicated facts").
const BARANGAYS = [
    'Basak', 'Calango', 'Jumao-as', 'Lutoban', 'Malongcay Diot', 'Maluay',
    'Mayabon', 'Nabago', 'Najandig', 'Nasig-id', 'Poblacion'
];

const WEEKDAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const REPORT_TYPE_NAMES = {
    tour_completed: 'Tour completed',
    headcount: 'Headcount',
    incident: 'Incident',
    tourist_feedback: 'Tourist feedback'
};

const guideInvalid = message => Object.assign(new Error(message), { name: 'ValidationError' });
const today = () => new Date().toISOString().slice(0, 10);
const isCalendarDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value + 'T00:00:00Z').getTime());

// Barangay names compared the way a person would read them.
const barangayKey = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
const officialBarangay = value => BARANGAYS.find(name => barangayKey(name) === barangayKey(value)) || null;

/* Languages as a guide or the office typed them: trimmed, each once whatever
   its capitalisation, none empty, none absurdly long. */
function cleanLanguages(list) {
    if (!Array.isArray(list)) throw guideInvalid('Languages must be a list.');
    const seen = new Set();
    const clean = [];
    for (const item of list) {
        let name = String(item || '').trim().replace(/\s+/g, ' ');
        if (!name) continue;
        // "korean" or "KOREAN" becomes "Korean". The first spelling saved is the
        // one everybody sees (languages are shared), so it should be the proper
        // one; a deliberately mixed-case name is kept as typed.
        if (name === name.toLowerCase() || name === name.toUpperCase()) {
            name = name.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, gap, letter) => gap + letter.toUpperCase());
        }
        if (name.length > 40) throw guideInvalid(`"${name.slice(0, 40)}…" is too long for a language name.`);
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        clean.push(name);
    }
    if (clean.length > MAX_GUIDE_LANGUAGES) throw guideInvalid(`List at most ${MAX_GUIDE_LANGUAGES} languages.`);
    return clean;
}

/* Working days, in week order, each once. At least one: a guide who works no
   day at all is what the 'unavailable' status is for. */
function cleanAvailableDays(list) {
    if (!Array.isArray(list)) throw guideInvalid('Working days must be a list.');
    const wanted = new Set(list.map(day => String(day || '').trim().toLowerCase()));
    const days = WEEKDAYS.filter(day => wanted.has(day));
    if (!days.length) throw guideInvalid('Choose at least one working day, or set the guide as unavailable instead.');
    return days;
}

// The weekday of a YYYY-MM-DD date, read as a calendar date (no timezone).
const weekdayOf = date => WEEKDAYS[(new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7];

/**
 * Cleans a guide payload from the office. Numbers are coerced, because a form
 * sends strings and a fee of "500" silently stored as text would break every
 * comparison later. The scope is checked against the destinations separately,
 * by checkGuideScope, because that needs the database.
 */
function applyGuideDetails(guide, body) {
    if (typeof body.fullName === 'string') {
        const name = body.fullName.trim();
        if (!name) throw guideInvalid('The guide needs a name.');
        guide.fullName = name;
    }
    for (const field of ['photoUrl', 'contactNumber', 'location', 'bio']) {
        if (typeof body[field] === 'string') guide[field] = body[field].trim();
    }
    if (body.guideFee !== undefined) {
        const fee = Number(body.guideFee);
        if (!Number.isFinite(fee) || fee < 0) throw guideInvalid('The guide fee must be zero or more.');
        guide.guideFee = fee;
    }
    if (body.maxGroupSize !== undefined) {
        const size = Math.floor(Number(body.maxGroupSize));
        if (!Number.isFinite(size) || size < 1) throw guideInvalid('The maximum group size must be at least one person.');
        guide.maxGroupSize = size;
    }
    if (body.status !== undefined) {
        if (!GUIDE_STATUSES.includes(body.status)) throw guideInvalid('Choose available, unavailable, or inactive.');
        guide.status = body.status;
    }
    if (Array.isArray(body.assignedSpots)) {
        // Only ids that are real, and each one once.
        const valid = body.assignedSpots
            .map(id => String(id || '').trim())
            .filter(id => db.isId(id));
        guide.assignedSpots = [...new Set(valid)];
    }
    if (body.scope !== undefined) {
        if (!GUIDE_SCOPES.includes(body.scope)) throw guideInvalid('Choose a municipal or a barangay scope.');
        guide.scope = body.scope;
    }
    if (typeof body.barangay === 'string') guide.barangay = body.barangay.trim();
    if (body.availableDays !== undefined) guide.availableDays = cleanAvailableDays(body.availableDays);
    return guide;
}

/**
 * The scope rule, checked on the guide as it is about to be saved: a barangay
 * guide names a real barangay, and every destination they serve is in it. A
 * municipal guide covers everywhere, so any barangay left over from an earlier
 * scope is cleared rather than left to mislead.
 *
 * A listing whose barangay was never filled in belongs to no barangay, so only
 * a municipal guide can serve it.
 */
async function checkGuideScope(guide) {
    if ((guide.scope || 'municipal') === 'municipal') {
        guide.scope = 'municipal';
        guide.barangay = '';
        return;
    }
    const barangay = officialBarangay(guide.barangay);
    if (!barangay) throw guideInvalid('A barangay guide needs the barangay they are stationed in, chosen from the list.');
    guide.barangay = barangay;

    const ids = (guide.assignedSpots || []).map(String);
    if (!ids.length) return;
    const spots = await Spot.find({ _id: { in: ids } });
    const outside = spots.filter(spot => barangayKey(spot.barangay) !== barangayKey(barangay));
    if (outside.length) {
        throw guideInvalid(
            `A barangay guide for ${barangay} can only serve destinations in ${barangay}. ` +
            `Untick ${outside.map(spot => spot.title).join(', ')}, or make them a municipal guide.`
        );
    }
}

/**
 * Whether a guide can take a tour on `date` (and, when given, at `time`) —
 * the ONE rule, used both when the office assigns a booking and when it
 * searches for a free guide, so the search can never promise a guide the
 * assignment would then refuse. Returns { free: true } or { free: false, reason }.
 *
 * With a time, only a confirmed booking at that same date and time clashes:
 * ZTIMS does not record how long a tour runs, so anything wider would mean
 * refusing bookings on a guess. Without a time (a search for a free day), any
 * confirmed booking that day counts, since the office has not said when.
 */
/* One tour per guide per day, whatever the time: tours here run for hours
   (a falls trek, a dive), and a guide who is busy that day leaves the other
   guides a turn. `time` is still accepted from callers but no longer decides. */
async function isGuideFreeOn(guide, date, { exceptBookingId } = {}) {
    if (guide.status !== 'available') return { free: false, reason: `${guide.fullName} is marked ${guide.status}.` };

    const weekday = weekdayOf(date);
    if (!(guide.availableDays || WEEKDAYS).includes(weekday)) {
        return { free: false, reason: `${guide.fullName} does not work on ${WEEKDAY_NAMES[weekday]}s.` };
    }
    const clash = await GuideBooking.findOne({
        _id: exceptBookingId ? { ne: String(exceptBookingId) } : undefined,
        guideId: guide._id,
        status: 'confirmed',
        preferredDate: date
    });
    if (clash) {
        return {
            free: false,
            reason: `${guide.fullName} already has a tour that day (${clash.reference}). A guide takes one tour a day.`
        };
    }
    return { free: true };
}

/* What a guide sees of their own record in the portal. Never the hash. */
function guideProfile(guide, spotSummaries, languages) {
    return {
        _id: guide._id,
        fullName: guide.fullName,
        photoUrl: guide.photoUrl || '',
        contactNumber: guide.contactNumber || '',
        location: guide.location || '',
        bio: guide.bio || '',
        guideFee: guide.guideFee,
        maxGroupSize: guide.maxGroupSize,
        status: guide.status,
        scope: guide.scope || 'municipal',
        barangay: guide.barangay || '',
        languages: languages || [],
        availableDays: guide.availableDays || WEEKDAYS.slice(),
        email: guide.email || '',
        assignedSpots: spotSummaries || [],
        createdAt: guide.createdAt
    };
}

/* ---- The guide's own portal ------------------------------------------------
   Every route here is scoped to req.auth.sub — the guide id never comes from
   the request — and registered before the office's /api/guides/:id routes so
   'me' is never read as an id. The record is re-read on each request, so a
   sign-in withdrawn or a guide made inactive stops working at once rather
   than when the two-hour token runs out. */

async function loadSignedInGuide(req, res, options) {
    const guide = await TouristGuide.findById(req.auth.sub, options);
    if (!guide || !guide.email) {
        res.status(401).json({ success: false, message: 'This guide sign-in is no longer active.' });
        return null;
    }
    if (guide.status === 'inactive') {
        res.status(403).json({ success: false, message: 'Your guide record is marked inactive by the Municipal Tourism Office.' });
        return null;
    }
    return guide;
}

async function spotSummariesFor(guide) {
    const ids = (guide.assignedSpots || []).map(String);
    if (!ids.length) return [];
    const list = await Spot.find({ _id: { in: ids } });
    const byId = new Map(list.map(spot => [String(spot._id), spot]));
    return ids.filter(id => byId.has(id)).map(id => {
        const spot = byId.get(id);
        return { _id: spot._id, title: spot.title, location: spot.location, barangay: spot.barangay || '' };
    });
}

async function fullGuideProfile(guide) {
    const [spotSummaries, languages] = await Promise.all([
        spotSummariesFor(guide),
        languagesOf(guide._id)
    ]);
    return guideProfile(guide, spotSummaries, languages);
}

app.get('/api/guides/me', requireGuide, async (req, res) => {
    try {
        const guide = await loadSignedInGuide(req, res);
        if (!guide) return;
        return res.status(200).json({ success: true, guide: await fullGuideProfile(guide), barangays: BARANGAYS });
    } catch (error) {
        console.error('❌ Guide profile read failure:', error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

/**
 * PATCH: the guide's own availability — whether they are taking work, and which
 * weekdays. Only available and unavailable: 'inactive' is the office's call, and
 * a guide it has set inactive cannot reach this route at all. Availability is a
 * proposal: it limits what the office may assign, it never assigns anything.
 */
app.patch('/api/guides/me/availability', requireGuide, async (req, res) => {
    try {
        const guide = await loadSignedInGuide(req, res);
        if (!guide) return;

        if (req.body.status !== undefined && !['available', 'unavailable'].includes(req.body.status)) {
            return res.status(400).json({ success: false, message: 'Choose available or unavailable.' });
        }
        const nextStatus = req.body.status !== undefined ? req.body.status : guide.status;
        const nextDays = req.body.availableDays !== undefined ? cleanAvailableDays(req.body.availableDays) : guide.availableDays;

        // The guide proposes, the office disposes: a guide cannot step away from
        // confirmed tours still to come. The office reassigns them first.
        const manilaToday = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
        const upcoming = (await GuideBooking.find({ guideId: guide._id, status: 'confirmed' }))
            .filter(b => String(b.preferredDate).slice(0, 10) >= manilaToday);
        const leftBehind = upcoming
            .filter(b => nextStatus !== 'available' || !nextDays.includes(weekdayOf(String(b.preferredDate).slice(0, 10))))
            .sort((x, y) => String(x.preferredDate).localeCompare(String(y.preferredDate)));
        if (leftBehind.length) {
            const list = leftBehind.slice(0, 5).map(b => `${b.reference} on ${String(b.preferredDate).slice(0, 10)}`).join(', ');
            return res.status(409).json({
                success: false,
                message: `You still have ${leftBehind.length === 1 ? 'a confirmed tour' : `${leftBehind.length} confirmed tours`} then: ${list}${leftBehind.length > 5 ? ', …' : ''}. Ask the Tourism Office to reassign ${leftBehind.length === 1 ? 'it' : 'them'} first.`,
                bookings: leftBehind.map(b => ({ reference: b.reference, date: String(b.preferredDate).slice(0, 10) }))
            });
        }
        guide.status = nextStatus;
        guide.availableDays = nextDays;

        await TouristGuide.save(guide);
        console.log(`🗓️ Guide ${guide.email} updated their availability (${guide.status})`);
        return res.status(200).json({ success: true, message: 'Your availability has been saved.', guide: await fullGuideProfile(guide) });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Guide availability failure:');
    }
});

app.put('/api/guides/me/languages', requireGuide, async (req, res) => {
    try {
        const guide = await loadSignedInGuide(req, res);
        if (!guide) return;

        await setGuideLanguages(guide._id, cleanLanguages(req.body.languages));
        return res.status(200).json({ success: true, message: 'Your languages have been saved.', guide: await fullGuideProfile(guide) });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Guide languages failure:');
    }
});

/**
 * PATCH: the guide's own contact number and "about you", saved straight away.
 * Only these two: name, scope, fee, group size, destinations and photo stay the
 * office's, because they decide what the guide may be assigned. Anything else in
 * the body is ignored.
 */
app.patch('/api/guides/me/details', requireGuide, async (req, res) => {
    try {
        const guide = await loadSignedInGuide(req, res);
        if (!guide) return;

        if (typeof req.body.contactNumber === 'string') {
            const contactNumber = req.body.contactNumber.trim();
            if (contactNumber.length > 40) return res.status(400).json({ success: false, message: 'That contact number is too long.' });
            guide.contactNumber = contactNumber;
        }
        if (typeof req.body.bio === 'string') {
            const bio = req.body.bio.trim();
            if (bio.length > 2000) return res.status(400).json({ success: false, message: 'Keep "About you" under 2000 characters.' });
            guide.bio = bio;
        }

        await TouristGuide.save(guide);
        console.log(`✏️ Guide ${guide.email} updated their contact details`);
        return res.status(200).json({ success: true, message: 'Your details have been saved.', guide: await fullGuideProfile(guide) });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Guide details failure:');
    }
});

app.post('/api/guides/me/password', requireGuide, resetRateLimit, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'Your current and new passwords are both required.' });
        }
        if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ success: false, message: `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        }

        const guide = await loadSignedInGuide(req, res, { secrets: true });
        if (!guide) return;
        if (!guide.password || !(await bcrypt.compare(currentPassword, guide.password))) {
            return res.status(401).json({ success: false, message: 'That current password is not right.' });
        }

        guide.password = await bcrypt.hash(newPassword, 12);
        guide.resetTokenHash = null;        // any reset link in flight is now void
        guide.resetTokenExpires = null;
        await TouristGuide.save(guide);

        console.log(`🔑 Tourist guide changed their own password: ${guide.email}`);
        return res.status(200).json({ success: true, message: 'Your password has been changed.' });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Guide password change failure:');
    }
});

// "YYYY-MM" for this month and the five before it, oldest first.
function lastSixMonths() {
    const now = today();
    const year = Number(now.slice(0, 4));
    const month = Number(now.slice(5, 7)) - 1;
    const months = [];
    for (let i = 5; i >= 0; i--) months.push(new Date(Date.UTC(year, month - i, 1)).toISOString().slice(0, 7));
    return months;
}

function tally(list, keyOf, weightOf) {
    const counts = new Map();
    for (const item of list) {
        const key = keyOf(item);
        if (key) counts.set(key, (counts.get(key) || 0) + (weightOf ? weightOf(item) : 1));
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/**
 * GET: the guide's schedule and dashboard.
 *
 *   bookings   the bookings assigned to THIS guide, with who they are for —
 *              what a guide needs to meet their visitors. Never the email,
 *              nothing about money.
 *   mine       reports on those bookings
 *   area       the tourism traffic in the guide's jurisdiction — every
 *              booking at a destination in their barangay, or in the whole
 *              municipality for a municipal guide. Counts only: whose
 *              booking it is stays with the guide it was assigned to.
 */
app.get('/api/guides/me/bookings', requireGuide, async (req, res) => {
    try {
        const guide = await loadSignedInGuide(req, res);
        if (!guide) return;

        const scopeBarangay = guide.scope === 'barangay' ? guide.barangay : null;
        const [bookings, inArea] = await Promise.all([
            GuideBooking.listForGuide(guide._id),
            GuideBooking.listInJurisdiction(scopeBarangay)
        ]);

        const now = today();
        const thisMonth = now.slice(0, 7);
        const months = lastSixMonths();
        const count = (list, status) => list.filter(b => b.status === status).length;
        const visitors = list => list.reduce((sum, b) => sum + (b.visitors || 0), 0);
        const upcoming = list => list.filter(b => b.preferredDate >= now && ['pending_payment', 'confirmed'].includes(b.status));
        const completed = bookings.filter(b => b.status === 'completed');
        const areaCompleted = inArea.filter(b => b.status === 'completed');

        return res.status(200).json({
            success: true,
            bookings,
            jurisdiction: scopeBarangay ? `Barangay ${scopeBarangay}` : 'Municipality of Zamboanguita',
            mine: {
                upcoming: upcoming(bookings).length,
                confirmed: count(bookings, 'confirmed'),
                awaitingPayment: count(bookings, 'pending_payment'),
                completed: completed.length,
                cancelled: count(bookings, 'cancelled'),
                noShow: count(bookings, 'no_show'),
                visitorsGuided: visitors(completed),
                toursThisMonth: completed.filter(b => String(b.preferredDate).startsWith(thisMonth)).length,
                byMonth: months.map(month => {
                    const inMonth = completed.filter(b => String(b.preferredDate).startsWith(month));
                    return { month, tours: inMonth.length, visitors: visitors(inMonth) };
                }),
                byNationality: tally(completed, b => b.nationality)
            },
            area: {
                upcoming: upcoming(inArea).length,
                unassignedUpcoming: upcoming(inArea).filter(b => !b.guideId).length,
                completed: areaCompleted.length,
                visitors: visitors(areaCompleted),
                byMonth: months.map(month => {
                    const inMonth = areaCompleted.filter(b => String(b.preferredDate).startsWith(month));
                    return { month, tours: inMonth.length, visitors: visitors(inMonth) };
                }),
                byDestination: tally(areaCompleted, b => b.spot && b.spot.title, b => b.visitors || 0)
            }
        });
    } catch (error) {
        console.error('❌ Guide bookings read failure:', error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

/* ---- Reports a guide files to the office ---------------------------------- */

app.get('/api/guides/me/reports', requireGuide, async (req, res) => {
    try {
        const guide = await loadSignedInGuide(req, res);
        if (!guide) return;
        const list = await GuideReport.listForOffice({ guideId: guide._id });
        return res.status(200).json({ success: true, reports: list.slice(0, 100) });
    } catch (error) {
        console.error('❌ Guide reports read failure:', error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

/**
 * POST: file a report. Where it happened (`barangay`) is worked out here —
 * from the booking's destination, or the guide's own barangay — never taken
 * from the guide, except that a municipal guide filing without a booking may
 * name the barangay, from the list, since their jurisdiction is all of them.
 * Filing never changes a booking; marking a tour completed stays the office's.
 */
app.post('/api/guides/me/reports', requireGuide, async (req, res) => {
    try {
        const guide = await loadSignedInGuide(req, res);
        if (!guide) return;

        const reportType = String(req.body.reportType || '').trim();
        if (!GUIDE_REPORT_TYPES.includes(reportType)) {
            return res.status(400).json({ success: false, message: 'Choose what you are reporting.' });
        }
        const details = String(req.body.details || '').trim();
        if (details.length > 2000) return res.status(400).json({ success: false, message: 'Keep the details under 2000 characters.' });

        let booking = null;
        let barangay = guide.scope === 'barangay' ? guide.barangay : '';
        if (req.body.bookingId) {
            booking = await GuideBooking.findById(req.body.bookingId);
            // Only a booking assigned to this guide; any other is "not found".
            if (!booking || String(booking.guideId) !== String(guide._id)) {
                return res.status(404).json({ success: false, message: 'That booking is not one assigned to you.' });
            }
            const spot = await Spot.findById(booking.spotId);
            barangay = (spot && officialBarangay(spot.barangay)) || (spot && spot.barangay) || barangay;
        } else if (guide.scope !== 'barangay' && req.body.barangay) {
            barangay = officialBarangay(req.body.barangay);
            if (!barangay) return res.status(400).json({ success: false, message: 'Choose the barangay from the list.' });
        }

        if (reportType === 'tour_completed' && !booking) {
            return res.status(400).json({ success: false, message: 'Choose the booking whose tour was completed.' });
        }
        let headcount = null;
        if (req.body.headcount !== undefined && req.body.headcount !== null && req.body.headcount !== '') {
            headcount = Number(req.body.headcount);
            if (!Number.isInteger(headcount) || headcount < 0) {
                return res.status(400).json({ success: false, message: 'The headcount must be a whole number.' });
            }
        }
        if (['tour_completed', 'headcount'].includes(reportType) && headcount === null) {
            return res.status(400).json({ success: false, message: 'Give the number of visitors.' });
        }
        if (['incident', 'tourist_feedback'].includes(reportType) && !details) {
            return res.status(400).json({ success: false, message: reportType === 'incident' ? 'Describe what happened.' : 'Write down what the tourist said.' });
        }

        const reportDate = String(req.body.reportDate || (booking && booking.preferredDate) || today()).trim();
        if (!isCalendarDate(reportDate)) return res.status(400).json({ success: false, message: 'Choose the date it happened.' });
        if (reportDate > today()) return res.status(400).json({ success: false, message: 'A report is about something that has happened — that date is still to come.' });

        const report = await GuideReport.create({
            guideId: guide._id,
            bookingId: booking ? booking._id : null,
            reportType, reportDate, headcount, barangay, details
        });
        console.log(`📝 ${guide.fullName} filed a ${reportType} report${barangay ? ` (${barangay})` : ''}`);
        return res.status(201).json({ success: true, message: `${REPORT_TYPE_NAMES[reportType]} report sent to the Municipal Tourism Office.`, report });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Guide report failure:');
    }
});

/* ---- The office's side ----------------------------------------------------
   The fixed paths (search, reports) come before /:id. */

app.get('/api/guides', requireAdmin, async (req, res) => {
    try {
        const guides = await TouristGuide.listWithSpots();
        return res.status(200).json(guides);
    } catch (error) {
        console.error('❌ Guide list failure:', error);
        return res.status(500).json([]);
    }
});

/**
 * GET: "who speaks Korean and is free on Saturday the 12th?" Every guide who
 * speaks the language (every guide, when no language is given), each marked
 * free or not on the date with the reason — decided by isGuideFreeOn, the same
 * rule assignment enforces. Optionally only guides who serve one destination.
 */
app.get('/api/guides/search', requireAdmin, async (req, res) => {
    try {
        const language = String(req.query.language || '').trim();
        const date = String(req.query.date || '').trim();
        const time = String(req.query.time || '').trim();
        if (date && !isCalendarDate(date)) return res.status(400).json({ success: false, message: 'That date is not valid.' });
        if (time && !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ success: false, message: 'That time is not valid.' });

        let guides = language ? await findGuidesSpeaking(language) : await TouristGuide.listWithSpots();
        if (db.isId(req.query.spotId)) guides = guides.filter(g => (g.assignedSpots || []).map(s => String(s._id || s)).includes(String(req.query.spotId)));

        const results = [];
        for (const guide of guides) {
            const verdict = date ? await isGuideFreeOn(guide, date, { time: time || undefined }) : { free: guide.status === 'available' };
            results.push({
                _id: guide._id,
                fullName: guide.fullName,
                contactNumber: guide.contactNumber,
                scope: guide.scope,
                barangay: guide.barangay,
                status: guide.status,
                languages: guide.languages,
                availableDays: guide.availableDays,
                guideFee: guide.guideFee,
                maxGroupSize: guide.maxGroupSize,
                free: verdict.free,
                reason: verdict.reason || ''
            });
        }
        results.sort((a, b) => Number(b.free) - Number(a.free) || a.fullName.localeCompare(b.fullName));
        return res.status(200).json({ success: true, language, date, results });
    } catch (error) {
        console.error('❌ Guide search failure:', error);
        return res.status(500).json({ success: false, message: 'Could not search the guides just now.' });
    }
});

/**
 * GET: every report guides have filed, and the per-barangay rollup — which
 * barangays are actually getting visitors, as the guides on the ground report
 * it. Filter by ?barangay= (use "none" for reports tied to no barangay),
 * ?type=, ?status=.
 */
app.get('/api/guides/reports', requireAdmin, async (req, res) => {
    try {
        const filters = {};
        if (req.query.barangay === 'none') filters.barangay = '';
        else if (req.query.barangay) filters.barangay = officialBarangay(req.query.barangay) || String(req.query.barangay);
        if (GUIDE_REPORT_TYPES.includes(req.query.type)) filters.reportType = req.query.type;
        if (['new', 'reviewed'].includes(req.query.status)) filters.status = req.query.status;

        const [list, all] = await Promise.all([
            GuideReport.listForOffice(filters),
            Object.keys(filters).length ? GuideReport.listForOffice({}) : null
        ]);
        const everything = all || list;

        // One row per barangay, every barangay listed even at zero — a barangay
        // no guide has reported from is itself worth seeing.
        const byBarangay = BARANGAYS.concat('').map(name => {
            const here = everything.filter(r => barangayKey(r.barangay) === barangayKey(name));
            const counted = here.filter(r => ['tour_completed', 'headcount'].includes(r.reportType));
            return {
                barangay: name,
                reports: here.length,
                toursCompleted: here.filter(r => r.reportType === 'tour_completed').length,
                visitorsCounted: counted.reduce((sum, r) => sum + (r.headcount || 0), 0),
                incidents: here.filter(r => r.reportType === 'incident').length,
                feedback: here.filter(r => r.reportType === 'tourist_feedback').length,
                unreviewed: here.filter(r => r.status === 'new').length
            };
        });

        return res.status(200).json({ success: true, reports: list, byBarangay, barangays: BARANGAYS });
    } catch (error) {
        console.error('❌ Guide report list failure:', error);
        return res.status(500).json({ success: false, message: 'Could not read the guide reports.' });
    }
});

app.patch('/api/guides/reports/:id', requireAdmin, async (req, res) => {
    try {
        const report = await GuideReport.findById(req.params.id);
        if (!report) return res.status(404).json({ success: false, message: 'That report no longer exists.' });
        if (!['new', 'reviewed'].includes(req.body.status)) {
            return res.status(400).json({ success: false, message: 'Mark it new or reviewed.' });
        }
        const officer = await TourismOfficer.findById(req.auth.sub);
        report.status = req.body.status;
        report.reviewedByEmail = req.body.status === 'reviewed' && officer ? officer.email : '';
        report.reviewedAt = req.body.status === 'reviewed' ? new Date() : null;
        await GuideReport.save(report);
        return res.status(200).json({ success: true, message: req.body.status === 'reviewed' ? 'Marked reviewed.' : 'Marked new.', report });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Guide report review failure:');
    }
});

/* Languages are set by the office as a list on create and edit, written to
   the join table after the record itself. */
async function saveOfficeLanguages(guide, body) {
    if (body.languages === undefined) return;
    guide.languages = await setGuideLanguages(guide._id, cleanLanguages(body.languages));
}

app.post('/api/guides', requireAdmin, async (req, res) => {
    try {
        const draft = applyGuideDetails({}, req.body);
        const languages = req.body.languages === undefined ? undefined : cleanLanguages(req.body.languages);
        await checkGuideScope(draft);
        const guide = await TouristGuide.create(draft);
        await saveOfficeLanguages(guide, { languages });
        console.log(`🧭 Officer added ${guide.scope} guide ${guide.fullName}`);
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
        const languages = req.body.languages === undefined ? undefined : cleanLanguages(req.body.languages);
        await checkGuideScope(guide);
        await TouristGuide.save(guide);
        await saveOfficeLanguages(guide, { languages });
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
        await TouristGuide.save(guide);
        return res.status(200).json({ success: true, message: `${guide.fullName} is now ${guide.status}.`, guide });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Guide status failure:');
    }
});

/**
 * POST: the officer issues a guide a sign-in for the guide portal, or changes
 * its email, or issues a new password for a guide who is locked out — the same
 * route for all three, since each is "this is how they sign in now".
 *
 * A password is generated when none is given and returned once so the officer
 * can pass it on; only its hash is stored. Changing only the email keeps the
 * existing password.
 */
app.post('/api/guides/:id/account', requireAdmin, async (req, res) => {
    try {
        const guide = await TouristGuide.findById(req.params.id, { secrets: true });
        if (!guide) return res.status(404).json({ success: false, message: 'That guide record no longer exists.' });

        const email = String(req.body.email || guide.email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, message: 'Give the email the guide will sign in with.' });
        }
        const takenBy = await emailTakenBy(email, { guideId: guide._id });
        if (takenBy) {
            return res.status(409).json({ success: false, message: `That email already signs in as ${takenBy}.` });
        }

        const typed = String(req.body.newPassword || '').trim();
        // A new sign-in always needs a password; an existing one gets a new
        // password only when one is typed or asked for.
        const issuePassword = !guide.password || typed || req.body.resetPassword === true;
        const newPassword = issuePassword ? (typed || crypto.randomBytes(6).toString('base64url')) : null;
        if (newPassword && newPassword.length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ success: false, message: `A password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        }

        const firstIssue = !guide.password;
        guide.email = email;
        if (newPassword) {
            guide.password = await bcrypt.hash(newPassword, 12);
            guide.resetTokenHash = null;
            guide.resetTokenExpires = null;
        }
        await TouristGuide.save(guide);

        console.log(`🔑 Officer ${firstIssue ? 'issued' : 'updated'} the guide sign-in for ${guide.fullName} (${email})`);
        return res.status(200).json({
            success: true,
            message: newPassword
                ? `${guide.fullName} can now sign in as ${email}. Pass the password on — it cannot be read again.`
                : `${guide.fullName} now signs in as ${email}. Their password is unchanged.`,
            email,
            newPassword
        });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Guide sign-in issue failure:');
    }
});

/**
 * DELETE: withdraw a guide's sign-in. The guide record, its bookings, reports
 * and history all stay; only the way into the portal goes.
 */
app.delete('/api/guides/:id/account', requireAdmin, async (req, res) => {
    try {
        const guide = await TouristGuide.findById(req.params.id, { secrets: true });
        if (!guide) return res.status(404).json({ success: false, message: 'That guide record no longer exists.' });

        guide.email = null;
        guide.password = null;
        guide.resetTokenHash = null;
        guide.resetTokenExpires = null;
        await TouristGuide.save(guide);

        console.log(`🔒 Officer withdrew the guide sign-in for ${guide.fullName}`);
        return res.status(200).json({ success: true, message: `${guide.fullName} can no longer sign in. Their record is kept.` });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Guide sign-in withdraw failure:');
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
        const spot = await Spot.findById(req.params.id);
        if (!spot) return res.status(404).json({ success: false, message: 'Spot not found.' });

        if (!spot.requiresGuide) {
            return res.status(200).json({ success: true, requiresGuide: false });
        }

        const guides = await TouristGuide.find({ assignedSpots: spot._id, status: 'available' });

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
            payment: paymentWays(),
            payOnline: paymentsGatewayOnline(),
            ...(await require('./attractions').visitCalendar(spot, 400))
        });
    } catch (error) {
        console.error('❌ Guide requirement failure:', error);
        return res.status(500).json({ success: false, message: 'Could not read the guide requirement.' });
    }
});

// A barangay guide only serves destinations in their barangay; checked again
// wherever a guide meets a destination, since a listing's barangay can change.
function guideServesSpot(guide, spot) {
    if (!(guide.assignedSpots || []).some(id => String(id._id || id) === String(spot._id))) return false;
    return guide.scope !== 'barangay' || barangayKey(spot.barangay) === barangayKey(guide.barangay);
}

const pesos = n => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Emails to visitors (notices.js): links in them point at the public site.
const notices = require('./notices');
const originOf = req => `${req.protocol}://${req.get('host')}`;

/**
 * PUBLIC: the guides a visitor can ask for at this destination — photo, name,
 * languages, fee, bio, largest group, the area they cover — and, for a chosen
 * date (and time), whether each is free, by isGuideFreeOn, the rule the
 * office's assignment uses. Never a phone number or an email, and never which
 * booking makes a guide busy.
 */
app.get('/api/spots/:id/guides', async (req, res) => {
    try {
        const spot = await Spot.findByIdWithManager(req.params.id);
        if (!spot || !spot.requiresGuide || !isPubliclyVisible(spot)) {
            return res.status(404).json({ success: false, message: 'No guides are listed for this destination.' });
        }
        const date = isCalendarDate(String(req.query.date || '')) ? String(req.query.date) : null;
        const time = /^\d{2}:\d{2}$/.test(String(req.query.time || '')) ? String(req.query.time) : undefined;

        const here = (await TouristGuide.listWithSpots())
            .filter(g => g.status === 'available' && guideServesSpot(g, spot));
        const guides = [];
        for (const g of here) {
            let free = null, note = '';
            if (date) {
                const verdict = await isGuideFreeOn(g, date, { time });
                free = verdict.free;
                if (!free) note = /does not work on/.test(verdict.reason || '')
                    ? `Does not guide on ${WEEKDAY_NAMES[weekdayOf(date)]}s`
                    : 'Not free that day';
            }
            guides.push({
                _id: g._id, fullName: g.fullName, photoUrl: g.photoUrl || '', languages: g.languages || [],
                guideFee: Number(g.guideFee) || 0, maxGroupSize: g.maxGroupSize, bio: g.bio || '',
                area: g.scope === 'barangay' ? `Barangay ${g.barangay}` : 'Whole municipality',
                free, note
            });
        }
        guides.sort((a, b) => a.guideFee - b.guideFee || a.fullName.localeCompare(b.fullName));
        return res.status(200).json({ success: true, date, guides });
    } catch (error) {
        console.error('❌ Public guide list failure:', error);
        return res.status(500).json({ success: false, message: 'Could not list the guides just now.' });
    }
});

/* ==========================================
   4c. GUIDE BOOKINGS AND ONSITE PAYMENT
   ------------------------------------------
   A visitor submits a request without any account, gets a reference, and pays
   either at the Municipal Tourism Office, where the officer records it here, or
   online through payments.js — a demonstration in the payment gateway's test
   mode, which confirms the booking the same way. Then the office assigns a guide.

   A counter payment is the record of cash that changed hands at a desk; an
   online one carries the gateway's reference and is marked as test-mode demo.
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
    const latest = await GuideBooking.latestReference(prefix);

    const previous = latest ? Number(String(latest).slice(prefix.length)) : 0;
    return prefix + String((Number.isFinite(previous) ? previous : 0) + 1).padStart(5, '0');
}

// How a visitor may pay, as the pages say it. Online only while the gateway is
// configured with a test key (see payments.js).
function paymentsGatewayOnline() {
    return require('./payments').gatewayState().online;
}
function paymentWays() {
    return paymentsGatewayOnline()
        ? 'Online (test mode), or at the Municipal Tourism Office'
        : 'Onsite at the Municipal Tourism Office';
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
        payment: paymentWays()
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

        const spot = await Spot.findByIdWithManager(body.spotId);
        if (!spot) return res.status(404).json({ success: false, message: 'That destination could not be found.' });
        const day = await require('./attractions').dayVerdict(spot, preferredDate);
        if (!day.open) return res.status(409).json({ success: false, message: day.reason });
        if (!spot.requiresGuide) {
            return res.status(400).json({ success: false, message: 'This destination does not require a tourist guide, so there is nothing to book.' });
        }
        if (!isPubliclyVisible(spot)) {
            return res.status(404).json({ success: false, message: 'This destination is not open for visits right now.' });
        }

        // A group larger than any available guide can take would be accepted and
        // then refused at the counter, so it is refused here instead.
        const guides = await TouristGuide.find({ assignedSpots: spot._id, status: 'available' });
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

        // The guide the visitor asked for, if any: one who guides here, takes a
        // group this size, and is free then. Still only a request — the office
        // confirms the guide.
        let requested = null;
        const wantedGuide = String(body.requestedGuideId || '').trim();
        if (wantedGuide) {
            requested = guides.find(g => String(g._id) === wantedGuide && guideServesSpot(g, spot)) || null;
            if (!requested) {
                return res.status(409).json({ success: false, message: 'That guide is not available for this destination. Choose another guide, or "Any guide".' });
            }
            if (visitors > requested.maxGroupSize) {
                return res.status(400).json({ success: false, message: `${requested.fullName} takes groups of up to ${requested.maxGroupSize}. Choose another guide, or "Any guide".` });
            }
            const verdict = await isGuideFreeOn(requested, preferredDate, { time: preferredTime });
            if (!verdict.free) {
                return res.status(409).json({ success: false, message: `${requested.fullName} is not free then. Choose another date or guide, or "Any guide".` });
            }
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
                    notes: String(body.notes || '').trim().slice(0, 1000),
                    requestedGuideId: requested ? requested._id : null
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
        await notices.bookingReceived(booking._id, originOf(req), { payOnline: paymentsGatewayOnline() });
        return res.status(201).json({
            success: true,
            message: 'Booking submitted.',
            booking: publicBookingView(booking, spot.title),
            requestedGuide: requested ? { fullName: requested.fullName, guideFee: Number(requested.guideFee) || 0 } : null,
            instruction: paymentsGatewayOnline()
                ? 'Pay online now, or at the Municipal Tourism Office, to confirm the booking.'
                : 'Please proceed to the Municipal Tourism Office to complete payment and confirmation.',
            payOnline: paymentsGatewayOnline()
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
        const booking = await GuideBooking.findByReferenceWithSpot(reference);
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

/* Visitors' personal details are erased a year after the visit (privacy.js).
   Vercel's cron calls this daily with CRON_SECRET; without it the route does
   not exist. The officer opening Guide Bookings runs it too (below). */
app.get('/api/maintenance/privacy', async (req, res) => {
    const secret = String(process.env.CRON_SECRET || '');
    const given = String(req.get('authorization') || '');
    const wanted = `Bearer ${secret}`;
    const matches = secret && given.length === wanted.length
        && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(wanted));
    if (!matches) return res.status(404).end();
    try {
        return res.json({ success: true, erased: await forgetOldVisitors() });
    } catch (error) {
        console.error('❌ Privacy clean-up failure:', error);
        return res.status(500).json({ success: false });
    }
});

app.get('/api/guide-bookings', requireAdmin, async (req, res) => {
    try {
        // Old visitors' details go before the office reads the list.
        await forgetOldVisitors().catch(error => console.error('❌ Privacy clean-up failure:', error));
        const query = {};
        if (BOOKING_STATUSES.includes(req.query.status)) query.status = req.query.status;

        const bookings = await GuideBooking.listForOffice(query, { limit: 500 });

        // The payment belongs to a separate record, so it is fetched alongside
        // rather than duplicated onto the booking.
        const payments = await Payment.find({ bookingId: { in: bookings.map(b => b._id) } });
        const byBooking = new Map(payments.map(p => [String(p.bookingId), p]));

        return res.status(200).json(bookings.map(booking => ({
            ...booking,
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
            await GuideBooking.save(booking);
            return res.status(200).json({ success: true, message: 'Guide unassigned.', booking });
        }

        const guide = await TouristGuide.findById(req.body.guideId);
        if (!guide) return res.status(404).json({ success: false, message: 'That guide record no longer exists.' });
        if (!guide.assignedSpots.some(id => String(id) === String(booking.spotId))) {
            return res.status(409).json({ success: false, message: `${guide.fullName} is not assigned to this destination.` });
        }
        // The scope, checked again here: a destination's barangay can change
        // after the guide was given it.
        if (guide.scope === 'barangay') {
            const spot = await Spot.findById(booking.spotId);
            if (!spot || barangayKey(spot.barangay) !== barangayKey(guide.barangay)) {
                return res.status(409).json({
                    success: false,
                    message: `${guide.fullName} is a barangay guide for ${guide.barangay}, and this destination is not in ${guide.barangay}.`
                });
            }
        }
        if (booking.visitors > guide.maxGroupSize) {
            return res.status(409).json({
                success: false,
                message: `This booking is for ${booking.visitors} visitors and ${guide.fullName} takes at most ${guide.maxGroupSize}.`
            });
        }
        // Status, working days and clashes: the same rule the office's
        // guide search uses, so a guide it shows as free is one this accepts.
        const verdict = await isGuideFreeOn(guide, booking.preferredDate, { time: booking.preferredTime, exceptBookingId: booking._id });
        if (!verdict.free) return res.status(409).json({ success: false, message: verdict.reason });
        // A paid booking keeps its price: only a guide at or below what was paid.
        const paid = await Payment.findOne({ bookingId: booking._id });
        if (paid && !paid.refundedAt && Number(guide.guideFee) > Number(paid.amount)) {
            return res.status(409).json({
                success: false,
                message: `This booking was paid ${pesos(paid.amount)}, and ${guide.fullName} charges ${pesos(guide.guideFee)}. Choose a guide at or below what was paid.`
            });
        }

        booking.guideId = guide._id;
        await GuideBooking.save(booking);

        const sameDay = await GuideBooking.find({
            _id: { ne: booking._id },
            guideId: guide._id,
            status: 'confirmed',
            preferredDate: booking.preferredDate
        });

        console.log(`🧭 ${guide.fullName} assigned to ${booking.reference}`);
        await notices.guideAssigned(booking._id, originOf(req));
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
        const booking = await GuideBooking.findById(req.params.id);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        // The reply names the assigned guide, as it always has.
        if (booking.guideId) {
            const assigned = await TouristGuide.findById(booking.guideId);
            booking.guideId = assigned ? { _id: assigned._id, fullName: assigned.fullName } : booking.guideId;
        }
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
        const officer = await TourismOfficer.findById(req.auth.sub);

        // The payment and the confirmation it causes are one event: both are
        // recorded, or neither is. MongoDB could leave a payment against an
        // unconfirmed booking if the second write failed.
        const payment = await db.transaction(async client => {
            const recorded = await Payment.create({
                bookingId: booking._id,
                amount,
                method: String(req.body.method || 'cash').trim() || 'cash',
                receiptNumber: String(req.body.receiptNumber || '').trim(),
                paidAt: req.body.paidAt ? new Date(req.body.paidAt) : new Date(),
                recordedByEmail: officer ? officer.email : '',
                remarks: String(req.body.remarks || '').trim().slice(0, 500)
            }, { client });

            booking.status = 'confirmed';
            booking.statusUpdatedAt = new Date();
            await GuideBooking.save(booking, { client });
            return recorded;
        });

        console.log(`💵 Payment recorded for ${booking.reference} by ${payment.recordedByEmail || req.auth.sub}`);
        await notices.bookingPaid(booking._id, originOf(req));
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
        // 'closed' comes only from closing a date, which also tells the visitor.
        if (!BOOKING_STATUSES.includes(status) || status === 'closed') {
            return res.status(400).json({ success: false, message: 'That is not a booking status ZTIMS uses.' });
        }

        const booking = await GuideBooking.findById(req.params.id);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });

        // Money taken online goes back when the office cancels, through the
        // refund route, which cancels the booking as it refunds. Cancelling here
        // would keep the money and drop the booking.
        if (status === 'cancelled') {
            const paid = await Payment.findOne({ bookingId: booking._id });
            if (paid && paid.channel === 'online' && !paid.refundedAt) {
                return res.status(409).json({
                    success: false,
                    message: 'This booking was paid online. Use "Cancel and refund" so the visitor gets the money back.',
                    refundPaymentId: paid._id
                });
            }
        }

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
        await GuideBooking.save(booking);

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

        const items = await Feedback.find(query, { sort: { createdAt: -1 }, limit: 500 });
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

        const officer = await TourismOfficer.findById(req.auth.sub);
        feedback.status = status;
        feedback.statusUpdatedAt = new Date();
        feedback.statusUpdatedByEmail = officer ? officer.email : '';
        await Feedback.save(feedback);

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
   TOURISM STATISTICS — Form A4 and attraction visitors (statistics.js)
========================================== */
app.use('/api/statistics', require('./statistics')({ requireAdmin, requireStaff }));

/* ==========================================
   ONLINE PAYMENTS — a demonstration in the gateway's test mode (payments.js)
========================================== */
const paymentsModule = require('./payments');
app.use('/api', paymentsModule({ requireAdmin, sharedRateLimit, isPubliclyVisible }));

/* ==========================================
   ATTRACTION SETUP — opening days, closed dates, prices per kind of visitor,
   and the share kept on a cancellation (attractions.js)
========================================== */
const attractions = require('./attractions');
app.use('/api', attractions({ requireAdmin }));

/* ==========================================
   MANAGE MY TICKET / BOOKING — a visitor moves or cancels with the code and
   the email it was bought with (manage.js)
========================================== */
app.use('/api', require('./manage')({ sharedRateLimit, refund: paymentsModule.refund, siteOrigin: paymentsModule.siteOrigin }));

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
    // Host and database name only — the URL's password is never printed.
    console.log(process.env.DATABASE_URL
        ? ` 🗄️  Database: ${db.describeDatabase()}${process.env.DATABASE_CA_CERT ? ' (certificate verified)' : ''}`
        : ` 🗄️  Database: DATABASE_URL is not set — using ${db.describeDatabase()}, which only exists on a developer's machine.`);
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
module.exports.closeDatabase = db.closePool;
