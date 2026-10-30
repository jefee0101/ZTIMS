const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
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
    payments: Payment,
    feedback: Feedback,
    MAX_SPOT_IMAGES,
    FEEDBACK_TOPICS, FEEDBACK_STATUSES, FEEDBACK_MESSAGE_MAX
} = require('./models');
const { forgetOldVisitors } = require('./privacy');
const { passwordProblem, generatePassword } = require('./passwords');
const mailer = require('./mailer');

const app = express();

/* ==========================================
   1. MIDDLEWARE PIPELINES
========================================== */
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://127.0.0.1:5500,http://localhost:5500')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

// Vercel gives every branch and every redeploy its own hostname, and tells the
// running deployment which ones are its own. Those are trusted by name — never
// "any *.vercel.app", which would trust every site anyone else hosts there.
// A page normally calls the API on its own origin anyway (isSameOrigin below).
for (const host of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]) {
    if (host) allowedOrigins.push(`https://${host}`);
}

const isAllowedOrigin = (origin) => allowedOrigins.includes(origin);

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
    const weak = passwordProblem(password, { email });
    if (weak) {
        // Refused rather than trimmed to a warning: this account can edit every
        // listing in the municipality.
        console.warn(`⚠️  INITIAL_ADMIN_PASSWORD will not do (${weak}) — no account was created or changed.`);
        return;
    }

    try {
        const existing = await TourismOfficer.findOne({ email }, { secrets: true });

        if (!existing) {
            const created = await TourismOfficer.create({ email, password: await bcrypt.hash(password, 12) });
            // The password sits in the environment, so it is replaced at first sign-in.
            await db.query('update tourism_officers set must_change_password = true where id = $1', [created._id]);
            console.log(`🛡️  Tourism Officer account created for ${email}.`);
            console.log('    Sign in, then REMOVE INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD.');
            return;
        }

        if (forceReset) {
            // Also voids an emailed reset link still in flight, ends every open
            // sign-in, and asks for the officer's own password at the next one.
            await storePassword('admin', existing._id, password, { issued: true });
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

// Every token is checked the same way: signature, issuer and audience, then the
// account itself. HS256 is named so a token can never choose its own algorithm.
const TOKEN_CHECK = { algorithms: ['HS256'], issuer: 'ztims-api', audience: 'ztims-web' };

// The table behind each role a token can carry ('resort_owner': see MANAGER_ROLES).
const ACCOUNT_TABLES = {
    admin: 'tourism_officers',
    establishment_manager: 'establishment_managers',
    resort_owner: 'establishment_managers'
};

const bearerToken = req => {
    const authorization = req.get('authorization') || '';
    return authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
};

/* The account a token names, as stored now, or null. `select *` on purpose: a
   database that has not yet been given session_version / must_change_password
   still signs people in (they read as 0 and false) until schema.sql is re-run. */
async function accountBehind(claims) {
    const table = ACCOUNT_TABLES[claims && claims.role];
    if (!table || !claims.sub) return null;
    const { rows } = await db.query(`select * from ${table} where id = $1`, [String(claims.sub)]);
    return rows[0] || null;
}

const sessionVersionOf = row => Number((row && row.session_version) || 0);

/* Ends every sign-in this account has open, everywhere: their tokens carry the
   old number and are refused from the next request on. */
async function endSessions(role, id, client) {
    const table = ACCOUNT_TABLES[role];
    const { rows } = await db.query(
        `update ${table} set session_version = session_version + 1 where id = $1 returning session_version`,
        [String(id)], client);
    return rows[0] ? Number(rows[0].session_version) : 0;
}

/* requireAuth: a valid token, for an account that still exists, from a sign-in
   that has not been ended since (a password change, or "Sign out of all
   devices"). An account whose password was chosen by someone else may do one
   thing only — set its own — so every other route refuses it until it has. */
const checkSignIn = ({ allowPasswordChangeOnly = false } = {}) => async (req, res, next) => {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Authentication required.' });

    let claims;
    try {
        claims = jwt.verify(token, process.env.JWT_SECRET, TOKEN_CHECK);
    } catch {
        return res.status(401).json({ success: false, message: 'Invalid or expired session.' });
    }
    try {
        const account = await accountBehind(claims);
        if (!account) return res.status(401).json({ success: false, message: 'Invalid or expired session.' });
        if (sessionVersionOf(account) !== Number(claims.sv || 0)) {
            return res.status(401).json({ success: false, code: 'SESSION_ENDED', message: 'You have been signed out. Please sign in again.' });
        }
        if (account.must_change_password && !allowPasswordChangeOnly) {
            return res.status(401).json({ success: false, code: 'PASSWORD_CHANGE_REQUIRED', message: 'Set your own password first. Please sign in again.' });
        }
        req.auth = claims;
        req.account = account;
        return next();
    } catch (error) {
        console.error('❌ Sign-in check failure:', error && error.message);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

const requireAuth = checkSignIn();
// Only for setting one's own password, which an issued password must do first.
const requireSignedInForPasswordChange = checkSignIn({ allowPasswordChangeOnly: true });

// An officer is also checked for being active, so one the office has
// deactivated stops working at once rather than when the token expires.
const requireAdmin = [requireAuth, (req, res, next) => {
    if (req.auth.role !== 'admin') return res.status(403).json({ success: false, message: 'Tourist Officer access required.' });
    if (req.account.active === false) {
        return res.status(401).json({ success: false, message: 'This account has been deactivated by the Municipal Tourism Office.' });
    }
    return next();
}];

/* Risky actions — a refund, adding or deactivating an officer, issuing someone a
   password, removing demo data — ask for the officer's own password again, so a
   computer left signed in cannot be used for them in a few seconds. Goes after
   requireAdmin. Wrong passwords are limited per account, so a borrowed session
   cannot be used to guess it. */
const confirmRateLimit = sharedRateLimit('confirm', {
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    keyGenerator: req => `${req.auth.role}:${req.auth.sub}`,
    message: { success: false, message: 'Too many wrong passwords. Please wait a few minutes and try again.' }
});
const requirePasswordConfirmation = [confirmRateLimit, async (req, res, next) => {
    const typed = String((req.body || {}).confirmPassword || '');
    if (!typed) {
        return res.status(428).json({ success: false, code: 'CONFIRM_PASSWORD', message: 'Enter your password to confirm.' });
    }
    const hash = req.account && req.account.password_hash;
    if (!hash || !(await bcrypt.compare(typed, hash))) {
        return res.status(403).json({ success: false, code: 'CONFIRM_PASSWORD', message: 'That password is not right.' });
    }
    delete req.body.confirmPassword;
    return next();
}];

// ZTIMS has two kinds of account: Tourism Officer ('admin') and Enterprise
// Manager. 'resort_owner' is not a third — it is the spelling the
// manager account carried in tokens issued before the rename, kept here only so
// a session signed in back then is not thrown out mid-visit. Nothing issues it
// any more.
const MANAGER_ROLES = ['establishment_manager', 'resort_owner'];
const isEstablishmentManager = role => MANAGER_ROLES.includes(role);

const requireEstablishmentManager = [requireAuth, (req, res, next) => {
    if (!isEstablishmentManager(req.auth.role)) {
        return res.status(403).json({ success: false, message: 'Tourist Enterprise Manager access required.' });
    }
    return next();
}];


// Tourist Officer or Tourist Enterprise Manager — used on routes both manage,
// each scoped to their own data.
const requireStaff = [requireAuth, (req, res, next) => {
    if (req.auth.role !== 'admin' && !isEstablishmentManager(req.auth.role)) {
        return res.status(403).json({ success: false, message: 'Staff access required.' });
    }
    return next();
}];

// Attaches req.auth when a current, usable sign-in comes with the request;
// anything less is simply treated as a visitor.
const optionalAuth = async (req, res, next) => {
    const token = bearerToken(req);
    if (token) {
        try {
            const claims = jwt.verify(token, process.env.JWT_SECRET, TOKEN_CHECK);
            const account = await accountBehind(claims);
            if (account && sessionVersionOf(account) === Number(claims.sv || 0) && !account.must_change_password
                && !(claims.role === 'admin' && account.active === false)) {
                req.auth = claims;
            }
        } catch { /* Public access remains available. */ }
    }
    return next();
};

// `sv`: the account's session_version when this sign-in began (see endSessions).
const createToken = (account, role, sessionVersion) => jwt.sign(
    { sub: account._id.toString(), role, sv: Number(sessionVersion || 0) },
    process.env.JWT_SECRET,
    { expiresIn: '2h', issuer: 'ztims-api', audience: 'ztims-web' }
);


/**
 * Which kind of account already signs in with this email, or null.
 *
 * The staff sign-in page does not ask which kind of account someone has; the
 * login route searches officers, then managers, and takes the
 * first match. Two accounts sharing an email would leave the later one unable
 * to ever sign in, so every place that issues or changes a sign-in email asks
 * this first. `except` is the record being edited, which may keep its own.
 */
async function emailTakenBy(email, except = {}) {
    const officer = await TourismOfficer.findOne({ email });
    if (officer && String(officer._id) !== String(except.officerId)) return 'a Tourism Officer';
    const manager = await EstablishmentManager.findOne({ email });
    if (manager && String(manager._id) !== String(except.managerId)) return 'an enterprise manager';
    return null;
}

const RESET_TOKEN_TTL_MINUTES = 30;

// A real bcrypt hash of a password nobody has, compared against when an email
// matches no account, so a wrong email takes as long to refuse as a wrong password.
const NO_ACCOUNT_HASH = '$2b$12$YDOAyLYTMrO2s/ukI0DbX.sdGfqiRJV7V1d8hHW1n8EmTyCD533Ie';

/* Sets an account's password, and with it ends every sign-in the account has
   open (see endSessions) and voids any reset link in flight. `issued`: someone
   else chose it — an officer passing it on — so its owner must replace it at
   their next sign-in. Returns the new session version, for a fresh token. */
async function storePassword(role, id, plainPassword, { issued }) {
    const hash = await bcrypt.hash(plainPassword, 12);
    const { rows } = await db.query(
        `update ${ACCOUNT_TABLES[role]}
            set password_hash = $2, reset_token_hash = null, reset_token_expires = null,
                must_change_password = $3, session_version = session_version + 1
          where id = $1
      returning session_version`,
        [String(id), hash, Boolean(issued)]);
    return rows[0] ? Number(rows[0].session_version) : 0;
}

/* Tells an account's owner that something about their sign-in changed, so a
   change they did not make does not go unnoticed. Never blocks the change. */
function alertAccountOwner(to, heading, intro, paragraphs = []) {
    const when = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'long', timeStyle: 'short' });
    const { text, html } = mailer.compose({
        heading,
        intro,
        rows: [['When', when + ' (Philippine time)']],
        paragraphs: [...paragraphs, 'If this was not you or your office, contact the Municipal Tourism Office at once.'],
        footer: 'Municipal Tourism Office, Zamboanguita, Negros Oriental. A security notice about your ZTIMS staff account.'
    });
    return mailer.sendMail({ to, subject: `ZTIMS: ${heading}`, text, html });
}

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

// Changing one's own password: wrong current passwords are counted per account,
// so a borrowed signed-in browser cannot be used to guess it.
const ownPasswordRateLimit = sharedRateLimit('own-password', {
    windowMs: 15 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: true,
    keyGenerator: req => `${req.auth.role}:${req.auth.sub}`,
    message: { success: false, message: 'Too many attempts. Please wait a few minutes and try again.' }
});

/* ==========================================
   4. API ROUTE HANDLERS
========================================== */

/* ---- Any signed-in account: its own password and its own sign-ins ----------- */

/* Changes the signed-in person's own password: the current one proves it is
   them, not a borrowed browser. Every other device signed in to the account is
   signed out; this one carries on with the fresh token sent back. Used by each
   portal's change-password form and by the sign-in page when an issued
   password has to be replaced. */
async function changeOwnPassword(req, res) {
    try {
        const { currentPassword, newPassword } = req.body || {};
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'Your current and new passwords are both required.' });
        }
        const account = req.account;
        if (!account.password_hash || !(await bcrypt.compare(String(currentPassword), account.password_hash))) {
            return res.status(400).json({ success: false, message: 'That current password is not right.' });
        }
        if (String(newPassword) === String(currentPassword)) {
            return res.status(400).json({ success: false, message: 'Choose a password different from the current one.' });
        }
        const weak = passwordProblem(String(newPassword), { email: account.email });
        if (weak) return res.status(400).json({ success: false, message: weak });

        const role = isEstablishmentManager(req.auth.role) ? 'establishment_manager' : req.auth.role;
        const sessionVersion = await storePassword(role, account.id, String(newPassword), { issued: false });

        console.log(`🔑 ${role} changed their own password: ${account.email}`);
        await alertAccountOwner(account.email, 'Your password was changed',
            'The password of your ZTIMS account was changed. Every other device signed in to it has been signed out.');
        return res.status(200).json({
            success: true,
            message: 'Your password has been changed. Any other device signed in to your account has been signed out.',
            token: createToken({ _id: account.id }, role, sessionVersion)
        });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Password change failure:');
    }
}

