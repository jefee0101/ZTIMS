/* Analytics: read-only statistics for the Tourism Officer, Enterprise Managers
 * and Support Staff, mounted at /api by server.js (routes /api/analytics/*).
 * The approved design: docs/analytics/ (inventory, role dashboards, gaps).
 *
 * Authoritative sources only, the same ones the reports use:
 *   accommodation  accommodation_report_versions (+ _counts) chosen per
 *                  enterprise-month: official = the finalized version,
 *                  operational = the latest saved version (as FORM A reads);
 *                  2025 paper totals (monthly_reports municipal_total) as a
 *                  separate baseline, never added to enterprise figures.
 *   attractions    attraction-visits.js's own month sources (yearSources):
 *                  official = finalized, operational = also submitted and
 *                  draft, exactly as DTA2M and VAR 3M choose them.
 *   reservations   bookings (ZTIMS room requests). Never arrivals.
 *   stays          the manager's own stay register (live, operational).
 * Arithmetic lives in analytics-engine.js; screens and the Excel file call the
 * same functions here, so a card, a chart and a cell cannot disagree.
 *
 * Who: the officer reads everything. A manager reads accommodation, stays,
 * reservations and the benchmark of their own enterprises only. Support Staff
 * read their one attraction only. Visitors and anyone else: nothing. The
 * scope comes from the signed-in account, never from the request.
 *
 * Never: money, percentages beyond the DAE-defined rates for places to stay,
 * a missing month as 0, an invented breakdown, or "unique tourists".
 */
'use strict';
const express = require('express');
const { query } = require('./db');
const A = require('./analytics-engine');
const AE = require('./attraction-engine');
const { sources: ATT } = require('./attraction-visits');

const ID = /^[0-9a-f]{24}$/i;
const CATEGORIES = ['BEACH', 'DIVING', 'NATURE', 'ADVENTURE', 'CULTURE', 'FAITH', 'LEISURE'];
const MAX_MONTHS = 36, MAX_DAYS = 366, MIN_GROUP = 3;
const MANAGER_ROLES = ['establishment_manager', 'resort_owner'];
const role = req => (req.auth && req.auth.role) || '';
const isOfficer = req => role(req) === 'admin';
const isManager = req => MANAGER_ROLES.includes(role(req));
const isStaff = req => role(req) === 'support_staff';

class Refusal extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const refuse = (status, code, message) => { throw new Refusal(status, code, message); };

/* ---- request parameters: a fixed list, each checked; anything else is refused ---- */
const COMMON = ['from', 'to', 'granularity', 'mode', 'compare', 'barangay', 'category', 'spotId', 'bbox'];
function params(req, allowed = COMMON, { days = false } = {}) {
    const q = req.query || {};
    for (const k of Object.keys(q)) if (!allowed.includes(k)) refuse(400, 'BAD_PARAM', `"${k}" is not a filter here.`);
    for (const [k, v] of Object.entries(q)) if (typeof v !== 'string') refuse(400, 'BAD_PARAM', `Give "${k}" once.`);
    const today = A.manilaToday();
    const p = {};
    if (days) {
        const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && A.addDays(s, 0) === s;
        p.to = q.to || today; p.from = q.from || A.addDays(p.to, -29);
        if (!isDay(p.from) || !isDay(p.to)) refuse(400, 'BAD_PERIOD', 'Give dates as YYYY-MM-DD.');
        if (p.from > p.to) refuse(400, 'BAD_PERIOD', 'The start is after the end.');
        if ((Date.parse(p.to) - Date.parse(p.from)) / 864e5 + 1 > MAX_DAYS) refuse(400, 'BAD_PERIOD', `At most ${MAX_DAYS} days at a time.`);
        if (p.from < '2000-01-01' || p.to > '2100-12-31') refuse(400, 'BAD_PERIOD', 'Dates from 2000 to 2100.');
    } else {
        const isMonth = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
        p.to = q.to || today.slice(0, 7);
        p.from = q.from || A.monthRange(A.monthKey(+p.to.slice(0, 4) - 1, +p.to.slice(5, 7)), p.to)[1] || p.to;
        if (!isMonth(p.from) || !isMonth(p.to)) refuse(400, 'BAD_PERIOD', 'Give months as YYYY-MM.');
        if (p.from > p.to) refuse(400, 'BAD_PERIOD', 'The start is after the end.');
        if (p.from < '2000-01' || p.to > '2100-12') refuse(400, 'BAD_PERIOD', 'Months from 2000 to 2100.');
        if (A.monthRange(p.from, p.to).length > MAX_MONTHS) refuse(400, 'BAD_PERIOD', `At most ${MAX_MONTHS} months at a time.`);
    }
    p.granularity = q.granularity || 'month';
    if (!['month', 'quarter', 'year'].includes(p.granularity)) refuse(400, 'BAD_PARAM', 'granularity is month, quarter or year.');
    p.mode = q.mode || 'official';
    if (!['official', 'operational'].includes(p.mode)) refuse(400, 'BAD_PARAM', 'mode is official or operational.');
    p.compare = q.compare || '';
    if (p.compare && p.compare !== 'previous-year') refuse(400, 'BAD_PARAM', 'compare is previous-year.');
    if (q.barangay != null) { p.barangay = q.barangay.trim(); if (!p.barangay || p.barangay.length > 60) refuse(400, 'BAD_PARAM', 'Give a barangay name.'); }
    if (q.category != null) { p.category = q.category.toUpperCase(); if (!CATEGORIES.includes(p.category)) refuse(400, 'BAD_PARAM', `category is one of ${CATEGORIES.join(', ')}.`); }
    if (q.spotId != null) { if (!ID.test(q.spotId)) refuse(400, 'BAD_PARAM', 'spotId is a place id.'); p.spotId = q.spotId; }
    if (q.bbox != null) {
        const b = q.bbox.split(',').map(Number);
        if (b.length !== 4 || b.some(n => !Number.isFinite(n)) || b[0] >= b[2] || b[1] >= b[3] || b[0] < -180 || b[2] > 180 || b[1] < -90 || b[3] > 90)
            refuse(400, 'BAD_PARAM', 'bbox is minLng,minLat,maxLng,maxLat.');
        p.bbox = b;
    }
    p.filtered = !!(p.barangay || p.category || p.spotId || p.bbox);
    return p;
}

