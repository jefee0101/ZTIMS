/* Visitor accounts (decided 9 November 2026, the panelist's request).
 *
 * A visitor signs in with an email and password, or with Google, to buy
 * tickets and book rooms (both need a signed-in, verified account), see them
 * all in one place, keep saved places and write reviews. The role in their
 * tokens is 'tourist'. Visitors are a separate kind of account from staff:
 *   - their own table (visitors), their own sign-in routes and pages;
 *   - their tokens carry a different audience ('ztims-visitor'), so a staff
 *     route (audience 'ztims-web') refuses them at the signature check, and
 *     requireVisitor refuses a staff token the same way;
 *   - an email a staff account signs in with cannot become a visitor account.
 *
 * The rules:
 *   - An email must be verified (an emailed link, or Google's own verified
 *     email) before the account can buy or book. Email links carry a token,
 *     never the address; only the token's hash is stored; each works once.
 *   - Google: the server checks the ID token itself, against Google's keys and
 *     GOOGLE_CLIENT_ID; the page's word is never taken. Only a verified Google
 *     email is accepted. It joins an existing password account only when that
 *     account's email was never verified (the Google sign-in proves the
 *     mailbox, and the unproven password is dropped), or when the visitor also
 *     gives that account's password.
 *   - Passwords follow passwords.js, like staff passwords.
 *   - Tickets and bookings made earlier with the same email (as a guest) are
 *     linked to the account once its email is verified.
 *   - Deleting the account (password, or a fresh Google sign-in) erases the
 *     name, phone, email, password and Google id. The row stays as "deleted"
 *     so old tickets, bookings and reviews still point somewhere; reviews stay
 *     and show as "Former visitor". Tickets and bookings keep their counts and
 *     amounts and fall under privacy.js's one-year rule.
 *
 * Mounted at /api by server.js, which hands over the shared rate limiter, the
 * staff email check and the site's address.
 */
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('./db');
const { passwordProblem } = require('./passwords');
const mailer = require('./mailer');

const ROLE = 'tourist';
const AUDIENCE = 'ztims-visitor';
const ISSUER = 'ztims-api';
const TOKEN_TTL = '30d';
const VERIFY_HOURS = 48;
const RESET_MINUTES = 30;
const FORMER_VISITOR = 'Former visitor';
// A real bcrypt hash of a password nobody has: an unknown email takes as long
// to refuse as a wrong password.
const NO_ACCOUNT_HASH = '$2b$12$YDOAyLYTMrO2s/ukI0DbX.sdGfqiRJV7V1d8hHW1n8EmTyCD533Ie';

const isId = value => /^[0-9a-f]{24}$/i.test(String(value || ''));
const looksLikeEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const normaliseEmail = value => String(value || '').trim().toLowerCase();
const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');

function problem(status, message, code) {
    return Object.assign(new Error(message), { status, code });
}

/* ------------------------------------------------------------------ tokens */

const createVisitorToken = row => jwt.sign(
    { sub: String(row.id), role: ROLE, sv: Number(row.session_version || 0) },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_TTL, issuer: ISSUER, audience: AUDIENCE }
);

