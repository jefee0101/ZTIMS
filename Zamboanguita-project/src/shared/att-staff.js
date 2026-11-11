/* The Support Staff's attraction pages (src/staff/): the Daily Visitor Record
 * (staff_register.html) and the Monthly Report (staff_statistics.html).
 * API: zamboanguita-backend/attraction-visits.js. Needs acc-common.js and
 * att-common.js loaded first.
 *
 *   ztimsAttStaff.record(host)   one count per date, the month at a glance
 *   ztimsAttStaff.report(host)   the generated month, Submit, versions, Excel
 *
 * The attraction is the account's own (GET /attraction-visits/me); the server
 * compares it with the URL on every call, so nothing here chooses it.
 */
(function () {
    const A = window.ztimsAcc, T = window.ztimsAtt;
    const { esc, nf, api } = A;
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    let mePromise = null;
    const me = () => (mePromise = mePromise || api('/attraction-visits/me'));
    const monthPath = (spotId, y, m) => `/attraction-visits/${encodeURIComponent(spotId)}/months/${y}/${m}`;
    const ym = key => [+key.slice(0, 4), +key.slice(5, 7)];
    const keyOf = (y, m) => A.monthKey(y, m);
    const lastReopen = events => (events || []).filter(e => e.action === 'reopened').pop() || null;
    const lastOf = (events, action) => (events || []).filter(e => e.action === action).pop() || null;

    /* The months a person may open: from reporting's start (or two years back
       before anything is recorded) to this month. */
    function monthRange(today, reportingFrom) {
        const [ty, tm] = ym(today);
        const [fy, fm] = reportingFrom ? ym(reportingFrom) : A.shiftMonth(ty, tm, -24);
        const out = [];
        for (let [y, m] = [ty, tm]; y > fy || (y === fy && m >= fm); [y, m] = A.shiftMonth(y, m, -1)) out.push([y, m]);
        return out;   // newest first
    }

    function stateBanner(v, page) {
        const s = v.state, link = page === 'record'
            ? `<a href="staff_statistics.html?month=${keyOf(v.figures.year, v.figures.month)}">Open the Monthly Report</a>`
            : `<a href="staff_register.html?month=${keyOf(v.figures.year, v.figures.month)}">Open the Daily Visitor Record</a>`;
        const sub = lastOf(v.events, 'submitted'), fin = lastOf(v.events, 'finalized'), re = lastReopen(v.events);
        switch (s.state) {
            case 'before': return `<div class="acc-banner acc-banner--info">This month is before reporting started${v.reportingFrom ? ` (${esc(A.monthName(...ym(v.reportingFrom)))})` : ''}.</div>`;
            case 'future': return '<div class="acc-banner acc-banner--info">This month has not started.</div>';
            case 'open': return `<div class="acc-banner acc-banner--info"><span>The month is in progress. It can be submitted from the 1st of next month.${page === 'report' ? ' ' + link : ''}</span></div>`;
            case 'incomplete': return `<div class="acc-banner acc-banner--bad"><span><b>${nf(s.missing)} date${s.missing === 1 ? ' is' : 's are'} not recorded.</b> Record each date, 0 when nobody came, before submitting. A missing date is never counted as 0. ${page === 'report' ? link : ''}</span></div>`;
            case 'ready': return `<div class="acc-banner acc-banner--warn"><span><b>Every date is recorded.</b> ${page === 'record' ? `Submit the month on the Monthly Report. ${link}` : 'Check the figures, then submit.'}</span></div>`;
            case 'submitted': return `<div class="acc-banner acc-banner--lock"><span class="material-symbols-outlined" aria-hidden="true">lock</span><span><b>Submitted, version ${s.version}${sub ? `, ${esc(A.fmtWhen(sub.at))}` : ''}.</b> The counts are locked while the Tourism Office reviews them. ${page === 'record' ? link : ''}</span></div>`;
            case 'finalized': return `<div class="acc-banner acc-banner--lock"><span class="material-symbols-outlined" aria-hidden="true">lock</span><span><b>Finalized, version ${s.finalizedVersion || s.version}${fin ? `, ${esc(A.fmtWhen(fin.at))}` : ''}.</b> Only the Tourism Office can reopen it. ${page === 'record' ? link : ''}</span></div>`;
            case 'reopened': return `<div class="acc-banner acc-banner--warn"><span class="material-symbols-outlined" aria-hidden="true">lock_open</span><span><b>Reopened by the Tourism Office${re ? `, ${esc(A.fmtWhen(re.at))}` : ''}.</b>${re && re.reason ? ` Reason: “${esc(re.reason)}”.` : ''} Correct the dates, then submit the correction on the Monthly Report.${s.finalizedVersion ? ` Version ${s.finalizedVersion} stays the official figure until a correction is finalized.` : ''} ${page === 'record' ? link : ''}</span></div>`;
            default: return '';
        }
    }
    const isLocked = st => ['submitted', 'finalized', 'before', 'future'].includes(st.state);

    async function header(host, title, actions) {
        host.innerHTML = `<div class="acc-head"><h1 class="text-3xl sm:text-4xl font-black font-headline tracking-tighter text-on-surface">${esc(title)}</h1>
            <div class="acc-head__actions">${actions || ''}</div></div><div data-att-body class="space-y-5">${A.loading('Loading your attraction…')}</div>`;
        const body = host.querySelector('[data-att-body]');
        try {
            const m = await me();
            if (!m.countsVisitors) { body.innerHTML = '<div class="ztims-empty">Visitors are not counted at this attraction. Ask the Tourism Office.</div>'; return null; }
            return { body, me: m };
        } catch (e) {
            if (e.status !== 401) body.innerHTML = e.status === 404 || e.status === 403
                ? '<div class="ztims-empty">No attraction is assigned to this account. Contact the Tourism Office.</div>'
                : A.failed(e.message);
            return null;
        }
    }

    /* =================================================================
       The Daily Visitor Record
       ================================================================= */
    async function record(host) {
        const h = await header(host, 'Daily Visitor Record', '<a href="staff_statistics.html" class="btn btn-secondary min-h-[44px]"><span class="material-symbols-outlined !text-base">bar_chart</span>Monthly Report</a>');
        if (!h) return;
        const spotId = h.me.attraction._id, today = h.me.today;
        const asked = new URLSearchParams(location.search).get('month');
        let [year, month] = asked && /^\d{4}-\d{2}$/.test(asked) && asked <= today.slice(0, 7) ? ym(asked) : ym(today);
        let view = null, date = null, dirty = false, pendingKey = null, saving = false;

        h.body.innerHTML = `
            <div class="acc-bar">
                <div class="acc-month" role="group" aria-label="Month">
                    <button type="button" class="acc-iconbtn" data-prev aria-label="Previous month"><span class="material-symbols-outlined">chevron_left</span></button>
                    <span class="acc-month__name" data-month aria-live="polite"></span>
                    <button type="button" class="acc-iconbtn" data-next aria-label="Next month"><span class="material-symbols-outlined">chevron_right</span></button>
                </div>
                <div data-pill></div>
            </div>
            <div data-banner></div>
            <div class="att-layout">
                <form class="glass-panel p-4 sm:p-5 space-y-4 att-form" novalidate data-form aria-labelledby="attFormTitle">
                    <h2 id="attFormTitle" class="acc-part">Record a date</h2>
                    <div class="att-form__top">
                        <label class="block"><span class="field-label">Date</span><input type="date" class="field" data-date required></label>
                        <label class="block"><span class="field-label">Total visitors</span>
                            <input type="number" class="field att-total" data-total inputmode="numeric" min="0" max="100000" step="1" required aria-describedby="attDayNote"></label>
                    </div>
                    <p id="attDayNote" class="acc-note" data-daynote aria-live="polite"></p>
                    <details class="att-more" data-more>
                        <summary>Add a breakdown <span class="acc-note">(optional)</span></summary>
                        <div class="space-y-4 pt-3">
                            <fieldset class="space-y-2"><legend class="font-bold text-sm">Where visitors live</legend>
                                <div class="att-grid4">${T.CLASSES.map(([k, label, hint]) => `<label class="block"><span class="field-label">${esc(label)}</span>
                                    <input type="number" class="field" data-res="${k}" inputmode="numeric" min="0" max="100000" step="1" title="${esc(hint)}"></label>`).join('')}</div>
                                <p class="acc-note" data-ressum aria-live="polite"></p></fieldset>
                            <fieldset class="space-y-2"><legend class="font-bold text-sm">Sex</legend>
                                <div class="att-grid4"><label class="block"><span class="field-label">Male</span><input type="number" class="field" data-sex="male" inputmode="numeric" min="0" max="100000" step="1"></label>
                                    <label class="block"><span class="field-label">Female</span><input type="number" class="field" data-sex="female" inputmode="numeric" min="0" max="100000" step="1"></label></div>
                                <p class="acc-note" data-sexsum aria-live="polite"></p></fieldset>
                            <p class="acc-note">Leave a box empty when it was not recorded. Residence and sex are kept separately.</p>
                        </div>
                    </details>
                    <p class="text-sm text-error bg-error/10 border border-error/20 px-4 py-3" role="alert" data-error hidden></p>
                    <div class="flex flex-wrap gap-3">
                        <button type="submit" class="btn btn-primary min-h-[44px]" data-save><span class="material-symbols-outlined !text-base">save</span>Save</button>
                        <button type="button" class="btn btn-cancel min-h-[44px]" data-discard hidden>Discard changes</button>
                    </div>
                </form>
                <section class="glass-panel p-4 sm:p-5 space-y-3" aria-labelledby="attMonthTitle">
                    <div class="flex flex-wrap items-center justify-between gap-2"><h2 id="attMonthTitle" class="acc-part">The month</h2>
                        <button type="button" class="btn btn-secondary btn-sm min-h-[40px]" data-zero hidden>Record 0 for several dates</button></div>
                    <p class="text-sm" data-progress></p>
                    <div class="att-meter" aria-hidden="true"><span data-meter></span></div>
                    <div data-cal></div>
                    <p class="att-legend" aria-label="What the days mean">
                        <span><i class="att-sw att-day--counted"></i>Counted</span><span><i class="att-sw att-day--zero"></i>Confirmed 0</span>
                        <span><i class="att-sw att-day--missing"></i>Missing</span><span><i class="att-sw att-day--closed"></i>Authorized closure</span></p>
                </section>
            </div>
            <section class="glass-panel p-4 sm:p-5 space-y-3" aria-label="Month so far"><h2 class="acc-part">So far this month</h2><div data-tiles></div></section>`;

        const $ = s => h.body.querySelector(s);
        const form = $('[data-form]'), dateIn = $('[data-date]'), totalIn = $('[data-total]'), errBox = $('[data-error]');
        const resIns = [...h.body.querySelectorAll('[data-res]')], sexIns = [...h.body.querySelectorAll('[data-sex]')];
        const allIns = [totalIn, ...resIns, ...sexIns];
        dateIn.max = today;

        const showError = msg => { errBox.innerHTML = msg || ''; errBox.hidden = !msg; };
        const num = el => (el.value.trim() === '' ? null : Number(el.value));
        const dayRow = d => view && view.figures.daily.find(x => x.date === d);

        function setDirty(on) {
            dirty = on;
            $('[data-discard]').hidden = !on;
            if (on) pendingKey = null;          // new figures, a new request
        }
        window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

        function sums() {
            const total = num(totalIn);
            const known = resIns.reduce((a, el) => a + (num(el) || 0), 0), anyRes = resIns.some(el => num(el) !== null);
            const sexKnown = sexIns.reduce((a, el) => a + (num(el) || 0), 0), anySex = sexIns.some(el => num(el) !== null);
            const zero = total === 0;
            [...resIns, ...sexIns].forEach(el => { el.disabled = zero || formLocked(); });
            $('[data-ressum]').textContent = zero ? 'No visitors: nothing to break down.' : !anyRes ? 'Not recorded.'
                : total == null ? `${nf(known)} classified.` : known === total ? `All ${nf(total)} visitors classified.` : known > total ? `${nf(known)} classified, more than the total of ${nf(total)}.` : `${nf(known)} of ${nf(total)} classified · ${nf(total - known)} not recorded.`;
            $('[data-sexsum]').textContent = zero ? '' : !anySex ? 'Not recorded.'
                : total == null ? `${nf(sexKnown)} recorded.` : sexKnown === total ? `All ${nf(total)} visitors recorded.` : sexKnown > total ? `Male + female is ${nf(sexKnown)}, more than the total of ${nf(total)}.` : `${nf(sexKnown)} of ${nf(total)} recorded · ${nf(total - sexKnown)} not recorded.`;
            return { total, known, anyRes, sexKnown, anySex };
        }
        const formLocked = () => !view || isLocked(view.state) || !date || ['closed', 'future', 'before'].includes((dayRow(date) || {}).state);

        function fillForm(d) {
            date = d; dateIn.value = d || '';
            const row = d && dayRow(d), c = row && row.count;
            totalIn.value = c ? c.total : '';
            resIns.forEach(el => { el.value = c && c.residence[el.dataset.res] != null ? c.residence[el.dataset.res] : ''; });
            sexIns.forEach(el => { el.value = c && c[el.dataset.sex] != null ? c[el.dataset.sex] : ''; });
            const hasBreakdown = c && (resIns.some(el => el.value !== '') || sexIns.some(el => el.value !== ''));
            $('[data-more]').open = !!hasBreakdown;
            const locked = formLocked();
            allIns.forEach(el => { el.disabled = locked; });
            $('[data-save]').disabled = locked;
            let note = '';
            if (!d) note = 'Choose a date.';
            else if (!row) note = '';
            else if (row.state === 'closed') note = `Authorized closure${row.why ? `: ${row.why}` : ''}. No count is taken on this date.`;
            else if (row.state === 'future') note = 'This date has not happened yet.';
            else if (row.state === 'before') note = 'This date is before reporting started.';
            else if (c) note = `${A.weekday(d)} ${A.fmtDate(d, true)}: saved ${c.total === 0 ? 'as 0 (no visitors)' : `as ${nf(c.total)} visitors`}.`;
            else if (row.state === 'scheduled') note = `${A.weekday(d)} ${A.fmtDate(d, true)}: usually closed, but not recorded. Enter the count, or 0 if nobody came.`;
            else note = `${A.weekday(d)} ${A.fmtDate(d, true)}: not recorded yet.`;
            if (isLocked(view.state) && !['future', 'before'].includes(view.state.state)) note += ' The month is locked.';
            $('[data-daynote]').textContent = note;
            showError('');
            setDirty(false);
            sums();
            h.body.querySelectorAll('.att-day').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.date === d)));
        }

        function drawMonth() {
            const f = view.figures, st = view.state;
            $('[data-month]').textContent = A.monthName(year, month);
            $('[data-pill]').innerHTML = T.monthPill(st.state, st.version, st.missing);
            $('[data-banner]').innerHTML = stateBanner(view, 'record');
            const [ny, nm] = A.shiftMonth(year, month, 1), [py, pm] = A.shiftMonth(year, month, -1);
            $('[data-next]').disabled = keyOf(ny, nm) > today.slice(0, 7);
            $('[data-prev]').disabled = !!view.reportingFrom && keyOf(py, pm) < view.reportingFrom.slice(0, 7);
            dateIn.min = view.reportingFrom || '';
            const missing = f.missing.length + f.scheduled.length;
            const passed = f.daily.filter(d => !['future', 'before', 'today'].includes(d.state) || d.count).length;
            $('[data-progress]').innerHTML = `<b>${nf(f.dates)}</b> of ${nf(f.days)} dates recorded · ${nf(f.zero)} confirmed 0 · ${nf(f.closed)} closure${f.closed === 1 ? '' : 's'} · <b class="${missing ? 'text-error' : ''}">${nf(missing)} missing</b>`;
            $('[data-meter]').style.width = `${passed ? Math.round(((f.dates + f.closed) / f.days) * 100) : 0}%`;
            $('[data-zero]').hidden = !missing || isLocked(st);
            // The calendar: one button per day, its state in words for screen readers.
            const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
            let cells = DOW.map(d => `<span class="att-cal__dow" aria-hidden="true">${d}</span>`).join('') + '<span class="att-cal__pad"></span>'.repeat(first);
            for (const d of f.daily) {
                const [cls, label] = T.dayInfo(d.state), c = d.count;
                const value = c ? (c.total === 0 ? '0' : nf(c.total)) : d.state === 'missing' || d.state === 'scheduled' ? '—' : d.state === 'closed' ? 'Closed' : '';
                const partial = c && c.total > 0 && (!c.residenceComplete || !c.sexComplete);
                const off = d.state === 'future' || d.state === 'before';
                cells += `<button type="button" class="att-day ${cls}" data-date="${d.date}" ${off ? 'disabled' : ''} aria-pressed="false"
                    aria-label="${esc(`${A.weekday(d.date)} ${A.fmtDate(d.date, true)}: ${c ? (c.total === 0 ? 'no visitors, confirmed' : `${nf(c.total)} visitors`) : label}${partial ? ', breakdown partly recorded' : ''}`)}">
                    <span class="att-day__n">${+d.date.slice(8, 10)}</span><span class="att-day__v">${esc(value)}</span>${partial ? '<span class="att-day__dot" aria-hidden="true"></span>' : ''}</button>`;
            }
            $('[data-cal]').innerHTML = `<div class="att-cal">${cells}</div>`;
            h.body.querySelectorAll('.att-day').forEach(b => b.addEventListener('click', () => pickDate(b.dataset.date)));
            $('[data-tiles]').innerHTML = T.tilesHtml(f) + `<div class="mt-4">${T.breakdownHtml(f)}</div>`;
        }

        /* Leaving edits is always asked, never silent. */
        function confirmLeave() {
            if (!dirty) return Promise.resolve(true);
            return new Promise(resolve => {
                let answered = false;
                const w = A.openWindow({
                    title: 'Discard your changes?',
                    body: `<p>The figures for ${esc(A.fmtDate(date, true))} are not saved yet.</p>`,
                    actions: [
                        { label: 'Keep editing', kind: 'secondary', run: () => { answered = true; resolve(false); } },
                        { label: 'Discard changes', kind: 'danger', run: () => { answered = true; setDirty(false); resolve(true); } }
                    ]
                });
                const close = w.close; w.close = () => { close(); if (!answered) resolve(false); };
            });
        }

        async function pickDate(d) {
            if (d === date) return;
            if (!(await confirmLeave())) { dateIn.value = date || ''; return; }
            fillForm(d);
            totalIn.focus();
        }

        async function load(keepDate) {
            h.body.querySelector('[data-cal]').innerHTML = A.loading('Loading the month…');
            try {
                view = await api(monthPath(spotId, year, month));
            } catch (e) {
                if (e.status !== 401) h.body.querySelector('[data-cal]').innerHTML = A.failed(e.message);
                return;
            }
            drawMonth();
            const f = view.figures;
            let d = keepDate && keepDate.slice(0, 7) === keyOf(year, month) ? keepDate : null;
            if (!d) {
                const open = f.daily.filter(x => ['missing', 'scheduled', 'today'].includes(x.state));
                d = (open.find(x => x.state === 'today') || open[0] || f.daily.filter(x => !['future', 'before'].includes(x.state)).pop() || {}).date || null;
            }
            fillForm(d);
        }

        async function goMonth(delta) {
            if (!(await confirmLeave())) return;
            [year, month] = A.shiftMonth(year, month, delta);
            history.replaceState(null, '', `?month=${keyOf(year, month)}`);
            load();
        }
        $('[data-prev]').addEventListener('click', () => goMonth(-1));
        $('[data-next]').addEventListener('click', () => goMonth(1));
        dateIn.addEventListener('change', async () => {
            const d = dateIn.value;
            if (!d || d === date) return;
            if (!(await confirmLeave())) { dateIn.value = date || ''; return; }
            if (d.slice(0, 7) !== keyOf(year, month)) { [year, month] = ym(d); setDirty(false); history.replaceState(null, '', `?month=${keyOf(year, month)}`); return load(d); }
            fillForm(d);
        });
        allIns.forEach(el => el.addEventListener('input', () => { setDirty(true); showError(''); sums(); }));
        $('[data-discard]').addEventListener('click', () => { setDirty(false); fillForm(date); });

        form.addEventListener('submit', async e => {
            e.preventDefault();
            if (saving || formLocked()) return;
            const s = sums(), problems = [];
            const whole = el => el.value.trim() === '' || /^\d{1,6}$/.test(el.value.trim());
            if (s.total === null) problems.push('Enter the total number of visitors. Enter 0 only when no one came.');
            if (!allIns.every(whole)) problems.push('Use whole numbers from 0 to 100,000.');
            if (s.total !== null && s.total > 100000) problems.push('The total must be 100,000 or less.');
            if (s.total !== null && s.known > s.total) problems.push(`Residence adds up to ${nf(s.known)}, more than the total.`);
            if (s.total !== null && s.sexKnown > s.total) problems.push(`Male + female is ${nf(s.sexKnown)}, more than the total.`);
            if (problems.length) { showError(esc(problems.join(' '))); totalIn.focus(); return; }
            const row = dayRow(date), c = row && row.count;
            const body = { total: s.total, revision: c ? c.revision : 0, requestKey: pendingKey || (pendingKey = T.requestKey()) };
            if (s.total > 0 && s.anyRes) { body.residence = Object.fromEntries(resIns.map(el => [el.dataset.res, num(el)])); body.residenceComplete = s.known === s.total; }
            if (s.total > 0 && s.anySex) { body.sex = Object.fromEntries(sexIns.map(el => [el.dataset.sex, num(el)])); body.sexComplete = s.sexKnown === s.total; }
            saving = true;
            const btn = $('[data-save]'); btn.disabled = true; btn.setAttribute('aria-busy', 'true');
            const savedDate = date, wasNew = !c;
            try {
                await api(`/attraction-visits/${encodeURIComponent(spotId)}/days/${savedDate}`, { method: 'PUT', body });
                setDirty(false); pendingKey = null;
                await load(savedDate);
                const next = wasNew ? view.figures.daily.find(x => x.state === 'missing' || x.state === 'scheduled') : null;
                A.toast(`Saved: ${A.fmtDate(savedDate)}, ${s.total === 0 ? 'no visitors' : nf(s.total) + ' visitors'}.${next ? ` Next missing date: ${A.fmtDate(next.date)}.` : ''}`, 'success');
                if (next) { fillForm(next.date); totalIn.focus(); }
            } catch (err) {
                if (err.status === 401) return;
                if (err.status === 0) { showError(`<b>Not saved.</b> ${esc(err.message)} Your figures are still here: press Save again.`); return; }
                pendingKey = null;
                if (err.code === 'STALE') {
                    showError(`<b>Not saved.</b> ${esc(err.message)} <button type="button" class="underline font-bold" data-reload>Load the saved figures</button>`);
                    errBox.querySelector('[data-reload]').addEventListener('click', () => { setDirty(false); load(savedDate); });
                } else if (err.code === 'PERIOD_LOCKED' || err.code === 'CLOSED_DATE') {
                    showError(`<b>Not saved.</b> ${esc(err.message)}`);
                    setDirty(false);
                    const msg = errBox.innerHTML; await load(savedDate); showError(msg);
                } else showError(`<b>Not saved.</b> ${esc(err.message)}`);
            } finally {
                saving = false; btn.removeAttribute('aria-busy'); btn.disabled = formLocked();
            }
        });

        $('[data-zero]').addEventListener('click', async () => {
            if (!(await confirmLeave())) return;
            const open = view.figures.daily.filter(d => d.state === 'missing' || d.state === 'scheduled');
            const key = T.requestKey();
            A.openWindow({
                title: 'Record 0 for several dates',
                body: `<p>Tick only the dates when <b>nobody came</b>. A date nobody counted stays missing: leave it unticked and record it when the count is found.</p>
                    <div class="att-zero-list">${open.map(d => `<label class="inline-flex items-center gap-2 min-h-[40px]"><input type="checkbox" value="${d.date}" class="accent-primary w-4 h-4">
                        ${esc(`${A.weekday(d.date)} ${A.fmtDate(d.date)}`)}${d.state === 'scheduled' ? ' <span class="acc-note">usually closed</span>' : ''}</label>`).join('')}</div>`,
                actions: [
                    { label: 'Cancel', kind: 'cancel' },
                    { label: 'Record 0 for the ticked dates', kind: 'primary', run: async w => {
                        const dates = [...w.body.querySelectorAll('input:checked')].map(i => i.value);
                        if (!dates.length) throw new Error('Tick at least one date.');
                        await api(`/attraction-visits/${encodeURIComponent(spotId)}/days/confirm-zero`, { method: 'POST', body: { dates, requestKey: key } });
                        A.toast(`Recorded 0 for ${dates.length} date${dates.length === 1 ? '' : 's'}.`, 'success');
                        await load(date);
                    } }
                ]
            });
        });

        await load();
    }

    /* =================================================================
       The Monthly Report
       ================================================================= */
    async function report(host) {
        const h = await header(host, 'Monthly Report', '<a href="staff_register.html" class="btn btn-secondary min-h-[44px]"><span class="material-symbols-outlined !text-base">edit_calendar</span>Daily Visitor Record</a>');
        if (!h) return;
        const spotId = h.me.attraction._id, today = h.me.today;
        const months = monthRange(today, h.me.reportingFrom);
        const asked = new URLSearchParams(location.search).get('month');
        let current = asked && months.some(([y, m]) => keyOf(y, m) === asked) ? asked : keyOf(...(months[1] || months[0]));

        h.body.innerHTML = `
            <div class="glass-panel p-4 flex flex-wrap items-end gap-3">
                <label class="block"><span class="field-label">Month</span><select class="field w-56" data-month>${months.map(([y, m]) => `<option value="${keyOf(y, m)}">${esc(A.monthName(y, m))}</option>`).join('')}</select></label>
                <div data-pill class="min-h-[44px] flex items-center"></div>
                <div class="ml-auto flex flex-wrap gap-2" data-actions></div>
            </div>
            <div data-view class="space-y-5"></div>`;
        const sel = h.body.querySelector('[data-month]'), out = h.body.querySelector('[data-view]');
        sel.value = current;
        sel.addEventListener('change', () => { current = sel.value; history.replaceState(null, '', `?month=${current}`); load(); });

        function completenessHtml(f) {
            const lines = [];
            if (f.residenceUnrecorded) lines.push(`Residence not recorded for <b>${nf(f.residenceUnrecorded)}</b> visit${f.residenceUnrecorded === 1 ? '' : 's'}${f.residenceDays ? ` on ${nf(f.residenceDays.partial + f.residenceDays.none)} date${f.residenceDays.partial + f.residenceDays.none === 1 ? '' : 's'}` : ''}. They stay in the total and out of Domestic and Foreign.`);
            if (f.sexUnrecorded) lines.push(`Sex not recorded for <b>${nf(f.sexUnrecorded)}</b> visit${f.sexUnrecorded === 1 ? '' : 's'}.`);
            return lines.length ? `<div class="acc-banner acc-banner--warn"><span class="material-symbols-outlined" aria-hidden="true">info</span><span>${lines.join('<br>')}</span></div>` : '';
        }

        async function load() {
            out.innerHTML = A.loading('Working out the month…');
            const [y, m] = ym(current);
            let v;
            try { v = await api(monthPath(spotId, y, m)); }
            catch (e) { if (e.status !== 401) out.innerHTML = A.failed(e.message); return; }
            const st = v.state, f = v.figures;
            h.body.querySelector('[data-pill]').innerHTML = T.monthPill(st.state, st.version, st.missing);
            const canSubmit = st.state === 'ready' || (st.state === 'reopened' && f.complete && f.days && keyOf(y, m) < today.slice(0, 7));
            const actions = h.body.querySelector('[data-actions]');
            actions.innerHTML = `${canSubmit ? `<button type="button" class="btn btn-primary min-h-[44px]" data-submit><span class="material-symbols-outlined !text-base">send</span>${st.state === 'reopened' ? 'Submit correction' : 'Submit month'}</button>` : ''}
                <button type="button" class="btn btn-secondary min-h-[44px]" data-xl><span class="material-symbols-outlined !text-base">download</span>VAR 1 Excel</button>`;
            const showLive = !['submitted', 'finalized'].includes(st.state) || !v.versions.length;
            const shown = showLive ? f : (v.versions.find(x => x.version === st.version) || {}).figures || f;
            out.innerHTML = `${stateBanner(v, 'report')}
                ${st.state === 'reopened' && v.officialFigures ? `<p class="acc-note">Official figure while the correction is pending: <b>${nf(v.officialFigures.total)}</b> visits (version ${st.finalizedVersion}). Below: the corrected counts as they stand.</p>` : ''}
                <section class="glass-panel p-4 sm:p-5 space-y-4"><h2 class="acc-part">${esc(v.attraction.name)} · ${esc(A.monthName(y, m))}</h2>
                    ${T.tilesHtml(showLive ? f : Object.assign({}, shown, { days: f.days }))}
                    ${completenessHtml(shown)}
                    ${T.breakdownHtml(shown)}</section>
                <details class="glass-panel p-4 sm:p-5" ${st.state === 'incomplete' ? 'open' : ''}><summary class="cursor-pointer font-bold">Day by day (VAR 1)</summary><div class="mt-3">${T.var1Html(f.daily)}</div></details>
                <section class="glass-panel p-4 sm:p-5 space-y-3"><h2 class="acc-part">Versions</h2>
                    ${v.versions.length ? `<ul class="divide-y divide-outline-variant/30">${v.versions.slice().reverse().map(x => `<li class="py-3 flex flex-wrap items-start justify-between gap-3">
                        <div><b>Version ${x.version}</b>${st.finalizedVersion === x.version ? ' ' + T.monthPill('finalized') : ''} · ${nf(x.figures.total)} visits · ${esc(A.fmtWhen(x.submittedAt))}
                            ${x.reason ? `<span class="acc-sub">Reason: ${esc(x.reason)}</span>` : ''}${T.changesHtml(x.changes)}</div>
                        <button type="button" class="btn btn-secondary btn-sm min-h-[40px]" data-vxl="${x.version}"><span class="material-symbols-outlined !text-base">download</span>Excel v${x.version}</button></li>`).join('')}</ul>` : '<p class="acc-note">Nothing submitted yet.</p>'}
                    <h3 class="font-bold text-sm pt-2">History</h3>${T.historyHtml(v.events)}</section>`;
            const xl = which => A.download(`${monthPath(spotId, y, m)}/export.xlsx?version=${which}`, `VAR1_${current}.xlsx`).catch(e => A.toast(e.message, 'error'));
            actions.querySelector('[data-xl]').addEventListener('click', () => xl(v.versions.length && !['reopened'].includes(st.state) ? 'latest' : 'current'));
            out.querySelectorAll('[data-vxl]').forEach(b => b.addEventListener('click', () => xl(b.dataset.vxl)));
            const sb = actions.querySelector('[data-submit]');
            if (sb) sb.addEventListener('click', () => submitWindow(v, y, m));
        }

        function submitWindow(v, y, m) {
            const f = v.figures, st = v.state, correction = st.state === 'reopened';
            const prev = correction ? v.versions.find(x => x.version === st.version) : null;
            const breakdown = [];
            if (f.residenceUnrecorded) breakdown.push(`Residence not recorded for ${nf(f.residenceUnrecorded)} visits.`);
            if (f.sexUnrecorded) breakdown.push(`Sex not recorded for ${nf(f.sexUnrecorded)} visits.`);
            A.openWindow({
                title: correction ? `Submit the correction for ${A.monthName(y, m)}?` : `Submit ${A.monthName(y, m)}?`,
                body: `<dl class="att-dl">
                        <dt>Attraction</dt><dd>${esc(v.attraction.name)}</dd>
                        <dt>Period</dt><dd>1–${f.days} ${esc(A.monthName(y, m))}</dd>
                        <dt>Total visits</dt><dd><b>${nf(f.total)}</b>${prev ? ` <span class="acc-note">(version ${prev.version}: ${nf(prev.figures.total)})</span>` : ''}</dd>
                        <dt>Dates</dt><dd>${nf(f.counted)} counted · ${nf(f.zero)} confirmed 0 · ${nf(f.closed)} authorized closure${f.closed === 1 ? '' : 's'}</dd>
                        <dt>Breakdowns</dt><dd>${breakdown.length ? `<span class="text-error font-bold">Incomplete.</span> ${esc(breakdown.join(' '))}` : 'Residence and sex recorded for every visitor.'}</dd></dl>
                    ${correction ? `<label class="block"><span class="field-label">What was corrected, and why</span><textarea class="field" rows="3" maxlength="300" data-reason required></textarea></label>` : ''}
                    <p class="acc-note">Once submitted, the daily counts are locked until the Tourism Office reopens the month.</p>`,
                actions: [
                    { label: 'Cancel', kind: 'cancel' },
                    { label: correction ? 'Submit correction' : 'Submit', kind: 'primary', run: async w => {
                        const body = { expectedVersion: st.version || 0 };
                        if (correction) {
                            body.reason = w.body.querySelector('[data-reason]').value.trim();
                            if (body.reason.length < 3) throw new Error('Say what was corrected.');
                        }
                        try {
                            await api(`${monthPath(spotId, y, m)}/submit`, { method: 'POST', body });
                        } catch (e) {
                            if (['STALE', 'ALREADY_SUBMITTED', 'MONTH_INCOMPLETE', 'PERIOD_FINALIZED'].includes(e.code)) { load(); }
                            throw e;
                        }
                        A.toast(`${A.monthName(y, m)} submitted: ${nf(f.total)} visits.`, 'success');
                        load();
                    } }
                ]
            });
        }

        load();
    }

    window.ztimsAttStaff = { record, report };
})();
