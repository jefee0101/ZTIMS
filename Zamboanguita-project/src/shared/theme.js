/* ==========================================================================
   Light and dark — one implementation for every page
   --------------------------------------------------------------------------
   Loaded as a plain, blocking <script src> in each page's <head>, before
   anything is painted, so the page's first frame is already the right theme.
   It used to be an 84-line copy inside all twenty pages.

   Which theme a visitor sees:
     1. the one they last chose with the toggle, on ANY page of the site — one
        choice for every page, kept until they toggle again;
     2. until they have chosen, their device's own setting
        (prefers-color-scheme), followed live.

   The choice is one localStorage key, `theme`, read by every page before it
   paints, and passed to other open tabs at once (the storage event). Signing
   out clears the sign-in, not the theme: pages sign out through
   ztimsTheme.clearStorage(), which keeps it.

   The toggle's icon shows the theme you are in (a moon while dark, a sun while
   light), and its label says what pressing it does.

   Switching is animated: a crossfade through the View Transitions API where
   the browser has it, otherwise a short colour transition on every element,
   switched on only for the moment of the change — never permanently, which is
   what the pages used to do and what made every hover pay for it.

   The API the pages already call is unchanged:
     window.toggleTheme()             flip, and remember
     window.toggleDarkMode()          the same, for inline onclick="…"
     window.applyTheme('dark'|'light')
     window.ztimsTheme.current()      'dark' | 'light'
   ========================================================================== */
(function () {
    var STORAGE_KEY = 'theme';
    var root = document.documentElement;
    var systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    var reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

    // The browser's own chrome (the address bar on a phone) follows the theme.
    var THEME_COLOR = { light: '#FFFFFF', dark: '#000000' };

    function stored() {
        try {
            var value = localStorage.getItem(STORAGE_KEY);
            return value === 'light' || value === 'dark' ? value : null;
        } catch { return null; }          // private browsing
    }

    function system() {
        return systemDark && systemDark.matches ? 'dark' : 'light';
    }

    function current() {
        return stored() || system();
    }

    function apply(theme) {
        var dark = theme === 'dark';

        // Every class convention the pages' stylesheets rely on, so none has to
        // change how it asks.
        root.classList.toggle('dark', dark);
        root.classList.toggle('light-mode', !dark);
        root.setAttribute('data-theme', dark ? 'dark' : 'light');
        if (document.body) {
            document.body.classList.toggle('light-mode', !dark);
            document.body.classList.toggle('dark-mode', dark);
        }

        var meta = document.querySelector('meta[name="theme-color"]');
        if (!meta && document.head) {
            meta = document.createElement('meta');
            meta.name = 'theme-color';
            document.head.appendChild(meta);
        }
        if (meta) meta.content = THEME_COLOR[dark ? 'dark' : 'light'];

        // A moon while dark, a sun while light — the same way round everywhere.
        var glyph = dark ? 'dark_mode' : 'light_mode';
        ['themeIcon', 'themeToggleIcon'].forEach(function (id) {
            var icon = document.getElementById(id);
            if (icon) icon.textContent = glyph;
        });

        var label = dark ? 'Switch to light mode' : 'Switch to dark mode';
        var buttons = ['themeToggleBtn', 'themeToggleButton'].map(function (id) { return document.getElementById(id); });
        ['themeIcon', 'themeToggleIcon'].forEach(function (id) {
            var icon = document.getElementById(id);
            if (icon && icon.closest) buttons.push(icon.closest('button'));
        });
        buttons.forEach(function (button) {
            if (!button) return;
            button.title = label;
            button.setAttribute('aria-label', label);
            button.setAttribute('aria-pressed', dark ? 'true' : 'false');
            bindToggle(button);
        });
    }

    /* Bound at most once per button, and never over a button that already
       carries an inline onclick: two handlers would toggle twice and land back
       where they started, which looks exactly like a button that does nothing. */
    function bindToggle(button) {
        if (button.getAttribute('data-theme-bound')) return;
        if (button.getAttribute('onclick')) return;
        button.setAttribute('data-theme-bound', '1');
        button.addEventListener('click', function () { window.toggleTheme(); });
    }

    /* The change itself, animated. The View Transition snapshots the page as it
       is, swaps the theme underneath, and crossfades — one composited fade
       rather than every element on the page animating its own colours. */
    function switchTo(theme) {
        // A tab in the background (another tab changed the theme) switches at
        // once: browsers hold a hidden tab's transition until it is looked at.
        var still = (reduceMotion && reduceMotion.matches) || document.hidden;
        if (still) { apply(theme); return; }

        if (document.startViewTransition) {
            root.classList.add('theme-switching');
            var transition = document.startViewTransition(function () { apply(theme); });
            transition.finished.finally(function () { root.classList.remove('theme-switching'); });
            return;
        }

        root.classList.add('theme-transition');
        apply(theme);
        window.setTimeout(function () { root.classList.remove('theme-transition'); }, 350);
    }

    // Everything a sign-out should forget, but not the theme.
    function clearStorage() {
        var keep = stored();
        try {
            localStorage.clear();
            if (keep) localStorage.setItem(STORAGE_KEY, keep);
        } catch { /* private browsing */ }
    }

    window.applyTheme = apply;
    window.ztimsTheme = { current: current, system: system, clearStorage: clearStorage };

    window.toggleTheme = function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        // Always remembered, so every page shows the same until toggled again.
        try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private browsing: this page view only */ }
        switchTo(next);
    };

    // Pages written earlier call this name from an inline onclick.
    window.toggleDarkMode = window.toggleTheme;

    // The device changed its mind (sunset, a shortcut, a schedule). Followed only
    // until the visitor has chosen for themselves.
    if (systemDark) {
        var follow = function () { if (!stored()) switchTo(system()); };
        if (systemDark.addEventListener) systemDark.addEventListener('change', follow);
        else if (systemDark.addListener) systemDark.addListener(follow);   // Safari < 14
    }

    // A choice made in another tab applies here too.
    window.addEventListener('storage', function (event) {
        if (event.key === STORAGE_KEY) switchTo(current());
    });

    apply(current());
    // The body classes cannot be set before the body exists, so they are applied
    // again once it does. The html class above already prevents the flash.
    document.addEventListener('DOMContentLoaded', function () { apply(current()); });
})();
