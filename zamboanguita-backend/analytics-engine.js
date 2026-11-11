/* Analytics arithmetic, with no database: periods, sums, coverage, peak and
 * low, comparisons, daily patterns. analytics.js feeds it the authoritative
 * records (saved and finalized versions, daily counts, stays, bookings) and
 * every screen, card and Excel file reads the result, so all of them agree.
 *
 * Rules held here, whatever the caller asks:
 *  - A missing month or day is null, never 0. A confirmed zero is 0.
 *  - A total over periods is only "complete" when every period is complete;
 *    partial totals are flagged and never ranked as a peak or a low.
 *  - A rate is worked out from summed counts, never averaged.
 *  - Unknown breakdowns stay null (addN): unknown + unknown is unknown.
 *  - Comparisons are differences in counts over periods complete in both
 *    years. No percentage (the counts-only rule, G4 in docs/analytics).
 */
'use strict';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = n => String(n).padStart(2, '0');
const monthKey = (y, m) => `${y}-${pad(m)}`;
const parseKey = k => [Number(k.slice(0, 4)), Number(k.slice(5, 7))];
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const firstDay = (y, m) => `${monthKey(y, m)}-01`;
const lastDay = (y, m) => `${monthKey(y, m)}-${pad(daysIn(y, m))}`;
const dayNum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
const dayStr = n => new Date(n * 864e5).toISOString().slice(0, 10);
const addDays = (s, n) => dayStr(dayNum(s) + n);
const weekday = s => new Date(dayNum(s) * 864e5).getUTCDay();
const toDate = v => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const manilaToday = (now = Date.now()) => new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
const ratio = (a, b) => (a == null || b == null || b <= 0 ? null : a / b);
const addN = (a, b) => (a == null ? (b == null ? null : b) : b == null ? a : a + b);

/* The months from..to (inclusive), as keys. */
function monthRange(from, to) {
    const out = [];
    let [y, m] = parseKey(from);
    const [ty, tm] = parseKey(to);
    while (y < ty || (y === ty && m <= tm)) { out.push(monthKey(y, m)); m++; if (m > 12) { m = 1; y++; } }
    return out;
}
/* The period a month belongs to, for each supported granularity. */
function periodOf(key, granularity) {
    const [y, m] = parseKey(key);
    if (granularity === 'quarter') return { key: `${y}-Q${Math.ceil(m / 3)}`, label: `Q${Math.ceil(m / 3)} ${y}` };
    if (granularity === 'year') return { key: String(y), label: String(y) };
    return { key, label: `${MONTHS[m - 1]} ${y}` };
}

/* ---- accommodation --------------------------------------------------------- */
const ACC_FIELDS = ['arrivals', 'guestNights', 'roomNightsOccupied', 'roomNightsAvailable'];
/* One month's figures from the versions chosen for it. Rooms only make sense for a month. */
function accMonth(versions, counts) {
    if (!versions.length) return null;
    const f = { rooms: 0, arrivals: 0, guestNights: 0, roomNightsOccupied: 0, roomNightsAvailable: 0, residence: emptySections(), sex: { male: 0, female: 0 } };
    for (const v of versions) {
        f.rooms += v.rooms || 0; f.arrivals += v.arrivals; f.guestNights += v.guest_nights;
        f.roomNightsOccupied += v.room_nights_occupied; f.roomNightsAvailable += v.room_nights_available;
    }
    for (const c of counts) {
        const s = f.residence[c.section] || (f.residence[c.section] = 0);
        f.residence[c.section] = s + c.male + c.female;
        f.sex.male += c.male; f.sex.female += c.female;
    }
    return f;
}
const emptySections = () => ({ philippine: 0, foreign: 0, overseas_filipino: 0, unspecified: 0 });
/* Rates the DAE templates define for private places to stay, from summed counts. */
function accRates(f) {
    if (!f) return null;
    return { occupancyRate: ratio(f.roomNightsOccupied, f.roomNightsAvailable), averageLengthOfStay: ratio(f.guestNights, f.arrivals) };
}
/* Adds months into a period. A period is complete only when every month in it is. */
function accPeriod(months) {
    const has = months.filter(m => m.figures);
    const f = has.length ? { arrivals: 0, guestNights: 0, roomNightsOccupied: 0, roomNightsAvailable: 0, residence: emptySections(), sex: { male: 0, female: 0 } } : null;
    for (const m of has) {
        ACC_FIELDS.forEach(k => { f[k] += m.figures[k]; });
        Object.entries(m.figures.residence).forEach(([k, v]) => { f.residence[k] = (f.residence[k] || 0) + v; });
        f.sex.male += m.figures.sex.male; f.sex.female += m.figures.sex.female;
    }
    if (f && months.length === 1) f.rooms = has[0].figures.rooms;
    const cov = sumCoverage(months.map(m => m.coverage));
    return { figures: f, rates: accRates(f), coverage: cov, complete: months.every(m => m.complete), future: months.every(m => m.future),
             months: months.map(m => m.key) };
}

