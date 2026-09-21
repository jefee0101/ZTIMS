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

   The markup below is fixed text ZTIMS wrote; nothing typed by a visitor or a
   manager ever reaches it, which is the only reason innerHTML is acceptable.
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

    function render(root) {
        const r = root.endsWith('/') ? root : root + '/';
        const src = r + 'src/';

        return (
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
                        /* CONFIRM WITH THE OFFICE BEFORE LAUNCH: the address and hours are the
                           usual ones for a municipal hall, not supplied by the office. The same
                           text is in contact.html and privacy.html; change all three together. */
                        '<address class="not-italic text-support space-y-1">' +
                            '<p class="font-semibold text-on-surface">Municipal Tourism Office</p>' +
                            '<p>Municipal Hall, Poblacion<br>Zamboanguita, Negros Oriental 6218</p>' +
                            '<p>Monday to Friday, 8:00 AM – 5:00 PM</p>' +
                        '</address>' +
                        /* The feedback form is the one channel that is always
                           open, so it gets the button and the office details
                           stay plain text. */
                        '<a href="' + src + 'contact.html" class="btn btn-secondary mt-4">' +
                            '<span class="material-symbols-outlined !text-base" aria-hidden="true">forum</span>' +
                            'Send feedback' +
                        '</a>' +
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

    function mount() {
        document.querySelectorAll('[data-site-footer]').forEach(function (footer) {
            if (footer.getAttribute('data-site-footer-mounted')) return;
            footer.setAttribute('data-site-footer-mounted', '1');
            footer.classList.add('bg-surface-container-low', 'border-t', 'border-outline-variant/15', 'transition-colors', 'duration-300');
            footer.innerHTML = render(footer.getAttribute('data-root') || './');
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
})();
