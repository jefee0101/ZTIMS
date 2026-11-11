/* Accommodation reporting: the arithmetic, with no database and no HTTP.
 *
 * Dates are 'YYYY-MM-DD' strings. The night of date D belongs to a room or a
 * guest when starts_on <= D < ends_on, so the check-out night is never
 * counted. A guest row's starts_on is its arrival: arrivals fall in the month
 * of that day. Room-nights occupied count each room once a night, however many
 * stays share it or move through it. Missing is never zero: a month with no
 * saved version has no figures in any annual or municipal total.
 */
const crypto = require('crypto');

const DEADLINE_DAY = 5;
const MANILA_OFFSET_HOURS = 8;

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

function manilaToday(now = Date.now()) {
    return new Date(now + MANILA_OFFSET_HOURS * 3600e3).toISOString().slice(0, 10);
}
/* Due by the end of the 5th of the following month, Manila time. */
function deadlineFor(year, month) {
    return new Date(Date.UTC(year, month, DEADLINE_DAY, 24 - MANILA_OFFSET_HOURS) - 1);
}

/* The months, 'YYYY-MM', that nights from..until (exclusive) fall in. */
function monthsOfNights(from, until) {
    const out = [];
    for (let k = from.slice(0, 7); k <= addDays(until, -1).slice(0, 7);) {
        out.push(k);
        const y = +k.slice(0, 4), m = +k.slice(5);
        k = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
    }
    return out;
}
/* Every month a stay's figures touch: arrivals (guest starts) and nights. */
function monthsOfStay(stay) {
    const set = new Set(monthsOfNights(stay.check_in, stay.check_out));
    for (const g of stay.guests || []) set.add(g.starts_on.slice(0, 7));
    return [...set].sort();
}

const roomActive = (room, d) => room.available_from <= d && (!room.available_until || d < room.available_until);
const covers = (row, d) => row.starts_on <= d && d < row.ends_on;           // nights [starts, ends)
const coversInclusive = (row, d) => row.starts_on <= d && d <= row.ends_on; // out-of-service, closed

/* One place's records, normalised (dates as strings, voided rows dropped). */
function normalise(data) {
    const s = x => ({ ...x, starts_on: toDate(x.starts_on), ends_on: toDate(x.ends_on) });
    return {
        rooms: (data.rooms || []).map(r => ({ ...r, available_from: toDate(r.available_from), available_until: toDate(r.available_until) })),
        unavailability: (data.unavailability || []).filter(u => !u.voided_at).map(s),
        closed: (data.closed || []).filter(c => !c.voided_at).map(s),
        stays: (data.stays || []).filter(x => x.status !== 'void').map(x => ({
            ...x, check_in: toDate(x.check_in), check_out: toDate(x.check_out),
            rooms: (x.rooms || []).map(s), guests: (x.guests || []).map(s)
        }))
    };
}

/* One day: DAE-1A columns (5), (6), (7), and the rooms available. */
function dayFigures(data, d) {
    let checkIn = 0, guests = 0;
    const occupied = new Set();
    // Guests per room that night, where the stay's guests can be placed: a
    // stay holding one room that night puts all its guests there; a stay
    // holding several leaves its rooms "occupied, guests not split" (null).
    const roomGuests = {}, roomCheckIn = {};
    for (const st of data.stays) {
        if (d < st.check_in || d >= st.check_out) {
            for (const g of st.guests) if (g.starts_on === d) checkIn += g.male + g.female;
            continue;
        }
        let here = 0, arriving = 0;
        for (const g of st.guests) {
            if (g.starts_on === d) { checkIn += g.male + g.female; arriving += g.male + g.female; }
            if (covers(g, d)) { guests += g.male + g.female; here += g.male + g.female; }
        }
        const rooms = st.rooms.filter(a => covers(a, d)).map(a => a.room_id);
        for (const id of rooms) occupied.add(id);
        for (const id of rooms) {
            if (rooms.length === 1 && roomGuests[id] !== null) roomGuests[id] = (roomGuests[id] || 0) + here;
            else roomGuests[id] = null;
            if (arriving) roomCheckIn[id] = true;
        }
    }
    const closed = data.closed.some(c => coversInclusive(c, d));
    const active = data.rooms.filter(r => roomActive(r, d));
    const out = new Set(data.unavailability.filter(u => coversInclusive(u, d)).map(u => u.room_id)
        .filter(id => active.some(r => r.id === id)));
    return { date: d, checkIn, guestNights: guests, roomsOccupied: occupied.size, occupiedRooms: [...occupied], roomGuests, roomCheckIn, activeRooms: active.map(r => r.id),
             roomsActive: active.length, outOfService: out.size, available: closed ? 0 : active.length - out.size, closed };
}

/* A month's DAE-1A and DAE-1B figures. `today` (Manila) cuts a month still
   running: nights up to yesterday, arrivals up to today. */