/* ---- places in scope: role first, then the filters ------------------------- */
const PLACE_COLS = `s.id, s.title, coalesce(nullif(s.enterprise_name, ''), s.title) as name, s.status, s.barangay, s.category, s.latitude, s.longitude,
                    s.managed_by, s.working_days, s.counts_visitors,
                    coalesce((select array_agg(m.category order by m.position) from spot_more_categories m where m.spot_id = s.id), '{}') as more`;
function filterSql(p, args) {
    const w = [];
    if (p.spotId) { args.push(p.spotId); w.push(`s.id = $${args.length}`); }
    if (p.barangay) { args.push(p.barangay); w.push(`lower(s.barangay) = lower($${args.length})`); }
    if (p.category) { args.push(p.category); w.push(`(s.category = $${args.length} or exists (select 1 from spot_more_categories m where m.spot_id = s.id and m.category = $${args.length}))`); }
    if (p.bbox) { args.push(...p.bbox); const n = args.length; w.push(`s.longitude between $${n - 3} and $${n - 1} and s.latitude between $${n - 2} and $${n}`); }
    return w.length ? ' and ' + w.join(' and ') : '';
}
const shapePlace = s => ({ _id: s.id, name: s.name, barangay: s.barangay || '', category: s.category, categories: [s.category, ...(s.more || [])].filter(Boolean),
    latitude: s.latitude == null ? null : Number(s.latitude), longitude: s.longitude == null ? null : Number(s.longitude), status: s.status });

async function accommodationPlaces(req, p) {
    if (!isOfficer(req) && !isManager(req)) refuse(403, 'NOT_ALLOWED', 'Accommodation statistics are for the Tourism Office and Enterprise Managers.');
    const args = [];
    let where = `s.type = 'accommodation' and s.managed_by is not null`;
    if (isManager(req)) { args.push(String(req.auth.sub)); where += ` and s.managed_by = $${args.length}`; }
    where += filterSql(p, args);
    const rows = (await query(`select ${PLACE_COLS}, pr.reporting_from from spots s left join accommodation_profiles pr on pr.spot_id = s.id where ${where} order by name limit 500`, args)).rows;
    if (p.spotId && !rows.length) refuse(isManager(req) ? 403 : 404, 'NOT_YOURS', isManager(req) ? 'This enterprise is not yours.' : 'No private place to stay with that id.');
    return rows;
}
async function attractionPlaces(req, p, years) {
    if (!isOfficer(req) && !isStaff(req)) refuse(403, 'NOT_ALLOWED', 'Attraction statistics are for the Tourism Office and Support Staff.');
    // The same list DTA2M and VAR 3M use: office-run attractions that count visitors, or that reported in these years.
    const args = [years];
    let where = `s.type = 'spot' and s.managed_by is null and ((s.counts_visitors and s.status <> 'archived')
                 or exists (select 1 from attraction_report_versions v where v.spot_id = s.id and v.year = any($1)))`;
    if (isStaff(req)) {
        if (p.spotId && String(p.spotId) !== String(req.account.spot_id)) refuse(403, 'NOT_YOURS', 'This is not the attraction you look after.');
        args.push(String(req.account.spot_id)); where += ` and s.id = $${args.length}`;
    }
    where += filterSql(p, args);
    const rows = (await query(`select ${PLACE_COLS} from spots s where ${where} order by s.title limit 200`, args)).rows;
    if (p.spotId && !rows.length) refuse(404, 'NOT_FOUND', 'No office-run attraction in reporting with that id.');
    return rows;
}

/* ---- accommodation: month rows ---------------------------------------------- */
/* One row per month: figures from the chosen versions, coverage, completeness.
   Mirrors FORM A's rules (accommodation.js municipalYear): an enterprise is expected
   unless archived (and not reporting) or closed the whole month; a missing one is
   never filled in; a month held as a paper municipal total has no enterprise figures. */
