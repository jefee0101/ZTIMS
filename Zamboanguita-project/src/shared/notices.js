/* ==========================================================================
   Announcements and events, as visitors see them
   --------------------------------------------------------------------------
   One copy of what the public pages share: Manila dates, the category pill,
   an event's date block, "Add to calendar" (an .ics made in the browser, in
   Manila time, as payment.html does for a ticket) and the month grid. Used by
   announcements.html, events.html, Home's "What is happening" section and the
   destination page's notice line. The data comes from announcements.js.
   A plain global-scope IIFE like the other shared pieces (window.ZTIMS_NOTICES).
   ========================================================================== */
(function () {
    'use strict';

    const TZ = 'Asia/Manila';
    const LABEL = { advisory: 'Advisory', event: 'Event', closure: 'Closure', general: 'General' };

    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    const part = (iso, opts, locale) => new Intl.DateTimeFormat(locale || 'en-GB', Object.assign({ timeZone: TZ }, opts)).format(new Date(iso));
    const date = iso => part(iso, { day: 'numeric', month: 'long', year: 'numeric' });          // 21 November 2026
    const shortDate = iso => part(iso, { day: 'numeric', month: 'short', year: 'numeric' });   // 21 Nov 2026
    const time = iso => part(iso, { hour: 'numeric', minute: '2-digit' }, 'en-US');            // 7:00 AM
    const dayKey = iso => part(iso, { year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA');   // 2026-11-21
    const clock = iso => part(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });  // 07:00

    const allDay = n => clock(n.startsAt) === '00:00' && /^23:5\d$/.test(clock(n.endsAt));

    /* "7:00 AM to 11:00 AM", "all day", or the dates when it runs over days. */
    function when(n) {
        if (allDay(n) && dayKey(n.startsAt) === dayKey(n.endsAt)) return 'all day';
        if (dayKey(n.startsAt) === dayKey(n.endsAt)) return `${time(n.startsAt)} to ${time(n.endsAt)}`;
        return `${shortDate(n.startsAt)} to ${shortDate(n.endsAt)}`;
    }

    const pill = category => `<span class="an-cat an-cat--${esc(category)}">${LABEL[category] || esc(category)}</span>`;
    const dateBlock = iso => `<span class="an-dateblock" aria-hidden="true"><b>${part(iso, { day: 'numeric' })}</b><span>${part(iso, { month: 'short' })}</span></span>`;

    /* The place, linked to its page; `root` is the way to src/ from the page. */
    const place = (n, root) => n.place
        ? `<a class="np-place" href="${root}spot.html?spotId=${encodeURIComponent(n.place._id)}">${esc(n.place.title)}</a>` : '';

    /* An .ics for one event, its times as they are (UTC, from Manila's). */
    function calendarFile(n) {
        const stamp = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        const text = value => String(value || '').replace(/([\\;,])/g, '\\$1').replace(/\n/g, '\\n');
        const where = n.place ? `${n.place.title}, Zamboanguita, Negros Oriental` : 'Zamboanguita, Negros Oriental';
        return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ZTIMS//Zamboanguita Tourism//EN', 'BEGIN:VEVENT',
            `UID:${text(n._id)}@ztims`, `DTSTAMP:${stamp(Date.now())}`,
            `DTSTART:${stamp(n.startsAt)}`, `DTEND:${stamp(n.endsAt)}`,
            `SUMMARY:${text(n.title)}`, `LOCATION:${text(where)}`, `DESCRIPTION:${text(n.body)}`,
            'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    }

    function downloadCalendar(n) {
        const url = URL.createObjectURL(new Blob([calendarFile(n)], { type: 'text/calendar' }));
        const link = Object.assign(document.createElement('a'), { href: url, download: `zamboanguita-event-${n._id}.ics` });
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /* The month as a grid (.an-cal in theme.css): each event a chip on every
       day it covers, `data-event` carrying its id. */
    function monthGrid(year, month, events) {
        const pad = n => String(n).padStart(2, '0');
        const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
        const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const today = dayKey(Date.now());
        const cells = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="an-cal__dow">${d}</div>`);
        for (let i = 0; i < first; i++) cells.push('<div class="an-cal__day an-cal__day--blank" aria-hidden="true"></div>');
        for (let d = 1; d <= days; d++) {
            const key = `${year}-${pad(month)}-${pad(d)}`;
            const on = events.filter(e => dayKey(e.startsAt) <= key && dayKey(e.endsAt) >= key);
            cells.push(`<div class="an-cal__day${on.length ? ' an-cal__day--busy' : ''}${key === today ? ' an-cal__day--today' : ''}">
                <span class="an-cal__num">${d}</span>
                <div class="an-cal__chips">${on.map(e => `<button type="button" class="an-cal__chip" data-event="${esc(e._id)}" title="${esc(e.title)}">${esc(e.title)}</button>`).join('')}</div>
            </div>`);
        }
        return cells.join('');
    }

    const monthTitle = (year, month) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(year, month - 1, 1));
    const thisMonth = () => { const [y, m] = dayKey(Date.now()).split('-').map(Number); return { year: y, month: m }; };

    async function get(apiBase, path) {
        const response = await fetch(apiBase + path);
        if (!response.ok) throw new Error('Not available right now.');
        return response.json();
    }

    window.ZTIMS_NOTICES = {
        LABEL, esc, date, shortDate, time, dayKey, when, pill, dateBlock, place,
        calendarFile, downloadCalendar, monthGrid, monthTitle, thisMonth, get
    };
})();
