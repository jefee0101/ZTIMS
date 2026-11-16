/* Read-only DAE-1A / actual DAE-1B. The server supplies the template rows and
 * saved daily detail; neither a summary nor current stays replace a version. */
(function ready() {
    // The production bundler may evaluate shared chunks before the page's
    // other module tags. Wait for the existing global rather than capturing undefined.
    if (!window.ztimsAcc) return setTimeout(ready, 20);
    const A = window.ztimsAcc;
    const types = { hotel: 'Hotel', resort: 'Resort', pension: 'Pension Inn / Lodge', hostel: 'Youth Hostel / Dormitory', apartel: 'Apartel / Rented Homes / Apartment', other: 'Other' };
    const scroll = table => `<div class="acc-scroll acc-paper-scroll" tabindex="0" role="region" aria-label="Report table">${table}</div>`;
    function header(c, form) {
        const p = c.detail && c.detail.profile || c.profile || {};
        const name = c.detail && c.detail.enterpriseName || c.enterprise.name;
        return `<div class="acc-paper__head"><p class="acc-paper__code">${form}</p>
            <h3>Report on the Regional Distribution of Travelers</h3><p><b>${A.monthName(c.year, c.month)}</b> · Region: ${A.esc(p.region || '–')}</p>
            <dl><div><dt>Name of enterprise</dt><dd>${A.esc(name)}</dd></div>
            <div><dt>Type of accommodation</dt><dd>${A.esc(p.accommodationType === 'other' ? p.accommodationTypeOther : types[p.accommodationType] || '–')}</dd></div>
            <div><dt>DOT accreditation classification</dt><dd>${A.esc(p.dotClassification || '–')}</dd></div>
            <div><dt>AE ID code (LGU assigned)</dt><dd>${A.esc(p.aeCode || '–')}</dd></div>
            <div><dt>City / municipality</dt><dd>Zamboanguita</dd></div><div><dt>Province</dt><dd>Negros Oriental</dd></div></dl></div>`;
    }
    function dae1b(c) {
        const days = A.daysIn(c.year, c.month), f = c.figures;
        const rows = c.rows || f.dae1b || [];
        const body = rows.map(r => {
            if (r.kind === 'spacer') return '<tr class="dae2-spacer"><td colspan="33"></td></tr>';
            const section = ['section', 'region'].includes(r.kind);
            return `<tr class="dae2-${r.kind}"><th scope="row" class="acc-sticky" style="padding-left:${.6 + r.indent * .8}rem">${A.esc(r.label)}</th>${Array.from({ length: 31 }, (_, i) =>
                `<td${i >= days ? ' class="acc-paper__absent"' : ''}>${section ? '' : r.days[i] == null ? '–' : A.nf(r.days[i])}</td>`).join('')}<td>${section || r.total == null ? '' : A.nf(r.total)}</td></tr>`;
        }).join('');
        return `<section class="glass-panel acc-paper">${header(c, 'DAE-1B')}
            ${!c.detail ? '<p class="acc-banner acc-banner--warn">This historical submission has no saved daily detail. Its monthly totals are preserved; daily cells are left blank.</p>' : ''}
            ${scroll(`<table class="dae2 acc-dae1b"><caption class="sr-only">DAE-1B daily arrivals by country of residence</caption><thead><tr><th class="acc-sticky">Country of residence</th>${Array.from({ length: 31 }, (_, i) => `<th${i >= days ? ' class="acc-paper__absent"' : ''}>${i + 1}</th>`).join('')}<th>Total</th></tr></thead><tbody>${body}${indicatorRows(c, days)}</tbody></table>`)}
            <p class="acc-note">* Philippine passport holders permanently residing abroad; excludes overseas Filipino workers and former Filipinos. Shaded columns are dates outside this month.</p></section>`;
    }
    function indicatorRows(c, days) {
        const f = c.figures, detail = c.detail;
        const counted = i => !f.partial || (f.daily[i] && f.daily[i].counted);
        const dayCells = fn => Array.from({ length: 31 }, (_, i) => `<td${i >= days ? ' class="acc-paper__absent"' : ''}>${!fn ? '' : i >= days || !detail ? '–' : fn(i)}</td>`).join('');
        const heading = text => `<tr class="dae2-section"><th class="acc-sticky">${text}</th>${dayCells()}<td></td></tr>`;
        const line = (text, fn, total) => `<tr><th class="acc-sticky">${text}</th>${dayCells(fn)}<td>${total}</td></tr>`;
        const daily = key => i => counted(i) ? A.nf(detail.daily[i][key]) : '–';
        let result = heading('PART II. Other Indicators') + heading('A. DAE2:')
            + line('1. Rooms Occupied', daily('roomsOccupied'), A.nf(f.roomNightsOccupied))
            + line('2. Rooms available for the month', daily('available'), A.nf(f.roomNightsAvailable))
            + line('3. Total Guest nights', daily('guestNights'), A.nf(f.guestNights))
            + heading('Alternative Submission')
            + line('1. Average Monthly Occupancy Rate', null, A.pct(f.occupancyRate))
            + line('2. Average Length of Stay (in Nights)', null, A.dec(f.averageLengthOfStay))
            + heading('B. VOLUME PER SEX');
        for (const [sex, label] of [['male','1. Male'], ['female','2. Female']]) {
            result += heading(label);
            const sections = [['philippine','a. Philippine Residents'],['foreign','b. Non-Philippine/Foreign Residents (including unspecified)'],['overseas_filipino','c. Overseas Filipinos'],['unspecified','d. Others/Unspecified Guest']];
            for (const [section, text] of sections) {
                const codes = Object.keys(f.counts || {}).filter(code => A.residenceSection(code) === section);
                const total = codes.reduce((sum, code) => sum + (f.counts[code][sex] || 0), 0);
                result += line(text, i => {
                    const arrival = f.partial && A.monthKey(c.year, c.month) + '-' + A.pad(i + 1) > A.manilaToday();
                    return arrival ? '–' : A.nf(codes.reduce((sum, code) => sum + (((detail.byDay[code] || {})[sex] || [])[i] || 0), 0));
                }, A.nf(total));
            }
            const total = Object.values(f.counts || {}).reduce((sum, counts) => sum + (counts[sex] || 0), 0);
            result += line('x. Total', i => f.partial && A.monthKey(c.year, c.month) + '-' + A.pad(i + 1) > A.manilaToday() ? '–' : A.nf(Object.values(detail.byDay || {}).reduce((sum, counts) => sum + (counts[sex][i] || 0), 0)), A.nf(total));
        }
        return result;
    }
    function dae1a(c) {
        if (!c.detail) return '<div class="acc-banner acc-banner--warn">DAE-1A daily detail was not recorded for this historical submission. It is not rebuilt from today’s Guest Register.</div>';
        const d = c.detail, f = c.figures, rooms = d.rooms || [];
        const nightDays = f.partial ? (f.daily || []).filter(day => day.counted).length : A.daysIn(c.year, c.month);
        const arrivalDays = f.partial ? Math.min(A.daysIn(c.year, c.month), Math.max(0, Math.round((Date.parse(A.manilaToday()) - Date.parse(A.monthKey(c.year, c.month) + '-01')) / 864e5) + 1)) : A.daysIn(c.year, c.month);
        const rows = d.daily.map((day, i) => `<tr><th scope="row" class="acc-sticky">${i + 1} ${A.weekday(A.monthKey(c.year, c.month) + '-' + A.pad(i + 1))}</th>${rooms.map(room => {
            const occupied = Object.prototype.hasOwnProperty.call(day.rooms || {}, room);
            const value = occupied ? day.rooms[room] == null ? '●' : day.rooms[room] : '';
            return `<td${(day.checkInRooms || []).includes(room) ? ' class="acc-mk--in"' : ''}>${value}</td>`;
        }).join('')}<td>${i < arrivalDays ? A.nf(day.checkIn) : '–'}</td><td>${i < nightDays ? A.nf(day.guestNights) : '–'}</td><td>${i < nightDays ? A.nf(day.roomsOccupied) : '–'}</td></tr>`).join('');
        return `<section class="glass-panel acc-paper">${header(c, 'DAE-1A')}
            <h4 class="acc-part">Monthly Recording Format for Accommodation Establishment</h4><p class="acc-note">Total number of rooms: ${A.nf(f.rooms)} · Highlighted cells: guests checked in · ● occupied, guests not split between rooms</p>
            ${scroll(`<table class="acc-grid acc-dae1a"><caption class="sr-only">DAE-1A daily room occupancy and guest nights</caption><thead><tr><th class="acc-sticky">Date</th>${rooms.map(r => `<th>Room ${A.esc(r)}</th>`).join('')}<th>(5) Guests checked in</th><th>(6) Guests staying overnight</th><th>(7) Rooms occupied</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th class="acc-sticky">Total</th><td colspan="${Math.max(1, rooms.length)}"></td><td>${A.nf(f.arrivals)}</td><td>${A.nf(f.guestNights)}</td><td>${A.nf(f.roomNightsOccupied)}</td></tr></tfoot></table>`)}</section>`;
    }
    function mountForms(el, context, options = {}) {
        let active = options.initialForm || 'dae1b';
        const forms = [['dae1a', 'DAE-1A'], ['dae1b', 'DAE-1B']].concat(options.formA ? [['forma', 'Form A · Zamboanguita']] : []);
        el.innerHTML = `<div role="tablist" aria-label="Monthly report forms" class="acc-tabs flex gap-2 border-b border-outline-variant/30">${forms.map(([id, name]) => `<button type="button" role="tab" class="settings-tab" data-form-tab="${id}" aria-selected="${id === active}">${name}</button>`).join('')}</div><div data-form-panel class="space-y-4" role="tabpanel"></div>`;
        const panel = el.querySelector('[data-form-panel]');
        function draw() {
            el.querySelectorAll('[data-form-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.formTab === active)));
            if (active === 'forma') { options.formA(panel); return; }
            panel.innerHTML = active === 'dae1a' ? dae1a(context) : dae1b(context);
        }
        el.querySelectorAll('[data-form-tab]').forEach(b => b.addEventListener('click', () => { active = b.dataset.formTab; draw(); }));
        draw();
    }
    Object.assign(A, { mountForms, dae1bHtml: dae1b });
})();
