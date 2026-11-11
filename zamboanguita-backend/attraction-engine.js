/* Attraction visitor reporting: the arithmetic, with no database and no HTTP.
 *
 * One source of counts: a daily count per attraction and date. Everything else
 * (a month's figures, its saved versions' figures, DTA2M, VAR 3M, VAR 2 and the
 * Excel files) is worked out here from it, so a screen, a preview and an Excel
 * file cannot disagree.
 *
 * Missing, zero, unknown and not applicable stay different:
 *   no daily count            the date is missing (or a closure, or not yet)
 *   total 0                   a confirmed zero
 *   a breakdown that is null  unknown: never zero, never assigned to a class
 * Residence is four classes that never overlap (Zamboanguita, the rest of
 * Negros Oriental, other Philippine provinces, foreign countries). Sex is an
 * independent observation: sex by residence is never worked out.
 * Visits to attractions are never added to accommodation arrivals.
 */
const crypto = require('crypto');

const MAX_TOTAL = 100000;
const MANILA_OFFSET_HOURS = 8;
const DEADLINE_DAY = 5;

const pad = n => String(n).padStart(2, '0');
const dayNum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
const dayStr = n => new Date(n * 864e5).toISOString().slice(0, 10);
const addDays = (s, n) => dayStr(dayNum(s) + n);
const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const monthKey = (year, month) => `${year}-${pad(month)}`;
const firstDay = (year, month) => `${monthKey(year, month)}-01`;
const lastDay = (year, month) => `${monthKey(year, month)}-${pad(daysIn(year, month))}`;
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && dayStr(dayNum(s)) === s;
const toDate = v => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const weekday = d => new Date(dayNum(d) * 864e5).getUTCDay();          // 0 = Sunday
const manilaToday = (now = Date.now()) => new Date(now + MANILA_OFFSET_HOURS * 3600e3).toISOString().slice(0, 10);
const deadlineFor = (year, month) => new Date(Date.UTC(year, month, DEADLINE_DAY, 24 - MANILA_OFFSET_HOURS) - 1);
const shiftMonth = (key, d) => { let y = +key.slice(0, 4), m = +key.slice(5, 7) + d; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return monthKey(y, m); };

/* The four residence classes: [API name, column, label]. */
const CLASSES = [
    ['zamboanguita', 'res_zamboanguita', 'Zamboanguita'],
    ['negrosOriental', 'res_negros_oriental', 'Rest of Negros Oriental'],
    ['otherProvince', 'res_other_province', 'Other Philippine provinces'],
    ['foreign', 'res_foreign', 'Foreign countries']
];

/* ---- validation ------------------------------------------------------------ */
const WRITABLE = ['total', 'residence', 'residenceComplete', 'sex', 'sexComplete', 'revision', 'requestKey'];
const RESIDENCE_KEYS = CLASSES.map(c => c[0]);

/* A daily count from a request body, or the reasons it is refused. Only the
   writable fields are read; any other field is refused, never ignored. */
