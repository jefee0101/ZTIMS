/* Attraction visitor reporting: the Daily Visitor Record of an office-run
 * attraction, its generated Monthly Report, Submit, the officer's Finalize and
 * Reopen, and the municipal DTA2M (monthly), VAR 3M (annual) and VAR 2.
 * Mounted at /api by server.js, which hands over its own sign-in checks.
 *
 * Who: the Support Staff account assigned to the attraction records and
 * submits, for that attraction only. The Tourism Officer reads every
 * attraction, finalizes and reopens (with a reason) and never records. Enterprise
 * managers and visitors have no route here.
 *
 * One source: attraction_daily_counts. Every figure is worked out from it by
 * attraction-engine.js, for the screens, the previews and the Excel files alike.
 * db/schema.sql ("Attraction visitor reporting") holds the rules underneath, so a
 * script that skips this file still cannot change a submitted or finalized
 * month, edit a saved version or remove a count.
 */
const express = require('express');
const { query, transaction } = require('./db');
const E = require('./attraction-engine');
const { isOpenOn } = require('./open-days');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ID = /^[0-9a-f]{24}$/i;
const CATEGORY_LABELS = { BEACH: 'Beach & Sea', DIVING: 'Diving & Snorkeling', NATURE: 'Nature', ADVENTURE: 'Adventure', CULTURE: 'Culture & Heritage', FAITH: 'Faith', LEISURE: 'Leisure & Recreation' };

const isOfficer = req => req.auth && req.auth.role === 'admin';
const isStaff = req => req.auth && req.auth.role === 'support_staff';
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
    if (error.code === '23505') return new Refusal(409, 'STALE', 'Someone saved this at the same moment. Reload it and check the figures.');
    if (error.code !== 'P0001') return null;
    const [token, ...rest] = String(error.message).split(' ');
    const arg = rest.join(' ');
    const map = {
        PERIOD_LOCKED: [409, `${arg.length === 7 ? monthName(arg) : 'That month'} is submitted or finalized, so its daily counts are locked. The Tourism Office must reopen it.`, { month: arg }],
        FUTURE_DATE: [400, 'A date that has not happened yet cannot be recorded.'],
        BEFORE_REPORTING: [409, 'That date is before this attraction started reporting.'],
        CLOSED_DATE: [409, 'That date is an authorized closure, so it takes no count. Ask the Tourism Office if the closure is wrong.'],
        MONTH_NOT_ENDED: [409, 'That month has not ended yet.'],
        MONTH_INCOMPLETE: [409, 'Every date of the month must be recorded or an authorized closure before it can be submitted.'],
        VERSION_GAP: [409, 'Reload and try again: the version numbers moved.'],
        VERSION_DRIFT: [409, 'The saved figures did not match the daily counts. Nothing was submitted. Reload and try again.'],
        BAD_TRANSITION: [409, 'That is not allowed for the month as it stands.'],
        NOT_ATTRACTION: [404, 'No office-run attraction with that id.'],
        IMMUTABLE: [409, 'Saved versions and their history never change.'],
        IMMUTABLE_DELETE: [409, 'Records are never removed. Correct a count with a new value instead.'],
        REVISION: [409, 'Reload and try again: the record moved.'],
        KEY_FIXED: [409, 'A record cannot move to another attraction or date.'],
        LEGACY_ATTRACTION_FROZEN: [409, 'Earlier attraction reports are read only. Use the Daily Visitor Record.'],
        LEGACY_REGISTER_FROZEN: [409, 'The Guest Register of an attraction is retired. Use the Daily Visitor Record.']
    };
    const hit = map[token];
    return hit ? new Refusal(hit[0], token, hit[1], hit[2]) : null;
}

/* ---- month sources, shared with analytics.js ------------------------------
   The same functions feed DTA2M, VAR 3M and the analytics, so they can never
   disagree on which version or draft a month uses. Read-only. */
async function settingsOf(spotId, client) {
    return (await query('select * from attraction_settings where spot_id = $1', [spotId], client)).rows[0] || null;
}
async function loadCtx(spot, from, to, client, settings) {
    settings = settings === undefined ? await settingsOf(spot.id, client) : settings;
    const counts = (await query('select * from attraction_daily_counts where spot_id = $1 and count_date between $2 and $3', [spot.id, from, to], client)).rows.map(E.rowOf);
    const closed = (await query('select closed_date, reason from spot_closed_dates where spot_id = $1 and closed_date between $2 and $3', [spot.id, from, to], client)).rows;
    return { counts: new Map(counts.map(r => [r.date, r])), closed: new Map(closed.map(c => [E.toDate(c.closed_date), c.reason])),
        reportingFrom: settings ? E.toDate(settings.reporting_from) : null, today: E.manilaToday(), scheduledClosed: d => !isOpenOn(spot.working_days, d), rows: counts };
}
const VERSION_COLS = `id, spot_id, year, month, version, dates_counted, zero_days, closed_days, total, res_zamboanguita, res_negros_oriental, res_other_province,
                      res_foreign, res_unrecorded, male, female, sex_unrecorded, source_digest, reason, submitted_by_role, submitted_by_email, submitted_at`;
