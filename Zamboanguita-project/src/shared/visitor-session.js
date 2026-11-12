/* The visitor's sign-in, on every visitor page (visitor accounts, November
   2026; the API is zamboanguita-backend/visitors.js).

   Keeps the visitor's token (localStorage.ztimsVisitorToken — never the staff
   portals' authToken) and their name, and draws the header's account control
   into .site-header__tools: "Sign in" when signed out; the visitor's name with
   a menu (My account, Sign out) when signed in, and shows the header's
   "My account" link ([data-visitor-link]) only while signed in. The token is checked once per
   page with GET /api/visitors/me; one the server refuses is forgotten.

   Exposes window.ztimsVisitor for the pages: token(), save(), clear(),
   signInUrl(next), api(path, options), me(). Nothing here is a control: the
   server decides what a visitor may do. */
(function () {
    'use strict';

    const TOKEN = 'ztimsVisitorToken';
    const NAME = 'ztimsVisitorName';
    const ACCOUNT = '/src/user/account.html';

    const read = key => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
    const write = (key, value) => { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* private browsing */ } };
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    const token = () => read(TOKEN);
    function save(newToken, visitor) {
        write(TOKEN, newToken);
        if (visitor) write(NAME, visitor.fullName || visitor.email || '');
    }
    function clear() { write(TOKEN, ''); write(NAME, ''); }

    /* Only an address on this site may be returned to after signing in. */
    function safeNext(next) {
        const value = String(next || '');
        return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/index.html';
    }
    const here = () => location.pathname + location.search + location.hash;
    const signInUrl = next => `/src/user/sign_in.html?next=${encodeURIComponent(safeNext(next || here()))}`;

    /* A call to the API as the visitor. A refused session is forgotten. */
    async function api(path, { method = 'GET', body } = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (token()) headers.Authorization = 'Bearer ' + token();
        let response, data = {};
        try {
            response = await fetch('/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
            data = await response.json().catch(() => ({}));
        } catch {
            return { ok: false, status: 0, data: { message: 'No connection. Check your signal and try again.' } };
        }
        if (response.status === 401 && token()) clear();
        return { ok: response.ok, status: response.status, data };
    }

    let mePromise = null;
    function me(force) {
        if (!token()) return Promise.resolve(null);
        if (!mePromise || force) {
            mePromise = api('/visitors/me').then(r => {
                if (!r.ok) return null;
                write(NAME, r.data.visitor.fullName || r.data.visitor.email || '');
                return r.data.visitor;
            });
        }
        return mePromise;
    }

    const firstName = name => String(name || '').trim().split(/\s+/)[0] || 'Account';
    const initials = name => String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '·';

    /* ---- the header -------------------------------------------------- */

    let openMenu = null;
    function closeMenu() {
        if (!openMenu) return;
        openMenu.menu.hidden = true;
        openMenu.button.setAttribute('aria-expanded', 'false');
        openMenu = null;
    }
    document.addEventListener('click', event => { if (openMenu && !openMenu.root.contains(event.target)) closeMenu(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });

    /* The header's "My account" link shows only while signed in; signed out,
       the header offers "Sign in" alone. */
    function showAccountLinks(signedIn) {
        document.querySelectorAll('[data-visitor-link]').forEach(link => { link.hidden = !signedIn; });
    }

    function draw(slot, name) {
        closeMenu();
        showAccountLinks(!!name);
        if (!name) {
            slot.innerHTML = `<a class="site-header__signin" href="${esc(signInUrl())}">
                <span class="material-symbols-outlined" aria-hidden="true">person</span><span>Sign in</span></a>`;
            return;
        }
        slot.innerHTML = `
            <div class="site-acct">
                <button type="button" class="site-acct__btn" aria-haspopup="menu" aria-expanded="false" aria-label="Your account: ${esc(name)}">
                    <span class="site-acct__initials" aria-hidden="true">${esc(initials(name))}</span>
                    <span class="site-acct__name">${esc(firstName(name))}</span>
                    <span class="material-symbols-outlined site-acct__caret" aria-hidden="true">expand_more</span>
                </button>
                <div class="site-acct__menu" role="menu" hidden>
                    <p class="site-acct__who">${esc(name)}</p>
                    <a role="menuitem" href="${ACCOUNT}#tickets"><span class="material-symbols-outlined" aria-hidden="true">account_circle</span>My account</a>
                    <button type="button" role="menuitem" data-sign-out><span class="material-symbols-outlined" aria-hidden="true">logout</span>Sign out</button>
                </div>
            </div>`;
        const root = slot.querySelector('.site-acct');
        const button = root.querySelector('.site-acct__btn');
        const menu = root.querySelector('.site-acct__menu');
        button.addEventListener('click', () => {
            if (openMenu) return closeMenu();
            menu.hidden = false;
            button.setAttribute('aria-expanded', 'true');
            openMenu = { root, button, menu };
        });
        root.querySelector('[data-sign-out]').addEventListener('click', () => {
            clear();
            // An account page has nothing to show once signed out.
            if (location.pathname.startsWith('/src/user/account')) location.assign('/index.html');
            else draw(slot, '');
        });
    }

    function mountHeader() {
        const tools = document.querySelector('.site-header__tools');
        if (!tools || tools.querySelector('[data-visitor-slot]')) return;
        const slot = document.createElement('div');
        slot.dataset.visitorSlot = '';
        slot.className = 'site-header__visitor';
        tools.insertBefore(slot, tools.firstChild);
        // The stored name first, so the header does not flicker; then checked.
        draw(slot, token() ? read(NAME) || 'Account' : '');
        if (token()) me().then(visitor => draw(slot, visitor ? (visitor.fullName || visitor.email) : ''));
    }

    window.ztimsVisitor = { token, save, clear, signInUrl, safeNext, api, me, ACCOUNT };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountHeader);
    else mountHeader();
    document.dispatchEvent(new CustomEvent('ztims-visitor-ready'));
})();
