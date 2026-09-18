/* ==========================================================================
   Marking the page you are on
   --------------------------------------------------------------------------
   Every link in the portal sidebars carried the same classes, so the current
   page looked exactly like the five you could go to. The only way to tell
   where you were was to read the heading.

   This marks the link matching the current file, rather than each page
   hard-coding its own highlight — six links across five pages is thirty
   places to keep in step by hand, and the first rename breaks them silently.
   ========================================================================== */

(function () {
    'use strict';

    /* The active link is marked in the identity's teal, taken from the shared
       tokens so it follows the theme rather than being a second opinion about
       what the accent is. Gold read as the brand colour when it was meant to be
       an accent, and on the light theme's sand ground it barely registered. */
    const ACCENT = 'rgb(var(--ztims-accent))';
    const ACCENT_SOFT = 'rgb(var(--ztims-accent) / .12)';

    function fileOf(path) {
        return String(path || '').split('?')[0].split('#')[0].split('/').pop() || 'index.html';
    }

    let stylesInjected = false;
    function injectStyles() {
        if (stylesInjected) return;
        stylesInjected = true;

        const style = document.createElement('style');
        style.id = 'ztims-nav-active';
        style.textContent = `
        aside a.nav-active {
            color: ${ACCENT} !important;
            font-weight: 800;
            background: ${ACCENT_SOFT};
            /* An inset shadow rather than a ::before bar: these links are flex
               containers, so a pseudo-element would become a flex child and
               shift the icon and label along. */
            box-shadow: inset 3px 0 0 0 ${ACCENT};
        }
        /* The hover nudge is for places you can go. You are already here. */
        aside a.nav-active:hover { transform: none !important; }
        aside a.nav-active .sidebar-label { color: ${ACCENT} !important; }
        aside a.nav-active .material-symbols-outlined {
            color: ${ACCENT} !important;
            font-variation-settings: 'FILL' 1;
        }`;
        document.head.appendChild(style);
    }

    function mark() {
        const here = fileOf(window.location.pathname);

        document.querySelectorAll('aside a[href]').forEach(function (link) {
            const href = link.getAttribute('href') || '';
            // Leave anything pointing off the portal alone — Log Out and the
            // public site both end in index.html and are not "where you are".
            const isSameFolder = !/^(https?:)?\/\//.test(href) && !href.startsWith('../../');
            const active = isSameFolder && fileOf(href) === here;

            link.classList.toggle('nav-active', active);
            if (active) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });
    }

    function start() {
        injectStyles();
        mark();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