const hasStaff = async (spotId, client) => (await query(`select 1 from support_staff where spot_id = $1 and status = 'active'`, [spotId], client)).rows.length > 0;
/* Every month of a year for one attraction, as a source for the consolidations. */
async function yearSources(spot, year, mode, client, staffOn) {
    const settings = await settingsOf(spot.id, client);
    const ctx = await loadCtx(spot, E.firstDay(year, 1), E.lastDay(year, 12), client, settings);
    const versions = (await query(`select ${VERSION_COLS} from attraction_report_versions where spot_id = $1 and year = $2 order by month, version`, [spot.id, year], client)).rows;
    const periods = (await query('select * from attraction_periods where spot_id = $1 and year = $2', [spot.id, year], client)).rows;
    const staff = staffOn === undefined ? await hasStaff(spot.id, client) : staffOn;
    const out = [];
    for (let month = 1; month <= 12; month++) {
        const vs = versions.filter(v => v.month === month), p = periods.find(x => x.month === month);
        const byId = new Map(vs.map(v => [v.id, v]));
        const period = p ? { state: p.state, currentVersion: byId.get(p.current_version_id).version, finalizedVersion: p.finalized_version_id ? byId.get(p.finalized_version_id).version : null } : null;
        const live = E.monthFigures(ctx, year, month);
        const st = E.periodState({ year, month, today: ctx.today, reportingFrom: ctx.reportingFrom, period, figures: live, hasStaff: staff });
        const fv = p && p.finalized_version_id ? byId.get(p.finalized_version_id) : null, lv = vs.length ? vs[vs.length - 1] : null;
        const src = E.sourceFor(mode, { state: st.state, finalized: fv ? { version: fv.version, figures: E.figuresFromVersion(fv), id: fv.id } : null,
            latest: lv ? { version: lv.version, figures: E.figuresFromVersion(lv), id: lv.id } : null, draft: mode === 'operational' ? live : null });
        if (fv && src.kind === 'final') src.versionId = fv.id;
        out.push({ month, state: st, source: src, missing: live.missing.length + live.scheduled.length });
    }
    return { settings, months: out };
}
async function officeAttractions(year, client) {
    return (await query(
        `select s.id, s.title, s.type, s.status, s.managed_by, s.counts_visitors, s.working_days, s.barangay, s.category
           from spots s
          where s.type = 'spot' and s.managed_by is null
            and ((s.counts_visitors and s.status <> 'archived')
                 or exists (select 1 from attraction_report_versions v where v.spot_id = s.id and v.year = $1))
          order by s.title limit 200`, [year], client)).rows;
}


