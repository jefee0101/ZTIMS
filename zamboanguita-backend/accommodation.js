/* Accommodation reporting: the stay register of a private place to stay, the
 * DAE-1A and DAE-1B worked out from it, saved monthly versions, the officer's
 * Finalize and Reopen, and the municipal FORM A. Mounted at /api by server.js.
 *
 * Who: the enterprise's manager records and submits for their own listings
 * only; the Tourism Officer reads every enterprise, finalizes and reopens,
 * and never writes a stay. Support Staff and visitors have no route here.
 * The arithmetic is in accommodation-engine.js; db/schema.sql ("Accommodation
 * reporting") holds the rules underneath, so a page or a script that skips
 * this file still cannot double-book a room, change a finalized month or
 * alter a saved version.
 */
const express = require('express');
const { query, transaction } = require('./db');
const E = require('./accommodation-engine');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ID = /^[0-9a-f]{24}$/i;
const MAX_ROOMS_PER_STAY = 20, MAX_GUEST_ROWS = 30, MAX_COUNT = 999, MAX_NIGHTS = 366;
const TYPES = ['hotel', 'resort', 'pension', 'hostel', 'apartel', 'other'];

const isOfficer = req => req.auth && req.auth.role === 'admin';
const isManager = req => req.auth && ['establishment_manager', 'resort_owner'].includes(req.auth.role);
const who = req => ({ role: req.auth.role, email: (req.account && req.account.email) || '' });
const monthName = k => `${MONTHS[+k.slice(5, 7) - 1]} ${k.slice(0, 4)}`;
const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

class Refusal extends Error {
    constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || {}; }
}
const refuse = (status, code, message, extra) => { throw new Refusal(status, code, message, extra); };

/* The database's own refusals (db/schema.sql), in words. */
function fromDatabase(error) {
    if (error instanceof Refusal) return error;
    if (error.code === '23P01') return new Refusal(409, 'ROOM_TAKEN', 'One of those rooms is already taken on one of those nights.');
    if (error.code === '23505') return new Refusal(409, 'DUPLICATE', 'That already exists. Reload and try again.');
    if (error.code !== 'P0001') return null;
    const [token, ...rest] = String(error.message).split(' ');
    const arg = rest.join(' ');
    const map = {
        PERIOD_FINALIZED: [409, `${monthName(arg)} is finalized. The Tourism Office must reopen it before anything in it can change.`, { month: arg }],
        MUNICIPAL_TOTAL_MONTH: [409, `${monthName(arg)} is held as a municipal total from the paper Form A4, so enterprise reports are not taken for it.`, { month: arg }],
        ROOM_OUT_OF_SERVICE: [409, 'A room is out of service on one of those nights.'],
        PLACE_CLOSED: [409, 'The place is closed on one of those nights.'],
        NIGHT_WITHOUT_ROOM: [400, 'Every night of the stay needs a room.'],
        NIGHT_WITHOUT_GUEST: [400, 'Every night of the stay needs at least one guest.'],
        STAY_GUEST_DATES: [400, 'Guests must arrive on or after check-in and leave on or before check-out, with someone arriving at check-in and someone leaving at check-out.'],
        STAY_ROOM_OUTSIDE: [400, 'A room is given for nights outside the stay, or on nights it is not available.'],
        STAY_ROOM_TWICE: [400, 'The same room is given twice for the same night.'],
        ROOM_OTHER_PLACE: [400, 'That room belongs to another enterprise.'],
        ROOM_TYPE_OTHER_PLACE: [400, 'That room type belongs to another enterprise.'],
        ROOM_SHARING_FIXED: [409, 'A room that already has stays cannot change between shared and private.'],
        NOT_ACCOMMODATION: [400, 'Only a privately managed place to stay keeps this register.'],
        ONLY_VOID: [409, 'This record can only be voided.'],
        STAY_VOID: [409, 'This stay was voided and cannot change.'],
        IMMUTABLE: [409, 'Saved versions and their history never change.'],
        ENTERPRISE_REPORTS_EXIST: [409, 'Enterprises have reported that month.'],
        VERSION_GAP: [409, 'Reload and try again: the version numbers moved.']
    };
    const hit = map[token];
    return hit ? new Refusal(hit[0], token, hit[1], hit[2]) : null;
}