function monthFigures(raw, year, month, { today, sections } = {}) {
    const data = normalise(raw);
    const days = daysIn(year, month), first = firstDay(year, month), last = lastDay(year, month);
    const lastNight = today ? addDays(today, -1) : last;
    const through = last < lastNight ? last : lastNight;
    const daily = [];
    let guestNights = 0, roomNightsOccupied = 0, roomNightsAvailable = 0, closedDays = 0, rooms = 0;
    for (let i = 1; i <= days; i++) {
        const d = `${monthKey(year, month)}-${pad(i)}`;
        const f = dayFigures(data, d);
        f.counted = d <= through;
        if (f.closed) closedDays += 1;
        rooms = Math.max(rooms, f.roomsActive);
        if (f.counted) {
            guestNights += f.guestNights;
            roomNightsOccupied += f.roomsOccupied;
            roomNightsAvailable += f.available;
        }
        daily.push(f);
    }
    const counts = {}, byDay = {};
    let arrivals = 0;
    for (const st of data.stays) for (const g of st.guests) {
        if (g.starts_on < first || g.starts_on > last || (today && g.starts_on > today)) continue;
        const c = counts[g.residence_code] || (counts[g.residence_code] = { male: 0, female: 0 });
        c.male += g.male; c.female += g.female; arrivals += g.male + g.female;
        const b = byDay[g.residence_code] || (byDay[g.residence_code] = { male: Array(days).fill(0), female: Array(days).fill(0) });
        const i = +g.starts_on.slice(8, 10) - 1;
        b.male[i] += g.male; b.female[i] += g.female;
    }
    const volume = { philippine: { male: 0, female: 0 }, foreign: { male: 0, female: 0 }, overseas_filipino: { male: 0, female: 0 }, unspecified: { male: 0, female: 0 } };
    for (const [code, c] of Object.entries(counts)) {
        const v = volume[(sections && sections[code]) || 'unspecified'];
        v.male += c.male; v.female += c.female;
    }
    return {
        year, month, rooms, arrivals, counts, byDay, volume, guestNights, roomNightsOccupied, roomNightsAvailable,
        roomNumbers: Object.fromEntries(data.rooms.map(r => [r.id, r.room_number])),
        occupancyRate: ratio(roomNightsOccupied, roomNightsAvailable),
        averageLengthOfStay: ratio(guestNights, arrivals),
        guestsPerRoom: ratio(guestNights, roomNightsOccupied),
        daily, through, partial: through < last, notOperating: closedDays === days
    };
}

const ratio = (a, b) => (b > 0 ? a / b : null);

/* What a version saves: the figures, nothing about a person or a stay. */
function versionFigures(f) {
    return {
        rooms: f.rooms, arrivals: f.arrivals, guestNights: f.guestNights,
        roomNightsOccupied: f.roomNightsOccupied, roomNightsAvailable: f.roomNightsAvailable,
        counts: Object.fromEntries(Object.entries(f.counts).filter(([, c]) => c.male + c.female > 0))
    };
}

/* The day-by-day detail a version keeps, so its DAE-1A and DAE-1B exports
   come from the version itself: arrivals per day by residence and sex, and
   each day's DAE-1A columns with the rooms occupied (by room number) and the
   guests in each where they can be placed. No stay, no person. */
function versionDetail(f) {
    const used = new Set();
    for (const d of f.daily) for (const id of [...d.activeRooms, ...d.occupiedRooms]) used.add(id);
    const roomActiveInMonth = [...used];
    return {
        days: f.daily.length,
        byDay: f.byDay,
        rooms: roomActiveInMonth.map(id => f.roomNumbers[id]).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })),
        daily: f.daily.map(d => ({
            checkIn: d.checkIn, guestNights: d.guestNights, roomsOccupied: d.roomsOccupied, available: d.available, closed: d.closed,
            rooms: Object.fromEntries(d.occupiedRooms.map(id => [f.roomNumbers[id] || id, d.roomGuests[id] === undefined ? null : d.roomGuests[id]])),
            checkInRooms: Object.keys(d.roomCheckIn || {}).map(id => f.roomNumbers[id] || id)
        }))
    };
}

/* Differences between a saved version and the register now. */
function differences(saved, now) {
    const out = [];
    const chk = (field, a, b) => { if (a !== b) out.push({ field, saved: a, now: b }); };
    chk('arrivals', saved.arrivals, now.arrivals);
    chk('guestNights', saved.guestNights, now.guestNights);
    chk('roomNightsOccupied', saved.roomNightsOccupied, now.roomNightsOccupied);
    chk('roomNightsAvailable', saved.roomNightsAvailable, now.roomNightsAvailable);
    chk('rooms', saved.rooms, now.rooms);
    const codes = new Set([...Object.keys(saved.counts || {}), ...Object.keys(now.counts || {})]);
    for (const code of [...codes].sort()) {
        const a = (saved.counts || {})[code] || { male: 0, female: 0 }, b = (now.counts || {})[code] || { male: 0, female: 0 };
        if (a.male !== b.male || a.female !== b.female) out.push({ field: 'counts', residence: code, saved: a, now: b });
    }
    return out;
}

