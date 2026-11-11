/* The stay register of a private place to stay: Guest Register → Stays and
 * Daily register (DAE-1A). Mounted by resort_register.html when the current
 * enterprise is a place to stay (window.ztimsAccRegister.mount(el, spot)).
 * Needs acc-common.js. Every rule is the server's; this page only asks.
 */
(function () {
    const A = () => window.ztimsAcc;
    let root, spot, rooms = [], year, month, view = null, stays = [], filter = 'all', tab = 'stays';

    const roomNo = id => { const r = rooms.find(x => x._id === id); return r ? r.roomNumber : '?'; };
    const guestsOf = s => s.guests.reduce((a, g) => a + g.male + g.female, 0);
    const nightsOf = s => Math.round((Date.parse(s.checkOut) - Date.parse(s.checkIn)) / 864e5);
    const roomsText = s => s.rooms.map((r, i) => (i ? ' → ' : '') + roomNo(r.roomId) + (i && r.from > s.checkIn ? ` (from ${A().fmtDate(r.from)})` : '')).join('');

    function mount(el, current) {
        root = el; spot = current;
        const t = A().manilaToday();
        const q = new URLSearchParams(location.search).get('month');
        if (q && /^\d{4}-\d{2}$/.test(q)) { year = +q.slice(0, 4); month = +q.slice(5); } else { year = +t.slice(0, 4); month = +t.slice(5, 7); }
        tab = location.hash === '#daily' ? 'daily' : 'stays';
        root.innerHTML = `
            <div class="acc-head">
                <h1 class="text-3xl sm:text-4xl font-black font-headline tracking-tighter text-on-surface">Guest Register</h1>
                <div class="acc-head__actions"><button type="button" class="btn btn-primary min-h-[44px]" data-acc="new">
                    <span class="material-symbols-outlined !text-base" aria-hidden="true">add</span>Record a stay</button></div>
            </div>
            <div class="acc-bar">
                <div class="acc-month" role="group" aria-label="Month">
                    <button type="button" class="acc-iconbtn" data-acc="prev" aria-label="Previous month"><span class="material-symbols-outlined">chevron_left</span></button>
                    <span class="acc-month__name" aria-live="polite"></span>
                    <button type="button" class="acc-iconbtn" data-acc="next" aria-label="Next month"><span class="material-symbols-outlined">chevron_right</span></button>
                </div>
                <span class="acc-state"></span>
            </div>
            <div role="tablist" aria-label="Guest Register" class="flex gap-2 border-b border-outline-variant/30">
                <button role="tab" class="settings-tab" data-tab="stays" aria-selected="true"><span class="material-symbols-outlined !text-base" aria-hidden="true">groups</span>Stays</button>
                <button role="tab" class="settings-tab" data-tab="daily" aria-selected="false"><span class="material-symbols-outlined !text-base" aria-hidden="true">table_view</span>Daily register (DAE-1A)</button>
            </div>
            <div class="acc-body"></div>`;
        root.addEventListener('click', onClick);
        window.addEventListener('hashchange', () => { const t2 = location.hash === '#daily' ? 'daily' : 'stays'; if (t2 !== tab) { tab = t2; draw(); } });
        load().then(openFromBooking);
    }

    async function load() {
        const body = root.querySelector('.acc-body');
        root.querySelector('.acc-month__name').textContent = A().monthName(year, month);
        body.innerHTML = A().loading('Loading the register…');
        try {
            const key = A().monthKey(year, month);
            const [r, v, s] = await Promise.all([
                A().api(`/accommodation/${spot._id}/rooms`),
                A().api(`/accommodation/${spot._id}/months/${year}/${month}`),
                A().api(`/accommodation/${spot._id}/stays?month=${key}`),
                A().loadResidences()
            ]);
            rooms = r.rooms; view = v; stays = s.stays;
            draw();
        } catch (e) {
            if (e.message === 'Signed out') return;
            body.innerHTML = A().failed(e.message, true);
        }
    }

    function draw() {
        root.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
        root.querySelector('.acc-state').innerHTML = view ? A().statePill(view.state.state, view.state.latestVersion) + (view.finalizedAt ? ` <span class="tone-pill rounded-pill acc-pill tone-neutral acc-pill--lock"><span class="material-symbols-outlined" aria-hidden="true">lock</span>Register locked</span>` : '') : '';
        const body = root.querySelector('.acc-body');
        if (!view.profile.reportingFrom || !rooms.length) {
            body.innerHTML = `<div class="ztims-empty"><p class="font-bold text-on-surface">Set up reporting first.</p>
                <p class="mt-1">${!rooms.length ? 'Add the room numbers under Rooms → Room numbers.' : ''} ${!view.profile.reportingFrom ? 'Set the month reporting starts under Enterprise → Reporting.' : ''}</p>
                <div class="flex flex-wrap justify-center gap-2 mt-3">${!rooms.length ? '<a class="btn btn-secondary btn-sm" href="resort_rooms.html#numbers">Room numbers</a>' : ''}${!view.profile.reportingFrom ? '<a class="btn btn-secondary btn-sm" href="resort_spots.html#reporting">Reporting</a>' : ''}</div></div>`;
            return;
        }
        body.innerHTML = tab === 'daily' ? dailyHtml() : staysHtml();
    }

    function banner() {
        const s = view.state.state;
        if (s === 'finalized') return `<div class="acc-banner acc-banner--lock"><span class="material-symbols-outlined" aria-hidden="true">lock</span><div><b>${A().monthName(year, month)} is finalized.</b> Stays with an arrival or a night in it cannot change until the Tourism Office reopens it.</div></div>`;
        if (s === 'reopened') return `<div class="acc-banner acc-banner--warn"><span class="material-symbols-outlined" aria-hidden="true">lock_open</span><div><b>Reopened by the Tourism Office.</b> Correct the stays, then submit the month again on Monthly Report.</div></div>`;
        if (s === 'changed') return `<div class="acc-banner acc-banner--warn"><span class="material-symbols-outlined" aria-hidden="true">edit_note</span><div><b>Changed since version ${view.state.latestVersion}.</b> Submit the correction on <a href="resort_statistics.html?month=${A().monthKey(year, month)}">Monthly Report</a>.</div></div>`;
        if (view.figures.partial) return `<p class="text-support">Month to date: nights through ${A().fmtDate(view.figures.through)}.</p>`;
        return '';
    }

    function staysHtml() {
        const f = view.figures, key = A().monthKey(year, month);
        let list = stays.slice().sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.reference.localeCompare(b.reference));
        const carried = s => s.checkIn.slice(0, 7) < key;
        if (filter === 'arrived') list = list.filter(s => !carried(s));
        if (filter === 'carried') list = list.filter(carried);
        const sex = s => { const m = s.guests.reduce((a, g) => a + g.male, 0), w = s.guests.reduce((a, g) => a + g.female, 0); return `${m} male, ${w} female`; };
        const where = s => [...new Set(s.guests.map(g => A().residenceName(g.residence)))].join(', ');
        return `${banner()}
            <div class="stat-tiles">
                <div class="stat-tile"><p>Guests arrived</p><p>${A().nf(f.arrivals)}</p></div>
                <div class="stat-tile"><p>Guest-nights</p><p>${A().nf(f.guestNights)}</p></div>
                <div class="stat-tile"><p>Room-nights occupied</p><p>${A().nf(f.roomNightsOccupied)}<span class="acc-of"> of ${A().nf(f.roomNightsAvailable)}</span></p></div>
                <div class="stat-tile"><p>Stays</p><p>${stays.length}</p></div>
            </div>
            <div class="dest-chips" role="group" aria-label="Show">
                ${[['all', 'All stays'], ['arrived', 'Arrived this month'], ['carried', 'Continuing from earlier']].map(([k, l]) =>
                    `<button type="button" class="dest-chip" data-filter="${k}" aria-pressed="${filter === k}">${l}</button>`).join('')}
            </div>
            <section class="glass-panel">
                ${list.length ? `<div class="divide-y divide-outline-variant/20">${list.map(s => `
                    <div class="acc-stay${carried(s) ? ' acc-stay--carried' : ''}">
                        <div class="acc-stay__ref">${A().esc(s.reference)}</div>
                        <div class="min-w-0"><b>${A().fmtDate(s.checkIn)} → ${A().fmtDate(s.checkOut)}</b> · ${nightsOf(s)} night${nightsOf(s) === 1 ? '' : 's'}
                            <span class="acc-sub">Room ${A().esc(roomsText(s))}</span></div>
                        <div class="min-w-0"><b>${guestsOf(s)} guest${guestsOf(s) === 1 ? '' : 's'}</b><span class="acc-sub">${sex(s)}</span></div>
                        <div class="min-w-0 acc-stay__where"><span>${A().esc(where(s))}</span>${carried(s) ? `<span class="acc-sub">Arrived ${A().fmtDate(s.checkIn)}; nights count here</span>` : ''}</div>
                        <div class="acc-stay__go"><button type="button" class="btn btn-secondary btn-sm min-h-[40px]" data-open="${A().esc(s._id)}">Open</button></div>
                    </div>`).join('')}</div>`
                : `<div class="p-4"><div class="ztims-empty">No stays ${filter === 'all' ? '' : 'of this kind '}in ${A().monthName(year, month)}.</div></div>`}
            </section>`;
    }

    function dailyHtml() {
        const f = view.figures;
        const ids = [...new Set(f.daily.flatMap(d => d.occupiedRooms).concat(rooms.filter(r => r.availableFrom <= A().monthKey(year, month) + '-31' && (!r.availableUntil || r.availableUntil > A().monthKey(year, month) + '-01')).map(r => r._id)))];
        ids.sort((a, b) => String(roomNo(a)).localeCompare(String(roomNo(b)), undefined, { numeric: true }));
        const today = A().manilaToday();
        const arrivalsIn = (d, id) => stays.some(s => s.guests.some(g => g.from === d.date) && s.rooms.some(r => r.roomId === id && r.from <= d.date && d.date < r.until));
        const rows = f.daily.map(d => {
            const fut = d.date > today;
            return `<tr class="${fut ? 'acc-fut' : ''}${d.closed ? ' acc-closed' : ''}">
                <th scope="row" class="acc-sticky">${+d.date.slice(8)} <span class="text-on-surface-variant font-normal">${A().weekday(d.date)}</span></th>
                ${ids.map(id => `<td class="acc-mk${d.occupiedRooms.includes(id) && arrivalsIn(d, id) ? ' acc-mk--in' : ''}">${d.occupiedRooms.includes(id) ? '<span class="acc-dot" title="Occupied"></span>' : ''}</td>`).join('')}
                <td class="text-right${d.checkIn ? ' acc-mk--in' : ''}">${fut ? '' : d.checkIn || ''}</td>
                <td class="text-right">${d.counted ? d.guestNights : ''}</td>
                <td class="text-right">${d.counted ? d.roomsOccupied : ''}</td>
                <td class="text-right text-on-surface-variant">${d.counted ? (d.closed ? 'closed' : d.available) : ''}</td></tr>`;
        }).join('');
        return `${banner()}
            <div class="flex flex-wrap items-center justify-between gap-3">
                <p class="text-support"><b class="text-on-surface">Form DAE-1A</b> · (4) Total number of rooms: <b class="text-on-surface">${f.rooms}</b></p>
                <button type="button" class="btn btn-secondary btn-sm min-h-[40px]" data-acc="export"><span class="material-symbols-outlined !text-base" aria-hidden="true">download</span>Excel (register now)</button>
            </div>
            <section class="glass-panel p-3 sm:p-4"><div class="acc-scroll"><table class="acc-grid">
                <thead><tr><th class="acc-sticky" rowspan="2">Day</th><th colspan="${ids.length}">Room identification</th>
                    <th rowspan="2" class="text-right">(5) Guests<br>checked in</th><th rowspan="2" class="text-right">(6) Guests staying<br>overnight</th>
                    <th rowspan="2" class="text-right">(7) Rooms<br>occupied</th><th rowspan="2" class="text-right">Rooms<br>available</th></tr>
                    <tr>${ids.map(id => `<th class="text-center">${A().esc(roomNo(id))}</th>`).join('')}</tr></thead>
                <tbody>${rows}</tbody>
                <tfoot><tr><th class="acc-sticky">Total of this month</th><td colspan="${ids.length}"></td><td class="text-right">${f.arrivals}</td><td class="text-right">${f.guestNights}</td><td class="text-right">${f.roomNightsOccupied}</td><td class="text-right">${f.roomNightsAvailable}</td></tr></tfoot>
            </table></div>
            <p class="text-support mt-3"><span class="acc-dot"></span> occupied · highlighted: guests checked in that day.</p></section>
            <div class="stat-tiles">
                <div class="stat-tile"><p>Average guest-nights</p><p>${A().dec(f.averageLengthOfStay)}</p></div>
                <div class="stat-tile"><p>Average room occupancy rate</p><p>${A().pct(f.occupancyRate)}</p></div>
                <div class="stat-tile"><p>Average guests per room</p><p>${A().dec(f.guestsPerRoom)}</p></div>
            </div>`;
    }

    async function onClick(e) {
        const t = e.target.closest('[data-acc],[data-tab],[data-filter],[data-open],[data-acc-retry]');
        if (!t || !root.contains(t)) return;
        if (t.dataset.accRetry !== undefined) return load();
        if (t.dataset.tab) { tab = t.dataset.tab; history.replaceState(null, '', '#' + tab); return draw(); }
        if (t.dataset.filter) { filter = t.dataset.filter; return draw(); }
        if (t.dataset.open) return openStay(t.dataset.open);
        const a = t.dataset.acc;
        if (a === 'prev' || a === 'next') { [year, month] = A().shiftMonth(year, month, a === 'prev' ? -1 : 1); return load(); }
        if (a === 'new') return stayForm(null);
        if (a === 'export') {
            try { await A().download(`/accommodation/${spot._id}/months/${year}/${month}/export.xlsx?version=current`, 'register.xlsx'); A().toast('Excel downloaded'); }
            catch (err) { A().toast(err.message, 'error'); }
        }
    }

    /* ---- one stay ---------------------------------------------------------- */
    async function openStay(id) {
        let data;
        try { data = await A().api(`/accommodation/stays/${encodeURIComponent(id)}`); }
        catch (e) { return A().toast(e.message, 'error'); }
        const s = data.stay, locked = data.lockedMonths || [];
        const hist = (data.changes || []).slice().reverse().map(c => `<li><span class="text-on-surface-variant">${A().fmtWhen(c.at)}</span> <b>${({ created: 'Recorded', edited: 'Changed', voided: 'Voided' })[c.action] || A().esc(c.action)}</b>${c.reason ? ' · ' + A().esc(c.reason) : ''}${c.affected_months && c.affected_months.length ? ` <span class="text-on-surface-variant">(${c.affected_months.map(m => A().monthName(+m.slice(0, 4), +m.slice(5))).join(', ')})</span>` : ''}</li>`).join('');
        const win = A().openWindow({
            title: 'Stay ' + s.reference, wide: true,
            body: `<dl class="est-facts">
                    <div class="est-fact"><dt>Check-in</dt><dd>${A().fmtDate(s.checkIn, true)}</dd></div>
                    <div class="est-fact"><dt>Check-out</dt><dd>${A().fmtDate(s.checkOut, true)}${s.checkOut > A().manilaToday() ? ' (expected)' : ''}</dd></div>
                    <div class="est-fact"><dt>Nights</dt><dd>${nightsOf(s)}</dd></div>
                    <div class="est-fact"><dt>Rooms</dt><dd>${A().esc(roomsText(s))}</dd></div></dl>
                <div class="acc-scroll"><table class="ztims-table acc-table"><thead><tr><th>Residence</th><th class="text-right">Male</th><th class="text-right">Female</th><th>Here</th></tr></thead>
                    <tbody>${s.guests.map(g => `<tr><td>${A().esc(A().residenceName(g.residence))}</td><td class="text-right">${g.male}</td><td class="text-right">${g.female}</td><td>${A().fmtDate(g.from)} → ${A().fmtDate(g.until)}</td></tr>`).join('')}</tbody></table></div>
                <p class="text-support">Counts in: ${data.months.map(m => A().monthName(+m.slice(0, 4), +m.slice(5))).join(', ')}</p>
                ${s.status !== 'active' ? `<div class="acc-banner acc-banner--bad"><span class="material-symbols-outlined" aria-hidden="true">block</span><div><b>Voided.</b> ${A().esc(s.voidReason || '')} It no longer counts.</div></div>` : ''}
                ${locked.length ? `<div class="acc-banner acc-banner--lock"><span class="material-symbols-outlined" aria-hidden="true">lock</span><div><b>Locked.</b> ${locked.map(m => A().monthName(+m.slice(0, 4), +m.slice(5))).join(' and ')} ${locked.length === 1 ? 'is' : 'are'} finalized. This stay cannot change until the Tourism Office reopens ${locked.length === 1 ? 'it' : 'them'}.</div></div>` : ''}
                <div><p class="field-label">History</p><ul class="acc-history">${hist}</ul></div>`,
            actions: locked.length || s.status !== 'active' ? [{ label: 'Close' }] : [
                { label: 'Void', kind: 'danger', run: () => { win.close(); voidStay(s); return false; } },
                { label: 'Transfer room', run: () => { win.close(); transfer(s); return false; } },
                { label: 'Change check-out', run: () => { win.close(); changeOut(s); return false; } },
                { label: 'Edit', kind: 'primary', run: () => { win.close(); stayForm(s); return false; } }
            ]
        });
    }

    const reasonField = (id) => `<label class="block"><span class="field-label">Reason</span>
        <select id="${id}" class="field"><option>Correction of a mistake</option><option>Guest extended the stay</option><option>Guest left early</option><option>Guests joined or left</option><option>Room problem</option><option>Other</option></select></label>
        <label class="block" id="${id}OtherWrap" hidden><span class="field-label">Describe the reason</span><input id="${id}Other" class="field" maxlength="300"/></label>`;
    const wireReason = (win, id) => { const s = win.el.querySelector('#' + id); s.addEventListener('change', () => { win.el.querySelector('#' + id + 'OtherWrap').hidden = s.value !== 'Other'; }); };
    const readReason = (win, id) => { const v = win.el.querySelector('#' + id).value; if (v !== 'Other') return v; const o = win.el.querySelector('#' + id + 'Other').value.trim(); if (o.length < 3) throw new Error('Describe the reason.'); return o; };

    function afterSave(result, verb) {
        const changed = (result.affected || []).filter(a => a.state === 'changed' || a.state === 'reopened');
        A().toast(verb + (changed.length ? ` ${changed.map(a => A().monthName(+a.month.slice(0, 4), +a.month.slice(5))).join(', ')}: submit the correction.` : ''));
        load();
    }
    const payloadOf = s => ({ checkIn: s.checkIn, checkOut: s.checkOut, revision: s.revision,
        rooms: s.rooms.map(r => ({ roomId: r.roomId, from: r.from, until: r.until })),
        guests: s.guests.map(g => ({ residence: g.residence, male: g.male, female: g.female, from: g.from, until: g.until })) });

    function transfer(s) {
        const nights = []; for (let d = s.checkIn; d < s.checkOut; d = A().addDays(d, 1)) nights.push(d);
        const win = A().openWindow({
            title: 'Transfer room · ' + s.reference,
            body: `<div class="grid sm:grid-cols-2 gap-4">
                <label class="block"><span class="field-label">Moves on</span><select id="trDay" class="field">${nights.slice(1).concat(nights.length === 1 ? nights : []).map(d => `<option value="${d}">${A().fmtDate(d, true)}</option>`).join('')}</select></label>
                <label class="block"><span class="field-label">To room</span><select id="trRoom" class="field">${rooms.map(r => `<option value="${A().esc(r._id)}">${A().esc(r.roomNumber)}${r.label ? ' · ' + A().esc(r.label) : ''}</option>`).join('')}</select></label></div>
                ${reasonField('trWhy')}`,
            onOpen: w => wireReason(w, 'trWhy'),
            actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Transfer', kind: 'primary', run: async w => {
                const day = w.el.querySelector('#trDay').value, to = w.el.querySelector('#trRoom').value, reason = readReason(w, 'trWhy');
                const p = payloadOf(s), segs = [];
                for (const r of p.rooms) {
                    if (r.until <= day) segs.push(r); else if (r.from >= day) segs.push({ roomId: to, from: r.from, until: r.until });
                    else { segs.push({ roomId: r.roomId, from: r.from, until: day }); segs.push({ roomId: to, from: day, until: r.until }); }
                }
                p.rooms = segs; p.reason = reason;
                const res = await A().api(`/accommodation/stays/${s._id}`, { method: 'PUT', body: p });
                afterSave(res, 'Room transferred. No new arrival counted.');
            } }]
        });
    }

    function changeOut(s) {
        const win = A().openWindow({
            title: 'Change check-out · ' + s.reference,
            body: `<label class="block"><span class="field-label">Check-out</span><input id="coDay" type="date" class="field" value="${s.checkOut}" min="${A().addDays(s.checkIn, 1)}"/></label>${reasonField('coWhy')}`,
            onOpen: w => wireReason(w, 'coWhy'),
            actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Save check-out', kind: 'primary', run: async w => {
                const day = w.el.querySelector('#coDay').value, reason = readReason(w, 'coWhy');
                if (!day || day === s.checkOut) throw new Error('Choose a different date.');
                const p = payloadOf(s);
                p.rooms = p.rooms.filter(r => r.from < day).map(r => (day > s.checkOut ? (r.until === s.checkOut ? { ...r, until: day } : r) : { ...r, until: r.until > day ? day : r.until }));
                p.guests = p.guests.filter(g => g.from < day).map(g => (day > s.checkOut ? (g.until === s.checkOut ? { ...g, until: day } : g) : { ...g, until: g.until > day ? day : g.until }));
                p.checkOut = day; p.reason = reason;
                const res = await A().api(`/accommodation/stays/${s._id}`, { method: 'PUT', body: p });
                afterSave(res, day > s.checkOut ? 'Stay extended.' : 'Check-out moved earlier.');
            } }]
        });
    }

    function voidStay(s) {
        A().openWindow({
            title: 'Void stay ' + s.reference + '?',
            body: `<p>The stay is kept but stops counting. Use this only for a stay recorded by mistake.</p>
                <label class="block"><span class="field-label">Reason</span><input id="vdWhy" class="field" maxlength="300" required/></label>`,
            actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Void stay', kind: 'danger', run: async w => {
                const reason = w.el.querySelector('#vdWhy').value.trim();
                if (reason.length < 3) throw new Error('Give the reason.');
                const res = await A().api(`/accommodation/stays/${s._id}/void`, { method: 'POST', body: { reason, revision: s.revision } });
                afterSave(res, 'Stay voided.');
            } }]
        });
    }

    /* Record or edit: dates, room periods, guest groups with their dates. */
    function stayForm(old, prefill) {
        const t = A().manilaToday();
        const fs = old ? JSON.parse(JSON.stringify(payloadOf(old))) : {
            checkIn: (prefill && prefill.checkIn) || t, checkOut: (prefill && prefill.checkOut) || A().addDays(t, 1),
            rooms: [{ roomId: rooms[0] ? rooms[0]._id : '', from: null, until: null }],
            guests: [{ residence: (prefill && prefill.residence) || 'ph-filipino', male: 0, female: 0, from: null, until: null }]
        };
        if (!old) { fs.rooms.forEach(r => { r.from = fs.checkIn; r.until = fs.checkOut; }); fs.guests.forEach(g => { g.from = fs.checkIn; g.until = fs.checkOut; }); }
        const opts = (list, value, key, label) => list.map(x => `<option value="${A().esc(x[key])}"${x[key] === value ? ' selected' : ''}>${A().esc(x[label])}</option>`).join('');
        let resList = [];
        const draw = w => {
            const single = fs.rooms.length === 1, sameGuests = fs.guests.every(g => g.from === fs.checkIn && g.until === fs.checkOut);
            w.body.innerHTML = `
                ${prefill && prefill.note ? `<p class="tone-pill tone-info rounded-pill inline-flex px-3 py-1 text-sm font-bold">${A().esc(prefill.note)}</p>` : ''}
                <div class="grid sm:grid-cols-2 gap-4">
                    <label class="block"><span class="field-label">Check-in</span><input data-f="checkIn" type="date" class="field" max="${t}" value="${fs.checkIn}"/></label>
                    <label class="block"><span class="field-label">Check-out</span><input data-f="checkOut" type="date" class="field" value="${fs.checkOut}"/></label>
                </div>
                <div><p class="field-label">Rooms</p><div class="space-y-2">${fs.rooms.map((r, i) => `
                    <div class="acc-formrow">
                        <label class="block"><span class="sr-only">Room</span><select data-r="${i}.roomId" class="field">${rooms.map(x => `<option value="${A().esc(x._id)}"${x._id === r.roomId ? ' selected' : ''}>${A().esc(x.roomNumber)}${x.label ? ' · ' + A().esc(x.label) : ''} (sleeps ${x.sleeps})</option>`).join('')}</select></label>
                        ${single ? '' : `<label class="block"><span class="field-label">From</span><input data-r="${i}.from" type="date" class="field" value="${r.from}"/></label>
                        <label class="block"><span class="field-label">Until</span><input data-r="${i}.until" type="date" class="field" value="${r.until}"/></label>
                        <button type="button" class="btn btn-cancel btn-sm" data-x="room" data-i="${i}">Remove</button>`}
                    </div>`).join('')}</div>
                    <button type="button" class="btn btn-secondary btn-sm mt-2" data-x="addroom"><span class="material-symbols-outlined !text-base" aria-hidden="true">add</span>Another room</button></div>
                <div><p class="field-label">Guests</p><div class="space-y-2">${fs.guests.map((g, i) => `
                    <div class="acc-formrow acc-formrow--guest">
                        <label class="block"><span class="sr-only">Residence</span><select data-g="${i}.residence" class="field">${opts(resList, g.residence, 'code', 'name')}</select></label>
                        <label class="block"><span class="field-label">Male</span><input data-g="${i}.male" type="number" min="0" max="999" step="1" class="field acc-num" value="${g.male}"/></label>
                        <label class="block"><span class="field-label">Female</span><input data-g="${i}.female" type="number" min="0" max="999" step="1" class="field acc-num" value="${g.female}"/></label>
                        ${sameGuests && fs.guests.length === 1 ? '' : `<label class="block"><span class="field-label">Arrived</span><input data-g="${i}.from" type="date" class="field" value="${g.from}"/></label>
                        <label class="block"><span class="field-label">Left</span><input data-g="${i}.until" type="date" class="field" value="${g.until}"/></label>`}
                        ${fs.guests.length > 1 ? `<button type="button" class="btn btn-cancel btn-sm" data-x="guest" data-i="${i}">Remove</button>` : ''}
                    </div>`).join('')}</div>
                    <button type="button" class="btn btn-secondary btn-sm mt-2" data-x="addguest"><span class="material-symbols-outlined !text-base" aria-hidden="true">add</span>Another residence or a guest who joined later</button></div>
                <p class="text-support" data-total></p>
                ${old ? reasonField('sfWhy') : ''}`;
            if (old) wireReason(w, 'sfWhy');
            total(w);
        };
        const total = w => {
            const n = fs.guests.reduce((a, g) => a + (+g.male || 0) + (+g.female || 0), 0);
            const nights = Math.max(0, Math.round((Date.parse(fs.checkOut) - Date.parse(fs.checkIn)) / 864e5));
            const el = w.body.querySelector('[data-total]');
            if (el) el.textContent = `${n} guest${n === 1 ? '' : 's'} · ${nights} night${nights === 1 ? '' : 's'}. The night of check-out is not counted.`;
        };
        // One room and one guest group follow the stay's dates; with several,
        // their dates are kept and only pulled inside the stay.
        let lastIn = fs.checkIn, lastOut = fs.checkOut;
        const sync = () => {
            if (fs.rooms.length === 1) { fs.rooms[0].from = fs.checkIn; fs.rooms[0].until = fs.checkOut; }
            for (const list of [fs.rooms, fs.guests]) for (const x of list) {
                if (x.from === lastIn || x.from < fs.checkIn) x.from = fs.checkIn;
                if (x.until === lastOut || x.until > fs.checkOut) x.until = fs.checkOut;
            }
            lastIn = fs.checkIn; lastOut = fs.checkOut;
        };
        const win = A().openWindow({
            title: old ? 'Edit stay ' + old.reference : 'Record a stay', wide: true, body: A().loading(),
            onOpen: async w => {
                resList = await A().loadResidences();
                draw(w);
                w.el.addEventListener('input', e => {
                    const x = e.target;
                    if (x.dataset.f) { fs[x.dataset.f] = x.value; if (x.dataset.f === 'checkIn' && fs.checkOut <= fs.checkIn) fs.checkOut = A().addDays(fs.checkIn, 1); sync(); }
                    else if (x.dataset.r) { const [i, k] = x.dataset.r.split('.'); fs.rooms[+i][k] = x.value; }
                    else if (x.dataset.g) { const [i, k] = x.dataset.g.split('.'); fs.guests[+i][k] = k === 'male' || k === 'female' ? Math.max(0, Math.floor(+x.value || 0)) : x.value; }
                    total(w);
                });
                w.el.addEventListener('change', e => { if (e.target.dataset.f) draw(w); });
                w.el.addEventListener('click', e => {
                    const b = e.target.closest('[data-x]'); if (!b) return;
                    const i = +b.dataset.i;
                    if (b.dataset.x === 'addroom') { fs.rooms.push({ roomId: rooms[0]._id, from: fs.checkIn, until: fs.checkOut }); }
                    if (b.dataset.x === 'room') fs.rooms.splice(i, 1);
                    if (b.dataset.x === 'addguest') fs.guests.push({ residence: 'ph-filipino', male: 0, female: 0, from: fs.checkIn, until: fs.checkOut });
                    if (b.dataset.x === 'guest') fs.guests.splice(i, 1);
                    draw(w);
                });
            },
            actions: [{ label: 'Cancel', kind: 'cancel' }, { label: old ? 'Save changes' : 'Save stay', kind: 'primary', run: async w => {
                const body = { checkIn: fs.checkIn, checkOut: fs.checkOut, rooms: fs.rooms.map(r => ({ roomId: r.roomId, from: r.from, until: r.until })),
                               guests: fs.guests.map(g => ({ residence: g.residence, male: +g.male, female: +g.female, from: g.from, until: g.until })) };
                if (!body.guests.some(g => g.male + g.female > 0)) throw new Error('Add at least one guest.');
                body.guests = body.guests.filter(g => g.male + g.female > 0);
                if (prefill && prefill.bookingId) body.bookingId = prefill.bookingId;
                let res;
                if (old) { body.reason = readReason(w, 'sfWhy'); body.revision = old.revision; res = await A().api(`/accommodation/stays/${old._id}`, { method: 'PUT', body }); }
                else res = await A().api(`/accommodation/${spot._id}/stays`, { method: 'POST', body });
                [year, month] = [+fs.checkIn.slice(0, 4), +fs.checkIn.slice(5, 7)];
                afterSave(res, old ? 'Stay saved.' : `Stay ${res.stay.reference} recorded.`);
            } }]
        });
        return win;
    }

    /* Bookings → Check in opens this page at ?booking=<id>: the stay form,
       filled from the booking; the manager splits male and female. */
    async function openFromBooking() {
        const id = new URLSearchParams(location.search).get('booking');
        if (!id) return;
        history.replaceState(null, '', location.pathname + location.hash);
        try {
            const b = await A().api(`/bookings/manage/item/${encodeURIComponent(id)}`);
            if (!['checked_in', 'completed'].includes(b.status)) return A().toast('Check the guest in on Bookings first.', 'info');
            const n = (b.adults || 0) + (b.children || 0);
            stayForm(null, { bookingId: b._id || id, checkIn: b.checkIn, checkOut: b.checkOut, residence: b.countryCode || b.country || 'ph-filipino',
                             note: `From booking ${b.code}: the booking says ${n} guest${n === 1 ? '' : 's'}.` });
        } catch (e) { if (e.message !== 'Signed out') A().toast(e.message, 'error'); }
    }

    window.ztimsAccRegister = { mount };
})();