const bearer = req => {
    const header = String(req.get('authorization') || '');
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

/* The signed-in visitor behind a request, or a reason why not. */
async function visitorFrom(req) {
    const token = bearer(req);
    if (!token) return { status: 401, message: 'Please sign in.', code: 'SIGN_IN' };
    let claims;
    try {
        claims = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    } catch {
        return { status: 401, message: 'Your session has ended. Please sign in again.', code: 'SIGN_IN' };
    }
    if (claims.role !== ROLE || !isId(claims.sub)) return { status: 401, message: 'Please sign in.', code: 'SIGN_IN' };
    const { rows } = await query('select * from visitors where id = $1', [claims.sub]);
    const row = rows[0];
    if (!row || row.status !== 'active') return { status: 401, message: 'Please sign in.', code: 'SIGN_IN' };
    if (Number(row.session_version || 0) !== Number(claims.sv || 0)) {
        return { status: 401, message: 'You have been signed out. Please sign in again.', code: 'SESSION_ENDED' };
    }
    if (!row.email_verified_at) return { status: 403, message: 'Verify your email address first.', code: 'EMAIL_NOT_VERIFIED' };
    return { visitor: row, claims };
}

/* A signed-in visitor with a verified email; the row is req.visitor. A staff
   token never passes (another audience). */
async function requireVisitor(req, res, next) {
    try {
        const found = await visitorFrom(req);
        if (!found.visitor) return res.status(found.status).json({ success: false, code: found.code, message: found.message });
        req.visitor = found.visitor;
        return next();
    } catch (error) {
        console.error('❌ Visitor sign-in check failure:', error && error.message);
        return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    }
}

/* ------------------------------------------------------------------ Google */

/* Google's signing keys, kept for as long as Google says they may be.
   GOOGLE_CERTS_URL exists for local tests only (a key the test made). */
let googleKeys = { at: 0, maxAge: 0, keys: [] };
async function googleKey(kid) {
    const fresh = Date.now() - googleKeys.at < googleKeys.maxAge * 1000;
    if (!fresh || !googleKeys.keys.some(k => k.kid === kid)) {
        const url = process.env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Google keys: HTTP ${response.status}`);
        const body = await response.json();
        const match = /max-age=(\d+)/.exec(response.headers.get('cache-control') || '');
        googleKeys = { at: Date.now(), maxAge: match ? Number(match[1]) : 3600, keys: Array.isArray(body.keys) ? body.keys : [] };
    }
    const jwk = googleKeys.keys.find(k => k.kid === kid);
    return jwk ? crypto.createPublicKey({ key: jwk, format: 'jwk' }) : null;
}

/* The verified identity in a Google ID token, or a thrown 401. */
async function verifyGoogleCredential(credential) {
    const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
    if (!clientId) throw problem(503, 'Google sign-in is not available right now.');
    const token = String(credential || '');
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || !decoded.header || decoded.header.alg !== 'RS256' || !decoded.header.kid) {
        throw problem(401, 'Google sign-in did not work. Please try again.');
    }
    let key;
    try { key = await googleKey(decoded.header.kid); } catch (error) {
        console.error('❌ Google keys failure:', error && error.message);
        throw problem(503, 'Google sign-in is not available right now.');
    }
    if (!key) throw problem(401, 'Google sign-in did not work. Please try again.');
    let claims;
    try {
        claims = jwt.verify(token, key, {
            algorithms: ['RS256'], audience: clientId, issuer: ['accounts.google.com', 'https://accounts.google.com']
        });
    } catch {
        throw problem(401, 'Google sign-in did not work. Please try again.');
    }
    const email = normaliseEmail(claims.email);
    if (!claims.sub || !looksLikeEmail(email) || !(claims.email_verified === true || claims.email_verified === 'true')) {
        throw problem(401, 'That Google account has no verified email address.');
    }
    return { sub: String(claims.sub), email, name: String(claims.name || '').trim().slice(0, 120), issuedAt: Number(claims.iat || 0) };
}

/* ----------------------------------------------------------------- records */

/* Tickets and bookings bought as a guest with this email become the account's.
   Only records nobody owns are taken; running it again changes nothing. */
async function linkOldRecords(visitor, client) {
    if (!visitor.email || !visitor.email_verified_at) return { tickets: 0, bookings: 0 };
    const t = await query('update tickets set visitor_id = $1 where visitor_id is null and email = $2', [visitor.id, visitor.email], client);
    const b = await query('update bookings set visitor_id = $1 where visitor_id is null and email = $2', [visitor.id, visitor.email], client);
    return { tickets: t.rowCount, bookings: b.rowCount };
}

const profile = v => ({
    _id: v.id, email: v.email, fullName: v.full_name, phone: v.phone, countryCode: v.country_code,
    emailVerified: Boolean(v.email_verified_at), hasPassword: Boolean(v.password_hash), hasGoogle: Boolean(v.google_sub),
    createdAt: v.created_at, lastSignInAt: v.last_sign_in_at
});

/* What a checkout needs from the account: the name and email always, the
   phone (and for a room, the country) once. A value the visitor gives at
   checkout for a missing one is saved to the account, so it is not asked again. */
async function checkoutDetails(visitor, body, { needCountry = false } = {}) {
    const b = body || {};
    let phone = visitor.phone, countryCode = visitor.country_code;
    const changes = {};
    if (!phone && b.phone) {
        const given = String(b.phone).trim();
        if (given.replace(/[^0-9]/g, '').length < 7 || given.length > 40) throw problem(400, 'Give a phone number we can call.');
        phone = changes.phone = given;
    }
    if (!countryCode && b.countryCode) {
        const { rows } = await query('select code from residences where code = $1', [String(b.countryCode)]);
        if (!rows.length) throw problem(400, 'Choose the country where you live.');
        countryCode = changes.country_code = rows[0].code;
    }
    if (!visitor.full_name || visitor.full_name.length < 2) throw problem(409, 'Add your full name to your account first.', 'PROFILE_INCOMPLETE');
    if (!phone) throw problem(409, 'Add a phone number to your account first.', 'PROFILE_INCOMPLETE');
    if (needCountry && !countryCode) throw problem(409, 'Add the country where you live to your account first.', 'PROFILE_INCOMPLETE');
    if (Object.keys(changes).length) {
        const sets = Object.keys(changes).map((k, i) => `${k} = $${i + 2}`).join(', ');
        await query(`update visitors set ${sets} where id = $1`, [visitor.id, ...Object.values(changes)]);
    }
    return { fullName: visitor.full_name, email: visitor.email, phone, countryCode, visitorId: visitor.id };
}

/* ------------------------------------------------------------------ emails */

function siteUrl(origin) {
    const configured = String(process.env.PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
    return configured || String(origin || '').replace(/\/+$/, '');
}
const FOOTER = 'Municipal Tourism Office, Zamboanguita, Negros Oriental.\n'
    + 'You are getting this because this email address was used for a ZTIMS visitor account.';

/* A fresh single-use link for one purpose; earlier unused ones of that
   purpose stop working. Returns the token to put in the link. */
async function issueEmailToken(visitorId, purpose, minutes) {
    const token = crypto.randomBytes(32).toString('hex');
    await transaction(async client => {
        await query(`update visitor_tokens set used_at = now() where visitor_id = $1 and purpose = $2 and used_at is null`, [visitorId, purpose], client);
        await query(`insert into visitor_tokens (visitor_id, purpose, token_hash, expires_at) values ($1, $2, $3, now() + make_interval(mins => $4))`,
            [visitorId, purpose, hashToken(token), minutes], client);
    });
    return token;
}

async function sendVerifyEmail(visitor, origin) {
    const token = await issueEmailToken(visitor.id, 'verify', VERIFY_HOURS * 60);
    const link = `${siteUrl(origin)}/src/user/verify_email.html?token=${token}`;
    const body = mailer.compose({
        heading: 'Confirm your email address',
        intro: `Open this link to confirm the email address for your ZTIMS account. It works once and expires in ${VERIFY_HOURS} hours.`,
        link: { label: 'Confirm my email', url: link },
        paragraphs: ['If you did not create an account, ignore this email.'],
        footer: FOOTER
    });
    return mailer.sendMail({ to: visitor.email, subject: 'Confirm your ZTIMS account', ...body });
}

async function sendResetEmail(visitor, origin) {
    const token = await issueEmailToken(visitor.id, 'reset', RESET_MINUTES);
    const link = `${siteUrl(origin)}/src/user/new_password.html?token=${token}`;
    const body = mailer.compose({
        heading: 'Choose a new password',
        intro: `Open this link to choose a new password for your ZTIMS account. It works once and expires in ${RESET_MINUTES} minutes.`,
        link: { label: 'Choose a new password', url: link },
        paragraphs: ['If you did not ask for this, ignore this email: your password stays as it is.'],
        footer: FOOTER
    });
    return mailer.sendMail({ to: visitor.email, subject: 'Reset your ZTIMS password', ...body });
}

function sendSecurityNotice(to, heading, intro) {
    if (!to) return Promise.resolve({ sent: false });
    const body = mailer.compose({
        heading, intro,
        paragraphs: ['If this was not you, reset your password at once, or contact the Municipal Tourism Office.'],
        footer: FOOTER
    });
    return mailer.sendMail({ to, subject: `ZTIMS: ${heading}`, ...body });
}

/* Uses an emailed token: the visitor it was for, or null. Marks it used. */
async function spendEmailToken(token, purpose, client) {
    if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return null;
    const { rows } = await query(`
        update visitor_tokens set used_at = now()
         where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now()
        returning visitor_id`, [hashToken(token), purpose], client);
    if (!rows[0]) return null;
    const { rows: v } = await query(`select * from visitors where id = $1 and status = 'active' for update`, [rows[0].visitor_id], client);
    return v[0] || null;
}

/* ------------------------------------------------------------------ router */

function visitorsRouter({ sharedRateLimit, emailTakenBy, siteOrigin }) {
    const router = express.Router();
    const limiter = (name, windowMs, limit, message, extra = {}) => sharedRateLimit(name, {
        windowMs, limit, message: { success: false, message }, ...extra
    });
    const signUpLimit = limiter('visitor-sign-up', 60 * 60 * 1000, 5, 'Too many sign-ups from this connection. Please wait a while.');
    // Only failed sign-ins count, as for staff (a town hall shares one address).
    const signInLimit = limiter('visitor-sign-in', 15 * 60 * 1000, 10, 'Too many tries. Please wait 15 minutes, or reset your password.', { skipSuccessfulRequests: true });
    const mailLimit = limiter('visitor-mail', 15 * 60 * 1000, 5, 'Too many emails asked for. Please wait a few minutes.');
    const linkLimit = limiter('visitor-link', 15 * 60 * 1000, 20, 'Too many tries. Please wait a few minutes.');
    const googleLimit = limiter('visitor-google', 15 * 60 * 1000, 20, 'Too many tries. Please wait a few minutes.');
    const ownLimit = limiter('visitor-own-password', 15 * 60 * 1000, 10, 'Too many wrong passwords. Please wait a few minutes.', {
        skipSuccessfulRequests: true, keyGenerator: req => `visitor:${req.visitor ? req.visitor.id : req.ip}`
    });

    const fail = (res, error, label) => {
        if (error && error.status) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
        console.error(label, error);
        return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    };

    async function signedIn(row, res, extra = {}) {
        const linked = await linkOldRecords(row);
        const { rows } = await query('update visitors set last_sign_in_at = now() where id = $1 returning *', [row.id]);
        return res.json({ success: true, token: createVisitorToken(rows[0]), visitor: profile(rows[0]), linked, ...extra });
    }

    async function findByEmail(email, client) {
        const { rows } = await query(`select * from visitors where lower(email) = $1 and status <> 'deleted'`, [email], client);
        return rows[0] || null;
    }

    /* ---- sign up, verify, sign in ---------------------------------- */

    router.post('/visitors/sign-up', signUpLimit, async (req, res) => {
        try {
            const b = req.body || {};
            const fullName = String(b.fullName || '').trim().replace(/\s+/g, ' ');
            const email = normaliseEmail(b.email);
            const password = String(b.password || '');
            if (fullName.length < 2 || fullName.length > 120) throw problem(400, 'Give your full name.');
            if (!looksLikeEmail(email)) throw problem(400, 'Give a valid email address.');
            if (b.consent !== true) throw problem(400, 'Agree to the Terms and the Privacy Policy to create an account.');
            const weak = passwordProblem(password, { email });
            if (weak) throw problem(400, weak);
            if (await emailTakenBy(email)) throw problem(409, 'This email is used by a staff account. Use another email.');
            const hash = await bcrypt.hash(password, 12);
            const existing = await findByEmail(email);
            let row;
            if (existing && existing.email_verified_at) {
                throw problem(409, 'An account with this email already exists. Sign in, or reset your password.', 'EMAIL_TAKEN');
            } else if (existing) {
                // Never verified: whoever proves the mailbox owns it, so the
                // unproven details are replaced and a new link is sent.
                ({ rows: [row] } = await query(`update visitors set full_name = $2, password_hash = $3, session_version = session_version + 1
                                                 where id = $1 returning *`, [existing.id, fullName, hash]));
            } else {
                ({ rows: [row] } = await query(`insert into visitors (email, full_name, password_hash) values ($1, $2, $3) returning *`,
                    [email, fullName, hash]));
            }
            const sent = await sendVerifyEmail(row, siteOrigin(req));
            return res.status(201).json({
                success: true, emailed: sent.sent,
                message: 'Account created. Open the link we emailed you to confirm your address.'
            });
        } catch (error) { return fail(res, error, '❌ Visitor sign-up failure:'); }
    });

    router.post('/visitors/verify', linkLimit, async (req, res) => {
        try {
            const row = await transaction(async client => {
                const v = await spendEmailToken((req.body || {}).token, 'verify', client);
                if (!v) throw problem(400, 'This link has expired or was already used. Sign in to get a new one.');
                const { rows } = await query(`update visitors set email_verified_at = coalesce(email_verified_at, now()) where id = $1 returning *`, [v.id], client);
                return rows[0];
            });
            return signedIn(row, res, { message: 'Your email is confirmed.' });
        } catch (error) { return fail(res, error, '❌ Visitor verify failure:'); }
    });

    /* A new confirmation link. The same answer whether or not the email has an
       account waiting, so this tells nobody who is registered. */
    router.post('/visitors/verify/resend', mailLimit, async (req, res) => {
        try {
            const email = normaliseEmail((req.body || {}).email);
            const row = looksLikeEmail(email) ? await findByEmail(email) : null;
            if (row && !row.email_verified_at && row.status === 'active') await sendVerifyEmail(row, siteOrigin(req));
            return res.json({ success: true, message: 'If that email has an account waiting to be confirmed, a new link is on its way.' });
        } catch (error) { return fail(res, error, '❌ Visitor resend failure:'); }
    });

    router.post('/visitors/sign-in', signInLimit, async (req, res) => {
        try {
            const email = normaliseEmail((req.body || {}).email);
            const password = String((req.body || {}).password || '');
            const row = looksLikeEmail(email) ? await findByEmail(email) : null;
            // The password first, against a stand-in for an unknown email, so
            // nothing about the account is told to someone without it.
            const good = await bcrypt.compare(password, (row && row.password_hash) || NO_ACCOUNT_HASH);
            if (!row || !row.password_hash || !good) {
                const googleOnly = row && !row.password_hash && row.google_sub;
                throw problem(401, googleOnly ? 'This account signs in with Google.' : 'The email or password is not right.');
            }
            if (row.status !== 'active') throw problem(403, 'This account cannot sign in. Contact the Municipal Tourism Office.');
            if (!row.email_verified_at) {
                await sendVerifyEmail(row, siteOrigin(req));
                throw problem(403, 'Confirm your email address first. We have sent you a new link.', 'EMAIL_NOT_VERIFIED');
            }
            return signedIn(row, res);
        } catch (error) { return fail(res, error, '❌ Visitor sign-in failure:'); }
    });

    /* Google: sign in, or create the account. `password` joins it to an
       existing verified password account. */
    router.post('/visitors/google', googleLimit, async (req, res) => {
        try {
            const google = await verifyGoogleCredential((req.body || {}).credential);
            if (await emailTakenBy(google.email)) throw problem(409, 'This email is used by a staff account. Use another Google account.');
            const row = await transaction(async client => {
                const { rows: bySub } = await query(`select * from visitors where google_sub = $1 and status <> 'deleted' for update`, [google.sub], client);
                if (bySub[0]) {
                    if (bySub[0].status !== 'active') throw problem(403, 'This account cannot sign in. Contact the Municipal Tourism Office.');
                    return bySub[0];
                }
                const existing = await findByEmail(google.email, client);
                if (!existing) {
                    const { rows } = await query(`insert into visitors (email, full_name, google_sub, email_verified_at) values ($1, $2, $3, now()) returning *`,
                        [google.email, google.name, google.sub], client);
                    return rows[0];
                }
                if (existing.status !== 'active') throw problem(403, 'This account cannot sign in. Contact the Municipal Tourism Office.');
                if (existing.google_sub) throw problem(409, 'This email is already joined to another Google account.');
                if (existing.email_verified_at && existing.password_hash) {
                    const typed = String((req.body || {}).password || '');
                    if (!typed) throw problem(409, 'You already have an account with this email. Enter its password once to join Google to it.', 'LINK_NEEDS_PASSWORD');
                    if (!(await bcrypt.compare(typed, existing.password_hash))) throw problem(401, 'That password is not right.', 'LINK_NEEDS_PASSWORD');
                }
                // Never verified: Google has proven the mailbox; a password set
                // by whoever made the unproven account is dropped.
                const keepPassword = Boolean(existing.email_verified_at);
                const { rows } = await query(`
                    update visitors set google_sub = $2, email_verified_at = coalesce(email_verified_at, now()),
                           full_name = case when full_name = '' then $3 else full_name end,
                           password_hash = case when $4 then password_hash else null end,
                           session_version = session_version + case when $4 then 0 else 1 end
                     where id = $1 returning *`, [existing.id, google.sub, google.name, keepPassword], client);
                return rows[0];
            });
            return signedIn(row, res);
        } catch (error) { return fail(res, error, '❌ Visitor Google sign-in failure:'); }
    });

    /* What the sign-in page needs to show the Google button: the public
       client id, from the server (never typed into a page). */
    router.get('/visitors/config', (req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.json({ googleClientId: String(process.env.GOOGLE_CLIENT_ID || '').trim() || null });
    });

    /* ---- forgot and reset ------------------------------------------ */

    router.post('/visitors/forgot', mailLimit, async (req, res) => {
        try {
            const email = normaliseEmail((req.body || {}).email);
            if (!mailer.mailConfigured()) throw problem(503, 'Password reset email is not set up yet. Please contact the Municipal Tourism Office.');
            const row = looksLikeEmail(email) ? await findByEmail(email) : null;
            if (row && row.status === 'active') await sendResetEmail(row, siteOrigin(req));
            return res.json({ success: true, message: 'If that email has an account, a link to choose a new password is on its way.' });
        } catch (error) { return fail(res, error, '❌ Visitor forgot failure:'); }
    });

    /* The link proves the mailbox, so it also confirms the email. Every
       sign-in from before ends. */
    router.post('/visitors/reset', linkLimit, async (req, res) => {
        try {
            const b = req.body || {};
            const password = String(b.password || '');
            const row = await transaction(async client => {
                const v = await spendEmailToken(b.token, 'reset', client);
                if (!v) throw problem(400, 'This link has expired or was already used. Ask for a new one.');
                const weak = passwordProblem(password, { email: v.email });
                if (weak) throw problem(400, weak);
                const { rows } = await query(`
                    update visitors set password_hash = $2, email_verified_at = coalesce(email_verified_at, now()),
                           session_version = session_version + 1 where id = $1 returning *`, [v.id, await bcrypt.hash(password, 12)], client);
                return rows[0];
            });
            sendSecurityNotice(row.email, 'Your password was changed', 'The password for your ZTIMS account was changed with a reset link.');
            return signedIn(row, res, { message: 'Your new password is saved.' });
        } catch (error) { return fail(res, error, '❌ Visitor reset failure:'); }
    });

    /* ---- the account ------------------------------------------------ */

    router.get('/visitors/me', requireVisitor, (req, res) => res.json({ success: true, visitor: profile(req.visitor) }));

    router.patch('/visitors/me', requireVisitor, async (req, res) => {
        try {
            const b = req.body || {};
            const v = req.visitor;
            const fullName = b.fullName === undefined ? v.full_name : String(b.fullName).trim().replace(/\s+/g, ' ');
            if (fullName.length < 2 || fullName.length > 120) throw problem(400, 'Give your full name.');
            const phone = b.phone === undefined ? v.phone : String(b.phone).trim();
            if (phone && (phone.replace(/[^0-9]/g, '').length < 7 || phone.length > 40)) throw problem(400, 'Give a phone number we can call.');
            let countryCode = b.countryCode === undefined ? v.country_code : (String(b.countryCode || '') || null);
            if (countryCode) {
                const { rows } = await query('select code from residences where code = $1', [countryCode]);
                if (!rows.length) throw problem(400, 'Choose the country where you live.');
            }
            const { rows } = await query('update visitors set full_name = $2, phone = $3, country_code = $4 where id = $1 returning *',
                [v.id, fullName, phone, countryCode]);
            return res.json({ success: true, message: 'Saved.', visitor: profile(rows[0]) });
        } catch (error) { return fail(res, error, '❌ Visitor profile failure:'); }
    });

    /* Change (or, for a Google-only account, set) the password. Google-only
       needs a fresh Google sign-in instead of a current password. */
    router.post('/visitors/me/password', requireVisitor, ownLimit, async (req, res) => {
        try {
            const b = req.body || {};
            const v = req.visitor;
            await proveItIsThem(v, b);
            const weak = passwordProblem(String(b.newPassword || ''), { email: v.email });
            if (weak) throw problem(400, weak);
            const { rows } = await query('update visitors set password_hash = $2, session_version = session_version + 1 where id = $1 returning *',
                [v.id, await bcrypt.hash(String(b.newPassword), 12)]);
            sendSecurityNotice(v.email, 'Your password was changed', 'The password for your ZTIMS account was changed while signed in.');
            return res.json({ success: true, message: 'Password changed. Other devices are signed out.', token: createVisitorToken(rows[0]) });
        } catch (error) { return fail(res, error, '❌ Visitor password failure:'); }
    });

    router.post('/visitors/me/sign-out-everywhere', requireVisitor, async (req, res) => {
        try {
            await query('update visitors set session_version = session_version + 1 where id = $1', [req.visitor.id]);
            return res.json({ success: true, message: 'Signed out on every device.' });
        } catch (error) { return fail(res, error, '❌ Visitor sign-out failure:'); }
    });

    /* The account's password, or a Google sign-in made in the last ten minutes
       by the same Google account. */
    async function proveItIsThem(v, b) {
        if (v.password_hash) {
            const typed = String(b.currentPassword || b.password || '');
            if (!typed || !(await bcrypt.compare(typed, v.password_hash))) throw problem(403, 'That password is not right.', 'CONFIRM_PASSWORD');
            return;
        }
        if (!b.credential) throw problem(428, 'Sign in with Google again to confirm.', 'CONFIRM_GOOGLE');
        const google = await verifyGoogleCredential(b.credential);
        if (google.sub !== v.google_sub || Date.now() / 1000 - google.issuedAt > 600) {
            throw problem(403, 'Sign in again with the Google account joined to this account.', 'CONFIRM_GOOGLE');
        }
    }

    /* Deletes the account: the person's details go; the row stays, so old
       tickets, bookings and reviews still point somewhere. */
    router.delete('/visitors/me', requireVisitor, ownLimit, async (req, res) => {
        try {
            const v = req.visitor;
            await proveItIsThem(v, req.body || {});
            await transaction(async client => {
                await query(`update visitor_tokens set used_at = now() where visitor_id = $1 and used_at is null`, [v.id], client);
                await query('delete from saved_places where visitor_id = $1', [v.id], client);
                await query(`
                    update visitors set email = null, full_name = '', phone = '', country_code = null, password_hash = null,
                           google_sub = null, status = 'deleted', deleted_at = now(), session_version = session_version + 1
                     where id = $1`, [v.id], client);
            });
            console.log('🗑️  A visitor deleted their account.');
            return res.json({ success: true, message: 'Your account is deleted.' });
        } catch (error) { return fail(res, error, '❌ Visitor delete failure:'); }
    });

    /* ---- what the account holds ------------------------------------ */

    router.get('/visitors/me/tickets', requireVisitor, async (req, res) => {
        try {
            const { rows } = await query(`
                select t.id, t.code, t.visit_date, t.people, t.amount, t.status, t.created_at, s.id as spot_id, s.title as spot_title
                  from tickets t join spots s on s.id = t.spot_id
                 where t.visitor_id = $1 and t.status <> 'pending_payment'
                 order by t.visit_date desc, t.created_at desc limit 200`, [req.visitor.id]);
            return res.json(rows.map(t => ({
                _id: t.id, code: t.code, visitDate: t.visit_date, people: t.people, amount: Number(t.amount), status: t.status,
                spot: { _id: t.spot_id, title: t.spot_title }, createdAt: t.created_at
            })));
        } catch (error) { return fail(res, error, '❌ Visitor tickets failure:'); }
    });

    router.get('/visitors/me/bookings', requireVisitor, async (req, res) => {
        try {
            const { rows } = await query(`
                select b.id, b.code, b.check_in, b.check_out, b.nights, b.adults, b.children, b.status, b.total_amount, b.created_at,
                       s.id as spot_id, s.title as spot_title, coalesce(nullif(s.enterprise_name, ''), s.title) as enterprise_name
                  from bookings b join spots s on s.id = b.spot_id
                 where b.visitor_id = $1
                 order by b.check_in desc, b.created_at desc limit 200`, [req.visitor.id]);
            return res.json(rows.map(b => ({
                _id: b.id, code: b.code, checkIn: b.check_in, checkOut: b.check_out, nights: b.nights, adults: b.adults, children: b.children,
                status: b.status, totalAmount: Number(b.total_amount), spot: { _id: b.spot_id, title: b.spot_title },
                enterpriseName: b.enterprise_name, createdAt: b.created_at
            })));
        } catch (error) { return fail(res, error, '❌ Visitor bookings failure:'); }
    });

    router.get('/visitors/me/saved', requireVisitor, async (req, res) => {
        try {
            const { rows } = await query(`
                select s.id, s.title, s.barangay, s.category, s.type, sp.created_at,
                       (select url from spot_photos p where p.spot_id = s.id order by p.position limit 1) as photo
                  from saved_places sp join spots s on s.id = sp.spot_id
                 where sp.visitor_id = $1 and s.status = 'published'
                 order by sp.created_at desc`, [req.visitor.id]);
            return res.json(rows.map(s => ({ _id: s.id, title: s.title, barangay: s.barangay, category: s.category, type: s.type, photo: s.photo, savedAt: s.created_at })));
        } catch (error) { return fail(res, error, '❌ Saved places failure:'); }
    });

    router.put('/visitors/me/saved/:spotId', requireVisitor, async (req, res) => {
        try {
            if (!isId(req.params.spotId)) throw problem(404, 'That place could not be found.');
            const { rows } = await query(`select id from spots where id = $1 and status = 'published'`, [req.params.spotId]);
            if (!rows.length) throw problem(404, 'That place could not be found.');
            await query('insert into saved_places (visitor_id, spot_id) values ($1, $2) on conflict do nothing', [req.visitor.id, rows[0].id]);
            return res.json({ success: true, saved: true });
        } catch (error) { return fail(res, error, '❌ Save place failure:'); }
    });

    router.delete('/visitors/me/saved/:spotId', requireVisitor, async (req, res) => {
        try {
            await query('delete from saved_places where visitor_id = $1 and spot_id = $2', [req.visitor.id, String(req.params.spotId)]);
            return res.json({ success: true, saved: false });
        } catch (error) { return fail(res, error, '❌ Unsave place failure:'); }
    });

    router.get('/visitors/me/reviews', requireVisitor, async (req, res) => {
        try {
            const { rows } = await query(`
                select r.id, r.rating, r.body, r.status, r.created_at, r.updated_at, s.id as spot_id, s.title as spot_title
                  from reviews r join spots s on s.id = r.spot_id
                 where r.visitor_id = $1 order by r.updated_at desc`, [req.visitor.id]);
            return res.json(rows.map(r => ({
                _id: r.id, rating: r.rating, body: r.body, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
                spot: { _id: r.spot_id, title: r.spot_title }
            })));
        } catch (error) { return fail(res, error, '❌ Visitor reviews failure:'); }
    });

    return router;
}

module.exports = visitorsRouter;
module.exports.requireVisitor = requireVisitor;
module.exports.checkoutDetails = checkoutDetails;
module.exports.linkOldRecords = linkOldRecords;
module.exports.verifyGoogleCredential = verifyGoogleCredential;
module.exports.FORMER_VISITOR = FORMER_VISITOR;
module.exports.ROLE = ROLE;