/* A fingerprint of everything a month's figures were worked out from. */
function sourceDigest(raw, year, month) {
    const data = normalise(raw);
    const first = firstDay(year, month), end = addDays(lastDay(year, month), 1);
    const touches = (from, until) => from < end && until > first;
    const pick = {
        rooms: data.rooms.filter(r => touches(r.available_from, r.available_until || '9999-12-31'))
            .map(r => [r.id, r.available_from, r.available_until]).sort(),
        out: data.unavailability.filter(u => touches(u.starts_on, addDays(u.ends_on, 1))).map(u => [u.id, u.room_id, u.starts_on, u.ends_on]).sort(),
        closed: data.closed.filter(c => touches(c.starts_on, addDays(c.ends_on, 1))).map(c => [c.id, c.starts_on, c.ends_on]).sort(),
        stays: data.stays.filter(s => monthsOfStay(s).includes(monthKey(year, month))).map(s => [s.id, s.check_in, s.check_out,
            s.rooms.map(a => [a.room_id, a.starts_on, a.ends_on]).sort(),
            s.guests.map(g => [g.residence_code, g.male, g.female, g.starts_on, g.ends_on]).sort()]).sort()
    };
    return { digest: crypto.createHash('sha256').update(JSON.stringify(pick)).digest('hex'), stays: pick.stays.length };
}

/* Where a place's month stands. */
function periodState({ year, month, today, reportingFrom, versions, finalized, events, figures, municipal }) {
    const first = firstDay(year, month), last = lastDay(year, month);
    const latest = versions.length ? versions[versions.length - 1] : null;
    const lastEvent = events.length ? events[events.length - 1] : null;
    const base = { latestVersion: latest ? latest.version : 0, deadline: deadlineFor(year, month).toISOString() };
    if (municipal) return { ...base, state: 'municipal_total' };
    if (first > today) return { ...base, state: 'future' };
    if (finalized) return { ...base, state: 'finalized' };
    let diff = [];
    if (latest && latest.provenance === 'register' && figures) diff = differences(latest.figures, versionFigures(figures));
    if (lastEvent && lastEvent.action === 'reopened') return { ...base, state: 'reopened', differences: diff };
    if (latest) return { ...base, state: diff.length ? 'changed' : 'submitted', differences: diff };
    if (figures && figures.notOperating) return { ...base, state: 'not_operating' };
    if (!reportingFrom) return { ...base, state: 'not_set_up' };
    if (first < reportingFrom) return { ...base, state: 'not_recorded' };
    if (last >= today) return { ...base, state: 'open' };
    return { ...base, state: todayPastDeadline(today, year, month) ? 'overdue' : 'due' };
}
function todayPastDeadline(today, year, month) {
    const y = month === 12 ? year + 1 : year, m = month === 12 ? 1 : month + 1;
    return today > `${y}-${pad(m)}-${pad(DEADLINE_DAY)}`;
}

/* A year from saved versions only: sums, then rates from the sums. */
function annualTotals(months) {
    const t = { arrivals: 0, guestNights: 0, roomNightsOccupied: 0, roomNightsAvailable: 0, counts: {}, months: 0 };
    for (const m of months) {
        if (!m) continue;
        t.months += 1;
        t.arrivals += m.arrivals; t.guestNights += m.guestNights;
        t.roomNightsOccupied += m.roomNightsOccupied; t.roomNightsAvailable += m.roomNightsAvailable;
        for (const [code, c] of Object.entries(m.counts || {})) {
            const x = t.counts[code] || (t.counts[code] = { male: 0, female: 0, unsplit: 0 });
            x.male += c.male || 0; x.female += c.female || 0; x.unsplit += c.unsplit || 0;
        }
    }
    t.occupancyRate = ratio(t.roomNightsOccupied, t.roomNightsAvailable);
    t.averageLengthOfStay = ratio(t.guestNights, t.arrivals);
    return t;
}

/* % difference, unavailable without a baseline or with a zero baseline. */
const percentDifference = (current, previous) => (previous == null || previous === 0 || current == null ? null : (current - previous) / previous);

module.exports = {
    DEADLINE_DAY, pad, addDays, daysIn, monthKey, firstDay, lastDay, isDate, toDate, manilaToday, deadlineFor,
    monthsOfNights, monthsOfStay, monthFigures, versionFigures, versionDetail, differences, sourceDigest, periodState,
    annualTotals, percentDifference, ratio
};
