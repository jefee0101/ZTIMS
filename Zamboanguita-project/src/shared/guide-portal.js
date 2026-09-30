/* ==========================================================================
   The Tourist Guide portal — shared by the four pages in src/guide/
   --------------------------------------------------------------------------
   A guide signs in on the same staff page as everyone else and lands here.
   One kind of account for every guide; its scope is the guide's jurisdiction —
   the whole municipality, or one barangay. The screens are the same; the scope
   only filters what the guide sees and what the office may assign them. All
   guides are managed by the Tourism Officer on the Tourist Guides page.

   The guide proposes, the office disposes. A guide keeps their availability
   and languages, edits their own contact number and bio, and files reports;
   the office assigns every booking. Everything else on their record is shown
   read-only. The server enforces all of it; the
   read-only screens only save a guide from typing into a field that would be
   refused.

   This draws the frame every guide page shares — sidebar, header, account
   menu, phone drawer — and holds the helpers they all call. Loaded as a
   module, like the other shared scripts, so it runs after the page is parsed
   and before DOMContentLoaded; pages call window.GuidePortal only from their
   own DOMContentLoaded handler.

       GuidePortal.start()            -> false when not signed in as a guide
       GuidePortal.api(path, opts)    -> { response, result }, 401 signs out
       GuidePortal.escapeHtml, formatDate, formatTime, showLoading,
       setButtonLoading, showMessage, showToast, weekdays, stationLabel
   ========================================================================== */
