/* The manager portal's enterprise switcher. One account may run several
   enterprises (one listing each); this keeps which one the portal is working
   on, draws the switcher in the header, and tells each page which it is.

   A plain global-scope IIFE, like the other shared pieces. The choice is kept
   in localStorage.ztimsEnterprise (a listing id) and checked against the
   account's own listings, so a stale or foreign id falls back to the first.
   Nothing here is a control: the server decides what a manager may touch. */
(function () {
    'use strict';

    const KEY = 'ztimsEnterprise';
    let list = [];
    let loaded = null;

    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    const nameOf = spot => (spot && (spot.enterpriseName || spot.title)) || '';

    function stored() {
        try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
    }

    function currentId() {
        const id = stored();
        if (id && list.some(s => s._id === id)) return id;
        return list[0] ? list[0]._id : '';
    }

    function current() {
        const id = currentId();
        return list.find(s => s._id === id) || null;
    }

    function remember(id) {
        try { localStorage.setItem(KEY, id); } catch { /* private browsing */ }
    }

    /* The account's enterprises, oldest first. Resolves with the list; a failed
       load leaves it empty and the page shows its own error. */
    function load(force) {
        if (loaded && !force) return loaded;
        loaded = (async () => {
            try {
                const response = await fetch('/api/spots?mine=true', {
                    headers: { Authorization: 'Bearer ' + (localStorage.getItem('authToken') || '') }
                });
                if (!response.ok) { list = []; return list; }
                const spots = await response.json();
                list = (Array.isArray(spots) ? spots : []).slice().sort(
                    (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
            } catch { list = []; }
            return list;
        })();
        return loaded;
    }

    /* A page that has already fetched the account's listings hands them over. */
    function set(spots) {
        list = (Array.isArray(spots) ? spots : []).slice().sort(
            (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
        loaded = Promise.resolve(list);
    }

    function select(id) {
        remember(id);
        location.reload();
    }

    function mount(slot) {
        if (!slot) return;
        const here = current();
        if (!here) { slot.innerHTML = ''; return; }
        const menuId = 'entMenu';
        slot.innerHTML = `
            <div class="ent-switch">
                <button type="button" class="ent-switch__btn" id="entSwitchBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}">
                    <span class="material-symbols-outlined" aria-hidden="true">storefront</span>
                    <span class="ent-switch__name">${esc(nameOf(here))}</span>
                    <span class="material-symbols-outlined" aria-hidden="true">expand_more</span>
                </button>
                <div class="ztims-dropdown ent-switch__menu" id="${menuId}" role="menu" hidden>
                    <p class="ent-switch__label">Working in</p>
                    ${list.map(s => `<button type="button" role="menuitem" class="ent-switch__item${s._id === here._id ? ' is-current' : ''}" data-id="${esc(s._id)}">
                        <span>${esc(nameOf(s))}</span>${s._id === here._id ? '<span class="material-symbols-outlined" aria-hidden="true">check</span>' : ''}</button>`).join('')}
                    <a role="menuitem" class="ent-switch__item" href="resort_enterprises.html">My enterprises</a>
                    <a role="menuitem" class="ent-switch__item ent-switch__add" href="resort_spots.html?add=1">
                        <span class="material-symbols-outlined" aria-hidden="true">add</span>Add enterprise</a>
                </div>
            </div>`;
        const button = slot.querySelector('#entSwitchBtn');
        const menu = slot.querySelector('#' + menuId);
        const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
        button.addEventListener('click', event => {
            event.stopPropagation();
            const open = menu.hidden;
            menu.hidden = !open;
            button.setAttribute('aria-expanded', String(open));
        });
        document.addEventListener('click', event => { if (!slot.contains(event.target)) close(); });
        document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
        menu.querySelectorAll('[data-id]').forEach(item => item.addEventListener('click', () => {
            if (item.dataset.id === here._id) return close();
            select(item.dataset.id);
        }));
    }

    window.ztimsEnterprise = {
        load, set, mount, select, current, currentId, nameOf,
        list: () => list.slice(),
        remember
    };
})();
