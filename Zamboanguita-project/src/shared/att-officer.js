/* The Tourism Officer's attraction visit reports, in Statistics → Attraction
 * visits (admin_statistics.html). API: zamboanguita-backend/attraction-visits.js.
 * Needs acc-common.js and att-common.js.
 *
 *   ztimsAttOfficer.mount(el)   Tracker · Monthly (DTA2M) · Annual (VAR 3M) · Issued
 *
 * The officer reads every office attraction, finalizes and reopens (with a
 * reason), and issues DTA2M / VAR 3M from finalized versions. The officer never
 * records a count: there is no form for it here, and the server refuses one.
 * Attraction visits are never added to accommodation arrivals or guest nights.
 */
(function () {
    const A = window.ztimsAcc, T = window.ztimsAtt;
    const { esc, nf, api } = A;
    const trackerLoads = new WeakMap(), monthLoads = new WeakMap();
    const STATUS = {
        submitted: ['tone-info acc-status-review', 'Awaiting review', 'Submitted by Support Staff; waiting for Tourism Office finalization'],
        finalized: ['tone-success', 'Finalized', 'Locked and included in official municipal reports'],
        reopened: ['tone-warning', 'Open for correction', 'Support Staff can correct and resubmit; the last finalized version stays official'],
        ready: ['tone-warning', 'Ready to submit', 'Daily counts are complete; Support Staff still needs to submit'],
        incomplete: ['tone-danger', 'Missing daily counts', 'One or more past dates need a count or a confirmed zero'],
        open: ['tone-neutral', 'In progress', 'Month is still in progress'],
        nostaff: ['tone-neutral', 'No assigned staff', 'No active Support Staff is assigned to this attraction'],
        before: ['tone-neutral', 'Before reporting', 'Before this attraction started reporting'],
        future: ['tone-neutral', 'Not started', 'Month has not started']
    };
    const statusPill = state => {
        const [tone, label] = STATUS[state] || ['tone-neutral', state];
        return `<span class="tone-pill rounded-pill acc-pill ${tone}">${state === 'finalized' ? '<span class="material-symbols-outlined" aria-hidden="true">lock</span>' : ''}${esc(label)}</span>`;
    };
    const thisYear = () => +A.manilaToday().slice(0, 4);
    const years = () => { const y = thisYear(); return [y, y - 1, y - 2]; };
    const yearSelect = (attr, value) => `<label class="block"><span class="field-label">Year</span><select class="field w-32" ${attr}>${years().map(y => `<option ${y === value ? 'selected' : ''}>${y}</option>`).join('')}</select></label>`;
    const modeToggle = mode => `<div class="att-mode" role="group" aria-label="Which figures"><button type="button" data-mode="official" aria-pressed="${mode === 'official'}">Official (finalized)</button><button type="button" data-mode="operational" aria-pressed="${mode === 'operational'}">Operational</button></div>`;
    const opBanner = '<div class="acc-banner acc-banner--warn"><span class="material-symbols-outlined" aria-hidden="true">visibility</span><span><b>Operational view.</b> It also takes submitted and draft months, each labeled. Send only the official (finalized) figures.</span></div>';

    function mount(el) {
        el.innerHTML = `<div role="tablist" aria-label="Attraction visits" class="att-report-nav flex flex-wrap gap-2 border-b border-outline-variant/30">
                ${[['tracker', 'fact_check', 'Attractions'], ['monthly', 'calendar_view_month', 'Municipal monthly · DTA2M'], ['annual', 'calendar_month', 'Municipal annual · VAR3M'], ['issued', 'inventory_2', 'Issued reports']]
                    .map(([k, icon, label], i) => `<button role="tab" type="button" class="settings-tab" data-sub="${k}" id="att-sub-${k}" aria-selected="${i === 0}"><span class="material-symbols-outlined !text-base" aria-hidden="true">${icon}</span>${label}</button>`).join('')}
            </div>
            <div data-subpanel class="space-y-4" role="tabpanel"></div>`;
        const panel = el.querySelector('[data-subpanel]');
        const state = { year: thisYear(), month: null, mode: 'official' };
        const [ly, lm] = A.shiftMonth(thisYear(), +A.manilaToday().slice(5, 7), -1);
        state.month = lm; state.monthYear = ly;
        function show(k) {
            trackerLoads.delete(panel);
            el.querySelectorAll('[data-sub]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.sub === k)));
            panel.setAttribute('aria-labelledby', 'att-sub-' + k);
            ({ tracker, monthly, annual, issued })[k](panel, state);
        }
        el.querySelectorAll('[data-sub]').forEach(b => b.addEventListener('click', () => show(b.dataset.sub)));
        show('tracker');
    }

    /* ---- Tracker ------------------------------------------------------------ */
    async function tracker(el, state) {
        const request = {};
        trackerLoads.set(el, request);
        el.innerHTML = A.loading('Loading attraction reports…');
        let d;
        try { d = await api(`/attraction-visits/tracker?year=${state.year}`); }
        catch (e) {
            if (trackerLoads.get(el) === request && e.status !== 401) {
                el.innerHTML = A.failed(e.message, true);
                el.querySelector('[data-acc-retry]').addEventListener('click', () => tracker(el, state), { once: true });
            }
            return;
        }
        if (trackerLoads.get(el) !== request) return;
        if (!d.attractions.some(a => a._id === state.attractionId)) state.attractionId = '';
        const selected = d.attractions.find(a => a._id === state.attractionId)?.months.find(m => m.month === state.selectedMonth);
        if (state.selectionYear !== state.year || !selected || ['before', 'future'].includes(selected.state)) state.selectedMonth = null;
        state.selectionYear = state.year;
        const refresh = () => tracker(el, state);
        function draw() {
            const attraction = d.attractions.find(a => a._id === state.attractionId);
            el.innerHTML = `<div class="acc-directory space-y-5">
                <div class="acc-head"><div class="acc-flow-title">${attraction ? '<button type="button" class="btn btn-secondary btn-sm" data-directory>← All attractions</button>' : ''}<h2 class="acc-part">${attraction ? esc(attraction.name) : 'Office-run attractions'}</h2>${attraction ? `<p class="acc-note">${esc([attraction.barangay, attraction.supportStaff || 'No assigned Support Staff'].filter(Boolean).join(' · '))}</p>` : ''}</div>
                <div class="acc-head__actions">${yearSelect('data-report-year aria-label="Reporting year"', state.year)}${attraction ? '<button type="button" class="btn btn-secondary" data-settings>Reporting settings</button>' : ''}</div></div>
                ${A.statusLegend(Object.entries(STATUS).map(([key, value]) => [statusPill(key), value[2]]))}
                ${attraction ? `<section aria-label="Reporting months"><h3 class="acc-part mb-3">Select a month</h3><div class="acc-month-cards">${attraction.months.map(m => `<button type="button" class="acc-month-card" data-report-month="${m.month}" aria-pressed="${state.selectedMonth === m.month}"${['future', 'before'].includes(m.state) ? ' disabled' : ''}><b>${A.MONTHS[m.month - 1]}</b>${statusPill(m.state)}<span class="acc-note">${m.state === 'incomplete' ? `${nf(m.missing)} dates missing` : esc(STATUS[m.state]?.[2] || '')}${m.version ? ` · v${m.version}` : ''}</span></button>`).join('')}</div></section><section data-month-report class="space-y-4" aria-label="Selected monthly report"></section>` : `
                <label class="block"><span class="field-label">Find an attraction</span><input type="search" class="field" data-attraction-search placeholder="Search attraction names" value="${esc(state.query || '')}"></label><div data-attraction-list class="acc-enterprise-list"></div>`}
            </div>`;
            el.querySelector('[data-report-year]').addEventListener('change', e => { state.year = +e.target.value; state.selectedMonth = null; refresh(); });
            if (!attraction) {
                const list = el.querySelector('[data-attraction-list]');
                function filter() {
                    const matches = d.attractions.filter(a => a.name.toLocaleLowerCase().includes((state.query || '').toLocaleLowerCase()));
                    list.innerHTML = matches.length ? matches.map(a => {
                        const review = a.months.filter(m => m.state === 'submitted').length;
                        const finalized = a.months.filter(m => m.state === 'finalized').length;
                        const missing = a.months.filter(m => m.state === 'incomplete').length;
                        return `<button type="button" class="acc-enterprise-row" data-attraction="${esc(a._id)}"><span><b>${esc(a.name)}</b><span class="acc-note">${finalized} month${finalized === 1 ? '' : 's'} finalized${review ? ` · ${review} awaiting review` : ''}${missing ? ` · ${missing} with missing counts` : ''}${!a.supportStaff ? ' · No assigned staff' : ''}</span></span><span aria-hidden="true">→</span></button>`;
                    }).join('') : '<div class="ztims-empty">No matching office-run attractions.</div>';
                    list.querySelectorAll('[data-attraction]').forEach(b => b.addEventListener('click', () => { state.attractionId = b.dataset.attraction; state.selectedMonth = null; draw(); }));
                }
                el.querySelector('[data-attraction-search]').addEventListener('input', e => { state.query = e.target.value; filter(); });
                filter();
            } else {
                el.querySelector('[data-directory]').addEventListener('click', () => { state.attractionId = ''; state.selectedMonth = null; draw(); });
                el.querySelector('[data-settings]').addEventListener('click', () => settingsWindow(attraction._id, attraction.name, refresh));
                const host = el.querySelector('[data-month-report]');
                const open = () => {
                    if (!state.selectedMonth) { host.innerHTML = '<div class="ztims-empty">Select a month to view its visitor summary and daily VAR1 report.</div>'; return; }
                    return monthWindow(attraction._id, state.year, state.selectedMonth, refresh, host);
                };
                el.querySelectorAll('[data-report-month]').forEach(b => b.addEventListener('click', async () => {
                    state.selectedMonth = +b.dataset.reportMonth;
                    const selectedMonth = state.selectedMonth;
                    el.querySelectorAll('[data-report-month]').forEach(x => x.setAttribute('aria-pressed', String(+x.dataset.reportMonth === state.selectedMonth)));
                    await open();
                    if (host.isConnected && state.selectedMonth === selectedMonth) host.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
                }));
                open();
            }
        }
        draw();
    }

    function settingsWindow(spotId, name, refresh) {
        A.openWindow({
            title: `Reporting settings · ${name}`,
            body: `<label class="block"><span class="field-label">Reporting starts (month)</span><input type="month" class="field" data-from></label>
                <label class="block"><span class="field-label">Attraction code</span><input type="text" class="field" maxlength="20" data-code></label>
                <p class="acc-note">Leave a box empty to keep it as it is. Reporting cannot start after a month that already has counts.</p>`,
            actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Save', kind: 'primary', run: async w => {
                const from = w.body.querySelector('[data-from]').value, code = w.body.querySelector('[data-code]').value.trim();
                const body = {};
                if (from) body.reportingFrom = from;
                if (code) body.attractionCode = code;
                if (!Object.keys(body).length) throw new Error('Enter the month reporting starts or the attraction code.');
                const r = await api(`/attraction-visits/${encodeURIComponent(spotId)}/settings`, { method: 'PUT', body });
                A.toast(`Saved. Reporting starts ${A.monthName(+r.reportingFrom.slice(0, 4), +r.reportingFrom.slice(5, 7))}${r.attractionCode ? `, code ${r.attractionCode}` : ''}.`, 'success');
                if (refresh) refresh();
            } }]
        });
    }

    /* ---- One attraction-month: review, Finalize, Reopen ---------------------- */
    async function monthWindow(spotId, year, month, refresh, host) {
        const path = `/attraction-visits/${encodeURIComponent(spotId)}/months/${year}/${month}`;
        const request = {};
        if (host) {
            monthLoads.set(host, request);
            host.innerHTML = `<div class="acc-head"><h2 class="text-xl font-bold"></h2><div class="acc-head__actions" data-review-actions></div></div><div data-review-error role="alert" hidden></div><div data-review-content class="space-y-4">${A.loading()}</div>`;
        }
        const w = host ? {
            el: host, body: host.querySelector('[data-review-content]'), close() {},
            error(message) { const error = host.querySelector('[data-review-error]'); error.hidden = false; error.textContent = message; }
        } : A.openWindow({ title: A.monthName(year, month), body: A.loading(), wide: true, actions: [{ label: 'Close', kind: 'secondary' }] });
        const active = () => !host || (host.isConnected && monthLoads.get(host) === request);
        let v;
        try { v = await api(path); } catch (e) { if (active() && e.status !== 401) w.body.innerHTML = A.failed(e.message); return; }
        if (!active()) return;
        const st = v.state, f = v.figures;
        const latest = v.versions[v.versions.length - 1];
        const shown = latest && st.state !== 'reopened' ? latest.figures : f;
        w.el.querySelector('h2').textContent = `${v.attraction.name} · ${A.monthName(year, month)}`;
        const re = (v.events || []).filter(e => e.action === 'reopened').pop();
        w.body.innerHTML = `<div class="flex flex-wrap items-center gap-2">${statusPill(st.state)}${st.state === 'reopened' && st.finalizedVersion ? `<span class="acc-note">Version ${st.finalizedVersion} stays official until the correction is finalized.</span>` : ''}</div>
            ${st.state === 'reopened' && re ? `<div class="acc-banner acc-banner--warn"><span>Reopened ${esc(A.fmtWhen(re.at))}: “${esc(re.reason)}”. Waiting for the Support Staff's correction.</span></div>` : ''}
            ${!latest ? `<div class="acc-banner acc-banner--info"><span>Not submitted. The figures below are the daily counts as they stand${f.missing.length + f.scheduled.length ? `, with ${f.missing.length + f.scheduled.length} dates missing` : ''}.</span></div>` : ''}
            ${latest && st.state !== 'reopened' ? `<p class="acc-note">Figures of version ${latest.version}, submitted ${esc(A.fmtWhen(latest.submittedAt))}${latest.submittedByEmail ? ` by ${esc(latest.submittedByEmail)}` : ''}.</p>` : ''}
            <div class="acc-tabs" role="tablist" aria-label="Attraction report"><button type="button" class="settings-tab" role="tab" data-report-form="summary" aria-selected="true">Monthly visitor summary</button><button type="button" class="settings-tab" role="tab" data-report-form="daily" aria-selected="false">Daily visitor report · VAR1</button></div>
            <div data-form-content role="tabpanel" aria-label="Monthly visitor summary" class="space-y-4"></div>
            <details><summary class="acc-part">Previous submissions</summary>
            ${v.versions.length ? `<ul class="divide-y divide-outline-variant/30">${v.versions.slice().reverse().map(x => `<li class="py-2 flex flex-wrap justify-between gap-2"><div><b>Version ${x.version}</b>${st.finalizedVersion === x.version ? ' ' + statusPill('finalized') : ''} · ${nf(x.figures.total)} visits · ${esc(A.fmtWhen(x.submittedAt))}${x.reason ? `<span class="acc-sub">Reason: ${esc(x.reason)}</span>` : ''}${T.changesHtml(x.changes)}</div>
                <button type="button" class="btn btn-secondary btn-sm min-h-[40px]" data-vxl="${x.version}">Excel v${x.version}</button></li>`).join('')}</ul>` : '<p class="acc-note">None yet.</p>'}</details>
            <details><summary class="acc-part">Submission history</summary>${T.historyHtml(v.events)}</details>`;
        const summaryHtml = `${T.tilesHtml(Object.assign({}, shown, { days: f.days, missing: latest && st.state !== 'reopened' ? undefined : f.missing, scheduled: f.scheduled }))}
            ${shown.residenceUnrecorded || shown.sexUnrecorded ? `<div class="acc-banner acc-banner--warn"><span>${shown.residenceUnrecorded ? `Residence not recorded for ${nf(shown.residenceUnrecorded)} visits. ` : ''}${shown.sexUnrecorded ? `Sex not recorded for ${nf(shown.sexUnrecorded)} visits.` : ''}</span></div>` : ''}
            ${T.breakdownHtml(shown)}`;
        const form = w.body.querySelector('[data-form-content]');
        form.innerHTML = summaryHtml;
        w.body.querySelectorAll('[data-report-form]').forEach(b => b.addEventListener('click', () => {
            const daily = b.dataset.reportForm === 'daily';
            w.body.querySelectorAll('[data-report-form]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
            form.setAttribute('aria-label', daily ? 'Daily visitor report · VAR1' : 'Monthly visitor summary');
            form.innerHTML = daily ? T.var1Html(shown.daily) : summaryHtml;
        }));
        const xl = which => A.download(`${path}/export.xlsx?version=${which}`, `VAR1_${year}-${A.pad(month)}.xlsx`).catch(e => w.error(e.message));
        w.body.querySelectorAll('[data-vxl]').forEach(b => b.addEventListener('click', () => xl(b.dataset.vxl)));
        // The actions this month allows; the server checks each again.
        const bar = w.el.querySelector(host ? '[data-review-actions]' : '.acc-window__actions');
        bar.innerHTML = '';
        const add = (label, kind, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = `btn min-h-[44px] ${kind}`; b.textContent = label; b.addEventListener('click', fn); bar.appendChild(b); return b; };
        add('VAR 1 Excel', 'btn-secondary', () => xl(latest && st.state !== 'reopened' ? 'latest' : 'current'));
        if (st.state === 'submitted' || st.state === 'finalized') add('Reopen for correction', 'btn-cancel', () => reopenWindow(v, path, () => { w.close(); refresh(); }));
        if (st.state === 'submitted') add(`Finalize version ${st.version}`, 'btn-primary', () => finalizeWindow(v, path, () => { w.close(); refresh(); }));
        if (!host) add('Close', 'btn-secondary', () => w.close());
    }

    function finalizeWindow(v, path, done) {
        const st = v.state, latest = v.versions[v.versions.length - 1];
        A.openWindow({
            title: `Finalize ${A.monthName(v.figures.year, v.figures.month)}?`,
            body: `<dl class="att-dl"><dt>Attraction</dt><dd>${esc(v.attraction.name)}</dd><dt>Version</dt><dd>${st.version}</dd><dt>Total visits</dt><dd><b>${nf(latest.figures.total)}</b></dd>
                <dt>Breakdowns</dt><dd>${latest.figures.residenceUnrecorded || latest.figures.sexUnrecorded ? `<span class="text-error font-bold">Incomplete:</span> residence not recorded for ${nf(latest.figures.residenceUnrecorded)}, sex not recorded for ${nf(latest.figures.sexUnrecorded)} visits.` : 'Complete.'}</dd></dl>
                <p class="acc-note">A finalized version becomes the official figure in DTA2M and VAR 3M. The month stays locked until you reopen it.</p>`,
            actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Finalize', kind: 'primary', run: async () => {
                await api(`${path}/finalize`, { method: 'POST', body: { expectedVersion: st.version } });
                A.toast(`${v.attraction.name}, ${A.monthName(v.figures.year, v.figures.month)}: version ${st.version} finalized.`, 'success');
                done();
            } }]
        });
    }

    function reopenWindow(v, path, done) {
        A.openWindow({
            title: `Reopen ${A.monthName(v.figures.year, v.figures.month)}?`,
            body: `<p>The Support Staff of ${esc(v.attraction.name)} can then correct the daily counts and submit a new version.${v.state.state === 'finalized' ? ` Version ${v.state.finalizedVersion || v.state.version} stays the official figure until the correction is finalized, and issued DTA2M / VAR 3M files that used it are marked to be regenerated.` : ''}</p>
                <label class="block"><span class="field-label">Reason (the Support Staff sees it)</span><textarea class="field" rows="3" maxlength="300" data-reason></textarea></label>
                <p class="acc-note">At least 10 characters.</p>`,
            actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Reopen', kind: 'danger', run: async w => {
                const reason = w.body.querySelector('[data-reason]').value.trim();
                if (reason.length < 10) throw new Error('Give a reason of at least 10 characters.');
                await api(`${path}/reopen`, { method: 'POST', body: { reason } });
                A.toast(`${A.monthName(v.figures.year, v.figures.month)} reopened.`, 'success');
                done();
            } }]
        });
    }

    /* ---- Monthly: DTA2M ------------------------------------------------------ */
    async function monthly(el, state) {
        const opts = [];
        for (let i = 0; i < 36; i++) { const [y, m] = A.shiftMonth(thisYear(), +A.manilaToday().slice(5, 7), -i); opts.push([y, m]); }
        el.innerHTML = `<div class="glass-panel p-4 flex flex-wrap items-end gap-3">
                <label class="block"><span class="field-label">Month</span><select class="field w-56" data-month>${opts.map(([y, m]) => `<option value="${y}-${m}" ${y === state.monthYear && m === state.month ? 'selected' : ''}>${esc(A.monthName(y, m))}</option>`).join('')}</select></label>
                ${modeToggle(state.mode)}
                <div class="ml-auto flex flex-wrap gap-2"><button type="button" class="btn btn-secondary min-h-[44px]" data-xl><span class="material-symbols-outlined !text-base">download</span>DTA2M Excel</button>
                    ${state.mode === 'official' ? '<button type="button" class="btn btn-primary min-h-[44px]" data-issue><span class="material-symbols-outlined !text-base">verified</span>Issue DTA2M</button>' : ''}</div>
            </div>${state.mode === 'operational' ? opBanner : ''}<div data-host class="space-y-4">${A.loading()}</div>`;
        el.querySelector('[data-month]').addEventListener('change', e => { [state.monthYear, state.month] = e.target.value.split('-').map(Number); monthly(el, state); });
        el.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { state.mode = b.dataset.mode; monthly(el, state); }));
        const y = state.monthYear, m = state.month, q = `year=${y}&month=${m}&mode=${state.mode}`;
        el.querySelector('[data-xl]').addEventListener('click', () => A.download(`/attraction-visits/consolidated/monthly.xlsx?${q}`, `DTA2M_${y}-${A.pad(m)}.xlsx`).catch(e => A.toast(e.message, 'error')));
        const issue = el.querySelector('[data-issue]');
        if (issue) issue.addEventListener('click', () => issueWindow('DTA2M', y, m, () => monthly(el, state)));
        const host = el.querySelector('[data-host]');
        let d;
        try { d = await api(`/attraction-visits/consolidated/monthly?${q}`); }
        catch (e) { if (e.status !== 401) host.innerHTML = A.failed(e.message); return; }
        const c = d.coverage, t = d.totals;
        const cell = (r, k) => (r.included ? (r[k] == null ? '' : nf(r[k])) : '–');
        const tn = v => (v == null ? '' : nf(v));
        host.innerHTML = `<div class="flex flex-wrap gap-2">
                <span class="tone-pill rounded-pill acc-pill tone-neutral acc-pill--lock">${c.finalized} of ${c.attractions} finalized</span>
                ${c.submitted ? `<span class="tone-pill rounded-pill acc-pill tone-success">${c.submitted} submitted, not finalized</span>` : ''}
                ${c.draft ? `<span class="tone-pill rounded-pill acc-pill tone-info">${c.draft} draft</span>` : ''}
                ${c.notSubmitted ? `<span class="tone-pill rounded-pill acc-pill tone-danger">${c.notSubmitted} not submitted</span>` : ''}</div>
            <div class="glass-panel acc-scroll"><table class="acc-grid acc-grid--wide"><thead>
                <tr><th rowspan="2">Attraction</th><th rowspan="2">Code</th><th>This Municipality</th><th>This Province</th><th>Other Province</th><th>Foreign</th><th colspan="3">Total</th><th rowspan="2">Residence not recorded</th><th rowspan="2">Figures</th></tr>
                <tr><th>Total</th><th>Total</th><th>Total</th><th>Total</th><th>Male</th><th>Female</th><th>Grand total</th></tr></thead>
                <tbody>${d.attractions.map(a => `<tr><th scope="row">${esc(a.name)}</th><td>${esc(a.code || '')}</td>
                    <td class="text-right">${cell(a.row, 'thisMunicipality')}</td><td class="text-right">${cell(a.row, 'thisProvince')}</td><td class="text-right">${cell(a.row, 'otherProvince')}</td><td class="text-right">${cell(a.row, 'foreign')}</td>
                    <td class="text-right">${cell(a.row, 'male')}</td><td class="text-right">${cell(a.row, 'female')}</td><td class="text-right"><b>${cell(a.row, 'total')}</b></td>
                    <td class="text-right ${a.row.included && a.row.residenceUnrecorded ? 'text-error font-bold' : ''}">${cell(a.row, 'residenceUnrecorded')}</td><td>${T.sourcePill(a.source)}</td></tr>`).join('') || '<tr><td colspan="11">No office-run attraction reports this month.</td></tr>'}</tbody>
                <tfoot><tr><th colspan="2">Total of this month</th>${t.included ? `<td class="text-right">${tn(t.thisMunicipality)}</td><td class="text-right">${tn(t.thisProvince)}</td><td class="text-right">${tn(t.otherProvince)}</td><td class="text-right">${tn(t.foreign)}</td>
                    <td class="text-right">${t.sexAny ? nf(t.male) : ''}</td><td class="text-right">${t.sexAny ? nf(t.female) : ''}</td><td class="text-right">${nf(t.total)}</td><td class="text-right">${nf(t.residenceUnrecorded)}</td>` : '<td colspan="8">Nothing to add up.</td>'}<td>${t.included} included</td></tr></tfoot></table></div>
            <p class="acc-note">${esc(d.note)} "–": not submitted${state.mode === 'official' ? ' or not finalized' : ''}, never 0. Empty: not recorded. Residence male and female stay empty, as on the Excel: they are never estimated. "This Province" is the rest of Negros Oriental, outside Zamboanguita.</p>`;
    }

    /* ---- Annual: VAR 3M ----------------------------------------------------- */
    async function annual(el, state) {
        el.innerHTML = `<div class="glass-panel p-4 flex flex-wrap items-end gap-3">${yearSelect('data-year', state.year)}${modeToggle(state.mode)}
                <div class="ml-auto flex flex-wrap gap-2"><button type="button" class="btn btn-secondary min-h-[44px]" data-xl><span class="material-symbols-outlined !text-base">download</span>VAR 3M Excel</button>
                    ${state.mode === 'official' ? '<button type="button" class="btn btn-primary min-h-[44px]" data-issue><span class="material-symbols-outlined !text-base">verified</span>Issue VAR 3M</button>' : ''}</div>
            </div>${state.mode === 'operational' ? opBanner : ''}<div data-host class="space-y-4">${A.loading()}</div>`;
        el.querySelector('[data-year]').addEventListener('change', e => { state.year = +e.target.value; annual(el, state); });
        el.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { state.mode = b.dataset.mode; annual(el, state); }));
        const q = `year=${state.year}&mode=${state.mode}`;
        el.querySelector('[data-xl]').addEventListener('click', () => A.download(`/attraction-visits/consolidated/annual.xlsx?${q}`, `VAR3M_${state.year}.xlsx`).catch(e => A.toast(e.message, 'error')));
        const issue = el.querySelector('[data-issue]');
        if (issue) issue.addEventListener('click', () => issueWindow('VAR3M', state.year, null, () => annual(el, state)));
        const host = el.querySelector('[data-host]');
        let d;
        try { d = await api(`/attraction-visits/consolidated/annual?${q}`); }
        catch (e) { if (e.status !== 401) host.innerHTML = A.failed(e.message); return; }
        if (!d.attractions.length) { host.innerHTML = '<div class="ztims-empty">No office-run attraction reports in that year.</div>'; return; }
        const c = cell => (cell && cell.included ? cell : null);
        // "–": no usable month; empty: the month is in, but its residence was not recorded.
        const td = (x, k, strong) => `<td class="text-right"${x && x.pending ? ' title="Correction pending"' : ''}>${!x ? '–' : x[k] == null ? '' : strong ? `<b>${nf(x[k])}</b>` : nf(x[k])}</td>`;
        const body = A.MONTHS.map((name, i) => `<tr><th scope="row">${name}</th>${d.attractions.map(a => { const x = c(a.months[i].cell); return td(x, 'domestic') + td(x, 'foreign') + td(x, 'total', true); }).join('')}
            ${(x => td(x, 'domestic') + td(x, 'foreign') + td(x, 'total', true))(d.byMonth[i])}</tr>`).join('');
        const anyIn = a => a.months.some(m => m.cell.included);
        host.innerHTML = `<div class="glass-panel acc-scroll"><table class="acc-grid acc-grid--wide"><thead>
                <tr><th rowspan="2">Month</th>${d.attractions.map(a => `<th colspan="3">${esc(a.name)}${a.code ? ` (${esc(a.code)})` : ''}</th>`).join('')}<th colspan="3">All attractions</th></tr>
                <tr>${d.attractions.concat([{}]).map(() => '<th>Domestic</th><th>Foreign</th><th>Total</th>').join('')}</tr></thead>
                <tbody>${body}</tbody>
                <tfoot><tr><th>Total</th>${d.totals.map((t, i) => (anyIn(d.attractions[i]) ? td(t, 'domestic') + td(t, 'foreign') + td(t, 'total') : '<td>–</td><td>–</td><td>–</td>')).join('')}
                    ${d.byMonth.some(Boolean) ? td(d.grand, 'domestic') + td(d.grand, 'foreign') + td(d.grand, 'total') : '<td>–</td><td>–</td><td>–</td>'}</tr>
                <tr class="att-row--note"><th>Residence not recorded</th>${d.totals.map(t => `<td colspan="3" class="text-right">${nf(t.unrecorded)}</td>`).join('')}<td colspan="3" class="text-right">${nf(d.grand.unrecorded)}</td></tr></tfoot></table></div>
            <p class="acc-note">${esc(d.note)} "–": no ${state.mode === 'official' ? 'finalized' : 'usable'} figures for that month, never 0. Empty: residence not recorded that month.</p>`;
    }

    function issueWindow(kind, year, month, done) {
        const period = month ? A.monthName(year, month) : String(year);
        A.openWindow({
            title: `Issue ${kind === 'VAR3M' ? 'VAR 3M' : 'DTA2M'} for ${period}?`,
            body: `<p>ZTIMS keeps a record of exactly which finalized versions this issue uses, so the same file can be downloaded again later. An earlier issue of the same period is marked superseded. Months that are not finalized are left out and stay empty on the form.</p>`,
            actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Issue', kind: 'primary', run: async () => {
                const r = await api('/attraction-visits/outputs', { method: 'POST', body: month ? { kind, year, month } : { kind, year } });
                A.toast(`Issued: ${r.output.composition.length} finalized month${r.output.composition.length === 1 ? '' : 's'} used.`, 'success');
                done();
            } }]
        });
    }

    /* ---- Issued outputs ----------------------------------------------------- */
    const OUT = { current: ['tone-success', 'verified', 'Current'], needs_regeneration: ['tone-warning', 'sync_problem', 'Needs regenerating'], superseded: ['tone-neutral', 'history', 'Superseded'] };
    async function issued(el, state) {
        el.innerHTML = `<div class="glass-panel p-4 flex flex-wrap items-end gap-3">${yearSelect('data-year', state.year)}</div><div class="glass-panel" data-host>${A.loading()}</div>`;
        el.querySelector('[data-year]').addEventListener('change', e => { state.year = +e.target.value; issued(el, state); });
        const host = el.querySelector('[data-host]');
        let d;
        try { d = await api(`/attraction-visits/outputs?year=${state.year}`); }
        catch (e) { if (e.status !== 401) host.innerHTML = A.failed(e.message); return; }
        if (!d.outputs.length) { host.innerHTML = '<div class="ztims-empty m-4">Nothing issued in that year.</div>'; return; }
        host.innerHTML = `<ul class="divide-y divide-outline-variant/30">${d.outputs.map(o => { const s = OUT[o.status] || ['tone-neutral', 'help', o.status]; return `<li class="p-4 flex flex-wrap items-center justify-between gap-3">
            <div><b>${o.kind === 'VAR3M' ? 'VAR 3M' : 'DTA2M'} · ${esc(o.month ? A.monthName(o.year, o.month) : String(o.year))}</b>
                <span class="tone-pill rounded-pill acc-pill ${s[0]}"><span class="material-symbols-outlined" aria-hidden="true">${s[1]}</span>${s[2]}</span>
                <span class="acc-sub">${o.versions} finalized month${o.versions === 1 ? '' : 's'} · issued ${esc(A.fmtWhen(o.issuedAt))} by ${esc(o.issuedBy)}${o.status !== 'current' && o.statusChangedAt ? ` · ${esc(s[2].toLowerCase())} since ${esc(A.fmtWhen(o.statusChangedAt))}` : ''}</span></div>
            <button type="button" class="btn btn-secondary btn-sm min-h-[40px]" data-out="${esc(o._id)}"><span class="material-symbols-outlined !text-base">download</span>Excel as issued</button></li>`; }).join('')}</ul>
            <p class="px-4 pb-4 acc-note">"Needs regenerating": a month it used was reopened. Issue the period again once the correction is finalized; this one is kept as it was.</p>`;
        host.querySelectorAll('[data-out]').forEach(b => b.addEventListener('click', () => A.download(`/attraction-visits/outputs/${b.dataset.out}/export.xlsx`, 'issued.xlsx').catch(e => A.toast(e.message, 'error'))));
    }

    window.ztimsAttOfficer = { mount };
})();
