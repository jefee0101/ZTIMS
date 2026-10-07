/* The Municipal Tourism Office's public contact details and emergency numbers.
 *
 * The officer keeps them on Settings → Office Information; the public site
 * reads them from GET /api/office (the footer on every visitor page, Contact
 * Us, and each destination's emergency box). Nothing here is personal data:
 * it is the office's own published contact information.
 *
 * Mounted at /api by server.js, which hands over its sign-in check.
 */
const express = require('express');
const { query, transaction } = require('./db');

const MAX_EMERGENCY = 12;
const clean = (value, max) => String(value ?? '').trim().slice(0, max);
const looksLikeEmail = value => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

async function readOffice() {
    const [{ rows: info }, { rows: numbers }] = await Promise.all([
        // `select *`: the Data Protection Officer columns read as blank on a
        // database that has not had schema.sql re-run yet, rather than failing.
        query('select * from office_info where id = 1'),
        query('select id, label, number from emergency_numbers order by position, created_at')
    ]);
    const row = info[0] || {};
    return {
        address: row.address || '', phone: row.phone || '', email: row.email || '',
        officeHours: row.office_hours || '', updatedAt: row.updated_at || null, updatedByEmail: row.updated_by_email || '',
        // The Data Protection Officer, published on the Privacy page as the
        // Data Privacy Act requires; and when the one-year erasure last ran.
        dpoName: row.dpo_name || '', dpoEmail: row.dpo_email || '', privacyCheckedAt: row.privacy_checked_at || null,
        emergency: numbers.map(n => ({ _id: n.id, label: n.label, number: n.number }))
    };
}

module.exports = function officeRouter({ requireAdmin }) {
    const router = express.Router();

    /* PUBLIC: what the visitor pages show. */
    router.get('/office', async (req, res) => {
        try {
            const office = await readOffice();
            delete office.updatedByEmail;
            delete office.privacyCheckedAt;
            res.set('Cache-Control', 'public, max-age=300');
            return res.json(office);
        } catch (error) {
            console.error('❌ Office information read failure:', error);
            return res.status(500).json({ success: false, message: 'The office information could not be loaded.' });
        }
    });

    /* The officer saves the whole set at once: details and the emergency list. */
    router.put('/office', requireAdmin, async (req, res) => {
        try {
            const body = req.body || {};
            const address = clean(body.address, 300);
            const phone = clean(body.phone, 40);
            const email = clean(body.email, 254).toLowerCase();
            const officeHours = clean(body.officeHours, 120);
            if (!looksLikeEmail(email)) return res.status(400).json({ success: false, message: 'The office email address does not look complete.' });

            const list = Array.isArray(body.emergency) ? body.emergency : [];
            if (list.length > MAX_EMERGENCY) return res.status(400).json({ success: false, message: `Up to ${MAX_EMERGENCY} emergency numbers.` });
            const emergency = [];
            for (const entry of list) {
                const label = clean(entry && entry.label, 80);
                const number = clean(entry && entry.number, 40);
                if (!label && !number) continue;           // an empty row left in the form
                if (!label || number.replace(/[^0-9]/g, '').length < 3) {
                    return res.status(400).json({ success: false, message: 'Each emergency number needs a name and a number.' });
                }
                emergency.push({ label, number });
            }

            const { rows } = await query('select email from tourism_officers where id = $1', [String(req.auth.sub)]);
            const by = rows[0] ? rows[0].email : '';
            await transaction(async client => {
                await query(`insert into office_info (id, address, phone, email, office_hours, updated_by_email)
                             values (1, $1, $2, $3, $4, $5)
                             on conflict (id) do update set address = $1, phone = $2, email = $3, office_hours = $4, updated_by_email = $5`,
                    [address, phone, email, officeHours, by], client);
                await query('delete from emergency_numbers', [], client);
                for (let i = 0; i < emergency.length; i++) {
                    await query('insert into emergency_numbers (label, number, position) values ($1, $2, $3)',
                        [emergency[i].label, emergency[i].number, i], client);
                }
            });
            return res.json({ success: true, message: 'Office information saved. The public site shows it now.', office: await readOffice() });
        } catch (error) {
            console.error('❌ Office information save failure:', error);
            return res.status(500).json({ success: false, message: 'The office information could not be saved.' });
        }
    });

    /* Settings → Data Privacy: the Data Protection Officer's name and email,
       saved on their own so the two Settings forms never overwrite each other. */
    router.put('/office/privacy', requireAdmin, async (req, res) => {
        try {
            const body = req.body || {};
            const dpoName = clean(body.dpoName, 120);
            const dpoEmail = clean(body.dpoEmail, 254).toLowerCase();
            if (!looksLikeEmail(dpoEmail)) return res.status(400).json({ success: false, message: "The Data Protection Officer's email address does not look complete." });
            if (Boolean(dpoName) !== Boolean(dpoEmail)) {
                return res.status(400).json({ success: false, message: "Give both the Data Protection Officer's name and email, or neither." });
            }
            const by = (req.account && req.account.email) || '';
            await query(`insert into office_info (id, dpo_name, dpo_email, updated_by_email) values (1, $1, $2, $3)
                         on conflict (id) do update set dpo_name = $1, dpo_email = $2, updated_by_email = $3`,
                [dpoName, dpoEmail, by]);
            return res.json({ success: true, message: 'Saved. The Privacy page shows it now.', office: await readOffice() });
        } catch (error) {
            console.error('❌ Data privacy save failure:', error);
            return res.status(500).json({ success: false, message: 'The Data Protection Officer could not be saved.' });
        }
    });

    /* The officer's own read, with what the public one leaves out. */
    router.get('/office/admin', requireAdmin, async (req, res) => {
        try {
            return res.json(await readOffice());
        } catch (error) {
            console.error('❌ Office information read failure:', error);
            return res.status(500).json({ success: false, message: 'The office information could not be loaded.' });
        }
    });

    return router;
};
