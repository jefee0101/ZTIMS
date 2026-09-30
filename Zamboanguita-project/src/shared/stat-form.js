/* ==========================================================================
   The monthly statistics report — one form, used by the establishment portal
   and by the Tourism Officer (for the office's own attractions and on anyone's
   behalf). Loaded as a module; it only defines window.ZTIMS_STATS.

   An accommodation reports its guests by country of residence (male and
   female), its number of rooms, room-nights occupied and guest nights. An
   attraction reports visitors by country of residence only. Totals are worked
   out as you type and again by the server, which is the one that decides:
   every rule here is also a rule there.

   Counts only. There is no field for money, a rate or a percentage, and none
   for anything about one guest.
   ========================================================================== */
(function () {
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                    'September', 'October', 'November', 'December'];
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const fmt = n => (n || 0).toLocaleString('en-US');
    const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

    let residencesPromise = null;
    function residences(apiBase, headers) {
        if (!residencesPromise) {
            residencesPromise = fetch(`${apiBase}/statistics/residences`, { headers: headers() })
                .then(r => { if (!r.ok) throw Object.assign(new Error('residences'), { status: r.status }); return r.json(); })
                .catch(error => { residencesPromise = null; throw error; });
        }
        return residencesPromise;
    }

    /* The months a report can be for: from January 2025 up to this month. */
    function periodOptions() {
        const now = new Date(Date.now() + 8 * 3600 * 1000);   // Manila
        const out = [];
        for (let y = now.getUTCFullYear(); y >= 2025; y--) {
            const last = y === now.getUTCFullYear() ? now.getUTCMonth() + 1 : 12;
            for (let m = last; m >= 1; m--) out.push({ year: y, month: m, label: `${MONTHS[m - 1]} ${y}` });
        }
        return out;
    }

    function formatWhen(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
    }

    /**
     * Draw the form for one place and one month into `host`.
     *   options.apiBase      '/api'
     *   options.headers      () => fetch headers with the sign-in token
     *   options.place        { _id, title, kind: 'accommodation' | 'attraction', barangay }
     *   options.year, month  the period
     *   options.officer      true on the officer's page: shows history, void and unlock
     *   options.onSaved      called after a successful save, void or unlock
     *   options.onExpired    called on a 401
     *   options.toast        (message, tone) => void
     */
    async function mount(host, options) {
        const { apiBase, headers, place, year, month } = options;
        const toast = options.toast || (() => {});
        const accommodation = place.kind === 'accommodation';
        const uid = 'sf' + Math.random().toString(36).slice(2, 8);
        host.innerHTML = '<div class="ztims-empty">Loading the report…</div>';

        let rows, state;
        try {
            const [res, reportRes] = await Promise.all([
                residences(apiBase, headers),
                fetch(`${apiBase}/statistics/reports/${place._id}/${year}/${month}`, { headers: headers() })
            ]);
            if (reportRes.status === 401) { if (options.onExpired) options.onExpired(); return; }
            state = await reportRes.json();
            if (!reportRes.ok) throw new Error(state.message || 'The report could not be loaded.');
            rows = res;
        } catch (error) {
            host.innerHTML = `<div class="ztims-empty tone-danger">${esc(error.status === 401 ? 'Your session has expired. Please sign in again.' : error.message || 'The report could not be loaded. Check your connection and try again.')}</div>`;
            if (error.status === 401 && options.onExpired) options.onExpired();
            return;
        }

        const report = state.report;
        const locked = !!(report && report.lockedAt);
        const blocked = state.recordedAsMunicipalTotal;
        const readOnly = locked || blocked;
        const given = Object.fromEntries(((report && report.counts) || []).map(c => [c.code, c]));
        const days = state.daysInMonth;

        // ---- group the rows the way the form does
        const sections = [
            { key: 'philippine', title: 'Philippine residents' },
            { key: 'foreign', title: 'Non-Philippine residents' },
            { key: 'overseas_filipino', title: 'Overseas Filipinos' },
            { key: 'unspecified', title: 'Unspecified residence' }
        ];
        const regionsOf = section => {
            const out = [];
            for (const r of rows.filter(x => x.section === section)) {
                let g = out.find(x => x.region === r.region);
                if (!g) out.push(g = { region: r.region, continent: r.continent, list: [] });
                g.list.push(r);
            }
            return out;
        };

        const cellInput = (code, sex) => {
            const value = given[code] ? given[code][sex] : '';
            return `<input type="number" inputmode="numeric" min="0" step="1" data-code="${esc(code)}" data-sex="${sex}"
                        value="${value === null || value === undefined ? '' : esc(value)}" ${readOnly ? 'disabled' : ''}
                        aria-label="${sex === 'male' ? 'Male' : 'Female'}"
                        class="field !min-h-[36px] !py-1.5 !px-2 !w-20 text-right font-mono">`;
        };

        let tbody = '';
        for (const sec of sections) {
            const groups = regionsOf(sec.key);
            if (!groups.length) continue;
            const single = groups.length === 1 && groups[0].list.length === 1;
            if (!single) tbody += `<tr class="sf-section" data-section="${sec.key}"><th colspan="4" class="text-left text-xs font-extrabold uppercase tracking-widest text-on-surface-variant pt-4 pb-1 px-3">${esc(sec.title)}</th></tr>`;
            for (const g of groups) {
                const showRegion = sec.key === 'foreign';
                if (showRegion) tbody += `<tr class="sf-region" data-region="${esc(g.region)}"><th colspan="4" class="text-left text-[11px] font-bold uppercase tracking-wider text-primary px-3 pt-3 pb-1">${esc(g.region)}</th></tr>`;
                for (const r of g.list) {
                    tbody += `<tr class="sf-row" data-code="${esc(r.code)}" data-name="${esc((r.name + ' ' + r.region + ' ' + r.continent).toLowerCase())}" data-region="${esc(g.region)}">
                        <td class="px-3 py-1.5 ${single ? 'font-bold' : ''}">${esc(r.name)}</td>
                        <td class="px-2 py-1 text-right">${cellInput(r.code, 'male')}</td>
                        <td class="px-2 py-1 text-right">${cellInput(r.code, 'female')}</td>
                        <td class="px-3 py-1.5 text-right font-mono font-bold" data-total="${esc(r.code)}">0</td></tr>`;
                }
                if (showRegion) tbody += `<tr class="sf-sub" data-subtotal="${esc(g.region)}"><td class="px-3 py-1.5 text-support font-bold">Sub-total, ${esc(g.region)}</td><td class="px-3 text-right font-mono" data-sm></td><td class="px-3 text-right font-mono" data-sf></td><td class="px-3 text-right font-mono font-bold" data-st></td></tr>`;
            }
        }

        const status = report
            ? `<span class="tone-pill ${report.late ? 'tone-warning' : 'tone-success'} text-xs font-bold px-2 py-0.5">${report.late ? 'Submitted late' : 'Submitted'}</span>
               <span class="text-support">by ${esc(report.submittedByEmail || (report.submittedByRole === 'admin' ? 'the Tourism Office' : 'the establishment'))}, ${esc(formatWhen(report.submittedAt))}</span>`
            : `<span class="tone-pill tone-neutral text-xs font-bold px-2 py-0.5">Not submitted yet</span>
               <span class="text-support">Due by ${esc(new Date(state.deadline).toLocaleDateString('en-PH', { dateStyle: 'medium' }))}</span>`;

        host.innerHTML = `
        <div class="space-y-5">
            <div class="flex flex-wrap items-center gap-2">${status}
                ${locked ? `<span class="tone-pill tone-info text-xs font-bold px-2 py-0.5">Locked: sent to the province</span>` : ''}
            </div>
            ${blocked ? `<div class="ztims-empty tone-warning">${esc(MONTHS[month - 1])} ${year} is recorded as the municipality's total from the printed Form A4, so reports for single places are not taken for it.</div>` : ''}
            ${locked ? `<p class="text-support">This month was already sent to the province. ${options.officer ? 'Unlock it below to correct it; the change is recorded.' : 'Ask the Tourism Office if something needs correcting.'}</p>` : ''}

            ${accommodation ? `
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label class="block"><span class="field-label">Number of rooms</span>
                    <input id="${uid}-rooms" type="number" inputmode="numeric" min="0" step="1" class="field font-mono" value="${report && report.rooms != null ? report.rooms : ''}" ${readOnly ? 'disabled' : ''}></label>
                <label class="block"><span class="field-label">Room-nights occupied</span>
                    <input id="${uid}-occ" type="number" inputmode="numeric" min="0" step="1" class="field font-mono" value="${report && report.roomNightsOccupied != null ? report.roomNightsOccupied : ''}" ${readOnly ? 'disabled' : ''}>
                    <span class="field-help">Each night a room is taken counts once.</span></label>
                <label class="block"><span class="field-label">Guest nights</span>
                    <input id="${uid}-nights" type="number" inputmode="numeric" min="0" step="1" class="field font-mono" value="${report && report.guestNights != null ? report.guestNights : ''}" ${readOnly ? 'disabled' : ''}>
                    <span class="field-help">Every guest × every night they stayed.</span></label>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-px bg-outline border border-outline">
                <div class="bg-surface p-3"><p class="text-label font-bold uppercase">Days in ${esc(MONTHS[month - 1])}</p><p class="text-xl font-mono font-bold">${days}</p></div>
                <div class="bg-surface p-3"><p class="text-label font-bold uppercase">Room-nights available</p><p id="${uid}-avail" class="text-xl font-mono font-bold">–</p></div>
                <div class="bg-surface p-3"><p class="text-label font-bold uppercase">Not occupied</p><p id="${uid}-free" class="text-xl font-mono font-bold">–</p></div>
                <div class="bg-surface p-3"><p class="text-label font-bold uppercase">Guests</p><p id="${uid}-guests" class="text-xl font-mono font-bold">0</p></div>
            </div>` : `
            <div class="grid grid-cols-3 gap-px bg-outline border border-outline">
                <div class="bg-surface p-3"><p class="text-label font-bold uppercase">Visitors</p><p id="${uid}-guests" class="text-xl font-mono font-bold">0</p></div>
                <div class="bg-surface p-3"><p class="text-label font-bold uppercase">Male</p><p id="${uid}-gm" class="text-xl font-mono font-bold">0</p></div>
                <div class="bg-surface p-3"><p class="text-label font-bold uppercase">Female</p><p id="${uid}-gf" class="text-xl font-mono font-bold">0</p></div>
            </div>`}

            <div class="flex flex-wrap items-center gap-3">
                <div class="relative flex-1 min-w-[12rem]">
                    <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant !text-lg">search</span>
                    <input id="${uid}-find" type="search" placeholder="Find a country or region" class="field !pl-10" autocomplete="off">
                </div>
                <label class="inline-flex items-center gap-2 text-sm text-on-surface-variant min-h-[44px] cursor-pointer">
                    <input id="${uid}-only" type="checkbox" class="accent-primary"> Only rows with ${accommodation ? 'guests' : 'visitors'}
                </label>
            </div>

            <div class="overflow-x-auto border border-outline">
                <table class="ztims-table text-sm min-w-[420px]">
                    <thead><tr><th class="text-left px-3 py-2">Country of residence</th><th class="text-right px-3 py-2">Male</th><th class="text-right px-3 py-2">Female</th><th class="text-right px-3 py-2">Total</th></tr></thead>
                    <tbody>${tbody}</tbody>
                    <tfoot>
                        <tr class="font-bold"><td class="px-3 py-2">Total Philippine residents</td><td class="px-3 text-right font-mono" data-sec-m="philippine"></td><td class="px-3 text-right font-mono" data-sec-f="philippine"></td><td class="px-3 text-right font-mono" data-sec-t="philippine"></td></tr>
                        <tr class="font-bold"><td class="px-3 py-2">Total non-Philippine residents</td><td class="px-3 text-right font-mono" data-sec-m="foreign"></td><td class="px-3 text-right font-mono" data-sec-f="foreign"></td><td class="px-3 text-right font-mono" data-sec-t="foreign"></td></tr>
                        <tr class="font-extrabold text-primary"><td class="px-3 py-2">${accommodation ? 'Grand total guest arrivals' : 'Total visitors'}</td><td class="px-3 text-right font-mono" data-grand-m></td><td class="px-3 text-right font-mono" data-grand-f></td><td class="px-3 text-right font-mono" data-grand-t></td></tr>
                    </tfoot>
                </table>
            </div>
            <p id="${uid}-nomatch" hidden class="text-support">No country or region matches that search.</p>

            <div id="${uid}-checks" class="flex flex-wrap gap-2" aria-live="polite"></div>
            <p id="${uid}-error" hidden class="text-sm text-error bg-error/10 border border-error/20 px-4 py-3"></p>

            <div class="flex flex-wrap items-center gap-3 pt-2 border-t border-outline">
                <button id="${uid}-save" type="button" class="btn btn-primary min-h-[48px]" ${readOnly ? 'disabled' : ''}>
                    <span class="material-symbols-outlined !text-base">save</span>${report ? 'Save changes' : 'Submit report'}
                </button>
                <p class="text-support">Counts only: no revenue, and no guest's name or details.</p>
            </div>

            ${options.officer && report ? `
            <details class="border border-outline p-4">
                <summary class="cursor-pointer font-bold text-sm">Officer actions and history</summary>
                <div class="mt-4 space-y-4">
                    <div class="flex flex-wrap items-end gap-3">
                        <label class="block flex-1 min-w-[14rem]"><span class="field-label">Reason (required)</span>
                            <input id="${uid}-reason" type="text" maxlength="500" class="field" placeholder="${locked ? 'What needs correcting' : 'Why this report is void'}"></label>
                        ${locked
                            ? `<button id="${uid}-unlock" type="button" class="btn btn-secondary min-h-[44px]"><span class="material-symbols-outlined !text-base">lock_open</span>Unlock to correct</button>`
                            : `<button id="${uid}-void" type="button" class="btn btn-danger min-h-[44px]"><span class="material-symbols-outlined !text-base">block</span>Void this report</button>`}
                    </div>
                    <p class="text-support">${locked ? 'Unlocking lets the figures be corrected. The unlock and the correction are both recorded.' : 'A void report stays on record but no longer counts in any total. Voiding is recorded.'}</p>
                    <ul class="space-y-1 text-sm">${(state.history || []).map(h => `<li><b>${esc(h.action)}</b> · ${esc(h.changed_by_email || h.changed_by_role)} · ${esc(formatWhen(h.changed_at))}${h.note ? ` · ${esc(h.note)}` : ''}</li>`).join('')}</ul>
                </div>
            </details>` : ''}
        </div>`;

        const $ = id => host.querySelector('#' + uid + '-' + id);
        const inputs = [...host.querySelectorAll('input[data-code]')];
        const totalCells = new Map([...host.querySelectorAll('[data-total]')].map(el => [el.dataset.total, el]));
        const numberOf = el => { const n = parseInt(el && el.value, 10); return Number.isFinite(n) ? n : null; };

        function collect() {
            const counts = {};
            for (const el of inputs) {
                const v = numberOf(el);
                counts[el.dataset.code] = counts[el.dataset.code] || { male: 0, female: 0 };
                counts[el.dataset.code][el.dataset.sex] = v || 0;
            }
            return counts;
        }

        function recalc() {
            const counts = collect();
            const bySec = {}, byRegion = {};
            let gm = 0, gf = 0;
            for (const r of rows) {
                const c = counts[r.code] || { male: 0, female: 0 };
                const t = c.male + c.female;
                const cell = totalCells.get(r.code);
                if (cell) { cell.textContent = fmt(t); cell.classList.toggle('text-on-surface-variant', t === 0); }
                bySec[r.section] = bySec[r.section] || { m: 0, f: 0 };
                bySec[r.section].m += c.male; bySec[r.section].f += c.female;
                if (r.section === 'foreign') {
                    byRegion[r.region] = byRegion[r.region] || { m: 0, f: 0 };
                    byRegion[r.region].m += c.male; byRegion[r.region].f += c.female;
                }
                gm += c.male; gf += c.female;
            }
            host.querySelectorAll('[data-subtotal]').forEach(tr => {
                const s = byRegion[tr.dataset.subtotal] || { m: 0, f: 0 };
                tr.querySelector('[data-sm]').textContent = fmt(s.m);
                tr.querySelector('[data-sf]').textContent = fmt(s.f);
                tr.querySelector('[data-st]').textContent = fmt(s.m + s.f);
            });
            for (const key of ['philippine', 'foreign']) {
                const s = bySec[key] || { m: 0, f: 0 };
                host.querySelector(`[data-sec-m="${key}"]`).textContent = fmt(s.m);
                host.querySelector(`[data-sec-f="${key}"]`).textContent = fmt(s.f);
                host.querySelector(`[data-sec-t="${key}"]`).textContent = fmt(s.m + s.f);
            }
            host.querySelector('[data-grand-m]').textContent = fmt(gm);
            host.querySelector('[data-grand-f]').textContent = fmt(gf);
            host.querySelector('[data-grand-t]').textContent = fmt(gm + gf);
            const guests = gm + gf;
            $('guests').textContent = fmt(guests);
            if (!accommodation) { $('gm').textContent = fmt(gm); $('gf').textContent = fmt(gf); }

            // Checks, in words. The server applies the same ones.
            const checks = [];
            if (inputs.some(el => el.value !== '' && (numberOf(el) === null || numberOf(el) < 0 || String(el.value).includes('.')))) {
                checks.push(['bad', 'Counts must be whole numbers, 0 or more']);
            }
            if (accommodation) {
                const rooms = numberOf($('rooms')), occ = numberOf($('occ')), nights = numberOf($('nights'));
                const available = rooms === null ? null : rooms * days;
                $('avail').textContent = available === null ? '–' : fmt(available);
                $('free').textContent = available === null || occ === null ? '–' : fmt(available - occ);
                if (rooms === null) checks.push(['wait', 'Enter the number of rooms']);
                if (occ === null) checks.push(['wait', 'Enter room-nights occupied']);
                else if (available !== null && occ > available) checks.push(['bad', `More room-nights occupied (${fmt(occ)}) than rooms × days (${fmt(available)})`]);
                if (nights === null) checks.push(['wait', 'Enter guest nights']);
                else if (nights < guests) checks.push(['bad', `Fewer guest nights (${fmt(nights)}) than guests (${fmt(guests)})`]);
                else if (guests === 0 && nights > 0) checks.push(['bad', 'Guest nights, but no guests entered']);
            }
            if (!checks.some(c => c[0] === 'bad')) checks.unshift(['ok', guests ? `${fmt(guests)} ${accommodation ? 'guests' : 'visitors'}, male and female add up` : `No ${accommodation ? 'guests' : 'visitors'} entered yet`]);
            $('checks').innerHTML = checks.map(([tone, text]) => {
                const cls = tone === 'ok' ? 'tone-success' : tone === 'bad' ? 'tone-danger' : 'tone-warning';
                return `<span class="${cls} tone-pill text-xs font-bold px-2.5 py-1">${tone === 'ok' ? '✓' : tone === 'bad' ? '!' : '•'} ${esc(text)}</span>`;
            }).join('');
            const save = $('save');
            if (save && !readOnly) save.disabled = checks.some(c => c[0] === 'bad');
            filter();
        }

        function filter() {
            const term = ($('find').value || '').trim().toLowerCase();
            const only = $('only').checked;
            const counts = collect();
            const visibleRegions = new Set();
            let any = false;
            host.querySelectorAll('tr.sf-row').forEach(tr => {
                const c = counts[tr.dataset.code] || { male: 0, female: 0 };
                const show = (!term || tr.dataset.name.includes(term)) && (!only || c.male + c.female > 0);
                tr.hidden = !show;
                if (show) { any = true; visibleRegions.add(tr.dataset.region); }
            });
            const filtering = !!term || only;
            host.querySelectorAll('tr.sf-region, tr.sf-sub').forEach(tr => {
                const key = tr.dataset.region || tr.dataset.subtotal;
                tr.hidden = filtering && !visibleRegions.has(key);
            });
            host.querySelectorAll('tr.sf-section').forEach(tr => { tr.hidden = filtering; });
            $('nomatch').hidden = any || !term;
        }

        // The host outlives each drawing of the form (mount runs again after every
        // save), so the previous drawing's listener comes off before this one goes on.
        if (host._ztimsStatsInput) host.removeEventListener('input', host._ztimsStatsInput);
        host._ztimsStatsInput = recalc;
        host.addEventListener('input', recalc);
        $('only').addEventListener('change', filter);

        async function send(method, path, body, busyButton, doneMessage) {
            const error = $('error');
            error.hidden = true;
            const original = busyButton.innerHTML;
            busyButton.disabled = true;
            busyButton.innerHTML = '<span class="inline-block w-4 h-4 border-2 border-current border-t-transparent animate-spin"></span> Saving…';
            try {
                const res = await fetch(`${apiBase}/statistics${path}`, {
                    method, headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body)
                });
                if (res.status === 401) { if (options.onExpired) options.onExpired(); return; }
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.message || 'That did not save. Try again.');
                toast(data.message || doneMessage, 'success');
                if (options.onSaved) options.onSaved(data);
                await mount(host, options);
            } catch (e) {
                error.textContent = e.message;
                error.hidden = false;
                busyButton.disabled = false;
                busyButton.innerHTML = original;
            }
        }

        const saveBtn = $('save');
        if (saveBtn) saveBtn.addEventListener('click', () => {
            const counts = collect();
            const body = { counts: Object.entries(counts).filter(([, c]) => c.male + c.female > 0).map(([code, c]) => ({ code, male: c.male, female: c.female })) };
            if (accommodation) Object.assign(body, { rooms: $('rooms').value, roomNightsOccupied: $('occ').value, guestNights: $('nights').value });
            send('PUT', `/reports/${place._id}/${year}/${month}`, body, saveBtn, 'Report saved.');
        });
        const reasonOf = () => { const r = ($('reason') && $('reason').value || '').trim(); if (!r) { const e = $('error'); e.textContent = 'Give a reason first.'; e.hidden = false; } return r; };
        const voidBtn = $('void');
        if (voidBtn) voidBtn.addEventListener('click', () => { const r = reasonOf(); if (r) send('POST', `/reports/${report._id}/void`, { reason: r }, voidBtn, 'Report voided.'); });
        const unlockBtn = $('unlock');
        if (unlockBtn) unlockBtn.addEventListener('click', () => { const r = reasonOf(); if (r) send('POST', `/reports/${report._id}/unlock`, { reason: r }, unlockBtn, 'Report unlocked.'); });

        recalc();
    }

    window.ZTIMS_STATS = { mount, periodOptions, MONTHS, daysIn };
})();