(function () {
    'use strict';

    const API_BASE = '/api';

    const NAV = [
        { href: 'guide_dashboard.html', icon: 'monitoring', label: 'Dashboard' },
        { href: 'guide_schedule.html', icon: 'event_available', label: 'Schedule & Availability' },
        { href: 'guide_languages.html', icon: 'translate', label: 'Languages' },
        { href: 'guide_profile.html', icon: 'badge', label: 'My Profile' }
    ];

    const WEEKDAYS = [
        { value: 'mon', short: 'Mon', label: 'Monday' },
        { value: 'tue', short: 'Tue', label: 'Tuesday' },
        { value: 'wed', short: 'Wed', label: 'Wednesday' },
        { value: 'thu', short: 'Thu', label: 'Thursday' },
        { value: 'fri', short: 'Fri', label: 'Friday' },
        { value: 'sat', short: 'Sat', label: 'Saturday' },
        { value: 'sun', short: 'Sun', label: 'Sunday' }
    ];

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }

    // A YYYY-MM-DD date read as a calendar date: parsed as local midnight, so it
    // never shows as the day before in a timezone west of UTC.
    function formatDate(value, options) {
        if (!value) return '—';
        const text = String(value);
        const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(text + 'T00:00:00') : new Date(text);
        return Number.isNaN(date.getTime())
            ? '—'
            : date.toLocaleDateString(undefined, options || { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
    }

    function formatTime(value) {
        const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
        if (!match) return value || '—';
        const hour = Number(match[1]);
        return `${((hour + 11) % 12) + 1}:${match[2]} ${hour < 12 ? 'AM' : 'PM'}`;
    }

    // The guide's scope, in words: their jurisdiction and where they are stationed.
    function stationLabel(guide) {
        if (!guide) return '';
        return guide.scope === 'barangay'
            ? `Barangay guide · Brgy. ${guide.barangay || '—'}`
            : 'Municipal guide · whole municipality';
    }

    /* ---- toasts ------------------------------------------------------------
       The same notification the other portals use, so a saved change reads the
       same here as anywhere else. */
    const TONES = {
        success: { icon: 'check_circle', accent: 'rgb(var(--ztims-success))' },
        error: { icon: 'error', accent: 'rgb(var(--ztims-error))' },
        info: { icon: 'info', accent: 'rgb(var(--ztims-secondary))' }
    };

    function toastHost() {
        let host = document.getElementById('toastHost');
        if (host) return host;
        host = document.createElement('div');
        host.id = 'toastHost';
        host.setAttribute('role', 'status');
        host.setAttribute('aria-live', 'polite');
        host.style.cssText = 'position:fixed;top:1rem;left:50%;transform:translateX(-50%);z-index:2147483000;' +
            'display:flex;flex-direction:column;align-items:center;gap:.6rem;width:min(26rem, calc(100vw - 2rem));pointer-events:none';
        document.body.appendChild(host);

        const style = document.createElement('style');
        style.textContent =
            '@keyframes toastIn{from{opacity:0;transform:translateY(-.9rem)}to{opacity:1;transform:none}}' +
            '@keyframes toastOut{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-.9rem)}}' +
            '@media (prefers-reduced-motion: reduce){#toastHost > *{animation:none !important}}';
        document.head.appendChild(style);
        return host;
    }

    function showToast(message, tone, options) {
        const settings = TONES[tone] || TONES.info;
        const duration = options && typeof options.duration === 'number' ? options.duration : (tone === 'error' ? 6000 : 4000);

        const toast = document.createElement('div');
        toast.style.cssText = 'pointer-events:auto;width:100%;box-sizing:border-box;display:flex;align-items:flex-start;gap:.65rem;' +
            'padding:.85rem 1rem;background:rgb(var(--glass-fill) / var(--glass-alpha-overlay));' +
            '-webkit-backdrop-filter:blur(var(--glass-blur)) saturate(var(--glass-saturate));' +
            'backdrop-filter:blur(var(--glass-blur)) saturate(var(--glass-saturate));color:rgb(var(--ztims-on-surface));' +
            'border:1px solid var(--glass-hairline);border-left:4px solid ' + settings.accent + ';' +
            'box-shadow:inset 0 1px 0 var(--glass-edge), var(--ztims-shadow-overlay);font-size:.85rem;line-height:1.45;' +
            'animation:toastIn var(--dur-moderate, 300ms) var(--ease-decelerate, ease-out)';

        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined';
        icon.textContent = settings.icon;
        icon.style.cssText = 'color:' + settings.accent + ';font-size:1.25rem;flex-shrink:0;line-height:1.2';

        const text = document.createElement('div');
        text.textContent = message;          // server text: never markup
        text.style.cssText = 'flex:1;white-space:pre-line;word-break:break-word';

        const close = document.createElement('button');
        close.type = 'button';
        close.setAttribute('aria-label', 'Dismiss');
        close.textContent = '×';
        close.style.cssText = 'background:none;border:0;color:rgb(var(--ztims-on-surface-variant));font-size:1.1rem;line-height:1;cursor:pointer;padding:0 .15rem;flex-shrink:0';

        toast.append(icon, text, close);
        toastHost().appendChild(toast);

        let timer = null;
        function dismiss() {
            if (timer) clearTimeout(timer);
            toast.style.animation = 'toastOut 200ms var(--ease-accelerate, ease-in) forwards';
            setTimeout(() => toast.remove(), 200);
        }
        close.addEventListener('click', dismiss);
        if (duration > 0) timer = setTimeout(dismiss, duration);
        return dismiss;
    }

    /* ---- session ----------------------------------------------------------- */
    function signOut() {
        try {
            localStorage.clear();
            sessionStorage.clear();
        } catch { /* private browsing */ }
        showToast('Signed out.', 'success', { duration: 2000 });
        // replace(), not href: the portal must not come back with the back button.
        setTimeout(() => window.location.replace('../../index.html'), 600);
    }

    function handleExpiredSession(message) {
        try { localStorage.removeItem('authToken'); } catch { /* private browsing */ }
        showToast(message || 'Your sign-in has expired. Signing you back in — nothing has been lost.', 'info');
        setTimeout(() => { window.location.href = '../staff_login.html?expired=1'; }, 900);
    }

    /* Every call the guide pages make. A 401 means the sign-in ended (it expired,
       or the office withdrew it), except on the password form, where it means
       the current password was wrong — that caller passes keep401. */
    async function api(path, options) {
        const settings = options || {};
        const headers = { Authorization: `Bearer ${localStorage.getItem('authToken') || ''}` };
        if (settings.body !== undefined) headers['Content-Type'] = 'application/json';

        const response = await fetch(`${API_BASE}${path}`, {
            method: settings.method || 'GET',
            headers,
            body: settings.body !== undefined ? JSON.stringify(settings.body) : undefined
        });
        const result = await response.json().catch(() => ({}));
        if (response.status === 401 && !settings.keep401) {
            handleExpiredSession(result.message && !/expired|invalid/i.test(result.message) ? result.message : undefined);
            throw new Error('Your sign-in has ended.');
        }
        if (!response.ok || result.success === false) {
            throw new Error(result.message || `The server refused (status ${response.status}).`);
        }
        return { response, result };
    }

    /* ---- small UI helpers ---------------------------------------------------- */
    function showLoading(target, message) {
        target.innerHTML =
            '<div class="flex flex-col items-center justify-center gap-3 py-16 w-full text-center">' +
                '<div class="w-10 h-10 rounded-full border-4 border-current border-t-transparent animate-spin opacity-80"></div>' +
                '<p class="text-sm opacity-80">' + escapeHtml(message) + '</p>' +
                '<p data-slow class="text-support opacity-60 hidden">The server is taking a moment — this can take up to a minute.</p>' +
            '</div>';
        const timer = setTimeout(() => {
            const note = target.querySelector('[data-slow]');
            if (note) note.classList.remove('hidden');
        }, 5000);
        return () => clearTimeout(timer);
    }

    function showLoadError(target, what, error) {
        target.innerHTML = `
            <div class="glass-panel rounded-2xl p-5 sm:p-8 text-center">
                <span class="material-symbols-outlined text-4xl block mb-2 text-error/70">cloud_off</span>
                <p class="text-on-surface font-bold mb-1">Could not load ${escapeHtml(what)}</p>
                <p class="text-on-surface-variant text-sm">${escapeHtml(error.message)} Nothing has been changed — refresh to try again.</p>
            </div>`;
    }

    function setButtonLoading(btn, label) {
        if (!btn) return () => {};
        const originalHTML = btn.innerHTML;
        const wasDisabled = btn.disabled;
        btn.disabled = true;
        btn.innerHTML = '<span class="inline-block w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin align-[-2px] mr-2"></span>' + escapeHtml(label);
        return () => { btn.innerHTML = originalHTML; btn.disabled = wasDisabled; };
    }

    function showMessage(id, message, tone) {
        const box = document.getElementById(id);
        if (!box) return;
        box.textContent = message || '';
        box.className = 'text-sm rounded-xl px-4 py-3 ' + (tone === 'error'
            ? 'text-error bg-error/10 border border-error/20'
            : 'text-primary bg-primary/10 border border-primary/20');
        box.hidden = !message;
    }

    /* ---- the frame ------------------------------------------------------------ */
    function currentFile() {
        return window.location.pathname.split('/').pop() || '';
    }

    function drawFrame() {
        const here = currentFile();
        const links = NAV.map(item => {
            const active = item.href === here;
            return `
                <a title="${escapeHtml(item.label)}" href="${item.href}"${active ? ' aria-current="page"' : ''}
                   class="flex items-center gap-3 ${active ? 'bg-primary/10 text-accent font-extrabold' : 'text-on-surface-variant hover:text-accent hover:translate-x-1'} px-5 py-3.5 rounded-xl transition-all duration-300">
                    <span class="material-symbols-outlined text-accent">${item.icon}</span>
                    <span class="sidebar-label">${escapeHtml(item.label)}</span>
                </a>`;
        }).join('');

        const frame = document.createElement('div');
        frame.innerHTML = `
            <div id="navScrim" aria-hidden="true"></div>
            <aside class="fixed left-0 top-0 h-full w-64 glass-nav border-r border-outline-variant/30 z-[100] flex flex-col p-5 sm:p-6 transition-colors duration-300">
                <div class="mb-10 px-2 flex items-start justify-between gap-2"><div>
                    <h1 class="sidebar-brand-full text-xl font-extrabold tracking-tight font-headline text-primary">EXPLORE<br><span class="text-accent">ZAMBOANGUITA</span></h1>
                    <p class="sidebar-label text-label uppercase tracking-widest mt-2">Tourist Guide Portal</p>
                    <span class="sidebar-brand-short text-2xl font-extrabold font-headline text-primary">EZ</span></div>
                    <button id="sidebarToggleBtn" type="button" title="Collapse sidebar" aria-label="Collapse sidebar"
                            class="shrink-0 p-2.5 rounded-lg min-h-[44px] min-w-[44px] flex items-center justify-center text-on-surface-variant hover:text-accent hover:bg-on-surface/5 transition-all">
                        <span id="sidebarToggleIcon" class="material-symbols-outlined !text-xl">left_panel_close</span>
                    </button>
                </div>
                <nav class="flex-1 space-y-2 font-body">${links}</nav>
                <div class="mt-auto pt-4 border-t border-outline-variant/30">
                    <a title="Log Out" id="logoutLink" href="../../index.html"
                       class="flex items-center gap-3 text-on-surface-variant px-5 py-3.5 rounded-xl hover:text-error transition-all duration-300 hover:translate-x-1">
                        <span class="material-symbols-outlined">logout</span>
                        <span class="sidebar-label">Log Out</span>
                    </a>
                </div>
            </aside>
            <header class="fixed top-0 right-0 w-full sm:w-[calc(100%-16rem)] flex justify-between items-center gap-3 px-4 sm:px-8 py-3 sm:py-4 z-50 glass-nav border-b border-outline-variant/20 transition-colors duration-300">
                <button id="navOpenBtn" type="button" aria-label="Open navigation" aria-expanded="false"
                        class="sm:hidden p-2.5 -ml-1 rounded-xl text-on-surface hover:bg-on-surface/5 transition-colors flex items-center justify-center min-h-[44px] min-w-[44px]">
                    <span class="material-symbols-outlined">menu</span>
                </button>
                <span class="hidden sm:block"></span>
                <div class="flex items-center gap-3">
                    <button id="themeToggleBtn" type="button" class="p-2.5 rounded-full bg-surface-variant border border-outline-variant/30 hover:scale-110 transition-all flex items-center justify-center">
                        <span id="themeIcon" class="material-symbols-outlined text-accent">dark_mode</span>
                    </button>
                    <div id="accountMenuSlot"></div>
                </div>
            </header>`;
        document.body.prepend(...frame.children);

        // theme.js binds #themeToggleBtn and sets its icon whenever it applies.
        if (typeof window.applyTheme === 'function' && window.ztimsTheme) window.applyTheme(window.ztimsTheme.current());

        wireSidebarCollapse();
        wireDrawer();
        document.getElementById('logoutLink').addEventListener('click', event => {
            event.preventDefault();
            signOut();
        });
        mountAccountMenu();
        document.body.classList.add('guide-portal-ready');
    }

    function wireSidebarCollapse() {
        const btn = document.getElementById('sidebarToggleBtn');
        const icon = document.getElementById('sidebarToggleIcon');
        function apply(collapsed) {
            document.body.classList.toggle('sidebar-collapsed', collapsed);
            icon.textContent = collapsed ? 'left_panel_open' : 'left_panel_close';
            const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
            btn.title = label;
            btn.setAttribute('aria-label', label);
        }
        btn.addEventListener('click', () => {
            const collapsed = !document.body.classList.contains('sidebar-collapsed');
            apply(collapsed);
            try { localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0'); } catch { /* private browsing */ }
        });
        try { apply(localStorage.getItem('sidebarCollapsed') === '1'); } catch { apply(false); }
    }

    function wireDrawer() {
        const openBtn = document.getElementById('navOpenBtn');
        const scrim = document.getElementById('navScrim');
        const aside = document.querySelector('aside');
        function setOpen(open) {
            document.body.classList.toggle('nav-open', open);
            openBtn.setAttribute('aria-expanded', String(open));
        }
        openBtn.addEventListener('click', () => setOpen(!document.body.classList.contains('nav-open')));
        scrim.addEventListener('click', () => setOpen(false));
        document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
        aside.addEventListener('click', e => { if (e.target.closest('a')) setOpen(false); });
        window.addEventListener('resize', () => { if (window.innerWidth >= 640) setOpen(false); });
    }

    function mountAccountMenu() {
        const slot = document.getElementById('accountMenuSlot');
        if (!slot) return;
        const name = localStorage.getItem('guideName') || 'Tourist guide';
        const email = localStorage.getItem('userEmail') || '';
        const photo = localStorage.getItem('guidePhoto') || '';
        slot.innerHTML = '';

        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative';
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.title = name;
        button.style.cssText = 'display:flex;align-items:center;justify-content:center;width:2.5rem;height:2.5rem;' +
            'border:2px solid rgb(var(--ztims-secondary) / .55);background:rgb(var(--ztims-surface-variant));' +
            'color:rgb(var(--ztims-accent));font-weight:800;font-size:.95rem;cursor:pointer;overflow:hidden';
        const initial = (name || email || '?').trim().charAt(0).toUpperCase();
        if (photo) {
            const img = document.createElement('img');
            img.src = photo;
            img.alt = '';
            img.style.cssText = 'width:100%;height:100%;object-fit:cover';
            img.addEventListener('error', () => { img.remove(); button.textContent = initial; });
            button.appendChild(img);
        } else {
            button.textContent = initial;
        }

        const menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        menu.hidden = true;
        menu.style.cssText = 'position:absolute;top:calc(100% + .6rem);right:0;z-index:1500;min-width:15rem;padding:.4rem;' +
            'background:rgb(var(--glass-fill) / var(--glass-alpha-overlay));' +
            '-webkit-backdrop-filter:blur(var(--glass-blur)) saturate(var(--glass-saturate));' +
            'backdrop-filter:blur(var(--glass-blur)) saturate(var(--glass-saturate));border:1px solid var(--glass-hairline);' +
            'color:rgb(var(--ztims-on-surface));box-shadow:inset 0 1px 0 var(--glass-edge), var(--ztims-shadow-overlay);' +
            'animation:ztimsMenuIn var(--dur-base, 220ms) var(--ease-decelerate, ease-out);font-size:.85rem';

        const head = document.createElement('div');
        head.style.cssText = 'padding:.65rem .75rem;border-bottom:1px solid rgb(var(--ztims-outline));margin-bottom:.3rem';
        const nameLine = document.createElement('div');
        nameLine.textContent = name;
        nameLine.style.cssText = 'font-weight:800;word-break:break-word';
        const emailLine = document.createElement('div');
        emailLine.textContent = email;
        emailLine.style.cssText = 'font-size:.75rem;color:rgb(var(--ztims-on-surface-variant));word-break:break-all;margin-top:.1rem';
        head.append(nameLine, emailLine);
        menu.appendChild(head);

        [
            { label: 'My profile', icon: 'badge', href: 'guide_profile.html' },
            { label: 'Sign out', icon: 'logout', danger: true, onSelect: signOut }
        ].forEach(item => {
            const entry = document.createElement(item.href ? 'a' : 'button');
            entry.setAttribute('role', 'menuitem');
            if (item.href) entry.href = item.href; else entry.type = 'button';
            entry.style.cssText = 'display:flex;align-items:center;gap:.6rem;width:100%;padding:.6rem .75rem;border:0;background:none;' +
                'color:' + (item.danger ? 'rgb(var(--ztims-error))' : 'inherit') + ';font:inherit;text-align:left;text-decoration:none;cursor:pointer';
            entry.innerHTML = `<span class="material-symbols-outlined !text-lg">${item.icon}</span>`;
            const label = document.createElement('span');
            label.textContent = item.label;
            entry.appendChild(label);
            entry.addEventListener('mouseenter', () => { entry.style.background = 'rgb(var(--ztims-on-surface) / .06)'; });
            entry.addEventListener('mouseleave', () => { entry.style.background = 'none'; });
            entry.addEventListener('click', () => {
                menu.hidden = true;
                if (item.onSelect) item.onSelect();
            });
            menu.appendChild(entry);
        });

        button.addEventListener('click', event => {
            event.stopPropagation();
            menu.hidden = !menu.hidden;
            button.setAttribute('aria-expanded', String(!menu.hidden));
        });
        document.addEventListener('click', event => { if (!menu.hidden && !wrap.contains(event.target)) menu.hidden = true; });
        document.addEventListener('keydown', event => { if (event.key === 'Escape') menu.hidden = true; });

        wrap.append(button, menu);
        slot.appendChild(wrap);
    }

    /* Keeps the corner's name and photo in step with what the server says, so a
       name the office corrected shows at once rather than at the next sign-in. */
    function rememberGuide(guide) {
        if (!guide) return;
        try {
            if (guide.fullName) localStorage.setItem('guideName', guide.fullName);
            localStorage.setItem('guidePhoto', guide.photoUrl || '');
        } catch { /* private browsing */ }
        mountAccountMenu();
    }

    /* Call first, from DOMContentLoaded. Anyone who is not signed in as a guide
       goes to the staff sign-in page instead of seeing an empty portal. */
    function start() {
        if (localStorage.getItem('userRole') !== 'tourist_guide' || !localStorage.getItem('authToken')) {
            window.location.href = '../staff_login.html';
            return false;
        }
        if (!document.querySelector('aside')) drawFrame();
        return true;
    }

    window.GuidePortal = {
        start,
        api,
        rememberGuide,
        escapeHtml,
        formatDate,
        formatTime,
        stationLabel,
        showLoading,
        showLoadError,
        setButtonLoading,
        showMessage,
        showToast,
        weekdays: WEEKDAYS
    };
})();
