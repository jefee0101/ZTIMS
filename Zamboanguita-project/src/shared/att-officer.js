/* The Tourism Officer's attraction visit reports, in Statistics → Attraction
 * visits (admin_statistics.html). API: zamboanguita-backend/attraction-visits.js.
 * Needs acc-common.js and att-common.js.
 *
 *   ztimsAttOfficer.mount(el)   Monthly DTA2M · Annual VAR3M
 *
 * The officer reads every office attraction, finalizes and reopens (with a
 * reason), and saves monthly DTA2M submissions. Annual VAR3M uses those copies. The officer never
 * records a count: there is no form for it here, and the server refuses one.
 * Attraction visits are never added to accommodation arrivals or guest nights.
 */
(function () {
    const A = window.ztimsAcc, T = window.ztimsAtt;
    const { esc, nf, api } = A;
    const trackerLoads = new WeakMap(), monthLoads = new WeakMap();
    const STATUS = {
        submitted: ['tone-info acc-status-review', 'Awaiting review', 'Daily records sent by Support Staff for Tourism Office review'],
        finalized: ['tone-success', 'Reviewed', 'Locked and ready for the monthly DTA2M submission'],
        reopened: ['tone-warning', 'Open for correction', 'Support Staff can correct the records; the previous DTA2M stays until resubmission'],
        ready: ['tone-warning', 'Ready for staff review', 'Daily counts are complete; Support Staff must send them for review'],
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

    const REPORT_STATUS = {
        preparing: ['tone-neutral', 'Preparing', 'Daily records still need to be completed or reviewed'],
        ready: ['tone-warning', 'Ready to submit', 'All reporting attractions have been reviewed'],
        submitted: ['tone-success', 'Submitted', 'A saved DTA2M submission is available'],
        correction: ['tone-danger', 'Correction required', 'Supporting records were reopened; submit again after review'],
        resubmitted: ['tone-success', 'Resubmitted', 'An updated DTA2M replaces the previous submission'],
        na: ['tone-neutral', 'Not applicable', 'No attraction was reporting in this month'],
        future: ['tone-neutral', 'Not started', 'This month has not started']
    };
    const reportPill = key => { const s = REPORT_STATUS[key]; return `<span class="tone-pill rounded-pill acc-pill ${s[0]}">${s[1]}</span>`; };
    function mount(el) {
        el.innerHTML = `<div class="att-report-nav flex flex-wrap gap-2" role="tablist" aria-label="Attraction reports"><button type="button" class="settings-tab" role="tab" data-sub="monthly" aria-selected="true">Monthly DTA2M</button><button type="button" class="settings-tab" role="tab" data-sub="annual" aria-selected="false">Annual VAR3M</button></div><div data-subpanel class="space-y-4" role="tabpanel"></div>`;
        const panel = el.querySelector('[data-subpanel]'), state = { year: thisYear(), month: null, mode: 'official' };
        function show(k) {
            trackerLoads.delete(panel);
            el.querySelectorAll('[data-sub]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.sub === k)));
            (k === 'annual' ? annual : monthly)(panel, state);
        }
        el.querySelectorAll('[data-sub]').forEach(b => b.addEventListener('click', () => show(b.dataset.sub)));
        show('monthly');
    }
    async function monthly(el, state) {
        const request = {}; trackerLoads.set(el, request);
        el.innerHTML = A.loading();
        let tracker, history;
        try { [tracker, history] = await Promise.all([api(`/attraction-visits/tracker?year=${state.year}`), api(`/attraction-visits/outputs?year=${state.year}`)]); }
        catch(e) { if (trackerLoads.get(el) === request) el.innerHTML = A.failed(e.message); return; }
        if (trackerLoads.get(el) !== request) return;
        const outputs = history.outputs.filter(o => o.kind === 'DTA2M');
        function info(month) {
            const rows = tracker.attractions.map(a => ({ ...a, record: a.months[month - 1] })).filter(a => a.record.state !== 'before');
            const submissions = outputs.filter(o => o.month === month), latest = submissions.find(o => o.status !== 'superseded');
            const ended = `${state.year}-${A.pad(month)}-${A.daysIn(state.year,month)}` < A.manilaToday();
            const ready = ended && rows.length > 0 && rows.every(a => a.record.state === 'finalized');
            const status = latest ? latest.status === 'needs_regeneration' ? 'correction' : submissions.length > 1 ? 'resubmitted' : 'submitted' : `${state.year}-${A.pad(month)}-01` > A.manilaToday() ? 'future' : !rows.length ? 'na' : ready ? 'ready' : 'preparing';
            return { rows, submissions, latest, ready, status };
        }
        el.innerHTML = `<div class="acc-directory space-y-5"><div class="acc-head"><div class="acc-flow-title"><h2 class="acc-part">Monthly DTA2M</h2></div>${yearSelect('data-report-year',state.year)}</div>${A.statusLegend(Object.keys(REPORT_STATUS).map(k=>[reportPill(k),REPORT_STATUS[k][2]]))}<section aria-label="Reporting months"><div class="acc-month-cards">${A.MONTHS.map((name,i)=>{const s=info(i+1);return `<button type="button" class="acc-month-card" data-dta-month="${i+1}" aria-pressed="${state.month===i+1}"${['future','na'].includes(s.status)?' disabled':''}><b>${name}</b>${reportPill(s.status)}<span class="acc-note">${s.rows.length ? `${s.rows.filter(a=>a.record.state==='finalized').length} of ${s.rows.length} attractions reviewed` : 'No reporting attractions'}</span></button>`;}).join('')}</div></section><section data-dta-report class="space-y-4" aria-label="Selected DTA2M">Select a month to prepare or view its DTA2M.</section></div>`;
        el.querySelector('[data-report-year]').addEventListener('change',e=>{state.year=+e.target.value;state.month=null;monthly(el,state);});
        const host = el.querySelector('[data-dta-report]');
        async function open(month, outputId) {
            const token={}; monthLoads.set(host,token);host.innerHTML=A.loading();
            const s=info(month), saved=outputId === 'draft' ? null : outputId || s.latest?._id;
            let d;
            try { d=await api(saved ? `/attraction-visits/outputs/${saved}` : `/attraction-visits/consolidated/monthly?year=${state.year}&month=${month}&mode=operational`); }
            catch(e){if(monthLoads.get(host)===token)host.innerHTML=A.failed(e.message);return;}
            if(!host.isConnected || monthLoads.get(host)!==token)return;
            const value=(r,k)=>r.included?(r[k]==null || (['male','female'].includes(k) && r.sexAny===false)?'':nf(r[k])):'—';
            host.innerHTML=`<div class="acc-head"><div><h2 class="acc-part">DTA2M · ${esc(A.monthName(state.year,month))}</h2>${reportPill(s.status)}</div><div class="acc-head__actions"><button type="button" class="btn btn-secondary" data-download>${saved?'Download submitted DTA2M':'Download draft DTA2M'}</button>${(!s.latest || s.status==='correction')?`<button type="button" class="btn btn-primary" data-submit-dta${s.ready?'':' disabled'}>${s.latest?'Resubmit DTA2M':'Submit DTA2M'}</button>`:''}</div></div>
                ${d.submission?`<p class="acc-note">Saved submission · ${esc(A.fmtWhen(d.submission.at))} · ${esc(d.submission.by)}</p>`:'<div class="acc-banner acc-banner--warn">Draft — complete and review each attraction before submitting.</div>'}
                ${s.status==='correction'?'<div class="acc-banner acc-banner--warn">Correction required. The saved submission below is preserved until a replacement is submitted.</div><button type="button" class="btn btn-secondary" data-draft>View current correction draft</button>':''}
                <div class="acc-scroll"><table class="acc-grid"><thead><tr><th>Attraction</th><th>This municipality</th><th>Rest of province</th><th>Other provinces</th><th>Foreign</th><th>Male</th><th>Female</th><th>Total visits</th><th>Residence not recorded</th></tr></thead><tbody>${d.attractions.map(a=>`<tr><th scope="row"><button type="button" class="underline font-bold" data-detail="${esc(a._id)}">${esc(a.name)}</button></th>${['thisMunicipality','thisProvince','otherProvince','foreign','male','female','total','residenceUnrecorded'].map(k=>`<td>${value(a.row,k)}</td>`).join('')}</tr>`).join('')||'<tr><td colspan="9">No reporting attractions.</td></tr>'}</tbody><tfoot><tr><th>Total</th>${['thisMunicipality','thisProvince','otherProvince','foreign','male','female','total','residenceUnrecorded'].map(k=>`<td>${value(d.totals,k)}</td>`).join('')}</tr></tfoot></table></div>
                <p class="acc-note">Visits, not unique tourists. Missing figures stay blank or —; confirmed zero remains 0.</p>
                <section><h3 class="acc-part">Supporting attraction records</h3>${A.statusLegend(Object.entries(STATUS).map(([k,v])=>[statusPill(k),v[2]]))}<div class="acc-enterprise-list">${s.rows.map(a=>`<button type="button" class="acc-enterprise-row" data-detail="${esc(a._id)}"><span><b>${esc(a.name)}</b><span class="acc-note">${a.record.missing?`${a.record.missing} dates missing`:''}</span></span>${statusPill(a.record.state)}</button>`).join('')}</div></section>
                <details><summary class="acc-part">Submission history (${s.submissions.length})</summary>${s.submissions.map((o,i)=>`<div class="acc-head py-3"><span>Submission ${s.submissions.length-i} · ${esc(A.fmtWhen(o.issuedAt))} · ${esc(o.issuedBy)}${o.status==='superseded'?' · Replaced by a newer submission':''}</span><button type="button" class="btn btn-secondary" data-saved="${esc(o._id)}">View saved report</button><button type="button" class="btn btn-secondary" data-saved-xl="${esc(o._id)}">Excel</button></div>`).join('')||'<p>No submissions yet.</p>'}</details>`;
            host.querySelector('[data-download]').onclick=()=>A.download(saved?`/attraction-visits/outputs/${saved}/export.xlsx`:`/attraction-visits/consolidated/monthly.xlsx?year=${state.year}&month=${month}&mode=operational`,'DTA2M.xlsx').catch(e=>A.toast(e.message,'error'));
            host.querySelector('[data-draft]')?.addEventListener('click',()=>open(month,'draft'));
            host.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>{
                host.innerHTML='<button type="button" class="btn btn-secondary" data-back-dta>← Back to DTA2M</button><div data-attraction-detail class="acc-directory space-y-4"></div>';
                host.querySelector('[data-back-dta]').onclick=()=>monthly(el,state);
                monthWindow(b.dataset.detail,state.year,month,()=>monthly(el,state),host.querySelector('[data-attraction-detail]'));
            });
            host.querySelectorAll('[data-saved]').forEach(b=>b.onclick=()=>open(month,b.dataset.saved));
            host.querySelectorAll('[data-saved-xl]').forEach(b=>b.onclick=()=>A.download(`/attraction-visits/outputs/${b.dataset.savedXl}/export.xlsx`,'DTA2M.xlsx').catch(e=>A.toast(e.message,'error')));
            host.querySelector('[data-submit-dta]')?.addEventListener('click',()=>A.openWindow({title:s.latest?'Resubmit monthly DTA2M?':'Submit monthly DTA2M?',body:'<p>Save this combined DTA2M and its reviewed attraction versions as the monthly submission. Download the saved Excel for delivery through your office’s usual channel.</p>',actions:[{label:'Cancel',kind:'cancel'},{label:s.latest?'Resubmit DTA2M':'Submit DTA2M',kind:'primary',run:async()=>{await api('/attraction-visits/outputs',{method:'POST',body:{kind:'DTA2M',year:state.year,month}});A.toast('DTA2M submission saved.','success');monthly(el,state);}}]}));
        }
        el.querySelectorAll('[data-dta-month]').forEach(b=>b.onclick=async()=>{state.month=+b.dataset.dtaMonth;el.querySelectorAll('[data-dta-month]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));await open(state.month);if(host.isConnected)host.scrollIntoView({block:'start',behavior:'auto'});});
        if(state.month)open(state.month);
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
        w.body.innerHTML = `<div class="flex flex-wrap items-center gap-2">${statusPill(st.state)}${st.state === 'reopened' && st.finalizedVersion ? `<span class="acc-note">The previous submitted DTA2M stays unchanged until a replacement is submitted.</span>` : ''}</div>
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
        add('Reporting settings', 'btn-secondary', () => settingsWindow(spotId, v.attraction.name, refresh));
        add('VAR 1 Excel', 'btn-secondary', () => xl(latest && st.state !== 'reopened' ? 'latest' : 'current'));
        if (st.state === 'submitted' || st.state === 'finalized') add('Reopen for correction', 'btn-cancel', () => reopenWindow(v, path, () => { w.close(); refresh(); }));
        if (st.state === 'submitted') add(`Mark version ${st.version} reviewed`, 'btn-primary', () => finalizeWindow(v, path, () => { w.close(); refresh(); }));
        if (!host) add('Close', 'btn-secondary', () => w.close());
    }

    function finalizeWindow(v, path, done) {
        const st = v.state, latest = v.versions[v.versions.length - 1];
        A.openWindow({
            title: `Mark ${A.monthName(v.figures.year, v.figures.month)} reviewed?`,
            body: `<dl class="att-dl"><dt>Attraction</dt><dd>${esc(v.attraction.name)}</dd><dt>Version</dt><dd>${st.version}</dd><dt>Total visits</dt><dd><b>${nf(latest.figures.total)}</b></dd>
                <dt>Breakdowns</dt><dd>${latest.figures.residenceUnrecorded || latest.figures.sexUnrecorded ? `<span class="text-error font-bold">Incomplete:</span> residence not recorded for ${nf(latest.figures.residenceUnrecorded)}, sex not recorded for ${nf(latest.figures.sexUnrecorded)} visits.` : 'Complete.'}</dd></dl>
                <p class="acc-note">These records become ready for the monthly DTA2M. They stay locked until reopened; submitting the combined DTA2M is a separate step.</p>`,
            actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Mark reviewed', kind: 'primary', run: async () => {
                await api(`${path}/finalize`, { method: 'POST', body: { expectedVersion: st.version } });
                A.toast(`${v.attraction.name}, ${A.monthName(v.figures.year, v.figures.month)}: version ${st.version} reviewed.`, 'success');
                done();
            } }]
        });
    }

    function reopenWindow(v, path, done) {
        A.openWindow({
            title: `Reopen ${A.monthName(v.figures.year, v.figures.month)}?`,
            body: `<p>The Support Staff of ${esc(v.attraction.name)} can then correct the daily counts and submit a new version.${v.state.state === 'finalized' ? ` The monthly DTA2M will require correction. Its saved figures and the annual report stay unchanged until a replacement DTA2M is submitted.` : ''}</p>
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
    /* ---- Annual: VAR 3M ----------------------------------------------------- */
    async function annual(el, state) {
        el.innerHTML = `<div class="acc-head"><h2 class="acc-part">Annual VAR3M</h2>${yearSelect('data-year', state.year)}<button type="button" class="btn btn-secondary" data-xl>Download annual VAR3M</button></div><p class="acc-note">All twelve months and all reporting attractions, using saved monthly DTA2M submissions. Unsubmitted months remain blank.</p><div data-host class="space-y-4">${A.loading()}</div>`;
        el.querySelector('[data-year]').addEventListener('change', e => { state.year = +e.target.value; state.month = null; annual(el, state); });
        const q = `year=${state.year}&mode=official&basis=submitted`;
        el.querySelector('[data-xl]').addEventListener('click', () => A.download(`/attraction-visits/consolidated/annual.xlsx?${q}`, `VAR3M_${state.year}.xlsx`).catch(e => A.toast(e.message, 'error')));
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
            <p class="acc-note">${esc(d.note)} "–": no submitted DTA2M figures for that month, never 0. Empty: residence not recorded that month.</p>`;
    }

    window.ztimsAttOfficer = { mount };
})();