async function accommodationMonths(places, keys, mode) {
    const today = A.manilaToday();
    const ids = places.map(s => s.id);
    const lo = +keys[0].replace('-', ''), hi = +keys[keys.length - 1].replace('-', '');
    const versions = ids.length ? (await query(
        `select v.id, v.spot_id, v.year, v.month, v.version, v.rooms, v.arrivals, v.guest_nights, v.room_nights_occupied, v.room_nights_available,
                (p.finalized_version_id = v.id) as final
           from accommodation_report_versions v
           left join accommodation_periods p on p.spot_id = v.spot_id and p.year = v.year and p.month = v.month and p.finalized_at is not null
          where v.spot_id = any($1) and v.year * 100 + v.month between $2 and $3`, [ids, lo, hi])).rows : [];
    const closed = ids.length ? (await query(`select spot_id, starts_on, ends_on from accommodation_closed_periods where voided_at is null and spot_id = any($1)`, [ids])).rows : [];
    const municipal = new Set((await query(`select year * 100 + month as k from monthly_reports where kind = 'municipal_total' and status = 'submitted' and year * 100 + month between $1 and $2`, [lo, hi])).rows.map(r => r.k));
    // The version each enterprise-month contributes: the finalized one (official) or the latest saved (operational).
    const byPm = new Map();
    for (const v of versions) {
        const k = `${v.spot_id}:${v.year}-${A.pad(v.month)}`, cur = byPm.get(k) || { latest: null, final: null };
        if (!cur.latest || v.version > cur.latest.version) cur.latest = v;
        if (v.final) cur.final = v;
        byPm.set(k, cur);
    }
    const chosenIds = [];
    for (const c of byPm.values()) { const v = mode === 'official' ? c.final : c.latest; if (v) chosenIds.push(v.id); }
    const counts = chosenIds.length ? (await query(
        `select c.version_id, r.section, c.male, c.female, r.code, r.name from accommodation_report_version_counts c join residences r on r.code = c.residence_code where c.version_id = any($1)`,
        [chosenIds])).rows : [];
    const countsBy = new Map(); for (const c of counts) { if (!countsBy.has(c.version_id)) countsBy.set(c.version_id, []); countsBy.get(c.version_id).push(c); }
    const closedWhole = (spotId, y, m) => {
        const ps = closed.filter(c => c.spot_id === spotId);
        for (let d = A.firstDay(y, m); d <= A.lastDay(y, m); d = A.addDays(d, 1)) if (!ps.some(c => A.toDate(c.starts_on) <= d && d <= A.toDate(c.ends_on))) return false;
        return ps.length > 0;
    };
    const perPlace = new Map(places.map(s => [s.id, []]));
    const rows = keys.map(key => {
        const [y, m] = A.parseKey(key), first = A.firstDay(y, m);
        if (first > today) { places.forEach(s => perPlace.get(s.id).push(null)); return { key, future: true, figures: null, coverage: {}, complete: false }; }
        if (municipal.has(y * 100 + m)) { places.forEach(s => perPlace.get(s.id).push(null)); return { key, municipalTotal: true, figures: null, coverage: { municipalTotal: 1 }, complete: false }; }
        const cov = { expected: 0, finalized: 0, submitted: 0, missing: 0, notOperating: 0, beforeReporting: 0 };
        const used = [];
        for (const s of places) {
            const c = byPm.get(`${s.id}:${key}`);
            const anyVersion = c && c.latest;
            if (s.status === 'archived' && !anyVersion) { perPlace.get(s.id).push(null); continue; }
            cov.expected++;
            if (c && c.final) cov.finalized++; else if (anyVersion) cov.submitted++;
            const v = c ? (mode === 'official' ? c.final : c.latest) : null;
            if (v) { used.push(v); perPlace.get(s.id).push({ v, counts: countsBy.get(v.id) || [] }); continue; }
            perPlace.get(s.id).push(null);
            if (anyVersion) continue;                       // saved but not finalized: counted under "submitted", not figures (official)
            if (closedWhole(s.id, y, m)) { cov.notOperating++; continue; }
            cov.missing++;
            if (!s.reporting_from || A.toDate(s.reporting_from) > first) cov.beforeReporting++;
        }
        const figures = A.accMonth(used, used.flatMap(v => countsBy.get(v.id) || []));
        const complete = cov.missing === 0 && (mode === 'operational' || cov.submitted === 0) && cov.expected > 0;
        return { key, future: false, figures, coverage: cov, complete, partial: !!figures && !complete };
    });
    return { rows, perPlace, counts: { byVersion: countsBy } };
}
/* The paper municipal totals for months in range: their own series, never mixed in. */
async function municipalBaseline(keys) {
    const lo = +keys[0].replace('-', ''), hi = +keys[keys.length - 1].replace('-', '');
    const reps = (await query(`select id, year, month, rooms, room_nights_occupied, guest_nights from monthly_reports
                                where kind = 'municipal_total' and status = 'submitted' and year * 100 + month between $1 and $2`, [lo, hi])).rows;
    const cnt = reps.length ? (await query(`select c.report_id, r.section, c.male, c.female, c.total from monthly_report_counts c join residences r on r.code = c.residence_code where c.report_id = any($1)`, [reps.map(r => r.id)])).rows : [];
    return keys.map(key => {
        const [y, m] = A.parseKey(key), r = reps.find(x => x.year === y && x.month === m);
        if (!r) return { key, figures: null };
        const cs = cnt.filter(c => c.report_id === r.id), residence = A.emptySections();
        cs.forEach(c => { residence[c.section] = (residence[c.section] || 0) + c.total; });
        const split = cs.length && cs.every(c => c.male != null);
        return { key, figures: { arrivals: cs.reduce((a, c) => a + c.total, 0), guestNights: r.guest_nights, roomNightsOccupied: r.room_nights_occupied, rooms: r.rooms,
                                 roomNightsAvailable: null, residence, sex: split ? { male: cs.reduce((a, c) => a + c.male, 0), female: cs.reduce((a, c) => a + c.female, 0) } : null } };
    });
}

