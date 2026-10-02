/* Tourism statistics: the monthly counts behind Form A4 ("Report on the
 * Regional Distribution of Travelers"), and visitor counts at attractions.
 *
 * Mounted at /api/statistics by server.js, which hands over its own sign-in
 * checks so this file enforces exactly the same roles.
 *
 * Who reports for a place is who runs it in ZTIMS: an establishment manager
 * for the listings they manage, the Tourism Officer for everything the office
 * keeps (spots.managed_by is null) and, on anyone's behalf, for any place.
 * Only the officer voids, locks and unlocks. Every rule is checked here, and
 * the database's constraints (db/schema.sql) hold underneath.
 *
 * Counts only. Nothing here reads or writes money, a rate, a percentage, or
 * anything about one person. Totals are added up when asked for, never stored.
 */
const express = require('express');
const { query, transaction } = require('./db');

// The office's deadline: a month's report is due by the end of the 5th of the
// following month, Philippine time. After that it still counts, marked late.
const DEADLINE_DAY = 5;
const MANILA_OFFSET_HOURS = 8;
const MAX_COUNT = 1000000;

const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const kindOf = spot => (spot.type === 'accommodation' ? 'accommodation' : 'attraction');

/* The end of the 5th of the following month in Manila, as a UTC instant. */
function deadlineFor(year, month) {
    return new Date(Date.UTC(year, month, DEADLINE_DAY, 24 - MANILA_OFFSET_HOURS) - 1);
}