function parseCount(body) {
    const errors = [];
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    for (const k of Object.keys(b)) if (!WRITABLE.includes(k)) errors.push(`"${k}" cannot be set here.`);
    const whole = (v, label) => {
        if (v === null || v === undefined || v === '') return null;
        const n = typeof v === 'string' && /^\d{1,7}$/.test(v) ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_TOTAL) { errors.push(`${label} must be a whole number from 0 to ${MAX_TOTAL.toLocaleString('en-US')}.`); return null; }
        return n;
    };
    const total = whole(b.total, 'The total');
    if (b.total === null || b.total === undefined || b.total === '') errors.push('The total number of visitors is required. Enter 0 only when no one came.');
    const res = {}; let resGiven = false;
    if (b.residence != null) {
        if (typeof b.residence !== 'object' || Array.isArray(b.residence)) errors.push('Residence must be an object.');
        else {
            for (const k of Object.keys(b.residence)) if (!RESIDENCE_KEYS.includes(k)) errors.push(`"${k}" is not a residence class.`);
            for (const [k, , label] of CLASSES) { res[k] = whole(b.residence[k], label); if (res[k] !== null) resGiven = true; }
        }
    } else CLASSES.forEach(([k]) => { res[k] = null; });
    let male = null, female = null;
    if (b.sex != null) {
        if (typeof b.sex !== 'object' || Array.isArray(b.sex)) errors.push('Sex must be an object.');
        else {
            for (const k of Object.keys(b.sex)) if (!['male', 'female'].includes(k)) errors.push(`"${k}" is not a sex class.`);
            male = whole(b.sex.male, 'Male'); female = whole(b.sex.female, 'Female');
        }
    }
    const flag = (v, label) => { if (v === undefined || v === null) return false; if (typeof v !== 'boolean') { errors.push(`${label} must be true or false.`); return false; } return v; };
    const residenceComplete = flag(b.residenceComplete, 'residenceComplete'), sexComplete = flag(b.sexComplete, 'sexComplete');
    let revision = 0;
    if (b.revision !== undefined && b.revision !== null) { if (!Number.isInteger(b.revision) || b.revision < 0 || b.revision > 1e6) errors.push('The revision must be a whole number.'); else revision = b.revision; }
    let requestKey = '';
    if (b.requestKey !== undefined && b.requestKey !== null) { if (typeof b.requestKey !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(b.requestKey)) errors.push('The request key must be 8 to 64 letters, digits, - or _.'); else requestKey = b.requestKey; }
    if (!requestKey) errors.push('A request key is required (it makes a retried save safe).');
    if (!errors.length && total !== null) {
        const known = CLASSES.reduce((a, [k]) => a + (res[k] || 0), 0), sexKnown = (male || 0) + (female || 0);
        if (total === 0 && (resGiven || male !== null || female !== null || residenceComplete || sexComplete)) errors.push('With no visitors, residence and sex must be empty.');
        if (known > total) errors.push(`Known residence adds up to ${known}, more than the total of ${total}.`);
        else if (residenceComplete && known !== total) errors.push(`Residence is marked complete but adds up to ${known}, not ${total}.`);
        if (sexKnown > total) errors.push(`Male + female is ${sexKnown}, more than the total of ${total}.`);
        else if (sexComplete && sexKnown !== total) errors.push(`Sex is marked complete but male + female is ${sexKnown}, not ${total}.`);
    }
    if (errors.length) return { errors };
    return { value: { total, res, residenceComplete: total > 0 && residenceComplete, male: total === 0 ? null : male, female: total === 0 ? null : female, sexComplete: total > 0 && sexComplete, revision, requestKey } };
}

/* ---- one day, one month ---------------------------------------------------- */
const rowOf = r => ({
    date: toDate(r.count_date), total: r.total,
    res: Object.fromEntries(CLASSES.map(([k, col]) => [k, r[col]])),
    residenceComplete: !!r.residence_complete, male: r.male, female: r.female, sexComplete: !!r.sex_complete, revision: r.revision,
    by: r.updated_by_email || r.created_by_email || '', at: r.updated_at
});
const known = r => CLASSES.reduce((a, [k]) => a + (r.res[k] || 0), 0);

/* The state of one date.
 *   counted / zero  a daily count exists (zero is a confirmed zero)
 *   closed          an authorized closure (spot_closed_dates), not a count
 *   today           today, still open for recording, not yet missing
 *   scheduled       the weekly schedule closes it; still not recorded, never assumed zero
 *   missing         a past date with nothing recorded
 *   future / before  not yet / before this attraction's first reporting month */
function dayState(date, { counts, closed, reportingFrom, today, scheduledClosed }) {
    if (reportingFrom && date < reportingFrom) return { state: 'before' };
    if (date > today) return { state: 'future' };
    const r = counts.get(date);
    if (r) return { state: r.total === 0 ? 'zero' : 'counted', count: r };
    if (closed.has(date)) return { state: 'closed', why: closed.get(date) };
    if (date === today) return { state: 'today' };
    if (scheduledClosed && scheduledClosed(date)) return { state: 'scheduled' };
    return { state: 'missing' };
}

/* A month's figures from the daily counts. Unknown stays unknown: the visits
   with no residence (or sex) recorded are reported as "unrecorded" and never
   added to any class. */
