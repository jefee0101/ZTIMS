/* ==========================================================================
   The public site's footer
   --------------------------------------------------------------------------
   Every visitor page used to carry its own copy — two of them one line long,
   the third barer still — and none of them said where the terms, the privacy
   policy or the office were. Adding those to three hand-kept copies (and to
   the four pages that now hold them) means seven footers drifting apart, so
   the footer is drawn here once and each page only marks where it goes:

       <footer data-site-footer data-root="../"></footer>
       <script type="module" src="./shared/site-footer.js"></script>

   data-root is the path from the page back to the project root, the same
   way each page already spells its own links (index.html sits at the root
   and says "src/history.html"; a page under src/ says "history.html"). It is
   stated rather than guessed from the script's URL, because Vite bundles this
   file to /assets/ with a hashed name at build time and the URL then says
   nothing about where the page is.

   The markup below is fixed text ZTIMS wrote, plus the office's contact details
   and emergency numbers, which the Tourism Officer keeps on Settings → Office
   Information (GET /api/office). Those are escaped on the way in; nothing a
   visitor or a manager types ever reaches this footer.
   ========================================================================== */
(function () {
    'use strict';

    const YEAR = new Date().getFullYear();

    function link(href, label) {
        return '<li><a href="' + href + '">' + label + '</a></li>';
    }

    /* The office's details as last published (Settings → Office Information).
       Until they arrive, or if they cannot be fetched, the address and hours
       below are shown and the phone, email and emergency numbers are left out:
       a wrong number in an emergency is worse than none. */
    let OFFICE = {
        address: 'Municipal Hall, Poblacion, Zamboanguita, Negros Oriental 6218',
        officeHours: 'Monday to Friday, 8:00 AM – 5:00 PM',
        phone: '', email: ''
    };
    let EMERGENCY = [];

    function escapeText(value) {
        return String(value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function emergencyList() {
        return '<ul class="space-y-1">' + EMERGENCY.map(function (e) {
            const dial = String(e.number).replace(/[^0-9+]/g, '');
            return '<li class="flex flex-wrap justify-between gap-x-3"><span>' + escapeText(e.label) + '</span>' +
                '<a class="font-bold text-primary hover:underline tabular-nums" href="tel:' + dial + '">' + escapeText(e.number) + '</a></li>';
        }).join('') + '</ul>';
    }
    /* The destination page's box; empty (and so hidden) while there are no numbers. */
    function fillEmergencyBoxes() {
        document.querySelectorAll('[data-emergency]').forEach(function (box) {
            if (!EMERGENCY.length) { box.hidden = true; return; }
            /* data-emergency="inline" (Home's Tourism Office card): the numbers
               on one line, "Police: 911 · Rescue: 143", into its
               [data-emergency-list]; the box keeps its own icon and label. */
            if (box.getAttribute('data-emergency') === 'inline') {
                const target = box.querySelector('[data-emergency-list]') || box;
                target.innerHTML = EMERGENCY.map(function (e) {
                    const dial = String(e.number).replace(/[^0-9+]/g, '');
                    return '<a class="hover:underline" href="tel:' + dial + '">' + escapeText(e.label) + ': ' + escapeText(e.number) + '</a>';
                }).join(' · ');
                box.hidden = false;
                return;
            }
            box.innerHTML =
                '<p class="flex items-center gap-2 font-bold text-on-surface mb-2">' +
                    '<span class="material-symbols-outlined !text-lg text-error" aria-hidden="true">emergency</span>In an emergency</p>' +
                '<div class="text-support">' + emergencyList() + '</div>';
            box.hidden = false;
        });
    }
    window.ztimsEmergency = { fill: fillEmergencyBoxes, get count() { return EMERGENCY.length; } };

    /* Other pages' own spots for the same details (Contact Us):
       [data-office-field="address|officeHours|phone|email|dpoName|dpoEmail"], each inside an
       optional [data-office-row] that is hidden while its value is empty. */
    function fillOfficeFields() {
        document.querySelectorAll('[data-office-field]').forEach(function (el) {
            const key = el.getAttribute('data-office-field');
            const value = OFFICE[key] || '';
            const row = el.closest('[data-office-row]');
            if (row) row.hidden = !value;
            if (key === 'phone' && value) {
                el.innerHTML = '<a class="hover:text-primary hover:underline" href="tel:' + String(value).replace(/[^0-9+]/g, '') + '">' + escapeText(value) + '</a>';
            } else if ((key === 'email' || key === 'dpoEmail') && value) {
                el.innerHTML = '<a class="hover:text-primary hover:underline break-all" href="mailto:' + escapeText(value) + '">' + escapeText(value) + '</a>';
            } else {
                el.textContent = value;
            }
        });
        // A group of rows (Home's Contact: email and phone) shows while any is filled.
        document.querySelectorAll('[data-office-group]').forEach(function (group) {
            const rows = group.querySelectorAll('[data-office-row]');
            group.hidden = rows.length > 0 && Array.prototype.every.call(rows, function (row) { return row.hidden; });
        });
    }
    /* The footer (the user's design from UX Pilot, October 2026): one rounded
       card — the name and a sentence, Explore, Information, Contact Us — then
       a line with the year and the place. Styles: .site-footer in theme.css. */
    function render(root) {
        const r = root.endsWith('/') ? root : root + '/';
        const src = r + 'src/';

        return (
            '<div class="site-footer">' +
                '<div class="site-footer__card">' +
                    '<div>' +
                        '<a href="' + r + 'index.html" class="site-footer__brand">' +
                            '<span class="site-header__logo" aria-hidden="true"><span class="material-symbols-outlined">sunny</span></span>' +
                            '<span><span class="site-footer__title">ZAMBOANGUITA TOURISM</span>' +
                            '<span class="site-footer__sub">Information Management System</span></span>' +
                        '</a>' +
                        '<p class="site-footer__about">Official tourism portal of the Municipality of Zamboanguita. ' +
                            'Discover the beauty of Negros Oriental.</p>' +
                    '</div>' +

                    '<nav aria-labelledby="footerExploreHeading">' +
                        '<h2 id="footerExploreHeading" class="site-footer__h">Explore</h2>' +
                        '<ul class="site-footer__list">' +
                            link(r + 'index.html#featured', 'Destinations') +
                            link(r + 'index.html?category=STAY#featured', 'Places to stay') +
                            link(r + 'index.html?category=CULTURE#featured', 'Heritage sites') +
                            link(src + 'history.html', 'History') +
                        '</ul>' +
                    '</nav>' +

                    '<nav aria-labelledby="footerInfoHeading">' +
                        '<h2 id="footerInfoHeading" class="site-footer__h">Information</h2>' +
                        '<ul class="site-footer__list">' +
                            link(src + 'faq.html', 'FAQ') +
                            link(src + 'terms.html', 'Terms &amp; Conditions') +
                            link(src + 'privacy.html', 'Privacy Policy') +
                            link(r + 'index.html#map', 'Tourism Map') +
                        '</ul>' +
                    '</nav>' +

                    '<div aria-labelledby="footerContactHeading">' +
                        '<h2 id="footerContactHeading" class="site-footer__h">Contact us</h2>' +
                        '<a href="' + src + 'contact.html" class="site-footer__feedback">Send feedback</a>' +
                        /* Quiet on purpose: findable by the officers and enterprise
                           managers who need it, without putting a staff-only door in
                           front of every tourist. */
                        '<a href="' + src + 'staff_login.html" class="site-footer__staff">Staff and Enterprise Manager sign in →</a>' +
                    '</div>' +
                '</div>' +

                '<div class="site-footer__bottom">' +
                    '<p>© ' + YEAR + ' Municipality of Zamboanguita</p>' +
                    '<p>Zamboanguita, Negros Oriental, Philippines</p>' +
                '</div>' +
            '</div>'
        );
    }

    function draw() {
        document.querySelectorAll('[data-site-footer]').forEach(function (footer) {
            footer.innerHTML = render(footer.getAttribute('data-root') || './');
        });
        fillEmergencyBoxes();
        fillOfficeFields();
    }

    function mount() {
        document.querySelectorAll('[data-site-footer]').forEach(function (footer) {
            if (footer.getAttribute('data-site-footer-mounted')) return;
            footer.setAttribute('data-site-footer-mounted', '1');
            footer.classList.add('site-footer-host');
        });
        draw();
        // The office's latest details; drawn again once they arrive.
        fetch('/api/office').then(function (res) { return res.ok ? res.json() : null; }).then(function (office) {
            if (!office) return;
            OFFICE = {
                address: office.address || OFFICE.address, officeHours: office.officeHours || '',
                phone: office.phone || '', email: office.email || '',
                // The Data Protection Officer, on the Privacy page.
                dpoName: office.dpoName || '', dpoEmail: office.dpoEmail || ''
            };
            EMERGENCY = Array.isArray(office.emergency) ? office.emergency : [];
            draw();
        }).catch(function () { /* the built-in address stays */ });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
})();
