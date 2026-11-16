/* The Tourism Officer's side of accommodation reporting, in Statistics:
 *   tracker(el, year)            private places to stay × months, by state
 *   month(el, place, year, month) one enterprise's month: the submitted
 *                                version, Finalize / Reopen, versions, history
 *   formA(el)                    the municipal FORM A, with its coverage
 * Needs acc-common.js. The officer reads and finalizes; never edits stays.
 */
(function () {
    const A = () => window.ztimsAcc;
    const monthLoads = new WeakMap();
    const trackerViews = new WeakMap();
    const STATUS = {
        submitted: ['tone-info', 'Awaiting review', 'Submitted to the Tourism Office'],
        changed: ['tone-warning', 'Needs resubmission', 'Register changed after submission'],
        finalized: ['tone-success', 'Finalized', 'Monthly submission locked'],
        reopened: ['tone-warning', 'Open for correction', 'Waiting for a corrected submission'],
        open: ['tone-neutral', 'In progress', 'Month is still in progress'],
        due: ['tone-neutral', 'Not submitted', 'Submission is due by the 5th of the following month'],
        overdue: ['tone-danger', 'Overdue', 'Submission deadline has passed'],
        not_recorded: ['tone-neutral', 'No report recorded', 'Before reporting started'],
        not_operating: ['tone-neutral', 'Not operating', 'Closed throughout this month'],
        not_set_up: ['tone-neutral', 'Not set up', 'Reporting has not been set up'],
        future: ['tone-neutral', 'Not started', 'Month has not started']
    };
    const statusPill = state => {
        const [tone, label] = STATUS[state] || ['tone-neutral', state];
        const icon = state === 'finalized' ? '<span class="material-symbols-outlined" aria-hidden="true">lock</span>' : '';
        return `<span class="tone-pill rounded-pill acc-pill ${tone}${state === 'submitted' ? ' acc-status-review' : ''}">${icon}${A().esc(label)}</span>`;
    };

    /* Directory → enterprise/year → month → submitted forms. */
    async function tracker(el, year) {
        const previous = trackerViews.get(el) || {};
        const state = { selected: previous.selected || '', month: previous.year === year ? previous.month : null, year, query: previous.query || '' };
        trackerViews.set(el, state);
        el.innerHTML = A().loading('Loading enterprise reports…');
        let data;
        try { data = await A().api(`/accommodation/tracker?year=${year}`); }
        catch (e) { if (trackerViews.get(el) === state && e.message !== 'Signed out') { el.innerHTML = A().failed(e.message, true); el.querySelector('[data-acc-retry]').addEventListener('click',()=>tracker(el,year),{once:true}); } return; }
        if (trackerViews.get(el) !== state) return;
        const enterprises = data.enterprises;
        if (!enterprises.some(e => e._id === state.selected)) state.selected = '';
        const refresh = () => tracker(el, year);
        const summary = e => {
            const submitted = e.months.filter(m => m.latestVersion > 0).length;
            const review = e.months.filter(m => m.state === 'submitted').length;
            const overdue = e.months.filter(m => m.state === 'overdue').length;
            return `${submitted} of 12 months submitted${review ? ` · ${review} awaiting review` : ''}${overdue ? ` · ${overdue} overdue` : ''}`;
        };
        function draw() {
            const enterprise = enterprises.find(e => e._id === state.selected);
            const currentYear = +A().manilaToday().slice(0,4);
            el.innerHTML = `<div class="acc-directory space-y-5">
                <div class="acc-head"><div class="acc-flow-title">${enterprise ? '<button type="button" class="btn btn-secondary btn-sm" data-directory>← All enterprises</button>' : ''}<h2 class="acc-part">${enterprise ? A().esc(enterprise.name) : 'Accommodation enterprises'}</h2></div>
                <div class="acc-head__actions"><label><span class="field-label">Reporting year</span><select class="field" data-report-year aria-label="Reporting year">${Array.from({length: Math.max(currentYear,year)-2024},(_,i)=>Math.max(currentYear,year)-i).map(y=>`<option${y===year?' selected':''}>${y}</option>`).join('')}</select></label><button type="button" class="btn btn-primary" data-package>Download submission package</button><button type="button" class="btn btn-secondary" data-annual>Annual municipal report · Form A</button></div></div>
                ${A().statusLegend(Object.entries(STATUS).map(([key, value]) => [statusPill(key), value[2]]))}
                ${enterprise ? `<section aria-label="Reporting months"><h3 class="acc-part mb-3">Select a month</h3><div class="acc-month-cards">${enterprise.months.map(m=>{
                    const [tone,label,note] = STATUS[m.state] || ['tone-neutral',m.state,''];
                    const [dueYear,dueMonth] = A().shiftMonth(year,m.month,1);
                    const detail = ['due','overdue'].includes(m.state) ? `Due 5 ${A().MONTHS[dueMonth-1].slice(0,3)} ${dueYear}` : note;
                    return `<button type="button" class="acc-month-card" data-report-month="${m.month}" data-spot="${A().esc(enterprise._id)}" aria-pressed="${state.month===m.month}"${m.state==='future'?' disabled':''}><b>${A().MONTHS[m.month-1]}</b>${statusPill(m.state)}<span class="acc-note">${A().esc(detail)}${m.latestVersion ? ` · v${m.latestVersion}` : ''}</span></button>`;
                }).join('')}</div></section><section data-month-report aria-label="Selected monthly submission" class="space-y-4">${A().loading()}</section>` : `
                <label class="block"><span class="field-label">Find an enterprise</span><input type="search" class="field" data-enterprise-search placeholder="Search enterprise names" value="${A().esc(state.query)}"></label>
                <div data-enterprise-list class="acc-enterprise-list"></div>`}
                </div>`;
            el.querySelector('[data-report-year]').addEventListener('change', e => {
                const outer = document.getElementById('trYear');
                if (outer) { outer.value=e.target.value; outer.dispatchEvent(new Event('change')); }
                else tracker(el,+e.target.value);
            });
            el.querySelector('[data-package]').onclick=()=>{const [y,m]=A().shiftMonth(+A().manilaToday().slice(0,4),+A().manilaToday().slice(5,7),-1);A().packagePreview('Accommodation',year,state.month || (y===year?m:1));};
            el.querySelector('[data-annual]').addEventListener('click', () => {
                el.innerHTML='<button type="button" class="btn btn-secondary mb-4" data-return>← Back to enterprise reports</button><div data-annual-report></div>';
                el.querySelector('[data-return]').addEventListener('click',draw);
                formA(el.querySelector('[data-annual-report]'),{year});
            });
            if (!enterprise) {
                const list=el.querySelector('[data-enterprise-list]');
                function filter() {
                    const matched=enterprises.filter(e=>e.name.toLocaleLowerCase().includes(state.query.toLocaleLowerCase()));
                    list.innerHTML=matched.length ? matched.map(e=>`<button type="button" class="acc-enterprise-row" data-enterprise="${A().esc(e._id)}"><span><b>${A().esc(e.name)}</b><span class="acc-note">${summary(e)}</span></span><span aria-hidden="true">→</span></button>`).join('') : '<div class="ztims-empty">No matching enterprises.</div>';
                    list.querySelectorAll('[data-enterprise]').forEach(b=>b.addEventListener('click',()=>{state.selected=b.dataset.enterprise;state.month=null;draw();}));
                }
                el.querySelector('[data-enterprise-search]').addEventListener('input',e=>{state.query=e.target.value;filter();});
                filter();
            } else {
                el.querySelector('[data-directory]').addEventListener('click',()=>{state.selected='';state.month=null;draw();});
                const report=el.querySelector('[data-month-report]');
                const open = () => {
                    if (!state.month) { report.innerHTML='<div class="ztims-empty">Select a month to view its submitted DAE-1A and DAE-1B.</div>'; return; }
                    return month(report,enterprise,year,state.month,{onStateChange:refresh});
                };
                el.querySelectorAll('[data-report-month]').forEach(b=>b.addEventListener('click',async()=>{
                    state.month=+b.dataset.reportMonth;
                    const selectedMonth=state.month;
                    el.querySelectorAll('[data-report-month]').forEach(x=>x.setAttribute('aria-pressed',String(+x.dataset.reportMonth===state.month)));
                    await open();
                    if (report.isConnected && state.month===selectedMonth) report.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
                }));
                open();
            }
        }
        draw();
    }

    /* ---- one enterprise's month ------------------------------------------ */
    async function month(el, place, year, mon, options = {}) {
        const request = {};
        monthLoads.set(el, request);
        el.innerHTML = A().loading();
        await A().loadResidences();
        let v;
        try { v = await A().api(`/accommodation/${place._id}/months/${year}/${mon}`); }
        catch (e) { if (monthLoads.get(el) === request && e.message !== 'Signed out') el.innerHTML = A().failed(e.message); return; }
        if (monthLoads.get(el) !== request) return;
        const s = v.state.state, latest = v.versions[v.versions.length - 1];
        let submitted = null;
        if (latest) {
            try { submitted = (await A().api(`/accommodation/versions/${latest._id}`)).version; }
            catch (e) { if (monthLoads.get(el) === request && e.message !== 'Signed out') el.innerHTML = A().failed(e.message); return; }
            if (monthLoads.get(el) !== request) return;
        }
        const B = (kind, icon, html) => `<div class="acc-banner acc-banner--${kind}"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span><div>${html}</div></div>`;
        const reopen = v.events.filter(x => x.action === 'reopened').pop();
        const banner = {
            submitted: latest && B('ok', 'check_circle', `<b>Version ${latest.version} submitted ${A().fmtWhen(latest.submittedAt)}${latest.late ? ' (late)' : ''}.</b> Ready to finalize.`),
            changed: B('warn', 'edit_note', `<b>The enterprise changed its register after version ${v.state.latestVersion}.</b> It must submit the correction before this month can be finalized.`),
            finalized: B('lock', 'lock', `<b>Finalized ${A().fmtWhen(v.finalizedAt)}.</b> The enterprise cannot change this month or its stays.`),
            reopened: B('warn', 'lock_open', `<b>Reopened ${reopen ? A().fmtWhen(reopen.at) : ''}.</b> ${reopen ? 'Reason: ' + A().esc(reopen.reason) + '. ' : ''}Waiting for the enterprise to submit again.`),
            open: B('info', 'pending', '<b>The month is in progress.</b>'),
            due: B('warn', 'schedule', '<b>Not submitted yet.</b> Due on the 5th.'),
            overdue: B('bad', 'error', '<b>Overdue.</b> Nothing is filled in for a missing report.'),
            not_recorded: B('bad', 'report', '<b>No report.</b> Before this enterprise started reporting in ZTIMS.'),
            not_operating: B('info', 'block', '<b>Not operating.</b> Closed every day of the month; N/A, not zero.'),
            not_set_up: B('info', 'settings', '<b>Not set up.</b> The enterprise has not set when its reporting starts.'),
            future: B('info', 'hourglass_empty', '<b>Not started.</b>')
        }[s] || '';
        const f = latest ? latest.figures : null;
        const actions = [];
        if (s === 'submitted') actions.push(`<button type="button" class="btn btn-primary min-h-[44px]" data-act="finalize"><span class="material-symbols-outlined !text-base" aria-hidden="true">lock</span>Finalize submission</button>`);
        if (s === 'finalized') actions.push(`<button type="button" class="btn btn-secondary min-h-[44px]" data-act="reopen"><span class="material-symbols-outlined !text-base" aria-hidden="true">lock_open</span>Reopen for correction</button>`);
        if (latest) actions.push(`<button type="button" class="btn btn-secondary min-h-[44px]" data-xl="${latest.version}"><span class="material-symbols-outlined !text-base" aria-hidden="true">download</span>Excel</button>`);
        el.innerHTML = `<div class="space-y-5">
            <div class="acc-head"><div class="flex flex-wrap items-center gap-2"><h2 class="text-xl font-headline font-bold text-on-surface">${A().esc(v.enterprise.name)} · ${A().monthName(year, mon)}</h2>${statusPill(s)}</div>
                <div class="acc-head__actions">${actions.join('')}</div></div>
            ${banner}
            ${f ? `<p class="text-support">Showing version ${latest.version}, as submitted${latest.provenance === 'legacy_manual' ? ' (typed by hand before the stay register)' : ''}.</p>
                <div data-submitted-forms class="space-y-4"></div>` : '<div class="acc-empty-forms"><div class="acc-tabs"><button type="button" class="settings-tab" disabled>DAE-1A</button><button type="button" class="settings-tab" disabled>DAE-1B</button></div><p class="ztims-empty">No submitted forms for this month.</p></div>'}
            ${v.versions.length ? `<details class="space-y-2"><summary class="acc-part">Previous submissions</summary><div class="acc-scroll"><table class="ztims-table acc-table"><thead><tr><th>Version</th><th>Submitted</th><th>Reason</th><th class="text-right">Arrivals</th><th class="text-right">Guest-nights</th><th></th></tr></thead><tbody>
                ${v.versions.slice().reverse().map(x => `<tr><td><b>v${x.version}</b></td><td>${A().fmtWhen(x.submittedAt)}${x.late ? ' · late' : ''}</td><td>${x.reason ? A().esc(x.reason) : '<span class="text-on-surface-variant">First submission</span>'}</td><td class="text-right">${A().nf(x.figures.arrivals)}</td><td class="text-right">${A().nf(x.figures.guestNights)}</td><td class="text-right"><button type="button" class="btn btn-secondary btn-sm" data-xl="${x.version}">Excel</button></td></tr>`).join('')}</tbody></table></div></details>` : ''}
            ${v.events.length ? `<details class="space-y-2"><summary class="acc-part">Submission history</summary><ul class="acc-history">${v.events.slice().reverse().map(e => `<li><span class="text-on-surface-variant">${A().fmtWhen(e.at)}</span> <b>${({ submitted: 'Submitted', finalized: 'Finalized', reopened: 'Reopened' })[e.action]}</b>${e.reason ? ' · ' + A().esc(e.reason) : ''} <span class="text-on-surface-variant">(${e.actorRole === 'admin' ? 'Tourism Office' : 'Enterprise'})</span></li>`).join('')}</ul></details>` : ''}
        </div>`;
        if (submitted) A().mountForms(el.querySelector('[data-submitted-forms]'), {
            year, month: mon, enterprise: v.enterprise, profile: v.profile, figures: submitted.figures, detail: submitted.detail, rows: submitted.dae1b
        });
        el.querySelectorAll('[data-xl]').forEach(button => {
            const version = v.versions.find(x => x.version === +button.dataset.xl);
            const open = document.createElement('button'); open.type = 'button'; open.className = 'btn btn-secondary btn-sm'; open.textContent = 'View forms';
            button.before(open);
            open.addEventListener('click', async () => {
                try {
                    const saved = (await A().api(`/accommodation/versions/${version._id}`)).version;
                    A().openWindow({ title: `${A().monthName(year, mon)} · version ${version.version}`, wide: true,
                        body: '<div data-saved-forms class="space-y-4"></div>', actions: [{ label: 'Close' }],
                        onOpen: w => A().mountForms(w.body.querySelector('[data-saved-forms]'), { year, month: mon, enterprise: v.enterprise, profile: v.profile, figures: saved.figures, detail: saved.detail, rows: saved.dae1b }) });
                } catch (e) { if (e.message !== 'Signed out') A().toast(e.message, 'error'); }
            });
        });
        const again = () => options.onStateChange ? options.onStateChange() : month(el, place, year, mon);
        el.querySelectorAll('[data-xl]').forEach(b => b.addEventListener('click', async () => {
            try { await A().download(`/accommodation/${place._id}/months/${year}/${mon}/export.xlsx?version=${b.dataset.xl}`, 'report.xlsx'); A().toast('Excel downloaded'); }
            catch (e) { A().toast(e.message, 'error'); }
        }));
        const fin = el.querySelector('[data-act="finalize"]');
        if (fin) fin.addEventListener('click', () => A().openWindow({
            title: `Finalize ${A().monthName(year, mon)}?`,
            body: `<p>Version ${latest.version} becomes the figures sent to the Province. The enterprise cannot change this month or its stays until you reopen it.</p>`,
            actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Finalize', kind: 'primary', run: async () => {
                try { await A().api(`/accommodation/${place._id}/months/${year}/${mon}/finalize`, { method: 'POST', body: { expectedVersion: latest.version } }); }
                catch (e) { if (e.code === 'STALE' || e.code === 'REGISTER_CHANGED') again(); throw e; }
                A().toast(`${A().monthName(year, mon)} finalized`); again();
            } }]
        }));
        const re = el.querySelector('[data-act="reopen"]');
        if (re) re.addEventListener('click', () => A().openWindow({
            title: `Reopen ${A().monthName(year, mon)}?`,
            body: `<p>The enterprise can then correct its stays and submit a new version. Version ${latest.version} is kept.</p>
                <label class="block"><span class="field-label">Reason (the enterprise sees it)</span><textarea id="reWhy" class="field" rows="3" maxlength="300" minlength="10"></textarea></label>`,
            actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Reopen', kind: 'danger', run: async w => {
                const reason = w.el.querySelector('#reWhy').value.trim();
                if (reason.length < 10) throw new Error('Give a reason of at least 10 characters.');
                await A().api(`/accommodation/${place._id}/months/${year}/${mon}/reopen`, { method: 'POST', body: { reason } });
                A().toast(`${A().monthName(year, mon)} reopened`); again();
            } }]
        }));
    }

    /* ---- FORM A ----------------------------------------------------------- */
    function formA(el, options = {}) {
        const thisYear = +A().manilaToday().slice(0, 4);
        let year = options.year || thisYear, onlyUsed = true, d = null, requestId = 0;
        el.innerHTML = `<div class="glass-panel p-4 flex flex-wrap items-end gap-3">
                <label class="block"><span class="field-label">Year</span><select data-year class="field w-32">${Array.from({ length: thisYear - 2024 }, (_, i) => thisYear - i).map(y => `<option>${y}</option>`).join('')}</select></label>
                <button type="button" class="btn btn-secondary min-h-[44px]" data-x="excel"><span class="material-symbols-outlined !text-base" aria-hidden="true">download</span>Download Excel</button>
                <label class="inline-flex items-center gap-2 text-sm font-semibold min-h-[44px] cursor-pointer ml-auto"><input data-only type="checkbox" class="accent-primary w-4 h-4" checked> Only countries with arrivals</label>
            </div><div data-body class="space-y-4"></div>`;
        const body = el.querySelector('[data-body]');
        el.querySelector('[data-year]').value = String(year);
        async function load() {
            const request = ++requestId;
            body.innerHTML = A().loading('Adding up the saved versions…');
            try { const data = await A().api(`/accommodation/form-a?year=${year}`); if (request !== requestId) return; d = data; draw(); }
            catch (e) { if (request === requestId && e.message !== 'Signed out') body.innerHTML = A().failed(e.message, true); }
        }
        function coverage(m) {
            if (m.source === 'none') {
                if (!m.expected || `${year}-${A().pad(m.month)}-01` > A().manilaToday()) return ['tone-neutral', '–'];
                if (m.beforeReporting + m.notOperating >= m.expected) return ['tone-neutral', 'Before reporting'];
                return ['tone-danger', 'No reports'];
            }
            if (m.complete) return ['tone-success', `Complete ${m.reported}/${m.expected - m.notOperating}`];
            return ['tone-warning', `${m.reported} of ${m.expected - m.notOperating}, ${m.missing} missing`];
        }
        function draw() {
            const has = d.months.map(m => m.source === 'enterprise_reports' && m.reported > 0);
            const cell = n => (n == null ? '<td class="text-right text-on-surface-variant">–</td>' : `<td class="text-right">${A().nf(n)}</td>`);
            const cmp = d.comparison.comparableMonths.length;
            const sections = [['philippine', 'Philippine residents'], ['foreign', 'Non-Philippine residents'], ['overseas_filipino', 'Overseas Filipinos'], ['unspecified', 'Unspecified residence']];
            const sum = rows => d.months.map((_, i) => (has[i] ? rows.reduce((a, r) => a + (r.months[i] || 0), 0) : null));
            let part1 = '';
            for (const [sec, label] of sections) {
                const rows = d.rows.filter(r => r.section === sec);
                part1 += `<tr class="acc-group"><th colspan="${15 + (cmp ? 2 : 0)}" class="text-left">${label}</th></tr>`;
                for (const r of rows.filter(r => !onlyUsed || r.total > 0)) {
                    part1 += `<tr><td class="acc-sticky pl-5">${A().esc(r.name)}</td>${r.months.map(cell).join('')}<td class="text-right"><b>${A().nf(r.total)}</b></td><td class="text-right">${A().pct(r.share)}</td>${cmp ? `<td class="text-right">${A().nf(r.comparison.previous)}</td><td class="text-right">${A().pct(r.comparison.percentDifference)}</td>` : ''}</tr>`;
                }
                const s = sum(rows), t = rows.reduce((a, r) => a + r.total, 0);
                part1 += `<tr class="acc-subtotal"><td class="acc-sticky">Total ${label.toLowerCase()}</td>${s.map(cell).join('')}<td class="text-right"><b>${A().nf(t)}</b></td><td class="text-right">${d.grandTotal ? A().pct(t / d.grandTotal) : 'n/a'}</td>${cmp ? '<td></td><td></td>' : ''}</tr>`;
            }
            const all = sum(d.rows);
            part1 += `<tr class="acc-total"><td class="acc-sticky">Grand total guest arrivals</td>${all.map(cell).join('')}<td class="text-right"><b>${A().nf(d.grandTotal)}</b></td><td></td>${cmp ? '<td></td><td></td>' : ''}</tr>`;
            const p2 = d.partII, pm = p2.months;
            const line = (label, fn, total) => `<tr><td class="acc-sticky">${label}</td>${pm.map(m => (m ? `<td class="text-right">${fn(m)}</td>` : '<td class="text-right text-on-surface-variant">–</td>')).join('')}<td class="text-right"><b>${total}</b></td></tr>`;
            const vol = d.volumePerSex;
            body.innerHTML = `
                <div><h3 class="acc-part">Form A · Zamboanguita · ${year}</h3><p class="acc-note">All 12 months of the year. Municipal totals combine the latest saved submissions of all accommodation enterprises; months without reports stay blank.</p></div>
                <section class="glass-panel p-4 space-y-2"><h3 class="acc-part">Coverage</h3>
                    <div class="acc-coverage">${d.months.map(m => { const [tone, text] = coverage(m); return `<div><span class="acc-coverage__m">${A().MONTHS[m.month - 1].slice(0, 3)}</span><span class="tone-pill rounded-pill acc-pill ${tone}">${A().esc(text)}</span></div>`; }).join('')}</div>
                    <p class="acc-note">${cmp ? `Compared with ${d.comparison.previousYear} over ${d.comparison.comparableMonths.map(n => A().MONTHS[n - 1].slice(0, 3)).join(', ')} only: the months complete in both years.` : `No comparison with ${d.comparison.previousYear}: ${A().esc(d.comparison.unavailableReason || '')}`} Missing reports are left blank, never counted as zero.</p></section>
                <div class="stat-tiles"><div class="stat-tile"><p>Guest arrivals</p><p>${A().nf(d.grandTotal)}</p></div><div class="stat-tile"><p>Guest-nights</p><p>${A().nf(p2.total.guestNights)}</p></div>
                    <div class="stat-tile"><p>Occupancy rate</p><p>${A().pct(p2.total.occupancyRate)}</p></div><div class="stat-tile"><p>Average length of stay</p><p>${A().dec(p2.total.averageLengthOfStay)}</p></div></div>
                <section class="glass-panel p-4 space-y-3"><h3 class="acc-part">Part I. Guest arrivals by nationality / country of residence</h3>
                    <div class="acc-scroll"><table class="acc-grid acc-grid--wide"><thead><tr><th class="acc-sticky">Country of residence</th>${A().MONTHS.map(m => `<th>${m.slice(0, 3)}</th>`).join('')}<th>Total</th><th>% share</th>${cmp ? `<th>${d.comparison.previousYear}*</th><th>% difference*</th>` : ''}</tr></thead><tbody>${part1}</tbody></table></div></section>
                <section class="glass-panel p-4 space-y-3"><h3 class="acc-part">Part II. Other indicators</h3>
                    <div class="acc-scroll"><table class="acc-grid acc-grid--wide"><thead><tr><th class="acc-sticky">${year}</th>${A().MONTHS.map(m => `<th>${m.slice(0, 3)}</th>`).join('')}<th>Total</th></tr></thead><tbody>
                    ${line('Rooms occupied (room-nights)', m => A().nf(m.roomNightsOccupied), A().nf(p2.total.roomNightsOccupied))}
                    ${line('Rooms available (room-nights)', m => A().nf(m.roomNightsAvailable), A().nf(p2.total.roomNightsAvailable))}
                    ${line('Guest-nights', m => A().nf(m.guestNights), A().nf(p2.total.guestNights))}
                    ${line('Occupancy rate', m => A().pct(m.occupancyRate), A().pct(p2.total.occupancyRate))}
                    ${line('Average length of stay', m => A().dec(m.averageLengthOfStay), A().dec(p2.total.averageLengthOfStay))}</tbody></table></div>
                    <p class="acc-note">Yearly rates use the year's totals.</p></section>
                <section class="glass-panel p-4 space-y-3"><h3 class="acc-part">Volume per sex</h3>
                    ${vol.months.length ? `<div class="acc-scroll"><table class="ztims-table acc-table"><thead><tr><th></th><th class="text-right">Male</th><th class="text-right">Female</th></tr></thead><tbody>
                        ${sections.map(([k, l]) => `<tr><td>${l}</td><td class="text-right">${A().nf(vol[k].male)}</td><td class="text-right">${A().nf(vol[k].female)}</td></tr>`).join('')}</tbody></table></div>` : ''}
                    <p class="acc-note">${vol.notRecordedMonths.length ? `Not recorded for ${vol.notRecordedMonths.map(n => A().MONTHS[n - 1].slice(0, 3)).join(', ')} (no male and female recorded).` : 'From every reported month.'}</p></section>`;
        }
        el.querySelector('[data-year]').addEventListener('change', e => { year = +e.target.value; load(); });
        el.querySelector('[data-only]').addEventListener('change', e => { onlyUsed = e.target.checked; if (d) draw(); });
        el.querySelector('[data-x="excel"]').addEventListener('click', async () => {
            try { await A().download(`/accommodation/form-a.xlsx?year=${year}`, `FORM_A_${year}.xlsx`); A().toast('Excel downloaded'); }
            catch (e) { A().toast(e.message, 'error'); }
        });
        body.addEventListener('click', e => { if (e.target.closest('[data-acc-retry]')) load(); });
        A().loadResidences().then(load);
    }

    (function ready() {
        if (!window.ztimsAcc || !window.ztimsAcc.mountForms) return setTimeout(ready, 20);
        window.ztimsAccOfficer = { tracker, month, formA };
    })();
})();
