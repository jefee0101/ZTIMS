/* Support Staff accounts (9 November 2026), mounted at /api.

   A Support Staff member is a person of the Municipal Tourism Office who looks
   after one attraction the office runs (no manager) whose "Count visitors
   here" is on: its Guest Register, its monthly report and its listing details
   except category and prices. The user's decisions:
   - The Tourism Officer adds, issues a password, deactivates or reactivates,
     each with the officer's own password again (requirePasswordConfirmation),
     like Tourism Office Accounts. Accounts are never deleted.
   - One active account per attraction (support_staff_one_active_per_spot). To
     replace someone, the officer deactivates the old account and adds a new
     one; the old reports keep the earlier person's email.
   - A blank password is generated and shown once; it is replaced at the
     first sign-in (must_change_password). The person is emailed when the
     account is added or a password is issued (alertAccountOwner).
   - Deactivating ends every open session at once (session_version, and
     requireAuth refuses an inactive account on every route).
   No tickets, money, Finalize / Reopen, closed dates or deletes here. */
const express = require('express');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('./db');
const { passwordProblem, generatePassword } = require('./passwords');

const isId = value => /^[0-9a-f]{24}$/i.test(String(value || ''));
const looksLikeEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const problem = (status, message, code) => Object.assign(new Error(message), { status, code });

/* What the officer's list and the person's own page show: never a hash. */
const view = row => ({
    _id: row.id, email: row.email, fullName: row.full_name, position: row.position,
    contactNumber: row.contact_number, status: row.status, lastSignInAt: row.last_sign_in_at,
    createdAt: row.created_at, createdByEmail: row.created_by_email,
    mustChangePassword: Boolean(row.must_change_password),
    spot: row.spot_title === undefined ? undefined : {
        _id: row.spot_id, title: row.spot_title, barangay: row.spot_barangay,
        status: row.spot_status, countsVisitors: row.spot_counts_visitors
    }
});

const SELECT = `
    select ss.*, s.title as spot_title, s.barangay as spot_barangay, s.status as spot_status,
           s.counts_visitors as spot_counts_visitors
      from support_staff ss join spots s on s.id = ss.spot_id`;

/* The attraction a Support Staff member may be given: the office's (no
   manager), a place visitors come to (not a place to stay) and published.
   Giving it someone switches its "Count visitors here" on (10 November
   2026): an office attraction counts visitors only through its Support Staff. */
async function assignableSpot(spotId, client) {
    if (!isId(spotId)) throw problem(400, 'Choose the attraction.');
    const { rows } = await query(
        'select id, title, type, status, managed_by, counts_visitors from spots where id = $1', [String(spotId)], client);
    const spot = rows[0];
    if (!spot) throw problem(404, 'That attraction could not be found.');
    if (spot.managed_by) throw problem(400, 'That place is run by a private enterprise. Its manager keeps its records.');
    if (spot.type !== 'spot') throw problem(400, 'Support Staff look after an attraction, not a place to stay.');
    if (spot.status !== 'published') throw problem(400, 'That attraction is not published.');
    return spot;
}

async function activeOn(spotId, exceptId, client) {
    const { rows } = await query(
        `select full_name, email from support_staff where spot_id = $1 and status = 'active' and id <> $2 limit 1`,
        [String(spotId), String(exceptId || '')], client);
    return rows[0] || null;
}