/* ---- attractions ----------------------------------------------------------- */
/* One attraction-month from its source (attraction-engine.js shapes), or null. */
function attMonthFigures(src, E) {
    const f = src.figures; if (!f) return null;
    const known = E.residenceKnown(f);
    return { visits: f.total, residence: known ? { ...f.residence } : null, residenceUnrecorded: f.residenceUnrecorded,
             sex: f.sexRecorded ? { male: f.male, female: f.female } : null, sexUnrecorded: f.sexUnrecorded,
             datesCounted: f.dates, zeroDays: f.zero, closedDays: f.closed };
}
function addAtt(a, b) {
    if (!a) return b ? JSON.parse(JSON.stringify(b)) : null;
    if (!b) return a;
    const res = a.residence == null && b.residence == null ? null
        : Object.fromEntries(['zamboanguita', 'negrosOriental', 'otherProvince', 'foreign'].map(k => [k, addN(a.residence && a.residence[k], b.residence && b.residence[k])]));
    const sex = a.sex == null && b.sex == null ? null : { male: addN(a.sex && a.sex.male, b.sex && b.sex.male), female: addN(a.sex && a.sex.female, b.sex && b.sex.female) };
    return { visits: a.visits + b.visits, residence: res, residenceUnrecorded: a.residenceUnrecorded + b.residenceUnrecorded, sex, sexUnrecorded: a.sexUnrecorded + b.sexUnrecorded,
             datesCounted: a.datesCounted + b.datesCounted, zeroDays: a.zeroDays + b.zeroDays, closedDays: a.closedDays + b.closedDays };
}
function attPeriod(months) {
    const f = months.reduce((acc, m) => addAtt(acc, m.figures), null);
    return { figures: f, coverage: sumCoverage(months.map(m => m.coverage)), complete: months.every(m => m.complete), future: months.every(m => m.future), months: months.map(m => m.key) };
}

