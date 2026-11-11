/* Attraction visitor reporting: what the Support Staff's and the officer's
 * pages share (att-staff.js, att-officer.js). Built on acc-common.js
 * (window.ztimsAcc: api, esc, windows, downloads, dates), loaded first.
 *
 *   monthPill(state, version)   a month's state, worded as the pages say it
 *   dayInfo(state)              a day's state: label, tone, icon
 *   tilesHtml(f)                total, dates counted, confirmed zeros, closed
 *   breakdownHtml(f)            residence and sex, each with "not recorded"
 *   var1Html(daily)             the month by day, as VAR 1 lays it out
 *   historyHtml(events)         submitted, finalized, reopened, with reasons
 *   sourcePill(source)          which figures a consolidation used
 *
 * The figures always come from the server (attraction-engine.js), the same
 * numbers its Excel files use; nothing here adds anything up except a
 * day's own breakdown while it is typed. Hiding a button is never a control.
 */
(function () {
    const A = window.ztimsAcc;
    const { esc, nf } = A;

    const CLASSES = [
        ['zamboanguita', 'Zamboanguita', 'This municipality'],
        ['negrosOriental', 'Rest of Negros Oriental', 'This province, outside Zamboanguita'],
        ['otherProvince', 'Other Philippine provinces', 'Other provinces'],
        ['foreign', 'Foreign countries', 'Living outside the Philippines']
    ];

    /* A month's state (attraction-engine.js periodState). */
    const MONTH_STATES = {
        before: ['tone-neutral', 'remove', 'Before reporting'],
        future: ['tone-neutral', 'hourglass_empty', 'Not yet'],
        open: ['tone-info', 'pending', 'In progress'],
        incomplete: ['tone-danger', 'report', 'Dates missing'],
        ready: ['tone-warning', 'outbox', 'Ready to submit'],
        submitted: ['tone-success', 'check_circle', 'Submitted'],
        finalized: ['tone-neutral acc-pill--lock', 'lock', 'Finalized'],
        reopened: ['tone-warning', 'lock_open', 'Reopened'],
        nostaff: ['tone-neutral', 'person_off', 'No Support Staff']
    };
    function monthPill(state, version, extra) {
        const s = MONTH_STATES[state] || ['tone-neutral', 'help', state];
        let label = s[2];
        if ((state === 'submitted' || state === 'finalized') && version) label += ` · v${version}`;
        if (state === 'incomplete' && extra) label = `${extra} date${extra === 1 ? '' : 's'} missing`;
        return `<span class="tone-pill rounded-pill acc-pill ${s[0]}"><span class="material-symbols-outlined" aria-hidden="true">${s[1]}</span>${esc(label)}</span>`;
    }

    /* A day's state (attraction-engine.js dayState). Missing is never zero. */
    const DAY_STATES = {
        counted: ['att-day--counted', 'Counted'],
        zero: ['att-day--zero', 'No visitors (confirmed)'],
        closed: ['att-day--closed', 'Authorized closure'],
        missing: ['att-day--missing', 'Missing'],
        scheduled: ['att-day--scheduled', 'Usually closed: confirm a count or 0'],
        today: ['att-day--today', 'Today: not recorded yet'],
        future: ['att-day--future', 'Not yet'],
        before: ['att-day--before', 'Before reporting']
    };
    const dayInfo = state => DAY_STATES[state] || ['', state];

    const zeroOf = f => (f.zero != null ? f.zero : f.zeroDays);
    const closedOf = f => (f.closed != null ? f.closed : f.closedDays);

    function tilesHtml(f) {
        const missing = Array.isArray(f.missing) ? f.missing.length + (f.scheduled || []).length : null;
        const tile = (label, value, sub) => `<div class="stat-tile"><p>${esc(label)}</p><p>${value}</p>${sub ? `<p class="acc-sub">${sub}</p>` : ''}</div>`;
        return `<div class="stat-tiles">
            ${tile('Visits', nf(f.total), 'Visits to the attraction, not unique tourists')}
            ${tile('Dates counted', nf(f.dates), f.days ? `of ${f.days} days` : '')}
            ${tile('No visitors (confirmed 0)', nf(zeroOf(f)), 'Days recorded as 0')}
            ${missing == null ? tile('Authorized closures', nf(closedOf(f)), '') : tile('Missing dates', `<span class="${missing ? 'text-error' : ''}">${nf(missing)}</span>`, `${nf(closedOf(f))} authorized closure${closedOf(f) === 1 ? '' : 's'}`)}
        </div>`;
    }

    /* Residence and sex, each on its own: a visitor is never placed in both by estimate. */
    function breakdownHtml(f) {
        const res = f.residence || {};
        // No residence recorded at all: the classes are unknown, shown empty, never 0.
        const known = f.total === 0 || f.total - (f.residenceUnrecorded || 0) > 0;
        const v = n => (known ? nf(n || 0) : '');
        const rows = CLASSES.map(([k, label]) => `<tr><td>${esc(label)}</td><td class="text-right">${v(res[k])}</td></tr>`).join('');
        const sexKnown = (f.male || 0) + (f.female || 0);
        return `<div class="grid lg:grid-cols-2 gap-4">
            <div class="acc-scroll"><table class="ztims-table acc-table"><thead><tr><th>Where visitors live</th><th class="text-right">Visits</th></tr></thead><tbody>
                ${rows}
                <tr class="acc-sum"><td>Domestic (the first three)</td><td class="text-right">${v(f.domestic != null ? f.domestic : (res.zamboanguita || 0) + (res.negrosOriental || 0) + (res.otherProvince || 0))}</td></tr>
                <tr class="${f.residenceUnrecorded ? 'att-unrec' : ''}"><td>Residence not recorded</td><td class="text-right">${nf(f.residenceUnrecorded || 0)}</td></tr>
                <tr class="acc-grand"><td>Total visits</td><td class="text-right">${nf(f.total)}</td></tr></tbody></table></div>
            <div class="acc-scroll"><table class="ztims-table acc-table"><thead><tr><th>Sex</th><th class="text-right">Visits</th></tr></thead><tbody>
                <tr><td>Male</td><td class="text-right">${sexKnown || !f.sexUnrecorded ? nf(f.male || 0) : '–'}</td></tr>
                <tr><td>Female</td><td class="text-right">${sexKnown || !f.sexUnrecorded ? nf(f.female || 0) : '–'}</td></tr>
                <tr class="${f.sexUnrecorded ? 'att-unrec' : ''}"><td>Sex not recorded</td><td class="text-right">${nf(f.sexUnrecorded || 0)}</td></tr>
                <tr class="acc-grand"><td>Total visits</td><td class="text-right">${nf(f.total)}</td></tr></tbody></table></div>
        </div>
        <p class="acc-note mt-2">Residence and sex are recorded separately. The forms' male and female under each residence stay empty: they are never worked out from these totals.</p>`;
    }

    /* The month by day, in VAR 1's order: This Province (Zamboanguita + rest of Negros
       Oriental), Other Province, Foreign, Total; male and female as recorded. */
    function var1Html(daily) {
        const cell = v => (v == null ? '' : nf(v));
        const rows = daily.map(d => {
            const c = d.count, day = +d.date.slice(8, 10);
            if (!c) {
                const [, label] = dayInfo(d.state);
                const why = d.state === 'closed' && d.why ? `: ${d.why}` : '';
                return `<tr class="${d.state === 'missing' || d.state === 'scheduled' ? 'att-row--missing' : 'acc-fut'}"><th scope="row">${day}</th><td colspan="6">${esc(label + why)}</td></tr>`;
            }
            const r = c.residence || {};
            const thisProvince = r.zamboanguita == null && r.negrosOriental == null ? null : (r.zamboanguita || 0) + (r.negrosOriental || 0);
            const known = ['zamboanguita', 'negrosOriental', 'otherProvince', 'foreign'].reduce((a, k) => a + (r[k] || 0), 0);
            const sexKnown = (c.male || 0) + (c.female || 0);
            const notes = [];
            if (c.total > 0 && known < c.total) notes.push(`${nf(c.total - known)} residence not recorded`);
            if (c.total > 0 && sexKnown < c.total) notes.push(`${nf(c.total - sexKnown)} sex not recorded`);
            return `<tr><th scope="row">${day}</th><td class="text-right">${cell(c.total === 0 ? 0 : thisProvince)}</td><td class="text-right">${cell(c.total === 0 ? 0 : r.otherProvince)}</td>
                <td class="text-right">${cell(c.total === 0 ? 0 : r.foreign)}</td><td class="text-right"><b>${nf(c.total)}</b></td>
                <td class="text-right">${c.total > 0 && sexKnown ? nf(c.male || 0) : ''}</td><td class="text-right">${c.total > 0 && sexKnown ? nf(c.female || 0) : ''}</td></tr>
                ${notes.length ? `<tr class="att-row--note"><th></th><td colspan="6">${esc(notes.join(' · '))}</td></tr>` : ''}`;
        }).join('');
        return `<div class="acc-scroll"><table class="acc-grid att-var1"><thead><tr><th>Day</th><th>This Province</th><th>Other Province</th><th>Foreign</th><th>Total</th><th>Male</th><th>Female</th></tr></thead>
            <tbody>${rows}</tbody></table></div>`;
    }

    const ACTIONS = { submitted: 'Submitted', finalized: 'Finalized', reopened: 'Reopened' };
    const roleName = r => (r === 'admin' ? 'Tourism Office' : r === 'support_staff' ? 'Support Staff' : r || '');
    function historyHtml(events) {
        if (!events || !events.length) return '<p class="acc-note">Nothing submitted yet.</p>';
        return `<ol class="acc-history">${events.slice().reverse().map(e => `<li><b>${esc(ACTIONS[e.action] || e.action)}${e.version ? ` v${e.version}` : ''}</b>
            · ${esc(A.fmtWhen(e.at))} · ${esc(roleName(e.actorRole))}${e.actorEmail ? ` (${esc(e.actorEmail)})` : ''}${e.reason ? `<br><span class="text-on-surface-variant">Reason: ${esc(e.reason)}</span>` : ''}</li>`).join('')}</ol>`;
    }

    /* What a version changed against the one before (attraction-engine.js diffDaily). */
    function changesHtml(changes) {
        if (!changes || !changes.length) return '';
        const line = c => (c.change === 'added' ? `missing → <b>${nf(c.to)}</b>`
            : c.change === 'removed' ? `${nf(c.from)} → <b>missing</b>`
            : c.change === 'total' ? `${nf(c.from)} → <b>${nf(c.to)}</b>` : `${nf(c.to)}, breakdown changed`);
        return `<table class="acc-diff"><tbody>${changes.slice(0, 31).map(c => `<tr><td>${esc(A.fmtDate(c.date))}</td><td>${line(c)}</td></tr>`).join('')}</tbody></table>`;
    }

    /* Which figures a consolidation used for one attraction-month. */
    const SOURCES = {
        final: ['tone-neutral acc-pill--lock', 'lock', 'Finalized'],
        submitted: ['tone-success', 'check_circle', 'Submitted, not finalized'],
        reopened: ['tone-warning', 'lock_open', 'Reopened'],
        draft: ['tone-info', 'edit_note', 'Draft, not submitted'],
        none: ['tone-danger', 'report', 'Not submitted'],
        nostaff: ['tone-neutral', 'person_off', 'No Support Staff'],
        before: ['tone-neutral', 'remove', 'Before reporting'],
        future: ['tone-neutral', 'hourglass_empty', 'Not yet']
    };
    function sourcePill(src) {
        const s = SOURCES[src.kind] || ['tone-neutral', 'help', src.kind];
        let label = s[2];
        if (src.version && (src.kind === 'final' || src.kind === 'submitted' || src.kind === 'reopened')) label += ` · v${src.version}`;
        if (src.kind === 'final' && src.pending) label += ', correction pending';
        return `<span class="tone-pill rounded-pill acc-pill ${s[0]}"><span class="material-symbols-outlined" aria-hidden="true">${s[1]}</span>${esc(label)}</span>`;
    }

    /* A request key: a retried save sends the same one, so it is applied once. */
    const requestKey = () => {
        const b = new Uint8Array(12);
        (window.crypto || window.msCrypto).getRandomValues(b);
        return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    };

    window.ztimsAtt = { CLASSES, MONTH_STATES, monthPill, dayInfo, tilesHtml, breakdownHtml, var1Html, historyHtml, changesHtml, sourcePill, roleName, requestKey };
})();