module.exports = function attractionVisitsRouter({ requireAdmin, requireReporter, requireSupportStaff, sharedRateLimit }) {
    const router = express.Router();
    const writeLimit = sharedRateLimit
        ? sharedRateLimit('attraction-visits-write', { windowMs: 60 * 60 * 1000, limit: 600, keyGenerator: req => `${req.auth.role}:${req.auth.sub}`,
            message: { success: false, message: 'Too many changes in a short time. Wait a few minutes.' } })
        : (req, res, next) => next();
    // Officer or Support Staff only: an enterprise manager's token passes requireReporter, not this.
    const staffOrOfficer = (req, res, next) => (isOfficer(req) || isStaff(req) ? next()
        : res.status(403).json({ success: false, message: 'Attraction visit reports are for the Support Staff of the attraction and the Tourism Office.' }));
    const READ = [requireReporter, staffOrOfficer];

    const handle = fn => async (req, res) => {
        try { await fn(req, res); } catch (error) {
            const r = fromDatabase(error);
            if (r) return res.status(r.status).json({ success: false, code: r.code, message: r.message, ...r.extra });
            console.error('❌ Attraction visits failure:', error);
            return res.status(500).json({ success: false, message: 'Something went wrong on our side. Try again in a moment.' });
        }
    };

    /* ---- places and access ---------------------------------------------- */
    async function placeFor(req, spotId, { write = false } = {}, client) {
        if (!ID.test(String(spotId || ''))) refuse(404, 'NOT_FOUND', 'Attraction not found.');
        const { rows } = await query(
            `select id, title, type, status, managed_by, counts_visitors, working_days, barangay, category from spots where id = $1`, [spotId], client);
        const spot = rows[0];
        if (!spot || spot.type !== 'spot' || spot.managed_by !== null) refuse(404, 'NOT_FOUND', 'No office-run attraction with that id.');
        if (isStaff(req)) {
            // The attraction in the URL is compared with the account's own assignment. Nothing the page sends is trusted.
            if (!req.account || String(req.account.spot_id) !== String(spot.id)) refuse(403, 'NOT_YOURS', 'This is not the attraction you look after.');
        } else if (!isOfficer(req)) refuse(403, 'NOT_YOURS', 'This is not yours.');
        if (write) {
            if (!isStaff(req)) refuse(403, 'OFFICER_DOES_NOT_RECORD', 'The Tourism Officer views, finalizes and reopens. Counts are recorded by the attraction\'s Support Staff.');
            if (!spot.counts_visitors) refuse(409, 'NOT_COUNTED', 'Visitors are not counted at this attraction.');
        }
        return spot;
    }
    const lock = (spotId, client) => query(`select pg_advisory_xact_lock(hashtextextended('attraction:' || $1, 0))`, [spotId], client);
    const typeLabel = spot => CATEGORY_LABELS[spot.category] || '';
    const spotInfo = (spot, settings) => ({ _id: spot.id, name: spot.title, type: typeLabel(spot), barangay: spot.barangay, code: settings ? settings.attraction_code : '' });

    function periodParams(req) {
        const year = Number(req.params.year != null ? req.params.year : req.query.year), month = Number(req.params.month != null ? req.params.month : req.query.month);
        if (!Number.isInteger(year) || year < 2000 || year > 2100) refuse(400, 'BAD_PERIOD', 'Give a year from 2000 to 2100.');
        if (!Number.isInteger(month) || month < 1 || month > 12) refuse(400, 'BAD_PERIOD', 'Give a month, 1 to 12.');
        return { year, month };
    }
    function yearParam(req) {
        const year = Number(req.query.year);
        if (!Number.isInteger(year) || year < 2000 || year > 2100) refuse(400, 'BAD_PERIOD', 'Give a year from 2000 to 2100.');
        return year;
    }
    const modeParam = req => { const m = String(req.query.mode || 'official'); if (!['official', 'operational'].includes(m)) refuse(400, 'BAD_MODE', 'mode is official or operational.'); return m; };
    const strictBody = (b, allowed) => {
        const body = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
        for (const k of Object.keys(body)) if (!allowed.includes(k)) refuse(400, 'BAD_FIELD', `"${k}" cannot be set here.`);
        return body;
    };

    /* ---- loading ---------------------------------------------------------- */
    const shapeVersion = (v, figures) => ({ _id: v.id, version: v.version, reason: v.reason, submittedAt: v.submitted_at, submittedByRole: v.submitted_by_role, submittedByEmail: v.submitted_by_email, figures });

    /* One attraction's month: live figures, state, versions, history. */
    async function monthView(spot, year, month, client) {
        const ctx = await loadCtx(spot, E.firstDay(year, month), E.lastDay(year, month), client);
        const figures = E.monthFigures(ctx, year, month);
        const versions = (await query('select * from attraction_report_versions where spot_id = $1 and year = $2 and month = $3 order by version', [spot.id, year, month], client)).rows;
        const events = (await query(`select action, version_id, reason, actor_role, actor_email, at from attraction_period_events where spot_id = $1 and year = $2 and month = $3 order by at, id`, [spot.id, year, month], client)).rows;
        const p = (await query('select * from attraction_periods where spot_id = $1 and year = $2 and month = $3', [spot.id, year, month], client)).rows[0] || null;
        const byId = new Map(versions.map(v => [v.id, v]));
        const period = p ? { state: p.state, currentVersion: byId.get(p.current_version_id).version, finalizedVersion: p.finalized_version_id ? byId.get(p.finalized_version_id).version : null } : null;
        const state = E.periodState({ year, month, today: ctx.today, reportingFrom: ctx.reportingFrom, period, figures, hasStaff: await hasStaff(spot.id, client) });
        const shaped = versions.map((v, i) => {
            const f = E.figuresFromVersion(v);
            return { ...shapeVersion(v, summary(f)), changes: i ? E.diffDaily(versions[i - 1].daily, v.daily) : [] };
        });
        const idv = new Map(versions.map(v => [v.id, v.version]));
        return { spot, settings: await settingsOf(spot.id, client), figures, state, period, versions: shaped, versionRows: versions,
            events: events.map(e => ({ action: e.action, version: idv.get(e.version_id), reason: e.reason, actorRole: e.actor_role, actorEmail: e.actor_email, at: e.at })), today: ctx.today, ctx };
    }
    const summary = f => ({ total: f.total, dates: f.dates, zeroDays: f.zero, closedDays: f.closed, residence: f.residence, residenceUnrecorded: f.residenceUnrecorded,
        male: f.male, female: f.female, sexUnrecorded: f.sexUnrecorded, domestic: f.domestic, foreign: f.foreignKnown });
    const shapeMonth = v => ({ success: true, today: v.today, attraction: spotInfo(v.spot, v.settings), reportingFrom: v.settings ? E.toDate(v.settings.reporting_from) : null,
        state: v.state, figures: v.figures, versions: v.versions, events: v.events,
        officialFigures: v.state.finalizedVersion ? summary(E.figuresFromVersion(v.versionRows.find(x => x.version === v.state.finalizedVersion))) : null });

    /* ---- who am I / settings ---------------------------------------------- */
    router.get('/attraction-visits/me', requireSupportStaff, handle(async (req, res) => {
        const spot = await placeFor(req, String(req.account.spot_id));
        const settings = await settingsOf(spot.id);
        res.json({ success: true, today: E.manilaToday(), attraction: spotInfo(spot, settings), countsVisitors: !!spot.counts_visitors, reportingFrom: settings ? E.toDate(settings.reporting_from) : null });
    }));

    router.put('/attraction-visits/:spotId/settings', requireAdmin, writeLimit, handle(async (req, res) => {
        const b = strictBody(req.body, ['reportingFrom', 'attractionCode']);
        let from = b.reportingFrom == null ? null : String(b.reportingFrom);
        if (from !== null) {
            if (/^\d{4}-\d{2}$/.test(from)) from += '-01';
            if (!E.isDate(from) || from.slice(8) !== '01') refuse(400, 'BAD_START', 'Reporting starts on a month, like 2026-08.');
        }
        const code = b.attractionCode == null ? null : text(b.attractionCode, 20);
        await transaction(async client => {
            const spot = await placeFor(req, req.params.spotId, {}, client);
            await lock(spot.id, client);
            const cur = await settingsOf(spot.id, client);
            const start = from || (cur ? E.toDate(cur.reporting_from) : null);
            if (!start) refuse(400, 'BAD_START', 'Give the month reporting starts.');
            const earlier = (await query('select 1 from attraction_daily_counts where spot_id = $1 and count_date < $2 limit 1', [spot.id, start], client)).rows[0];
            if (earlier) refuse(409, 'COUNTS_BEFORE', 'Counts already exist before that month, so reporting cannot start after them.');
            await query(`insert into attraction_settings (spot_id, reporting_from, attraction_code) values ($1, $2, $3)
                         on conflict (spot_id) do update set reporting_from = excluded.reporting_from, attraction_code = coalesce($4, attraction_settings.attraction_code)`,
                [spot.id, start, code || '', code], client);
            res.json({ success: true, reportingFrom: start, attractionCode: code !== null ? code : (cur ? cur.attraction_code : '') });
        });
    }));

    /* ---- the Daily Visitor Record ----------------------------------------- */
    router.get('/attraction-visits/:spotId/months/:year/:month', READ, handle(async (req, res) => {
        const spot = await placeFor(req, req.params.spotId);
        const { year, month } = periodParams(req);
        res.json(shapeMonth(await monthView(spot, year, month)));
    }));

    async function logCount(client, spotId, date, action, before, after, actor) {
        await query(`insert into attraction_count_changes (spot_id, count_date, action, before, after, actor_role, actor_email) values ($1, $2, $3, $4, $5, $6, $7)`,
            [spotId, date, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, actor.role, actor.email], client);
    }
    const shapeCount = r => ({ date: E.toDate(r.count_date), ...(({ total, res, residenceComplete, male, female, sexComplete, revision }) => ({ total, residence: res, residenceComplete, male, female, sexComplete, revision }))(E.rowOf(r)) });
    async function assertDateOpen(spot, date, client) {
        if (date > E.manilaToday()) refuse(400, 'FUTURE_DATE', 'A date that has not happened yet cannot be recorded.');
        const closed = (await query('select reason from spot_closed_dates where spot_id = $1 and closed_date = $2', [spot.id, date], client)).rows[0];
        if (closed) refuse(409, 'CLOSED_DATE', `That date is an authorized closure${closed.reason ? ' (' + closed.reason + ')' : ''}, so it takes no count.`);
        const p = (await query('select state from attraction_periods where spot_id = $1 and year = $2 and month = $3', [spot.id, +date.slice(0, 4), +date.slice(5, 7)], client)).rows[0];
        if (p && p.state !== 'reopened') refuse(409, 'PERIOD_LOCKED', `${monthName(date.slice(0, 7))} is ${p.state}, so its daily counts are locked. The Tourism Office must reopen it.`, { month: date.slice(0, 7), state: p.state });
    }
    async function ensureSettings(spot, date, client) {
        let s = await settingsOf(spot.id, client);
        if (!s) {
            await query('insert into attraction_settings (spot_id, reporting_from) values ($1, $2) on conflict (spot_id) do nothing', [spot.id, E.firstDay(+date.slice(0, 4), +date.slice(5, 7))], client);
            s = await settingsOf(spot.id, client);
        }
        if (date < E.toDate(s.reporting_from)) refuse(409, 'BEFORE_REPORTING', 'That date is before this attraction started reporting.');
        return s;
    }

    router.put('/attraction-visits/:spotId/days/:date', requireSupportStaff, writeLimit, handle(async (req, res) => {
        const date = String(req.params.date);
        if (!E.isDate(date) || date < '2000-01-01' || date > '2100-12-31') refuse(400, 'BAD_DATE', 'Give a real calendar date.');
        const parsed = E.parseCount(req.body);
        if (parsed.errors) refuse(400, 'BAD_COUNT', parsed.errors[0], { errors: parsed.errors });
        const v = parsed.value, actor = who(req);
        await transaction(async client => {
            const spot = await placeFor(req, req.params.spotId, { write: true }, client);
            await lock(spot.id, client);
            await assertDateOpen(spot, date, client);
            await ensureSettings(spot, date, client);
            const cur = (await query('select * from attraction_daily_counts where spot_id = $1 and count_date = $2 for update', [spot.id, date], client)).rows[0];
            const cols = [v.total, v.res.zamboanguita, v.res.negrosOriental, v.res.otherProvince, v.res.foreign, v.residenceComplete, v.male, v.female, v.sexComplete];
            if (cur) {
                // The same request again (a retry after a lost answer): the first result, nothing added.
                if (cur.last_request_key === v.requestKey) return res.json({ success: true, replayed: true, count: shapeCount(cur) });
                if (v.revision !== cur.revision) refuse(409, 'STALE', 'This date was changed by someone else. Reload it and check the figures.', { server: shapeCount(cur) });
                const { rows } = await query(
                    `update attraction_daily_counts set total = $3, res_zamboanguita = $4, res_negros_oriental = $5, res_other_province = $6, res_foreign = $7, residence_complete = $8,
                            male = $9, female = $10, sex_complete = $11, revision = revision + 1, last_request_key = $12, updated_by_email = $13, updated_by_role = $14
                      where id = $1 and revision = $2 returning *`, [cur.id, cur.revision, ...cols, v.requestKey, actor.email, actor.role], client);
                if (!rows[0]) refuse(409, 'STALE', 'This date was changed by someone else. Reload it and check the figures.');
                await logCount(client, spot.id, date, 'updated', shapeCount(cur), shapeCount(rows[0]), actor);
                return res.json({ success: true, replayed: false, count: shapeCount(rows[0]) });
            }
            if (v.revision !== 0) refuse(409, 'STALE', 'This date has no saved record to change. Reload it.');
            const { rows } = await query(
                `insert into attraction_daily_counts (spot_id, count_date, total, res_zamboanguita, res_negros_oriental, res_other_province, res_foreign, residence_complete, male, female, sex_complete,
                        last_request_key, created_by_email, updated_by_email, updated_by_role)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14) returning *`, [spot.id, date, ...cols, v.requestKey, actor.email, actor.role], client);
            await logCount(client, spot.id, date, 'created', null, shapeCount(rows[0]), actor);
            res.status(201).json({ success: true, replayed: false, count: shapeCount(rows[0]) });
        });
    }));

    /* Several dates with no visitors at once (closed weekdays): each one a deliberate, confirmed zero. */
    router.post('/attraction-visits/:spotId/days/confirm-zero', requireSupportStaff, writeLimit, handle(async (req, res) => {
        const b = strictBody(req.body, ['dates', 'requestKey']);
        const dates = Array.isArray(b.dates) ? [...new Set(b.dates.map(String))].sort() : [];
        if (!dates.length || dates.length > 31) refuse(400, 'BAD_DATES', 'Give 1 to 31 dates.');
        if (!dates.every(d => E.isDate(d) && d >= '2000-01-01' && d <= '2100-12-31')) refuse(400, 'BAD_DATE', 'Every date must be a real calendar date.');
        const key = typeof b.requestKey === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(b.requestKey) ? b.requestKey : refuse(400, 'BAD_COUNT', 'A request key is required (it makes a retried save safe).');
        const actor = who(req);
        await transaction(async client => {
            const spot = await placeFor(req, req.params.spotId, { write: true }, client);
            await lock(spot.id, client);
            const made = [];
            for (const d of dates) {
                await assertDateOpen(spot, d, client);
                await ensureSettings(spot, d, client);
                const cur = (await query('select * from attraction_daily_counts where spot_id = $1 and count_date = $2', [spot.id, d], client)).rows[0];
                if (cur) { if (cur.last_request_key === key) continue; refuse(409, 'ALREADY_RECORDED', `${d} already has a count. Change it from its own record.`, { date: d }); }
                const { rows } = await query(
                    `insert into attraction_daily_counts (spot_id, count_date, total, last_request_key, created_by_email, updated_by_email, updated_by_role) values ($1, $2, 0, $3, $4, $4, $5) returning *`,
                    [spot.id, d, key, actor.email, actor.role], client);
                await logCount(client, spot.id, d, 'created', null, shapeCount(rows[0]), actor);
                made.push(d);
            }
            res.status(made.length ? 201 : 200).json({ success: true, confirmed: made, replayed: made.length === 0 });
        });
    }));

    /* ---- Submit, Finalize, Reopen ----------------------------------------- */
    router.post('/attraction-visits/:spotId/months/:year/:month/submit', requireSupportStaff, writeLimit, handle(async (req, res) => {
        const { year, month } = periodParams(req);
        const b = strictBody(req.body, ['expectedVersion', 'reason']);
        const actor = who(req);
        await transaction(async client => {
            const spot = await placeFor(req, req.params.spotId, { write: true }, client);
            await lock(spot.id, client);
            const v = await monthView(spot, year, month, client), st = v.state, current = v.period ? v.period.currentVersion : 0;
            if (st.state === 'finalized') refuse(409, 'PERIOD_FINALIZED', `${monthName(E.monthKey(year, month))} is finalized. The Tourism Office must reopen it first.`);
            if (st.state === 'submitted') refuse(409, 'ALREADY_SUBMITTED', `Version ${current} is already submitted and waiting for the Tourism Office.`, { version: current });
            if (st.state === 'before') refuse(409, 'BEFORE_REPORTING', 'That month is before this attraction started reporting.');
            if (['future', 'open'].includes(st.state)) refuse(409, 'MONTH_NOT_ENDED', `${monthName(E.monthKey(year, month))} has not ended. It can be submitted from ${E.addDays(E.lastDay(year, month), 1)}.`);
            if (!v.figures.complete) refuse(409, 'MONTH_INCOMPLETE', 'Every date must be recorded or an authorized closure before the month can be submitted.', { missing: v.figures.missing, scheduled: v.figures.scheduled });
            if (Number(b.expectedVersion || 0) !== current) refuse(409, 'STALE', 'A version was submitted meanwhile. Reload and check the figures.', { latestVersion: current });
            const reason = text(b.reason, 300);
            if (current > 0 && reason.length < 3) refuse(400, 'BAD_REASON', 'Give the reason for the correction.');
            const cols = E.versionColumns(v.figures), digest = E.sourceDigest(v.ctx.rows.filter(r => r.date >= E.firstDay(year, month) && r.date <= E.lastDay(year, month)).sort((a, c) => (a.date < c.date ? -1 : 1)));
            const { rows } = await query(
                `insert into attraction_report_versions (spot_id, year, month, version, dates_counted, zero_days, closed_days, total, res_zamboanguita, res_negros_oriental, res_other_province,
                        res_foreign, res_unrecorded, male, female, sex_unrecorded, daily, source_digest, reason, submitted_by_role, submitted_by_email)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) returning id`,
                [spot.id, year, month, current + 1, cols.dates_counted, cols.zero_days, cols.closed_days, cols.total, cols.res_zamboanguita, cols.res_negros_oriental, cols.res_other_province,
                 cols.res_foreign, cols.res_unrecorded, cols.male, cols.female, cols.sex_unrecorded, JSON.stringify(v.figures.daily), digest, reason, actor.role, actor.email], client);
            await query(`insert into attraction_period_events (spot_id, year, month, action, version_id, reason, actor_role, actor_email) values ($1, $2, $3, 'submitted', $4, $5, $6, $7)`,
                [spot.id, year, month, rows[0].id, reason, actor.role, actor.email], client);
            if (v.period) await query(`update attraction_periods set state = 'submitted', current_version_id = $4 where spot_id = $1 and year = $2 and month = $3`, [spot.id, year, month, rows[0].id], client);
            else await query(`insert into attraction_periods (spot_id, year, month, state, current_version_id) values ($1, $2, $3, 'submitted', $4)`, [spot.id, year, month, rows[0].id], client);
            await query('set constraints all immediate', [], client);
            res.status(201).json(shapeMonth(await monthView(spot, year, month, client)));
        });
    }));

    router.post('/attraction-visits/:spotId/months/:year/:month/finalize', requireAdmin, writeLimit, handle(async (req, res) => {
        const { year, month } = periodParams(req);
        const b = strictBody(req.body, ['expectedVersion']);
        const actor = who(req);
        await transaction(async client => {
            const spot = await placeFor(req, req.params.spotId, {}, client);
            await lock(spot.id, client);
            const p = (await query('select p.*, v.version from attraction_periods p join attraction_report_versions v on v.id = p.current_version_id where p.spot_id = $1 and p.year = $2 and p.month = $3 for update of p', [spot.id, year, month], client)).rows[0];
            if (!p) refuse(409, 'NOTHING_SUBMITTED', 'The Support Staff has not submitted this month.');
            if (p.state === 'finalized') refuse(409, 'ALREADY_FINALIZED', 'Already finalized.');
            if (p.state === 'reopened') refuse(409, 'NO_CURRENT_VERSION', 'The month is reopened. The Support Staff must submit the correction first.');
            if (Number(b.expectedVersion) !== p.version) refuse(409, 'STALE', 'A newer version arrived. Reload and review it.', { latestVersion: p.version });
            await query(`update attraction_periods set state = 'finalized', finalized_version_id = current_version_id where spot_id = $1 and year = $2 and month = $3`, [spot.id, year, month], client);
            await query(`insert into attraction_period_events (spot_id, year, month, action, version_id, actor_role, actor_email) values ($1, $2, $3, 'finalized', $4, $5, $6)`,
                [spot.id, year, month, p.current_version_id, actor.role, actor.email], client);
            res.json(shapeMonth(await monthView(spot, year, month, client)));
        });
    }));

    router.post('/attraction-visits/:spotId/months/:year/:month/reopen', requireAdmin, writeLimit, handle(async (req, res) => {
        const { year, month } = periodParams(req);
        const b = strictBody(req.body, ['reason']);
        const reason = text(b.reason, 300);
        if (reason.length < 10) refuse(400, 'BAD_REASON', 'Give a reason of at least 10 characters. The Support Staff sees it.');
        const actor = who(req);
        await transaction(async client => {
            const spot = await placeFor(req, req.params.spotId, {}, client);
            await lock(spot.id, client);
            const p = (await query('select * from attraction_periods where spot_id = $1 and year = $2 and month = $3 for update', [spot.id, year, month], client)).rows[0];
            if (!p || p.state === 'reopened') refuse(409, 'NOT_LOCKED', 'This month is not submitted or finalized.');
            await query(`update attraction_periods set state = 'reopened' where spot_id = $1 and year = $2 and month = $3`, [spot.id, year, month], client);
            await query(`insert into attraction_period_events (spot_id, year, month, action, version_id, reason, actor_role, actor_email) values ($1, $2, $3, 'reopened', $4, $5, $6, $7)`,
                [spot.id, year, month, p.current_version_id, reason, actor.role, actor.email], client);
            // Issued outputs that used this month now need regenerating. They are kept, never edited.
            await query(`update attraction_outputs set status = 'needs_regeneration', status_changed_at = now()
                          where status = 'current' and composition @> $1::jsonb and year = $2 and (kind = 'VAR3M' or month = $3)`,
                [JSON.stringify([{ spotId: spot.id, year, month }]), year, month], client);
            res.json(shapeMonth(await monthView(spot, year, month, client)));
        });
    }));

    /* ---- the officer's tracker -------------------------------------------- */
    router.get('/attraction-visits/tracker', requireAdmin, handle(async (req, res) => {
        const year = yearParam(req);
        const rows = [];
        for (const spot of await officeAttractions(year)) {
            const ys = await yearSources(spot, year, 'operational');
            rows.push({ _id: spot.id, name: spot.title, barangay: spot.barangay, supportStaff: (await query(`select full_name from support_staff where spot_id = $1 and status = 'active' limit 1`, [spot.id])).rows[0] || null,
                months: ys.months.map(m => ({ month: m.month, state: m.state.state, version: m.state.version || 0, missing: m.missing })) });
        }
        res.json({ success: true, year, attractions: rows.map(r => ({ ...r, supportStaff: r.supportStaff ? r.supportStaff.full_name : '' })) });
    }));

    /* ---- consolidation: the same functions feed the screens and the Excel ---- */
    async function monthlyConsolidation(year, month, mode, client) {
        const rows = [];
        for (const spot of await officeAttractions(year, client)) {
            const ys = await yearSources(spot, year, mode, client);
            const m = ys.months[month - 1];
            if (m.state.state === 'before') continue;
            rows.push({ spot, code: ys.settings ? ys.settings.attraction_code : '', state: m.state.state, source: m.source, dta2m: E.dta2mRow(m.source) });
        }
        const count = k => rows.filter(r => r.source.kind === k).length;
        return { year, month, mode, rows, totals: E.sumRows(rows.map(r => r.dta2m)),
            coverage: { attractions: rows.length, finalized: count('final'), submitted: count('submitted') + count('reopened'), draft: count('draft'), notSubmitted: count('none') + count('nostaff') } };
    }
    async function annualConsolidation(year, mode, client) {
        const attractions = [];
        for (const spot of await officeAttractions(year, client)) {
            const ys = await yearSources(spot, year, mode, client);
            attractions.push({ spot, code: ys.settings ? ys.settings.attraction_code : '', months: ys.months.map(m => ({ month: m.month, state: m.state.state, source: m.source, cell: E.var3mCell(m.source) })) });
        }
        const zero = { domestic: null, foreign: null, total: 0, unrecorded: 0 };
        const totals = attractions.map(a => a.months.filter(m => m.cell.included).reduce((acc, m) => E.addCells(acc, m.cell), { ...zero }));
        const byMonth = Array.from({ length: 12 }, (_, i) => { const cells = attractions.map(a => a.months[i].cell).filter(c => c.included); return cells.length ? cells.reduce((acc, c) => E.addCells(acc, c), { ...zero }) : null; });
        const grand = totals.reduce((acc, t) => E.addCells(acc, t), { ...zero });
        const legacy = (await query(`select count(*)::int as n from monthly_reports where kind = 'municipal_total' and status = 'submitted' and year = $1`, [year], client)).rows[0].n;
        return { year, mode, attractions, totals, byMonth, grand,
            legacy: { municipalTotalMonths: legacy, note: legacy ? 'Municipal totals from the printed Form A4 are kept as loaded. They are not attraction visits and are not allocated to attractions.' : '' } };
    }
    const shapeSource = s => ({ kind: s.kind, version: s.version || null, pending: !!s.pending });
    const jsonMonthly = d => ({ success: true, year: d.year, month: d.month, mode: d.mode, coverage: d.coverage, totals: d.totals,
        note: 'Visits to attractions, added across attractions. They are not unique tourists and are never added to accommodation arrivals.',
        attractions: d.rows.map(r => ({ _id: r.spot.id, name: r.spot.title, code: r.code, state: r.state, source: shapeSource(r.source), row: r.dta2m })) });
    const jsonAnnual = d => ({ success: true, year: d.year, mode: d.mode, totals: d.totals, byMonth: d.byMonth, grand: d.grand, legacy: d.legacy,
        note: 'Domestic and Foreign are the residence that was recorded. Domestic + Foreign is below Total by the visits with no residence recorded (unrecorded).',
        attractions: d.attractions.map(a => ({ _id: a.spot.id, name: a.spot.title, code: a.code, months: a.months.map(m => ({ month: m.month, state: m.state, source: shapeSource(m.source), cell: m.cell })) })) });

    router.get('/attraction-visits/consolidated/monthly', requireAdmin, handle(async (req, res) => {
        const { year, month } = periodParams(req);
        res.json(jsonMonthly(await monthlyConsolidation(year, month, modeParam(req))));
    }));
    router.get('/attraction-visits/consolidated/annual', requireAdmin, handle(async (req, res) => {
        res.json(jsonAnnual(await annualConsolidation(yearParam(req), modeParam(req))));
    }));
    router.get('/attraction-visits/consolidated/attraction/:spotId', requireAdmin, handle(async (req, res) => {
        const year = yearParam(req), mode = modeParam(req);
        const spot = await placeFor(req, req.params.spotId);
        const ys = await yearSources(spot, year, mode);
        res.json({ success: true, year, mode, attraction: spotInfo(spot, ys.settings), months: ys.months.map(m => ({ month: m.month, state: m.state.state, source: shapeSource(m.source), row: E.dta2mRow(m.source) })) });
    }));

    /* ---- issued outputs: exactly which finalized versions an issue used ---- */
    router.post('/attraction-visits/outputs', requireAdmin, writeLimit, handle(async (req, res) => {
        const b = strictBody(req.body, ['kind', 'year', 'month']);
        const kind = String(b.kind || '');
        if (!['DTA2M', 'VAR3M'].includes(kind)) refuse(400, 'BAD_KIND', 'kind is DTA2M or VAR3M.');
        const year = Number(b.year), month = kind === 'DTA2M' ? Number(b.month) : null;
        if (!Number.isInteger(year) || year < 2000 || year > 2100) refuse(400, 'BAD_PERIOD', 'Give a year from 2000 to 2100.');
        if (kind === 'DTA2M' && (!Number.isInteger(month) || month < 1 || month > 12)) refuse(400, 'BAD_PERIOD', 'Give a month, 1 to 12.');
        const actor = who(req);
        await transaction(async client => {
            await query(`select pg_advisory_xact_lock(hashtextextended('attraction-outputs', 0))`, [], client);
            const composition = [];
            if (kind === 'DTA2M') for (const r of (await monthlyConsolidation(year, month, 'official', client)).rows) { if (r.source.kind === 'final') composition.push({ spotId: r.spot.id, year, month, versionId: r.source.versionId, version: r.source.version }); }
            else for (const a of (await annualConsolidation(year, 'official', client)).attractions) for (const m of a.months) { if (m.source.kind === 'final') composition.push({ spotId: a.spot.id, year, month: m.month, versionId: m.source.versionId, version: m.source.version }); }
            if (!composition.length) refuse(409, 'NOTHING_FINALIZED', 'No attraction has a finalized month in that period, so there is nothing to issue.');
            await query(`update attraction_outputs set status = 'superseded', status_changed_at = now() where kind = $1 and year = $2 and month is not distinct from $3 and status in ('current', 'needs_regeneration')`, [kind, year, month], client);
            const { rows } = await query(`insert into attraction_outputs (kind, year, month, composition, issued_by_email) values ($1, $2, $3, $4, $5) returning id, status, issued_at`,
                [kind, year, month, JSON.stringify(composition), actor.email], client);
            res.status(201).json({ success: true, output: { _id: rows[0].id, kind, year, month, status: rows[0].status, issuedAt: rows[0].issued_at, composition } });
        });
    }));
    router.get('/attraction-visits/outputs', requireAdmin, handle(async (req, res) => {
        const year = yearParam(req);
        const { rows } = await query(`select id, kind, year, month, status, jsonb_array_length(composition) as versions, issued_by_email, issued_at, status_changed_at from attraction_outputs where year = $1 order by issued_at desc limit 200`, [year]);
        res.json({ success: true, outputs: rows.map(r => ({ _id: r.id, kind: r.kind, year: r.year, month: r.month, status: r.status, versions: r.versions, issuedBy: r.issued_by_email, issuedAt: r.issued_at, statusChangedAt: r.status_changed_at })) });
    }));

    /* ---- Excel ------------------------------------------------------------ */
    const X = require('./attraction-visits-excel');
    const send = async (res, wb, name) => {
        const buffer = await X.toBuffer(wb);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^A-Za-z0-9_.-]/g, '_')}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(buffer);
    };
    const fileName = (spot, tail) => `${String(spot.title).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}_${tail}.xlsx`;

    /* VAR 1 for one attraction and month: a saved version as submitted, or the daily counts now (marked not submitted). */
    router.get('/attraction-visits/:spotId/months/:year/:month/export.xlsx', READ, handle(async (req, res) => {
        const spot = await placeFor(req, req.params.spotId);
        const { year, month } = periodParams(req);
        const v = await monthView(spot, year, month);
        const which = String(req.query.version || 'latest');
        let figures, status;
        const pick = which === 'latest' ? v.versionRows[v.versionRows.length - 1] : which === 'current' ? null : v.versionRows.find(x => x.version === Number(which));
        if (which !== 'current' && !pick) refuse(404, 'NO_VERSION', 'No saved version of that month. Export the daily counts now with version=current.');
        if (pick) { figures = E.figuresFromVersion(pick); status = `Version ${pick.version}, submitted ${E.toDate(pick.submitted_at)}${v.period && v.period.finalizedVersion === pick.version ? ', finalized' : ''}`; }
        else { if (E.firstDay(year, month) > v.today) refuse(409, 'FUTURE', 'That month has not started.'); figures = v.figures; status = `NOT SUBMITTED: worked out from the daily counts on ${v.today}`; }
        const wb = X.workbook(); X.addVar1(wb, { attraction: spotInfo(spot, v.settings), figures, status });
        return send(res, wb, fileName(spot, `VAR1_${year}-${E.pad(month)}_${pick ? 'v' + pick.version : 'draft'}`));
    }));
    router.get('/attraction-visits/consolidated/monthly.xlsx', requireAdmin, handle(async (req, res) => {
        const { year, month } = periodParams(req), mode = modeParam(req);
        const wb = X.workbook(); X.addDta2m(wb, await monthlyConsolidation(year, month, mode));
        return send(res, wb, `DTA2M_${year}-${E.pad(month)}_${mode}.xlsx`);
    }));
    router.get('/attraction-visits/consolidated/annual.xlsx', requireAdmin, handle(async (req, res) => {
        const year = yearParam(req), mode = modeParam(req);
        const d = await annualConsolidation(year, mode);
        const wb = X.workbook(); X.addVar3m(wb, d); for (const a of d.attractions) if (a.months.some(m => m.cell.included)) X.addVar2(wb, { year, mode, attraction: a });
        return send(res, wb, `VAR3M_${year}_${mode}.xlsx`);
    }));
    /* An issued output again, built from the exact versions it used (not from today's data). */
    router.get('/attraction-visits/outputs/:id/export.xlsx', requireAdmin, handle(async (req, res) => {
        if (!ID.test(String(req.params.id))) refuse(404, 'NOT_FOUND', 'Output not found.');
        const o = (await query('select * from attraction_outputs where id = $1', [req.params.id])).rows[0];
        if (!o) refuse(404, 'NOT_FOUND', 'Output not found.');
        const ids = o.composition.map(c => c.versionId);
        const versions = (await query(`select ${VERSION_COLS} from attraction_report_versions where id = any($1)`, [ids])).rows;
        const spots = (await query('select id, title, category from spots where id = any($1)', [[...new Set(o.composition.map(c => c.spotId))]])).rows;
        const sets = (await query('select spot_id, attraction_code from attraction_settings where spot_id = any($1)', [spots.map(s => s.id)])).rows;
        const mk = (spotId, month) => { const c = o.composition.find(x => x.spotId === spotId && x.month === month); const v = c && versions.find(x => x.id === c.versionId); return v ? { kind: 'final', version: v.version, figures: E.figuresFromVersion(v), pending: false } : { kind: 'none' }; };
        const wb = X.workbook();
        if (o.kind === 'DTA2M') {
            const rows = spots.map(s => { const src = mk(s.id, o.month); return { spot: s, code: (sets.find(x => x.spot_id === s.id) || {}).attraction_code || '', state: 'finalized', source: src, dta2m: E.dta2mRow(src) }; });
            X.addDta2m(wb, { year: o.year, month: o.month, mode: 'official', rows, totals: E.sumRows(rows.map(r => r.dta2m)), coverage: { attractions: rows.length, finalized: rows.length, submitted: 0, draft: 0, notSubmitted: 0 }, issued: { at: o.issued_at, status: o.status, id: o.id } });
        } else {
            const attractions = spots.map(s => ({ spot: s, code: (sets.find(x => x.spot_id === s.id) || {}).attraction_code || '', months: Array.from({ length: 12 }, (_, i) => { const src = mk(s.id, i + 1); return { month: i + 1, state: src.kind === 'final' ? 'finalized' : 'none', source: src, cell: E.var3mCell(src) }; }) }));
            const zero = { domestic: null, foreign: null, total: 0, unrecorded: 0 };
            const totals = attractions.map(a => a.months.filter(m => m.cell.included).reduce((acc, m) => E.addCells(acc, m.cell), { ...zero }));
            const byMonth = Array.from({ length: 12 }, (_, i) => { const cs = attractions.map(a => a.months[i].cell).filter(c => c.included); return cs.length ? cs.reduce((acc, c) => E.addCells(acc, c), { ...zero }) : null; });
            X.addVar3m(wb, { year: o.year, mode: 'official', attractions, totals, byMonth, grand: totals.reduce((acc, t) => E.addCells(acc, t), { ...zero }), legacy: { municipalTotalMonths: 0, note: '' }, issued: { at: o.issued_at, status: o.status, id: o.id } });
        }
        return send(res, wb, `${o.kind}_${o.year}${o.month ? '-' + E.pad(o.month) : ''}_issued_${String(o.id).slice(0, 8)}.xlsx`);
    }));

    return router;
};
module.exports.fromDatabase = fromDatabase;

module.exports.sources = { settingsOf, loadCtx, hasStaff, yearSources, officeAttractions };