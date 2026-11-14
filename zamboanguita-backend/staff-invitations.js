/* Staff invitations (14 November 2026), the user's decision.

   When the Tourism Officer adds a Tourism Officer, Enterprise Manager or
   Support Staff account, they choose how the person gets in:
   - an invitation link (the default): the person is emailed a link and chooses
     their own password on src/staff/accept_invite.html. Nobody else ever knows
     it. The officer can also copy the link, for when the email fails or the
     person is in the office;
   - a password now (the earlier method, unchanged): the officer types or
     generates one, it is shown once, and must_change_password makes the person
     replace it at their first sign-in.

   Rules:
   - A token is 32 random bytes; only its sha-256 hash is stored
     (staff_invitations). Each is single-use and runs out after 72 hours.
   - An invited account has no usable password until the link is used: its
     password_hash is the hash of a random secret nobody ever sees, and the
     sign-in route also refuses it while an invitation is open, as a wrong
     password.
   - Resending replaces the earlier token, so the old link stops working.
   - Any password set for the account (the link, a reset link, the officer
     issuing one) spends its open invitations (storePassword in server.js).
   - An expired, used or unknown token gets one message, whatever the reason.
   - A failed email is logged and never undoes the account: the officer is
     told to copy the link instead. */
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { query, transaction } = require('./db');
const mailer = require('./mailer');

const TTL_HOURS = 72;

// The account kinds an officer invites: the address part of the resend route,
// the table, the token role, and the words used for them.
const KINDS = {
    officer: { table: 'tourism_officers', role: 'admin', label: 'Tourism Officer' },
    manager: { table: 'establishment_managers', role: 'establishment_manager', label: 'Enterprise Manager' },
    support: { table: 'support_staff', role: 'support_staff', label: 'Support Staff' }
};
const KIND_OF_TABLE = Object.fromEntries(Object.entries(KINDS).map(([kind, k]) => [k.table, kind]));

const INVALID_LINK = 'This invitation link is no longer valid. Ask the Tourism Office for a new one.';
const EMAIL_FAILED = 'Email could not be sent. Copy the link instead.';

const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');

/* What an invited account keeps as its password until the link is used: the
   hash of a random secret that is thrown away at once, so no password can
   ever match it. */
async function unusablePasswordHash() {
    return bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
}

function siteUrl(req) {
    const configured = String(process.env.PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
    return configured || `${req.protocol}://${req.get('host')}`;
}

// The link carries the token and nothing else: never the email.
const linkFor = (req, token) => `${siteUrl(req)}/src/staff/accept_invite.html?token=${token}`;

/* A fresh token for the account. Any earlier unused one is removed in the same
   step, so its link stops working. Returns { token, expiresAt }. */
async function issueToken(kind, accountId, createdByEmail, client) {
    const table = KINDS[kind].table;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);
    await query('delete from staff_invitations where account_table = $1 and account_id = $2 and used_at is null',
        [table, String(accountId)], client);
    await query(
        `insert into staff_invitations (account_table, account_id, token_hash, expires_at, created_by_email)
         values ($1, $2, $3, $4, $5)`,
        [table, String(accountId), hashToken(token), expiresAt, String(createdByEmail || '')], client);
    return { token, expiresAt };
}

const manilaTime = date => new Date(date).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila', dateStyle: 'long', timeStyle: 'short'
}) + ' (Philippine time)';

/* The invitation email, in the site's colours (mailer.compose). Resolves true
   when it left; never throws. */
async function sendInvitation({ kind, email, name, place, link, expiresAt, invitedBy }) {
    const label = KINDS[kind].label;
    const rows = [['Account', label], ['Sign-in email', email]];
    if (place) rows.push([kind === 'support' ? 'Attraction' : 'Place', place]);
    rows.push(['Link works until', manilaTime(expiresAt)]);
    const { text, html } = mailer.compose({
        heading: 'You are invited to ZTIMS',
        intro: `${invitedBy || 'The Municipal Tourism Office'} created a ${label} account for ${name || 'you'} on ZTIMS, the Zamboanguita Tourism Information Management System.`,
        rows,
        paragraphs: [
            'Open the link to choose your own password. It works once. Nobody at the office will know your password.',
            'If you were not expecting this, ignore this email. Nothing happens until the link is used.'
        ],
        link: { label: 'Set your password', url: link },
        footer: 'Municipal Tourism Office, Zamboanguita, Negros Oriental. An invitation to a ZTIMS staff account.'
    });
    const result = await mailer.sendMail({ to: email, subject: 'ZTIMS: you are invited', text, html });
    if (!result.sent) console.error(`❌ Invitation email not sent (${result.reason}); the officer can copy the link.`);
    return Boolean(result.sent);
}