// The sign-in page's "choose your own password" step, for any kind of account,
// including one whose password was issued and must be replaced first.
app.post('/api/me/password', requireSignedInForPasswordChange, ownPasswordRateLimit, changeOwnPassword);

// "Sign out of all devices": every sign-in of this account ends, this one too.
app.post('/api/me/sign-out-everywhere', requireAuth, async (req, res) => {
    try {
        await endSessions(req.auth.role, req.auth.sub);
        console.log(`🔒 ${req.auth.role} signed out of all devices: ${req.account.email}`);
        return res.status(200).json({ success: true, message: 'Every device signed in to your account has been signed out.' });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Sign out everywhere failure:');
    }
});

/**
 * 🌟 POST: Add a new Tourism Officer account
 * Target URL: http://localhost:5000/api/admin/create
 */
app.post('/api/admin/create', requireAdmin, requirePasswordConfirmation, async (req, res) => {
    try {
        const { email } = req.body;
        const fullName = String(req.body.fullName || '').trim();
        const position = String(req.body.position || '').trim();
        // Blank asks for one to be generated, as for managers.
        const password = String(req.body.password || '').trim() || generatePassword();

        if (!email || !fullName) {
            return res.status(400).json({ success: false, message: "The officer's full name and email address are required." });
        }
        if (fullName.length > 120 || position.length > 120) {
            return res.status(400).json({ success: false, message: 'Name and position are limited to 120 characters.' });
        }
        const normalizedEmail = email.toLowerCase().trim();
        const weak = passwordProblem(password, { email: normalizedEmail });
        if (weak) return res.status(400).json({ success: false, message: weak });

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
        const created = await TourismOfficer.create({
            email: normalizedEmail,
            password: passwordHash,
            fullName, position
        });
        // Chosen by someone else: its owner sets their own at first sign-in.
        await db.query('update tourism_officers set must_change_password = true where id = $1', [created._id]);

        console.log(`🛡️ New Tourism Officer account created: ${normalizedEmail}`);
        // Every active officer hears of a new officer account, so one added
        // without the office knowing does not go unnoticed.
        const addedBy = (req.account && req.account.email) || 'another officer';
        const { rows: colleagues } = await db.query('select email from tourism_officers where active and id <> $1', [created._id]);
        await Promise.all(colleagues.map(({ email: to }) => alertAccountOwner(to,
            'A new officer account was added',
            `A Tourism Officer account for ${fullName} (${normalizedEmail}) was added by ${addedBy}.`)));
        // The password is returned once so it can be passed on; only its hash is kept.
        return res.status(201).json({ success: true, message: 'Officer account created.', email: normalizedEmail, newPassword: password });
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
        return res.status(200).json(adminList.map(a => ({ ...a, isYou: String(a._id) === String(req.auth.sub) })));
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
 * credentials that are not configured. Enterprise managers have had
 * /api/establishment-managers/me/password all along; this is the same thing for
 * the account that oversees them, and deliberately mirrors it.
 *
 * The current password is required, and checked, for the same reason it is
 * there: an unattended signed-in browser must not be enough to lock the real
 * officer out of the account that administers the whole system.
 */
app.post('/api/admin/me/password', requireAdmin, ownPasswordRateLimit, changeOwnPassword);

/* The signed-in officer's own record (Settings → My Account). */
app.get('/api/admin/me', requireAdmin, async (req, res) => {
    try {
        const me = await TourismOfficer.findById(req.auth.sub);
        if (!me) return res.status(404).json({ success: false, message: 'Account not found.' });
        return res.json({
            _id: me._id, email: me.email, fullName: me.fullName, position: me.position,
            contactNumber: me.contactNumber, createdAt: me.createdAt, lastSignInAt: me.lastSignInAt
        });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Officer profile read failure:');
    }
});

/* The officer keeps their own name, position and contact number. The sign-in
   email is not changed here: it is the account's identity. */
app.patch('/api/admin/me', requireAdmin, async (req, res) => {
    try {
        const fullName = String((req.body || {}).fullName ?? '').trim();
        const position = String((req.body || {}).position ?? '').trim();
        const contactNumber = String((req.body || {}).contactNumber ?? '').trim();
        if (!fullName) return res.status(400).json({ success: false, message: 'Your full name is required.' });
        if (fullName.length > 120 || position.length > 120) {
            return res.status(400).json({ success: false, message: 'Name and position are limited to 120 characters.' });
        }
        if (contactNumber.length > 40) return res.status(400).json({ success: false, message: 'The contact number is too long.' });
        const me = await TourismOfficer.findById(req.auth.sub);
        if (!me) return res.status(404).json({ success: false, message: 'Account not found.' });
        Object.assign(me, { fullName, position, contactNumber });
        await TourismOfficer.save(me);
        return res.json({ success: true, message: 'Your details have been saved.', fullName, position, contactNumber });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Officer profile update failure:');
    }
});

/* Deactivate or reactivate another officer. Never yourself, and never the
   last active officer: someone must always be able to run the system. The
   account is kept, so the records it made still say who made them. */
app.patch('/api/admin/:id/status', requireAdmin, requirePasswordConfirmation, async (req, res) => {
    try {
        const active = (req.body || {}).active;
        if (typeof active !== 'boolean') return res.status(400).json({ success: false, message: 'Say whether the account is active.' });
        if (String(req.params.id) === String(req.auth.sub)) {
            return res.status(409).json({ success: false, message: 'You cannot deactivate your own account.' });
        }
        const officer = await TourismOfficer.findById(req.params.id);
        if (!officer) return res.status(404).json({ success: false, message: 'That account no longer exists.' });
        if (!active) {
            const { rows } = await db.query('select count(*)::int as n from tourism_officers where active and id <> $1', [officer._id]);
            if (rows[0].n < 1) return res.status(409).json({ success: false, message: 'At least one officer account must stay active.' });
        }
        officer.active = active;
        await TourismOfficer.save(officer);
        console.log(`🛡️ Officer account ${active ? 'reactivated' : 'deactivated'}: ${officer.email}`);
        return res.json({ success: true, message: active ? 'The account has been reactivated.' : 'The account has been deactivated. It can no longer sign in.' });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Officer status change failure:');
    }
});

/* Issue a new password for another officer (one who forgot theirs). Your own
   is changed under Security, with your current password. */
app.post('/api/admin/:id/password', requireAdmin, requirePasswordConfirmation, async (req, res) => {
    try {
        if (String(req.params.id) === String(req.auth.sub)) {
            return res.status(409).json({ success: false, message: 'Change your own password under Security.' });
        }
        const officer = await TourismOfficer.findById(req.params.id);
        if (!officer) return res.status(404).json({ success: false, message: 'That account no longer exists.' });
        const newPassword = String((req.body || {}).newPassword || '').trim() || generatePassword();
        const weak = passwordProblem(newPassword, { email: officer.email });
        if (weak) return res.status(400).json({ success: false, message: weak });
        await storePassword('admin', officer._id, newPassword, { issued: true });
        console.log(`🔑 Officer issued a new password for officer ${officer.email}`);
        await alertAccountOwner(officer.email, 'A new password was issued for your account',
            `${(req.account && req.account.email) || 'A Tourism Officer'} issued a new password for your ZTIMS account. You will be asked to choose your own when you sign in.`);
        return res.json({ success: true, message: 'A new password has been set. Pass it on — it cannot be read again.', email: officer.email, newPassword });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Officer password issue failure:');
    }
});

/**
 * POST: Tourist Officer creates a Tourist Enterprise Manager account (managers do
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
            return res.status(400).json({ success: false, message: 'Missing mandatory email, password, or enterprise name.' });
        }

        const normalizedEmail = email.toLowerCase().trim();
        const weak = passwordProblem(String(password), { email: normalizedEmail });
        if (weak) return res.status(400).json({ success: false, message: weak });
        const existingManager = await EstablishmentManager.findOne({ email: normalizedEmail });
        if (existingManager) {
            return res.status(409).json({ success: false, message: 'This email is already registered as an enterprise manager.' });
        }
        const takenBy = await emailTakenBy(normalizedEmail);
        if (takenBy) {
            return res.status(409).json({ success: false, message: `This email already signs in as ${takenBy}.` });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const created = await EstablishmentManager.create({
            email: normalizedEmail,
            password: passwordHash,
            establishmentName: establishmentName.trim(),
            managerName: (managerName || "").trim(),
            // Left blank, the sign-in address doubles as the public one, so a
            // listing never ends up with no way to reach anybody.
            contactEmail: (req.body.contactEmail || normalizedEmail).toLowerCase().trim(),
            phone: phone || ""
        });

        // The officer chose this password: the manager sets their own at first sign-in.
        await db.query('update establishment_managers set must_change_password = true where id = $1', [created._id]);

        console.log(`🏨 New Tourist Enterprise Manager account created by Tourist Officer: ${normalizedEmail}`);
        return res.status(201).json({ success: true, message: 'Enterprise manager account created!' });
    } catch (error) {
        return reportWriteFailure(res, error, '❌ Create Enterprise Manager Endpoint Failure:');
    }
}

/**
 * GET: Tourist Officer lists all enterprise manager accounts
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
        console.error("❌ Get Enterprise Manager List Endpoint Failure:", error);
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
        // ticket was already recorded"); otherwise, the generic wording.
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
 * PATCH: the enterprise reports whether it is operating.
 *
 * This is the enterprise speaking about its own business, so it is theirs to
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
            return res.status(400).json({ success: false, message: 'Choose whether the enterprise is operating, temporarily closed, or permanently closed.' });
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
        return reportWriteFailure(res, error, '❌ Enterprise status update failure:');
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
        if (!name) throw new Error('The enterprise needs a name.');
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

app.post('/api/establishment-managers/me/password', requireEstablishmentManager, ownPasswordRateLimit, changeOwnPassword);


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
                if (taken) return res.status(409).json({ success: false, message: 'Another enterprise already signs in with that email.' });
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
app.post('/api/establishment-managers/:id/password', requireAdmin, requirePasswordConfirmation, async (req, res) => {
    try {
        const manager = await EstablishmentManager.findById(req.params.id);
        if (!manager) return res.status(404).json({ success: false, message: 'That account no longer exists.' });

        const newPassword = String(req.body.newPassword || '').trim() || generatePassword();
        const weak = passwordProblem(newPassword, { email: manager.email });
        if (weak) return res.status(400).json({ success: false, message: weak });

        await storePassword('establishment_manager', manager._id, newPassword, { issued: true });

        console.log(`🔑 Officer issued a new password for ${manager.email}`);
        await alertAccountOwner(manager.email, 'A new password was issued for your account',
            'The Municipal Tourism Office issued a new password for your ZTIMS account. You will be asked to choose your own when you sign in.');
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
        console.log(`🗑️ Officer deleted enterprise manager account ${manager.email}`);
        return res.status(200).json({ success: true, message: 'Account deleted.' });
    } catch (error) {
        console.error('❌ Officer manager delete failure:', error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});



/**
 * POST: Sign in. ZTIMS has two kinds of account: Tourism Officer and Tourist
 * Enterprise Manager. Visitors browse without one.
 * Target URL: http://localhost:5000/api/login
 */
// Only failed sign-ins count: everyone at the Municipal Hall reaches the site
// from one internet address, and ten officers signing in on a Monday morning
// must not lock the eleventh out. Ten wrong passwords in 15 minutes still do.
app.post('/api/login', sharedRateLimit('login', {
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    message: { success: false, message: 'Too many failed sign-ins. Please wait a few minutes and try again.' }
}), async (req, res) => {
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
            account = await TourismOfficer.findOne({ email: normalizedEmail }, { secrets: true });
            resolvedRole = 'admin';

            if (!account) {
                account = await EstablishmentManager.findOne({ email: normalizedEmail }, { secrets: true });
                resolvedRole = 'establishment_manager';
            }
        } else if (requestedRole === 'admin') {
            account = await TourismOfficer.findOne({ email: normalizedEmail }, { secrets: true });
        } else {
            account = await EstablishmentManager.findOne({ email: normalizedEmail }, { secrets: true });
            resolvedRole = 'establishment_manager';
        }

        // The password is checked first, and for an unknown email too (against a
        // stand-in hash, so the answer takes as long either way). Only someone
        // who knows the password learns that an account exists or is suspended.
        const passwordMatches = await bcrypt.compare(String(password), (account && account.password) || NO_ACCOUNT_HASH);
        if (!account || !account.password || !passwordMatches) {
            // Deliberately the same wording whichever collection was searched, so the
            // response can't be used to discover which emails are registered.
            const audience = requestedRole === 'staff' ? 'staff'
                : resolvedRole === 'admin' ? 'Tourist Officer'
                : 'Tourist Enterprise Manager';
            return res.status(401).json({
                success: false,
                message: `Authentication failed: Invalid ${audience} credentials.`
                });
        }

        // A suspended account is told plainly — once the password has proved it
        // is theirs — rather than being left to think they are mistyping it.
        if (isEstablishmentManager(resolvedRole) && account.active === false) {
            return res.status(403).json({
                success: false,
                message: 'This account has been suspended by the Municipal Tourism Office. Please contact them to have it restored.'
            });
        }
        if (resolvedRole === 'admin' && account.active === false) {
            return res.status(403).json({
                success: false,
                message: 'This account has been deactivated by the Municipal Tourism Office.'
            });
        }

        const stored = await accountBehind({ role: resolvedRole, sub: account._id });
        const mustChangePassword = Boolean(stored && stored.must_change_password);

        if (resolvedRole === 'admin') {
            try {
                account.lastSignInAt = new Date();
                await TourismOfficer.save(account);
            } catch (error) {
                console.error('❌ Could not record the sign-in time:', error && error.message);
            }
        }

        // Base payload data structures object mapping logic
        const responseData = {
            success: true,
            message: `Login Successful! Welcome back.`,
            token: createToken(account, resolvedRole, sessionVersionOf(stored)),
            role: resolvedRole,
            // The password was chosen by someone else: the sign-in page asks for
            // the person's own before going on, and nothing else works until then.
            mustChangePassword,
            userId: account._id, // Sends valid object database identifier instead of 'anonymous_guest'
            user: {
                email: account.email,
                name: account.fullName || account.establishmentName || account.email.split('@')[0],
                fullName: account.fullName || "",
                phone: account.phone || "",
                nationality: account.nationality || "",
                establishmentName: account.establishmentName || "",
                // Pre-rename key, still sent so a page cached from before the rename
                // keeps showing the enterprise's name instead of a blank.
                resortName: account.establishmentName || ""
            }
        };

        return res.status(200).json(responseData);
    } catch (error) {
        console.error("❌ Auth Route Error:", error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});


// Reset emails go out through mailer.js like every other email: the office's
// Gmail (MAIL_USER / MAIL_PASSWORD, never committed), giving up after 8 seconds
// rather than holding the request, and MAIL_TRANSPORT=file:… for local tests.
if (!mailer.mailConfigured()) {
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
 * Returns { account, table, role } — the table being where the account is saved back —
 * or null.
 */
async function findResettableAccount(email, withResetFields) {
    const options = { secrets: Boolean(withResetFields) };

    const manager = await EstablishmentManager.findOne({ email }, options);
    if (manager) return manager.active === false ? null : { account: manager, table: EstablishmentManager, role: 'establishment_manager' };

    const officer = await TourismOfficer.findOne({ email }, options);
    if (officer) return officer.active === false ? null : { account: officer, table: TourismOfficer, role: 'admin' };

    return null;
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
        if (!mailer.mailConfigured()) {
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

        // The site's own address: PUBLIC_SITE_URL when set, else the address this
        // request came to (the page and the API share one origin). Never the
        // CORS list, whose first entry is a local test address when it is unset.
        const siteUrl = (process.env.PUBLIC_SITE_URL || `${req.protocol}://${req.get('host')}`).trim().replace(/\/+$/, '');
        const resetLink = `${siteUrl}/src/user/reset_password.html?email=${encodeURIComponent(normalizedEmail)}&token=${token}`;

        const sent = await mailer.sendMail({
            to: normalizedEmail,
            subject: 'Reset your ZTIMS password',
            text: [
                'Zamboanguita Tourism Staff Portal', '',
                'We received a request to change the password for your account.',
                `Open this link to choose a new password. It works once and expires in ${RESET_TOKEN_TTL_MINUTES} minutes:`,
                resetLink, '',
                "If you didn't ask to change your password, ignore this email — your password stays as it is."
            ].join('\n'),
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #1C1917;">
                    <h2 style="color: #7A2E00;">Zamboanguita Tourism Staff Portal</h2>
                    <p>Hello,</p>
                    <p>We received a request to change the password for your account.</p>
                    <p>Click the button below to create a new password. This link works once and expires in ${RESET_TOKEN_TTL_MINUTES} minutes.</p>
                    <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; color: #FFFDFA; background-color: #BF5700; text-decoration: none; font-weight: bold; margin: 15px 0;">Reset Password</a>
                    <p style="font-size: 12px; color: #666;">If the button doesn't work, paste this into your browser:<br>${resetLink}</p>
                    <p>If you didn't ask to change your password, you can ignore this email — your password stays as it is.</p>
                </div>
            `
        });
        if (!sent.sent) {
            // The token is useless if the email never left, so don't leave it live.
            user.resetTokenHash = null;
            user.resetTokenExpires = null;
            await found.table.save(user);
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

        const weak = passwordProblem(String(newPassword), { email: String(email).toLowerCase().trim() });
        if (weak) return res.status(400).json({ success: false, message: weak });

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

        // Spent immediately (storePassword clears it), so the same link cannot be
        // replayed; every open sign-in of the account ends with the old password.
        await storePassword(found.role, user._id, String(newPassword), { issued: false });

        console.log(`🔑 Password reset completed for ${user.email}`);
        await alertAccountOwner(user.email, 'Your password was changed',
            'The password of your ZTIMS account was changed through a reset link. Every device signed in to it has been signed out.');
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
 * Pass ?mine=true (Tourist Enterprise Manager) to scope results to their own listings.
 */
app.get('/api/spots', optionalAuth, async (req, res) => {
    try {
        const query = {};
        if (req.query.mine === 'true' && isEstablishmentManager(req.auth?.role)) {
            // A manager asking for "mine" gets exactly the listings assigned to
            // them — the scope is applied in the query, not left to the caller.
            query.managedBy = req.auth.sub;
        }
        // The enterprise's public-facing details come along so the officer's
        // oversight page can show who maintains each listing without a request per row.
        const foundSpots = await Spot.findWithManagers(query);

        // A suspended enterprise's listings leave the public site, but the
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
/* Where a photo may come from: the municipality's own Cloudinary account (every
   upload goes there), and the folder the office used before it, which two of
   the first listings still show. A photo anywhere else would let that site see
   every visitor who opens the page, and the pages' Content-Security-Policy
   (vercel.json, img-src) would not show it anyway — keep the two in step.
   A photo already on the record being edited is always kept. */
const PHOTO_SOURCES = [
    `https://res.cloudinary.com/${(process.env.CLOUDINARY_CLOUD_NAME || 'xeo3pvpw').trim()}/`,
    'https://uploads.onecompiler.io/43fxe3kf9/'
];
const isOwnPhoto = url => PHOTO_SOURCES.some(prefix => String(url).startsWith(prefix));

/* Throws a 400-shaped error when a photo address is neither ours nor already
   on the record. `kept`: the addresses the record has now. */
function checkPhotoSources(urls, kept = []) {
    const already = new Set(kept.filter(Boolean).map(String));
    const stranger = urls.filter(Boolean).map(String).find(url => !already.has(url) && !isOwnPhoto(url));
    if (stranger) {
        const error = new Error('Photos have to be uploaded through ZTIMS. Use "Upload photos" rather than a link from another site.');
        error.status = 400;
        error.name = 'ValidationError';
        throw error;
    }
}

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
   together: being an enterprise manager is not enough on its own, the listing
   has to be one that manager is assigned to.

   None of this depends on the frontend. The portals hide actions the signed-in
   user cannot perform, but that is presentation. These functions are the
   authorization, and a hand-built request carrying someone else's listing id is
   refused here no matter what any page did or didn't show.
========================================== */

// What an enterprise manager may write on a listing assigned to them: its
// tourism information, and nothing about who is responsible for it.
const MANAGER_WRITABLE_SPOT_FIELDS = [
    'title', 'location', 'category', 'moreCategories', 'description', 'imageUrl', 'images', 'bookingUrl',
    'type', 'label', 'workingDays', 'workingTime', 'travelFee', 'entranceFee',
    'address', 'barangay', 'latitude', 'longitude'
];
// Note what is absent: status and managedBy. Publication is the municipality's
// decision, not an enterprise's.

/**
 * Decides whether this caller may write to this listing.
 *
 * The Tourism Officer's authority covers every listing, including one a private
 * enterprise maintains. That is the point of municipal oversight, and it does
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
                message: 'You may only manage listings assigned to your own enterprise.'
            };
        }
        return { allowed: true, scope: 'manager' };
    }

    return { allowed: false, status: 403, message: 'Staff access required.' };
}

/**
 * Narrows a payload to the fields the caller's scope allows. An officer's passes
 * through whole; a manager's is reduced to their own enterprise's information.
 *
 * Dropping beats rejecting here: the enterprise's editor posts a whole listing
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
 * What a listing is known for (see schema.sql, "Categories"): `category` is the
 * main one of six, `moreCategories` any others; whether it is a place to stay is
 * `type`, its own question. A field the editor did not send is left alone.
 *
 * The four old values a page cached before October 2026 may still send are
 * read the way schema.sql converted the listings; ACCOMMODATION alone is not
 * guessed at (it said nothing about what the place is known for).
 */
const SPOT_CATEGORIES = ['BEACH', 'DIVING', 'NATURE', 'ADVENTURE', 'CULTURE', 'FAITH', 'LEISURE'];
const OLD_SPOT_CATEGORIES = { 'BEACH / DIVING': ['BEACH', 'DIVING'], MOUNTAIN: ['NATURE'], CULTURAL: ['CULTURE'] };

function categoryProblem(message) {
    return Object.assign(new Error(message), { name: 'ValidationError', errors: { category: { message } } });
}

function normaliseSpotCategories(payload) {
    const out = { ...payload };
    if ('category' in out) {
        let main = String(out.category || '').trim().toUpperCase();
        if (OLD_SPOT_CATEGORIES[main]) {
            const [first, ...rest] = OLD_SPOT_CATEGORIES[main];
            main = first;
            if (!('moreCategories' in out)) out.moreCategories = rest;
        }
        if (!SPOT_CATEGORIES.includes(main)) {
            throw categoryProblem('Choose what the place is known for: Beach & Sea, Diving & Snorkeling, Nature, Adventure, Culture & Heritage, Faith or Leisure & Recreation.');
        }
        out.category = main;
    }
    if ('moreCategories' in out) {
        const list = Array.isArray(out.moreCategories) ? out.moreCategories : [];
        const codes = list.map(code => String(code || '').trim().toUpperCase()).filter(Boolean);
        const unknown = codes.find(code => !SPOT_CATEGORIES.includes(code));
        if (unknown) throw categoryProblem(`"${unknown}" is not one of the categories.`);
        out.moreCategories = [...new Set(codes)].filter(code => code !== out.category);
    }
    if ('type' in out && !['accommodation', 'spot'].includes(out.type)) {
        throw categoryProblem('Say whether it is a place to stay or a place to visit.');
    }
    return out;
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
   issued to a signed-in Tourism Officer or enterprise manager and to nobody
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

const UPLOAD_FORMATS = 'jpg,jpeg,png,webp';

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
    // allowed_formats is signed with the rest, so a page cannot drop it: only
    // photographs and plain images, never an SVG (which can carry script) or a PDF.
    const params = { allowed_formats: UPLOAD_FORMATS, folder: CLOUDINARY_FOLDER, timestamp };

    return res.status(200).json({
        success: true,
        signed: true,
        cloudName: CLOUDINARY_CLOUD_NAME,
        apiKey: CLOUDINARY_API_KEY,
        folder: CLOUDINARY_FOLDER,
        allowedFormats: UPLOAD_FORMATS,
        timestamp,
        signature: signCloudinaryParams(params)
    });
});

app.post('/api/spots', requireStaff, async (req, res) => {
    try {
        // A manager's listing is assigned to them, whatever the request claims;
        // only the officer may assign a listing to an enterprise.
        const managedBy = isEstablishmentManager(req.auth.role)
            ? req.auth.sub
            : (req.body.managedBy || null);
        // One enterprise, one listing (spots_one_per_establishment holds it
        // too); said plainly here before anything is written.
        if (managedBy && await Spot.count({ managedBy })) {
            return res.status(409).json({
                success: false,
                message: isEstablishmentManager(req.auth.role)
                    ? 'Your enterprise already has its listing. Edit that one instead of adding another.'
                    : 'That enterprise already has its listing. An enterprise keeps one listing.'
            });
        }
        // The record's identity and history are the database's to set, never a request's.
        const { _id, createdAt, updatedAt, ...body } = req.body;
        const scoped = scopeSpotPayload(body, isEstablishmentManager(req.auth.role) ? 'manager' : 'officer');
        const prepared = normaliseSpotCategories(deriveSpotLocation(normaliseSpotLocation(normaliseSpotImages(scoped)), ''));
        checkPhotoSources([prepared.imageUrl, ...(prepared.images || [])]);
        const savedSpot = await Spot.create({ ...prepared, managedBy });
        return res.status(201).json(savedSpot);
    } catch (error) {
        return reportWriteFailure(res, error, 'Publishing a spot failed:');
    }
});

/**
 * GET: Fetch a single spot by id (public — used by the destination page)
 * Target URL: http://localhost:5000/api/spots/:id
 */
app.get('/api/spots/:id', async (req, res) => {
    try {
        // Only the enterprise's public-facing contact details — never the
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
 * Officer-only, on every listing including those a private enterprise
 * maintains — that is what municipal oversight means, and it is the reason this
 * is separate from editing the listing's information. An enterprise keeps its
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
 * PUT/DELETE: Enterprise Managers manage only their own spot; the Tourist Officer manages any.
 * Target URL: http://localhost:5000/api/spots/:id
 */
app.put('/api/spots/:id', requireStaff, async (req, res) => {
    try {
        const spot = await Spot.findById(req.params.id);
        if (!spot) return res.status(404).json({ message: 'Spot not found.' });

        const verdict = authorizeSpotWrite(req.auth, spot);
        if (!verdict.allowed) return res.status(verdict.status).json({ success: false, message: verdict.message });

        // Which enterprise maintains a listing is never reassigned from here,
        // and a listing's id and history are never the request's to change: the
        // update is saved against the id in the URL, whatever the body carries.
        const { managedBy, ownerId, _id, createdAt, updatedAt, ...updates } = req.body;
        const prepared = normaliseSpotLocation(normaliseSpotImages(scopeSpotPayload(updates, verdict.scope)));
        checkPhotoSources([prepared.imageUrl, ...(prepared.images || [])], [spot.imageUrl, ...(spot.images || [])]);
        Object.assign(spot, normaliseSpotCategories(deriveSpotLocation(prepared, spot.location)));
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
        // A listing with tickets on record keeps them: the database refuses the delete.
        if (error && error.code === 'STILL_REFERENCED') {
            return res.status(409).json({
                success: false,
                message: 'This listing has tickets on record, so it cannot be deleted. Archive it instead — the record is kept and the public no longer sees it.'
            });
        }
        return res.status(500).json({ error: error.message });
    }
});

/* ==========================================
   4c. DAILY MAINTENANCE
========================================== */

/* Visitors' personal details are erased a year after the visit (privacy.js).
   Vercel's cron calls this daily with CRON_SECRET; without it the route does
   not exist. */
app.get('/api/maintenance/privacy', async (req, res) => {
    const secret = String(process.env.CRON_SECRET || '');
    const given = String(req.get('authorization') || '');
    const wanted = `Bearer ${secret}`;
    const matches = secret && given.length === wanted.length
        && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(wanted));
    if (!matches) return res.status(404).end();
    try {
        const erased = await forgetOldVisitors();
        return res.json({ success: true, erased });
    } catch (error) {
        console.error('❌ Privacy clean-up failure:', error);
        return res.status(500).json({ success: false });
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

// One of the writes anyone on the internet can make (buying tickets is the
// other), so it is held tightly: ten an hour is plenty for a person, and a
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
   The enterprise says where it is. The visitor's device — or a starting point
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
const ROUTER_ORDER = ['openrouteservice', 'osrm', 'valhalla'];

const PROFILE_KEY = { openrouteservice: 'ors', osrm: 'osrm', valhalla: 'valhalla' };

/* A router can serve a mode only if it is configured and knows a profile for it.
 * OSRM's demo needs no key; ORS needs one; Valhalla needs a base URL. */
const ROUTER_AVAILABLE = {
    openrouteservice: () => Boolean(ORS_API_KEY),
    osrm: () => true,
    valhalla: () => Boolean(VALHALLA_URL)
};

/* Every router a mode can fall back to, primary first. One sick provider must
 * not take a whole mode down with it: when ORS hangs, the same request goes to
 * OSRM or Valhalla, and the response names whichever router actually answered. */
function routerChain(mode) {
    return ROUTER_ORDER
        .map(router => mode[PROFILE_KEY[router]] ? { router, profile: mode[PROFILE_KEY[router]] } : null)
        .filter(link => link && ROUTER_AVAILABLE[link.router]());
}

const ROUTING_MODES = Object.fromEntries(
    Object.entries(MODES)
        .map(([id, mode]) => {
            const chain = routerChain(mode);
            return chain.length
                ? [id, { label: mode.label, router: chain[0].router, profile: chain[0].profile, chain }]
                : null;
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

async function routeWithValhalla(from, to, profile) {
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

async function routeWithOpenRouteService(from, to, profile) {
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

async function routeWithOsrm(from, to, profile) {
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

    // Per mode, not per site: the chain lists every router that can compute this
    // mode, primary first. A provider that hangs or errors costs the visitor one
    // attempt, not their directions — the same request goes to the next router,
    // and the response names the one that actually answered.
    const { chain } = ROUTING_MODES[mode];

    try {
        let routes = null;
        let router = null;
        let lastError = null;

        for (const { router: linkRouter, profile } of chain) {
            try {
                routes = linkRouter === 'openrouteservice' ? await routeWithOpenRouteService(from, to, profile)
                    : linkRouter === 'valhalla' ? await routeWithValhalla(from, to, profile)
                    : await routeWithOsrm(from, to, profile);
                router = linkRouter;
                // An empty answer still counts as an answer: "these points are not
                // connected by this kind of road" needs no second opinion.
                break;
            } catch (error) {
                lastError = error;
                console.error(`Routing with ${linkRouter} failed:`, error.message);
            }
        }

        // Every router in the chain failed — the honest answer stays "unreachable".
        if (router === null) throw lastError;

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
 * Address search, used by the enterprise's location picker and by a visitor who
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
app.use('/api', paymentsModule({ requireAdmin, requirePasswordConfirmation, sharedRateLimit, isPubliclyVisible }));

/* ==========================================
   ATTRACTION SETUP — opening days, closed dates, prices per kind of visitor,
   and the share kept on a cancellation (attractions.js)
========================================== */
const attractions = require('./attractions');
app.use('/api', attractions({ requireAdmin }));

/* ==========================================
   OFFICE INFORMATION — the office's public contact details and emergency
   numbers, kept on the officer's Settings page (office.js)
========================================== */
app.use('/api', require('./office')({ requireAdmin }));

/* ==========================================
   MANAGE MY TICKET — a visitor moves or cancels with the code and
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
