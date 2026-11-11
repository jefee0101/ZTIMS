/* The Tourism Officer's side of accommodation reporting, in Statistics:
 *   tracker(el, year)            private places to stay × months, by state
 *   month(el, place, year, month) one enterprise's month: the submitted
 *                                version, Finalize / Reopen, versions, history
 *   formA(el)                    the municipal FORM A, with its coverage
 * Needs acc-common.js. The officer reads and finalizes; never edits stays.
 */
(function () {
    const A = () => window.ztimsAcc;
    const SHORT = { submitted: '✓', changed: '!', finalized: '🔒', reopened: 'Re', open: '…', due: 'Due', overdue: '!', not_recorded: '–', not_operating: 'N/A', not_set_up: '?', future: '', municipal_total: 'Total' };

    /* ---- tracker ---------------------------------------------------------- */
    async function tracker(el, year, onPick) {
        el.innerHTML = A().loading();
        try {
            const d = await A().api(`/accommodation/tracker?year=${year}`);
            if (!d.enterprises.length) { el.innerHTML = '<div class="ztims-empty m-4">No private places to stay are listed.</div>'; return; }
            const tally = {};
            const rows = d.enterprises.map(e => `<tr class="own-row--private"><td class="px-3 py-2 acc-sticky"><span class="font-bold">${A().esc(e.name)}</span></td>${e.months.map(m => {
                tally[m.state] = (tally[m.state] || 0) + 1;
                const s = A().STATES[m.state] || ['tone-neutral', '', m.state];
                const label = `${e.name} · ${A().monthName(year, m.month)}: ${s[2]}${m.latestVersion ? ' · version ' + m.latestVersion : ''}`;
                return `<td class="px-1 py-1.5 text-center">${m.state === 'future' ? '' : `<button type="button" class="st-cell tone-pill ${s[0]}" data-spot="${A().esc(e._id)}" data-month="${m.month}" title="${A().esc(label)}" aria-label="${A().esc(label)}">${SHORT[m.state] || ''}</button>`}</td>`;
            }).join('')}</tr>`).join('');
            const pill = (state, n) => `<span class="tone-pill rounded-pill acc-pill ${(A().STATES[state] || ['tone-neutral'])[0]}">${n} ${A().STATES[state][2].toLowerCase()}</span>`;
            el.innerHTML = `<div class="flex flex-wrap gap-2 p-4">${['submitted', 'finalized', 'changed', 'reopened', 'overdue', 'not_recorded', 'not_operating'].filter(k => tally[k]).map(k => pill(k, tally[k])).join('') || '<span class="text-support">Nothing reported yet.</span>'}</div>
                <p class="flex flex-wrap gap-2 px-4 pb-3 text-xs font-bold" aria-label="What the cells mean">${['submitted', 'changed', 'finalized', 'reopened', 'due', 'overdue', 'not_recorded', 'not_operating', 'municipal_total'].map(k => `<span class="tone-pill rounded-pill px-2.5 py-0.5 ${A().STATES[k][0]}">${SHORT[k]} ${A().STATES[k][2]}</span>`).join('')}</p>
                <div class="acc-scroll"><table class="ztims-table text-sm min-w-[900px]"><thead><tr><th class="text-left px-3 py-2 acc-sticky">Place to stay</th>${A().MONTHS.map(m => `<th class="px-1 py-2 text-center">${m.slice(0, 3)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
            el.querySelectorAll('[data-spot]').forEach(b => b.addEventListener('click', () => onPick(b.dataset.spot, year, +b.dataset.month)));
        } catch (e) { if (e.message !== 'Signed out') el.innerHTML = A().failed(e.message); }
    }

    /* ---- one enterprise's month ------------------------------------------ */
    async function month(el, place, year, mon) {
        el.innerHTML = A().loading();
        await A().loadResidences();
        let v;
        try { v = await A().api(`/accommodation/${place._id}/months/${year}/${mon}`); }
        catch (e) { if (e.message !== 'Signed out') el.innerHTML = A().failed(e.message); return; }
        const s = v.state.state, latest = v.versions[v.versions.length - 1];
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
            future: B('info', 'hourglass_empty', '<b>Not started.</b>'),
            municipal_total: B('info', 'inventory_2', '<b>Held as a municipal total</b> from the paper Form A4.')
        }[s] || '';
        const f = latest ? latest.figures : null;
        const actions = [];
        if (s === 'submitted') actions.push(`<button type="button" class="btn btn-primary min-h-[44px]" data-act="finalize"><span class="material-symbols-outlined !text-base" aria-hidden="true">lock</span>Finalize version ${latest.version}</button>`);
        if (s === 'finalized') actions.push(`<button type="button" class="btn btn-secondary min-h-[44px]" data-act="reopen"><span class="material-symbols-outlined !text-base" aria-hidden="true">lock_open</span>Reopen</button>`);
        if (latest) actions.push(`<button type="button" class="btn btn-secondary min-h-[44px]" data-xl="${latest.version}"><span class="material-symbols-outlined !text-base" aria-hidden="true">download</span>Excel</button>`);
        el.innerHTML = `<div class="space-y-5">
            <div class="acc-head"><div class="flex flex-wrap items-center gap-2"><h2 class="text-xl font-headline font-bold text-on-surface">${A().esc(v.enterprise.name)} · ${A().monthName(year, mon)}</h2>${A().statePill(s, v.state.latestVersion)}</div>
                <div class="acc-head__actions">${actions.join('')}</div></div>
            ${banner}
            ${f ? `<p class="text-support">Showing version ${latest.version}, as submitted${latest.provenance === 'legacy_manual' ? ' (typed by hand before the stay register)' : ''}.</p>
                <div class="stat-tiles"><div class="stat-tile"><p>Guest arrivals</p><p>${A().nf(f.arrivals)}</p></div><div class="stat-tile"><p>Guest-nights</p><p>${A().nf(f.guestNights)}</p></div>
                <div class="stat-tile"><p>Occupancy rate</p><p>${A().pct(f.occupancyRate)}</p></div><div class="stat-tile"><p>Average length of stay</p><p>${A().dec(f.averageLengthOfStay)}</p></div></div>
                <section class="space-y-3"><h3 class="acc-part">Part I. Guest arrivals by nationality / country of residence</h3>${A().partOneHtml(f.counts)}</section>
                <section class="space-y-3"><h3 class="acc-part">Part II. Other indicators</h3>${A().partTwoHtml(f)}</section>` : ''}
            ${v.versions.length ? `<section class="space-y-2"><h3 class="acc-part">Versions</h3><div class="acc-scroll"><table class="ztims-table acc-table"><thead><tr><th>Version</th><th>Submitted</th><th>Reason</th><th class="text-right">Arrivals</th><th class="text-right">Guest-nights</th><th></th></tr></thead><tbody>
                ${v.versions.slice().reverse().map(x => `<tr><td><b>v${x.version}</b></td><td>${A().fmtWhen(x.submittedAt)}${x.late ? ' · late' : ''}</td><td>${x.reason ? A().esc(x.reason) : '<span class="text-on-surface-variant">First submission</span>'}</td><td class="text-right">${A().nf(x.figures.arrivals)}</td><td class="text-right">${A().nf(x.figures.guestNights)}</td><td class="text-right"><button type="button" class="btn btn-secondary btn-sm" data-xl="${x.version}">Excel</button></td></tr>`).join('')}</tbody></table></div></section>` : ''}
            ${v.events.length ? `<section class="space-y-2"><h3 class="acc-part">History</h3><ul class="acc-history">${v.events.slice().reverse().map(e => `<li><span class="text-on-surface-variant">${A().fmtWhen(e.at)}</span> <b>${({ submitted: 'Submitted', finalized: 'Finalized', reopened: 'Reopened' })[e.action]}</b>${e.reason ? ' · ' + A().esc(e.reason) : ''} <span class="text-on-surface-variant">(${e.actorRole === 'admin' ? 'Tourism Office' : 'Enterprise'})</span></li>`).join('')}</ul></section>` : ''}
        </div>`;
        const again = () => month(el, place, year, mon);
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
    function formA(el) {
        const thisYear = +A().manilaToday().slice(0, 4);
        let year = thisYear, onlyUsed = true, d = null;
        el.innerHTML = `<div class="glass-panel p-4 flex flex-wrap items-end gap-3">
                <label class="block"><span class="field-label">Year</span><select data-year class="field w-32">${Array.from({ length: thisYear - 2024 }, (_, i) => thisYear - i).map(y => `<option>${y}</option>`).join('')}</select></label>
                <button type="button" class="btn btn-secondary min-h-[44px]" data-x="excel"><span class="material-symbols-outlined !text-base" aria-hidden="true">download</span>Download Excel</button>
                <label class="inline-flex items-center gap-2 text-sm font-semibold min-h-[44px] cursor-pointer ml-auto"><input data-only type="checkbox" class="accent-primary w-4 h-4" checked> Only countries with arrivals</label>
            </div><div data-body class="space-y-4"></div>`;
        const body = el.querySelector('[data-body]');
        async function load() {
            body.innerHTML = A().loading('Adding up the saved versions…');
            try { d = await A().api(`/accommodation/form-a?year=${year}`); draw(); }
            catch (e) { if (e.message !== 'Signed out') body.innerHTML = A().failed(e.message, true); }
        }
        function coverage(m) {
            if (m.source === 'municipal_total') return ['tone-neutral', 'Paper total'];
            if (m.source === 'none') return m.expected && `${year}-${A().pad(m.month)}-01` <= A().manilaToday() ? ['tone-danger', 'No reports'] : ['tone-neutral', '–'];
            if (m.complete) return ['tone-success', `Complete ${m.reported}/${m.expected - m.notOperating}`];
            return ['tone-warning', `${m.reported} of ${m.expected - m.notOperating}, ${m.missing} missing`];
        }
        function draw() {
            const has = d.months.map(m => m.source === 'municipal_total' || (m.source === 'enterprise_reports' && m.reported > 0));
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
                    ${line('Rooms available (room-nights)', m => A().nf(m.roomNightsAvailable) + (m.roomNightsAvailableDerived ? '<sup title="Rooms × days, from the paper total">†</sup>' : ''), A().nf(p2.total.roomNightsAvailable))}
                    ${line('Guest-nights', m => A().nf(m.guestNights), A().nf(p2.total.guestNights))}
                    ${line('Occupancy rate', m => A().pct(m.occupancyRate), A().pct(p2.total.occupancyRate))}
                    ${line('Average length of stay', m => A().dec(m.averageLengthOfStay), A().dec(p2.total.averageLengthOfStay))}</tbody></table></div>
                    <p class="acc-note">† Paper months give rooms, not room-nights: rooms × days. Yearly rates use the year's totals.</p></section>
                <section class="glass-panel p-4 space-y-3"><h3 class="acc-part">Volume per sex</h3>
                    ${vol.months.length ? `<div class="acc-scroll"><table class="ztims-table acc-table"><thead><tr><th></th><th class="text-right">Male</th><th class="text-right">Female</th></tr></thead><tbody>
                        ${sections.map(([k, l]) => `<tr><td>${l}</td><td class="text-right">${A().nf(vol[k].male)}</td><td class="text-right">${A().nf(vol[k].female)}</td></tr>`).join('')}</tbody></table></div>` : ''}
                    <p class="acc-note">${vol.notRecordedMonths.length ? `Not recorded for ${vol.notRecordedMonths.map(n => A().MONTHS[n - 1].slice(0, 3)).join(', ')} (paper totals without male and female).` : 'From every reported month.'}</p></section>`;
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

    window.ztimsAccOfficer = { tracker, month, formA };
})();
