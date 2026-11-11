/* Monthly Report for a private place to stay: Month (DAE-1B) with Submit,
 * Versions, and Year (the annual summary). Mounted by resort_statistics.html
 * when the current enterprise is a place to stay
 * (window.ztimsAccReport.mount(el, spot)). Needs acc-common.js.
 * Figures always come from the server; a saved version never changes.
 */
(function () {
    const A = () => window.ztimsAcc;
    let root, spot, year, month, tab = 'month', view = null, yearData = null;

    function mount(el, current) {
        root = el; spot = current;
        const t = A().manilaToday();
        const q = new URLSearchParams(location.search).get('month');
        if (q && /^\d{4}-\d{2}$/.test(q)) { year = +q.slice(0, 4); month = +q.slice(5); }
        else { [year, month] = A().shiftMonth(+t.slice(0, 4), +t.slice(5, 7), -1); }
        tab = ['month', 'versions', 'year'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'month';
        root.innerHTML = `
            <div class="acc-head">
                <h1 class="text-3xl sm:text-4xl font-black font-headline tracking-tighter text-on-surface">Monthly Report</h1>
                <div class="acc-head__actions" data-actions></div>
            </div>
            <div role="tablist" aria-label="Monthly Report" class="flex gap-2 border-b border-outline-variant/30">
                <button role="tab" class="settings-tab" data-tab="month"><span class="material-symbols-outlined !text-base" aria-hidden="true">assignment</span>Month (DAE-1B)</button>
                <button role="tab" class="settings-tab" data-tab="versions"><span class="material-symbols-outlined !text-base" aria-hidden="true">history</span>Versions</button>
                <button role="tab" class="settings-tab" data-tab="year"><span class="material-symbols-outlined !text-base" aria-hidden="true">calendar_view_month</span>Year</button>
            </div>
            <div class="acc-bar" data-picker></div>
            <div class="acc-body space-y-5"></div>`;
        root.addEventListener('click', onClick);
        window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (['month', 'versions', 'year'].includes(h) && h !== tab) { tab = h; load(); } });
        A().loadResidences().then(load);
    }

    const picker = () => tab === 'year'
        ? `<div class="acc-month"><button type="button" class="acc-iconbtn" data-step="-12" aria-label="Previous year"><span class="material-symbols-outlined">chevron_left</span></button><span class="acc-month__name">${year}</span><button type="button" class="acc-iconbtn" data-step="12" aria-label="Next year"><span class="material-symbols-outlined">chevron_right</span></button></div>`
        : `<div class="acc-month"><button type="button" class="acc-iconbtn" data-step="-1" aria-label="Previous month"><span class="material-symbols-outlined">chevron_left</span></button><span class="acc-month__name" aria-live="polite">${A().monthName(year, month)}</span><button type="button" class="acc-iconbtn" data-step="1" aria-label="Next month"><span class="material-symbols-outlined">chevron_right</span></button></div><span data-state></span>`;

    async function load() {
        root.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
        root.querySelector('[data-picker]').innerHTML = picker();
        root.querySelector('[data-actions]').innerHTML = '';
        const body = root.querySelector('.acc-body');
        body.innerHTML = A().loading();
        try {
            if (tab === 'year') { yearData = await A().api(`/accommodation/${spot._id}/year/${year}`); return drawYear(); }
            view = await A().api(`/accommodation/${spot._id}/months/${year}/${month}`);
            root.querySelector('[data-state]').innerHTML = A().statePill(view.state.state, view.state.latestVersion);
            return tab === 'versions' ? drawVersions() : drawMonth();
        } catch (e) { if (e.message !== 'Signed out') body.innerHTML = A().failed(e.message, true); }
    }

    function diffTable(list) {
        if (!list || !list.length) return '';
        const label = d => d.field === 'counts' ? `${A().residenceName(d.residence)} (male, female)` : ({ arrivals: 'Guest arrivals', guestNights: 'Guest-nights', roomNightsOccupied: 'Rooms occupied (room-nights)', roomNightsAvailable: 'Rooms available (room-nights)', rooms: 'Number of rooms' })[d.field] || d.field;
        const v = x => (x && typeof x === 'object' ? `${x.male}, ${x.female}` : A().nf(x));
        return `<table class="acc-diff"><thead><tr><th class="text-left">Figure</th><th class="text-right">Submitted</th><th class="text-right">Register now</th></tr></thead><tbody>${list.map(d => `<tr><td>${A().esc(label(d))}</td><td class="text-right">${v(d.saved)}</td><td class="text-right"><b>${v(d.now)}</b></td></tr>`).join('')}</tbody></table>`;
    }

    function drawMonth() {
        const body = root.querySelector('.acc-body'), f = view.figures, s = view.state.state, latest = view.versions[view.versions.length - 1];
        const last = `${A().monthKey(year, month)}-${A().pad(A().daysIn(year, month))}`, from = A().addDays(last, 1);
        const due = new Date(view.state.deadline);
        const B = (kind, icon, html) => `<div class="acc-banner acc-banner--${kind}"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span><div>${html}</div></div>`;
        const banner = {
            open: B('info', 'pending', `<b>In progress.</b> Figures through ${A().fmtDate(f.through)}. Submit from ${A().fmtDate(from, true)}; due ${due.toLocaleDateString('en-PH', { day: 'numeric', month: 'short', timeZone: 'Asia/Manila' })}.`),
            due: B('warn', 'schedule', `<b>Ready to submit.</b> Due ${due.toLocaleDateString('en-PH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Manila' })}.`),
            overdue: B('bad', 'error', `<b>Overdue.</b> Late reports are accepted and marked late.`),
            submitted: latest && B('ok', 'check_circle', `<b>Version ${latest.version} submitted ${A().fmtWhen(latest.submittedAt)}${latest.late ? ' (late)' : ''}.</b> It matches the register.`),
            changed: B('warn', 'edit_note', `<b>The register changed after version ${view.state.latestVersion}.</b> The Tourism Office still sees version ${view.state.latestVersion}. Submit the correction; the earlier version is kept.${diffTable(view.state.differences)}`),
            finalized: B('lock', 'lock', `<b>Finalized by the Tourism Office ${A().fmtWhen(view.finalizedAt)}.</b> This month and its stays cannot change until the office reopens it.`),
            reopened: (() => { const e = view.events.filter(x => x.action === 'reopened').pop(); return B('warn', 'lock_open', `<b>Reopened by the Tourism Office ${e ? A().fmtWhen(e.at) : ''}.</b> ${e ? 'Reason: ' + A().esc(e.reason) + '. ' : ''}Correct the stays, then submit again.${diffTable(view.state.differences)}`); })(),
            not_recorded: B('bad', 'report', `<b>No report.</b> Reporting in ZTIMS starts ${view.profile.reportingFrom ? A().monthName(+view.profile.reportingFrom.slice(0, 4), +view.profile.reportingFrom.slice(5, 7)) : 'once it is set'}; no figures are filled in for earlier months.`),
            not_operating: B('info', 'block', `<b>Not operating.</b> Every day of the month is in a closed period; the month is N/A, not zero.`),
            not_set_up: B('info', 'settings', `<b>Set up reporting first:</b> the month reporting starts (Enterprise → Reporting) and the room numbers (Rooms → Room numbers).`),
            future: B('info', 'hourglass_empty', `<b>Not started.</b>`),
            municipal_total: B('info', 'inventory_2', `<b>Held as a municipal total</b> from the paper Form A4. Enterprises do not report this month.`)
        }[s] || '';
        const canSubmit = ['due', 'overdue', 'changed', 'reopened'].includes(s);
        const actions = root.querySelector('[data-actions]');
        actions.innerHTML = (canSubmit ? `<button type="button" class="btn btn-primary min-h-[44px]" data-act="submit"><span class="material-symbols-outlined !text-base" aria-hidden="true">send</span>${latest ? 'Submit correction as version ' + (latest.version + 1) : 'Submit ' + A().MONTHS[month - 1]}</button>` : '')
            + (s === 'open' ? `<button type="button" class="btn btn-primary min-h-[44px]" disabled><span class="material-symbols-outlined !text-base" aria-hidden="true">send</span>Submit from ${A().fmtDate(from)}</button>` : '')
            + (['open', 'due', 'overdue', 'submitted', 'changed', 'finalized', 'reopened'].includes(s) ? `<button type="button" class="btn btn-secondary min-h-[44px]" data-act="excel"><span class="material-symbols-outlined !text-base" aria-hidden="true">download</span>Excel</button>` : '');
        const showFigures = !['not_recorded', 'not_operating', 'not_set_up', 'future', 'municipal_total'].includes(s);
        body.innerHTML = banner + (showFigures ? `
            <div class="stat-tiles">
                <div class="stat-tile"><p>Guest arrivals</p><p>${A().nf(f.arrivals)}</p></div>
                <div class="stat-tile"><p>Guest-nights</p><p>${A().nf(f.guestNights)}</p></div>
                <div class="stat-tile"><p>Occupancy rate</p><p>${A().pct(f.occupancyRate)}</p></div>
                <div class="stat-tile"><p>Average length of stay</p><p>${A().dec(f.averageLengthOfStay)}</p></div>
            </div>
            <section class="glass-panel p-4 sm:p-5 space-y-3"><h2 class="acc-part">Part I. Guest arrivals by nationality / country of residence</h2>${A().partOneHtml(f.counts)}</section>
            <section class="glass-panel p-4 sm:p-5 space-y-3"><h2 class="acc-part">Part II. Other indicators</h2>${A().partTwoHtml(f)}
                <details class="text-sm"><summary class="cursor-pointer font-bold">How these are worked out</summary>
                <ul class="list-disc pl-5 mt-2 space-y-1 text-on-surface-variant"><li>Arrivals: each guest once, in the month they arrive.</li><li>Guest-nights: every night a guest sleeps here this month; the night of check-out is not counted.</li><li>Rooms occupied: rooms holding guests, night by night (room-nights).</li><li>Average length of stay: this month's guest-nights ÷ this month's arrivals. A stay across a month end is split, so it is not the average of whole stays.</li><li>Occupancy: room-nights occupied ÷ room-nights available (rooms out of service and closed days are not available).</li></ul></details></section>` : '');
    }

    function submit() {
        const latest = view.versions[view.versions.length - 1], f = view.figures, next = latest ? latest.version + 1 : 1;
        A().openWindow({
            title: latest ? `Submit correction · version ${next}` : `Submit ${A().monthName(year, month)}`,
            body: `<div class="stat-tiles"><div class="stat-tile"><p>Arrivals</p><p>${A().nf(f.arrivals)}</p></div><div class="stat-tile"><p>Guest-nights</p><p>${A().nf(f.guestNights)}</p></div><div class="stat-tile"><p>Room-nights</p><p>${A().nf(f.roomNightsOccupied)}</p></div></div>
                ${latest ? `<div><p class="field-label">Changes from version ${latest.version}</p>${diffTable(view.state.differences) || '<p class="text-support">The figures are the same; the correction records why the month was reopened.</p>'}</div>
                <label class="block"><span class="field-label">Reason for the correction</span><input id="subWhy" class="field" maxlength="300" required/></label>` : ''}
                <p class="text-support">Saved as version ${next}. ${latest ? `Version ${latest.version} is kept and never changes.` : 'Later changes to the register never alter it.'}</p>`,
            actions: [{ label: 'Cancel', kind: 'cancel' }, { label: latest ? `Submit version ${next}` : 'Submit report', kind: 'primary', run: async w => {
                const body = { expectedVersion: latest ? latest.version : 0 };
                if (latest) { body.reason = w.el.querySelector('#subWhy').value.trim(); if (body.reason.length < 3) throw new Error('Give the reason for the correction.'); }
                try { await A().api(`/accommodation/${spot._id}/months/${year}/${month}/submit`, { method: 'POST', body }); }
                catch (e) { if (e.code === 'STALE') { load(); } throw e; }
                A().toast(`${A().monthName(year, month)} submitted as version ${next}`);
                load();
            } }]
        });
    }

    function drawVersions() {
        const body = root.querySelector('.acc-body');
        const vs = view.versions.slice().reverse();
        const ev = view.events.slice().reverse();
        body.innerHTML = vs.length ? `
            <section class="glass-panel"><h2 class="acc-part px-5 pt-4 pb-3 border-b border-outline-variant/30">Saved versions</h2>
                <div class="acc-scroll"><table class="ztims-table acc-table"><thead><tr><th>Version</th><th>Submitted</th><th>Reason</th><th class="text-right">Arrivals</th><th class="text-right">Guest-nights</th><th class="text-right">Occupancy</th><th></th></tr></thead><tbody>
                ${vs.map((v, i) => `<tr><td><b>v${v.version}</b> ${i === 0 ? '<span class="tone-pill rounded-pill acc-pill tone-info">Latest</span>' : '<span class="tone-pill rounded-pill acc-pill tone-neutral">Replaced</span>'}${v.provenance === 'legacy_manual' ? ' <span class="tone-pill rounded-pill acc-pill tone-neutral">Typed by hand</span>' : ''}</td>
                    <td>${A().fmtWhen(v.submittedAt)}${v.late ? ' · late' : ''}</td><td>${v.reason ? A().esc(v.reason) : '<span class="text-on-surface-variant">First submission</span>'}</td>
                    <td class="text-right">${A().nf(v.figures.arrivals)}</td><td class="text-right">${A().nf(v.figures.guestNights)}</td><td class="text-right">${A().pct(v.figures.occupancyRate)}</td>
                    <td class="text-right whitespace-nowrap"><button type="button" class="btn btn-secondary btn-sm" data-view="${v.version}">View</button> <button type="button" class="btn btn-secondary btn-sm" data-xl="${v.version}">Excel</button></td></tr>`).join('')}</tbody></table></div></section>
            <section class="glass-panel"><h2 class="acc-part px-5 pt-4 pb-3 border-b border-outline-variant/30">History</h2>
                <ul class="acc-history p-5">${ev.map(e => `<li><span class="text-on-surface-variant">${A().fmtWhen(e.at)}</span> <b>${({ submitted: 'Submitted', finalized: 'Finalized', reopened: 'Reopened' })[e.action]}</b>${e.reason ? ' · ' + A().esc(e.reason) : ''} <span class="text-on-surface-variant">(${e.actorRole === 'admin' ? 'Tourism Office' : 'Enterprise'})</span></li>`).join('')}</ul></section>`
            : `<div class="ztims-empty">No version saved for ${A().monthName(year, month)}.</div>`;
    }

    function viewVersion(n) {
        const v = view.versions.find(x => x.version === n);
        A().openWindow({ title: `${A().monthName(year, month)} · version ${v.version}`, wide: true,
            body: `<div class="acc-banner acc-banner--lock"><span class="material-symbols-outlined" aria-hidden="true">lock</span><div>Saved ${A().fmtWhen(v.submittedAt)}. This is exactly what was submitted.</div></div>
                <section class="space-y-3"><h3 class="acc-part">Part I</h3>${A().partOneHtml(v.figures.counts)}</section>
                <section class="space-y-3"><h3 class="acc-part">Part II</h3>${A().partTwoHtml(v.figures)}</section>`,
            actions: [{ label: 'Close' }] });
    }

    function drawYear() {
        const body = root.querySelector('.acc-body'), y = yearData, t = y.totals;
        const cnt = list => y.months.filter(m => list.includes(m.state));
        const names = list => list.map(m => A().MONTHS[m.month - 1].slice(0, 3)).join(', ');
        const parts = [['Reported', cnt(['submitted', 'changed', 'finalized', 'reopened']), 'tone-success'], ['Not operating', cnt(['not_operating']), 'tone-neutral'],
            ['Not reported', cnt(['not_recorded', 'overdue', 'due']), 'tone-danger'], ['In progress', cnt(['open']), 'tone-info'], ['Not yet', cnt(['future']), 'tone-neutral']].filter(p => p[1].length);
        const cell = (m, fn) => m.latestVersion ? `<td class="text-right">${fn(m.latestVersion.figures)}${m.state === 'changed' ? '<sup title="The register changed since this version">*</sup>' : ''}</td>` : `<td class="text-right text-on-surface-variant">${m.state === 'not_operating' ? 'N/A' : '–'}</td>`;
        const line = (label, fn, total, cls = '') => `<tr class="${cls}"><td class="acc-sticky">${label}</td>${y.months.map(m => cell(m, fn)).join('')}<td class="text-right"><b>${total}</b></td></tr>`;
        const sexSum = (f, sec) => Object.entries(f.counts).filter(([c]) => A().residenceSection(c) === sec).reduce((a, [, c]) => a + c.male + c.female, 0);
        root.querySelector('[data-actions]').innerHTML = `<button type="button" class="btn btn-secondary min-h-[44px]" data-act="excelYear"><span class="material-symbols-outlined !text-base" aria-hidden="true">download</span>Excel</button>`;
        body.innerHTML = `
            ${y.complete ? '' : `<div class="acc-banner acc-banner--warn"><span class="material-symbols-outlined" aria-hidden="true">event_busy</span><div><b>${year} is incomplete.</b> The totals add up the ${t.months} reported month${t.months === 1 ? '' : 's'} only.<div class="flex flex-wrap gap-2 mt-2">${parts.map(p => `<span class="tone-pill rounded-pill acc-pill ${p[2]}">${p[0]}: ${names(p[1])}</span>`).join('')}</div></div></div>`}
            <section class="glass-panel p-4 sm:p-5"><div class="acc-scroll"><table class="acc-grid"><thead><tr><th class="acc-sticky">${year}</th>${y.months.map(m => `<th>${A().MONTHS[m.month - 1].slice(0, 3)}</th>`).join('')}<th>Total</th></tr></thead><tbody>
                ${line('Philippine residents', f => sexSum(f, 'philippine'), A().nf(sexSumT('philippine')))}
                ${line('Non-Philippine residents', f => sexSum(f, 'foreign'), A().nf(sexSumT('foreign')))}
                ${line('Overseas Filipinos', f => sexSum(f, 'overseas_filipino'), A().nf(sexSumT('overseas_filipino')))}
                ${line('Unspecified residence', f => sexSum(f, 'unspecified'), A().nf(sexSumT('unspecified')))}
                ${line('<b>Guest arrivals</b>', f => A().nf(f.arrivals), A().nf(t.arrivals))}
                ${line('Rooms occupied (room-nights)', f => A().nf(f.roomNightsOccupied), A().nf(t.roomNightsOccupied))}
                ${line('Rooms available (room-nights)', f => A().nf(f.roomNightsAvailable), A().nf(t.roomNightsAvailable))}
                ${line('Guest-nights', f => A().nf(f.guestNights), A().nf(t.guestNights))}
                ${line('Occupancy rate', f => A().pct(f.occupancyRate), A().pct(t.occupancyRate))}
                ${line('Average length of stay', f => A().dec(f.averageLengthOfStay), A().dec(t.averageLengthOfStay))}</tbody></table></div>
            <p class="acc-note mt-3">From each month's latest submitted version. Yearly rates use the year's totals, not an average of monthly rates. – no report; N/A not operating; * the register changed since that version.</p></section>`;
        function sexSumT(sec) { return y.months.filter(m => m.latestVersion).reduce((a, m) => a + sexSum(m.latestVersion.figures, sec), 0); }
    }

    async function onClick(e) {
        const t = e.target.closest('[data-tab],[data-step],[data-act],[data-view],[data-xl],[data-acc-retry]');
        if (!t || !root.contains(t)) return;
        if (t.dataset.accRetry !== undefined) return load();
        if (t.dataset.tab) { tab = t.dataset.tab; history.replaceState(null, '', '#' + tab); return load(); }
        if (t.dataset.step) { const d = +t.dataset.step; if (Math.abs(d) === 12) year += d / 12; else [year, month] = A().shiftMonth(year, month, d); return load(); }
        if (t.dataset.view) return viewVersion(+t.dataset.view);
        const dl = async (path, name) => { try { await A().download(path, name); A().toast('Excel downloaded'); } catch (err) { A().toast(err.message, 'error'); } };
        if (t.dataset.xl) return dl(`/accommodation/${spot._id}/months/${year}/${month}/export.xlsx?version=${t.dataset.xl}`, 'report.xlsx');
        if (t.dataset.act === 'submit') return submit();
        if (t.dataset.act === 'excel') return dl(`/accommodation/${spot._id}/months/${year}/${month}/export.xlsx?version=${view.versions.length && view.state.state !== 'changed' && view.state.state !== 'reopened' ? 'latest' : 'current'}`, 'report.xlsx');
        if (t.dataset.act === 'excelYear') return dl(`/accommodation/${spot._id}/year/${year}/export.xlsx`, 'annual.xlsx');
    }

    window.ztimsAccReport = { mount };
})();