module.exports = function supportStaffRouter(deps) {
    const {
        requireAdmin, requirePasswordConfirmation, requireSupportStaff, ownPasswordRateLimit, changeOwnPassword,
        emailTakenBy, storePassword, endSessions, alertAccountOwner, reportWriteFailure
    } = deps;
    const router = express.Router();
    const fail = (res, error, label) => {
        if (error && error.status) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
        if (error && error.code === 11000) return res.status(409).json({ success: false, message: 'That attraction already has active Support Staff.' });
        return reportWriteFailure(res, error, label);
    };
    const officerEmail = req => (req.account && req.account.email) || 'the Tourism Officer';

    /* ---- the Support Staff member (first: /me must not be read as an :id) */

    router.get('/support-staff/me', requireSupportStaff, async (req, res) => {
        try {
            const { rows } = await query(`${SELECT} where ss.id = $1`, [req.account.id]);
            if (!rows.length) throw problem(404, 'Account not found.');
            return res.json(view(rows[0]));
        } catch (error) { return fail(res, error, '❌ Support Staff profile failure:'); }
    });

    // Name, position and contact number. The sign-in email and the attraction
    // are the officer's to set.
    router.patch('/support-staff/me', requireSupportStaff, async (req, res) => {
        try {
            const b = req.body || {};
            const fullName = String(b.fullName ?? '').trim();
            const position = String(b.position ?? '').trim();
            const contactNumber = String(b.contactNumber ?? '').trim();
            if (!fullName) throw problem(400, 'Your full name is required.');
            if (fullName.length > 120 || position.length > 120) throw problem(400, 'Name and position are limited to 120 characters.');
            if (contactNumber.length > 40) throw problem(400, 'The contact number is too long.');
            await query('update support_staff set full_name = $2, position = $3, contact_number = $4 where id = $1',
                [req.account.id, fullName, position, contactNumber]);
            return res.json({ success: true, message: 'Your details have been saved.', fullName, position, contactNumber });
        } catch (error) { return fail(res, error, '❌ Support Staff profile update failure:'); }
    });

    router.post('/support-staff/me/password', requireSupportStaff, ownPasswordRateLimit, changeOwnPassword);

    router.post('/support-staff/me/sign-out-everywhere', requireSupportStaff, async (req, res) => {
        try {
            await endSessions('support_staff', req.account.id);
            return res.json({ success: true, message: 'Every device signed in to your account has been signed out.' });
        } catch (error) { return fail(res, error, '❌ Support Staff sign out failure:'); }
    });

    /* ---- the Tourism Officer (Settings → Support Staff) --------------- */

    router.get('/support-staff', requireAdmin, async (req, res) => {
        try {
            const { rows } = await query(`${SELECT} order by (ss.status = 'active') desc, ss.full_name`);
            return res.json(rows.map(view));
        } catch (error) { return fail(res, error, '❌ Support Staff list failure:'); }
    });

    router.post('/support-staff', requireAdmin, requirePasswordConfirmation, async (req, res) => {
        try {
            const b = req.body || {};
            const email = String(b.email || '').trim().toLowerCase();
            const fullName = String(b.fullName || '').trim();
            const position = String(b.position || '').trim();
            const contactNumber = String(b.contactNumber || '').trim();
            if (!fullName || !email) throw problem(400, 'The full name and sign-in email are required.');
            if (!looksLikeEmail(email)) throw problem(400, 'That email does not look like an email address.');
            if (fullName.length > 120 || position.length > 120) throw problem(400, 'Name and position are limited to 120 characters.');
            if (contactNumber.length > 40) throw problem(400, 'The contact number is too long.');
            const password = String(b.password || '').trim() || generatePassword();
            const weak = passwordProblem(password, { email });
            if (weak) throw problem(400, weak);
            const takenBy = await emailTakenBy(email);
            if (takenBy) throw problem(409, `This email already signs in as ${takenBy}.`);

            const hash = await bcrypt.hash(password, 12);
            const row = await transaction(async client => {
                const spot = await assignableSpot(b.spotId, client);
                // Lock the attraction so two officers cannot both assign someone.
                await query('select id from spots where id = $1 for update', [spot.id], client);
                const other = await activeOn(spot.id, '', client);
                if (other) throw problem(409, `${spot.title} already has active Support Staff: ${other.full_name} (${other.email}). Deactivate that account first.`);
                const { rows } = await query(
                    `insert into support_staff (email, password_hash, full_name, position, contact_number, spot_id, must_change_password, created_by_email)
                     values ($1, $2, $3, $4, $5, $6, true, $7) returning *`,
                    [email, hash, fullName, position, contactNumber, spot.id, officerEmail(req)], client);
                await query('update spots set counts_visitors = true where id = $1', [spot.id], client);
                return { ...rows[0], spot_title: spot.title };
            });
            console.log(`🛡️ Support Staff account added for ${row.spot_title}: ${email}`);
            await alertAccountOwner(email, 'Your ZTIMS Support Staff account',
                `${officerEmail(req)} added a Support Staff account for you, for ${row.spot_title}. The Tourism Office will give you your first password; you will choose your own when you sign in.`);
            // The password is returned once so it can be passed on; only its hash is kept.
            return res.status(201).json({ success: true, message: 'Support Staff account added.', email, newPassword: password, _id: row.id });
        } catch (error) { return fail(res, error, '❌ Support Staff add failure:'); }
    });

    router.post('/support-staff/:id/password', requireAdmin, requirePasswordConfirmation, async (req, res) => {
        try {
            if (!isId(req.params.id)) throw problem(404, 'That account no longer exists.');
            const { rows } = await query('select id, email, status from support_staff where id = $1', [req.params.id]);
            if (!rows.length) throw problem(404, 'That account no longer exists.');
            if (rows[0].status !== 'active') throw problem(409, 'Reactivate the account first.');
            const newPassword = String((req.body || {}).newPassword || '').trim() || generatePassword();
            const weak = passwordProblem(newPassword, { email: rows[0].email });
            if (weak) throw problem(400, weak);
            await storePassword('support_staff', rows[0].id, newPassword, { issued: true });
            console.log(`🔑 Officer issued a new password for Support Staff ${rows[0].email}`);
            await alertAccountOwner(rows[0].email, 'A new password was issued for your account',
                `${officerEmail(req)} issued a new password for your ZTIMS Support Staff account. You will be asked to choose your own when you sign in.`);
            return res.json({ success: true, message: 'A new password has been set. Pass it on — it cannot be read again.', email: rows[0].email, newPassword });
        } catch (error) { return fail(res, error, '❌ Support Staff password issue failure:'); }
    });

    /* Deactivate (open sessions end at once) or reactivate (only while the
       attraction still qualifies and has nobody else active). */
    router.patch('/support-staff/:id/status', requireAdmin, requirePasswordConfirmation, async (req, res) => {
        try {
            if (!isId(req.params.id)) throw problem(404, 'That account no longer exists.');
            const active = (req.body || {}).active;
            if (typeof active !== 'boolean') throw problem(400, 'Say whether the account is active.');
            const message = await transaction(async client => {
                const { rows } = await query('select * from support_staff where id = $1 for update', [req.params.id], client);
                const row = rows[0];
                if (!row) throw problem(404, 'That account no longer exists.');
                if ((row.status === 'active') === active) return active ? 'The account is already active.' : 'The account is already deactivated.';
                if (active) {
                    const spot = await assignableSpot(row.spot_id, client);
                    await query('select id from spots where id = $1 for update', [spot.id], client);
                    const other = await activeOn(spot.id, row.id, client);
                    if (other) throw problem(409, `${spot.title} already has active Support Staff: ${other.full_name} (${other.email}).`);
                    await query(`update support_staff set status = 'active' where id = $1`, [row.id], client);
                    await query('update spots set counts_visitors = true where id = $1', [spot.id], client);
                    return 'The account has been reactivated.';
                }
                await query(`update support_staff set status = 'inactive' where id = $1`, [row.id], client);
                await endSessions('support_staff', row.id, client);
                return 'The account has been deactivated. It can no longer sign in.';
            });
            console.log(`🛡️ Support Staff ${req.params.id}: ${message}`);
            return res.json({ success: true, message });
        } catch (error) { return fail(res, error, '❌ Support Staff status failure:'); }
    });

    return router;
};
