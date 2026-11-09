/* Saved places: the heart on Home's cards and on a destination page (visitor
   accounts, November 2026; the API is visitors.js' /visitors/me/saved).

   Any button with data-save-spot="<listing id>" is a heart: this file marks
   the ones the signed-in visitor has saved (aria-pressed) and toggles them on
   a click. Signed out, a click asks the visitor to sign in, and Sign in comes
   back to this page. The list itself is My account → Saved places.

   window.ztimsSaved: heart(spotId, extraClass) → the button's HTML, and
   refresh() to mark hearts drawn later. Styles: .sv-heart, .sv-ask in
   theme.css. Needs visitor-session.js (window.ztimsVisitor) on the page. */
(function () {
    'use strict';

    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const visitor = () => window.ztimsVisitor;
    let saved = null;            // a Set of listing ids, once known
    let loading = null;

    function heart(spotId, extraClass) {
        return `<button type="button" class="sv-heart ${esc(extraClass || '')}" data-save-spot="${esc(spotId)}" aria-pressed="false" aria-label="Save this place">
            <span class="material-symbols-outlined" aria-hidden="true">favorite</span></button>`;
    }

    function mark(button) {
        const on = Boolean(saved && saved.has(button.dataset.saveSpot));
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        button.setAttribute('aria-label', on ? 'Saved. Remove from saved places' : 'Save this place');
    }
    function refresh() {
        document.querySelectorAll('[data-save-spot]').forEach(mark);
    }

    function load() {
        const v = visitor();
        if (!v || !v.token()) { saved = new Set(); return Promise.resolve(saved); }
        if (!loading) {
            loading = v.api('/visitors/me/saved').then(r => {
                saved = new Set(r.ok && Array.isArray(r.data) ? r.data.map(s => s._id) : []);
                return saved;
            });
        }
        return loading;
    }

    /* Signed out: a small window offering Sign in, which returns here. */
    function askToSignIn(button) {
        let box = document.getElementById('svAsk');
        if (!box) {
            box = document.createElement('div');
            box.id = 'svAsk';
            box.className = 'sv-ask';
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-modal', 'true');
            box.setAttribute('aria-labelledby', 'svAskTitle');
            box.innerHTML = `
                <div class="sv-ask__card">
                    <span class="material-symbols-outlined sv-ask__icon" aria-hidden="true">favorite</span>
                    <h2 id="svAskTitle" class="sv-ask__title">Sign in to save places</h2>
                    <div class="sv-ask__actions">
                        <button type="button" class="hm-btn hm-btn--ghost" data-sv-close>Not now</button>
                        <a class="hm-btn" data-sv-signin href="#">Sign in</a>
                    </div>
                </div>`;
            document.body.appendChild(box);
            box.addEventListener('click', event => {
                if (event.target === box || event.target.closest('[data-sv-close]')) close();
            });
            document.addEventListener('keydown', event => { if (event.key === 'Escape' && !box.hidden) close(); });
        }
        const back = button;
        function close() { box.hidden = true; if (back && back.isConnected) back.focus(); }
        box.querySelector('[data-sv-signin]').href = visitor() ? visitor().signInUrl() : '/src/user/sign_in.html';
        box.hidden = false;
        box.querySelector('[data-sv-signin]').focus();
    }

    function toast(message, tone) {
        if (typeof window.showToast === 'function') window.showToast(message, tone);
    }

    async function toggle(button) {
        const v = visitor();
        if (!v || !v.token()) return askToSignIn(button);
        await load();
        const id = button.dataset.saveSpot;
        const on = saved.has(id);
        button.disabled = true;
        const r = await v.api('/visitors/me/saved/' + encodeURIComponent(id), { method: on ? 'DELETE' : 'PUT' });
        button.disabled = false;
        if (r.status === 401) return askToSignIn(button);
        if (!r.ok) return toast(r.data.message || 'Could not save it. Try again.', 'error');
        on ? saved.delete(id) : saved.add(id);
        refresh();
        toast(on ? 'Removed from saved places.' : 'Saved. Find it in My account.', 'success');
    }

    document.addEventListener('click', event => {
        const button = event.target.closest('[data-save-spot]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        toggle(button);
    });

    window.ztimsSaved = { heart, refresh: () => load().then(refresh) };
    window.ztimsSaved.refresh();
    document.dispatchEvent(new CustomEvent('ztims-saved-ready'));
})();