/* Paper-total months added into a period: arrivals, guest nights and room-nights occupied only. A period
   with any month not on paper is incomplete and has no total. No sex split and no room-nights available
   exist for these months, so none is shown (never 0). */
function baselineAdder(rows) {
    const has = rows.filter(r => r.figures);
    const f = has.length === rows.length && has.length ? has.reduce((a, r) => ({ arrivals: a.arrivals + r.figures.arrivals, guestNights: a.guestNights + r.figures.guestNights,
        roomNightsOccupied: a.roomNightsOccupied + r.figures.roomNightsOccupied }), { arrivals: 0, guestNights: 0, roomNightsOccupied: 0 }) : null;
    return { figures: f, complete: !!f, future: false, months: rows.map(r => r.key) };
}

/* ---- attractions: month rows -------------------------------------------------- */
async function attractionMonths(places, keys, mode) {
    const years = [...new Set(keys.map(k => +k.slice(0, 4)))];
    const src = new Map();                                  // spotId:key -> { state, source }
    for (const s of places) for (const y of years) {
        const ys = await ATT.yearSources(s, y, mode);
        ys.months.forEach(m => src.set(`${s.id}:${y}-${A.pad(m.month)}`, m));
    }
    const perPlace = new Map(places.map(s => [s.id, []]));
    const rows = keys.map(key => {
        const cov = { expected: 0, finalized: 0, submitted: 0, draft: 0, notSubmitted: 0, noStaff: 0 };
        let figures = null, future = true;
        for (const s of places) {
            const m = src.get(`${s.id}:${key}`), st = m ? m.state.state : 'before', kind = m ? m.source.kind : 'before';
            if (st !== 'future') future = false;
            if (st === 'before' || st === 'future') { perPlace.get(s.id).push(null); continue; }
            cov.expected++;
            if (kind === 'final') cov.finalized++; else if (kind === 'submitted' || kind === 'reopened') cov.submitted++;
            else if (kind === 'draft') cov.draft++; else if (kind === 'nostaff') cov.noStaff++; else cov.notSubmitted++;
            const f = A.attMonthFigures(m.source, AE);
            perPlace.get(s.id).push(f ? { figures: f, kind, version: m.source.version || null, pending: !!m.source.pending } : null);
            figures = A.addAtt(figures, f);
        }
        const complete = cov.expected > 0 && (mode === 'official' ? cov.finalized === cov.expected : cov.finalized + cov.submitted === cov.expected);
        return { key, future, figures, coverage: cov, complete, partial: !!figures && !complete };
    });
    return { rows, perPlace };
}

/* ---- series with periods, peak and low, and the comparison --------------------- */
async function accommodationSeries(req, p) {
    const places = await accommodationPlaces(req, p);
    const keys = A.monthRange(p.from, p.to);
    const cur = await accommodationMonths(places, keys, p.mode);
    const periods = A.toPeriods(cur.rows, p.granularity, A.accPeriod);
    // The paper totals describe the whole municipality: only for the officer's unfiltered view.
    const municipalScope = isOfficer(req) && !p.filtered;
    let baseline = null;
    if (municipalScope) {
        const b = await municipalBaseline(keys);
        if (b.some(x => x.figures)) baseline = A.toPeriods(b.map(x => ({ key: x.key, figures: x.figures, coverage: {}, complete: !!x.figures, future: false })), p.granularity, baselineAdder);
    }
    let comparison = null;
    if (p.compare) {
        const pk = A.monthRange(A.monthKey(+p.from.slice(0, 4) - 1, +p.from.slice(5, 7)), A.monthKey(+p.to.slice(0, 4) - 1, +p.to.slice(5, 7)));
        const prev = A.toPeriods((await accommodationMonths(places, pk, p.mode)).rows, p.granularity, A.accPeriod);
        let prevBase = null;
        if (municipalScope) {
            const b = await municipalBaseline(pk);
            prevBase = A.toPeriods(b.map(x => ({ key: x.key, figures: x.figures, coverage: {}, complete: !!x.figures, future: false })), p.granularity, baselineAdder);
        }
        comparison = ['arrivals', 'guestNights'].map(measure => ({ measure, periods: A.compare(periods, prev, x => x.figures[measure]).map((c, i) => {
            // Where the earlier period was kept only as the paper total, compare with it and say its scope is unconfirmed (G3).
            if (!c.comparable && prevBase && prevBase[i] && prevBase[i].complete && prevBase[i].figures && periods[i].complete && periods[i].figures)
                return { ...c, comparable: true, previous: prevBase[i].figures[measure], difference: periods[i].figures[measure] - prevBase[i].figures[measure], reason: null, previousSource: 'municipal_total', scopeUnconfirmed: true };
            return c;
        }) }));
    }
    return { places, keys, months: cur, periods, baseline, comparison, municipalScope };
}
async function attractionSeries(req, p) {
    const keys = A.monthRange(p.from, p.to);
    const years = [...new Set(keys.map(k => +k.slice(0, 4)))];
    const places = await attractionPlaces(req, p, p.compare ? years.concat(years.map(y => y - 1)) : years);
    const cur = await attractionMonths(places, keys, p.mode);
    const periods = A.toPeriods(cur.rows, p.granularity, A.attPeriod);
    let comparison = null;
    if (p.compare) {
        const pk = A.monthRange(A.monthKey(+p.from.slice(0, 4) - 1, +p.from.slice(5, 7)), A.monthKey(+p.to.slice(0, 4) - 1, +p.to.slice(5, 7)));
        const prev = A.toPeriods((await attractionMonths(places, pk, p.mode)).rows, p.granularity, A.attPeriod);
        comparison = [{ measure: 'visits', periods: A.compare(periods, prev, x => x.figures.visits) }];
    }
    return { places, keys, months: cur, periods, comparison };
}

