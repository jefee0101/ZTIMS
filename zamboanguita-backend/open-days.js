/* Which weekdays a destination is open, read from and written to its
 * `working_days` text ("Everyday", "Monday to Saturday", "Weekends only",
 * "Monday, Wednesday and Friday" …).
 *
 * The text stays what visitors read; the office ticks days in the attraction
 * setup and this turns the ticks into that text and back. Older free text is
 * read as well as it can be ("Tuesday to Sunday", "Mon–Fri", "weekdays"); text
 * that names no day at all ("By appointment") is UNKNOWN, and unknown means
 * open every day — a sale is never refused on a guess.
 *
 * DUPLICATED BY HAND in Zamboanguita-project/src/shared/open-days.js, which the
 * forms use. `npm run check` in the frontend compares the two.
 */
const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/* The weekdays a text names, in week order, or null when it names none. */
function parseOpenDays(text) {
    const t = String(text || '').toLowerCase().replace(/[–—]/g, '-').trim();

    // "Closed Mondays", "Daily except Sundays": the days after the word are
    // taken OUT of what comes before it (every day, when nothing does).
    const exception = /\b(closed|except|excluding|but not)\b/.exec(t);
    if (exception) {
        const before = t.slice(0, exception.index).replace(/\b(open|,)\s*$/, '').trim();
        const shut = namedDays(t.slice(exception.index + exception[0].length));
        if (!shut) return before ? parseOpenDays(before) : null;
        const base = (before && namedDays(before)) || WEEK;
        const open = base.filter(d => !shut.includes(d));
        return open.length ? open : null;
    }
    return namedDays(t);
}

/* The weekdays a piece of text names (no exceptions), or null for none. */
function namedDays(t) {
    if (!t || /every\s*day|daily|all\s*week|7\s*days|seven\s*days/.test(t)) return WEEK.slice();

    const open = new Set();
    if (/weekends?/.test(t)) { open.add('sat'); open.add('sun'); }
    if (/weekdays?/.test(t)) WEEK.slice(0, 5).forEach(d => open.add(d));

    // Day words, each with what stands between it and the one before, so
    // "Monday to Friday" and "Mon-Fri" are ranges and "Mon, Fri" is not.
    const found = [];
    // Whole day names and their usual short forms only, so "sunrise" or
    // "monthly" never reads as a day.
    const dayWord = /\b(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?\.?(?![a-z])/g;
    let m;
    while ((m = dayWord.exec(t))) found.push({ day: WEEK.indexOf(m[1].slice(0, 3)), start: m.index, end: m.index + m[0].length });
    for (let i = 0; i < found.length; i++) {
        open.add(WEEK[found[i].day]);
        if (i === 0) continue;
        const between = t.slice(found[i - 1].end, found[i].start);
        if (/^\s*(-|to|through|thru|until|till)\s*$/.test(between)) {
            for (let d = found[i - 1].day; d !== found[i].day; d = (d + 1) % 7) open.add(WEEK[d]);
        }
    }
    return open.size ? WEEK.filter(d => open.has(d)) : null;
}

/* The text for a set of ticked days. At least one day; all seven is Everyday. */
function formatOpenDays(days) {
    const set = WEEK.filter(d => (days || []).includes(d));
    if (!set.length) return '';
    const key = set.join(',');
    if (set.length === 7) return 'Everyday';
    if (key === 'mon,tue,wed,thu,fri') return 'Monday to Friday';
    if (key === 'mon,tue,wed,thu,fri,sat') return 'Monday to Saturday';
    if (key === 'sat,sun') return 'Weekends only';
    const index = set.map(d => WEEK.indexOf(d));
    if (set.length === 1) return `${NAMES[index[0]]}s only`;
    if (set.length >= 3 && index[index.length - 1] - index[0] === set.length - 1) {
        return `${NAMES[index[0]]} to ${NAMES[index[index.length - 1]]}`;
    }
    const names = index.map(i => NAMES[i]);
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/* The weekday key of a YYYY-MM-DD date. */
function weekdayOf(dateKey) {
    const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();   // 0 = Sunday
    return WEEK[(day + 6) % 7];
}

/* Whether the text says the place is open on that date's weekday. */
function isOpenOn(workingDays, dateKey) {
    const days = parseOpenDays(workingDays);
    return !days || days.includes(weekdayOf(dateKey));
}

module.exports = { WEEK, NAMES, parseOpenDays, formatOpenDays, weekdayOf, isOpenOn };