function monthFigures(ctx, year, month) {
    const n = daysIn(year, month);
    const f = { year, month, key: monthKey(year, month), days: n, counted: 0, zero: 0, closed: 0, missing: [], scheduled: [], total: 0,
        residence: { zamboanguita: 0, negrosOriental: 0, otherProvince: 0, foreign: 0 }, residenceUnrecorded: 0, residenceDays: { complete: 0, partial: 0, none: 0 },
        male: 0, female: 0, sexUnrecorded: 0, sexDays: { complete: 0, partial: 0, none: 0 }, daily: [] };
    for (let i = 1; i <= n; i++) {
        const date = `${f.key}-${pad(i)}`, st = dayState(date, ctx), row = { date, weekday: weekday(date), state: st.state };
        if (st.why !== undefined) row.why = st.why;
        const r = st.count;
        if (r) {
            row.count = { total: r.total, residence: { ...r.res }, residenceComplete: r.residenceComplete, male: r.male, female: r.female, sexComplete: r.sexComplete, revision: r.revision };
            f.total += r.total; if (r.total === 0) f.zero++; else f.counted++;
            CLASSES.forEach(([k]) => { f.residence[k] += r.res[k] || 0; });
            const kn = known(r), un = r.total - kn;
            f.residenceUnrecorded += un;
            if (r.total > 0) { if (un === 0) f.residenceDays.complete++; else if (kn === 0) f.residenceDays.none++; else f.residenceDays.partial++; }
            const sk = (r.male || 0) + (r.female || 0), su = r.total - sk;
            f.male += r.male || 0; f.female += r.female || 0; f.sexUnrecorded += su;
            if (r.total > 0) { if (su === 0) f.sexDays.complete++; else if (sk === 0) f.sexDays.none++; else f.sexDays.partial++; }
        }
        if (st.state === 'closed') f.closed++;
        if (st.state === 'missing') f.missing.push(date);
        if (st.state === 'scheduled') f.scheduled.push(date);
        f.daily.push(row);
    }
    f.dates = f.counted + f.zero;                                        // dates with a confirmed count
    f.domestic = f.residence.zamboanguita + f.residence.negrosOriental + f.residence.otherProvince;
    f.foreignKnown = f.residence.foreign;
    f.sexRecorded = f.male + f.female > 0;
    f.complete = f.missing.length === 0 && f.scheduled.length === 0;     // every date counted or closed (once the month has ended)
    return f;
}

/* The figures a saved version keeps (no per-day detail): the same numbers
   monthFigures gives, in the version table's columns. */
const versionColumns = f => ({
    dates_counted: f.dates, zero_days: f.zero, closed_days: f.closed, total: f.total,
    res_zamboanguita: f.residence.zamboanguita, res_negros_oriental: f.residence.negrosOriental, res_other_province: f.residence.otherProvince,
    res_foreign: f.residence.foreign, res_unrecorded: f.residenceUnrecorded, male: f.male, female: f.female, sex_unrecorded: f.sexUnrecorded
});
/* A saved version, read back into the shape monthFigures gives. */
function figuresFromVersion(v) {
    const daily = v.daily || [];
    const f = { year: v.year, month: v.month, key: monthKey(v.year, v.month), days: daysIn(v.year, v.month), counted: v.dates_counted - v.zero_days, zero: v.zero_days, closed: v.closed_days,
        missing: [], scheduled: [], total: v.total, residence: { zamboanguita: v.res_zamboanguita, negrosOriental: v.res_negros_oriental, otherProvince: v.res_other_province, foreign: v.res_foreign },
        residenceUnrecorded: v.res_unrecorded, male: v.male, female: v.female, sexUnrecorded: v.sex_unrecorded, daily, dates: v.dates_counted };
    f.domestic = f.residence.zamboanguita + f.residence.negrosOriental + f.residence.otherProvince;
    f.foreignKnown = f.residence.foreign; f.sexRecorded = f.male + f.female > 0; f.complete = true;
    f.residenceDays = { complete: 0, partial: 0, none: 0 }; f.sexDays = { complete: 0, partial: 0, none: 0 };
    for (const d of daily) if (d.count && d.count.total > 0) {
        const kn = RESIDENCE_KEYS.reduce((a, k) => a + (d.count.residence[k] || 0), 0), sk = (d.count.male || 0) + (d.count.female || 0);
        f.residenceDays[kn === d.count.total ? 'complete' : kn ? 'partial' : 'none']++; f.sexDays[sk === d.count.total ? 'complete' : sk ? 'partial' : 'none']++;
    }
    return f;
}
const sourceDigest = rows => crypto.createHash('sha256').update(JSON.stringify(rows.map(r => [r.date, r.total, CLASSES.map(([k]) => r.res[k]), r.male, r.female, r.residenceComplete, r.sexComplete]))).digest('hex');

/* Dates that changed between two versions' daily snapshots. */
function diffDaily(prev, cur) {
    const out = [], before = new Map((prev || []).map(d => [d.date, d]));
    for (const d of cur || []) {
        const p = before.get(d.date); if (!p) continue;
        const a = p.count, b = d.count;
        if (!a && b) out.push({ date: d.date, change: 'added', to: b.total });
        else if (a && !b) out.push({ date: d.date, change: 'removed', from: a.total });
        else if (a && b && (a.total !== b.total || JSON.stringify(a.residence) !== JSON.stringify(b.residence) || a.male !== b.male || a.female !== b.female)) out.push({ date: d.date, change: a.total !== b.total ? 'total' : 'breakdown', from: a.total, to: b.total });
    }
    return out;
}

/* ---- month state ---------------------------------------------------------- */
/* Where a month stands. `period` is the attraction_periods row (or null),
   `figures` the live figures. Recording is locked in submitted and finalized. */
