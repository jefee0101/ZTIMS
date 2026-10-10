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

    /* One class string for every link, so a change to the touch target or the
       hover colour happens once. 44px tall: the footer is read on phones. */
    const LINK = 'inline-flex items-center gap-1.5 min-h-[44px] py-2 text-sm text-on-surface-variant hover:text-primary transition-colors';
    const HEADING = 'text-label font-bold uppercase tracking-widest text-on-surface mb-3';

    function link(href, label, icon) {
        return '<li><a href="' + href + '" class="' + LINK + '">' +
            (icon ? '<span class="material-symbols-outlined !text-base" aria-hidden="true">' + icon + '</span>' : '') +
            label + '</a></li>';
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
    }
    function contactLines() {
        return '<p>' + escapeText(OFFICE.address) + '</p>' +
            (OFFICE.officeHours ? '<p>' + escapeText(OFFICE.officeHours) + '</p>' : '') +
            (OFFICE.phone ? '<p><a class="hover:text-primary hover:underline" href="tel:' + String(OFFICE.phone).replace(/[^0-9+]/g, '') + '">' + escapeText(OFFICE.phone) + '</a></p>' : '') +
            (OFFICE.email ? '<p><a class="hover:text-primary hover:underline break-all" href="mailto:' + escapeText(OFFICE.email) + '">' + escapeText(OFFICE.email) + '</a></p>' : '');
    }

    /* The strip across the top of the footer: ten flat tiles of
       Zamboanguita — sun over the sea, a bangka, reef fish, a sea turtle,
       palms, a waterfall in the hills, the heritage church, the Malatapay
       market, and two pattern tiles — in the identity's oranges, cream and
       ink, repeated across the width. Decoration only: hidden from screen
       readers, inline so it needs no file and no request. */
    const TILES = '<g transform="translate(0 0)"><rect width="80" height="80" fill="#F28500"/><circle cx="40" cy="40" r="16" fill="#FFC48C"/><path d="M0,50 q10,-6 20,0 t20,0 t20,0 t20,0 V80 H0Z" fill="#BF5700"/><path d="M0,64 q10,-6 20,0 t20,0 t20,0 t20,0 V80 H0Z" fill="#7A2E00"/></g><g transform="translate(80 0)"><rect width="80" height="80" fill="#7A2E00"/><polygon points="41,14 41,48 60,48" fill="#F28500"/><rect x="39" y="12" width="2" height="40" fill="#FFC48C"/><path d="M16,50 H64 L57,59 H23 Z" fill="#FAF7F2"/><rect x="8" y="55" width="64" height="2" fill="#FFC48C"/><rect x="26" y="50" width="2" height="7" fill="#FFC48C"/><rect x="52" y="50" width="2" height="7" fill="#FFC48C"/><rect y="64" width="80" height="16" fill="#BF5700"/></g><g transform="translate(160 0)"><rect width="80" height="80" fill="#BF5700"/><ellipse cx="30" cy="22" rx="10" ry="6" fill="#F28500"/><polygon points="38,22 47,16 47,28" fill="#F28500"/><circle cx="25" cy="21" r="1.4" fill="#1C1917"/><ellipse cx="46" cy="41" rx="10" ry="6" fill="#FFC48C"/><polygon points="54,41 63,35 63,47" fill="#FFC48C"/><circle cx="41" cy="40" r="1.4" fill="#1C1917"/><ellipse cx="28" cy="60" rx="10" ry="6" fill="#F28500"/><polygon points="36,60 45,54 45,66" fill="#F28500"/><circle cx="23" cy="59" r="1.4" fill="#1C1917"/></g><g transform="translate(240 0)"><rect width="80" height="80" fill="#F28500"/><ellipse cx="25" cy="28" rx="9" ry="5" transform="rotate(-35 25 28)" fill="#7A2E00"/><ellipse cx="55" cy="28" rx="9" ry="5" transform="rotate(35 55 28)" fill="#7A2E00"/><ellipse cx="27" cy="56" rx="7" ry="4" transform="rotate(35 27 56)" fill="#7A2E00"/><ellipse cx="53" cy="56" rx="7" ry="4" transform="rotate(-35 53 56)" fill="#7A2E00"/><circle cx="40" cy="15" r="6" fill="#7A2E00"/><ellipse cx="40" cy="42" rx="15" ry="19" fill="#7A2E00"/><polygon points="40,30 49,36 49,48 40,54 31,48 31,36" fill="#BF5700"/></g><g transform="translate(320 0)"><rect width="80" height="80" fill="#FFC48C"/><polygon points="0,0 80,0 40,40" fill="#BF5700"/><polygon points="0,80 80,80 40,40" fill="#BF5700"/><polygon points="40,32 48,40 40,48 32,40" fill="#7A2E00"/></g><g transform="translate(400 0)"><rect width="80" height="80" fill="#BF5700"/><path d="M0,80 Q40,58 80,80 Z" fill="#F28500"/><path d="M30,70 Q28,48 36,30" stroke="#7A2E00" stroke-width="4" fill="none"/><path d="M52,70 Q55,52 50,38" stroke="#7A2E00" stroke-width="4" fill="none"/><path d="M36,30 q-14,-4 -20,6 q10,-8 20,-6 q-6,-14 -18,-12 q14,0 18,12 q4,-14 18,-14 q-12,4 -18,14 q14,-2 20,8 q-10,-8 -20,-8Z" fill="#7A2E00"/><path d="M50,38 q-10,-4 -16,4 q8,-6 16,-4 q2,-10 14,-10 q-10,2 -14,10 q10,0 14,8 q-8,-6 -14,-8Z" fill="#7A2E00"/></g><g transform="translate(480 0)"><rect width="80" height="80" fill="#7A2E00"/><polygon points="0,80 0,32 22,14 40,30 60,16 80,30 80,80" fill="#BF5700"/><rect x="34" y="26" width="12" height="42" fill="#FAF7F2"/><rect x="37" y="26" width="2" height="42" fill="#FFC48C"/><rect x="42" y="26" width="2" height="42" fill="#FFC48C"/><ellipse cx="40" cy="70" rx="20" ry="6" fill="#F28500"/></g><g transform="translate(560 0)"><rect width="80" height="80" fill="#F28500"/><rect y="70" width="80" height="10" fill="#BF5700"/><polygon points="22,70 22,36 40,22 58,36 58,70" fill="#FAF7F2"/><rect x="39" y="9" width="2" height="12" fill="#7A2E00"/><rect x="35" y="12" width="10" height="2" fill="#7A2E00"/><circle cx="40" cy="38" r="4" fill="#7A2E00"/><path d="M33,70 V56 a7,7 0 0 1 14,0 V70Z" fill="#7A2E00"/></g><g transform="translate(640 0)"><rect width="80" height="80" fill="#BF5700"/><rect x="10" y="16" width="10" height="12" fill="#F28500"/><rect x="20" y="16" width="10" height="12" fill="#FAF7F2"/><rect x="30" y="16" width="10" height="12" fill="#F28500"/><rect x="40" y="16" width="10" height="12" fill="#FAF7F2"/><rect x="50" y="16" width="10" height="12" fill="#F28500"/><rect x="60" y="16" width="10" height="12" fill="#FAF7F2"/><circle cx="15" cy="28" r="5" fill="#F28500"/><circle cx="25" cy="28" r="5" fill="#FAF7F2"/><circle cx="35" cy="28" r="5" fill="#F28500"/><circle cx="45" cy="28" r="5" fill="#FAF7F2"/><circle cx="55" cy="28" r="5" fill="#F28500"/><circle cx="65" cy="28" r="5" fill="#FAF7F2"/><rect x="12" y="33" width="2" height="30" fill="#7A2E00"/><rect x="66" y="33" width="2" height="30" fill="#7A2E00"/><rect x="10" y="48" width="60" height="6" fill="#7A2E00"/><circle cx="24" cy="44" r="5" fill="#F28500"/><circle cx="34" cy="44" r="5" fill="#FFC48C"/><circle cx="46" cy="44" r="5" fill="#F28500"/><circle cx="57" cy="44" r="5" fill="#FFC48C"/></g><g transform="translate(720 0)"><rect width="80" height="80" fill="#7A2E00"/><polygon points="16,7 25,16 16,25 7,16" fill="#F28500"/><polygon points="16,31 25,40 16,49 7,40" fill="#F28500"/><polygon points="16,55 25,64 16,73 7,64" fill="#F28500"/><polygon points="40,7 49,16 40,25 31,16" fill="#F28500"/><polygon points="40,31 49,40 40,49 31,40" fill="#F28500"/><polygon points="40,55 49,64 40,73 31,64" fill="#F28500"/><polygon points="64,7 73,16 64,25 55,16" fill="#F28500"/><polygon points="64,31 73,40 64,49 55,40" fill="#F28500"/><polygon points="64,55 73,64 64,73 55,64" fill="#F28500"/></g>';
    function tileStrip() {
        let copies = '';
        for (let i = 0; i < 4; i += 1) {
            copies += '<svg class="footer-tiles__row" viewBox="0 0 800 80" preserveAspectRatio="xMinYMin meet" focusable="false"><use href="#ztimsFooterTiles"/></svg>';
        }
        return '<div class="footer-tiles" aria-hidden="true">' +
            '<svg width="0" height="0" style="position:absolute"><defs><g id="ztimsFooterTiles">' + TILES + '</g></defs></svg>' +
            copies + '</div>';
    }

    function render(root) {
        const r = root.endsWith('/') ? root : root + '/';
        const src = r + 'src/';

        return (
            tileStrip() +
            '<div class="max-w-[1600px] mx-auto px-5 sm:px-6 md:px-10 pt-12 pb-8 sm:pt-14">' +

                /* Four columns on a desktop, two on a tablet, one on a phone.
                   The wordmark column is the widest because it carries a
                   sentence; the link columns only need to be as wide as their
                   longest label. */
                '<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-x-8 gap-y-10">' +

                    '<div class="lg:col-span-5">' +
                        '<a href="' + r + 'index.html" class="inline-block leading-tight">' +
                            '<span class="block text-base font-extrabold tracking-tight font-headline text-primary">ZAMBOANGUITA <span class="text-accent">TOURISM</span></span>' +
                            '<span class="block text-[10px] uppercase tracking-widest text-on-surface-variant">Information Management System</span>' +
                        '</a>' +
                        '<p class="text-support mt-4 max-w-sm">' +
                            'The Municipal Tourism Office’s guide to Zamboanguita’s beaches, dive sites, ' +
                            'falls, resorts and guided tours in Negros Oriental, Philippines. Browse freely — ' +
                            'no account needed.' +
                        '</p>' +
                    '</div>' +

                    '<nav class="lg:col-span-2" aria-labelledby="footerExploreHeading">' +
                        '<h2 id="footerExploreHeading" class="' + HEADING + '">Explore</h2>' +
                        '<ul class="space-y-0.5">' +
                            link(r + 'index.html', 'Destinations') +
                            link(r + 'index.html#map', 'Map &amp; directions') +
                            link(src + 'history.html', 'Our History') +
                            link(src + 'manage.html', 'Manage my ticket or booking') +
                        '</ul>' +
                    '</nav>' +

                    '<nav class="lg:col-span-2" aria-labelledby="footerInfoHeading">' +
                        '<h2 id="footerInfoHeading" class="' + HEADING + '">Information</h2>' +
                        '<ul class="space-y-0.5">' +
                            link(src + 'faq.html', 'Frequently Asked Questions') +
                            link(src + 'terms.html', 'Terms &amp; Conditions') +
                            link(src + 'privacy.html', 'Privacy Policy') +
                        '</ul>' +
                    '</nav>' +

                    '<div class="lg:col-span-3" aria-labelledby="footerContactHeading">' +
                        '<h2 id="footerContactHeading" class="' + HEADING + '">Contact Us</h2>' +
                        '<address class="not-italic text-support space-y-1">' +
                            '<p class="font-semibold text-on-surface">Municipal Tourism Office</p>' +
                            contactLines() +
                        '</address>' +
                        /* The feedback form is the one channel that is always
                           open, so it gets the button and the office details
                           stay plain text. */
                        '<a href="' + src + 'contact.html" class="btn btn-secondary mt-4">' +
                            '<span class="material-symbols-outlined !text-base" aria-hidden="true">forum</span>' +
                            'Send feedback' +
                        '</a>' +
                        (EMERGENCY.length
                            ? '<div class="mt-6" aria-labelledby="footerEmergencyHeading">' +
                                  '<h2 id="footerEmergencyHeading" class="' + HEADING + '">In an emergency</h2>' +
                                  '<div class="text-support">' + emergencyList() + '</div>' +
                              '</div>'
                            : '') +
                    '</div>' +
                '</div>' +

                '<div class="mt-10 pt-6 border-t border-outline-variant/15 flex flex-col sm:flex-row items-center justify-between gap-2 sm:gap-4 text-support text-center sm:text-left">' +
                    '<p>© ' + YEAR + ' Zamboanguita Tourism Information Management System</p>' +
                    /* Quiet on purpose: findable by the officers and establishment
                       managers who need it, without putting a staff-only door in
                       front of every tourist. */
                    '<a href="' + src + 'staff_login.html" class="' + LINK + '">' +
                        '<span class="material-symbols-outlined !text-sm" aria-hidden="true">badge</span>' +
                        'Staff &amp; Tourist Establishment Manager Sign In' +
                    '</a>' +
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
            footer.classList.add('bg-surface-container-low', 'border-t', 'border-outline-variant/15', 'transition-colors', 'duration-300');
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