/* ---- place breakdowns: by place, barangay, category, location ---------------- */
function breakdown(places, perPlace, keys, adder, valueKey, minGroup) {
    const byPlace = places.map(s => {
        const months = perPlace.get(s.id).map((x, i) => ({ key: keys[i], figures: x ? (x.figures || x.f) : null }));
        const withFig = months.filter(m => m.figures);
        return { place: shapePlace(s), value: withFig.length ? withFig.reduce((a, m) => a + m.figures[valueKey], 0) : null, monthsWithFigures: withFig.length };
    });
    const group = keyOf => {
        const g = new Map();
        for (const r of byPlace) for (const k of keyOf(r)) {
            if (!g.has(k)) g.set(k, { key: k, places: 0, placesWithFigures: 0, value: null });
            const x = g.get(k); x.places++; if (r.value != null) { x.placesWithFigures++; x.value = (x.value || 0) + r.value; }
        }
        return [...g.values()].map(x => (minGroup && x.placesWithFigures < minGroup ? { ...x, value: null, suppressed: true } : x)).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
    };
    return { byPlace, byBarangay: group(r => [r.place.barangay || '(no barangay)']), byCategory: group(r => r.place.categories),
             notes: ['A barangay is where the place is, not where visitors live.', 'A place with several categories counts under each, so category values overlap and are never added together.',
                     'A place with no figures in the period has value null (not reported), never 0.'] };
}

/* ---- Excel: the same figures, cell for cell ---------------------------------- */
function workbookFor(title, rows, headers, notes) {
    const { workbook, safeText } = require('./accommodation-excel');
    const wb = workbook(), ws = wb.addWorksheet('Periods');
    ws.addRow([safeText(title)]).font = { bold: true, size: 12 };
    ws.addRow([]);
    ws.addRow(headers).font = { bold: true };
    for (const r of rows) ws.addRow(r.map(v => (typeof v === 'string' ? safeText(v) : v)));
    ws.columns.forEach((c, i) => { c.width = i === 0 ? 18 : 16; });
    ws.addRow([]);
    for (const n of notes) ws.addRow([safeText(n)]).font = { italic: true, size: 9 };
    return wb;
}