function periodState({ year, month, today, reportingFrom, period, figures, hasStaff = true }) {
    const key = monthKey(year, month), version = period ? period.currentVersion : 0;
    if (!reportingFrom || firstDay(year, month) < reportingFrom) return { state: 'before', version: 0 };
    if (firstDay(year, month) > today) return { state: 'future', version: 0 };
    if (period) return { state: period.state, version, locked: period.state !== 'reopened', finalizedVersion: period.finalizedVersion || null, pending: period.state === 'reopened' };
    if (!hasStaff && figures.dates + figures.closed === 0) return { state: 'nostaff', version: 0 };
    if (lastDay(year, month) >= today) return { state: 'open', version: 0, key };
    if (!figures.complete) return { state: 'incomplete', version: 0, missing: figures.missing.length + figures.scheduled.length };
    return { state: 'ready', version: 0 };
}

/* ---- consolidation ----------------------------------------------------------
   Official = the finalized version of a month (the last finalized one stays
   official while the month is reopened, marked pending, until a replacement is
   finalized: an old and a new version are never both counted). Operational also
   takes a submitted version, then a draft from the daily counts, each labeled.
   A month with nothing usable is "none": shown as not submitted, never as 0. */
function sourceFor(mode, { state, finalized, latest, draft }) {
    if (state === 'before' || state === 'future') return { kind: state };
    if (finalized) return { kind: 'final', version: finalized.version, figures: finalized.figures, pending: state !== 'finalized' };
    if (mode === 'official') return { kind: state === 'nostaff' ? 'nostaff' : 'none' };
    if (latest) return { kind: state === 'reopened' ? 'reopened' : 'submitted', version: latest.version, figures: latest.figures };
    if (draft && draft.dates > 0) return { kind: 'draft', figures: draft };
    return { kind: state === 'nostaff' ? 'nostaff' : 'none' };
}

/* DTA2M columns for one attraction's month, from a source. Sex-by-residence
   cells do not exist: the form's residence Male/Female are left empty. */
function dta2mRow(src) {
    const f = src.figures; if (!f) return { included: false, kind: src.kind };
    return { included: true, kind: src.kind, version: src.version, pending: !!src.pending,
        thisMunicipality: f.residence.zamboanguita, thisProvince: f.residence.negrosOriental, otherProvince: f.residence.otherProvince, foreign: f.residence.foreign,
        male: f.sexRecorded ? f.male : null, female: f.sexRecorded ? f.female : null, total: f.total, residenceUnrecorded: f.residenceUnrecorded, sexUnrecorded: f.sexUnrecorded, dates: f.dates };
}
/* VAR 3M cells: Domestic = Zamboanguita + rest of Negros Oriental + other provinces (as recorded),
   Foreign (as recorded), Total (confirmed). Domestic + Foreign is below Total by `unrecorded`. */
function var3mCell(src) {
    const f = src.figures; if (!f) return { included: false, kind: src.kind };
    return { included: true, kind: src.kind, version: src.version, pending: !!src.pending, domestic: f.domestic, foreign: f.foreignKnown, total: f.total, unrecorded: f.residenceUnrecorded };
}
const addCells = (a, c) => ({ domestic: a.domestic + c.domestic, foreign: a.foreign + c.foreign, total: a.total + c.total, unrecorded: a.unrecorded + c.unrecorded });
const sumRows = rows => rows.filter(r => r.included).reduce((a, r) => ({
    thisMunicipality: a.thisMunicipality + r.thisMunicipality, thisProvince: a.thisProvince + r.thisProvince, otherProvince: a.otherProvince + r.otherProvince, foreign: a.foreign + r.foreign,
    male: a.male + (r.male || 0), female: a.female + (r.female || 0), sexAny: a.sexAny || r.male !== null, total: a.total + r.total, residenceUnrecorded: a.residenceUnrecorded + r.residenceUnrecorded, sexUnrecorded: a.sexUnrecorded + r.sexUnrecorded, included: a.included + 1
}), { thisMunicipality: 0, thisProvince: 0, otherProvince: 0, foreign: 0, male: 0, female: 0, sexAny: false, total: 0, residenceUnrecorded: 0, sexUnrecorded: 0, included: 0 });

module.exports = {
    MAX_TOTAL, CLASSES, RESIDENCE_KEYS, WRITABLE, pad, dayNum, dayStr, addDays, daysIn, monthKey, firstDay, lastDay, isDate, toDate, weekday, manilaToday, deadlineFor, shiftMonth,
    parseCount, rowOf, dayState, monthFigures, versionColumns, figuresFromVersion, sourceDigest, diffDaily, periodState, sourceFor, dta2mRow, var3mCell, addCells, sumRows
};
