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

    // The open menu, if any; one pair of document listeners closes it.
    let openMenu = null;
    function closeMenu() {
        if (!openMenu) return;
        openMenu.menu.hidden = true;
        openMenu.button.setAttribute('aria-expanded', 'false');
        openMenu = null;
    }
    document.addEventListener('click', event => {
        if (openMenu && !openMenu.root.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });

    /* The header's switcher: the same pill and menu as the portals' other
       buttons and ⋯ menus (.pg-btn, .dest-menu in portal-flat.css). */
    function mount(slot) {
        if (!slot) return;
        closeMenu();
        const here = current();
        if (!here) { slot.innerHTML = ''; return; }
        const icon = name => `<span class="material-symbols-outlined" aria-hidden="true">${name}</span>`;
        slot.innerHTML = `
            <div class="ent-switch">
                <button type="button" class="pg-btn pg-btn--plain ent-switch__btn" aria-haspopup="menu" aria-expanded="false"
                        aria-label="Working in ${esc(nameOf(here))}. Switch enterprise">
                    ${icon('storefront')}<span class="ent-switch__name">${esc(nameOf(here))}</span>${icon('expand_more')}
                </button>
                <div class="ztims-dropdown dest-menu ent-switch__menu" role="menu" hidden>
                    <p class="ent-switch__label">Working in</p>
                    ${list.map(s => s._id === here._id
                        ? `<button type="button" role="menuitem" class="is-current" aria-current="true" data-id="${esc(s._id)}">${icon('check')}<span>${esc(nameOf(s))}</span></button>`
                        : `<button type="button" role="menuitem" data-id="${esc(s._id)}">${icon('storefront')}<span>${esc(nameOf(s))}</span></button>`).join('')}
                    <hr class="ent-switch__rule">
                    <a role="menuitem" href="resort_enterprises.html">${icon('dashboard')}My enterprises</a>
                    <a role="menuitem" href="resort_spots.html?add=1">${icon('add_business')}Add enterprise</a>
                </div>
            </div>`;
        const root = slot.querySelector('.ent-switch');
        const button = root.querySelector('.ent-switch__btn');
        const menu = root.querySelector('.ent-switch__menu');
        button.addEventListener('click', () => {
            if (openMenu) return closeMenu();
            menu.hidden = false;
            button.setAttribute('aria-expanded', 'true');
            openMenu = { root, button, menu };
        });
        menu.querySelectorAll('[data-id]').forEach(item => item.addEventListener('click', () => {
            if (item.dataset.id === here._id) return closeMenu();
            select(item.dataset.id);
        }));
    }

    window.ztimsEnterprise = {
        load, set, mount, select, current, currentId, nameOf,
        list: () => list.slice(),
        remember
    };
})();