/* ---- shared -------------------------------------------------------------- */
function sumCoverage(list) {
    const out = {};
    for (const c of list) for (const [k, v] of Object.entries(c || {})) if (typeof v === 'number') out[k] = (out[k] || 0) + v;
    return out;
}
/* Groups month rows into periods with the domain's adder. */
function toPeriods(monthRows, granularity, adder) {
    const groups = new Map();
    for (const m of monthRows) {
        const p = periodOf(m.key, granularity);
        if (!groups.has(p.key)) groups.set(p.key, { key: p.key, label: p.label, rows: [] });
        groups.get(p.key).rows.push(m);
    }
    return [...groups.values()].map(g => ({ key: g.key, label: g.label, ...adder(g.rows) }));
}
/* Peak and low among complete periods with figures only. */
function peakLow(periods, value) {
    const ok = periods.filter(p => p.complete && p.figures && value(p) != null);
    if (!ok.length) return { peak: null, low: null, ranked: 0, excluded: periods.filter(p => !p.future && !(p.complete && p.figures)).map(p => p.key) };
    const sorted = [...ok].sort((a, b) => value(b) - value(a));
    return { peak: { key: sorted[0].key, value: value(sorted[0]) }, low: ok.length > 1 ? { key: sorted[sorted.length - 1].key, value: value(sorted[sorted.length - 1]) } : null,
             ranked: ok.length, excluded: periods.filter(p => !p.future && !(p.complete && p.figures)).map(p => p.key) };
}
/* This period against the same one a year earlier: a difference in counts, only when both are complete. */
function compare(cur, prev, value) {
    return cur.map((p, i) => {
        const q = prev[i];
        const comparable = !!(q && p.complete && q.complete && p.figures && q.figures);
        return { key: p.key, previousKey: q ? q.key : null, comparable, current: p.figures ? value(p) : null, previous: q && q.figures ? value(q) : null,
                 difference: comparable ? value(p) - value(q) : null,
                 reason: comparable ? null : !p.figures || !p.complete ? 'This period is not complete.' : !q || !q.figures ? 'Nothing was reported a year earlier.' : 'The earlier period is not complete.' };
    });
}
/* Totals over a range, with completeness carried. */
function total(periods, adder) {
    const t = adder(periods.map(p => ({ key: p.key, figures: p.figures, coverage: p.coverage, complete: p.complete, future: p.future })));
    return t;
}

/* ---- daily patterns (one attraction, or one enterprise's stays) ----------- */
/* Days are { date, value (null = not recorded), state }. Means use recorded days only. */
function weekdayMeans(days) {
    const sum = Array(7).fill(0), n = Array(7).fill(0);
    for (const d of days) if (d.value != null) { const w = weekday(d.date); sum[w] += d.value; n[w]++; }
    const all = n.reduce((a, b) => a + b, 0);
    return { weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((name, i) => ({ weekday: name, mean: n[i] ? sum[i] / n[i] : null, days: n[i] })),
             overallMean: all ? sum.reduce((a, b) => a + b, 0) / all : null, recordedDays: all };
}
/* Trailing 7-day mean over recorded days, needing at least 3 recorded days in the window. */
function rolling7(days) {
    return days.map((d, i) => {
        if (d.value == null) return null;
        const w = days.slice(Math.max(0, i - 6), i + 1).map(x => x.value).filter(v => v != null);
        return w.length >= 3 ? w.reduce((a, b) => a + b, 0) / w.length : null;
    });
}
function peakLowDays(days) {
    const rec = days.filter(d => d.value != null);
    if (!rec.length) return { peak: null, low: null };
    const s = [...rec].sort((a, b) => b.value - a.value || (a.date < b.date ? -1 : 1));
    return { peak: { date: s[0].date, value: s[0].value }, low: rec.length > 1 ? { date: s[s.length - 1].date, value: s[s.length - 1].value } : null };
}
const median = list => {
    const a = list.filter(v => v != null && Number.isFinite(v)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const STAY_BUCKETS = [['1', 1, 1], ['2', 2, 2], ['3', 3, 3], ['4-6', 4, 6], ['7+', 7, Infinity]];
function stayBuckets(nights) {
    return STAY_BUCKETS.map(([label, lo, hi]) => ({ nights: label, stays: nights.filter(n => n >= lo && n <= hi).length }));
}

module.exports = {
    MONTHS, pad, monthKey, parseKey, daysIn, firstDay, lastDay, addDays, weekday, toDate, manilaToday, ratio, addN,
    monthRange, periodOf, accMonth, accRates, accPeriod, attMonthFigures, addAtt, attPeriod, sumCoverage, toPeriods, peakLow, compare, total,
    weekdayMeans, rolling7, peakLowDays, median, stayBuckets, emptySections
};
