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
    const DEFAULT_CENTER = [9.1003, 123.1966];   // Zamboanguita town centre, view only

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

    // A required field says so, once, where it is asked for.
    function required() {
        return '<span class="text-error ml-0.5" title="Required">*</span>';
    }

    function errorSlot(id) {
        return '<p id="' + id + '" hidden class="text-[11px] text-error mt-1 flex items-start gap-1">' +
            '<span class="material-symbols-outlined !text-sm shrink-0">error</span><span data-msg></span></p>';
    }

    function buildMarkup(p, role) {
        const isOfficer = role === 'officer';

        const stepTabs = STEPS.map(function (step, index) {
            return '<button type="button" data-step-tab="' + index + '" ' +
                'class="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-xl text-[11px] font-bold ' +
                'uppercase tracking-wider transition-all min-h-[44px]">' +
                '<span class="material-symbols-outlined !text-base shrink-0">' + step.icon + '</span>' +
                '<span class="truncate hidden sm:inline">' + step.label + '</span>' +
                '<span class="sm:hidden">' + (index + 1) + '</span>' +
                '</button>';
        }).join('');

        return '' +
        '<div id="' + p + 'DraftBar" hidden class="mb-4 flex flex-wrap items-center gap-2 bg-surface-container-high ' +
            'border border-outline-variant/30 rounded-xl px-4 py-3">' +
            '<span class="material-symbols-outlined !text-base text-primary">history</span>' +
            '<p class="text-xs text-on-surface flex-1 min-w-[12rem]">You have an unfinished listing from ' +
                '<b id="' + p + 'DraftWhen"></b>.</p>' +
            '<button type="button" id="' + p + 'DraftRestore" class="px-3 py-2 min-h-[40px] rounded-lg bg-primary ' +
                'text-on-primary text-[11px] font-bold">Restore it</button>' +
            '<button type="button" id="' + p + 'DraftDiscard" class="px-3 py-2 min-h-[40px] rounded-lg ' +
                'border border-outline-variant/40 text-on-surface-variant text-[11px] font-bold">Discard</button>' +
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
                '<p class="text-[11px] text-on-surface-variant mt-1">Accommodation moves the listing under places to stay.</p>' +
            '</div>' +

            '<div>' +
                '<label for="' + p + 'Description" class="' + LABEL + '">Description' + required() + '</label>' +
                '<textarea id="' + p + 'Description" name="description" rows="4" ' +
                    'placeholder="What is there to see and do? What should a visitor know before coming?" ' +
                    'class="' + INPUT + ' resize-none"></textarea>' +
                '<div class="flex justify-between gap-2 mt-1">' +
                    errorSlot(p + 'DescriptionError') +
                    '<span id="' + p + 'DescriptionCount" class="text-[11px] text-on-surface-variant shrink-0 ml-auto"></span>' +
                '</div>' +
            '</div>' +

            '<div>' +
                '<label for="' + p + 'Label" class="' + LABEL + '">Tagline <span class="normal-case font-normal opacity-70">(optional)</span></label>' +
                '<input id="' + p + 'Label" name="label" type="text" placeholder="e.g., Crystal Waters" class="' + INPUT + '"/>' +
                '<p class="text-[11px] text-on-surface-variant mt-1">A short phrase shown under the name.</p>' +
            '</div>' +
        '</section>' +

        /* =========================== STEP 2 — LOCATION ====================== */
        '<section data-step="1" class="space-y-4" hidden>' +
            '<p class="text-[11px] text-on-surface-variant">' +
                'Visitors get directions, distance and travel time from this pin, worked out from wherever they ' +
                'happen to be at the time. Without it, directions stay unavailable for this listing.' +
            '</p>' +

            '<div>' +
                '<label for="' + p + 'LocBarangay" class="' + LABEL + '">Barangay' + required() + '</label>' +
                '<select id="' + p + 'LocBarangay" name="barangay" class="' + INPUT + '">' +
                    '<option value="">Choose a barangay…</option>' +
                    BARANGAYS.map(function (b) {
                        return '<option value="' + escapeHtml(b) + '">' + escapeHtml(b) + '</option>';
                    }).join('') +
                '</select>' +
                errorSlot(p + 'BarangayError') +
            '</div>' +

            '<div>' +
                '<label for="' + p + 'LocAddress" class="' + LABEL + '">Street or sitio <span class="normal-case font-normal opacity-70">(optional)</span></label>' +
                '<input id="' + p + 'LocAddress" name="address" type="text" ' +
                    'placeholder="e.g., Sitio Bonbon, near the wharf" class="' + INPUT + '"/>' +
            '</div>' +

            '<div class="flex items-center gap-2 text-xs text-on-surface-variant bg-surface-container-low rounded-xl px-4 py-3">' +
                '<span class="material-symbols-outlined !text-base">public</span>' +
                '<span><b class="text-on-surface">' + MUNICIPALITY + '</b>, ' + PROVINCE + '</span>' +
            '</div>' +
            '<input type="hidden" id="' + p + 'LocMunicipality" value="' + MUNICIPALITY + '"/>' +
            '<input type="hidden" id="' + p + 'LocProvince" value="' + PROVINCE + '"/>' +

            '<div>' +
                '<label for="' + p + 'LocSearch" class="' + LABEL + '">Find it on the map</label>' +
                '<div class="flex gap-2">' +
                    '<input id="' + p + 'LocSearch" type="text" placeholder="Search an address or landmark" ' +
                        'class="' + INPUT + ' flex-1"/>' +
                    '<button type="button" id="' + p + 'LocSearchBtn" class="shrink-0 px-4 py-3 rounded-xl ' +
                        'bg-surface-variant border border-outline-variant/40 text-xs font-bold text-on-surface ' +
                        'hover:bg-outline-variant/40 transition-all min-h-[44px]">Search</button>' +
                '</div>' +
                '<div id="' + p + 'LocResults" hidden class="mt-2 bg-surface-variant border border-outline-variant/40 ' +
                    'rounded-xl p-1 max-h-44 overflow-y-auto text-on-surface"></div>' +
            '</div>' +

            '<div id="' + p + 'LocMap" class="relative z-0 h-56 sm:h-72 w-full rounded-xl overflow-hidden ' +
                'border border-outline-variant/40 bg-surface-variant"></div>' +
            '<p class="text-[11px] text-on-surface-variant">Tap the map to drop the pin, or drag it to the exact entrance.</p>' +

            // The pin is the truth; the numbers are a readout of it. They used to be
            // two decimal text boxes beside a map that already set them — an
            // invitation to a transposed pin.
            '<div class="flex flex-wrap items-center gap-2 bg-surface-container-low rounded-xl px-4 py-3">' +
                '<span class="material-symbols-outlined !text-base text-primary shrink-0">my_location</span>' +
                '<p id="' + p + 'LocReadout" class="text-xs text-on-surface-variant flex-1 min-w-[10rem]">No pin dropped yet.</p>' +
                '<button type="button" id="' + p + 'LocManualToggle" class="text-[11px] font-bold text-primary ' +
                    'underline underline-offset-2 min-h-[36px] px-1">Enter manually</button>' +
            '</div>' +

            '<div id="' + p + 'LocManualRow" hidden class="grid grid-cols-1 sm:grid-cols-2 gap-3">' +
                '<div>' +
                    '<label for="' + p + 'LocLat" class="' + LABEL + '">Latitude</label>' +
                    '<input id="' + p + 'LocLat" type="text" inputmode="decimal" placeholder="9.123456" class="' + INPUT + '"/>' +
                '</div>' +
                '<div>' +
                    '<label for="' + p + 'LocLng" class="' + LABEL + '">Longitude</label>' +
                    '<input id="' + p + 'LocLng" type="text" inputmode="decimal" placeholder="123.123456" class="' + INPUT + '"/>' +
                '</div>' +
            '</div>' +

            '<div class="flex flex-wrap gap-2">' +
                '<button type="button" id="' + p + 'LocConfirm" class="' + CHIP_BTN + '">' +
                    '<span class="material-symbols-outlined !text-base">check_circle</span> Confirm location</button>' +
                '<button type="button" id="' + p + 'LocClear" class="' + CHIP_BTN + ' !text-on-surface-variant">' +
                    '<span class="material-symbols-outlined !text-base">location_off</span> Clear</button>' +
            '</div>' +

            '<p id="' + p + 'LocStatus" hidden class="text-[11px] text-on-surface-variant"></p>' +
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
            '<p class="text-[11px] text-on-surface-variant">Leave a fee at zero if there is nothing to pay.</p>' +

            '<div class="pt-1">' +
                '<label class="inline-flex items-center gap-2.5 cursor-pointer select-none min-h-[44px]">' +
                    '<input id="' + p + 'TakesBookings" type="checkbox" class="w-5 h-5 rounded border-outline-variant/60 ' +
                        'bg-surface-variant text-primary focus:ring-primary focus:ring-offset-0"/>' +
                    '<span class="text-xs font-bold uppercase tracking-wider text-on-surface">Visitors can book online</span>' +
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
                        '<span class="text-xs font-bold uppercase tracking-wider text-on-surface">Requires a tourist guide</span>' +
                    '</label>' +
                    '<p class="text-[11px] text-on-surface-variant mt-1">Visitors are told a guide is needed. Assign the ' +
                        'guides themselves under Tourist Guides.</p>' +
                  '</div>'
                : '') +
        '</section>' +

        /* ============================ STEP 4 — PHOTOS ======================= */
        '<section data-step="3" class="space-y-4" hidden>' +
            '<div class="flex items-center justify-between gap-2">' +
                '<label class="' + LABEL + ' !mb-0">Photos</label>' +
                '<span id="' + p + 'PhotoCounter" class="text-[11px] text-on-surface-variant font-bold"></span>' +
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
            '<p id="' + p + 'PhotoEmptyHint" class="text-[11px] text-on-surface-variant">' +
                'The first photo becomes the cover. A listing with no photo shows a grey placeholder on the public page.</p>' +
            '<p id="' + p + 'PhotoStatus" hidden class="text-[11px]"></p>' +
        '</section>' +

        '</div>' +

        /* ============================== PREVIEW ============================= */
        '<aside class="hidden xl:block">' +
            '<p class="' + LABEL + '">What visitors will see</p>' +
            '<div id="' + p + 'Preview" class="rounded-2xl overflow-hidden bg-surface-container-low ' +
                'border border-outline-variant/30 sticky top-0"></div>' +
            '<p class="text-[11px] text-on-surface-variant mt-2">Updates as you type.</p>' +
        '</aside>' +
        '</div>' +

        /* ============================== FOOTER ============================== */
        '<p id="' + p + 'FormError" hidden class="mt-5 text-sm text-error bg-error/10 border border-error/20 ' +
            'rounded-xl px-4 py-3"></p>' +

        '<div class="flex flex-wrap gap-3 pt-5 mt-5 border-t border-outline-variant/20">' +
            '<button type="button" id="' + p + 'CancelBtn" class="flex-1 min-w-[7rem] bg-outline-variant ' +
                'hover:bg-outline-variant/80 text-on-surface font-bold py-3.5 rounded-full transition-all min-h-[48px]">Cancel</button>' +
            '<button type="button" id="' + p + 'BackBtn" hidden class="flex-1 min-w-[7rem] border border-outline-variant/50 ' +
                'text-on-surface font-bold py-3.5 rounded-full transition-all min-h-[48px]">Back</button>' +
            '<button type="button" id="' + p + 'NextBtn" class="flex-[2] min-w-[9rem] bg-primary text-on-primary ' +
                'font-bold py-3.5 rounded-full transition-all shadow-lg hover:scale-[1.02] min-h-[48px]">Next</button>' +
            '<button type="submit" id="' + p + 'SubmitBtn" hidden class="flex-[2] min-w-[9rem] bg-primary text-on-primary ' +
                'font-bold py-3.5 rounded-full transition-all shadow-lg hover:scale-[1.02] min-h-[48px]">Publish</button>' +
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
        let manualOpen = false;
        let draftTimer = null;

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
            if (show) setFieldError(field, p + rule.slot, message);
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
            const field = el(rule.field);
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

            if (step === 1) refreshMap();
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
                    '<p class="text-[10px] font-bold uppercase tracking-widest text-primary mb-1">' + escapeHtml(category) + '</p>' +
                    '<h4 class="font-display font-bold text-on-surface leading-tight mb-1">' + escapeHtml(title) + '</h4>' +
                    (label ? '<p class="text-[11px] text-on-surface-variant italic mb-1">' + escapeHtml(label) + '</p>' : '') +
                    '<p class="text-[11px] text-on-surface-variant flex items-start gap-1 mb-2">' +
                        '<span class="material-symbols-outlined !text-sm shrink-0">location_on</span>' +
                        '<span>' + escapeHtml(where) + '</span></p>' +
                    '<p class="text-xs text-on-surface-variant line-clamp-3">' +
                        escapeHtml(description || 'No description yet.') + '</p>' +
                    '<p class="text-[11px] font-bold text-on-surface mt-3">Entrance ' + formatPeso(entrance) + '</p>' +
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
            status.style.color = tone === 'error' ? '#f87171' : (tone === 'ok' ? '#4ade80' : '');
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

        function paintReadout() {
            const point = readPoint();
            el('LocReadout').textContent = point
                ? 'Pin at ' + point.lat.toFixed(6) + ', ' + point.lng.toFixed(6) + '.'
                : 'No pin dropped yet — directions stay unavailable for this listing.';
        }

        function writePoint(lat, lng) {
            el('LocLat').value = lat.toFixed(6);
            el('LocLng').value = lng.toFixed(6);
            paintReadout();
            saveDraftSoon();
        }

        el('LocManualToggle').addEventListener('click', function () {
            manualOpen = !manualOpen;
            el('LocManualRow').hidden = !manualOpen;
            el('LocManualToggle').textContent = manualOpen ? 'Hide the numbers' : 'Enter manually';
        });
        [el('LocLat'), el('LocLng')].forEach(function (field) {
            field.addEventListener('input', function () { paintReadout(); saveDraftSoon(); });
        });

        function placeMarker(lat, lng, recentre) {
            if (!map) return;
            if (!marker) {
                marker = window.L.marker([lat, lng], { draggable: true }).addTo(map);
                marker.on('dragend', function () {
                    const at = marker.getLatLng();
                    writePoint(at.lat, at.lng);
                    say('Pin moved to ' + at.lat.toFixed(6) + ', ' + at.lng.toFixed(6) + '.', 'ok');
                });
            } else {
                marker.setLatLng([lat, lng]);
            }
            if (recentre) map.setView([lat, lng], Math.max(map.getZoom(), 16));
        }

        function clearMarker() {
            if (marker && map) map.removeLayer(marker);
            marker = null;
        }

        async function ensureMap() {
            if (map) return map;
            await loadLeaflet();

            map = window.L.map(el('LocMap'), { scrollWheelZoom: false }).setView(DEFAULT_CENTER, 13);
            window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap contributors'
            }).addTo(map);

            map.on('click', function (event) {
                writePoint(event.latlng.lat, event.latlng.lng);
                placeMarker(event.latlng.lat, event.latlng.lng, false);
                say('Pin set. Drag it if the exact gate is somewhere else.', 'ok');
                describePoint({ lat: event.latlng.lat, lng: event.latlng.lng });
            });

            /* Dropping a pin on a 14rem map means guessing which building is
               which. Full screen is where the gate can actually be found, so
               the control is here as well as on the public maps. Only the
               control is lost if the map module is missing; the picker itself
               carries on. */
            if (window.ZTIMS_MAP && window.ZTIMS_MAP.addExpandControl) {
                window.ZTIMS_MAP.addExpandControl(map, el('LocMap'), function () {
                    const point = readPoint();
                    // Stay on the pin through the change of size: re-framing to
                    // anything else would lose the thing being placed.
                    if (point) map.setView([point.lat, point.lng], Math.max(map.getZoom(), 16));
                });
            }

            return map;
        }

        // Leaflet measures the container on creation, so a map built inside a
        // closed dialog comes out zero-sized. Called whenever step 2 is shown.
        async function refreshMap() {
            try {
                await ensureMap();
                map.invalidateSize();
                const point = readPoint();
                if (point) placeMarker(point.lat, point.lng, true);
                else { clearMarker(); map.setView(DEFAULT_CENTER, 13); }
            } catch (error) {
                say(error.message, 'error');
            }
        }

        // A dropdown only takes a value it already has an option for, so the
        // geocoder's spelling is matched against the ten rather than assigned.
        function setBarangay(value) {
            const wanted = String(value || '').trim().toLowerCase();
            if (!wanted) return false;
            const match = BARANGAYS.find(function (b) { return b.toLowerCase() === wanted; });
            if (!match) return false;
            el('LocBarangay').value = match;
            return true;
        }

        // Turns a pin into readable address text. It only ever fills fields that
        // are still empty — something typed by hand is never overwritten.
        async function describePoint(point) {
            try {
                const response = await fetch(apiBase + '/directions/reverse?lat=' + point.lat + '&lng=' + point.lng);
                const data = await response.json().catch(function () { return {}; });
                if (!response.ok) return;

                if (data.label && !el('LocAddress').value.trim()) el('LocAddress').value = data.label;
                if (data.barangay && !el('LocBarangay').value) setBarangay(data.barangay);
                paintPreview();
                saveDraftSoon();
            } catch (error) {
                /* The pin is what gets saved; the address text is only a convenience. */
            }
        }

        function renderResults(list) {
            const results = el('LocResults');
            results.innerHTML = '';
            results.hidden = list.length === 0;

            list.forEach(function (place) {
                // Built with textContent, never innerHTML: these labels come from an
                // outside geocoder and must never be treated as markup.
                const option = document.createElement('button');
                option.type = 'button';
                option.textContent = place.label;
                option.className = 'w-full text-left text-xs px-3 py-2.5 rounded-lg hover:bg-outline-variant/30 transition-colors';
                option.addEventListener('click', async function () {
                    writePoint(place.latitude, place.longitude);
                    await ensureMap();
                    placeMarker(place.latitude, place.longitude, true);
                    results.hidden = true;
                    if (!el('LocAddress').value.trim()) el('LocAddress').value = place.label;
                    describePoint({ lat: place.latitude, lng: place.longitude });
                    say('Pin placed. Drag it if the exact gate is somewhere else.', 'ok');
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
                    : 'No match found. Drop the pin on the map instead.');
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

        el('LocConfirm').addEventListener('click', async function () {
            const point = readPoint();
            if (!point) {
                say('No location set yet. Search for the address, or tap the map to drop a pin.', 'error');
                return;
            }
            try {
                await ensureMap();
                placeMarker(point.lat, point.lng, true);
                map.invalidateSize();
                await describePoint(point);
                say('Location confirmed: ' + point.lat.toFixed(6) + ', ' + point.lng.toFixed(6) + '.', 'ok');
            } catch (error) {
                say(error.message, 'error');
            }
        });

        el('LocClear').addEventListener('click', function () {
            el('LocLat').value = '';
            el('LocLng').value = '';
            clearMarker();
            paintReadout();
            say('Location cleared. Visitors will not be offered directions to this listing.');
            saveDraftSoon();
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

            el('LocSearch').value = '';
            el('LocResults').innerHTML = '';
            el('LocResults').hidden = true;
            manualOpen = false;
            el('LocManualRow').hidden = true;
            el('LocManualToggle').textContent = 'Enter manually';
            paintReadout();
            say('');
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

        async function uploadToCloudinary(file) {
            const body = new FormData();
            body.append('file', file);
            body.append('upload_preset', options.uploadPreset);

            const response = await fetch('https://api.cloudinary.com/v1_1/' + options.cloudName + '/image/upload', {
                method: 'POST', body: body
            });
            const result = await response.json().catch(function () { return {}; });
            if (!response.ok || !result.secure_url) {
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

        el('AddPhotoUrlBtn').addEventListener('click', function () {
            const url = prompt('Paste the photo link (it must start with http:// or https://)');
            if (url === null) return;
            if (!/^https?:\/\//i.test(url.trim())) {
                setPhotoStatus('That does not look like a photo link. It should start with http:// or https://.', 'error');
                return;
            }
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
            paintReadout();
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
                setFormError(error.message || 'That could not be saved.');
            } finally {
                button.disabled = false;
                button.innerHTML = originalHTML;
            }
        });

        /* ------------------------------------------------------------- api */

        function open(spot) {
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
            form.reset();
            photos = [];
            currentSpot = null;
            editingId = '';
            el('DraftBar').hidden = true;
        }

        // Nothing is on screen until a page calls open(), but the preview and the
        // pickers should be in a sane state from the start.
        paintSchedule();
        paintReadout();
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