/* Today's year and month in Manila. */
function manilaNow() {
    const now = new Date(Date.now() + MANILA_OFFSET_HOURS * 3600 * 1000);
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

const isOfficer = req => req.auth && req.auth.role === 'admin';

function badRequest(res, message, extra = {}) {
    return res.status(400).json({ success: false, message, ...extra });
}

function failure(res, error, label) {
    console.error(label, error);
    return res.status(500).json({ success: false, message: 'Something went wrong on our side. Try again in a moment.' });
}

/* Year and month from the URL, refusing anything that is not a real, started
   month: a report for next month cannot be true yet. */
function periodFrom(params) {
    const year = Number(params.year), month = Number(params.month);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return { error: 'The year must be between 2000 and 2100.' };
    if (!Number.isInteger(month) || month < 1 || month > 12) return { error: 'The month must be 1 to 12.' };
    const now = manilaNow();
    if (year > now.year || (year === now.year && month > now.month)) {
        return { error: 'That month has not started yet, so there is nothing to report for it.' };
    }
    return { year, month };
}

async function spotById(id, client) {
    if (!/^[0-9a-f]{24}$/i.test(String(id || ''))) return null;
    const { rows } = await query(
        `select s.id, s.title, s.type, s.barangay, s.status, s.managed_by,
                m.establishment_name as manager_name
           from spots s left join establishment_managers m on m.id = s.managed_by
          where s.id = $1`, [String(id)], client);
    return rows[0] || null;
}

/* Whether the signed-in account may report for this place. */
function mayReportFor(req, spot) {
    if (isOfficer(req)) return true;
    return spot.managed_by !== null && String(spot.managed_by) === String(req.auth.sub);
}

async function whoIsSigningIn(req) {
    const table = isOfficer(req) ? 'tourism_officers' : 'establishment_managers';
    const { rows } = await query(`select email from ${table} where id = $1`, [String(req.auth.sub)]);
    return { role: req.auth.role, id: String(req.auth.sub), email: rows[0] ? rows[0].email : '' };
}

async function residenceCodes(client) {
    const { rows } = await query('select code from residences', [], client);
    return new Set(rows.map(r => r.code));
}

/* A report and its counts, shaped for the pages. */
function shapeReport(row, counts) {
    if (!row) return null;
    const deadline = deadlineFor(row.year, row.month);
    return {
        _id: row.id,
        kind: row.kind,
        spotId: row.spot_id,
        year: row.year,
        month: row.month,
        rooms: row.rooms,
        roomNightsOccupied: row.room_nights_occupied,
        guestNights: row.guest_nights,
        status: row.status,
        voidReason: row.void_reason,
        submittedByRole: row.submitted_by_role,
        submittedByEmail: row.submitted_by_email,
        submittedAt: row.submitted_at,
        late: new Date(row.submitted_at) > deadline,
        lockedAt: row.locked_at,
        lockedByEmail: row.locked_by_email,
        updatedAt: row.updated_at,
        counts: (counts || []).map(c => ({ code: c.residence_code, male: c.male, female: c.female, total: c.total }))
    };
}

/* What gets written to report_changes: everything a person could have changed. */
function snapshotOf(report) {
    if (!report) return null;
    return {
        rooms: report.rooms, roomNightsOccupied: report.roomNightsOccupied, guestNights: report.guestNights,
        status: report.status, lockedAt: report.lockedAt,
        counts: Object.fromEntries(report.counts.map(c => [c.code, { male: c.male, female: c.female, total: c.total }]))
    };
}

async function logChange(client, reportId, action, who, before, after, note = '') {
    await query(
        `insert into report_changes (report_id, action, changed_by_role, changed_by_email, note, before, after)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [reportId, action, who.role, who.email, String(note || '').slice(0, 500),
         before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null], client);
}

async function liveReport(spotId, year, month, client) {
    const { rows } = await query(
        `select * from monthly_reports where spot_id = $1 and year = $2 and month = $3 and status = 'submitted'`,
        [spotId, year, month], client);
    if (!rows[0]) return null;
    const counts = await query(
        `select c.* from monthly_report_counts c join residences r on r.code = c.residence_code
          where c.report_id = $1 order by r.sort_order`, [rows[0].id], client);
    return shapeReport(rows[0], counts.rows);
}

/* A whole number from 0 up, or an explanation of why not. */
function wholeNumber(value, label, { required = true } = {}) {
    if (value === undefined || value === null || value === '') {
        return required ? { error: `${label} is required.` } : { value: null };
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) return { error: `${label} must be a whole number, 0 or more.` };
    if (n > MAX_COUNT) return { error: `${label} looks too large (${n}). Check the number.` };
    return { value: n };
}

module.exports = function statisticsRouter({ requireAdmin, requireStaff }) {
    const router = express.Router();

    /* The rows of Form A4, in the form's order. */
    router.get('/residences', requireStaff, async (req, res) => {
        try {
            const { rows } = await query('select code, name, section, continent, region from residences order by sort_order');
            return res.json(rows);
        } catch (error) {
            return failure(res, error, '❌ Residences failure:');
        }
    });

    /* The places the signed-in account reports for. */
    router.get('/places', requireStaff, async (req, res) => {
        try {
            const params = [];
            let where = `where s.status <> 'archived'`;
            if (!isOfficer(req)) {
                params.push(String(req.auth.sub));
                where += ` and s.managed_by = $1`;
            }
            const { rows } = await query(
                `select s.id, s.title, s.type, s.barangay, s.status, s.managed_by, m.establishment_name as manager_name
                   from spots s left join establishment_managers m on m.id = s.managed_by
                 ${where} order by s.type, s.title`, params);
            return res.json(rows.map(s => ({
                _id: s.id, title: s.title, kind: kindOf(s), barangay: s.barangay, status: s.status,
                keptByOffice: s.managed_by === null, managerName: s.manager_name || ''
            })));
        } catch (error) {
            return failure(res, error, '❌ Statistics places failure:');
        }
    });

    /* One place's report for one month, if there is one. */
    router.get('/reports/:spotId/:year/:month', requireStaff, async (req, res) => {
        try {
            const period = periodFrom(req.params);
            if (period.error) return badRequest(res, period.error);
            const spot = await spotById(req.params.spotId);
            if (!spot) return res.status(404).json({ success: false, message: 'That place could not be found.' });
            if (!mayReportFor(req, spot)) return res.status(403).json({ success: false, message: 'You can only see reports for the places you manage.' });

            const report = await liveReport(spot.id, period.year, period.month);
            let history = [];
            if (report && isOfficer(req)) {
                const { rows } = await query(
                    `select action, changed_by_role, changed_by_email, note, changed_at from report_changes
                      where report_id = $1 order by changed_at desc limit 50`, [report._id]);
                history = rows;
            }
            const municipal = await query(
                `select 1 from monthly_reports where kind = 'municipal_total' and status = 'submitted' and year = $1 and month = $2`,
                [period.year, period.month]);
            return res.json({
                place: { _id: spot.id, title: spot.title, kind: kindOf(spot), barangay: spot.barangay },
                year: period.year, month: period.month, daysInMonth: daysIn(period.year, period.month),
                deadline: deadlineFor(period.year, period.month),
                recordedAsMunicipalTotal: municipal.rows.length > 0,
                report, history
            });
        } catch (error) {
            return failure(res, error, '❌ Statistics report read failure:');
        }
    });

    /* Save a place's month: creates the report, or replaces its figures. */
    router.put('/reports/:spotId/:year/:month', requireStaff, async (req, res) => {
        try {
            const period = periodFrom(req.params);
            if (period.error) return badRequest(res, period.error);
            const spot = await spotById(req.params.spotId);
            if (!spot) return res.status(404).json({ success: false, message: 'That place could not be found.' });
            if (!mayReportFor(req, spot)) return res.status(403).json({ success: false, message: 'You can only report for the places you manage.' });
            const kind = kindOf(spot);
            const body = req.body || {};

            // ---- the counts: one row per residence that had anyone
            const codes = await residenceCodes();
            const list = Array.isArray(body.counts) ? body.counts : [];
            if (list.length > codes.size) return badRequest(res, 'Too many rows for one report.');
            const counts = [];
            const seen = new Set();
            for (const row of list) {
                const code = String((row && row.code) || '');
                if (!codes.has(code)) return badRequest(res, `"${code}" is not a row on Form A4.`);
                if (seen.has(code)) return badRequest(res, `A country appears twice in the report (${code}).`);
                seen.add(code);
                const male = wholeNumber(row.male, 'Male', { required: false });
                const female = wholeNumber(row.female, 'Female', { required: false });
                if (male.error) return badRequest(res, male.error);
                if (female.error) return badRequest(res, female.error);
                const m = male.value || 0, f = female.value || 0;
                if (m + f === 0) continue;       // nobody from there: not stored
                counts.push({ code, male: m, female: f, total: m + f });
            }
            const arrivals = counts.reduce((sum, c) => sum + c.total, 0);

            // ---- rooms and nights, accommodations only
            let rooms = null, roomNights = null, guestNights = null;
            if (kind === 'accommodation') {
                const r = wholeNumber(body.rooms, 'Number of rooms');
                const o = wholeNumber(body.roomNightsOccupied, 'Room-nights occupied');
                const g = wholeNumber(body.guestNights, 'Guest nights');
                for (const check of [r, o, g]) if (check.error) return badRequest(res, check.error);
                rooms = r.value; roomNights = o.value; guestNights = g.value;
                const available = rooms * daysIn(period.year, period.month);
                if (roomNights > available) {
                    return badRequest(res, `Room-nights occupied (${roomNights}) is more than rooms × days (${rooms} × ${daysIn(period.year, period.month)} = ${available}).`);
                }
                if (guestNights < arrivals) {
                    return badRequest(res, `Guest nights (${guestNights}) is fewer than guests (${arrivals}). Every guest stays at least one night.`);
                }
                if (arrivals === 0 && guestNights > 0) {
                    return badRequest(res, 'There are guest nights but no guests. Add where the guests came from.');
                }
            } else if (body.rooms != null || body.roomNightsOccupied != null || body.guestNights != null) {
                return badRequest(res, 'An attraction reports visitors only, not rooms or nights.');
            }

            const who = await whoIsSigningIn(req);
            const result = await transaction(async client => {
                const municipal = await query(
                    `select 1 from monthly_reports where kind = 'municipal_total' and status = 'submitted' and year = $1 and month = $2`,
                    [period.year, period.month], client);
                if (municipal.rows.length) {
                    return { conflict: 'This month is already recorded as the municipality\'s total from the printed sheet, so reports for single places would count its guests twice.' };
                }
                const before = await liveReport(spot.id, period.year, period.month, client);
                if (before && before.lockedAt) {
                    return { conflict: 'This month was already sent to the province and is locked. The Tourism Officer can unlock it to correct it.', locked: true };
                }
                let reportId;
                if (before) {
                    reportId = before._id;
                    await query(
                        `update monthly_reports set rooms = $2, room_nights_occupied = $3, guest_nights = $4,
                                submitted_by_role = $5, submitted_by_email = $6, submitted_at = now()
                          where id = $1`,
                        [reportId, rooms, roomNights, guestNights, who.role, who.email], client);
                    await query('delete from monthly_report_counts where report_id = $1', [reportId], client);
                } else {
                    const { rows } = await query(
                        `insert into monthly_reports (kind, spot_id, year, month, rooms, room_nights_occupied, guest_nights,
                                                      submitted_by_role, submitted_by_email)
                         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
                        [kind, spot.id, period.year, period.month, rooms, roomNights, guestNights, who.role, who.email], client);
                    reportId = rows[0].id;
                }
                for (const c of counts) {
                    await query(
                        // The total is the database's: male + female.
                        `insert into monthly_report_counts (report_id, residence_code, male, female) values ($1, $2, $3, $4)`,
                        [reportId, c.code, c.male, c.female], client);
                }
                const after = await liveReport(spot.id, period.year, period.month, client);
                await logChange(client, reportId, before ? 'updated' : 'created', who, snapshotOf(before), snapshotOf(after));
                return { report: after, created: !before };
            });

            if (result.conflict) return res.status(409).json({ success: false, message: result.conflict, locked: !!result.locked });
            return res.status(result.created ? 201 : 200).json({
                success: true,
                message: result.created ? 'Report saved.' : 'Report updated.',
                report: result.report
            });
        } catch (error) {
            if (error && error.code === '23505') {
                return res.status(409).json({ success: false, message: 'Someone else saved this month at the same moment. Reload to see their figures.' });
            }
            if (error && typeof error.code === 'string' && error.code.startsWith('23')) {
                return badRequest(res, 'Those figures break one of the report rules. Check the counts and try again.');
            }
            return failure(res, error, '❌ Statistics report save failure:');
        }
    });

    /* The officer voids a report entered in error. It stays on record. */
    router.post('/reports/:id/void', requireAdmin, async (req, res) => {
        try {
            const reason = String((req.body || {}).reason || '').trim();
            if (!reason) return badRequest(res, 'Say why the report is being voided.');
            const who = await whoIsSigningIn(req);
            const outcome = await transaction(async client => {
                const { rows } = await query(`select * from monthly_reports where id = $1 for update`, [String(req.params.id)], client);
                const row = rows[0];
                if (!row) return { status: 404, message: 'That report could not be found.' };
                if (row.status === 'void') return { status: 409, message: 'That report is already void.' };
                if (row.locked_at) return { status: 409, message: 'Unlock the report before voiding it: it was already sent to the province.' };
                await query(`update monthly_reports set status = 'void', void_reason = $2 where id = $1`, [row.id, reason.slice(0, 500)], client);
                await logChange(client, row.id, 'voided', who, { status: 'submitted' }, { status: 'void' }, reason);
                return { status: 200, message: 'Report voided. It no longer counts in any total.' };
            });
            return res.status(outcome.status).json({ success: outcome.status === 200, message: outcome.message });
        } catch (error) {
            return failure(res, error, '❌ Statistics void failure:');
        }
    });

    /* The officer unlocks a report so it can be corrected. */
    router.post('/reports/:id/unlock', requireAdmin, async (req, res) => {
        try {
            const reason = String((req.body || {}).reason || '').trim();
            if (!reason) return badRequest(res, 'Say why the report needs correcting.');
            const who = await whoIsSigningIn(req);
            const outcome = await transaction(async client => {
                const { rows } = await query(`select * from monthly_reports where id = $1 for update`, [String(req.params.id)], client);
                const row = rows[0];
                if (!row) return { status: 404, message: 'That report could not be found.' };
                if (!row.locked_at) return { status: 409, message: 'That report is not locked.' };
                await query(`update monthly_reports set locked_at = null, locked_by_email = '' where id = $1`, [row.id], client);
                await logChange(client, row.id, 'unlocked', who, { lockedAt: row.locked_at }, { lockedAt: null }, reason);
                return { status: 200, message: 'Report unlocked. Its figures can be corrected now.' };
            });
            return res.status(outcome.status).json({ success: outcome.status === 200, message: outcome.message });
        } catch (error) {
            return failure(res, error, '❌ Statistics unlock failure:');
        }
    });

    /* The officer marks months as sent to the province: their reports lock. */
    router.post('/periods/lock', requireAdmin, async (req, res) => {
        try {
            const body = req.body || {};
            const year = Number(body.year), from = Number(body.fromMonth), to = Number(body.toMonth);
            if (!Number.isInteger(year) || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 12 || from > to) {
                return badRequest(res, 'Give a year and a range of months, January to December.');
            }
            const who = await whoIsSigningIn(req);
            const locked = await transaction(async client => {
                const { rows } = await query(
                    `update monthly_reports set locked_at = now(), locked_by_email = $4
                      where year = $1 and month between $2 and $3 and status = 'submitted' and locked_at is null
                      returning id, locked_at`, [year, from, to, who.email], client);
                for (const row of rows) await logChange(client, row.id, 'locked', who, { lockedAt: null }, { lockedAt: row.locked_at }, 'Sent to the province');
                return rows.length;
            });
            return res.json({ success: true, message: `Locked ${locked} report${locked === 1 ? '' : 's'}.`, locked });
        } catch (error) {
            return failure(res, error, '❌ Statistics lock failure:');
        }
    });

    /* Who has reported: every place of one kind × the 12 months of a year. */
    router.get('/tracker', requireAdmin, async (req, res) => {
        try {
            const year = Number(req.query.year);
            const kind = req.query.kind === 'attraction' ? 'attraction' : 'accommodation';
            if (!Number.isInteger(year) || year < 2000 || year > 2100) return badRequest(res, 'Give a year.');
            const places = await query(
                `select s.id, s.title, s.barangay, s.status, s.managed_by, m.establishment_name as manager_name
                   from spots s left join establishment_managers m on m.id = s.managed_by
                  where s.type = $1 and (s.status <> 'archived'
                        or exists (select 1 from monthly_reports r where r.spot_id = s.id and r.year = $2))
                  order by s.title`, [kind === 'accommodation' ? 'accommodation' : 'spot', year]);
            const reports = await query(
                `select id, spot_id, month, submitted_at, locked_at from monthly_reports
                  where year = $1 and kind = $2 and status = 'submitted'`, [year, kind]);
            const byPlace = new Map();
            for (const r of reports.rows) byPlace.set(r.spot_id + ':' + r.month, r);
            const municipal = await query(
                `select month from monthly_reports where year = $1 and kind = 'municipal_total' and status = 'submitted'`, [year]);
            const municipalMonths = new Set(municipal.rows.map(r => r.month));
            const now = new Date();

            const rows = places.rows.map(p => ({
                _id: p.id, title: p.title, barangay: p.barangay, keptByOffice: p.managed_by === null,
                managerName: p.manager_name || '',
                months: Array.from({ length: 12 }, (_, i) => {
                    const month = i + 1;
                    const report = byPlace.get(p.id + ':' + month);
                    if (report) {
                        return { month, status: new Date(report.submitted_at) > deadlineFor(year, month) ? 'late' : 'submitted',
                                 reportId: report.id, locked: !!report.locked_at };
                    }
                    if (municipalMonths.has(month)) return { month, status: 'municipal_total' };
                    const periodEnded = now >= new Date(Date.UTC(year, month, 1) - MANILA_OFFSET_HOURS * 3600 * 1000);
                    if (!periodEnded) return { month, status: 'not_due' };
                    return { month, status: now > deadlineFor(year, month) ? 'missing' : 'due' };
                })
            }));
            return res.json({ year, kind, places: rows });
        } catch (error) {
            return failure(res, error, '❌ Statistics tracker failure:');
        }
    });

    /* Form A4 for a year (optionally a range of its months), added up now. */
    async function formA4(year, from, to) {
        const residences = (await query('select code, name, section, continent, region from residences order by sort_order')).rows;
        const reports = (await query(
            `select id, kind, month, rooms, room_nights_occupied, guest_nights, locked_at from monthly_reports
              where year = $1 and month between $2 and $3 and status = 'submitted'
                and kind in ('accommodation', 'municipal_total')`, [year, from, to])).rows;
        // A month recorded as a municipal total is that total; otherwise it is
        // the sum of the establishments' reports. Never both.
        const municipalMonths = new Set(reports.filter(r => r.kind === 'municipal_total').map(r => r.month));
        const used = reports.filter(r => municipalMonths.has(r.month) ? r.kind === 'municipal_total' : r.kind === 'accommodation');
        const ids = used.map(r => r.id);
        const counts = ids.length ? (await query(
            `select c.*, r.month from monthly_report_counts c join monthly_reports r on r.id = c.report_id
              where c.report_id = any($1)`, [ids])).rows : [];

        const zero = () => Array(12).fill(0);
        const byCode = Object.fromEntries(residences.map(r => [r.code, { total: zero(), male: zero(), female: zero() }]));
        const sexKnown = Array(12).fill(true);
        for (const c of counts) {
            const m = c.month - 1, cell = byCode[c.residence_code];
            cell.total[m] += c.total;
            if (c.male === null) sexKnown[m] = false; else { cell.male[m] += c.male; cell.female[m] += c.female; }
        }
        const dae = { rooms: zero(), roomNightsAvailable: zero(), roomNightsOccupied: zero(), guestNights: zero() };
        const reportsPerMonth = zero();
        for (const r of used) {
            const m = r.month - 1;
            reportsPerMonth[m] += 1;
            dae.rooms[m] += r.rooms || 0;
            dae.roomNightsAvailable[m] += (r.rooms || 0) * daysIn(year, r.month);
            dae.roomNightsOccupied[m] += r.room_nights_occupied || 0;
            dae.guestNights[m] += r.guest_nights || 0;
        }
        dae.roomNightsNotOccupied = dae.roomNightsAvailable.map((a, i) => a - dae.roomNightsOccupied[i]);
        const inRange = i => i + 1 >= from && i + 1 <= to;
        for (const key of Object.keys(dae)) dae[key] = dae[key].map((v, i) => (inRange(i) ? v : null));

        return {
            year, fromMonth: from, toMonth: to, residences,
            counts: byCode,
            sexKnown: sexKnown.map((known, i) => (inRange(i) ? known && reportsPerMonth[i] > 0 : null)),
            municipalTotalMonths: [...municipalMonths].sort((a, b) => a - b),
            reportsPerMonth: reportsPerMonth.map((n, i) => (inRange(i) ? n : null)),
            lockedMonths: [...new Set(used.filter(r => r.locked_at).map(r => r.month))].sort((a, b) => a - b),
            dae
        };
    }

    function rangeFrom(q) {
        const year = Number(q.year);
        const from = q.from ? Number(q.from) : 1, to = q.to ? Number(q.to) : 12;
        if (!Number.isInteger(year) || year < 2000 || year > 2100) return { error: 'Give a year.' };
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 12 || from > to) return { error: 'Give a range of months, January to December.' };
        return { year, from, to };
    }

    router.get('/form-a4', requireAdmin, async (req, res) => {
        try {
            const range = rangeFrom(req.query);
            if (range.error) return badRequest(res, range.error);
            return res.json(await formA4(range.year, range.from, range.to));
        } catch (error) {
            return failure(res, error, '❌ Form A4 failure:');
        }
    });

    router.get('/form-a4.xlsx', requireAdmin, async (req, res) => {
        try {
            const range = rangeFrom(req.query);
            if (range.error) return badRequest(res, range.error);
            const data = await formA4(range.year, range.from, range.to);
            const buffer = await require('./statistics-excel').formA4Workbook(data);
            const name = `Form_A4_Zamboanguita_${range.year}${range.from === 1 && range.to === 12 ? '' : `_${range.from}-${range.to}`}.xlsx`;
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
            return res.send(Buffer.from(buffer));
        } catch (error) {
            return failure(res, error, '❌ Form A4 Excel failure:');
        }
    });

    /* Visitors at every attraction, month by month. */
    router.get('/attractions', requireAdmin, async (req, res) => {
        try {
            const year = Number(req.query.year);
            if (!Number.isInteger(year) || year < 2000 || year > 2100) return badRequest(res, 'Give a year.');
            const places = (await query(
                `select s.id, s.title, s.barangay, s.managed_by from spots s
                  where s.type = 'spot' and (s.status <> 'archived'
                        or exists (select 1 from monthly_reports r where r.spot_id = s.id and r.year = $1))
                  order by s.title`, [year])).rows;
            const sums = (await query(
                `select r.spot_id, r.month, sum(c.total)::int as total, sum(c.male)::int as male, sum(c.female)::int as female
                   from monthly_reports r left join monthly_report_counts c on c.report_id = r.id
                  where r.year = $1 and r.kind = 'attraction' and r.status = 'submitted'
                  group by r.spot_id, r.month`, [year])).rows;
            const cell = new Map(sums.map(s => [s.spot_id + ':' + s.month, s]));
            const rows = places.map(p => ({
                _id: p.id, title: p.title, barangay: p.barangay, keptByOffice: p.managed_by === null,
                months: Array.from({ length: 12 }, (_, i) => {
                    const s = cell.get(p.id + ':' + (i + 1));
                    return s ? { reported: true, total: s.total || 0, male: s.male || 0, female: s.female || 0 } : { reported: false, total: 0, male: 0, female: 0 };
                })
            }));
            return res.json({ year, attractions: rows });
        } catch (error) {
            return failure(res, error, '❌ Attractions summary failure:');
        }
    });

    return router;
};

module.exports.daysIn = daysIn;
module.exports.deadlineFor = deadlineFor;