/* Issues a token, emails it and returns what the officer's page shows: the
   link (to copy), whether the email left, and when the link runs out. */
async function offerInvitation(req, { kind, accountId, email, name, place }) {
    const invitedBy = (req.account && (req.account.full_name || req.account.email)) || '';
    const { token, expiresAt } = await issueToken(kind, accountId, req.account && req.account.email);
    const inviteLink = linkFor(req, token);
    const emailSent = await sendInvitation({ kind, email, name, place, link: inviteLink, expiresAt, invitedBy });
    return {
        method: 'invite', inviteLink, emailSent, expiresAt,
        emailMessage: emailSent ? `An invitation was emailed to ${email}.` : EMAIL_FAILED
    };
}

/* Accounts of one table still waiting on their invitation: id → { expiresAt,
   expired }. For the officer's lists. */
async function pendingInvitations(table) {
    const { rows } = await query(
        `select account_id, max(expires_at) as expires_at from staff_invitations
          where account_table = $1 and used_at is null group by account_id`, [table]);
    const now = Date.now();
    return new Map(rows.map(r => [r.account_id, { expiresAt: r.expires_at, expired: new Date(r.expires_at).getTime() <= now }]));
}

/* The fields every list row gets, from pendingInvitations. */
const inviteFields = (pending, id) => {
    const p = pending.get(String(id));
    return { invitePending: Boolean(p), inviteExpiresAt: p ? p.expiresAt : null, inviteExpired: Boolean(p && p.expired) };
};

async function hasOpenInvitation(table, accountId) {
    const { rows } = await query(
        'select 1 from staff_invitations where account_table = $1 and account_id = $2 and used_at is null limit 1',
        [table, String(accountId)]);
    return rows.length > 0;
}

/* Called whenever a password is set for an account another way: its open
   invitations are spent, so the account is no longer "waiting". */
async function spendInvitations(table, accountId, client) {
    await query(
        'update staff_invitations set used_at = now() where account_table = $1 and account_id = $2 and used_at is null',
        [table, String(accountId)], client);
}

// Whether an account may still be let in: a deactivated officer or Support
// Staff member, or a suspended manager, gets the same "no longer valid".
const isUsable = (table, row) => table === 'support_staff' ? row.status === 'active' : row.active !== false;

const NAME_COLUMN = { tourism_officers: 'full_name', establishment_managers: 'manager_name', support_staff: 'full_name' };

/* The open invitation behind a token, with its account, or null. `client` and
   `lock`: inside the accept transaction, so two uses of one link cannot both
   succeed. */
async function openInvitation(token, client, lock) {
    if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return null;
    const { rows } = await query(
        `select * from staff_invitations where token_hash = $1 and used_at is null and expires_at > now()${lock ? ' for update' : ''}`,
        [hashToken(token)], client);
    const invitation = rows[0];
    if (!invitation || !KIND_OF_TABLE[invitation.account_table]) return null;
    const table = invitation.account_table;
    const found = await query(`select * from ${table} where id = $1${lock ? ' for update' : ''}`, [invitation.account_id], client);
    const account = found.rows[0];
    if (!account || !isUsable(table, account)) return null;
    return { invitation, account, table, kind: KIND_OF_TABLE[table] };
}

