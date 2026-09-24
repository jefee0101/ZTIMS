/* ==========================================================================
   The listing form — one copy, used by all three editors
   --------------------------------------------------------------------------
   Before this, the establishment portal, the officer's Destinations page and
   the officer's Analytics quick-add each carried their own form. They
   collected different fields, validated differently and looked different, so
   the same listing came out complete or half-empty depending on which door
   you walked through. The schedule and location pickers were byte-identical
   copies pasted into all three, kept in step by hand.

   Now there is one form. A page supplies a container, a role and a submit
   handler; everything else lives here.

   It is deliberately a plain global rather than an ES export: the pages are
   standalone HTML with inline scripts, and this keeps them that way.
   ========================================================================== */

/* ztimsDialog comes from src/shared/ztims-dialog.js, which every page loading
   this form also loads. Read as a bare name on purpose, not window.ztimsDialog:
   that is what lets scripts/check-undefined.cjs report a page that forgot the
   second script tag. */
/* global ztimsDialog */

(function () {
    'use strict';

    /* ---------------------------------------------------------------- data */

    // The municipality's barangays. Free text let the same place arrive as
    // "Malatapay", "malatapay" and "Malatapai" — three barangays as far as any
    // filter is concerned.
    //
    // Jumao-as was added on local correction. The rest were originally worked
    // out from the municipality's school locations rather than an official
    // register, so if another one is missing, this is the list to fix — and
    // the count on src/history.html has to move with it.
    const BARANGAYS = [
        'Basak', 'Calango', 'Jumao-as', 'Lutoban', 'Malongcay Diot', 'Maluay',
        'Mayabon', 'Nabago', 'Najandig', 'Nasig-id', 'Poblacion'
    ];

    // Fixed for a Zamboanguita-only system. They were editable text inputs
    // pre-filled with these values — two more things to tab through and mistype.
    const MUNICIPALITY = 'Zamboanguita';
    const PROVINCE = 'Negros Oriental';

    const CATEGORIES = [
        { value: 'MOUNTAIN', label: 'Mountain' },
        { value: 'BEACH / DIVING', label: 'Beach / Diving' },
        { value: 'CULTURAL', label: 'Cultural' },
        { value: 'ACCOMMODATION', label: 'Accommodation' }
    ];

    const DAY_PRESETS = [
        'Everyday',
        'Monday to Friday',
        'Monday to Saturday',
        'Weekends only',
        'Wednesdays only'
    ];

    const MAX_SPOT_IMAGES = 30;              // must match MAX_SPOT_IMAGES in server.js
    const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

    const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

    /* --------------------------------------------------------------- where
       Every map in this form opens over Zamboanguita. Nobody registering a
       listing here is ever placing it anywhere else, so starting on a world
       view, on the province, or on wherever the browser thinks the officer is
       just means panning back before any work can start.

       The centre is the municipal centre of Zamboanguita, Negros Oriental.

       The bounds are a COARSE envelope, not the municipal boundary. Their only
       job is to catch a pin that is obviously somewhere else — a search result
       in Manila, a mistyped coordinate — while never rejecting a real one. They
       are therefore deliberately wider than the municipality's 85.86 km², and
       they do overlap Dauin to the north and Siaton to the south and west.
       A pin inside them is not proof it is in Zamboanguita; that is what the
       reverse geocoder's municipality is for, and the two are used together.

       To replace these with the real boundary: the municipality is OSM relation
       3740506. Its bounding box, or the LGU's own shapefile, drops straight in
       here — nothing else has to change.
       ------------------------------------------------------------------- */
    const ZAMBOANGUITA_CENTER = [9.1005, 123.1994];
    const ZAMBOANGUITA_BOUNDS = { minLat: 9.02, maxLat: 9.19, minLng: 123.09, maxLng: 123.27 };

    // Enough of the municipality to get your bearings, and close enough to tell
    // one building from the next. Nobody is asked to think in zoom levels.
    const LOCAL_ZOOM = 14;
    const PIN_ZOOM = 17;

    function insideZamboanguita(lat, lng) {
        return lat >= ZAMBOANGUITA_BOUNDS.minLat && lat <= ZAMBOANGUITA_BOUNDS.maxLat
            && lng >= ZAMBOANGUITA_BOUNDS.minLng && lng <= ZAMBOANGUITA_BOUNDS.maxLng;
    }

    // Long enough that a typed word is one lookup rather than five.
    const SEARCH_DEBOUNCE_MS = 450;

    const DRAFT_PREFIX = 'ztims:spot-draft:';
    const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

    const STEPS = [
        { id: 'basics', label: 'Basics', icon: 'edit_note' },
        { id: 'location', label: 'Location', icon: 'location_on' },
        { id: 'visiting', label: 'Visiting', icon: 'schedule' },
        { id: 'photos', label: 'Photos', icon: 'photo_library' }
    ];

    /* ------------------------------------------------------------- helpers */

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    function toClock(value) {
        // "14:30" from an <input type="time"> becomes "2:30 PM", the wording
        // listings already use.
        const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
        if (!match) return '';
        let hour = Number(match[1]);
        const suffix = hour >= 12 ? 'PM' : 'AM';
        hour = hour % 12 || 12;
        return hour + ':' + match[2] + ' ' + suffix;
    }

    function toInputTime(clock) {
        const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(clock || '').trim());
        if (!match) return '';
        let hour = Number(match[1]) % 12;
        if (/PM/i.test(match[3])) hour += 12;
        return String(hour).padStart(2, '0') + ':' + match[2];
    }

    function formatPeso(amount) {
        return '₱' + (Number(amount) || 0).toFixed(2);
    }

    let leafletLoading = null;
    function loadLeaflet() {
        if (window.L) return Promise.resolve(window.L);
        // The tourism map module owns a loader too. Use it when it is there, so
        // one page never has two loaders racing to inject the same script.
        if (window.ZTIMS_MAP && window.ZTIMS_MAP.loadLeaflet) return window.ZTIMS_MAP.loadLeaflet();
        if (leafletLoading) return leafletLoading;

        leafletLoading = new Promise(function (resolve, reject) {
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = LEAFLET_CSS;
            document.head.appendChild(css);

            const script = document.createElement('script');
            script.src = LEAFLET_JS;
            script.onload = function () { resolve(window.L); };
            script.onerror = function () { reject(new Error('The map could not be loaded. Check your connection.')); };
            document.head.appendChild(script);
        });
        return leafletLoading;
    }

    /* -------------------------------------------------------------- markup */

    const INPUT = 'w-full bg-surface-variant border border-outline-variant/40 rounded-xl p-3 text-on-surface ' +
        'focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors';
    const LABEL = 'block text-xs font-bold uppercase tracking-wider text-on-surface-variant mb-1';
    const CHIP_BTN = 'inline-flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-xl bg-surface-variant ' +
        'border border-outline-variant/40 text-xs font-bold text-on-surface hover:bg-outline-variant/40 transition-all';

    // The three ways into a location. Big on purpose: on a phone this is the
    // first thing a manager taps, and all three are equally valid answers.
    const WAY_BTN = 'flex flex-col items-start gap-1 text-left px-4 py-4 min-h-[88px] rounded-xl bg-surface-variant ' +
        'border border-outline-variant/40 hover:border-primary hover:bg-outline-variant/30 transition-all ' +
        'focus:outline-none focus:ring-2 focus:ring-primary';

    // A required field says so, once, where it is asked for.
    function required() {
        return '<span class="text-error ml-0.5" title="Required">*</span>';
    }

    function errorSlot(id) {
        return '<p id="' + id + '" hidden class="text-support text-error mt-1 flex items-start gap-1">' +
            '<span class="material-symbols-outlined !text-sm shrink-0">error</span><span data-msg></span></p>';
    }

    function buildMarkup(p, role) {
        const isOfficer = role === 'officer';

        const stepTabs = STEPS.map(function (step, index) {
            return '<button type="button" data-step-tab="' + index + '" ' +
                'class="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-xl text-support font-bold ' + 'uppercase tracking-wider transition-all min-h-[44px]">' +
                '<span class="material-symbols-outlined !text-base shrink-0">' + step.icon + '</span>' +
                '<span class="truncate hidden sm:inline">' + step.label + '</span>' +
                '<span class="sm:hidden">' + (index + 1) + '</span>' +
                '</button>';
        }).join('');

        return '' +
        '<div id="' + p + 'DraftBar" hidden class="mb-4 flex flex-wrap items-center gap-2 bg-surface-container-high ' +
            'border border-outline-variant/30 rounded-xl px-4 py-3">' +
            '<span class="material-symbols-outlined !text-base text-primary">history</span>' +
            '<p class="text-support text-on-surface flex-1 min-w-[12rem]">You have an unfinished listing from ' +
                '<b id="' + p + 'DraftWhen"></b>.</p>' +
            '<button type="button" id="' + p + 'DraftRestore" class="btn btn-primary btn-sm">Restore it</button>' +
            '<button type="button" id="' + p + 'DraftDiscard" class="btn btn-secondary btn-sm">Discard</button>' +
        '</div>' +

        // ---- step rail ----
        '<div class="flex gap-1 bg-surface-container-low rounded-2xl p-1 mb-1">' + stepTabs + '</div>' +
        '<div class="h-1 rounded-full bg-outline-variant/30 mb-5 overflow-hidden">' +
            '<div id="' + p + 'Progress" class="h-full bg-primary rounded-full transition-all duration-300" style="width:25%"></div>' +
        '</div>' +

        '<div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_20rem] gap-6">' +
        '<div>' +

        /* ============================ STEP 1 — BASICS ======================= */
        '<section data-step="0" class="space-y-4">' +
            '<div>' +
                '<label for="' + p + 'Title" class="' + LABEL + '">Name' + required() + '</label>' +
                '<input id="' + p + 'Title" name="title" type="text" autocomplete="off" ' +
                    'placeholder="e.g., Turtle Island Sanctuary" class="' + INPUT + '"/>' +
                errorSlot(p + 'TitleError') +
            '</div>' +

            '<div>' +
                '<label for="' + p + 'Category" class="' + LABEL + '">Category' + required() + '</label>' +
                '<select id="' + p + 'Category" name="category" class="' + INPUT + '">' +
                    CATEGORIES.map(function (c) {
                        return '<option value="' + escapeHtml(c.value) + '">' + escapeHtml(c.label) + '</option>';
                    }).join('') +
                '</select>' +
                '<p class="text-support mt-1">Accommodation moves the listing under places to stay.</p>' +
            '</div>' +

            '<div>' +
                '<label for="' + p + 'Description" class="' + LABEL + '">Description' + required() + '</label>' +
                '<textarea id="' + p + 'Description" name="description" rows="4" ' +
                    'placeholder="What is there to see and do? What should a visitor know before coming?" ' +
                    'class="' + INPUT + ' resize-none"></textarea>' +
                '<div class="flex justify-between gap-2 mt-1">' +
                    errorSlot(p + 'DescriptionError') +
                    '<span id="' + p + 'DescriptionCount" class="text-support shrink-0 ml-auto"></span>' +
                '</div>' +
            '</div>' +

            '<div>' +
                '<label for="' + p + 'Label" class="' + LABEL + '">Tagline <span class="normal-case font-normal opacity-70">(optional)</span></label>' +
                '<input id="' + p + 'Label" name="label" type="text" placeholder="e.g., Crystal Waters" class="' + INPUT + '"/>' +
                '<p class="text-support mt-1">A short phrase shown under the name.</p>' +
            '</div>' +
        '</section>' +

        /* =========================== STEP 2 — LOCATION ======================
           The question is "where should visitors arrive?", not "what are the
           coordinates?". Nobody registering a resort should have to know what a
           latitude is, so the numbers are the last thing on this panel rather
           than the first, and there are three ways to get to them that all end
           in the same place: a pin you can look at and agree with.
           ------------------------------------------------------------------ */
        '<section data-step="1" class="space-y-4" hidden>' +

            '<div>' +
                '<h3 class="text-base sm:text-lg font-bold text-on-surface">Where should visitors arrive?</h3>' +
                '<p class="text-support mt-1">' +
                    'Find the place, then put the pin on the gate or entrance people should head for. ' +
                    'ZTIMS works out the map position, the barangay and the directions from that.' +
                '</p>' +
            '</div>' +

            /* A listing saved before this step existed, or one an officer added
               in a hurry. It is a notice, not a wall: everything else about the
               listing stays editable. */
            '<div id="' + p + 'LocLegacy" hidden class="flex flex-wrap items-start gap-2 bg-surface-container-high ' +
                'border border-outline-variant/40 rounded-xl px-4 py-3">' +
                '<span class="material-symbols-outlined !text-base text-primary shrink-0">wrong_location</span>' +
                '<p class="text-support text-on-surface flex-1 min-w-[12rem]">' +
                    'This listing has no map location yet. Visitors cannot get directions to it until one is added — ' +
                    'everything else here can still be edited and saved.' +
                '</p>' +
                '<button type="button" id="' + p + 'LocLegacyAdd" class="btn btn-primary btn-sm">Add location</button>' +
            '</div>' +

            /* ---------------- pick a way in ---------------- */
            '<div id="' + p + 'LocChoose" class="grid grid-cols-1 sm:grid-cols-3 gap-2">' +
                '<button type="button" id="' + p + 'LocWaySearch" class="' + WAY_BTN + '">' +
                    '<span class="material-symbols-outlined text-primary">search</span>' +
                    '<span class="font-bold text-on-surface">Search for the place</span>' +
                    '<span class="text-support">By name, landmark or address. Easiest.</span>' +
                '</button>' +
                '<button type="button" id="' + p + 'LocWayHere" class="' + WAY_BTN + '">' +
                    '<span class="material-symbols-outlined text-primary">my_location</span>' +
                    '<span class="font-bold text-on-surface">I am at the location</span>' +
                    '<span class="text-support">Use this device\'s position right now.</span>' +
                '</button>' +
                '<button type="button" id="' + p + 'LocWayMap" class="' + WAY_BTN + '">' +
                    '<span class="material-symbols-outlined text-primary">map</span>' +
                    '<span class="font-bold text-on-surface">Pick on the map</span>' +
                    '<span class="text-support">Tap the spot yourself.</span>' +
                '</button>' +
            '</div>' +

            /* ---------------- the working area ---------------- */
            '<div id="' + p + 'LocWork" hidden class="space-y-4">' +

                /* The same three ways in, as a row of chips. Once one had been
                   chosen the chooser above was gone, and the only way to another
                   was "Change location", which throws the pin away and asks first.
                   Someone whose search found nothing, or whose phone put them
                   on the wrong street, needs the other two without starting
                   over — so these switch the way in and leave the pin where it is. */
                '<div id="' + p + 'LocWays" class="flex flex-wrap items-center gap-2" role="group" aria-label="How to find the location">' +
                    '<span class="text-label font-bold uppercase tracking-wider mr-1">Find it by</span>' +
                    '<button type="button" id="' + p + 'LocSwitchSearch" data-way="search" class="' + CHIP_BTN + '">' +
                        '<span class="material-symbols-outlined !text-base">search</span>Search</button>' +
                    '<button type="button" id="' + p + 'LocSwitchHere" data-way="here" class="' + CHIP_BTN + '">' +
                        '<span class="material-symbols-outlined !text-base">my_location</span>My position</button>' +
                    '<button type="button" id="' + p + 'LocSwitchMap" data-way="map" class="' + CHIP_BTN + '">' +
                        '<span class="material-symbols-outlined !text-base">touch_app</span>Tap the map</button>' +
                '</div>' +

                '<div id="' + p + 'LocFind" hidden>' +
                    '<label for="' + p + 'LocSearch" class="' + LABEL + '">Search for the place</label>' +
                    '<div class="flex gap-2">' +
                        '<input id="' + p + 'LocSearch" type="text" ' +
                            'placeholder="Resort, landmark, barangay or address…" ' +
                            'class="' + INPUT + ' flex-1"/>' +
                        '<button type="button" id="' + p + 'LocSearchBtn" class="shrink-0 px-4 py-3 rounded-xl ' + 'bg-surface-variant border border-outline-variant/40 text-support font-bold text-on-surface ' + 'hover:bg-outline-variant/40 transition-all min-h-[44px]">Search</button>' +
                    '</div>' +
                    '<div id="' + p + 'LocResults" hidden class="mt-2 bg-surface-variant border border-outline-variant/40 ' +
                        'rounded-xl p-1 max-h-56 overflow-y-auto text-on-surface"></div>' +
                    '<p class="text-support mt-1">Places in Zamboanguita are listed first.</p>' +
                '</div>' +

                '<div>' +
                    '<p id="' + p + 'LocMapHint' + '" class="text-support text-on-surface mb-2 flex items-start gap-1.5">' +
                        '<span class="material-symbols-outlined !text-base text-primary shrink-0">touch_app</span>' +
                        '<span>Tap the map to drop a pin on the entrance visitors should ' +
                        'arrive at, then drag it to adjust.</span>' +
                    '</p>' +
                    // Taller than it was, and tallest on a phone, where a pin is
                    // placed with a fingertip rather than a mouse.
                    '<div id="' + p + 'LocMap" class="relative z-0 h-72 sm:h-80 w-full rounded-xl overflow-hidden ' +
                        'border border-outline-variant/40 bg-surface-variant"></div>' +
                '</div>' +

                /* The pin in words. Somewhere unexpected reads as wrong text far
                   more readily than it reads as a dot in the wrong place. */
                '<div id="' + p + 'LocSanity" hidden class="flex items-start gap-2 bg-surface-container-low rounded-xl px-4 py-3">' +
                    '<span class="material-symbols-outlined !text-base text-primary shrink-0">location_on</span>' +
                    '<p class="text-support flex-1 min-w-0">' +
                        '<span class="block text-label uppercase tracking-wider font-bold">This pin is at</span>' +
                        '<span id="' + p + 'LocSanityText" class="text-on-surface break-words">Reading the address…</span>' +
                    '</p>' +
                '</div>' +

                '<p id="' + p + 'LocCheck" hidden class="text-support flex items-start gap-1.5"></p>' +

                /* The pin says one barangay, the form says another. Offered as a
                   choice, because the geocoder is not always the one that is right. */
                '<div id="' + p + 'LocMismatch" hidden class="bg-surface-container-high border border-outline-variant/40 ' +
                    'rounded-xl px-4 py-3 space-y-2">' +
                    '<p id="' + p + 'LocMismatchText" class="text-support text-on-surface"></p>' +
                    '<div class="flex flex-wrap gap-2">' +
                        '<button type="button" id="' + p + 'LocMismatchUse" class="btn btn-primary btn-sm"></button>' +
                        '<button type="button" id="' + p + 'LocMismatchKeep" class="btn btn-secondary btn-sm">Adjust the pin</button>' +
                    '</div>' +
                '</div>' +

                '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">' +
                    '<div>' +
                        '<label for="' + p + 'LocBarangay" class="' + LABEL + '">Barangay' + required() + '</label>' +
                        '<select id="' + p + 'LocBarangay" name="barangay" class="' + INPUT + '">' +
                            '<option value="">Choose a barangay…</option>' +
                            BARANGAYS.map(function (b) {
                                return '<option value="' + escapeHtml(b) + '">' + escapeHtml(b) + '</option>';
                            }).join('') +
                        '</select>' +
                        '<p class="text-support mt-1">Filled in from the pin. Change it if it is wrong.</p>' +
                        errorSlot(p + 'BarangayError') +
                    '</div>' +
                    '<div>' +
                        '<label for="' + p + 'LocAddress" class="' + LABEL + '">Street or sitio ' +
                            '<span class="normal-case font-normal opacity-70">(optional)</span></label>' +
                        '<input id="' + p + 'LocAddress" name="address" type="text" ' +
                            'placeholder="e.g., Sitio Bonbon, near the wharf" class="' + INPUT + '"/>' +
                        '<p class="text-support mt-1">Anything you type here is kept as you typed it.</p>' +
                    '</div>' +
                '</div>' +

                '<div class="flex items-center gap-2 text-support bg-surface-container-low rounded-xl px-4 py-3">' +
                    '<span class="material-symbols-outlined !text-base">public</span>' +
                    '<span><b class="text-on-surface">' + MUNICIPALITY + '</b>, ' + PROVINCE + '</span>' +
                '</div>' +
                '<input type="hidden" id="' + p + 'LocMunicipality" value="' + MUNICIPALITY + '"/>' +
                '<input type="hidden" id="' + p + 'LocProvince" value="' + PROVINCE + '"/>' +

                /* Still here for whoever has a GPS reading off a handset, and out
                   of the way of everyone who does not. */
                '<details id="' + p + 'LocAdvanced" class="rounded-xl border border-outline-variant/40 bg-surface-container-low">' +
                    '<summary class="cursor-pointer px-4 py-3 text-label font-bold uppercase tracking-wider ' + 'text-on-surface-variant select-none min-h-[44px] flex items-center gap-1.5">' +
                        '<span class="material-symbols-outlined !text-base">tune</span>Advanced location details</summary>' +
                    '<div class="px-4 pb-4 space-y-2">' +
                        '<p class="text-support">' +
                            'The pin is what gets saved. These are a readout of it, and you can type over them ' +
                            'if you are copying a reading from somewhere else.' +
                        '</p>' +
                        '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">' +
                            '<div>' +
                                '<label for="' + p + 'LocLat" class="' + LABEL + '">Latitude</label>' +
                                '<input id="' + p + 'LocLat" type="text" inputmode="decimal" placeholder="9.100500" class="' + INPUT + '"/>' +
                            '</div>' +
                            '<div>' +
                                '<label for="' + p + 'LocLng" class="' + LABEL + '">Longitude</label>' +
                                '<input id="' + p + 'LocLng" type="text" inputmode="decimal" placeholder="123.199400" class="' + INPUT + '"/>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</details>' +

                '<div class="flex flex-wrap gap-2">' +
                    '<button type="button" id="' + p + 'LocConfirm" class="btn btn-primary min-h-[48px]">' +
                        '<span class="material-symbols-outlined !text-base">check_circle</span>' +
                        '<span id="' + p + 'LocConfirmLabel">Confirm location</span></button>' +
                    '<button type="button" id="' + p + 'LocChange" class="' + CHIP_BTN + ' !text-on-surface-variant">' +
                        '<span class="material-symbols-outlined !text-base">edit_location_alt</span> Change location</button>' +
                '</div>' +
                errorSlot(p + 'LocError') +

                '<p id="' + p + 'LocStatus" hidden class="text-support"></p>' +
            '</div>' +
        '</section>' +

        /* =========================== STEP 3 — VISITING ====================== */
        '<section data-step="2" class="space-y-4" hidden>' +
            '<div>' +
                '<label for="' + p + 'SchedDays" class="' + LABEL + '">Open on</label>' +
                '<select id="' + p + 'SchedDays" class="' + INPUT + '">' +
                    DAY_PRESETS.map(function (d) {
                        return '<option value="' + escapeHtml(d) + '">' + escapeHtml(d) + '</option>';
                    }).join('') +
                    '<option value="__custom__">Something else…</option>' +
                '</select>' +
                '<input id="' + p + 'SchedDaysCustom" type="text" hidden placeholder="e.g., Tuesdays and Fridays" ' +
                    'class="' + INPUT + ' mt-2"/>' +
            '</div>' +

            '<div>' +
                '<label for="' + p + 'SchedHours" class="' + LABEL + '">Opening hours</label>' +
                '<select id="' + p + 'SchedHours" class="' + INPUT + '">' +
                    '<option value="all">All day</option>' +
                    '<option value="range">Between set hours</option>' +
                    '<option value="__custom__">Something else…</option>' +
                '</select>' +
                '<div id="' + p + 'SchedHoursRow" hidden class="grid grid-cols-2 gap-3 mt-2">' +
                    '<div>' +
                        '<label for="' + p + 'SchedOpen" class="' + LABEL + '">Opens</label>' +
                        '<input id="' + p + 'SchedOpen" type="time" class="' + INPUT + '"/>' +
                    '</div>' +
                    '<div>' +
                        '<label for="' + p + 'SchedClose" class="' + LABEL + '">Closes</label>' +
                        '<input id="' + p + 'SchedClose" type="time" class="' + INPUT + '"/>' +
                    '</div>' +
                '</div>' +
                '<input id="' + p + 'SchedHoursCustom" type="text" hidden placeholder="e.g., By appointment" ' +
                    'class="' + INPUT + ' mt-2"/>' +
            '</div>' +

            '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">' +
                '<div>' +
                    '<label for="' + p + 'TravelFee" class="' + LABEL + '">Travel fee</label>' +
                    '<input id="' + p + 'TravelFee" type="number" min="0" step="0.01" placeholder="0.00" class="' + INPUT + '"/>' +
                    errorSlot(p + 'TravelFeeError') +
                '</div>' +
                '<div>' +
                    '<label for="' + p + 'EntranceFee" class="' + LABEL + '">Entrance fee</label>' +
                    '<input id="' + p + 'EntranceFee" type="number" min="0" step="0.01" placeholder="0.00" class="' + INPUT + '"/>' +
                    errorSlot(p + 'EntranceFeeError') +
                '</div>' +
            '</div>' +
            '<p class="text-support">Leave a fee at zero if there is nothing to pay.</p>' +

            '<div class="pt-1">' +
                '<label class="inline-flex items-center gap-2.5 cursor-pointer select-none min-h-[44px]">' +
                    '<input id="' + p + 'TakesBookings" type="checkbox" class="w-5 h-5 rounded border-outline-variant/60 ' +
                        'bg-surface-variant text-primary focus:ring-primary focus:ring-offset-0"/>' +
                    '<span class="text-label font-bold uppercase tracking-wider text-on-surface">Visitors can book online</span>' +
                '</label>' +
                '<div id="' + p + 'BookingRow" hidden class="mt-2">' +
                    '<label for="' + p + 'BookingUrl" class="' + LABEL + '">Booking link</label>' +
                    '<input id="' + p + 'BookingUrl" type="url" placeholder="https://your-site.com/book" class="' + INPUT + '"/>' +
                    errorSlot(p + 'BookingUrlError') +
                '</div>' +
            '</div>' +

            (isOfficer
                ? '<div class="pt-1">' +
                    '<label class="inline-flex items-center gap-2.5 cursor-pointer select-none min-h-[44px]">' +
                        '<input id="' + p + 'RequiresGuide" type="checkbox" class="w-5 h-5 rounded border-outline-variant/60 ' +
                            'bg-surface-variant text-primary focus:ring-primary focus:ring-offset-0"/>' +
                        '<span class="text-label font-bold uppercase tracking-wider text-on-surface">Requires a tourist guide</span>' +
                    '</label>' +
                    '<p class="text-support mt-1">Visitors are told a guide is needed. Assign the ' +
                        'guides themselves under Tourist Guides.</p>' +
                  '</div>'
                : '') +
        '</section>' +

        /* ============================ STEP 4 — PHOTOS ======================= */
        '<section data-step="3" class="space-y-4" hidden>' +
            '<div class="flex items-center justify-between gap-2">' +
                '<label class="' + LABEL + ' !mb-0">Photos</label>' +
                '<span id="' + p + 'PhotoCounter" class="text-support font-bold"></span>' +
            '</div>' +

            '<div class="flex flex-wrap gap-2">' +
                '<label id="' + p + 'PhotoUploadLabel" class="cursor-pointer ' + CHIP_BTN + '">' +
                    '<span class="material-symbols-outlined !text-base">upload</span>' +
                    '<span id="' + p + 'PhotoUploadText">Upload photos</span>' +
                    '<input id="' + p + 'PhotoInput" type="file" accept="image/*" multiple class="hidden"/>' +
                '</label>' +
                '<button type="button" id="' + p + 'AddPhotoUrlBtn" class="' + CHIP_BTN + '">' +
                    '<span class="material-symbols-outlined !text-base">link</span> Paste a link</button>' +
            '</div>' +

            '<div id="' + p + 'PhotoGallery" class="grid grid-cols-3 sm:grid-cols-4 gap-2"></div>' +
            '<p id="' + p + 'PhotoEmptyHint" class="text-support">' +
                'The first photo becomes the cover. A listing with no photo shows a grey placeholder on the public page.</p>' +
            '<p id="' + p + 'PhotoStatus" hidden class="text-support"></p>' +
        '</section>' +

        '</div>' +

        /* ============================== PREVIEW ============================= */
        '<aside class="hidden xl:block">' +
            '<p class="' + LABEL + '">What visitors will see</p>' +
            '<div id="' + p + 'Preview" class="rounded-2xl overflow-hidden bg-surface-container-low ' +
                'border border-outline-variant/30 sticky top-0"></div>' +
        '</aside>' +
        '</div>' +

        /* ============================== FOOTER ============================== */
        '<p id="' + p + 'FormError" hidden class="mt-5 text-sm text-error bg-error/10 border border-error/20 ' +
            'rounded-xl px-4 py-3"></p>' +

        '<div class="flex flex-wrap gap-3 pt-5 mt-5 border-t border-outline-variant/20">' +
            '<button type="button" id="' + p + 'CancelBtn" class="btn btn-ghost flex-1 min-w-[7rem] min-h-[48px]">Cancel</button>' +
            '<button type="button" id="' + p + 'BackBtn" hidden class="btn btn-secondary flex-1 min-w-[7rem] min-h-[48px]">Back</button>' +
            '<button type="button" id="' + p + 'NextBtn" class="btn btn-primary flex-[2] min-w-[9rem] min-h-[48px]">Next</button>' +
            '<button type="submit" id="' + p + 'SubmitBtn" hidden class="btn btn-primary flex-[2] min-w-[9rem] min-h-[48px]">Publish</button>' +
        '</div>';
    }

    /* --------------------------------------------------------------- mount */

    /**
     * options:
     *   mount        element the form is rendered into (required)
     *   prefix       id prefix, so two forms can live on one page (default 'spot')
     *   apiBase      ZTIMS API root, for address search and reverse lookup
     *   role         'officer' | 'manager'  — officer also sets requiresGuide
     *   cloudName / uploadPreset   Cloudinary, for photo uploads
     *   labels       { create, edit } for the submit button
     *   onSubmit(payload, { editingId, spot })  — the page does its own fetch
     *   onCancel()
     */
    window.mountSpotForm = function (options) {
        const host = options.mount;
        if (!host) return null;

        const p = options.prefix || 'spot';
        const role = options.role === 'officer' ? 'officer' : 'manager';
        const apiBase = options.apiBase || '';
        const labels = options.labels || {};
        const createLabel = labels.create || 'Publish listing';
        const editLabel = labels.edit || 'Save changes';

        const form = document.createElement('form');
        form.id = p + 'Form';
        form.noValidate = true;       // the form validates itself, with its own wording
        form.innerHTML = buildMarkup(p, role);
        host.innerHTML = '';
        host.appendChild(form);

        const el = function (suffix) { return document.getElementById(p + suffix); };

        let step = 0;
        let editingId = '';
        let currentSpot = null;
        let photos = [];
        let map = null;
        let marker = null;
        let draftTimer = null;

        /* ---- location state ----
           locationConfirmed is the whole point of the Confirm button: before it,
           pressing Next on a new listing is refused. It goes back to false the
           moment the pin moves, so "confirmed" always means somebody looked at
           this pin, not an earlier one.

           hadPointOnOpen remembers whether the listing arrived with a location,
           which is what separates "this new listing still needs one" from "this
           old listing never had one and that must not block fixing its hours". */
        let locationConfirmed = false;
        let hadPointOnOpen = false;

        /* The map has two modes. In View mode it is a map: it pans, it zooms, and
           clicking it does nothing to the listing. Pin mode is entered
           deliberately, and only then does a click move the pin.

           Before this, every click on the map moved the saved location, so
           looking around the map and changing where visitors are sent were the
           same gesture. pinBackup holds what the location was when pin mode was
           entered, which is what Cancel puts back. */
        let pinMode = false;
        let pinBackup = null;
        let expandControl = null;
        let pinControl = null;
        let locMethod = '';                 // '' | 'search' | 'here' | 'map'
        let detectedBarangay = '';          // what the geocoder made of the pin
        let detectedMunicipality = '';

        /* ------------------------------------------------------ validation */

        function setFieldError(field, slotId, message) {
            const slot = document.getElementById(slotId);
            if (slot) {
                const target = slot.querySelector('[data-msg]');
                if (target) target.textContent = message || '';
                slot.hidden = !message;
            }
            if (field) {
                field.classList.toggle('!border-error', Boolean(message));
                field.setAttribute('aria-invalid', message ? 'true' : 'false');
            }
        }

        // Each rule returns a message, or '' when the value is fine. `step` is the
        // panel the field lives on, so a failure can take you straight there.
        const RULES = [
            {
                step: 0, field: 'Title', slot: 'TitleError',
                test: function (v) {
                    if (!v.trim()) return 'Give the listing a name.';
                    if (v.trim().length < 3) return 'That name looks too short.';
                    return '';
                }
            },
            {
                step: 0, field: 'Description', slot: 'DescriptionError',
                test: function (v) {
                    if (!v.trim()) return 'Describe what a visitor will find here.';
                    if (v.trim().length < 20) return 'A little more detail — at least 20 characters.';
                    return '';
                }
            },
            /* Before the barangay rule on purpose: the barangay is filled in from
               the pin now, so being told to set a location first is the order that
               actually gets someone through this panel. */
            {
                step: 1, field: 'LocLat', slot: 'LocError', focusId: 'LocConfirm', decorate: false,
                test: function () {
                    // An existing listing that never had a location is not blocked
                    // from having its description or hours corrected. The notice on
                    // the panel says what is missing; it does not stand in the way.
                    if (editingId && !hadPointOnOpen) return '';
                    if (!readPoint()) {
                        return 'Set where visitors should arrive — search for the place, '
                            + 'use this device\'s position, or tap the map.';
                    }
                    if (!locationConfirmed) return 'Check the pin, then press Confirm location.';
                    return '';
                }
            },
            {
                step: 1, field: 'LocBarangay', slot: 'BarangayError',
                test: function (v) { return v ? '' : 'Choose the barangay this is in.'; }
            },
            {
                step: 2, field: 'TravelFee', slot: 'TravelFeeError',
                test: function (v) {
                    if (v === '') return '';
                    return Number(v) >= 0 && isFinite(Number(v)) ? '' : 'A fee cannot be negative.';
                }
            },
            {
                step: 2, field: 'EntranceFee', slot: 'EntranceFeeError',
                test: function (v) {
                    if (v === '') return '';
                    return Number(v) >= 0 && isFinite(Number(v)) ? '' : 'A fee cannot be negative.';
                }
            },
            {
                step: 2, field: 'BookingUrl', slot: 'BookingUrlError',
                test: function (v) {
                    if (!el('TakesBookings').checked) return '';
                    if (!v.trim()) return 'Add the link visitors should book through, or switch booking off.';
                    if (!/^https?:\/\/.+/i.test(v.trim())) return 'A booking link has to start with http:// or https://.';
                    return '';
                }
            }
        ];

        function checkRule(rule, show) {
            const field = el(rule.field);
            if (!field) return '';
            const message = rule.test(field.value);
            // decorate:false for a rule whose real subject is not a text box — the
            // location rule watches a pin, and putting a red ring round a latitude
            // field folded away under Advanced would point at the wrong thing.
            if (show) setFieldError(rule.decorate === false ? null : field, p + rule.slot, message);
            return message;
        }

        // Returns the first failing rule, so the caller can jump to it.
        function firstProblem(uptoStep) {
            for (const rule of RULES) {
                if (uptoStep !== undefined && rule.step > uptoStep) continue;
                if (checkRule(rule, true)) return rule;
            }
            return null;
        }

        function focusProblem(rule) {
            goToStep(rule.step);
            const field = el(rule.focusId || rule.field);
            if (!field) return;
            // After the panel is visible, or the scroll lands on a hidden element.
            requestAnimationFrame(function () {
                field.scrollIntoView({ block: 'center', behavior: 'smooth' });
                field.focus({ preventScroll: true });
            });
        }

        RULES.forEach(function (rule) {
            const field = el(rule.field);
            if (!field) return;
            // Complain on the way out of a field, not on every keystroke — but once
            // a field is marked wrong, clear it as soon as it is right.
            field.addEventListener('blur', function () { checkRule(rule, true); });
            field.addEventListener('input', function () {
                if (field.getAttribute('aria-invalid') === 'true') checkRule(rule, true);
            });
        });

        function setFormError(message) {
            const box = el('FormError');
            box.textContent = message || '';
            box.hidden = !message;
        }

        /* ----------------------------------------------------------- steps */

        function paintSteps() {
            STEPS.forEach(function (_, index) {
                const tab = form.querySelector('[data-step-tab="' + index + '"]');
                const panel = form.querySelector('[data-step="' + index + '"]');
                const active = index === step;
                if (panel) panel.hidden = !active;
                if (tab) {
                    tab.className = 'flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-xl ' +
                        'text-[11px] font-bold uppercase tracking-wider transition-all min-h-[44px] ' +
                        (active
                            ? 'bg-primary text-on-primary shadow'
                            : 'text-on-surface-variant hover:bg-outline-variant/20');
                    tab.setAttribute('aria-current', active ? 'step' : 'false');
                }
            });

            el('Progress').style.width = ((step + 1) / STEPS.length * 100) + '%';
            el('BackBtn').hidden = step === 0;

            const last = step === STEPS.length - 1;
            el('NextBtn').hidden = last;
            el('SubmitBtn').hidden = !last;
            el('SubmitBtn').textContent = editingId ? editLabel : createLabel;

            // The map is built the first time the Location panel is actually shown
            // with something to show, and re-measured every time after that.
            // setLocPhase decides which of the two it is.
            if (step === 1) setLocPhase();
        }

        function goToStep(index) {
            step = Math.max(0, Math.min(STEPS.length - 1, index));
            paintSteps();
        }

        el('NextBtn').addEventListener('click', function () {
            const problem = firstProblem(step);
            if (problem) { setFormError(''); focusProblem(problem); return; }
            setFormError('');
            goToStep(step + 1);
        });

        el('BackBtn').addEventListener('click', function () { goToStep(step - 1); });

        // The tabs jump freely backwards; going forward still has to pass the
        // steps in between, so nothing is skipped by accident.
        form.querySelectorAll('[data-step-tab]').forEach(function (tab) {
            tab.addEventListener('click', function () {
                const target = Number(tab.dataset.stepTab);
                if (target <= step) { goToStep(target); return; }
                const problem = firstProblem(target - 1);
                if (problem) { focusProblem(problem); return; }
                goToStep(target);
            });
        });

        /* --------------------------------------------------------- preview */

        function previewHtml() {
            const title = el('Title').value.trim() || 'Untitled listing';
            const category = el('Category').value;
            const description = el('Description').value.trim();
            const barangay = el('LocBarangay').value;
            const address = el('LocAddress').value.trim();
            const where = [address, barangay].filter(Boolean).join(', ') || 'Location not set';
            const cover = photos[0] || '';
            const entrance = Number(el('EntranceFee').value) || 0;
            const label = el('Label').value.trim();

            return '' +
                '<div class="aspect-[4/3] bg-surface-variant relative">' +
                    (cover
                        ? '<img src="' + escapeHtml(cover) + '" alt="" class="w-full h-full object-cover"/>'
                        : '<div class="w-full h-full flex items-center justify-center text-on-surface-variant">' +
                          '<span class="material-symbols-outlined !text-3xl">no_photography</span></div>') +
                '</div>' +
                '<div class="p-4">' +
                    '<p class="text-label font-bold uppercase tracking-widest text-primary mb-1">' + escapeHtml(category) + '</p>' +
                    '<h4 class="font-display font-bold text-on-surface leading-tight mb-1">' + escapeHtml(title) + '</h4>' +
                    (label ? '<p class="text-support italic mb-1">' + escapeHtml(label) + '</p>' : '') +
                    '<p class="text-support flex items-start gap-1 mb-2">' +
                        '<span class="material-symbols-outlined !text-sm shrink-0">location_on</span>' +
                        '<span>' + escapeHtml(where) + '</span></p>' +
                    '<p class="text-support line-clamp-3">' +
                        escapeHtml(description || 'No description yet.') + '</p>' +
                    '<p class="text-support font-bold text-on-surface mt-3">Entrance ' + formatPeso(entrance) + '</p>' +
                '</div>';
        }

        function paintPreview() {
            el('Preview').innerHTML = previewHtml();
            const description = el('Description').value.trim();
            el('DescriptionCount').textContent = description.length + ' characters';
        }

        ['Title', 'Category', 'Description', 'Label', 'LocBarangay', 'LocAddress', 'EntranceFee']
            .forEach(function (name) {
                const field = el(name);
                if (!field) return;
                field.addEventListener('input', function () { paintPreview(); saveDraftSoon(); });
                field.addEventListener('change', function () { paintPreview(); saveDraftSoon(); });
            });

        /* -------------------------------------------------------- schedule */

        function paintSchedule() {
            el('SchedDaysCustom').hidden = el('SchedDays').value !== '__custom__';
            el('SchedHoursRow').hidden = el('SchedHours').value !== 'range';
            el('SchedHoursCustom').hidden = el('SchedHours').value !== '__custom__';
        }
        el('SchedDays').addEventListener('change', function () { paintSchedule(); saveDraftSoon(); });
        el('SchedHours').addEventListener('change', function () { paintSchedule(); saveDraftSoon(); });

        function fillSchedule(spot) {
            const storedDays = String((spot && spot.workingDays) || '').trim() || 'Everyday';
            const match = DAY_PRESETS.find(function (preset) {
                return preset.toLowerCase() === storedDays.toLowerCase();
            });
            if (match) {
                el('SchedDays').value = match;
                el('SchedDaysCustom').value = '';
            } else {
                el('SchedDays').value = '__custom__';
                el('SchedDaysCustom').value = storedDays;
            }

            const storedHours = String((spot && spot.workingTime) || '').trim() || 'All Day';
            const range = /^(.+?)\s*-\s*(.+)$/.exec(storedHours);
            const from = range ? toInputTime(range[1]) : '';
            const to = range ? toInputTime(range[2]) : '';

            if (/^all day$/i.test(storedHours)) {
                el('SchedHours').value = 'all';
                el('SchedOpen').value = '';
                el('SchedClose').value = '';
                el('SchedHoursCustom').value = '';
            } else if (from && to) {
                el('SchedHours').value = 'range';
                el('SchedOpen').value = from;
                el('SchedClose').value = to;
                el('SchedHoursCustom').value = '';
            } else {
                // Wording no clock can express — "By appointment", say. Kept verbatim.
                el('SchedHours').value = '__custom__';
                el('SchedHoursCustom').value = storedHours;
            }
            paintSchedule();
        }

        function scheduleValue() {
            const chosenDays = el('SchedDays').value === '__custom__'
                ? (el('SchedDaysCustom').value.trim() || 'Everyday')
                : el('SchedDays').value;

            let chosenHours = 'All Day';
            if (el('SchedHours').value === 'range') {
                const from = toClock(el('SchedOpen').value);
                const to = toClock(el('SchedClose').value);
                chosenHours = (from && to) ? from + ' - ' + to : 'All Day';
            } else if (el('SchedHours').value === '__custom__') {
                chosenHours = el('SchedHoursCustom').value.trim() || 'All Day';
            }

            return { workingDays: chosenDays, workingTime: chosenHours };
        }

        /* --------------------------------------------------------- booking */

        el('TakesBookings').addEventListener('change', function () {
            el('BookingRow').hidden = !el('TakesBookings').checked;
            if (!el('TakesBookings').checked) {
                setFieldError(el('BookingUrl'), p + 'BookingUrlError', '');
            }
            saveDraftSoon();
        });

        function fillBooking(spot) {
            const url = (spot && spot.bookingUrl) || '';
            el('TakesBookings').checked = Boolean(url);
            el('BookingUrl').value = url;
            el('BookingRow').hidden = !url;
        }

        function bookingValue() {
            // Switched off means no booking link, whatever the box still holds.
            return el('TakesBookings').checked ? el('BookingUrl').value.trim() : '';
        }

        /* -------------------------------------------------------- location */

        function say(message, tone) {
            const status = el('LocStatus');
            if (!status) return;
            status.textContent = message || '';
            status.hidden = !message;
            status.style.color = tone === 'error' ? 'rgb(var(--ztims-error))' : (tone === 'ok' ? 'rgb(var(--ztims-success))' : '');
        }

        // The same rule the API applies, so the form refuses what the server would.
        function readPoint() {
            const lat = parseFloat(el('LocLat').value);
            const lng = parseFloat(el('LocLng').value);
            if (!isFinite(lat) || !isFinite(lng)) return null;
            if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
            if (lat === 0 && lng === 0) return null;      // the classic "unset" pair
            return { lat: lat, lng: lng };
        }

        // Four decimals is about eleven metres — close enough to send somebody to.
        // Two is a kilometre, which is a different building or a different beach.
        function decimalsOf(value) {
            const match = /\.(\d+)$/.exec(String(value || '').trim());
            return match ? match[1].length : 0;
        }

        function pointIsPrecise() {
            return decimalsOf(el('LocLat').value) >= 4 && decimalsOf(el('LocLng').value) >= 4;
        }

        /* Which of the three ways in is currently open, '' when none is. The panel
           shows the chooser or the working area based on this and on whether a pin
           exists — there is no other state to keep in step. */
        function setLocPhase() {
            const working = Boolean(locMethod) || Boolean(readPoint());
            el('LocChoose').hidden = working;
            el('LocWork').hidden = !working;
            el('LocFind').hidden = locMethod !== 'search';
            paintWays();
            if (working) refreshMap();
            paintLocation();
        }

        // The chip for the way currently in use reads as pressed; the others as
        // places to go. aria-pressed carries the same for a screen reader.
        function paintWays() {
            ['LocSwitchSearch', 'LocSwitchHere', 'LocSwitchMap'].forEach(function (id) {
                const chip = el(id);
                if (!chip) return;
                const way = chip.getAttribute('data-way');
                // The map chip means "a tap will place the pin", so it is only
                // pressed while that is true — not after the pin was confirmed.
                const on = way === locMethod && (way !== 'map' || pinMode);
                chip.setAttribute('aria-pressed', on ? 'true' : 'false');
                chip.classList.toggle('!bg-primary', on);
                chip.classList.toggle('!text-on-primary', on);
                chip.classList.toggle('!border-primary', on);
            });
        }

        // Everything that reads off the current pin: the confirm button, the
        // within-Zamboanguita line, and whether the address line is worth showing.
        function paintLocation() {
            const point = readPoint();
            const confirmBtn = el('LocConfirm');
            const check = el('LocCheck');
            const sanity = el('LocSanity');

            if (!point) {
                check.hidden = true;
                sanity.hidden = true;
                confirmBtn.disabled = true;
                el('LocConfirmLabel').textContent = 'Confirm location';
                return;
            }

            sanity.hidden = false;
            confirmBtn.disabled = false;
            el('LocConfirmLabel').textContent = locationConfirmed ? 'Location confirmed' : 'Confirm location';
            // Once confirmed it steps down from the filled action to the quiet
            // one: there is nothing left to press it for.
            confirmBtn.classList.toggle('btn-primary', !locationConfirmed);
            confirmBtn.classList.toggle('btn-secondary', locationConfirmed);
            paintPinControl();

            check.hidden = false;
            const inside = insideZamboanguita(point.lat, point.lng);
            check.className = 'text-xs flex items-start gap-1.5 ' + (inside ? 'text-on-surface-variant' : 'text-error');
            check.textContent = '';
            const icon = document.createElement('span');
            icon.className = 'material-symbols-outlined !text-base shrink-0';
            icon.textContent = inside ? 'check_circle' : 'warning';
            const words = document.createElement('span');
            words.textContent = inside
                ? 'Within ' + MUNICIPALITY + '.'
                : 'This location appears to be outside ' + MUNICIPALITY + '. Move the pin, or choose another search result.';
            check.appendChild(icon);
            check.appendChild(words);
        }

        function writePoint(lat, lng) {
            el('LocLat').value = lat.toFixed(6);
            el('LocLng').value = lng.toFixed(6);
            // A pin that has moved has not been agreed to yet, whatever was agreed
            // to before it moved.
            locationConfirmed = false;
            paintLocation();
            saveDraftSoon();
        }

        [el('LocLat'), el('LocLng')].forEach(function (field) {
            field.addEventListener('input', function () {
                locationConfirmed = false;
                paintLocation();
                saveDraftSoon();
            });
            // Typed by hand, so the map has to catch up with the numbers.
            field.addEventListener('change', async function () {
                const point = readPoint();
                if (!point) return;
                try {
                    await ensureMap();
                    placeMarker(point.lat, point.lng, true);
                } catch (error) { /* the numbers still stand without a map */ }
            });
        });

        /* Draggable while pinning, and while the pin has not been agreed to yet.
           A search result or a phone's position lands near the place, not on
           the gate, and every message after one says to drag the pin onto the
           entrance — which it could not be, because dragging was pin mode only.
           The guard stays where it matters: a confirmed pin, and a listing's
           saved one, cannot be moved by a slip of the hand on a map somebody
           opened to look at. Any drag un-confirms it, so the two never overlap. */
        function pinIsLoose() {
            return pinMode || (Boolean(readPoint()) && !locationConfirmed);
        }

        function placeMarker(lat, lng, recentre) {
            if (!map) return;
            if (!marker) {
                marker = window.L.marker([lat, lng], { draggable: pinIsLoose() }).addTo(map);
                marker.on('dragend', function () {
                    const at = marker.getLatLng();
                    writePoint(at.lat, at.lng);
                    // Dragging is the other way a pin first gets a position, so
                    // Confirm has to be re-enabled here too.
                    paintPinControl();
                    describePoint({ lat: at.lat, lng: at.lng });
                    say('Pin moved. Check the address below still reads right.', 'ok');
                });
            } else {
                marker.setLatLng([lat, lng]);
            }
            setMarkerDraggable(pinIsLoose());
            paintMarkerState();
            if (recentre) map.setView([lat, lng], Math.max(map.getZoom(), PIN_ZOOM));
        }

        function setMarkerDraggable(on) {
            if (!marker || !marker.dragging) return;
            if (on) marker.dragging.enable();
            else marker.dragging.disable();
        }

        // A pin being placed and a pin already agreed to should not look alike.
        function paintMarkerState() {
            if (!marker || !marker._icon) return;
            marker._icon.classList.toggle('ztims-pin--choosing', pinMode);
        }

        function clearMarker() {
            if (marker && map) map.removeLayer(marker);
            marker = null;
        }

        /* Guarded by the promise, not by `map`. Two callers can reach this before
           either has finished — setLocPhase asks for the map when the panel is
           shown, and the "Pick on the map" button asks for it again in the same
           tick — and the old `if (map)` check let both through, because neither
           had assigned it yet. That built two Leaflet maps on one container, and
           once the pin bar existed, two of those as well. */
        let mapReady = null;

        function ensureMap() {
            if (map) return Promise.resolve(map);
            if (mapReady) return mapReady;
            mapReady = buildMap().catch(function (error) {
                mapReady = null;        // a failed attempt must not poison the next
                throw error;
            });
            return mapReady;
        }

        async function buildMap() {
            await loadLeaflet();

            /* The wheel is left to the page while the map is a panel inside a
               scrolling form — otherwise scrolling past the form zooms the map
               instead. Expanded, the map is the whole screen and there is
               nothing to scroll past, so the wheel becomes zoom. That switch is
               in the expand control's callback below. */
            map = window.L.map(el('LocMap'), { scrollWheelZoom: false })
                .setView(ZAMBOANGUITA_CENTER, LOCAL_ZOOM);
            window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap contributors'
            }).addTo(map);

            /* Leaflet does not raise `click` at the end of a drag, so panning
               cannot place a pin. The mode check is the second guard: a plain
               click while looking around must not move anybody's listing. */
            map.on('click', function (event) {
                /* A click while merely looking used to do nothing whatsoever, and
                   say nothing about why — so the obvious way to place a first pin
                   looked like a map that did not work.

                   Two situations were being treated as one. With no location set
                   there is nothing a stray click can damage, and tapping the map
                   is precisely how anyone expects to set one: take the click and
                   switch into pin mode around it. With a location already set the
                   separation earns its keep — a click while reading the map must
                   not move a published listing — so say what to press instead. */
                if (!pinMode) {
                    if (readPoint()) {
                        say('Press "Tap the map" above, or Pin location on the map, then tap where the pin should go.');
                        return;
                    }
                    enterPinMode();
                }

                writePoint(event.latlng.lat, event.latlng.lng);
                placeMarker(event.latlng.lat, event.latlng.lng, false);
                // Placed from a municipality-wide view, the pin is a guess at which
                // building it is. Rather than refusing it, go in close enough that
                // the guess can be corrected by looking.
                if (map.getZoom() < PIN_ZOOM) map.setView([event.latlng.lat, event.latlng.lng], PIN_ZOOM);
                // Confirm is disabled while there is nothing to confirm, which is
                // the state pin mode starts in. Without this the button never came
                // back: the pin went down and Confirm stayed grey.
                paintPinControl();
                say('Pin placed. Tap again or drag it to move it, then confirm.', 'ok');
                describePoint({ lat: event.latlng.lat, lng: event.latlng.lng });
            });

            try {
                pinControl = addPinControl(map);
            } catch (error) {
                // An older Leaflet, or a partial one. Pin mode still works from
                // the panel below; only the in-map buttons are missing.
                pinControl = null;
            }

            /* Dropping a pin on a small map means guessing which building is
               which. Full screen is where the gate can actually be found, so
               the control is here as well as on the public maps. Only the
               control is lost if the map module is missing; the picker itself
               carries on. */
            if (window.ZTIMS_MAP && window.ZTIMS_MAP.addExpandControl) {
                // Kept, not discarded: close() collapses the map. While expanded
                // the map hangs off <body> rather than sitting inside the dialog,
                // so closing the form no longer takes it off screen with it — it
                // would be left covering the page with no way back.
                expandControl = window.ZTIMS_MAP.addExpandControl(map, el('LocMap'), function (expanded) {
                    // Full screen has no page behind it to scroll, so the wheel
                    // can do the obvious thing.
                    if (expanded) map.scrollWheelZoom.enable();
                    else map.scrollWheelZoom.disable();
                    map.invalidateSize();

                    const point = readPoint();
                    // Stay on the pin through the change of size: re-framing to
                    // anything else would lose the thing being placed.
                    if (point) map.setView([point.lat, point.lng], Math.max(map.getZoom(), PIN_ZOOM));
                });
            }

            return map;
        }

        // Leaflet measures the container on creation, so a map built inside a
        // closed dialog comes out zero-sized. Called whenever the panel is shown.
        async function refreshMap() {
            try {
                await ensureMap();
                map.invalidateSize();
                const point = readPoint();
                if (point) placeMarker(point.lat, point.lng, true);
                else { clearMarker(); map.setView(ZAMBOANGUITA_CENTER, LOCAL_ZOOM); }
            } catch (error) {
                say(error.message, 'error');
            }
        }

        // A dropdown only takes a value it already has an option for, so the
        // geocoder's spelling is matched against the eleven rather than assigned.
        function matchBarangay(value) {
            const wanted = String(value || '').trim().toLowerCase();
            if (!wanted) return '';
            return BARANGAYS.find(function (b) { return b.toLowerCase() === wanted; }) || '';
        }

        function setBarangay(value) {
            const match = matchBarangay(value);
            if (!match) return false;
            el('LocBarangay').value = match;
            return true;
        }

        /* The pin says one barangay and the form says another. Shown as a choice
           rather than a correction: the geocoder is not always the one that is
           right, and whoever is filling this in may well know better. */
        function paintMismatch() {
            const chosen = el('LocBarangay').value;
            const box = el('LocMismatch');
            if (!detectedBarangay || !chosen || detectedBarangay === chosen) {
                box.hidden = true;
                return;
            }
            el('LocMismatchText').textContent =
                'The pin looks like it is in ' + detectedBarangay + ', but this listing says ' + chosen + '.';
            el('LocMismatchUse').textContent = 'Use ' + detectedBarangay;
            box.hidden = false;
        }

        el('LocMismatchUse').addEventListener('click', function () {
            setBarangay(detectedBarangay);
            paintMismatch();
            paintPreview();
            saveDraftSoon();
        });

        el('LocMismatchKeep').addEventListener('click', function () {
            el('LocMismatch').hidden = true;
            say('Drag the pin to where visitors actually arrive, and the barangay will follow it.');
            el('LocMap').scrollIntoView({ block: 'center', behavior: 'smooth' });
        });

        el('LocBarangay').addEventListener('change', function () { paintMismatch(); });

        function pointWords(point) {
            return point.lat.toFixed(5) + ', ' + point.lng.toFixed(5);
        }

        // Turns a pin into readable address text. It only ever fills fields that
        // are still empty — something typed by hand is never overwritten.
        async function describePoint(point) {
            const sanity = el('LocSanityText');
            sanity.textContent = 'Reading the address…';
            try {
                const response = await fetch(apiBase + '/directions/reverse?lat=' + point.lat + '&lng=' + point.lng);
                const data = await response.json().catch(function () { return {}; });
                if (!response.ok) { sanity.textContent = pointWords(point); return; }

                if (data.label && !el('LocAddress').value.trim()) el('LocAddress').value = data.label;

                detectedBarangay = matchBarangay(data.barangay);
                detectedMunicipality = String(data.municipality || '').trim();
                if (detectedBarangay && !el('LocBarangay').value) setBarangay(detectedBarangay);

                sanity.textContent = data.label
                    || [detectedBarangay, MUNICIPALITY].filter(Boolean).join(', ')
                    || pointWords(point);

                paintMismatch();
                paintPreview();
                saveDraftSoon();
            } catch (error) {
                /* The pin is what gets saved; the address text is only a convenience. */
                sanity.textContent = pointWords(point);
            }
            paintLocation();
        }


        /* ------------------------------------------------- pin mode -------
           The controls live inside the map, because section by section the
           reason to be here is that the map is full screen — and the form's own
           Confirm button is then somewhere behind it, unreachable without
           shrinking the map again and losing the view you just found.

           Only this picker gets them. The public map has no pin control at all,
           which is the front half of "visitors are read-only"; the back half is
           authorizeSpotWrite on the server, which is what actually stops a
           hand-written request. */
        function addPinControl(target) {
            const control = window.L.control({ position: 'bottomleft' });

            control.onAdd = function () {
                const box = window.L.DomUtil.create('div', 'ztims-pinbar');

                function button(label, icon, kind) {
                    const el = window.L.DomUtil.create('button', 'ztims-pinbar__btn ztims-pinbar__btn--' + kind, box);
                    el.type = 'button';
                    el.innerHTML = '<span class="material-symbols-outlined">' + icon + '</span><span>' + label + '</span>';
                    return el;
                }

                control._start = button('Pin location', 'edit_location_alt', 'start');
                control._confirm = button('Confirm location', 'check_circle', 'confirm');
                control._cancel = button('Cancel', 'close', 'cancel');

                // Without this a press on a control also reaches the map, which
                // would drop a pin under the button that was just pressed.
                window.L.DomEvent.disableClickPropagation(box);
                window.L.DomEvent.disableScrollPropagation(box);

                window.L.DomEvent.on(control._start, 'click', function (event) {
                    window.L.DomEvent.preventDefault(event);
                    enterPinMode();
                });
                window.L.DomEvent.on(control._confirm, 'click', function (event) {
                    window.L.DomEvent.preventDefault(event);
                    confirmPin();
                });
                window.L.DomEvent.on(control._cancel, 'click', function (event) {
                    window.L.DomEvent.preventDefault(event);
                    cancelPin();
                });

                return box;
            };

            control.addTo(target);
            paintPinControl();
            return control;
        }

        function paintPinControl() {
            // Independent of the control: the map says which mode it is in even
            // if the buttons could not be drawn.
            const mount = el('LocMap');
            if (mount) mount.classList.toggle('ztims-map--pinning', pinMode);

            if (!pinControl || !pinControl._start) return;
            pinControl._start.hidden = pinMode;
            pinControl._confirm.hidden = !pinMode;
            pinControl._cancel.hidden = !pinMode;
            // Nothing to confirm until something has been chosen.
            pinControl._confirm.disabled = !readPoint();
        }

        function enterPinMode() {
            if (pinMode) return;
            // What Cancel restores. Taken before anything can change.
            const point = readPoint();
            pinBackup = {
                lat: el('LocLat').value,
                lng: el('LocLng').value,
                confirmed: locationConfirmed,
                had: Boolean(point)
            };
            pinMode = true;
            setMarkerDraggable(true);
            paintMarkerState();
            paintPinControl();
            paintWays();
            say('Tap the map where visitors should arrive, then confirm.', 'ok');
        }

        function leavePinMode() {
            pinMode = false;
            pinBackup = null;
            setMarkerDraggable(pinIsLoose());
            paintMarkerState();
            paintPinControl();
            paintWays();
        }

        /* The same checks the form's own Confirm button runs, because there is
           one definition of a location being agreed to and both buttons have to
           mean it. Nothing is written to the database here: the listing is saved
           by the form's Publish or Save, exactly as before. */
        async function confirmPin() {
            const ok = await confirmLocation();
            if (ok) leavePinMode();
        }

        function cancelPin() {
            if (!pinMode) return;
            const backup = pinBackup;
            leavePinMode();
            if (!backup) return;

            el('LocLat').value = backup.lat;
            el('LocLng').value = backup.lng;
            locationConfirmed = backup.confirmed;

            const point = readPoint();
            if (point) {
                placeMarker(point.lat, point.lng, true);
                say('Left as it was.');
            } else {
                clearMarker();
                say('No location set. The listing is unchanged.');
            }
            paintLocation();
            saveDraftSoon();
        }

        /* ------------------------------------------------- the three ways in
           Each is a function rather than a handler, because two sets of buttons
           lead to it: the big chooser shown before anything is set, and the row
           of chips above the map once something is. Switching never clears the
           pin — a pin found by search can still be nudged by tapping the map,
           and a phone's position can be corrected by a search. Only pin mode is
           left, and left with the pin where it is, because it was the map's
           way of asking for a tap and the tap is no longer what is wanted. */

        function chooseSearch() {
            if (pinMode) leavePinMode();
            locMethod = 'search';
            setLocPhase();
            say('');
            el('LocSearch').focus();
        }

        async function chooseMap() {
            locMethod = 'map';
            setLocPhase();
            // Choosing this is itself the deliberate act, so pin mode starts here
            // rather than asking for a second press of the same intent.
            try { await ensureMap(); } catch (error) { /* say() already reported it */ }
            enterPinMode();
        }

        el('LocWaySearch').addEventListener('click', chooseSearch);
        el('LocSwitchSearch').addEventListener('click', chooseSearch);
        el('LocWayMap').addEventListener('click', chooseMap);
        el('LocSwitchMap').addEventListener('click', chooseMap);
        el('LocWayHere').addEventListener('click', chooseHere);
        el('LocSwitchHere').addEventListener('click', chooseHere);

        el('LocLegacyAdd').addEventListener('click', chooseSearch);

        /* The device's own position, asked for only when it is offered as the
           answer and used only as this listing's location. ZTIMS keeps no record
           of where whoever filled the form happened to be standing. */
        function chooseHere() {
            if (!navigator.geolocation) {
                say('This device cannot report its position. Search for the place, or pick it on the map instead.', 'error');
                return;
            }
            // Where to go back to if the device cannot answer: the way that was
            // in use, or the chooser when there was none.
            const previous = locMethod;
            if (pinMode) leavePinMode();
            locMethod = 'here';
            setLocPhase();
            say('Asking this device where it is. The position is used to place this listing and nothing else.');

            navigator.geolocation.getCurrentPosition(async function (position) {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                writePoint(lat, lng);
                try {
                    await ensureMap();
                    placeMarker(lat, lng, true);
                } catch (error) { /* the pin stands even if the map will not load */ }
                await describePoint({ lat: lat, lng: lng });
                // A phone indoors, or one that answered from cell towers rather
                // than GPS, can be a street or two out. The radius is said out
                // loud so a wide one is treated as a starting point, not the answer.
                const radius = Math.round(Number(position.coords.accuracy) || 0);
                const rough = radius > 50 ? ' This reading is only accurate to about ' + radius + ' m, so check the pin against the map.' : '';
                say(insideZamboanguita(lat, lng)
                    ? 'Position found. Drag the pin onto the entrance, then confirm.' + rough
                    : 'Position found, but it is outside ' + MUNICIPALITY + '. Move the pin to the place you are listing.',
                    insideZamboanguita(lat, lng) ? (rough ? undefined : 'ok') : 'error');
            }, function (error) {
                locMethod = previous;
                setLocPhase();
                say(error && error.code === 1
                    ? 'Location access was not allowed. You can search for the place, or choose it on the map instead.'
                    : 'We could not read this device\'s position. You can search for the place, or choose it on the map instead.',
                    'error');
            }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
        }

        /* ------------------------------------------------------------ search */

        function renderResults(list) {
            const results = el('LocResults');
            results.innerHTML = '';
            results.hidden = list.length === 0;

            list.forEach(function (place) {
                // Built with textContent, never innerHTML: these labels come from an
                // outside geocoder and must never be treated as markup.
                const option = document.createElement('button');
                option.type = 'button';
                option.className = 'w-full text-left px-3 py-3 min-h-[44px] rounded-lg hover:bg-outline-variant/30 transition-colors';

                const name = document.createElement('span');
                name.className = 'block text-xs text-on-surface';
                name.textContent = place.label;
                option.appendChild(name);

                // A result outside the municipality is still offered — it may be
                // the one they meant — but it is labelled before it is picked.
                if (!insideZamboanguita(place.latitude, place.longitude)) {
                    const flag = document.createElement('span');
                    flag.className = 'block text-[11px] text-error mt-0.5';
                    flag.textContent = 'Outside ' + MUNICIPALITY;
                    option.appendChild(flag);
                }

                option.addEventListener('click', async function () {
                    writePoint(place.latitude, place.longitude);
                    try {
                        await ensureMap();
                        placeMarker(place.latitude, place.longitude, true);
                    } catch (error) { /* the pin stands even without a map */ }
                    results.hidden = true;
                    if (!el('LocAddress').value.trim()) el('LocAddress').value = place.label;
                    await describePoint({ lat: place.latitude, lng: place.longitude });
                    say('Pin placed. Drag it onto the entrance if it is not there already.', 'ok');
                    paintPreview();
                });
                results.appendChild(option);
            });
        }

        // explicit: the visitor pressed Search or Enter, so say something even when
        // there is nothing useful to say. While typing, stay quiet until there is
        // a result — a status line flickering on every keystroke is noise.
        async function runSearch(explicit) {
            const query = el('LocSearch').value.trim();
            if (query.length < 3) {
                if (explicit) say('Type at least three characters to search.', 'error');
                return;
            }

            if (explicit) say('Searching…');
            try {
                const response = await fetch(apiBase + '/directions/search?q=' + encodeURIComponent(query));
                const data = await response.json().catch(function () { return {}; });
                if (!response.ok) throw new Error(data.message || 'Address search is unavailable right now.');

                const list = Array.isArray(data.results) ? data.results : [];
                renderResults(list);
                say(list.length
                    ? 'Pick the closest match, then drag the pin to the exact spot.'
                    : 'We could not find that place. Try the establishment name, a landmark, the barangay or the street — '
                        + 'or pick it on the map instead.');
            } catch (error) {
                say(error.message, 'error');
            }
        }

        el('LocSearchBtn').addEventListener('click', function () { runSearch(true); });
        el('LocSearch').addEventListener('keydown', function (event) {
            // Inside a form, Enter would otherwise submit the whole listing.
            if (event.key === 'Enter') { event.preventDefault(); runSearch(true); }
        });

        /* Suggestions as you type. Debounced and de-duplicated because every
           keystroke would otherwise be one call to the geocoder, which is rate
           limited both here and upstream. The button stays for anyone who
           would rather ask explicitly. */
        let searchTimer = null;
        let lastQuery = '';
        el('LocSearch').addEventListener('input', function () {
            clearTimeout(searchTimer);
            const query = el('LocSearch').value.trim();
            if (query.length < 3) {
                el('LocResults').hidden = true;
                lastQuery = '';
                return;
            }
            searchTimer = setTimeout(function () {
                if (query === lastQuery) return;
                lastQuery = query;
                runSearch();
            }, SEARCH_DEBOUNCE_MS);
        });

        /* ----------------------------------------------- confirm and change */

        /* One definition of "this location is agreed to", used by the button under
           the map and by the one inside it. Returns whether it took, so the
           caller can decide what to do next. */
        async function confirmLocation() {
            const point = readPoint();
            if (!point) {
                say('No pin yet. Search for the place, use this device\'s position, or tap the map.', 'error');
                return false;
            }
            if (!insideZamboanguita(point.lat, point.lng)) {
                say('This location appears to be outside ' + MUNICIPALITY
                    + '. Please move the pin, or choose another search result.', 'error');
                return false;
            }
            if (!pointIsPrecise()) {
                say('Those coordinates are not exact enough to send anyone to. Place the pin on the map, '
                    + 'or give at least four decimal places.', 'error');
                return false;
            }

            try {
                await ensureMap();
                placeMarker(point.lat, point.lng, true);
                map.invalidateSize();
            } catch (error) { /* a pin with no map is still a pin */ }
            await describePoint(point);

            if (!el('LocBarangay').value) {
                say('Choose the barangay to finish confirming this location.', 'error');
                el('LocBarangay').focus();
                return false;
            }

            locationConfirmed = true;
            // Agreed to, so it stays put until someone deliberately picks it up again.
            setMarkerDraggable(pinIsLoose());
            paintLocation();
            setFieldError(null, p + 'LocError', '');

            // The coarse bounds said yes and the map service disagrees. It is
            // wrong often enough at a boundary that it warns rather than blocks.
            const elsewhere = detectedMunicipality && !/zamboanguita/i.test(detectedMunicipality);
            say(elsewhere
                ? 'Location confirmed — but the map service reads this pin as ' + detectedMunicipality
                    + '. Worth a second look before you publish.'
                : 'Location confirmed. This is where visitors will be sent.',
                elsewhere ? 'error' : 'ok');
            return true;
        }

        el('LocConfirm').addEventListener('click', function () { confirmLocation(); });

        function clearLocation() {
            el('LocLat').value = '';
            el('LocLng').value = '';
            clearMarker();
            locationConfirmed = false;
            locMethod = '';
            detectedBarangay = '';
            detectedMunicipality = '';
            el('LocSearch').value = '';
            el('LocResults').innerHTML = '';
            el('LocResults').hidden = true;
            el('LocMismatch').hidden = true;
            lastQuery = '';
            say('');
            setLocPhase();
            saveDraftSoon();
        }

        /* Losing a located pin to a mis-tap is worse than one extra tap. This
           form already opens inside a page modal on two of the three pages, so
           the question goes through ztims-dialog.js, which stacks above that
           modal and takes Escape before it does — a plain second overlay would
           have closed both. The page must load ztims-dialog.js alongside this
           file; npm run check flags one that does not. */
        el('LocChange').addEventListener('click', async function () {
            if (!readPoint() && !locMethod) return;
            const sure = await ztimsDialog.confirm({
                title: 'Change location?',
                message: 'The location currently set for this listing will be removed.',
                confirmLabel: 'Change location'
            });
            if (!sure) return;
            clearLocation();
        });

        function fillLocation(spot) {
            const source = spot || {};
            el('LocAddress').value = source.address || '';
            el('LocBarangay').value = '';
            if (source.barangay) setBarangay(source.barangay);

            const hasPoint = source.latitude !== null && source.latitude !== undefined
                && source.longitude !== null && source.longitude !== undefined;
            el('LocLat').value = hasPoint ? source.latitude : '';
            el('LocLng').value = hasPoint ? source.longitude : '';

            hadPointOnOpen = Boolean(readPoint());
            // A pin already saved was agreed to when it was set. Asking for it to
            // be confirmed again would mean anyone fixing a typo in the opening
            // hours first had to re-place a pin nobody had questioned.
            locationConfirmed = hadPointOnOpen;
            locMethod = '';
            detectedBarangay = '';
            detectedMunicipality = '';

            el('LocSearch').value = '';
            el('LocResults').innerHTML = '';
            el('LocResults').hidden = true;
            el('LocMismatch').hidden = true;
            el('LocAdvanced').open = false;
            // Shown only for a listing that exists and never had a pin — a new one
            // has not failed to do anything yet.
            el('LocLegacy').hidden = !(editingId && !hadPointOnOpen);
            el('LocSanityText').textContent = source.address
                || (hasPoint ? pointWords({ lat: Number(source.latitude), lng: Number(source.longitude) }) : '');
            say('');
            setLocPhase();
        }

        function locationPayload() {
            const point = readPoint();
            return {
                address: el('LocAddress').value.trim(),
                barangay: el('LocBarangay').value,
                municipality: MUNICIPALITY,
                province: PROVINCE,
                // Blank coordinates go as empty strings, which the API reads as
                // "clear it" — never as a point at 0,0 off the coast of Africa.
                latitude: point ? point.lat : '',
                longitude: point ? point.lng : ''
            };
        }

        /* ---------------------------------------------------------- photos */

        function cloudinaryConfigured() {
            return Boolean(options.cloudName && options.uploadPreset) &&
                !String(options.cloudName).startsWith('YOUR_') &&
                !String(options.uploadPreset).startsWith('YOUR_');
        }

        function setPhotoStatus(message, tone) {
            const status = el('PhotoStatus');
            status.textContent = message || '';
            status.className = 'text-[11px] ' + (tone === 'error' ? 'text-error' : 'text-on-surface-variant');
            status.hidden = !message;
        }

        function renderPhotos() {
            el('PhotoCounter').textContent = photos.length + ' / ' + MAX_SPOT_IMAGES;
            el('PhotoEmptyHint').hidden = photos.length > 0;

            el('PhotoGallery').innerHTML = photos.map(function (url, index) {
                return '<figure class="relative group aspect-square rounded-xl overflow-hidden bg-surface-variant ring-1 ' +
                        (index === 0 ? 'ring-primary' : 'ring-outline-variant/40') + '">' +
                    '<img src="' + escapeHtml(url) + '" alt="Photo ' + (index + 1) + '" class="w-full h-full object-cover"/>' +
                    (index === 0
                        ? '<figcaption class="absolute bottom-0 inset-x-0 bg-primary text-on-primary text-[9px] font-bold ' +
                          'tracking-widest text-center py-0.5">COVER</figcaption>'
                        : '') +
                    '<div class="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 focus-within:opacity-100 ' +
                        'transition-opacity flex items-center justify-center gap-1">' +
                        (index === 0 ? '' :
                            '<button type="button" data-cover="' + index + '" title="Make this the cover" ' +
                            'class="p-1 rounded-full bg-white text-black hover:scale-110 transition-transform flex">' +
                            '<span class="material-symbols-outlined !text-base">star</span></button>') +
                        '<button type="button" data-remove="' + index + '" title="Remove this photo" ' +
                        'class="p-1 rounded-full bg-white text-error hover:scale-110 transition-transform flex">' +
                        '<span class="material-symbols-outlined !text-base">delete</span></button>' +
                    '</div>' +
                '</figure>';
            }).join('');

            paintPreview();
        }

        // Keeps the list unique and inside the limit, and reports what it dropped
        // so photos never disappear without explanation.
        function addPhotos(urls) {
            let duplicates = 0;
            for (const raw of urls) {
                const url = String(raw || '').trim();
                if (!url) continue;
                if (photos.includes(url)) { duplicates += 1; continue; }
                if (photos.length >= MAX_SPOT_IMAGES) {
                    renderPhotos();
                    setPhotoStatus('Only ' + MAX_SPOT_IMAGES + ' photos are allowed, so the rest were not added.', 'error');
                    return;
                }
                photos.push(url);
            }
            renderPhotos();
            saveDraftSoon();
            if (duplicates) {
                setPhotoStatus(duplicates + ' photo' + (duplicates > 1 ? 's were' : ' was') + ' already in the gallery.');
            }
        }

        /* The upload is authorised by the ZTIMS API rather than by a preset sitting
           in the page source. Only a signed-in officer or establishment manager can
           obtain a signature, so reading this page no longer grants anyone the
           ability to upload to the municipality's Cloudinary account.

           Asked for once per batch and reused: a signature is valid for an hour,
           and one request per photo would be wasteful. If the server has no
           credentials configured it says so, and the old unsigned preset is used —
           uploads keep working while that is being set up. */
        let uploadTicket = null;

        async function getUploadTicket() {
            if (uploadTicket) return uploadTicket;
            try {
                const response = await fetch(apiBase + '/uploads/signature', { headers: authHeaders() });
                if (response.status === 401 || response.status === 403) {
                    throw new Error('Your sign-in does not allow uploading photos. Sign in again and retry.');
                }
                if (!response.ok) throw new Error('Could not authorise the upload.');
                uploadTicket = await response.json();
            } catch (error) {
                if (/sign-in/.test(error.message)) throw error;
                // A network blip should not block the upload path entirely.
                uploadTicket = { signed: false };
            }
            return uploadTicket;
        }

        function authHeaders(extra) {
            return Object.assign(
                { 'Authorization': 'Bearer ' + (localStorage.getItem('authToken') || '') },
                extra || {}
            );
        }

        /* The upload itself lives in src/shared/photo-upload.js, because the
           guides page needs the same thing and two copies of a signed upload is
           two places to get the signing wrong. The local path below is kept for
           the case where that module did not load, so a missing script costs the
           page its uploads rather than its whole form. */
        async function uploadToCloudinary(file) {
            if (window.ZTIMS_UPLOAD) {
                return window.ZTIMS_UPLOAD.uploadImage(file, {
                    apiBase: apiBase,
                    cloudName: options.cloudName,
                    uploadPreset: options.uploadPreset
                });
            }

            // Checked here as well as by the accept attribute, which a determined
            // file picker will happily ignore.
            if (!/^image\//.test(file.type || '')) {
                throw new Error('that is not an image');
            }

            const ticket = await getUploadTicket();
            const body = new FormData();
            body.append('file', file);

            let cloudName = options.cloudName;
            if (ticket.signed) {
                cloudName = ticket.cloudName;
                body.append('api_key', ticket.apiKey);
                body.append('timestamp', ticket.timestamp);
                body.append('folder', ticket.folder);
                body.append('signature', ticket.signature);
            } else {
                body.append('upload_preset', options.uploadPreset);
            }

            const response = await fetch('https://api.cloudinary.com/v1_1/' + cloudName + '/image/upload', {
                method: 'POST', body: body
            });
            const result = await response.json().catch(function () { return {}; });
            if (!response.ok || !result.secure_url) {
                // A stale signature is worth one retry with a fresh one.
                if (ticket.signed && response.status === 401) {
                    uploadTicket = null;
                }
                throw new Error((result && result.error && result.error.message) || 'Cloudinary rejected the upload.');
            }
            return result.secure_url;
        }

        el('PhotoInput').addEventListener('change', async function (event) {
            const input = event.target;
            const files = Array.from(input.files || []);
            input.value = '';       // so picking the same file twice still fires change
            if (files.length === 0) return;

            if (!cloudinaryConfigured()) {
                setPhotoStatus('Photo uploads are not set up yet — use "Paste a link" instead.', 'error');
                return;
            }

            const room = MAX_SPOT_IMAGES - photos.length;
            if (room <= 0) {
                setPhotoStatus('You already have the maximum of ' + MAX_SPOT_IMAGES + ' photos.', 'error');
                return;
            }

            const queue = files.slice(0, room);
            const skipped = files.length - queue.length;
            const failed = [];
            const label = el('PhotoUploadText');
            const originalLabel = label.textContent;
            input.disabled = true;

            for (let i = 0; i < queue.length; i++) {
                const file = queue[i];
                label.textContent = 'Uploading ' + (i + 1) + ' of ' + queue.length + '…';
                setPhotoStatus('Uploading ' + file.name + ' (' + (i + 1) + ' of ' + queue.length + ')…');
                if (file.size > MAX_PHOTO_BYTES) {
                    failed.push(file.name + ' (over 10 MB)');
                    continue;
                }
                if (!/^image\//.test(file.type || '')) {
                    failed.push(file.name + ' (not an image)');
                    continue;
                }
                try {
                    photos.push(await uploadToCloudinary(file));
                    renderPhotos();
                } catch (error) {
                    console.error('Cloudinary upload failed:', error);
                    failed.push(file.name + ' (' + error.message + ')');
                }
            }

            label.textContent = originalLabel;
            input.disabled = false;
            renderPhotos();
            saveDraftSoon();

            const notes = [];
            if (failed.length) notes.push('Could not upload: ' + failed.join(', ') + '.');
            if (skipped) notes.push(skipped + ' photo' + (skipped > 1 ? 's were' : ' was') + ' skipped — the limit is ' + MAX_SPOT_IMAGES + '.');
            const uploaded = queue.length - failed.length;
            setPhotoStatus(notes.join(' ') || (uploaded + ' photo' + (uploaded === 1 ? '' : 's') + ' uploaded.'),
                failed.length ? 'error' : '');
        });

        el('AddPhotoUrlBtn').addEventListener('click', async function () {
            const url = await ztimsDialog.prompt({
                title: 'Add a photo by link',
                message: 'Paste the address of a photo that is already online.',
                label: 'Photo link',
                type: 'url',
                placeholder: 'https://…',
                help: 'It must start with http:// or https://.',
                confirmLabel: 'Add photo',
                validate: function (value) {
                    return /^https?:\/\//i.test(value.trim())
                        ? ''
                        : 'That does not look like a photo link. It should start with http:// or https://.';
                }
            });
            if (url === null) return;
            setPhotoStatus('');
            addPhotos([url]);
        });

        // Delegated so the buttons survive every re-render of the gallery.
        el('PhotoGallery').addEventListener('click', function (event) {
            const removeBtn = event.target.closest('[data-remove]');
            const coverBtn = event.target.closest('[data-cover]');
            if (removeBtn) {
                photos.splice(Number(removeBtn.dataset.remove), 1);
            } else if (coverBtn) {
                const index = Number(coverBtn.dataset.cover);
                photos.unshift(photos.splice(index, 1)[0]);
            } else {
                return;
            }
            setPhotoStatus('');
            renderPhotos();
            saveDraftSoon();
        });

        /* ----------------------------------------------------------- draft */

        const draftKey = DRAFT_PREFIX + p;

        function readForm() {
            return {
                title: el('Title').value,
                category: el('Category').value,
                description: el('Description').value,
                label: el('Label').value,
                address: el('LocAddress').value,
                barangay: el('LocBarangay').value,
                latitude: el('LocLat').value,
                longitude: el('LocLng').value,
                schedDays: el('SchedDays').value,
                schedDaysCustom: el('SchedDaysCustom').value,
                schedHours: el('SchedHours').value,
                schedOpen: el('SchedOpen').value,
                schedClose: el('SchedClose').value,
                schedHoursCustom: el('SchedHoursCustom').value,
                travelFee: el('TravelFee').value,
                entranceFee: el('EntranceFee').value,
                takesBookings: el('TakesBookings').checked,
                bookingUrl: el('BookingUrl').value,
                requiresGuide: el('RequiresGuide') ? el('RequiresGuide').checked : false,
                photos: photos.slice()
            };
        }

        function applyForm(data) {
            el('Title').value = data.title || '';
            el('Category').value = data.category || 'MOUNTAIN';
            el('Description').value = data.description || '';
            el('Label').value = data.label || '';
            el('LocAddress').value = data.address || '';
            el('LocBarangay').value = '';
            if (data.barangay) setBarangay(data.barangay);
            el('LocLat').value = data.latitude || '';
            el('LocLng').value = data.longitude || '';
            el('SchedDays').value = data.schedDays || 'Everyday';
            el('SchedDaysCustom').value = data.schedDaysCustom || '';
            el('SchedHours').value = data.schedHours || 'all';
            el('SchedOpen').value = data.schedOpen || '';
            el('SchedClose').value = data.schedClose || '';
            el('SchedHoursCustom').value = data.schedHoursCustom || '';
            el('TravelFee').value = data.travelFee || '';
            el('EntranceFee').value = data.entranceFee || '';
            el('TakesBookings').checked = Boolean(data.takesBookings);
            el('BookingUrl').value = data.bookingUrl || '';
            el('BookingRow').hidden = !data.takesBookings;
            if (el('RequiresGuide')) el('RequiresGuide').checked = Boolean(data.requiresGuide);
            photos = Array.isArray(data.photos) ? data.photos.slice() : [];

            paintSchedule();
            // A restored draft's pin was placed by whoever drafted it, but nobody
            // has looked at it since. One glance and one press is a small price for
            // never publishing a pin that was last seen days ago.
            locationConfirmed = false;
            hadPointOnOpen = false;
            setLocPhase();
            renderPhotos();
            paintPreview();
        }

        function isBlank(data) {
            return !data.title.trim() && !data.description.trim() && !data.label.trim() &&
                !data.address.trim() && !data.barangay && !data.latitude && !data.photos.length;
        }

        // Only while creating: an edit already has a saved copy on the server, and
        // a stale draft overwriting one would be worse than losing a few keystrokes.
        function saveDraftSoon() {
            if (editingId) return;
            clearTimeout(draftTimer);
            draftTimer = setTimeout(function () {
                try {
                    const data = readForm();
                    if (isBlank(data)) { localStorage.removeItem(draftKey); return; }
                    localStorage.setItem(draftKey, JSON.stringify({ at: Date.now(), data: data }));
                } catch (error) {
                    /* A full or blocked localStorage must never break the form. */
                }
            }, 400);
        }

        function clearDraft() {
            clearTimeout(draftTimer);
            try { localStorage.removeItem(draftKey); } catch (error) { /* see above */ }
        }

        function readDraft() {
            try {
                const raw = localStorage.getItem(draftKey);
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                if (!parsed || !parsed.data) return null;
                if (Date.now() - Number(parsed.at || 0) > DRAFT_MAX_AGE_MS) { clearDraft(); return null; }
                return parsed;
            } catch (error) {
                return null;
            }
        }

        function describeWhen(timestamp) {
            const minutes = Math.round((Date.now() - timestamp) / 60000);
            if (minutes < 1) return 'a moment ago';
            if (minutes < 60) return minutes + ' minute' + (minutes === 1 ? '' : 's') + ' ago';
            const hours = Math.round(minutes / 60);
            if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
            const days = Math.round(hours / 24);
            return days + ' day' + (days === 1 ? '' : 's') + ' ago';
        }

        el('DraftRestore').addEventListener('click', function () {
            const draft = readDraft();
            if (draft) applyForm(draft.data);
            el('DraftBar').hidden = true;
        });

        el('DraftDiscard').addEventListener('click', function () {
            clearDraft();
            el('DraftBar').hidden = true;
        });

        /* ---------------------------------------------------------- submit */

        el('CancelBtn').addEventListener('click', function () {
            if (typeof options.onCancel === 'function') options.onCancel();
        });

        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            setFormError('');

            const problem = firstProblem();
            if (problem) { focusProblem(problem); return; }

            const payload = Object.assign({
                title: el('Title').value.trim(),
                description: el('Description').value.trim(),
                category: el('Category').value,
                label: el('Label').value.trim(),
                travelFee: parseFloat(el('TravelFee').value) || 0,
                entranceFee: parseFloat(el('EntranceFee').value) || 0,
                images: photos.slice(),
                imageUrl: photos[0] || '',          // photo one is the cover
                bookingUrl: bookingValue()
            }, scheduleValue(), locationPayload());

            if (el('RequiresGuide')) payload.requiresGuide = el('RequiresGuide').checked;

            const button = el('SubmitBtn');
            const originalHTML = button.innerHTML;
            button.disabled = true;
            button.innerHTML = '<span class="inline-block w-4 h-4 rounded-full border-2 border-current ' +
                'border-t-transparent animate-spin align-[-3px] mr-2"></span>' +
                (editingId ? 'Saving…' : 'Publishing…');

            try {
                await options.onSubmit(payload, { editingId: editingId, spot: currentSpot });
                clearDraft();
            } catch (error) {
                // A page can throw a silent, expected cancellation (e.g. the
                // manager backed out of a duplicate-listing prompt) — that isn't
                // a save failure, so it gets no error banner.
                if (!error || !error.silent) setFormError((error && error.message) || 'That could not be saved.');
            } finally {
                button.disabled = false;
                button.innerHTML = originalHTML;
            }
        });

        /* ------------------------------------------------------------- api */

        function open(spot) {
            uploadTicket = null;      // re-authorised per dialog
            currentSpot = spot || null;
            editingId = spot && spot._id ? String(spot._id) : '';

            el('Title').value = (spot && spot.title) || '';
            el('Category').value = (spot && spot.category) || 'MOUNTAIN';
            el('Description').value = (spot && spot.description) || '';
            el('Label').value = (spot && spot.label) || '';
            el('TravelFee').value = spot && spot.travelFee != null ? spot.travelFee : '';
            el('EntranceFee').value = spot && spot.entranceFee != null ? spot.entranceFee : '';
            if (el('RequiresGuide')) el('RequiresGuide').checked = Boolean(spot && spot.requiresGuide);

            fillBooking(spot);
            fillSchedule(spot);
            fillLocation(spot);

            // A listing saved before galleries existed has only a cover image;
            // showing it as photo one keeps it from being wiped on the next save.
            photos = spot && Array.isArray(spot.images) && spot.images.length
                ? spot.images.slice()
                : (spot && spot.imageUrl ? [spot.imageUrl] : []);

            RULES.forEach(function (rule) { setFieldError(el(rule.field), p + rule.slot, ''); });
            setFormError('');
            setPhotoStatus('');
            renderPhotos();
            paintPreview();

            // An unfinished listing is offered back, never restored behind your back.
            const draft = editingId ? null : readDraft();
            if (draft) {
                el('DraftWhen').textContent = describeWhen(Number(draft.at));
                el('DraftBar').hidden = false;
            } else {
                el('DraftBar').hidden = true;
            }

            goToStep(0);
        }

        function close() {
            // Before anything else: an expanded map is parked on <body> and
            // outlives the dialog otherwise.
            if (expandControl && expandControl.isExpanded && expandControl.isExpanded()) {
                expandControl.collapse();
            }
            if (pinMode) leavePinMode();
            form.reset();
            photos = [];
            currentSpot = null;
            editingId = '';
            el('DraftBar').hidden = true;
        }

        // Nothing is on screen until a page calls open(), but the preview and the
        // pickers should be in a sane state from the start.
        paintSchedule();
        setLocPhase();
        renderPhotos();
        paintPreview();
        paintSteps();

        return {
            element: form,
            open: open,
            close: close,
            goToStep: goToStep,
            clearDraft: clearDraft,
            get editingId() { return editingId; }
        };
    };

    window.SPOT_FORM_BARANGAYS = BARANGAYS;
})();