module.exports = function accommodationRouter({ requireAdmin, requireStaff, requireEstablishmentManager, sharedRateLimit }) {
    const router = express.Router();
    const writeLimit = sharedRateLimit
        ? sharedRateLimit('accommodation-write', { windowMs: 60 * 60 * 1000, limit: 300, keyGenerator: req => `${req.auth.role}:${req.auth.sub}`,
            message: { success: false, message: 'Too many changes in a short time. Wait a few minutes.' } })
        : (req, res, next) => next();

    const handle = fn => async (req, res) => {
        try { await fn(req, res); } catch (error) {
            const r = fromDatabase(error);
            if (r) return res.status(r.status).json({ success: false, code: r.code, message: r.message, ...r.extra });
            console.error('❌ Accommodation failure:', error);
            return res.status(500).json({ success: false, message: 'Something went wrong on our side. Try again in a moment.' });
        }
    };

    /* ---- places and access ---------------------------------------------- */
    async function placeFor(req, spotId, { write = false } = {}, client) {
        if (!ID.test(String(spotId || ''))) refuse(404, 'NOT_FOUND', 'Enterprise not found.');
        const { rows } = await query(
            `select s.id, s.title, s.type, s.status, s.managed_by, s.created_at, coalesce(nullif(s.enterprise_name, ''), s.title) as name
               from spots s where s.id = $1`, [spotId], client);
        const spot = rows[0];
        if (!spot || spot.type !== 'accommodation' || !spot.managed_by) refuse(404, 'NOT_FOUND', 'No private place to stay with that id.');
        const own = isManager(req) && String(spot.managed_by) === String(req.auth.sub);
        if (write && !own) refuse(403, 'NOT_YOURS', 'Only this enterprise\'s manager can change its records.');
        if (!own && !isOfficer(req)) refuse(403, 'NOT_YOURS', 'This enterprise is not yours.');
        return spot;
    }
    const lockPlace = (spotId, client) => query(`select pg_advisory_xact_lock(hashtextextended('accommodation:' || $1, 0))`, [spotId], client);

    async function sections(client) {
        const { rows } = await query('select code, section from residences', [], client);
        return Object.fromEntries(rows.map(r => [r.code, r.section]));
    }
    async function profileOf(spotId, client) {
        const { rows } = await query('select * from accommodation_profiles where spot_id = $1', [spotId], client);
        const p = rows[0];
        return p ? { accommodationType: p.accommodation_type, accommodationTypeOther: p.accommodation_type_other, dotClassification: p.dot_classification,
                     aeCode: p.ae_code, reportingFrom: E.toDate(p.reporting_from) } : { accommodationType: '', accommodationTypeOther: '', dotClassification: '', aeCode: '', reportingFrom: null };
    }

    /* Everything a range of a place's figures is worked out from. */
    async function loadRecords(spotId, from, until, client) {
        const rooms = (await query('select * from accommodation_rooms where spot_id = $1 order by lower(room_number)', [spotId], client)).rows;
        const unavailability = (await query('select * from accommodation_room_unavailability where spot_id = $1 and voided_at is null', [spotId], client)).rows;
        const closed = (await query('select * from accommodation_closed_periods where spot_id = $1 and voided_at is null', [spotId], client)).rows;
        const stays = (await query(
            `select * from accommodation_stays where spot_id = $1 and status = 'active' and check_in < $3 and check_out > $2 order by check_in, reference`,
            [spotId, from, until], client)).rows;
        const ids = stays.map(s => s.id);
        const allocations = ids.length ? (await query('select * from accommodation_stay_rooms where stay_id = any($1) order by starts_on', [ids], client)).rows : [];
        const guests = ids.length ? (await query('select * from accommodation_stay_guests where stay_id = any($1) order by starts_on', [ids], client)).rows : [];
        for (const s of stays) {
            s.rooms = allocations.filter(a => a.stay_id === s.id);
            s.guests = guests.filter(g => g.stay_id === s.id);
        }
        return { rooms, unavailability, closed, stays };
    }
    const monthRange = (y, m) => [E.firstDay(y, m), E.addDays(E.lastDay(y, m), 1)];

    async function versionsOf(spotId, year, month, client) {
        const v = (await query(
            `select * from accommodation_report_versions where spot_id = $1 and year = $2 and month = $3 order by version`, [spotId, year, month], client)).rows;
        const counts = v.length ? (await query('select * from accommodation_report_version_counts where version_id = any($1)', [v.map(x => x.id)], client)).rows : [];
        return v.map(x => shapeVersion(x, counts.filter(c => c.version_id === x.id)));
    }
    function shapeVersion(v, counts) {
        return {
            _id: v.id, version: v.version, provenance: v.provenance, reason: v.reason, late: v.late,
            submittedAt: v.submitted_at, submittedByRole: v.submitted_by_role, sourceStays: v.source_stays,
            figures: {
                rooms: v.rooms, arrivals: v.arrivals, guestNights: v.guest_nights,
                roomNightsOccupied: v.room_nights_occupied, roomNightsAvailable: v.room_nights_available,
                occupancyRate: E.ratio(v.room_nights_occupied, v.room_nights_available),
                averageLengthOfStay: E.ratio(v.guest_nights, v.arrivals),
                counts: Object.fromEntries(counts.map(c => [c.residence_code, { male: c.male, female: c.female }]))
            }
        };
    }
    async function eventsOf(spotId, year, month, client) {
        return (await query(
            `select action, version_id, reason, actor_role, at from accommodation_period_events
              where spot_id = $1 and year = $2 and month = $3 order by at, id`, [spotId, year, month], client)).rows;
    }
    async function periodOf(spotId, year, month, client) {
        return (await query('select * from accommodation_periods where spot_id = $1 and year = $2 and month = $3', [spotId, year, month], client)).rows[0] || null;
    }
    async function municipalMonth(year, month, client) {
        return (await query(`select 1 from monthly_reports where kind = 'municipal_total' and status = 'submitted' and year = $1 and month = $2`, [year, month], client)).rows.length > 0;
    }

    async function monthView(spot, year, month, today, client) {
        const [from, until] = monthRange(year, month);
        const records = await loadRecords(spot.id, from, until, client);
        const sec = await sections(client);
        const figures = E.monthFigures(records, year, month, { today, sections: sec });
        const versions = await versionsOf(spot.id, year, month, client);
        const events = await eventsOf(spot.id, year, month, client);
        const period = await periodOf(spot.id, year, month, client);
        const profile = await profileOf(spot.id, client);
        const state = E.periodState({ year, month, today, reportingFrom: profile.reportingFrom, versions, finalized: !!(period && period.finalized_at),
                                      events, figures, municipal: await municipalMonth(year, month, client) });
        return { spot, profile, figures, versions, events, period, state, records };
    }

    function periodParams(req) {
        const year = Number(req.params.year), month = Number(req.params.month);
        if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) refuse(400, 'BAD_PERIOD', 'Give a year and a month, 1 to 12.');
        return { year, month };
    }

    async function logChange(client, spotId, entity, entityId, action, reason, months, before, after, actor) {
        await query(
            `insert into accommodation_changes (spot_id, entity, entity_id, action, reason, affected_months, before, after, actor_role, actor_email)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [spotId, entity, entityId, action, text(reason, 300), months, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, actor.role, actor.email], client);
    }

    /* After a change: every month it reaches, and where each now stands. */
    async function affectedStates(spot, months, client) {
        const today = E.manilaToday();
        const out = [];
        for (const k of months) {
            const v = await monthView(spot, +k.slice(0, 4), +k.slice(5, 7), today, client);
            out.push({ month: k, state: v.state.state, latestVersion: v.state.latestVersion, differences: v.state.differences || [] });
        }
        return out;
    }

    /* ---- profile ----------------------------------------------------------- */
    router.get('/accommodation/:spotId/profile', requireStaff, handle(async (req, res) => {
        const spot = await placeFor(req, req.params.spotId);
        res.json({ success: true, enterprise: { _id: spot.id, name: spot.name }, profile: await profileOf(spot.id) });
    }));

    router.put('/accommodation/:spotId/profile', requireEstablishmentManager, writeLimit, handle(async (req, res) => {
        const b = req.body || {};
        const type = String(b.accommodationType || '');
        if (type && !TYPES.includes(type)) refuse(400, 'BAD_TYPE', 'Choose the kind of place from the list.');
        let reportingFrom = b.reportingFrom ? String(b.reportingFrom) : null;
        if (reportingFrom) {
            if (/^\d{4}-\d{2}$/.test(reportingFrom)) reportingFrom += '-01';
            if (!E.isDate(reportingFrom) || reportingFrom.slice(8) !== '01') refuse(400, 'BAD_START', 'Reporting starts on a month, like 2026-08.');
        }
        const actor = who(req);
        await transaction(async client => {
            const spot = await placeFor(req, req.params.spotId, { write: true }, client);
            await lockPlace(spot.id, client);
            const before = await profileOf(spot.id, client);
            if (reportingFrom) {
                const earlier = (await query(`select year, month from accommodation_report_versions where spot_id = $1 and make_date(year, month, 1) < $2 limit 1`, [spot.id, reportingFrom], client)).rows[0];
                if (earlier) refuse(409, 'REPORTS_BEFORE', `${monthName(E.monthKey(earlier.year, earlier.month))} was already submitted, so reporting cannot start after it.`);
            }
            await query(
                `insert into accommodation_profiles (spot_id, accommodation_type, accommodation_type_other, dot_classification, ae_code, reporting_from)
                 values ($1, $2, $3, $4, $5, $6)
                 on conflict (spot_id) do update set accommodation_type = excluded.accommodation_type, accommodation_type_other = excluded.accommodation_type_other,
                     dot_classification = excluded.dot_classification, ae_code = excluded.ae_code, reporting_from = excluded.reporting_from`,
                [spot.id, type, type === 'other' ? text(b.accommodationTypeOther, 80) : '', text(b.dotClassification, 80), text(b.aeCode, 40), reportingFrom], client);
            const after = await profileOf(spot.id, client);
            await logChange(client, spot.id, 'profile', spot.id, before.reportingFrom || before.accommodationType ? 'edited' : 'created', '', [], before, after, actor);
            res.json({ success: true, profile: after });
        });
    }));

    /* ---- rooms, out of service, closed ------------------------------------- */
    const shapeRoom = r => ({ _id: r.id, roomNumber: r.room_number, label: r.label, sleeps: r.sleeps, shared: r.shared, roomTypeId: r.room_type_id,
                              availableFrom: E.toDate(r.available_from), availableUntil: E.toDate(r.available_until) });
    router.get('/accommodation/:spotId/rooms', requireStaff, handle(async (req, res) => {
        const spot = await placeFor(req, req.params.spotId);
        const rec = await loadRecords(spot.id, '1900-01-01', '1900-01-02');
        res.json({
            success: true, rooms: rec.rooms.map(shapeRoom),
            outOfService: rec.unavailability.map(u => ({ _id: u.id, roomId: u.room_id, startsOn: E.toDate(u.starts_on), endsOn: E.toDate(u.ends_on), reason: u.reason })),
            closedPeriods: rec.closed.map(c => ({ _id: c.id, startsOn: E.toDate(c.starts_on), endsOn: E.toDate(c.ends_on), reason: c.reason }))
        });
    }));

    router.post('/accommodation/:spotId/rooms', requireEstablishmentManager, writeLimit, handle(async (req, res) => {
        const b = req.body || {};
        const number = text(b.roomNumber, 20), sleeps = Number(b.sleeps), from = String(b.availableFrom || '');
        if (!number) refuse(400, 'BAD_ROOM', 'Enter the room number.');
        if (!Number.isInteger(sleeps) || sleeps < 1 || sleeps > 30) refuse(400, 'BAD_ROOM', 'Sleeps must be a whole number, 1 to 30.');
        if (!E.isDate(from)) refuse(400, 'BAD_ROOM', 'Enter the date the room became available.');
        const actor = who(req);
        await transaction(async client => {
            const spot = await placeFor(req, req.params.spotId, { write: true }, client);
            await lockPlace(spot.id, client);
            const { rows } = await query(
                `insert into accommodation_rooms (spot_id, room_number, label, sleeps, shared, available_from, room_type_id)
                 values ($1, $2, $3, $4, $5, $6, $7) returning *`,
                [spot.id, number, text(b.label, 80), sleeps, b.shared === true, from, ID.test(String(b.roomTypeId || '')) ? b.roomTypeId : null], client);
            await logChange(client, spot.id, 'room', rows[0].id, 'created', '', [], null, shapeRoom(rows[0]), actor);
            res.status(201).json({ success: true, room: shapeRoom(rows[0]) });
        }).catch(e => { if (e.code === '23505') throw new Refusal(409, 'ROOM_EXISTS', `Room ${number} already exists.`); throw e; });
    }));

    router.patch('/accommodation/rooms/:roomId', requireEstablishmentManager, writeLimit, handle(async (req, res) => {
        const b = req.body || {};
        const actor = who(req);
        await transaction(async client => {
            const found = (await query('select * from accommodation_rooms where id = $1', [String(req.params.roomId)], client)).rows[0];
            if (!found) refuse(404, 'NOT_FOUND', 'Room not found.');
            const spot = await placeFor(req, found.spot_id, { write: true }, client);
            await lockPlace(spot.id, client);
            const next = { label: found.label, sleeps: found.sleeps, until: E.toDate(found.available_until) };
            if (b.label !== undefined) next.label = text(b.label, 80);
            if (b.sleeps !== undefined) { const n = Number(b.sleeps); if (!Number.isInteger(n) || n < 1 || n > 30) refuse(400, 'BAD_ROOM', 'Sleeps must be a whole number, 1 to 30.'); next.sleeps = n; }
            if (b.availableUntil !== undefined) {
                if (b.availableUntil !== null && !E.isDate(String(b.availableUntil))) refuse(400, 'BAD_ROOM', 'Give the first day the room is no longer available.');
                next.until = b.availableUntil;
                if (next.until) {
                    const later = (await query(`select reference from accommodation_stays s join accommodation_stay_rooms a on a.stay_id = s.id
                                                 where a.room_id = $1 and s.status = 'active' and a.ends_on > $2 limit 1`, [found.id, next.until], client)).rows[0];
                    if (later) refuse(409, 'ROOM_IN_USE', `Stay ${later.reference} uses this room after that date.`);
                }
            }
            const { rows } = await query('update accommodation_rooms set label = $2, sleeps = $3, available_until = $4 where id = $1 returning *',
                [found.id, next.label, next.sleeps, next.until], client);
            const months = found.available_until === rows[0].available_until ? [] : ['from ' + (next.until || E.toDate(found.available_until))];
            await logChange(client, spot.id, 'room', found.id, 'edited', text(b.reason, 300), months, shapeRoom(found), shapeRoom(rows[0]), actor);
            res.json({ success: true, room: shapeRoom(rows[0]) });
        });
    }));

    function periodBody(b) {
        const s = String(b.startsOn || ''), e = String(b.endsOn || ''), reason = text(b.reason, 200);
        if (!E.isDate(s) || !E.isDate(e) || e < s) refuse(400, 'BAD_DATES', 'Give a first and a last day, the last on or after the first.');
        if (!reason) refuse(400, 'BAD_REASON', 'Give a reason.');
        return { s, e, reason };
    }
    router.post('/accommodation/:spotId/out-of-service', requireEstablishmentManager, writeLimit, handle(async (req, res) => {
        const { s, e, reason } = periodBody(req.body || {});
        const roomId = String((req.body || {}).roomId || '');
        const actor = who(req);
        await transaction(async client => {
            const spot = await placeFor(req, req.params.spotId, { write: true }, client);
            await lockPlace(spot.id, client);
            const used = (await query(`select s.reference from accommodation_stays s join accommodation_stay_rooms a on a.stay_id = s.id
                                        where a.room_id = $1 and s.status = 'active' and a.starts_on <= $3 and a.ends_on > $2 limit 1`, [roomId, s, e], client)).rows[0];
            if (used) refuse(409, 'ROOM_IN_USE', `Stay ${used.reference} uses that room on those dates. Move it first.`);
            const { rows } = await query(`insert into accommodation_room_unavailability (spot_id, room_id, starts_on, ends_on, reason, created_by_email)
                                          values ($1, $2, $3, $4, $5, $6) returning id`, [spot.id, roomId, s, e, reason, actor.email], client);
            await logChange(client, spot.id, 'unavailability', rows[0].id, 'created', reason, E.monthsOfNights(s, E.addDays(e, 1)), null, { roomId, startsOn: s, endsOn: e }, actor);
            res.status(201).json({ success: true, _id: rows[0].id, affected: await affectedStates(spot, E.monthsOfNights(s, E.addDays(e, 1)), client) });
        });
    }));
    router.post('/accommodation/:spotId/closed-periods', requireEstablishmentManager, writeLimit, handle(async (req, res) => {
        const { s, e, reason } = periodBody(req.body || {});
        const actor = who(req);
        await transaction(async client => {
            const spot = await placeFor(req, req.params.spotId, { write: true }, client);
            await lockPlace(spot.id, client);
            const used = (await query(`select reference from accommodation_stays where spot_id = $1 and status = 'active' and check_in <= $3 and check_out > $2 limit 1`, [spot.id, s, e], client)).rows[0];
            if (used) refuse(409, 'STAY_IN_PERIOD', `Stay ${used.reference} has nights in those dates.`);
            const { rows } = await query(`insert into accommodation_closed_periods (spot_id, starts_on, ends_on, reason, created_by_email)
                                          values ($1, $2, $3, $4, $5) returning id`, [spot.id, s, e, reason, actor.email], client);
            await logChange(client, spot.id, 'closed_period', rows[0].id, 'created', reason, E.monthsOfNights(s, E.addDays(e, 1)), null, { startsOn: s, endsOn: e }, actor);
            res.status(201).json({ success: true, _id: rows[0].id, affected: await affectedStates(spot, E.monthsOfNights(s, E.addDays(e, 1)), client) });
        });
    }));
    /* Voiding out-of-service or a closed period: kept, marked void, with why. */
    for (const [path, table, entity] of [['out-of-service', 'accommodation_room_unavailability', 'unavailability'], ['closed-periods', 'accommodation_closed_periods', 'closed_period']]) {
        router.post(`/accommodation/${path}/:id/void`, requireEstablishmentManager, writeLimit, handle(async (req, res) => {
            const reason = text((req.body || {}).reason, 300);
            if (reason.length < 3) refuse(400, 'BAD_REASON', 'Say why it is removed.');
            const actor = who(req);
            await transaction(async client => {
                const row = (await query(`select * from ${table} where id = $1`, [String(req.params.id)], client)).rows[0];
                if (!row || row.voided_at) refuse(404, 'NOT_FOUND', 'Not found.');
                const spot = await placeFor(req, row.spot_id, { write: true }, client);
                await lockPlace(spot.id, client);
                await query(`update ${table} set voided_at = now(), void_reason = $2 where id = $1`, [row.id, reason], client);
                const months = E.monthsOfNights(E.toDate(row.starts_on), E.addDays(E.toDate(row.ends_on), 1));
                await logChange(client, spot.id, entity, row.id, 'voided', reason, months, { startsOn: E.toDate(row.starts_on), endsOn: E.toDate(row.ends_on) }, null, actor);
                res.json({ success: true, affected: await affectedStates(spot, months, client) });
            });
        }));
    }

    /* ---- stays ------------------------------------------------------------- */
    async function parseStay(b, spot, client) {
        const checkIn = String(b.checkIn || ''), checkOut = String(b.checkOut || '');
        if (!E.isDate(checkIn) || !E.isDate(checkOut)) refuse(400, 'BAD_DATES', 'Give the check-in and check-out dates.');
        if (checkOut <= checkIn) refuse(400, 'BAD_DATES', 'Check-out must be at least one night after check-in.');
        if (E.addDays(checkIn, MAX_NIGHTS) < checkOut) refuse(400, 'BAD_DATES', `A stay can be at most ${MAX_NIGHTS} nights.`);
        if (checkIn > E.manilaToday()) refuse(400, 'FUTURE_ARRIVAL', 'Check-in cannot be after today. A booking is not an arrival.');
        const rooms = Array.isArray(b.rooms) ? b.rooms : [];
        const guests = Array.isArray(b.guests) ? b.guests : [];
        if (!rooms.length || rooms.length > MAX_ROOMS_PER_STAY) refuse(400, 'BAD_ROOMS', `Give 1 to ${MAX_ROOMS_PER_STAY} room periods.`);
        if (!guests.length || guests.length > MAX_GUEST_ROWS) refuse(400, 'BAD_GUESTS', `Give 1 to ${MAX_GUEST_ROWS} guest groups.`);
        const own = new Set((await query('select id from accommodation_rooms where spot_id = $1', [spot.id], client)).rows.map(r => r.id));
        const codes = new Set((await query('select code from residences', [], client)).rows.map(r => r.code));
        const dates = (x, label) => {
            const s = x.from == null ? checkIn : String(x.from), e = x.until == null ? checkOut : String(x.until);
            if (!E.isDate(s) || !E.isDate(e) || e <= s) refuse(400, 'BAD_DATES', `${label}: give dates with the last after the first.`);
            if (s < checkIn || e > checkOut) refuse(400, 'BAD_DATES', `${label}: the dates must fall inside the stay.`);
            return [s, e];
        };
        const R = rooms.map((x, i) => {
            if (!own.has(String(x.roomId || ''))) refuse(400, 'BAD_ROOMS', `Room ${i + 1}: choose one of this enterprise's rooms.`);
            const [s, e] = dates(x, `Room ${i + 1}`);
            return { roomId: x.roomId, from: s, until: e };
        });
        const G = guests.map((x, i) => {
            const code = String(x.residence || '');
            if (!codes.has(code)) refuse(400, 'BAD_GUESTS', `Group ${i + 1}: choose a residence from the list.`);
            const m = Number(x.male), f = Number(x.female);
            for (const n of [m, f]) if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) refuse(400, 'BAD_GUESTS', `Group ${i + 1}: counts are whole numbers from 0 to ${MAX_COUNT}.`);
            if (m + f === 0) refuse(400, 'BAD_GUESTS', `Group ${i + 1}: at least one guest.`);
            const [s, e] = dates(x, `Group ${i + 1}`);
            if (s > E.manilaToday()) refuse(400, 'FUTURE_ARRIVAL', `Group ${i + 1}: guests cannot arrive after today.`);
            return { residence: code, male: m, female: f, from: s, until: e };
        });
        return { checkIn, checkOut, rooms: R, guests: G };
    }
    async function writeParts(client, stayId, st) {
        await query('delete from accommodation_stay_rooms where stay_id = $1', [stayId], client);
        await query('delete from accommodation_stay_guests where stay_id = $1', [stayId], client);
        for (const r of st.rooms) await query('insert into accommodation_stay_rooms (stay_id, room_id, starts_on, ends_on) values ($1, $2, $3, $4)', [stayId, r.roomId, r.from, r.until], client);
        for (const g of st.guests) await query(`insert into accommodation_stay_guests (stay_id, residence_code, male, female, starts_on, ends_on)
                                                values ($1, $2, $3, $4, $5, $6)`, [stayId, g.residence, g.male, g.female, g.from, g.until], client);
    }
    async function stayById(id, client) {
        const s = (await query('select * from accommodation_stays where id = $1', [String(id)], client)).rows[0];
        if (!s) return null;
        s.rooms = (await query('select * from accommodation_stay_rooms where stay_id = $1 order by starts_on', [s.id], client)).rows;
        s.guests = (await query('select * from accommodation_stay_guests where stay_id = $1 order by starts_on, residence_code', [s.id], client)).rows;
        return s;
    }
    const shapeStay = s => ({
        _id: s.id, reference: s.reference, checkIn: E.toDate(s.check_in), checkOut: E.toDate(s.check_out), status: s.status, voidReason: s.void_reason,
        revision: s.revision, bookingId: s.booking_id,
        rooms: s.rooms.map(a => ({ roomId: a.room_id, from: E.toDate(a.starts_on), until: E.toDate(a.ends_on) })),
        guests: s.guests.map(g => ({ residence: g.residence_code, male: g.male, female: g.female, from: E.toDate(g.starts_on), until: E.toDate(g.ends_on) }))
    });
    const monthsOf = s => E.monthsOfStay({ check_in: E.toDate(s.check_in || s.checkIn), check_out: E.toDate(s.check_out || s.checkOut),
        guests: (s.guests || []).map(g => ({ starts_on: E.toDate(g.starts_on || g.from) })) });

    router.get('/accommodation/:spotId/stays', requireStaff, handle(async (req, res) => {
        const spot = await placeFor(req, req.params.spotId);
        const key = String(req.query.month || '');
        if (!/^\d{4}-\d{2}$/.test(key)) refuse(400, 'BAD_PERIOD', 'Give month=YYYY-MM.');
        const [from, until] = monthRange(+key.slice(0, 4), +key.slice(5));
        const rec = await loadRecords(spot.id, from, until);
        res.json({ success: true, stays: rec.stays.map(shapeStay) });
    }));
    router.get('/accommodation/stays/:id', requireStaff, handle(async (req, res) => {
        const s = await stayById(req.params.id);
        if (!s) refuse(404, 'NOT_FOUND', 'Stay not found.');
        await placeFor(req, s.spot_id);
        const changes = (await query(`select action, reason, affected_months, before, after, actor_role, at from accommodation_changes
                                       where entity = 'stay' and entity_id = $1 order by at, id`, [s.id])).rows;
        const months = monthsOf(s);
        // Finalized months this stay counts in: the page shows it locked, the server refuses changes anyway.
        const locked = (await query(`select year, month from accommodation_periods where spot_id = $1 and finalized_at is not null`, [s.spot_id])).rows
            .map(p => E.monthKey(p.year, p.month)).filter(k => months.includes(k)).sort();
        res.json({ success: true, stay: shapeStay(s), months, lockedMonths: locked, changes });
    }));

    router.post('/accommodation/:spotId/stays', requireEstablishmentManager, writeLimit, handle(async (req, res) => {
        const actor = who(req);
        await transaction(async client => {
            const spot = await placeFor(req, req.params.spotId, { write: true }, client);
            await lockPlace(spot.id, client);
            const profile = await profileOf(spot.id, client);
            if (!profile.reportingFrom) refuse(409, 'NOT_SET_UP', 'Set the month reporting starts in the statistical profile first.');
            const st = await parseStay(req.body || {}, spot, client);
            if (st.checkIn < profile.reportingFrom && st.checkOut <= profile.reportingFrom) refuse(409, 'BEFORE_REPORTING', 'That stay ends before reporting starts.');
            const bookingId = ID.test(String((req.body || {}).bookingId || '')) ? req.body.bookingId : null;
            if (bookingId) {
                const b = (await query(`select spot_id, status from bookings where id = $1`, [bookingId], client)).rows[0];
                if (!b || b.spot_id !== spot.id) refuse(400, 'BAD_BOOKING', 'That booking is not for this enterprise.');
            }
            const n = (await query(`select coalesce(max(substring(reference from 4)::integer), 0) + 1 as n from accommodation_stays where spot_id = $1 and reference ~ '^ST-[0-9]+$'`, [spot.id], client)).rows[0].n;
            const reference = 'ST-' + String(n).padStart(6, '0');
            const { rows } = await query(`insert into accommodation_stays (spot_id, reference, check_in, check_out, booking_id, created_by_email)
                                          values ($1, $2, $3, $4, $5, $6) returning id`, [spot.id, reference, st.checkIn, st.checkOut, bookingId, actor.email], client);
            await writeParts(client, rows[0].id, st);
            await query('set constraints all immediate', [], client);   // the stay rules, now, so the answer is right
            const saved = await stayById(rows[0].id, client);
            const months = monthsOf(saved);
            await logChange(client, spot.id, 'stay', saved.id, 'created', '', months, null, shapeStay(saved), actor);
            res.status(201).json({ success: true, stay: shapeStay(saved), affected: await affectedStates(spot, months, client) });
        });
    }));

    router.put('/accommodation/stays/:id', requireEstablishmentManager, writeLimit, handle(async (req, res) => {
        const b = req.body || {};
        const reason = text(b.reason, 300);
        const actor = who(req);
        await transaction(async client => {
            const found = (await query('select spot_id from accommodation_stays where id = $1', [String(req.params.id)], client)).rows[0];
            if (!found) refuse(404, 'NOT_FOUND', 'Stay not found.');
            const spot = await placeFor(req, found.spot_id, { write: true }, client);   // ownership before anything about the body
            if (reason.length < 3) refuse(400, 'BAD_REASON', 'Say why the stay changes.');
            await lockPlace(spot.id, client);
            const before = await stayById(req.params.id, client);
            if (before.status !== 'active') refuse(409, 'STAY_VOID', 'This stay was voided and cannot change.');
            if (Number(b.revision) !== before.revision) refuse(409, 'STALE', 'This stay changed since you opened it. Reload it and make the change again.', { revision: before.revision });
            const st = await parseStay(b, spot, client);
            await query('update accommodation_stays set check_in = $2, check_out = $3 where id = $1', [before.id, st.checkIn, st.checkOut], client);
            await writeParts(client, before.id, st);
            await query('set constraints all immediate', [], client);
            const after = await stayById(before.id, client);
            const months = [...new Set([...monthsOf(before), ...monthsOf(after)])].sort();
            await logChange(client, spot.id, 'stay', before.id, 'edited', reason, months, shapeStay(before), shapeStay(after), actor);
            res.json({ success: true, stay: shapeStay(after), affected: await affectedStates(spot, months, client) });
        });
    }));

    router.post('/accommodation/stays/:id/void', requireEstablishmentManager, writeLimit, handle(async (req, res) => {
        const reason = text((req.body || {}).reason, 300);
        if (reason.length < 3) refuse(400, 'BAD_REASON', 'Say why the stay is voided.');
        const actor = who(req);
        await transaction(async client => {
            const found = (await query('select spot_id from accommodation_stays where id = $1', [String(req.params.id)], client)).rows[0];
            if (!found) refuse(404, 'NOT_FOUND', 'Stay not found.');
            const spot = await placeFor(req, found.spot_id, { write: true }, client);
            await lockPlace(spot.id, client);
            const before = await stayById(req.params.id, client);
            if (before.status !== 'active') refuse(409, 'STAY_VOID', 'Already voided.');
            if (Number((req.body || {}).revision) !== before.revision) refuse(409, 'STALE', 'This stay changed since you opened it. Reload it first.', { revision: before.revision });
            await query(`update accommodation_stays set status = 'void', void_reason = $2 where id = $1`, [before.id, reason], client);
            const months = monthsOf(before);
            await logChange(client, spot.id, 'stay', before.id, 'voided', reason, months, shapeStay(before), null, actor);
            res.json({ success: true, affected: await affectedStates(spot, months, client) });
        });
    }));

    /* ---- a month: DAE-1A, DAE-1B, versions --------------------------------- */
    const shapeMonth = v => ({
        success: true, enterprise: { _id: v.spot.id, name: v.spot.name }, profile: v.profile,
        state: v.state, figures: { ...v.figures, daily: v.figures.daily.map(d => ({ date: d.date, counted: d.counted, checkIn: d.checkIn, guestNights: d.guestNights,
            roomsOccupied: d.roomsOccupied, occupiedRooms: d.occupiedRooms, available: d.available, outOfService: d.outOfService, closed: d.closed })) },
        versions: v.versions, events: v.events.map(e => ({ action: e.action, versionId: e.version_id, reason: e.reason, actorRole: e.actor_role, at: e.at })),
        finalizedAt: v.period && v.period.finalized_at
    });
    router.get('/accommodation/:spotId/months/:year/:month', requireStaff, handle(async (req, res) => {
        const spot = await placeFor(req, req.params.spotId);
        const { year, month } = periodParams(req);
        res.json(shapeMonth(await monthView(spot, year, month, E.manilaToday())));
    }));

    router.post('/accommodation/:spotId/months/:year/:month/submit', requireEstablishmentManager, writeLimit, handle(async (req, res) => {
        const { year, month } = periodParams(req);
        const b = req.body || {};
        const actor = who(req);
        await transaction(async client => {
            const spot = await placeFor(req, req.params.spotId, { write: true }, client);
            await lockPlace(spot.id, client);
            const today = E.manilaToday();
            if (E.lastDay(year, month) >= today) refuse(409, 'MONTH_NOT_ENDED', `${monthName(E.monthKey(year, month))} has not ended. It can be submitted from ${E.addDays(E.lastDay(year, month), 1)}.`);
            const v = await monthView(spot, year, month, today, client);
            const s = v.state.state;
            if (s === 'not_set_up') refuse(409, 'NOT_SET_UP', 'Set the month reporting starts in the statistical profile first.');
            if (s === 'not_recorded') refuse(409, 'BEFORE_REPORTING', 'That month is before this enterprise started reporting in ZTIMS.');
            if (s === 'finalized') refuse(409, 'PERIOD_FINALIZED', 'This month is finalized. The Tourism Office must reopen it first.');
            if (s === 'municipal_total') refuse(409, 'MUNICIPAL_TOTAL_MONTH', 'This month is held as a municipal total from the paper Form A4.');
            const latest = v.versions.length ? v.versions[v.versions.length - 1] : null;
            if (Number(b.expectedVersion || 0) !== (latest ? latest.version : 0)) {
                refuse(409, 'STALE', 'A version was submitted meanwhile. Reload and check the figures again.', { latestVersion: latest ? latest.version : 0 });
            }
            if (latest && s === 'submitted') refuse(409, 'ALREADY_SUBMITTED', `Version ${latest.version} already matches the register. Nothing to correct.`);
            const reason = text(b.reason, 300);
            if (latest && reason.length < 3) refuse(400, 'BAD_REASON', 'Give the reason for the correction.');
            const fig = E.versionFigures(v.figures);
            const src = E.sourceDigest(v.records, year, month);
            const late = Date.now() > E.deadlineFor(year, month).getTime();
            const { rows } = await query(
                `insert into accommodation_report_versions (spot_id, year, month, version, provenance, rooms, room_nights_available, room_nights_occupied,
                     guest_nights, arrivals, source_digest, source_stays, reason, late, submitted_by_role, submitted_by_email, detail)
                 values ($1, $2, $3, $4, 'register', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning id`,
                [spot.id, year, month, (latest ? latest.version : 0) + 1, fig.rooms, fig.roomNightsAvailable, fig.roomNightsOccupied, fig.guestNights,
                 fig.arrivals, src.digest, src.stays, reason, late, actor.role, actor.email, JSON.stringify(E.versionDetail(v.figures))], client);
            for (const [code, c] of Object.entries(fig.counts)) {
                await query('insert into accommodation_report_version_counts (version_id, residence_code, male, female) values ($1, $2, $3, $4)', [rows[0].id, code, c.male, c.female], client);
            }
            await query(`insert into accommodation_period_events (spot_id, year, month, action, version_id, reason, actor_role, actor_email)
                         values ($1, $2, $3, 'submitted', $4, $5, $6, $7)`, [spot.id, year, month, rows[0].id, reason, actor.role, actor.email], client);
            await query('set constraints all immediate', [], client);
            res.status(201).json(shapeMonth(await monthView(spot, year, month, today, client)));
        });
    }));

    router.get('/accommodation/versions/:id', requireStaff, handle(async (req, res) => {
        const v = (await query('select * from accommodation_report_versions where id = $1', [String(req.params.id)])).rows[0];
        if (!v) refuse(404, 'NOT_FOUND', 'Version not found.');
        await placeFor(req, v.spot_id);
        const counts = (await query('select * from accommodation_report_version_counts where version_id = $1', [v.id])).rows;
        res.json({ success: true, year: v.year, month: v.month, spotId: v.spot_id, version: shapeVersion(v, counts) });
    }));

    /* ---- the officer: finalize, reopen ------------------------------------- */
    router.post('/accommodation/:spotId/months/:year/:month/finalize', requireAdmin, handle(async (req, res) => {
        const { year, month } = periodParams(req);
        const actor = who(req);
        await transaction(async client => {
            const spot = await placeFor(req, req.params.spotId, {}, client);
            await lockPlace(spot.id, client);
            const today = E.manilaToday();
            const v = await monthView(spot, year, month, today, client);
            const latest = v.versions[v.versions.length - 1];
            if (v.state.state === 'finalized') refuse(409, 'ALREADY_FINALIZED', 'Already finalized.');
            if (!latest || v.state.state === 'reopened') refuse(409, 'NO_CURRENT_VERSION', 'There is no submitted version to finalize. After a reopening the enterprise must submit again.');
            if (v.state.state === 'changed') refuse(409, 'REGISTER_CHANGED', `The enterprise changed its register after version ${latest.version}. It must submit the correction first.`, { differences: v.state.differences });
            if (Number((req.body || {}).expectedVersion) !== latest.version) refuse(409, 'STALE', 'A newer version arrived. Reload and review it.', { latestVersion: latest.version });
            await query(`insert into accommodation_periods (spot_id, year, month, finalized_at, finalized_by_email, finalized_version_id)
                         values ($1, $2, $3, now(), $4, $5)
                         on conflict (spot_id, year, month) do update set finalized_at = now(), finalized_by_email = excluded.finalized_by_email,
                             finalized_version_id = excluded.finalized_version_id`, [spot.id, year, month, actor.email, latest._id], client);
            await query(`insert into accommodation_period_events (spot_id, year, month, action, version_id, actor_role, actor_email)
                         values ($1, $2, $3, 'finalized', $4, $5, $6)`, [spot.id, year, month, latest._id, actor.role, actor.email], client);
            res.json(shapeMonth(await monthView(spot, year, month, today, client)));
        });
    }));

    router.post('/accommodation/:spotId/months/:year/:month/reopen', requireAdmin, handle(async (req, res) => {
        const { year, month } = periodParams(req);
        const reason = text((req.body || {}).reason, 300);
        if (reason.length < 10) refuse(400, 'BAD_REASON', 'Give a reason of at least 10 characters. The enterprise sees it.');
        const actor = who(req);
        await transaction(async client => {
            const spot = await placeFor(req, req.params.spotId, {}, client);
            await lockPlace(spot.id, client);
            const p = (await query('select * from accommodation_periods where spot_id = $1 and year = $2 and month = $3 for update', [spot.id, year, month], client)).rows[0];
            if (!p || !p.finalized_at) refuse(409, 'NOT_FINALIZED', 'This month is not finalized.');
            await query(`update accommodation_periods set finalized_at = null, finalized_by_email = '', finalized_version_id = null where spot_id = $1 and year = $2 and month = $3`, [spot.id, year, month], client);
            await query(`insert into accommodation_period_events (spot_id, year, month, action, version_id, reason, actor_role, actor_email)
                         values ($1, $2, $3, 'reopened', $4, $5, $6, $7)`, [spot.id, year, month, p.finalized_version_id, reason, actor.role, actor.email], client);
            res.json(shapeMonth(await monthView(spot, year, month, E.manilaToday(), client)));
        });
    }));

    /* ---- a year: one enterprise, and the tracker ------------------------- */
    async function yearStates(spot, year, today, client) {
        const rec = await loadRecords(spot.id, `${year}-01-01`, `${year + 1}-01-01`, client);
        const sec = await sections(client);
        const profile = await profileOf(spot.id, client);
        const versions = (await query('select * from accommodation_report_versions where spot_id = $1 and year = $2 order by month, version', [spot.id, year], client)).rows;
        const counts = versions.length ? (await query('select * from accommodation_report_version_counts where version_id = any($1)', [versions.map(v => v.id)], client)).rows : [];
        const periods = (await query('select * from accommodation_periods where spot_id = $1 and year = $2', [spot.id, year], client)).rows;
        const events = (await query('select * from accommodation_period_events where spot_id = $1 and year = $2 order by at, id', [spot.id, year], client)).rows;
        const municipal = new Set((await query(`select month from monthly_reports where kind = 'municipal_total' and status = 'submitted' and year = $1`, [year], client)).rows.map(r => r.month));
        return Array.from({ length: 12 }, (_, i) => {
            const month = i + 1;
            const vs = versions.filter(v => v.month === month).map(v => shapeVersion(v, counts.filter(c => c.version_id === v.id)));
            const figures = E.monthFigures(rec, year, month, { today, sections: sec });
            const period = periods.find(p => p.month === month);
            const state = E.periodState({ year, month, today, reportingFrom: profile.reportingFrom, versions: vs, finalized: !!(period && period.finalized_at),
                                          events: events.filter(e => e.month === month), figures, municipal: municipal.has(month) });
            return { month, state: state.state, latestVersion: vs.length ? vs[vs.length - 1] : null, notOperating: figures.notOperating };
        });
    }

    router.get('/accommodation/:spotId/year/:year', requireStaff, handle(async (req, res) => {
        const spot = await placeFor(req, req.params.spotId);
        const year = Number(req.params.year);
        if (!Number.isInteger(year) || year < 2000 || year > 2100) refuse(400, 'BAD_PERIOD', 'Give a year.');
        const months = await yearStates(spot, year, E.manilaToday());
        const sec = await sections();
        const reported = months.map(m => (m.latestVersion ? m.latestVersion.figures : null));
        const totals = E.annualTotals(reported);
        const volume = { philippine: { male: 0, female: 0 }, foreign: { male: 0, female: 0 }, overseas_filipino: { male: 0, female: 0 }, unspecified: { male: 0, female: 0 } };
        for (const [code, c] of Object.entries(totals.counts)) { const v = volume[sec[code] || 'unspecified']; v.male += c.male; v.female += c.female; }
        res.json({ success: true, year, enterprise: { _id: spot.id, name: spot.name }, months, totals: { ...totals, volume },
                   complete: months.every(m => ['submitted', 'finalized', 'not_operating'].includes(m.state)) });
    }));

    router.get('/accommodation/tracker', requireAdmin, handle(async (req, res) => {
        const year = Number(req.query.year);
        if (!Number.isInteger(year) || year < 2000 || year > 2100) refuse(400, 'BAD_PERIOD', 'Give a year.');
        const spots = (await query(
            `select s.id, s.title, s.status, s.created_at, coalesce(nullif(s.enterprise_name, ''), s.title) as name from spots s
              where s.type = 'accommodation' and s.managed_by is not null
                and (s.status <> 'archived' or exists (select 1 from accommodation_report_versions v where v.spot_id = s.id and v.year = $1))
              order by name`, [year])).rows;
        const today = E.manilaToday();
        const rows = [];
        for (const s of spots) rows.push({ _id: s.id, name: s.name, months: (await yearStates(s, year, today)).map(m => ({ month: m.month, state: m.state, latestVersion: m.latestVersion ? m.latestVersion.version : 0 })) });
        res.json({ success: true, year, enterprises: rows });
    }));

    /* ---- FORM A: the municipality's year ---------------------------------- */
    /* Each month has one source: the paper municipal total where one is held,
       otherwise every enterprise's latest saved version. Never both. A month
       of enterprise reports is complete when every enterprise expected that
       month reported or was not operating; missing ones are not filled in. */
    async function municipalYear(year, client) {
        const residences = (await query('select code, name, section, continent, region, sort_order from residences order by sort_order', [], client)).rows;
        const municipal = (await query(`select * from monthly_reports where kind = 'municipal_total' and status = 'submitted' and year = $1`, [year], client)).rows;
        const mCounts = municipal.length ? (await query('select * from monthly_report_counts where report_id = any($1)', [municipal.map(m => m.id)], client)).rows : [];
        const latest = (await query(
            `select distinct on (spot_id, month) * from accommodation_report_versions where year = $1 order by spot_id, month, version desc`, [year], client)).rows;
        const vCounts = latest.length ? (await query('select * from accommodation_report_version_counts where version_id = any($1)', [latest.map(v => v.id)], client)).rows : [];
        const spots = (await query(
            `select s.id, s.created_at, s.status, p.reporting_from from spots s left join accommodation_profiles p on p.spot_id = s.id
              where s.type = 'accommodation' and s.managed_by is not null`, [], client)).rows;
        const closed = (await query('select spot_id, starts_on, ends_on from accommodation_closed_periods where voided_at is null', [], client)).rows;
        const finalizedSet = new Set((await query('select spot_id, month from accommodation_periods where year = $1 and finalized_at is not null', [year], client)).rows.map(p => p.spot_id + ':' + p.month));
        const months = [];
        for (let month = 1; month <= 12; month++) {
            const first = E.firstDay(year, month), last = E.lastDay(year, month);
            const m = municipal.find(r => r.month === month);
            if (m) {
                const counts = {};
                for (const c of mCounts.filter(c => c.report_id === m.id)) counts[c.residence_code] = c.male === null ? { unsplit: c.total_unsplit } : { male: c.male, female: c.female };
                months.push({ month, source: 'municipal_total', complete: true, sexSplit: mCounts.filter(c => c.report_id === m.id).every(c => c.male !== null),
                    rooms: m.rooms, roomNightsOccupied: m.room_nights_occupied, guestNights: m.guest_nights,
                    // The paper sheet gives rooms, not room-nights available: rooms × days, stated as derived.
                    roomNightsAvailable: m.rooms == null ? null : m.rooms * E.daysIn(year, month), roomNightsAvailableDerived: true,
                    arrivals: Object.values(counts).reduce((a, c) => a + (c.unsplit || 0) + (c.male || 0) + (c.female || 0), 0), counts, locked: !!m.locked_at });
                continue;
            }
            // Every private place to stay listed now (an archived one only if it reported that month).
            // One that opened later records the months before as a closed period.
            const expected = spots.filter(s => s.status !== 'archived' || latest.some(v => v.spot_id === s.id && v.month === month));
            const vs = latest.filter(v => v.month === month);
            const reportedIds = new Set(vs.map(v => v.spot_id));
            const notOperating = expected.filter(s => !reportedIds.has(s.id) && isClosedMonth(closed.filter(c => c.spot_id === s.id), first, last)).map(s => s.id);
            const beforeReporting = expected.filter(s => !reportedIds.has(s.id) && s.reporting_from && E.toDate(s.reporting_from) > first).map(s => s.id);
            const missing = expected.filter(s => !reportedIds.has(s.id) && !notOperating.includes(s.id)).map(s => s.id);
            if (first > E.manilaToday() || !vs.length) {
                months.push({ month, source: vs.length ? 'enterprise_reports' : 'none', complete: false, expected: expected.length, reported: 0, notOperating: notOperating.length, missing: missing.length, beforeReporting: beforeReporting.length });
                continue;
            }
            const counts = {};
            for (const c of vCounts.filter(c => vs.some(v => v.id === c.version_id))) {
                const x = counts[c.residence_code] || (counts[c.residence_code] = { male: 0, female: 0 });
                x.male += c.male; x.female += c.female;
            }
            const sum = k => vs.reduce((a, v) => a + v[k], 0);
            months.push({ month, source: 'enterprise_reports', complete: missing.length === 0, sexSplit: true,
                expected: expected.length, reported: vs.length, notOperating: notOperating.length, missing: missing.length, beforeReporting: beforeReporting.length,
                finalized: vs.filter(v => finalizedSet.has(v.spot_id + ':' + month)).length,
                legacyManual: vs.filter(v => v.provenance === 'legacy_manual').length,
                rooms: sum('rooms'), roomNightsOccupied: sum('room_nights_occupied'), roomNightsAvailable: sum('room_nights_available'),
                guestNights: sum('guest_nights'), arrivals: sum('arrivals'), counts });
        }
        return { residences, months };
    }
    function isClosedMonth(periods, first, last) {
        for (let d = first; d <= last; d = E.addDays(d, 1)) if (!periods.some(p => E.toDate(p.starts_on) <= d && d <= E.toDate(p.ends_on))) return false;
        return true;
    }
    const countOf = c => (c ? (c.unsplit || 0) + (c.male || 0) + (c.female || 0) : 0);
    const hasData = m => m && (m.source === 'municipal_total' || (m.source === 'enterprise_reports' && m.reported > 0));

    router.get('/accommodation/form-a', requireAdmin, handle(async (req, res) => {
        const year = Number(req.query.year);
        if (!Number.isInteger(year) || year < 2001 || year > 2100) refuse(400, 'BAD_PERIOD', 'Give a year.');
        const cur = await municipalYear(year);
        const prev = await municipalYear(year - 1);
        // Comparable months: complete coverage in both years. Only these enter the comparison.
        const comparable = cur.months.filter((m, i) => hasData(m) && m.complete && hasData(prev.months[i]) && prev.months[i].complete).map(m => m.month);
        const grand = cur.months.filter(hasData).reduce((a, m) => a + m.arrivals, 0);
        const rows = cur.residences.map(r => {
            const months = cur.months.map(m => (hasData(m) ? countOf(m.counts[r.code]) : null));
            const total = months.reduce((a, n) => a + (n || 0), 0);
            const c = comparable.reduce((a, mm) => a + countOf(cur.months[mm - 1].counts[r.code]), 0);
            const p = comparable.reduce((a, mm) => a + countOf(prev.months[mm - 1].counts[r.code]), 0);
            return { code: r.code, name: r.name, section: r.section, continent: r.continent, region: r.region,
                     months, total, share: E.ratio(total, grand),
                     comparison: comparable.length ? { current: c, previous: p, percentDifference: E.percentDifference(c, p) } : null };
        });
        const part2 = (y, months) => {
            const ms = months.filter(hasData);
            const s = k => ms.reduce((a, m) => a + (m[k] || 0), 0);
            return { roomNightsOccupied: s('roomNightsOccupied'), roomNightsAvailable: s('roomNightsAvailable'), guestNights: s('guestNights'), arrivals: s('arrivals'),
                     occupancyRate: E.ratio(s('roomNightsOccupied'), s('roomNightsAvailable')), averageLengthOfStay: E.ratio(s('guestNights'), s('arrivals')) };
        };
        const pick = (months, list) => months.filter(m => list.includes(m.month));
        const sexMonths = cur.months.filter(m => hasData(m) && m.sexSplit);
        const volume = {};
        for (const sec of ['philippine', 'foreign', 'overseas_filipino', 'unspecified']) {
            volume[sec] = { male: 0, female: 0 };
            for (const m of sexMonths) for (const r of cur.residences.filter(x => x.section === sec)) {
                const c = m.counts[r.code]; if (c) { volume[sec].male += c.male || 0; volume[sec].female += c.female || 0; }
            }
        }
        res.json({
            success: true, year,
            months: cur.months.map(m => ({ ...m, counts: undefined })),
            rows, grandTotal: grand,
            partII: { months: cur.months.map(m => (hasData(m) ? { roomNightsOccupied: m.roomNightsOccupied, roomNightsAvailable: m.roomNightsAvailable,
                          roomNightsAvailableDerived: !!m.roomNightsAvailableDerived, guestNights: m.guestNights,
                          occupancyRate: E.ratio(m.roomNightsOccupied, m.roomNightsAvailable), averageLengthOfStay: E.ratio(m.guestNights, m.arrivals) } : null)),
                      total: part2(year, cur.months),
                      comparison: comparable.length ? { current: part2(year, pick(cur.months, comparable)), previous: part2(year - 1, pick(prev.months, comparable)) } : null },
            volumePerSex: { months: sexMonths.map(m => m.month), notRecordedMonths: cur.months.filter(m => hasData(m) && !m.sexSplit).map(m => m.month), ...volume },
            comparison: { previousYear: year - 1, comparableMonths: comparable,
                          unavailableReason: comparable.length ? null : 'No month has complete coverage in both years.' }
        });
    }));

    /* ---- Excel exports (accommodation-excel.js) ----------------------------
       Each export is read through the same checks as the page: a manager
       their own enterprise, the officer any; FORM A the officer only. A month
       exports a saved version (?version=n) exactly as submitted, or the
       register now (?version=current), marked "not submitted". */
    const XLSX = require('./accommodation-excel');
    const sendXlsx = async (res, wb, name) => {
        const buffer = await XLSX.toBuffer(wb);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^A-Za-z0-9_.-]/g, '_')}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(buffer);
    };
    const fileName = (spot, tail) => `${String(spot.name).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}_${tail}.xlsx`;

    router.get('/accommodation/:spotId/months/:year/:month/export.xlsx', requireStaff, handle(async (req, res) => {
        const spot = await placeFor(req, req.params.spotId);
        const { year, month } = periodParams(req);
        const today = E.manilaToday();
        const which = String(req.query.version || 'latest');
        const view = await monthView(spot, year, month, today);
        const sec = await sections();
        let version, status;
        if (which === 'current') {
            if (E.firstDay(year, month) > today) refuse(409, 'FUTURE', 'That month has not started.');
            const f = view.figures;
            version = { ...E.versionFigures(f), detail: E.versionDetail(f) };
            status = `NOT SUBMITTED: worked out from the stay register on ${today}` + (f.partial ? ` (nights through ${f.through})` : '');
            version.countedDays = f.partial ? f.daily.filter(d => d.counted).length : null;
        } else {
            const n = which === 'latest' ? (view.versions.length ? view.versions[view.versions.length - 1].version : 0) : Number(which);
            const found = (await query('select * from accommodation_report_versions where spot_id = $1 and year = $2 and month = $3 and version = $4',
                [spot.id, year, month, n])).rows[0];
            if (!found) refuse(404, 'NO_VERSION', 'No saved version of that month. Export the register instead (version=current).');
            const counts = (await query('select * from accommodation_report_version_counts where version_id = $1', [found.id])).rows;
            version = { ...shapeVersion(found, counts).figures, detail: found.detail };
            const finalized = view.period && view.period.finalized_version_id === found.id;
            status = `Version ${found.version}${found.provenance === 'legacy_manual' ? ' (hand-typed report, no day-by-day detail)' : ''}, submitted ${E.toDate(found.submitted_at)}${finalized ? ', finalized' : ''}`;
        }
        const ctx = { year, month, days: E.daysIn(year, month), enterpriseName: spot.name, profile: view.profile, sections: sec, status,
                      rooms: version.rooms, roomNightsAvailable: version.roomNightsAvailable, detail: version.detail, countedDays: version.countedDays, version };
        const wb = XLSX.workbook();
        XLSX.addDae1A(wb, ctx);
        XLSX.addDae1B(wb, ctx, true);
        XLSX.addDae1B(wb, ctx, false);
        return sendXlsx(res, wb, fileName(spot, `DAE-1A_DAE-1B_${year}-${E.pad(month)}_${which === 'current' ? 'register' : 'v' + (version.version || which)}`));
    }));

    /* FORM A layout: the months from saved versions (or municipal totals),
       previous year only over comparable months. */
    function formAWorkbookContext(cur, prev, comparable) {
        const months = cur.months.map(m => (hasData(m) ? m : null));
        const previousMonths = prev ? prev.months.map(m => (hasData(m) ? m : null)) : null;
        const sumP = (ms, k) => ms.filter(Boolean).reduce((a, m) => a + (m[k] || 0), 0);
        const p2 = ms => { const list = ms.filter(Boolean); if (!list.length) return null;
            const o = { roomNightsOccupied: sumP(list, 'roomNightsOccupied'), roomNightsAvailable: sumP(list, 'roomNightsAvailable'), guestNights: sumP(list, 'guestNights'), arrivals: sumP(list, 'arrivals') };
            o.occupancyRate = E.ratio(o.roomNightsOccupied, o.roomNightsAvailable); o.averageLengthOfStay = E.ratio(o.guestNights, o.arrivals); return o; };
        return {
            months, previousMonths, comparable,
            partII: {
                months: months.map(m => (m ? { roomNightsOccupied: m.roomNightsOccupied, roomNightsAvailable: m.roomNightsAvailable, guestNights: m.guestNights,
                                               occupancyRate: E.ratio(m.roomNightsOccupied, m.roomNightsAvailable), averageLengthOfStay: E.ratio(m.guestNights, m.arrivals) } : null)),
                total: p2(months),
                current: comparable.length ? p2(months.filter((m, i) => comparable.includes(i + 1))) : null,
                previous: comparable.length && previousMonths ? p2(previousMonths.filter((m, i) => comparable.includes(i + 1))) : null
            }
        };
    }
    const monthList = ms => (ms.length ? ms.map(m => MONTHS[m - 1].slice(0, 3)).join(', ') : 'none');

    router.get('/accommodation/form-a.xlsx', requireAdmin, handle(async (req, res) => {
        const year = Number(req.query.year);
        if (!Number.isInteger(year) || year < 2001 || year > 2100) refuse(400, 'BAD_PERIOD', 'Give a year.');
        const cur = await municipalYear(year), prev = await municipalYear(year - 1);
        const comparable = cur.months.filter((m, i) => hasData(m) && m.complete && hasData(prev.months[i]) && prev.months[i].complete).map(m => m.month);
        const ctx = formAWorkbookContext(cur, prev, comparable);
        const reported = cur.months.filter(hasData);
        ctx.year = year;
        ctx.notes = [
            `Months with figures: ${monthList(reported.map(m => m.month))}. Blank: no report for that month (not zero).`,
            `Source: ${reported.some(m => m.source === 'municipal_total') ? 'municipal totals from the paper Form A4 (no male/female split, no enterprise detail)' : ''}${reported.some(m => m.source === 'municipal_total') && reported.some(m => m.source === 'enterprise_reports') ? '; ' : ''}${reported.some(m => m.source === 'enterprise_reports') ? 'saved enterprise reports' : ''}.`,
            `Incomplete months (an enterprise has not reported): ${monthList(cur.months.filter(m => hasData(m) && !m.complete).map(m => m.month))}.`,
            `Total (Previous Year) and % Difference cover months complete in both years only: ${monthList(comparable)}.`,
            reported.some(m => m.roomNightsAvailableDerived) ? 'Rooms available for the paper months: rooms × days in the month.' : ''
        ].filter(Boolean);
        const wb = XLSX.workbook();
        XLSX.addFormA(wb, ctx);
        return sendXlsx(res, wb, `FORM_A_Zamboanguita_${year}.xlsx`);
    }));

    router.get('/accommodation/:spotId/year/:year/export.xlsx', requireStaff, handle(async (req, res) => {
        const spot = await placeFor(req, req.params.spotId);
        const year = Number(req.params.year);
        if (!Number.isInteger(year) || year < 2001 || year > 2100) refuse(400, 'BAD_PERIOD', 'Give a year.');
        const enterpriseYear = async y => {
            const vs = (await query(`select distinct on (month) * from accommodation_report_versions where spot_id = $1 and year = $2 order by month, version desc`, [spot.id, y])).rows;
            const counts = vs.length ? (await query('select * from accommodation_report_version_counts where version_id = any($1)', [vs.map(v => v.id)])).rows : [];
            return { months: Array.from({ length: 12 }, (_, i) => {
                const v = vs.find(x => x.month === i + 1);
                if (!v) return null;
                return { month: i + 1, source: 'enterprise_reports', complete: true, reported: 1, arrivals: v.arrivals, guestNights: v.guest_nights,
                         roomNightsOccupied: v.room_nights_occupied, roomNightsAvailable: v.room_nights_available,
                         counts: Object.fromEntries(counts.filter(c => c.version_id === v.id).map(c => [c.residence_code, { male: c.male, female: c.female }])) };
            }) };
        };
        const cur = await enterpriseYear(year), prev = await enterpriseYear(year - 1);
        const comparable = cur.months.filter((m, i) => m && prev.months[i]).map(m => m.month);
        const ctx = formAWorkbookContext(cur, prev, comparable);
        ctx.year = year; ctx.enterpriseName = spot.name; ctx.sheetName = 'Annual summary';
        ctx.status = 'Annual summary of this enterprise\'s DAE-1B, in the FORM A layout';
        ctx.notes = [`Months with a submitted report: ${monthList(cur.months.filter(Boolean).map(m => m.month))}. Blank: no report (not zero).`,
                     `Total (Previous Year) and % Difference cover months reported in both years only: ${monthList(comparable)}.`];
        const wb = XLSX.workbook();
        XLSX.addFormA(wb, ctx);
        return sendXlsx(res, wb, fileName(spot, `annual_${year}`));
    }));

    /* The blank templates, for anyone keeping a paper copy. Staff only. */
    router.get('/accommodation/templates/:name', requireStaff, handle(async (req, res) => {
        const name = String(req.params.name);
        const wb = XLSX.workbook();
        const blankProfile = { accommodationType: '', accommodationTypeOther: '', dotClassification: '', aeCode: '' };
        if (name === 'dae1a.xlsx') XLSX.addDae1A(wb, { detail: null, days: 31, enterpriseName: '' });
        else if (name === 'dae1b.xlsx') { XLSX.addDae1B(wb, { profile: blankProfile, sections: await sections(), enterpriseName: '', version: null, days: 31 }, true); XLSX.addDae1B(wb, { profile: blankProfile, sections: await sections(), enterpriseName: '', version: null }, false); }
        else if (name === 'form-a.xlsx') XLSX.addFormA(wb, { year: '', months: Array(12).fill(null), comparable: [], partII: { months: Array(12).fill(null), total: null } });
        else refuse(404, 'NOT_FOUND', 'No such template.');
        return sendXlsx(res, wb, `blank_${name}`);
    }));

    return router;
};