function invitationsRouter(deps) {
    const { requireAdmin, requirePasswordConfirmation, sharedRateLimit, passwordProblem, reportWriteFailure } = deps;
    const router = express.Router();

    // Guessing a 256-bit token is hopeless, but the page is public: keep it calm.
    const linkRateLimit = sharedRateLimit('staff-invite', {
        windowMs: 15 * 60 * 1000,
        limit: 30,
        message: { success: false, message: 'Too many attempts. Please wait a few minutes and try again.' }
    });

    /* What the page shows above the password boxes: who the link is for. The
       token already proves the person holds the invitation. */
    router.post('/invitations/check', linkRateLimit, async (req, res) => {
        try {
            const found = await openInvitation((req.body || {}).token);
            if (!found) return res.status(400).json({ success: false, code: 'INVALID_INVITATION', message: INVALID_LINK });
            return res.json({
                success: true,
                email: found.account.email,
                name: found.account[NAME_COLUMN[found.table]] || '',
                account: KINDS[found.kind].label,
                expiresAt: found.invitation.expires_at
            });
        } catch (error) { return reportWriteFailure(res, error, '❌ Invitation check failure:'); }
    });

    /* The person sets their own password: it is checked by passwords.js, the
       token is spent, must_change_password is cleared and session_version goes
       up. A weak password leaves the link usable, so they can try again. */
    router.post('/invitations/accept', linkRateLimit, async (req, res) => {
        try {
            const { token, password } = req.body || {};
            const outcome = await transaction(async client => {
                const found = await openInvitation(token, client, true);
                if (!found) return { status: 400, body: { success: false, code: 'INVALID_INVITATION', message: INVALID_LINK } };
                const weak = passwordProblem(String(password || ''), { email: found.account.email });
                if (weak) return { status: 400, body: { success: false, code: 'WEAK_PASSWORD', message: weak } };
                const hash = await bcrypt.hash(String(password), 12);
                await query(
                    `update ${found.table}
                        set password_hash = $2, reset_token_hash = null, reset_token_expires = null,
                            must_change_password = false, session_version = session_version + 1
                      where id = $1`, [found.account.id, hash], client);
                await spendInvitations(found.table, found.account.id, client);
                console.log(`🔑 Invitation accepted: ${KINDS[found.kind].label} ${found.account.email}`);
                return { status: 200, body: { success: true, message: 'Your password is set. Sign in with it now.', email: found.account.email } };
            });
            return res.status(outcome.status).json(outcome.body);
        } catch (error) { return reportWriteFailure(res, error, '❌ Invitation accept failure:'); }
    });

    /* The officer sends a new link to someone who has not accepted yet. The
       earlier link stops working. Asks for the officer's password. */
    router.post('/invitations/:kind/:id/resend', requireAdmin, requirePasswordConfirmation, async (req, res) => {
        try {
            const kind = KINDS[req.params.kind] ? req.params.kind : null;
            if (!kind || !/^[0-9a-f]{24}$/i.test(req.params.id)) {
                return res.status(404).json({ success: false, message: 'That account no longer exists.' });
            }
            const table = KINDS[kind].table;
            const { rows } = await query(`select * from ${table} where id = $1`, [req.params.id]);
            const account = rows[0];
            if (!account) return res.status(404).json({ success: false, message: 'That account no longer exists.' });
            if (!isUsable(table, account)) {
                return res.status(409).json({ success: false, message: 'Reactivate the account first.' });
            }
            if (!(await hasOpenInvitation(table, account.id))) {
                return res.status(409).json({ success: false, code: 'ALREADY_ACCEPTED', message: 'This person has already set their password. Use New password instead.' });
            }
            let place = '';
            if (kind === 'support') {
                const spot = await query('select title from spots where id = $1', [account.spot_id]);
                place = spot.rows[0] ? spot.rows[0].title : '';
            }
            const offer = await offerInvitation(req, {
                kind, accountId: account.id, email: account.email, name: account[NAME_COLUMN[table]], place
            });
            console.log(`✉️ Invitation resent: ${KINDS[kind].label} ${account.email}`);
            return res.json({ success: true, message: 'A new invitation link was made. The earlier link no longer works.', email: account.email, ...offer });
        } catch (error) { return reportWriteFailure(res, error, '❌ Invitation resend failure:'); }
    });

    return router;
}

module.exports = {
    TTL_HOURS, KINDS, INVALID_LINK, EMAIL_FAILED,
    unusablePasswordHash, offerInvitation, pendingInvitations, inviteFields,
    hasOpenInvitation, spendInvitations, invitationsRouter,
    // createMethod: the request's choice, the invitation unless it says otherwise.
    createMethod: body => ((body || {}).method === 'password' ? 'password' : 'invite')
};
