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
    const MON = A.MONTHS.map(m => m.slice(0, 3));
    const SHORT = { finalized: 'Final', submitted: 'Submitted', reopened: 'Reopened', ready: 'Ready', incomplete: 'Missing', open: 'In progress', nostaff: 'No staff', before: '–', future: '' };
    const thisYear = () => +A.manilaToday().slice(0, 4);
    const years = () => { const y = thisYear(); return [y, y - 1, y - 2]; };
    const yearSelect = (attr, value) => `<label class="block"><span class="field-label">Year</span><select class="field w-32" ${attr}>${years().map(y => `<option ${y === value ? 'selected' : ''}>${y}</option>`).join('')}</select></label>`;
    const modeToggle = mode => `<div class="att-mode" role="group" aria-label="Which figures"><button type="button" data-mode="official" aria-pressed="${mode === 'official'}">Official (finalized)</button><button type="button" data-mode="operational" aria-pressed="${mode === 'operational'}">Operational</button></div>`;
    const opBanner = '<div class="acc-banner acc-banner--warn"><span class="material-symbols-outlined" aria-hidden="true">visibility</span><span><b>Operational view.</b> It also takes submitted and draft months, each labeled. Send only the official (finalized) figures.</span></div>';
    const legacyLine = l => (l && l.municipalTotalMonths ? `<p class="acc-note">${esc(l.note)} (${l.municipalTotalMonths} month${l.municipalTotalMonths === 1 ? '' : 's'} in that year.)</p>` : '');

    function mount(el) {
        el.innerHTML = `<div role="tablist" aria-label="Attraction visits" class="flex flex-wrap gap-2 border-b border-outline-variant/30">
                ${[['tracker', 'fact_check', 'Tracker'], ['monthly', 'calendar_view_month', 'Monthly (DTA2M)'], ['annual', 'calendar_month', 'Annual (VAR 3M)'], ['issued', 'inventory_2', 'Issued']]
                    .map(([k, icon, label], i) => `<button role="tab" type="button" class="settings-tab" data-sub="${k}" id="att-sub-${k}" aria-selected="${i === 0}"><span class="material-symbols-outlined !text-base" aria-hidden="true">${icon}</span>${label}</button>`).join('')}
            </div>
            <p class="acc-note">Visits to office-run attractions, counted daily by each attraction's Support Staff. Kept apart from accommodation arrivals and guest nights; added across attractions they are visits, not unique tourists.</p>
            <div data-subpanel class="space-y-4" role="tabpanel"></div>`;
        const panel = el.querySelector('[data-subpanel]');
        const state = { year: thisYear(), month: null, mode: 'official' };
        const [ly, lm] = A.shiftMonth(thisYear(), +A.manilaToday().slice(5, 7), -1);
        state.month = lm; state.monthYear = ly;
        function show(k) {
            el.querySelectorAll('[data-sub]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.sub === k)));
            panel.setAttribute('aria-labelledby', 'att-sub-' + k);
            ({ tracker, monthly, annual, issued })[k](panel, state);
        }
        el.querySelectorAll('[data-sub]').forEach(b => b.addEventListener('click', () => show(b.dataset.sub)));
        show('tracker');
    }

    /* ---- Tracker ------------------------------------------------------------ */
    async function tracker(el, state) {
        el.innerHTML = `<div class="glass-panel p-4 flex flex-wrap items-end gap-3">${yearSelect('data-year', state.year)}</div><div class="glass-panel" data-host>${A.loading()}</div>`;
        el.querySelector('[data-year]').addEventListener('change', e => { state.year = +e.target.value; tracker(el, state); });
        const host = el.querySelector('[data-host]');
        let d;
        try { d = await api(`/attraction-visits/tracker?year=${state.year}`); }
        catch (e) { if (e.status !== 401) host.innerHTML = A.failed(e.message); return; }
        if (!d.attractions.length) { host.innerHTML = '<div class="ztims-empty m-4">No office-run attraction counts visitors in that year.</div>'; return; }
        const tally = {};
        const rows = d.attractions.map(a => `<tr class="own-row--office"><td class="px-3 py-2 acc-sticky text-left">
                <span class="font-bold">${esc(a.name)}</span><span class="acc-sub">${esc(a.barangay || '')}${a.supportStaff ? ` · ${esc(a.supportStaff)}` : ' · <span class="text-error font-bold">No Support Staff</span>'}</span>
                <button type="button" class="text-xs font-bold underline mt-1" data-settings="${esc(a._id)}" data-name="${esc(a.name)}">Reporting settings</button></td>
            ${a.months.map(m => {
                tally[m.state] = (tally[m.state] || 0) + 1;
                if (m.state === 'future') return '<td></td>';
                const s = T.MONTH_STATES[m.state] || ['tone-neutral', 'help', m.state];
                let short = SHORT[m.state] || m.state;
                if (m.state === 'incomplete') short = `${m.missing} missing`;
                if ((m.state === 'finalized' || m.state === 'submitted') && m.version) short += ` v${m.version}`;
                const label = `${a.name} · ${A.monthName(state.year, m.month)}: ${s[2]}${m.version ? ', version ' + m.version : ''}${m.state === 'incomplete' ? `, ${m.missing} dates missing` : ''}`;
                return `<td class="px-1 py-1.5">${m.state === 'before' ? `<span class="acc-note" title="${esc(label)}">–</span>`
                    : `<button type="button" class="att-cellbtn" data-spot="${esc(a._id)}" data-month="${m.month}" aria-label="${esc(label)}" title="${esc(label)}"><span class="tone-pill rounded-pill acc-pill ${s[0]}">${esc(short)}</span></button>`}</td>`;
            }).join('')}</tr>`).join('');
        const order = ['submitted', 'finalized', 'reopened', 'ready', 'incomplete', 'nostaff'];
        host.innerHTML = `<div class="flex flex-wrap gap-2 p-4">${order.filter(k => tally[k]).map(k => `<span class="tone-pill rounded-pill acc-pill ${T.MONTH_STATES[k][0]}">${tally[k]} ${esc(T.MONTH_STATES[k][2].toLowerCase())}</span>`).join('') || '<span class="acc-note">Nothing to review yet.</span>'}</div>
            <p class="px-4 pb-3 acc-note">Submitted months wait for you to finalize them. "Ready" and "missing" months are still with the Support Staff.</p>
            <div class="acc-scroll"><table class="ztims-table text-sm min-w-[1100px] att-track"><thead><tr><th class="text-left px-3 py-2 acc-sticky">Attraction</th>${MON.map(m => `<th class="px-1 py-2 text-center">${m}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
        host.querySelectorAll('[data-spot]').forEach(b => b.addEventListener('click', () => monthWindow(b.dataset.spot, state.year, +b.dataset.month, () => tracker(el, state))));
        host.querySelectorAll('[data-settings]').forEach(b => b.addEventListener('click', () => settingsWindow(b.dataset.settings, b.dataset.name)));
    }

    function settingsWindow(spotId, name) {
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
            } }]
        });
    }

    /* ---- One attraction-month: review, Finalize, Reopen ---------------------- */
    async function monthWindow(spotId, year, month, refresh) {
        const path = `/attraction-visits/${encodeURIComponent(spotId)}/months/${year}/${month}`;
        const w = A.openWindow({ title: A.monthName(year, month), body: A.loading(), wide: true, actions: [{ label: 'Close', kind: 'secondary' }] });
        let v;
        try { v = await api(path); } catch (e) { if (e.status !== 401) w.body.innerHTML = A.failed(e.message); return; }
        const st = v.state, f = v.figures;
        const latest = v.versions[v.versions.length - 1];
        const shown = latest && st.state !== 'reopened' ? latest.figures : f;
        w.el.querySelector('h2').textContent = `${v.attraction.name} · ${A.monthName(year, month)}`;
        const re = (v.events || []).filter(e => e.action === 'reopened').pop();
        w.body.innerHTML = `<div class="flex flex-wrap items-center gap-2">${T.monthPill(st.state, st.version, st.missing)}${st.state === 'reopened' && st.finalizedVersion ? `<span class="acc-note">Version ${st.finalizedVersion} stays official until the correction is finalized.</span>` : ''}</div>
            ${st.state === 'reopened' && re ? `<div class="acc-banner acc-banner--warn"><span>Reopened ${esc(A.fmtWhen(re.at))}: “${esc(re.reason)}”. Waiting for the Support Staff's correction.</span></div>` : ''}
            ${!latest ? `<div class="acc-banner acc-banner--info"><span>Not submitted. The figures below are the daily counts as they stand${f.missing.length + f.scheduled.length ? `, with ${f.missing.length + f.scheduled.length} dates missing` : ''}.</span></div>` : ''}
            ${latest && st.state !== 'reopened' ? `<p class="acc-note">Figures of version ${latest.version}, submitted ${esc(A.fmtWhen(latest.submittedAt))}${latest.submittedByEmail ? ` by ${esc(latest.submittedByEmail)}` : ''}.</p>` : ''}
            ${T.tilesHtml(Object.assign({}, shown, { days: f.days, missing: latest && st.state !== 'reopened' ? undefined : f.missing, scheduled: f.scheduled }))}
            ${shown.residenceUnrecorded || shown.sexUnrecorded ? `<div class="acc-banner acc-banner--warn"><span>${shown.residenceUnrecorded ? `Residence not recorded for ${nf(shown.residenceUnrecorded)} visits. ` : ''}${shown.sexUnrecorded ? `Sex not recorded for ${nf(shown.sexUnrecorded)} visits.` : ''}</span></div>` : ''}
            ${T.breakdownHtml(shown)}
            <details><summary class="cursor-pointer font-bold min-h-[44px] flex items-center">Day by day (VAR 1)</summary>${T.var1Html(f.daily)}</details>
            <h3 class="acc-part">Versions</h3>
            ${v.versions.length ? `<ul class="divide-y divide-outline-variant/30">${v.versions.slice().reverse().map(x => `<li class="py-2 flex flex-wrap justify-between gap-2"><div><b>Version ${x.version}</b>${st.finalizedVersion === x.version ? ' ' + T.monthPill('finalized') : ''} · ${nf(x.figures.total)} visits · ${esc(A.fmtWhen(x.submittedAt))}${x.reason ? `<span class="acc-sub">Reason: ${esc(x.reason)}</span>` : ''}${T.changesHtml(x.changes)}</div>
                <button type="button" class="btn btn-secondary btn-sm min-h-[40px]" data-vxl="${x.version}">Excel v${x.version}</button></li>`).join('')}</ul>` : '<p class="acc-note">None yet.</p>'}
            <h3 class="acc-part">History</h3>${T.historyHtml(v.events)}`;
        const xl = which => A.download(`${path}/export.xlsx?version=${which}`, `VAR1_${year}-${A.pad(month)}.xlsx`).catch(e => w.error(e.message));
        w.body.querySelectorAll('[data-vxl]').forEach(b => b.addEventListener('click', () => xl(b.dataset.vxl)));
        // The actions this month allows; the server checks each again.
        const bar = w.el.querySelector('.acc-window__actions');
        bar.innerHTML = '';
        const add = (label, kind, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = `btn min-h-[44px] ${kind}`; b.textContent = label; b.addEventListener('click', fn); bar.appendChild(b); return b; };
        add('VAR 1 Excel', 'btn-secondary', () => xl(latest && st.state !== 'reopened' ? 'latest' : 'current'));
        if (st.state === 'submitted' || st.state === 'finalized') add('Reopen', 'btn-cancel', () => reopenWindow(v, path, () => { w.close(); refresh(); }));
        if (st.state === 'submitted') add(`Finalize version ${st.version}`, 'btn-primary', () => finalizeWindow(v, path, () => { w.close(); refresh(); }));
        add('Close', 'btn-secondary', () => w.close());
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
        if (!d.attractions.length) { host.innerHTML = '<div class="ztims-empty">No office-run attraction reports in that year.</div>' + legacyLine(d.legacy); return; }
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
            <p class="acc-note">${esc(d.note)} "–": no ${state.mode === 'official' ? 'finalized' : 'usable'} figures for that month, never 0. Empty: residence not recorded that month.</p>${legacyLine(d.legacy)}`;
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
