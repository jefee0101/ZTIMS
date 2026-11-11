/* Setting up a place to stay for reporting:
 *   rooms(el, spot)    Rooms → Room numbers: numbered rooms, out of service,
 *                      and the month's availability night by night
 *   profile(el, spot)  Enterprise → Reporting: the DAE-1B header facts, the
 *                      month reporting starts, closed periods
 * Needs acc-common.js. The server refuses anything that would change a
 * finalized month; its message is shown as it comes.
 */
(function () {
    const A = () => window.ztimsAcc;
    const TYPES = [['', 'Choose'], ['hotel', 'Hotel'], ['resort', 'Resort'], ['pension', 'Pension inn / lodge'], ['hostel', 'Youth hostel / dormitory'], ['apartel', 'Apartel / rented homes / apartment'], ['other', 'Others']];

    /* ---- Rooms → Room numbers --------------------------------------------- */
    function rooms(el, spot) {
        let data = null, stays = [], y, m;
        const t = A().manilaToday(); y = +t.slice(0, 4); m = +t.slice(5, 7);
        async function load() {
            el.innerHTML = A().loading('Loading rooms…');
            try {
                data = await A().api(`/accommodation/${spot._id}/rooms`);
                stays = (await A().api(`/accommodation/${spot._id}/stays?month=${A().monthKey(y, m)}`)).stays;
                draw();
            } catch (e) { if (e.message !== 'Signed out') el.innerHTML = A().failed(e.message, true); }
        }
        const roomNo = id => (data.rooms.find(r => r._id === id) || {}).roomNumber || '?';
        function draw() {
            const today = A().manilaToday();
            const active = r => r.availableFrom <= today && (!r.availableUntil || today < r.availableUntil);
            const out = data.outOfService;
            el.innerHTML = `
                <div class="bkm-bar"><h2 class="text-lg font-extrabold text-on-surface">Room numbers</h2>
                    <button type="button" class="btn btn-primary min-h-[44px]" data-x="add"><span class="material-symbols-outlined !text-base" aria-hidden="true">add</span>Add room</button></div>
                ${data.rooms.length ? `<section class="glass-panel"><div class="acc-scroll"><table class="ztims-table acc-table"><thead><tr><th>Room</th><th>Label</th><th class="text-right">Sleeps</th><th>Available</th><th></th></tr></thead><tbody>
                    ${data.rooms.map(r => `<tr><td><b>${A().esc(r.roomNumber)}</b>${r.shared ? ' <span class="tone-pill rounded-pill acc-pill tone-info">Shared</span>' : ''}</td><td>${A().esc(r.label)}</td><td class="text-right">${r.sleeps}</td>
                        <td>${A().fmtDate(r.availableFrom, true)}${r.availableUntil ? ` to ${A().fmtDate(A().addDays(r.availableUntil, -1), true)}` : ' on'}${active(r) ? '' : ' <span class="tone-pill rounded-pill acc-pill tone-neutral">Not available now</span>'}</td>
                        <td class="text-right"><button type="button" class="btn btn-secondary btn-sm" data-edit="${A().esc(r._id)}">Edit</button></td></tr>`).join('')}</tbody></table></div></section>`
                : '<div class="ztims-empty">No room numbers yet. Add each room you rent out; stays and the daily register use them.</div>'}
                <div class="bkm-bar"><h2 class="text-lg font-extrabold text-on-surface">Out of service</h2>
                    <button type="button" class="btn btn-secondary min-h-[44px]" data-x="oos"${data.rooms.length ? '' : ' disabled'}><span class="material-symbols-outlined !text-base" aria-hidden="true">construction</span>Add out of service</button></div>
                ${out.length ? `<section class="glass-panel"><div class="acc-scroll"><table class="ztims-table acc-table"><thead><tr><th>Room</th><th>First day</th><th>Last day</th><th>Reason</th><th></th></tr></thead><tbody>
                    ${out.map(o => `<tr><td><b>${A().esc(roomNo(o.roomId))}</b></td><td>${A().fmtDate(o.startsOn, true)}</td><td>${A().fmtDate(o.endsOn, true)}</td><td>${A().esc(o.reason)}</td>
                        <td class="text-right"><button type="button" class="btn btn-cancel btn-sm" data-void="${A().esc(o._id)}">Remove</button></td></tr>`).join('')}</tbody></table></div></section>` : '<div class="ztims-empty">No room is out of service.</div>'}
                ${data.rooms.length ? availability() : ''}`;
        }
        function availability() {
            const days = A().daysIn(y, m), key = A().monthKey(y, m), today = A().manilaToday();
            const closed = d => data.closedPeriods.some(c => c.startsOn <= d && d <= c.endsOn);
            const head = Array.from({ length: days }, (_, i) => { const d = `${key}-${A().pad(i + 1)}`; return `<th class="${d === today ? 'acc-mk--in' : ''}">${i + 1}</th>`; }).join('');
            const body = data.rooms.map(r => `<tr><th class="acc-sticky">${A().esc(r.roomNumber)}</th>${Array.from({ length: days }, (_, i) => {
                const d = `${key}-${A().pad(i + 1)}`;
                if (d < r.availableFrom || (r.availableUntil && d >= r.availableUntil) || closed(d)) return '<td class="acc-closed" title="Not available"></td>';
                if (data.outOfService.some(o => o.roomId === r._id && o.startsOn <= d && d <= o.endsOn)) return '<td class="acc-closed" title="Out of service">✕</td>';
                const st = stays.find(s => s.status === 'active' && s.rooms.some(a => a.roomId === r._id && a.from <= d && d < a.until));
                return st ? `<td class="acc-mk" title="${A().esc(st.reference)}"><span class="acc-dot"></span></td>` : '<td></td>';
            }).join('')}</tr>`).join('');
            return `<div class="bkm-bar"><h2 class="text-lg font-extrabold text-on-surface">Rooms by night</h2>
                <div class="acc-month"><button type="button" class="acc-iconbtn" data-step="-1" aria-label="Previous month"><span class="material-symbols-outlined">chevron_left</span></button><span class="acc-month__name">${A().monthName(y, m)}</span><button type="button" class="acc-iconbtn" data-step="1" aria-label="Next month"><span class="material-symbols-outlined">chevron_right</span></button></div></div>
                <section class="glass-panel p-3"><div class="acc-scroll"><table class="acc-grid"><thead><tr><th class="acc-sticky">Room</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
                <p class="acc-note mt-2"><span class="acc-dot"></span> occupied · ✕ out of service · shaded: not available or closed.</p></section>`;
        }
        function roomWindow(r) {
            A().openWindow({
                title: r ? `Room ${r.roomNumber}` : 'Add room',
                body: `<div class="grid sm:grid-cols-2 gap-4">
                    <label class="block"><span class="field-label">Room number</span><input id="rnNo" class="field" maxlength="20" value="${r ? A().esc(r.roomNumber) : ''}"${r ? ' disabled' : ''}/></label>
                    <label class="block"><span class="field-label">Sleeps</span><input id="rnSleeps" type="number" min="1" max="30" class="field" value="${r ? r.sleeps : 2}"/></label>
                    <label class="block sm:col-span-2"><span class="field-label">Label</span><input id="rnLabel" class="field" maxlength="80" placeholder="Family room" value="${r ? A().esc(r.label) : ''}"/></label>
                    ${r ? `<label class="block"><span class="field-label">Last available night</span><input id="rnUntil" type="date" class="field" value="${r.availableUntil ? A().addDays(r.availableUntil, -1) : ''}"/></label>`
                        : `<label class="block"><span class="field-label">Available from</span><input id="rnFrom" type="date" class="field" value="${A().manilaToday()}"/></label>
                           <label class="sf-switch self-end"><input id="rnShared" type="checkbox"/><span class="sf-switch__track" aria-hidden="true"></span><span>Shared room (several parties a night)</span></label>`}</div>`,
                actions: [{ label: 'Cancel', kind: 'cancel' }, { label: r ? 'Save room' : 'Add room', kind: 'primary', run: async w => {
                    const q = id => w.el.querySelector('#' + id);
                    if (r) {
                        const until = q('rnUntil').value;
                        await A().api(`/accommodation/rooms/${r._id}`, { method: 'PATCH', body: { label: q('rnLabel').value, sleeps: +q('rnSleeps').value, availableUntil: until ? A().addDays(until, 1) : null } });
                        A().toast('Room saved');
                    } else {
                        await A().api(`/accommodation/${spot._id}/rooms`, { method: 'POST', body: { roomNumber: q('rnNo').value.trim(), label: q('rnLabel').value, sleeps: +q('rnSleeps').value, availableFrom: q('rnFrom').value, shared: q('rnShared').checked } });
                        A().toast('Room added');
                    }
                    load();
                } }]
            });
        }
        function oosWindow() {
            A().openWindow({
                title: 'Add out of service',
                body: `<label class="block"><span class="field-label">Room</span><select id="osRoom" class="field">${data.rooms.map(r => `<option value="${A().esc(r._id)}">${A().esc(r.roomNumber)}</option>`).join('')}</select></label>
                    <div class="grid sm:grid-cols-2 gap-4"><label class="block"><span class="field-label">First day</span><input id="osFrom" type="date" class="field"/></label><label class="block"><span class="field-label">Last day</span><input id="osTo" type="date" class="field"/></label></div>
                    <label class="block"><span class="field-label">Reason</span><select id="osWhy" class="field"><option>Maintenance</option><option>Renovation</option><option>Owner's use</option><option>Other</option></select></label>`,
                actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Add', kind: 'primary', run: async w => {
                    const q = id => w.el.querySelector('#' + id).value;
                    await A().api(`/accommodation/${spot._id}/out-of-service`, { method: 'POST', body: { roomId: q('osRoom'), startsOn: q('osFrom'), endsOn: q('osTo'), reason: q('osWhy') } });
                    A().toast('Room marked out of service'); load();
                } }]
            });
        }
        function voidWindow(id) {
            A().openWindow({
                title: 'Remove this out-of-service period?',
                body: `<p>It is kept in the history, and the room counts as available again on those days.</p><label class="block"><span class="field-label">Reason</span><input id="vdWhy" class="field" maxlength="300"/></label>`,
                actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Remove', kind: 'danger', run: async w => {
                    await A().api(`/accommodation/out-of-service/${id}/void`, { method: 'POST', body: { reason: w.el.querySelector('#vdWhy').value } });
                    A().toast('Removed'); load();
                } }]
            });
        }
        el.addEventListener('click', e => {
            const b = e.target.closest('[data-x],[data-edit],[data-void],[data-step],[data-acc-retry]');
            if (!b) return;
            if (b.dataset.accRetry !== undefined) return load();
            if (b.dataset.x === 'add') return roomWindow(null);
            if (b.dataset.x === 'oos') return oosWindow();
            if (b.dataset.edit) return roomWindow(data.rooms.find(r => r._id === b.dataset.edit));
            if (b.dataset.void) return voidWindow(b.dataset.void);
            if (b.dataset.step) { [y, m] = A().shiftMonth(y, m, +b.dataset.step); return load(); }
        });
        load();
    }

    /* ---- Enterprise → Reporting ------------------------------------------- */
    function profile(el, spot) {
        let p = null, closed = [];
        async function load() {
            el.innerHTML = A().loading();
            try {
                p = (await A().api(`/accommodation/${spot._id}/profile`)).profile;
                closed = (await A().api(`/accommodation/${spot._id}/rooms`)).closedPeriods;
                draw();
            } catch (e) { if (e.message !== 'Signed out') el.innerHTML = A().failed(e.message, true); }
        }
        function draw() {
            const typeName = (TYPES.find(t => t[0] === p.accommodationType) || [, ''])[1];
            const fact = (k, v, required) => `<div class="est-fact"><dt>${k}</dt><dd class="${!v && required ? 'text-error font-bold' : ''}">${v ? A().esc(v) : (required ? 'Required' : 'None')}</dd></div>`;
            el.innerHTML = `<section class="glass-panel p-5 space-y-4">
                    <div class="bkm-bar"><h2 class="text-lg font-extrabold text-on-surface">Statistical profile</h2><button type="button" class="btn btn-primary min-h-[44px]" data-x="edit">Edit</button></div>
                    <dl class="est-facts">${fact('Kind of place', p.accommodationType === 'other' ? 'Others: ' + p.accommodationTypeOther : typeName, true)}
                        ${fact('DOT accreditation classification', p.dotClassification)}${fact('AE ID code (assigned by the LGU)', p.aeCode)}
                        ${fact('Reporting starts', p.reportingFrom ? A().monthName(+p.reportingFrom.slice(0, 4), +p.reportingFrom.slice(5, 7)) : '', true)}
                        ${fact('City / Municipality', 'Zamboanguita')}${fact('Province', 'Negros Oriental')}</dl></section>
                <section class="glass-panel p-5 space-y-4">
                    <div class="bkm-bar"><h2 class="text-lg font-extrabold text-on-surface">Closed periods</h2><button type="button" class="btn btn-secondary min-h-[44px]" data-x="closed">Add closed period</button></div>
                    ${closed.length ? `<div class="acc-scroll"><table class="ztims-table acc-table"><thead><tr><th>First day</th><th>Last day</th><th>Reason</th><th></th></tr></thead><tbody>${closed.map(c => `<tr><td>${A().fmtDate(c.startsOn, true)}</td><td>${A().fmtDate(c.endsOn, true)}</td><td>${A().esc(c.reason)}</td><td class="text-right"><button type="button" class="btn btn-cancel btn-sm" data-void="${A().esc(c._id)}">Remove</button></td></tr>`).join('')}</tbody></table></div>`
                        : '<div class="ztims-empty">No closed periods. A month closed every day is reported as N/A, not as zero.</div>'}</section>`;
        }
        el.addEventListener('click', e => {
            const b = e.target.closest('[data-x],[data-void],[data-acc-retry]');
            if (!b) return;
            if (b.dataset.accRetry !== undefined) return load();
            if (b.dataset.x === 'edit') return A().openWindow({
                title: 'Statistical profile',
                body: `<label class="block"><span class="field-label">Kind of place</span><select id="pfType" class="field">${TYPES.map(([v, l]) => `<option value="${v}"${v === p.accommodationType ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
                    <label class="block"><span class="field-label">If others, which</span><input id="pfOther" class="field" maxlength="80" value="${A().esc(p.accommodationTypeOther)}"/></label>
                    <label class="block"><span class="field-label">DOT accreditation classification</span><input id="pfDot" class="field" maxlength="80" value="${A().esc(p.dotClassification)}"/></label>
                    <label class="block"><span class="field-label">AE ID code (assigned by the LGU)</span><input id="pfAe" class="field" maxlength="40" value="${A().esc(p.aeCode)}"/></label>
                    <label class="block"><span class="field-label">Reporting starts</span><input id="pfFrom" type="month" class="field" value="${p.reportingFrom ? p.reportingFrom.slice(0, 7) : ''}"/></label>`,
                actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Save', kind: 'primary', run: async w => {
                    const q = id => w.el.querySelector('#' + id).value;
                    if (!q('pfType')) throw new Error('Choose the kind of place.');
                    if (!q('pfFrom')) throw new Error('Choose the month reporting starts.');
                    await A().api(`/accommodation/${spot._id}/profile`, { method: 'PUT', body: { accommodationType: q('pfType'), accommodationTypeOther: q('pfOther'), dotClassification: q('pfDot'), aeCode: q('pfAe'), reportingFrom: q('pfFrom') } });
                    A().toast('Profile saved'); load();
                } }]
            });
            if (b.dataset.x === 'closed') return A().openWindow({
                title: 'Add closed period',
                body: `<div class="grid sm:grid-cols-2 gap-4"><label class="block"><span class="field-label">First closed day</span><input id="cpFrom" type="date" class="field"/></label><label class="block"><span class="field-label">Last closed day</span><input id="cpTo" type="date" class="field"/></label></div>
                    <label class="block"><span class="field-label">Reason</span><input id="cpWhy" class="field" maxlength="200" placeholder="Closed for repairs"/></label>`,
                actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Add', kind: 'primary', run: async w => {
                    const q = id => w.el.querySelector('#' + id).value;
                    await A().api(`/accommodation/${spot._id}/closed-periods`, { method: 'POST', body: { startsOn: q('cpFrom'), endsOn: q('cpTo'), reason: q('cpWhy') } });
                    A().toast('Closed period added'); load();
                } }]
            });
            if (b.dataset.void) return A().openWindow({
                title: 'Remove this closed period?',
                body: `<p>It is kept in the history; those days count as open again.</p><label class="block"><span class="field-label">Reason</span><input id="vcWhy" class="field" maxlength="300"/></label>`,
                actions: [{ label: 'Cancel', kind: 'cancel' }, { label: 'Remove', kind: 'danger', run: async w => {
                    await A().api(`/accommodation/closed-periods/${b.dataset.void}/void`, { method: 'POST', body: { reason: w.el.querySelector('#vcWhy').value } });
                    A().toast('Removed'); load();
                } }]
            });
        });
        load();
    }

    window.ztimsAccSetup = { rooms, profile };
})();
