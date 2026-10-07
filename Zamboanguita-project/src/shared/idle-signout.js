/* ==========================================================================
   Signing an officer out after 30 minutes without activity
   --------------------------------------------------------------------------
   The office's computers are shared. An officer who walks away leaves every
   visitor's details and every refund one click from the next person at the
   desk, so the officer's pages sign out by themselves after 30 minutes with
   no mouse, key, touch or scroll on any of them.

   The last activity is kept in localStorage, which every open officer tab
   shares: working in one tab keeps the others signed in, and when the time
   is up they all sign out together. The sign-in page clears it, so a new
   sign-in always starts with a full 30 minutes.

   Loaded as a module on each officer page (src/admin/*.html). The server's
   own two-hour expiry on every sign-in still applies underneath.
   ========================================================================== */

(function () {
    'use strict';

    const IDLE_LIMIT_MS = 30 * 60 * 1000;
    const KEY = 'ztimsLastActivity';
    // Writing on every mouse movement would be wasteful; once in a while is enough.
    const WRITE_EVERY_MS = 15 * 1000;

    function signedInAsOfficer() {
        try {
            return localStorage.getItem('userRole') === 'admin' && Boolean(localStorage.getItem('authToken'));
        } catch (error) {
            return false;
        }
    }

    function lastActivity() {
        try { return Number(localStorage.getItem(KEY)) || 0; } catch (error) { return 0; }
    }

    function noteActivity() {
        try { localStorage.setItem(KEY, String(Date.now())); } catch (error) { /* private browsing */ }
    }

    function signOut() {
        try {
            if (window.ztimsTheme && window.ztimsTheme.clearStorage) window.ztimsTheme.clearStorage();
            else ['authToken', 'userRole', 'userEmail', 'userId', 'userName', KEY].forEach(k => localStorage.removeItem(k));
            sessionStorage.clear();
        } catch (error) { /* private browsing */ }
        window.location.replace('../staff_login.html?idle=1');
    }

    function idleTooLong() {
        const last = lastActivity();
        return last > 0 && Date.now() - last > IDLE_LIMIT_MS;
    }

    if (!signedInAsOfficer()) return;

    // Reopened after a long time away (a laptop lid, a tab left overnight).
    if (idleTooLong()) {
        signOut();
        return;
    }

    let lastWrite = Date.now();
    noteActivity();

    function onActivity() {
        const now = Date.now();
        if (now - lastWrite < WRITE_EVERY_MS) return;
        lastWrite = now;
        noteActivity();
    }

    ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'touchstart'].forEach(type =>
        window.addEventListener(type, onActivity, { passive: true, capture: true }));

    // Timers are slowed in a background tab and stop on a sleeping phone, so the
    // check also runs the moment the page is looked at again.
    window.setInterval(() => { if (idleTooLong()) signOut(); }, 30 * 1000);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && idleTooLong()) signOut();
    });
})();