module.exports = function analyticsRouter({ requireReporter: reporterChain, sharedRateLimit }) {
    const router = express.Router();
    // Reads are cheap but not free: a limit per account, counted across serverless instances.
    const readLimit = sharedRateLimit
        ? sharedRateLimit('analytics-read', { windowMs: 15 * 60 * 1000, limit: 300, keyGenerator: req => `${req.auth.role}:${req.auth.sub}`,
            message: { success: false, message: 'Too many statistics requests. Wait a few minutes.' } })
        : (req, res, next) => next();
    const requireReporter = [...reporterChain, readLimit];
    const handle = fn => async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try { await fn(req, res); } catch (error) {
            if (error instanceof Refusal) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
            console.error('❌ Analytics failure:', error.message);
            return res.status(500).json({ success: false, message: 'Something went wrong on our side. Try again in a moment.' });
        }
    };
    const meta = (p, extra) => ({ success: true, from: p.from, to: p.to, granularity: p.granularity, mode: p.mode, filters: { barangay: p.barangay || null, category: p.category || null, spotId: p.spotId || null, bbox: p.bbox || null }, ...extra });

    /* Accommodation: arrivals, guest nights, room-nights, the DAE rates, residence and sex, coverage. */
    router.get('/analytics/accommodation', requireReporter, handle(async (req, res) => {
        const p = params(req);
        const s = await accommodationSeries(req, p);
        res.json(meta(p, {
            domain: 'accommodation', measure: 'Guest arrivals at private places to stay (a guest counts once at each place). Not visits, not reservations, not unique tourists.',
            places: s.places.length, periods: s.periods.map(x => ({ key: x.key, label: x.label, figures: x.figures, rates: x.rates, coverage: x.coverage, complete: x.complete, future: x.future, municipalTotal: s.months.rows.filter(r => x.months.includes(r.key)).some(r => r.municipalTotal) })),
            total: A.accPeriod(s.months.rows.filter(r => !r.future)),
            peakLow: { arrivals: A.peakLow(s.periods, x => x.figures && x.figures.arrivals), guestNights: A.peakLow(s.periods, x => x.figures && x.figures.guestNights) },
            baseline: s.baseline ? { label: '2025 paper Form A4 municipal totals: their scope is not confirmed (G3). Never added to enterprise figures.', periods: s.baseline } : null,
            comparison: s.comparison
        }));
    }));
    router.get('/analytics/accommodation/places', requireReporter, handle(async (req, res) => {
        const p = params(req, ['from', 'to', 'mode', 'barangay', 'category', 'spotId', 'bbox']);
        const places = await accommodationPlaces(req, p);
        const keys = A.monthRange(p.from, p.to);
        const m = await accommodationMonths(places, keys, p.mode);
        const per = new Map([...m.perPlace].map(([id, list]) => [id, list.map(x => (x ? { figures: { arrivals: x.v.arrivals, guestNights: x.v.guest_nights } } : null))]));
        res.json(meta(p, { domain: 'accommodation', measure: 'arrivals', ...breakdown(places, per, keys, null, 'arrivals', isManager(req) ? MIN_GROUP : 0) }));
    }));
    /* The manager's own stay register: arrivals by day and weekday, length of stay. Live, so labeled operational. */
    router.get('/analytics/accommodation/stays', requireReporter, handle(async (req, res) => {
        if (!isManager(req)) refuse(403, 'NOT_ALLOWED', 'Stay-level patterns are for the enterprise\'s own manager.');
        const p = params(req, ['from', 'to', 'spotId'], { days: true });
        if (!p.spotId) refuse(400, 'BAD_PARAM', 'Give your enterprise (spotId).');
        const [place] = await accommodationPlaces(req, p);
        const start = place.reporting_from ? A.toDate(place.reporting_from) : null;
        const arr = (await query(`select g.starts_on, sum(g.male + g.female)::int as guests from accommodation_stay_guests g join accommodation_stays s on s.id = g.stay_id
                                   where s.spot_id = $1 and s.status = 'active' and g.starts_on between $2 and $3 group by g.starts_on`, [place.id, p.from, p.to])).rows;
        const nights = (await query(`select (check_out - check_in)::int as n from accommodation_stays where spot_id = $1 and status = 'active' and check_in between $2 and $3`, [place.id, p.from, p.to])).rows.map(r => r.n);
        const by = new Map(arr.map(r => [A.toDate(r.starts_on), r.guests])), days = [];
        for (let d = p.from; d <= p.to; d = A.addDays(d, 1)) days.push({ date: d, value: !start || d < start || d > A.manilaToday() ? null : (by.get(d) || 0) });
        res.json(meta(p, { domain: 'accommodation', source: 'stay register (live; it can change until the month is submitted)', place: shapePlace(place), reportingFrom: start,
            arrivals: { total: days.reduce((a, d) => a + (d.value || 0), 0), days, rolling7: A.rolling7(days), ...A.weekdayMeans(days), peakLow: A.peakLowDays(days) },
            lengthOfStay: { stays: nights.length, buckets: A.stayBuckets(nights), median: A.median(nights) } }));
    }));

    /* Attractions: visits, residence classes and sex where recorded, coverage. */
    router.get('/analytics/attractions', requireReporter, handle(async (req, res) => {
        const p = params(req);
        const s = await attractionSeries(req, p);
        res.json(meta(p, {
            domain: 'attractions', measure: 'Visits to office-run attractions that count visitors. Visits, not people; never added to accommodation arrivals.',
            places: s.places.length, periods: s.periods.map(x => ({ key: x.key, label: x.label, figures: x.figures, coverage: x.coverage, complete: x.complete, future: x.future })),
            total: A.attPeriod(s.months.rows.filter(r => !r.future)),
            peakLow: { visits: A.peakLow(s.periods, x => x.figures && x.figures.visits) },
            comparison: s.comparison,
            notCovered: isOfficer(req) ? (await query(`select count(*)::int as n from spots where type = 'spot' and status = 'published' and (managed_by is not null or not counts_visitors)`)).rows[0].n : undefined
        }));
    }));
    router.get('/analytics/attractions/places', requireReporter, handle(async (req, res) => {
        const p = params(req, ['from', 'to', 'mode', 'barangay', 'category', 'spotId', 'bbox']);
        const keys = A.monthRange(p.from, p.to);
        const places = await attractionPlaces(req, p, [...new Set(keys.map(k => +k.slice(0, 4)))]);
        const m = await attractionMonths(places, keys, p.mode);
        res.json(meta(p, { domain: 'attractions', measure: 'visits', ...breakdown(places, m.perPlace, keys, null, 'visits', 0) }));
    }));
    /* One attraction day by day: the Daily Visitor Record's counts (operational). */
    router.get('/analytics/attractions/daily', requireReporter, handle(async (req, res) => {
        const p = params(req, ['from', 'to', 'spotId'], { days: true });
        if (isStaff(req)) p.spotId = p.spotId || String(req.account.spot_id);
        if (!p.spotId) refuse(400, 'BAD_PARAM', 'Give the attraction (spotId).');
        const [place] = await attractionPlaces(req, p, [+p.from.slice(0, 4), +p.to.slice(0, 4)]);
        const keys = A.monthRange(p.from.slice(0, 7), p.to.slice(0, 7));
        const ctx = await ATT.loadCtx(place, A.firstDay(...A.parseKey(keys[0])), A.lastDay(...A.parseKey(keys[keys.length - 1])));
        const days = [];
        for (const k of keys) for (const d of AE.monthFigures(ctx, ...A.parseKey(k)).daily) {
            if (d.date < p.from || d.date > p.to) continue;
            const c = d.count;
            days.push({ date: d.date, state: d.state, value: c ? c.total : null, residence: c && c.total > 0 && Object.values(c.residence).some(v => v != null) ? c.residence : null,
                        male: c && c.total > 0 ? c.male : null, female: c && c.total > 0 ? c.female : null });
        }
        const tally = s => days.filter(d => d.state === s).length;
        res.json(meta(p, { domain: 'attractions', source: 'Daily Visitor Record (operational: counts as recorded, before or after submission)', place: shapePlace(place),
            days, rolling7: A.rolling7(days), ...A.weekdayMeans(days), peakLow: A.peakLowDays(days),
            summary: { visits: days.reduce((a, d) => a + (d.value || 0), 0), recordedDays: days.filter(d => d.value != null).length, confirmedZero: tally('zero'),
                       missing: tally('missing') + tally('scheduled'), closed: tally('closed'), notYet: tally('future') + tally('today'), beforeReporting: tally('before') } }));
    }));

    /* Room requests made through ZTIMS: never arrivals, never money. */
    router.get('/analytics/reservations', requireReporter, handle(async (req, res) => {
        const p = params(req, ['from', 'to', 'spotId', 'barangay', 'category', 'bbox']);
        const places = await accommodationPlaces(req, p);
        const ids = places.map(s => s.id);
        const lo = A.firstDay(...A.parseKey(p.from)), hiEx = A.addDays(A.lastDay(...A.parseKey(p.to)), 1);
        const reqs = ids.length ? (await query(
            `select b.id, b.status, b.country_code, b.check_in, b.nights,
                    to_char(b.requested_at at time zone 'Asia/Manila', 'YYYY-MM') as req_month,
                    (b.check_in - (b.requested_at at time zone 'Asia/Manila')::date)::int as lead_days,
                    case when b.decided_at is not null then extract(epoch from (b.decided_at - b.requested_at)) / 3600 end as answer_hours,
                    coalesce((select sum(r.units) from booking_rooms r where r.booking_id = b.id), 0)::int as rooms
               from bookings b where b.spot_id = any($1) and (b.requested_at at time zone 'Asia/Manila')::date >= $2 and (b.requested_at at time zone 'Asia/Manila')::date < $3`,
            [ids, lo, hiEx])).rows : [];
        const kept = ['confirmed', 'checked_in', 'completed', 'no_show'];
        const keys = A.monthRange(p.from, p.to);
        res.json(meta(p, { domain: 'reservations', measure: 'Room requests made through ZTIMS, by the month they were made. A request is not an arrival; reservations made outside ZTIMS are not here.',
            places: places.length,
            months: keys.map(k => { const rs = reqs.filter(r => r.req_month === k); const by = {}; rs.forEach(r => { by[r.status] = (by[r.status] || 0) + 1; }); return { key: k, requests: rs.length, byStatus: by }; }),
            total: { requests: reqs.length, byStatus: reqs.reduce((o, r) => ({ ...o, [r.status]: (o[r.status] || 0) + 1 }), {}),
                     roomNightsReserved: reqs.filter(r => kept.includes(r.status)).reduce((a, r) => a + r.rooms * r.nights, 0) },
            leadTimeDays: { median: A.median(reqs.filter(r => kept.includes(r.status)).map(r => r.lead_days)), requests: reqs.filter(r => kept.includes(r.status)).length },
            answerTimeHours: { median: A.median(reqs.filter(r => r.answer_hours != null).map(r => Number(r.answer_hours))), requests: reqs.filter(r => r.answer_hours != null).length },
            byCountry: Object.entries(reqs.reduce((o, r) => ({ ...o, [r.country_code || 'unknown']: (o[r.country_code || 'unknown'] || 0) + 1 }), {})).map(([code, requests]) => ({ code, requests })).sort((a, b) => b.requests - a.requests),
            note: 'Room-nights reserved count confirmed, checked-in, completed and no-show requests (units × nights). Prices are left out (no revenue in statistics).' }));
    }));

    /* What keeps the picture incomplete: the officer's to-do list. */
    router.get('/analytics/coverage', requireReporter, handle(async (req, res) => {
        if (!isOfficer(req)) refuse(403, 'NOT_ALLOWED', 'Reporting coverage is for the Tourism Office.');
        if (Object.keys(req.query || {}).length) refuse(400, 'BAD_PARAM', 'No filters here.');
        const one = async sql => (await query(sql)).rows[0].n;
        res.json({ success: true, gaps: [
            { id: 'attractions_not_counted', count: await one(`select count(*)::int as n from spots where type = 'spot' and status = 'published' and managed_by is null and not counts_visitors`), label: 'Office-run attractions that do not count visitors' },
            { id: 'counting_without_staff', count: await one(`select count(*)::int as n from spots s where type = 'spot' and status = 'published' and managed_by is null and counts_visitors and not exists (select 1 from support_staff t where t.spot_id = s.id and t.status = 'active')`), label: 'Counting attractions with no active Support Staff' },
            { id: 'private_attractions', count: await one(`select count(*)::int as n from spots where type = 'spot' and status = 'published' and managed_by is not null`), label: 'Manager-run attractions (no way to report visitors yet, G2)' },
            { id: 'stays_without_profile', count: await one(`select count(*)::int as n from spots s where type = 'accommodation' and managed_by is not null and status <> 'archived' and not exists (select 1 from accommodation_profiles p where p.spot_id = s.id and p.reporting_from is not null)`), label: 'Private places to stay with no reporting start' },
            { id: 'stays_without_rooms', count: await one(`select count(*)::int as n from spots s where type = 'accommodation' and managed_by is not null and status <> 'archived' and not exists (select 1 from accommodation_rooms r where r.spot_id = s.id)`), label: 'Private places to stay with no rooms set up (no occupancy)' }
        ] });
    }));

    /* Excel of a series: the very periods the JSON returns. */
    router.get('/analytics/:domain/export.xlsx', requireReporter, handle(async (req, res) => {
        const domain = req.params.domain;
        if (!['accommodation', 'attractions'].includes(domain)) refuse(404, 'NOT_FOUND', 'No such export.');
        const p = params(req);
        const fmt = v => (v == null ? null : v);
        let rows, headers, notes, title;
        if (domain === 'accommodation') {
            const s = await accommodationSeries(req, p);
            title = `Accommodation arrivals, ${p.from} to ${p.to} (${p.mode})`;
            headers = ['Period', 'Arrivals', 'Guest nights', 'Room-nights occupied', 'Room-nights available', 'Occupancy rate', 'Average length of stay', 'Places expected', 'Finalized', 'Submitted, not finalized', 'Missing', 'Not operating', 'Complete'];
            rows = s.periods.map(x => [x.label, fmt(x.figures && x.figures.arrivals), fmt(x.figures && x.figures.guestNights), fmt(x.figures && x.figures.roomNightsOccupied), fmt(x.figures && x.figures.roomNightsAvailable),
                fmt(x.rates && x.rates.occupancyRate), fmt(x.rates && x.rates.averageLengthOfStay), fmt(x.coverage.expected), fmt(x.coverage.finalized), fmt(x.coverage.submitted), fmt(x.coverage.missing), fmt(x.coverage.notOperating),
                x.future ? 'Not yet' : x.complete ? 'Complete' : x.figures ? 'Partial' : 'Not reported']);
            notes = ['Arrivals at private places to stay; a guest counts once at each place. Empty cells are not reported, never 0.', 'Rates are worked out from the summed counts (the DAE definitions).', 'The 2025 paper totals are not in this sheet: their scope is not confirmed.'];
        } else {
            const s = await attractionSeries(req, p);
            title = `Attraction visits, ${p.from} to ${p.to} (${p.mode})`;
            headers = ['Period', 'Visits', 'Zamboanguita', 'Rest of Negros Oriental', 'Other Philippine provinces', 'Foreign', 'Residence not recorded', 'Male', 'Female', 'Sex not recorded', 'Attractions expected', 'Finalized', 'Submitted', 'Draft', 'Not submitted', 'Complete'];
            rows = s.periods.map(x => { const f = x.figures, r = f && f.residence;
                return [x.label, fmt(f && f.visits), fmt(r && r.zamboanguita), fmt(r && r.negrosOriental), fmt(r && r.otherProvince), fmt(r && r.foreign), fmt(f && f.residenceUnrecorded),
                    fmt(f && f.sex && f.sex.male), fmt(f && f.sex && f.sex.female), fmt(f && f.sexUnrecorded), fmt(x.coverage.expected), fmt(x.coverage.finalized), fmt(x.coverage.submitted), fmt(x.coverage.draft),
                    fmt((x.coverage.notSubmitted || 0) + (x.coverage.noStaff || 0)), x.future ? 'Not yet' : x.complete ? 'Complete' : f ? 'Partial' : 'Not reported']; });
            notes = ['Visits to office-run attractions, not people; never added to accommodation arrivals.', 'Empty residence or sex: not recorded, never 0. Sex by residence is not recorded.'];
        }
        const wb = workbookFor(title, rows, headers, notes);
        const buffer = Buffer.from(await wb.xlsx.writeBuffer());
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${`analytics_${domain}_${p.from}_${p.to}_${p.mode}.xlsx`.replace(/[^A-Za-z0-9_.-]/g, '_')}"`);
        res.send(buffer);
    }));

    return router;
};
module.exports.params = params;
