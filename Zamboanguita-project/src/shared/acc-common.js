/* Accommodation reporting: what the manager's and the officer's pages share.
 * Plain global (window.ztimsAcc), like the other shared scripts, loaded by
 * the pages that show the stay register, the reports and the tracker.
 *
 *   api(path, options)      fetch /api/accommodation…, the staff token, JSON;
 *                           throws an Error with .status, .code and .data
 *   esc(text)               text for innerHTML (every server or typed text)
 *   STATES / statePill(s)   a month's state as a pill
 *   monthName, fmtDate, …   dates in Manila, as the API gives them
 *   openWindow({…})         an accessible window in the .ztims-modal shell
 *   download(path, name)    an Excel export, with the token, as a file
 *
 * Authorization is the server's: hiding a button here is never a control.
 */
(function () {
    const API = '/api';
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const token = () => { try { return localStorage.getItem('authToken') || ''; } catch { return ''; } };

    function signedOut() {
        const next = encodeURIComponent(location.pathname.replace(/^.*\/src\//, '') + location.search + location.hash);
        location.href = (location.pathname.includes('/admin/') || location.pathname.includes('/resort/') ? '../' : '') + 'staff_login.html?next=' + next;
    }

    async function api(path, options = {}) {
        let response;
        try {
            response = await fetch(API + path, {
                method: options.method || 'GET',
                headers: Object.assign({ Authorization: 'Bearer ' + token() }, options.body ? { 'Content-Type': 'application/json' } : {}),
                body: options.body ? JSON.stringify(options.body) : undefined
            });
        } catch {
            const error = new Error('No connection. Check your signal and try again.');
            error.status = 0;
            throw error;
        }
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        if (response.status === 401) { signedOut(); const e = new Error('Signed out'); e.status = 401; throw e; }
        if (!response.ok) {
            const error = new Error((data && data.message) || 'Something went wrong. Try again.');
            error.status = response.status;
            error.code = data && data.code;
            error.data = data;
            throw error;
        }
        return data;
    }

    async function download(path, fallbackName) {
        const response = await fetch(API + path, { headers: { Authorization: 'Bearer ' + token() } });
        if (response.status === 401) return signedOut();
        if (!response.ok) {
            let message = 'The file could not be made.';
            try { message = (await response.json()).message || message; } catch { /* not JSON */ }
            throw new Error(message);
        }
        const disposition = response.headers.get('Content-Disposition') || '';
        const match = /filename="([^"]+)"/.exec(disposition);
        const blob = await response.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = match ? match[1] : fallbackName;
        document.body.appendChild(link);
        link.click();
        setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
    }

    const pad = n => String(n).padStart(2, '0');
    const manilaToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const addDays = (s, n) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) + n)).toISOString().slice(0, 10);
    const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
    const monthName = (y, m) => `${MONTHS[m - 1]} ${y}`;
    const monthKey = (y, m) => `${y}-${pad(m)}`;
    const shiftMonth = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1 + d, 1)); return [t.getUTCFullYear(), t.getUTCMonth() + 1]; };
    function fmtDate(s, withYear) {
        if (!s) return '';
        const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
        return d.toLocaleDateString('en-PH', { day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined, timeZone: 'UTC' });
    }
    const fmtWhen = s => (s ? new Date(s).toLocaleString('en-PH', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }) : '');
    const weekday = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))).toLocaleDateString('en-PH', { weekday: 'short', timeZone: 'UTC' });
    const nf = n => (n == null ? '–' : Number(n).toLocaleString('en-PH'));
    const pct = r => (r == null ? 'n/a' : (r * 100).toFixed(1) + '%');
    const dec = r => (r == null ? 'n/a' : r.toFixed(2));

    /* A month's state, worded as the pages say it. */
    const STATES = {
        submitted: ['tone-success', 'check_circle', 'Submitted'],
        changed: ['tone-warning', 'edit_note', 'Changed since submitted'],
        finalized: ['tone-neutral acc-pill--lock', 'lock', 'Finalized'],
        reopened: ['tone-warning', 'lock_open', 'Reopened'],
        open: ['tone-info', 'pending', 'In progress'],
        due: ['tone-warning', 'schedule', 'Due'],
        overdue: ['tone-danger', 'error', 'Overdue'],
        not_recorded: ['tone-danger', 'report', 'Not reported'],
        not_operating: ['tone-neutral', 'block', 'N/A, not operating'],
        not_set_up: ['tone-neutral', 'settings', 'Not set up'],
        future: ['tone-neutral', 'hourglass_empty', 'Not yet'],
        municipal_total: ['tone-neutral', 'inventory_2', 'Municipal total']
    };
    function statePill(state, version) {
        const s = STATES[state] || ['tone-neutral', 'help', state];
        const label = (state === 'submitted' || state === 'changed') && version ? `${s[2]}${state === 'submitted' ? ` · v${version}` : ` (v${version})`}` : s[2];
        return `<span class="tone-pill rounded-pill acc-pill ${s[0]}"><span class="material-symbols-outlined" aria-hidden="true">${s[1]}</span>${esc(label)}</span>`;
    }

    /* Residence codes and names (Form A4's rows), fetched once. */
    let residences = null;
    async function loadResidences() {
        if (residences) return residences;
        const r = await fetch(API + '/statistics/residences', { headers: { Authorization: 'Bearer ' + token() } });
        if (r.status === 401) { signedOut(); return []; }
        const data = await r.json().catch(() => []);
        residences = Array.isArray(data) ? data : (data.residences || []);
        return residences;
    }
    const residenceName = code => { const r = (residences || []).find(x => x.code === code); return r ? r.name : code; };
    const residenceSection = code => { const r = (residences || []).find(x => x.code === code); return r ? r.section : 'unspecified'; };

    /* A window in the site's .ztims-modal shell: focus moves in and back,
       Escape and the scrim close it, and only its own buttons act. */
    function openWindow({ title, body, actions = [], wide = false, onOpen }) {
        const scrim = document.createElement('div');
        scrim.className = 'fixed inset-0 ztims-scrim flex items-center justify-center z-[200] p-3 sm:p-4 acc-window';
        const titleId = 'accWin' + Math.random().toString(36).slice(2, 8);
        scrim.innerHTML = `<div class="ztims-modal w-full ${wide ? 'max-w-4xl' : 'max-w-2xl'} p-5 sm:p-7 space-y-5 overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
            <div class="flex justify-between items-start gap-4">
                <h2 id="${titleId}" class="text-2xl font-black tracking-tight font-headline">${esc(title)}</h2>
                <button type="button" data-win-close aria-label="Close" class="text-on-surface-variant hover:text-on-surface flex"><span class="material-symbols-outlined">close</span></button>
            </div>
            <div class="acc-window__body space-y-4">${body}</div>
            <p class="acc-window__error text-sm text-error bg-error/10 border border-error/20 px-4 py-3" role="alert" hidden></p>
            <div class="flex flex-wrap justify-end gap-3 pt-1 acc-window__actions"></div>
        </div>`;
        const previous = document.activeElement;
        const bar = scrim.querySelector('.acc-window__actions');
        const errorBox = scrim.querySelector('.acc-window__error');
        const api = {
            el: scrim,
            body: scrim.querySelector('.acc-window__body'),
            close() { scrim.remove(); document.removeEventListener('keydown', onKey, true); if (previous && previous.focus) previous.focus(); },
            error(message) { errorBox.textContent = message || ''; errorBox.hidden = !message; if (message) errorBox.scrollIntoView({ block: 'nearest' }); },
            busy(on) { bar.querySelectorAll('button').forEach(b => { b.disabled = !!on; }); }
        };
        for (const a of actions) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn min-h-[44px] ' + (a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : a.kind === 'cancel' ? 'btn-cancel' : 'btn-secondary');
            b.textContent = a.label;
            if (a.disabled) b.disabled = true;
            b.addEventListener('click', async () => {
                if (!a.run) return api.close();
                api.error('');
                api.busy(true);
                try { const keep = await a.run(api); if (keep !== false) api.close(); }
                catch (e) { if (e && e.message !== 'Signed out') api.error(e.message); }
                finally { if (document.body.contains(scrim)) api.busy(false); }
            });
            bar.appendChild(b);
        }
        const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); api.close(); } };
        document.addEventListener('keydown', onKey, true);
        scrim.addEventListener('click', e => { if (e.target === scrim || e.target.closest('[data-win-close]')) api.close(); });
        document.body.appendChild(scrim);
        if (onOpen) onOpen(api);
        const first = scrim.querySelector('input, select, textarea, button:not([data-win-close])');
        if (first) first.focus();
        return api;
    }

    const toast = (message, tone) => { if (typeof window.showToast === 'function') window.showToast(message, tone || 'success'); };
    const loading = text => `<div class="ztims-empty acc-loading" aria-busy="true"><span class="animate-spin acc-spin" aria-hidden="true"></span>${esc(text || 'Loading…')}</div>`;
    const failed = (message, retry) => `<div class="ztims-empty tone-danger" role="alert">${esc(message)}${retry ? ` <button type="button" class="btn btn-secondary btn-sm ml-2" data-acc-retry>Try again</button>` : ''}</div>`;

    /* Part I (arrivals by residence) and Part II as tables. `counts` is
       { code: { male, female } } or, for the paper months, { code: { unsplit } }.
       Rows with no arrivals are left out; group totals always show. */
    function partOneHtml(counts) {
        const list = residences || [];
        const get = code => counts[code] || null;
        const n = c => (c ? (c.unsplit || 0) + (c.male || 0) + (c.female || 0) : 0);
        const split = Object.values(counts).every(c => c.unsplit == null);
        const cell = (c, k) => (c && c[k] != null ? nf(c[k]) : (split ? '0' : '–'));
        const row = (label, c, cls = '') => `<tr class="${cls}"><td>${esc(label)}</td>${split ? `<td class="text-right">${cell(c, 'male')}</td><td class="text-right">${cell(c, 'female')}</td>` : ''}<td class="text-right"><b>${nf(n(c))}</b></td></tr>`;
        const add = codes => codes.reduce((a, code) => { const c = get(code); if (!c) return a; return { male: a.male + (c.male || 0), female: a.female + (c.female || 0), unsplit: (a.unsplit || 0) + (c.unsplit || 0) }; }, { male: 0, female: 0, unsplit: 0 });
        const sec = s => list.filter(r => r.section === s).map(r => r.code);
        const foreign = list.filter(r => r.section === 'foreign');
        const shownForeign = foreign.filter(r => n(get(r.code)) > 0);
        const groupRow = label => `<tr class="acc-group"><td colspan="${split ? 4 : 2}">${esc(label)}</td></tr>`;
        return `<div class="acc-scroll"><table class="ztims-table acc-table"><thead><tr><th>Country of residence</th>${split ? '<th class="text-right">Male</th><th class="text-right">Female</th>' : ''}<th class="text-right">Total</th></tr></thead><tbody>
            ${groupRow('PHILIPPINE RESIDENTS')}${row('Filipino nationality', get('ph-filipino'))}${row('Foreign nationality', get('ph-foreign'))}
            ${row('Total Philippine residents', add(sec('philippine')), 'acc-sum')}
            ${groupRow('NON-PHILIPPINE RESIDENTS')}${shownForeign.length ? shownForeign.map(r => row(r.name, get(r.code))).join('') : `<tr><td colspan="${split ? 4 : 2}" class="text-on-surface-variant">No arrivals from outside the Philippines</td></tr>`}
            ${row('Total non-Philippine residents', add(sec('foreign')), 'acc-sum')}
            ${row('Overseas Filipinos*', get('overseas-filipino'), 'acc-sum')}${row('Guests with unspecified residence', get('unspecified'), 'acc-sum')}
            ${row('Grand total guest arrivals', add(list.map(r => r.code)), 'acc-grand')}</tbody></table></div>
            <p class="acc-note mt-2">Rows with no arrivals are left out here; the Excel lists every row. * Philippine passport holders permanently residing abroad; excludes overseas Filipino workers.</p>`;
    }
    function partTwoHtml(f) {
        const sexBy = section => Object.entries(f.counts || {}).filter(([code]) => residenceSection(code) === section).reduce((a, [, c]) => ({ male: a.male + (c.male || 0), female: a.female + (c.female || 0) }), { male: 0, female: 0 });
        const v = [['a. Philippine residents', sexBy('philippine')], ['b. Non-Philippine residents', sexBy('foreign')], ['c. Overseas Filipinos', sexBy('overseas_filipino')], ['d. Others / unspecified', sexBy('unspecified')]];
        return `<div class="grid lg:grid-cols-2 gap-4"><div class="acc-scroll"><table class="ztims-table acc-table"><tbody>
                <tr><td>Number of rooms</td><td class="text-right"><b>${nf(f.rooms)}</b></td></tr>
                <tr><td>1. Rooms occupied <span class="text-on-surface-variant">(room-nights)</span></td><td class="text-right"><b>${nf(f.roomNightsOccupied)}</b></td></tr>
                <tr><td>2. Rooms available for the month <span class="text-on-surface-variant">(room-nights)</span></td><td class="text-right"><b>${nf(f.roomNightsAvailable)}</b></td></tr>
                <tr><td>3. Total guest nights</td><td class="text-right"><b>${nf(f.guestNights)}</b></td></tr>
                <tr class="acc-sum"><td>Average monthly occupancy rate</td><td class="text-right">${pct(f.occupancyRate)}</td></tr>
                <tr class="acc-sum"><td>Average length of stay (nights)</td><td class="text-right">${dec(f.averageLengthOfStay)}</td></tr></tbody></table></div>
            <div class="acc-scroll"><table class="ztims-table acc-table"><thead><tr><th>Volume per sex</th><th class="text-right">Male</th><th class="text-right">Female</th></tr></thead><tbody>
                ${v.map(([l, x]) => `<tr><td>${l}</td><td class="text-right">${x.male}</td><td class="text-right">${x.female}</td></tr>`).join('')}</tbody></table></div></div>`;
    }

    window.ztimsAcc = {
        partOneHtml, partTwoHtml,
        api, download, esc, MONTHS, pad, manilaToday, addDays, daysIn, monthName, monthKey, shiftMonth, fmtDate, fmtWhen, weekday,
        nf, pct, dec, STATES, statePill, loadResidences, residenceName, residenceSection, openWindow, toast, loading, failed
    };
})();
