/* ==========================================================================
   The tourism map — OpenStreetMap through Leaflet, with ZTIMS's own markers
   --------------------------------------------------------------------------
   Responsibilities, kept apart on purpose:

     OpenStreetMap      the tiles: roads, buildings, coastline, place names
     Leaflet            drawing, panning, zooming, markers, popups, the route
     ZTIMS (this file)  which places exist, what category each one is, and
                        therefore which marker it gets
     OpenRouteService   the route, its distance and its travel time

   Nothing here talks to OpenRouteService. Routing already goes through the
   ZTIMS API (/api/directions/route), which holds the key server-side, and a
   marker's "Get Directions" hands off to that existing flow rather than
   starting a second one.
   ========================================================================== */

(function () {
    'use strict';

    const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

    // Only the opening view when there is nothing to fit to. Never saved anywhere.
    const DEFAULT_CENTRE = [9.1003, 123.1966];   // Zamboanguita town centre
    const DEFAULT_ZOOM = 12;

    // OpenStreetMap's tile usage policy asks for this attribution, and for the
    // tiles not to be used as a bulk source. It stays visible at every size.
    const OSM_TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" ' +
        'target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

    /* ------------------------------------------------------------ categories */

    /* ZTIMS's own four categories, not OpenStreetMap's and not the routing
       service's. The glyphs come from Material Symbols, which every page
       already loads, so the markers look like the rest of the system rather
       than like a second design dropped on top of it. */
    /* Category colours, drawn from the Coastal Tourism palette rather than from
       four unrelated material hues. Written as hex, not tokens, because Leaflet
       builds these markers as inline SVG and canvas fills where a CSS variable
       would not resolve — so this is the one place the palette is repeated, and
       it is repeated deliberately. Ocean for a place to stay, teal for a natural
       attraction, coastal blue for the sea, gold for what the municipality keeps. */
    const CATEGORIES = {
        'BEACH / DIVING': { label: 'Beach / Diving', icon: 'scuba_diving', colour: '#168AAD' },
        'MOUNTAIN': { label: 'Mountain', icon: 'landscape', colour: '#2A9D8F' },
        'CULTURAL': { label: 'Cultural', icon: 'museum', colour: '#F4B942' },
        'ACCOMMODATION': { label: 'Accommodation', icon: 'hotel', colour: '#0B4F6C' }
    };

    const FALLBACK_CATEGORY = { label: 'Tourist spot', icon: 'photo_camera', colour: '#667085' };

    function categoryOf(spot) {
        const key = String((spot && spot.category) || '').trim().toUpperCase();
        return CATEGORIES[key] || FALLBACK_CATEGORY;
    }

    /* --------------------------------------------------------------- helpers */

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    /* The same rule the API applies. A half-filled pair is not a location:
       Number('') is 0, so "no longitude" would otherwise become a point in the
       Gulf of Guinea. A record that fails this gets no marker at all — a
       visitor should never be sent somewhere ZTIMS is guessing about. */
    function pointOf(spot) {
        if (!spot) return null;
        const rawLat = spot.latitude;
        const rawLng = spot.longitude;
        if (rawLat === '' || rawLat === null || rawLat === undefined) return null;
        if (rawLng === '' || rawLng === null || rawLng === undefined) return null;

        const lat = Number(rawLat);
        const lng = Number(rawLng);
        if (!isFinite(lat) || !isFinite(lng)) return null;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
        if (lat === 0 && lng === 0) return null;
        return { lat: lat, lng: lng };
    }

    function locationLine(spot) {
        return [spot.address, spot.barangay, spot.municipality, spot.province]
            .map(function (part) { return String(part || '').trim(); })
            .filter(Boolean)
            .join(', ');
    }

    let leafletLoading = null;
    function loadLeaflet() {
        if (window.L) return Promise.resolve(window.L);
        if (leafletLoading) return leafletLoading;

        leafletLoading = new Promise(function (resolve, reject) {
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = LEAFLET_CSS;
            document.head.appendChild(css);

            const script = document.createElement('script');
            script.src = LEAFLET_JS;
            script.onload = function () { resolve(window.L); };
            script.onerror = function () {
                leafletLoading = null;   // so a later attempt can retry
                reject(new Error('The map could not be loaded. Check your connection.'));
            };
            document.head.appendChild(script);
        });
        return leafletLoading;
    }

    /* ------------------------------------------------------------ marker look */

    let stylesInjected = false;
    function injectStyles() {
        if (stylesInjected) return;
        stylesInjected = true;

        const style = document.createElement('style');
        style.id = 'ztims-map-styles';
        style.textContent = `
        .ztims-pin {
            width: 34px; height: 34px;
            /* A square turned on its corner: a diamond whose lowest point
               marks the spot, sharp-edged like the rest of the site. */
            border-radius: 0;
            transform: rotate(-45deg);
            background: var(--pin, #455A64);
            border: 2px solid rgba(255,255,255,.9);
            box-shadow: 0 3px 8px rgba(0,0,0,.35);
            display: flex; align-items: center; justify-content: center;
        }
        .ztims-pin > span {
            transform: rotate(45deg);
            color: #fff;
            font-size: 18px;
            line-height: 1;
        }
        .ztims-pin--origin { border-radius: 0; transform: none; }
        .ztims-pin--origin > span { transform: none; }

        .leaflet-popup-content-wrapper { border-radius: 0; }
        /* Leaflet's own stylesheet rounds its zoom buttons and layer box. */
        .leaflet-bar, .leaflet-bar a, .leaflet-control-layers { border-radius: 0 !important; }
        .leaflet-popup-content { margin: 14px 16px; min-width: 190px; }
        .ztims-popup__category {
            font-size: 10px; font-weight: 700; letter-spacing: .1em;
            text-transform: uppercase; margin: 0 0 4px;
        }
        .ztims-popup__title { font-size: 15px; font-weight: 700; margin: 0 0 4px; color: #17212B; }
        .ztims-popup__where { font-size: 12px; color: #667085; margin: 0 0 10px; }
        .ztims-popup__actions { display: flex; flex-wrap: wrap; gap: 6px; }
        .ztims-popup__actions a {
            flex: 1 1 auto; text-align: center; white-space: nowrap;
            padding: 9px 12px; min-height: 40px; box-sizing: border-box;
            border-radius: 0; font-size: 11px; font-weight: 700; text-decoration: none;
        }
        .ztims-popup__actions .is-primary { background: #0B4F6C; color: #fff; }
        .ztims-popup__actions .is-secondary { border: 1px solid #CDD8E2; color: #0B4F6C; }

        .ztims-legend {
            display: flex; flex-wrap: wrap; gap: 6px 14px;
            font-size: 11px; font-weight: 700; align-items: center;
        }
        .ztims-legend span.dot {
            width: 10px; height: 10px; border-radius: 0; display: inline-block; margin-right: 5px;
        }

        /* Expanded view. Fixed rather than the Fullscreen API: Safari on iPhone
           will not put a plain <div> into fullscreen, and a phone is exactly
           where a bigger map is wanted most. */
        .ztims-map--expanded {
            position: fixed !important;
            inset: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            height: 100dvh !important;      /* keeps clear of mobile browser chrome */
            max-height: none !important;
            margin: 0 !important;
            border-radius: 0 !important;
            border: 0 !important;
            z-index: 1200 !important;
        }
        body.ztims-map-locked { overflow: hidden; }

        .ztims-expand {
            background: #fff; color: #222;
            border: 2px solid rgba(0,0,0,.2);
            border-radius: 0;
            width: 40px; height: 40px;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; box-shadow: 0 1px 5px rgba(0,0,0,.3);
        }
        .ztims-expand:hover { background: #f4f4f4; }
        .ztims-expand .material-symbols-outlined { font-size: 20px; line-height: 1; }

        /* The always-on name beside each pin. Leaflet's tooltip default is a
           white box with a pointer; this is a bare label instead, the way a map
           names a place. The white halo keeps it readable over roads, water and
           open land without a box getting in the way of the map underneath. */
        .leaflet-tooltip.ztims-label {
            background: transparent;
            border: 0;
            box-shadow: none;
            padding: 0;
            margin: 0;
            font-family: inherit;
            font-size: 11px;
            font-weight: 800;
            letter-spacing: .01em;
            white-space: nowrap;
            text-shadow:
                 0  0   3px #fff,  0  0 3px #fff,
                 1px 0  2px #fff, -1px 0 2px #fff,
                 0  1px 2px #fff,  0 -1px 2px #fff;
            /* Clicks belong to the pin, not to the text floating next to it. */
            pointer-events: none;
        }
        /* Leaflet draws the tooltip's pointer with ::before. A bare label has none. */
        .leaflet-tooltip.ztims-label::before { display: none !important; }

        .ztims-map--nolabels .leaflet-tooltip.ztims-label { display: none; }`;
        document.head.appendChild(style);
    }

    function markerIcon(spot) {
        injectStyles();
        const meta = categoryOf(spot);
        return window.L.divIcon({
            className: '',       // no Leaflet default box around the pin
            html: '<div class="ztims-pin" style="--pin:' + meta.colour + '">' +
                      '<span class="material-symbols-outlined">' + meta.icon + '</span>' +
                  '</div>',
            iconSize: [34, 34],
            iconAnchor: [17, 34],
            popupAnchor: [0, -32],
            // Where the always-on name label hangs from — just above the pin.
            tooltipAnchor: [0, -36]
        });
    }

    // Names below this are more clutter than help: at municipality-wide zoom the
    // labels would overlap each other and the roads underneath.
    const LABEL_MIN_ZOOM = 12;

    /**
     * The name, shown beside the pin without anyone having to click it. A map
     * where every marker is an anonymous dot makes you tap each one to find out
     * what it is; the point of the map is to answer that at a glance.
     *
     * Coloured by category and haloed in white so it stays readable over roads,
     * water and open land alike.
     */
    function attachLabel(marker, spot) {
        const meta = categoryOf(spot);
        const title = String(spot.title || '').trim();
        if (!title) return marker;

        marker.bindTooltip(
            '<span style="color:' + meta.colour + '">' + escapeHtml(title) + '</span>',
            { permanent: true, direction: 'top', className: 'ztims-label', opacity: 1 }
        );
        return marker;
    }

    // Labels are hidden rather than removed, so zooming back in costs nothing.
    function watchLabelZoom(map, mount) {
        function paint() {
            mount.classList.toggle('ztims-map--nolabels', map.getZoom() < LABEL_MIN_ZOOM);
        }
        map.on('zoomend', paint);
        paint();
    }

    function originIcon() {
        injectStyles();
        return window.L.divIcon({
            className: '',
            html: '<div class="ztims-pin ztims-pin--origin" style="--pin:#1565C0">' +
                      '<span class="material-symbols-outlined">person_pin_circle</span>' +
                  '</div>',
            iconSize: [30, 30],
            iconAnchor: [15, 15],
            popupAnchor: [0, -16]
        });
    }

    /* ------------------------------------------------------------- expanding */

    /**
     * A control that grows the map to fill the window, and puts it back.
     *
     * Leaflet measures its container once and caches the size, so every change
     * of shape has to be followed by invalidateSize() or the tiles stay laid
     * out for the old box — grey bands down one side, markers in the wrong
     * place. onResize lets the caller re-frame whatever the map is about: all
     * the markers on the tourism map, the route on a directions map.
     */
    function addExpandControl(map, mount, onResize) {
        injectStyles();
        let expanded = false;

        const control = window.L.control({ position: 'topright' });

        control.onAdd = function () {
            const button = window.L.DomUtil.create('button', 'ztims-expand');
            button.type = 'button';
            button.innerHTML = '<span class="material-symbols-outlined">open_in_full</span>';
            button.title = 'Make the map bigger';
            button.setAttribute('aria-label', 'Make the map bigger');
            button.setAttribute('aria-pressed', 'false');

            // Without this a click on the control also reaches the map, which
            // would drop a pin or start a drag underneath the button.
            window.L.DomEvent.disableClickPropagation(button);
            window.L.DomEvent.on(button, 'click', function (event) {
                window.L.DomEvent.preventDefault(event);
                setExpanded(!expanded);
            });

            control._button = button;
            return button;
        };

        function paint() {
            const button = control._button;
            if (!button) return;
            button.innerHTML = '<span class="material-symbols-outlined">' +
                (expanded ? 'close_fullscreen' : 'open_in_full') + '</span>';
            const label = expanded ? 'Make the map smaller' : 'Make the map bigger';
            button.title = label;
            button.setAttribute('aria-label', label);
            button.setAttribute('aria-pressed', expanded ? 'true' : 'false');
        }

        /* Where the map sits while it is expanded.

           `position: fixed` is measured against the nearest ancestor carrying a
           transform, not against the viewport. Both entrance animations end on
           `transform: none`, but they fill forwards, and Chromium treats an
           element with a filling transform animation as a containing block even
           when the matrix is the identity. On the destination page that ancestor
           is <main class="page-enter">, so inset:0/100dvh resolved to main's box
           and the maximized map came out as a strip across the top of the page.

           Hanging the map off <body> for the duration settles it, and keeps
           settling it if some future wrapper picks up a transform. Leaflet holds
           the container by reference, so moving the node costs nothing — and
           invalidateSize() below already runs after every change of shape. */
        let anchor = null;

        function portal(out) {
            if (out) {
                if (anchor || !mount.parentNode) return;
                anchor = document.createComment('ztims-map');
                mount.parentNode.insertBefore(anchor, mount);
                document.body.appendChild(mount);
            } else if (anchor) {
                if (anchor.parentNode) {
                    anchor.parentNode.insertBefore(mount, anchor);
                    anchor.parentNode.removeChild(anchor);
                }
                anchor = null;
            }
        }

        function setExpanded(next) {
            expanded = next;
            portal(expanded);
            mount.classList.toggle('ztims-map--expanded', expanded);
            // The page behind must not scroll while the map covers it.
            document.body.classList.toggle('ztims-map-locked', expanded);
            paint();

            // After the browser has applied the new size, never before it.
            requestAnimationFrame(function () {
                map.invalidateSize();
                if (typeof onResize === 'function') onResize(expanded);
            });
        }

        // Capture phase, and the event stops here. This map can sit inside a
        // dialog that also closes on Escape — the establishment's listing form
        // does. Without this, shrinking the map would close the whole form and
        // throw away everything typed into it. Registered on capture so it runs
        // before the dialog's own bubble-phase listener, whichever was added
        // first, and only swallows the key while the map is actually expanded.
        document.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape' || !expanded) return;
            event.stopPropagation();
            setExpanded(false);
        }, true);

        control.addTo(map);
        return { isExpanded: function () { return expanded; }, collapse: function () { setExpanded(false); } };
    }

    /* --------------------------------------------------------------- popups */

    /**
     * What a visitor sees on tapping a marker: what the place is, where it is,
     * and the two things they might want next. Both buttons lead into pages
     * that already exist — this map adds no directions logic of its own.
     */
    function popupHtml(spot, detailHref) {
        const meta = categoryOf(spot);
        const where = locationLine(spot) || 'Zamboanguita, Negros Oriental';

        // Each URL is assembled first and escaped once. Escaping the base and then
        // concatenating would leave the joining "&" raw in the attribute.
        const separator = detailHref.indexOf('?') === -1 ? '?' : '&';
        const directionsHref = detailHref + separator + 'directions=1';

        return '' +
            '<p class="ztims-popup__category" style="color:' + meta.colour + '">' +
                escapeHtml(meta.label) + '</p>' +
            '<p class="ztims-popup__title">' + escapeHtml(spot.title || 'Untitled listing') + '</p>' +
            '<p class="ztims-popup__where">' + escapeHtml(where) + '</p>' +
            '<div class="ztims-popup__actions">' +
                '<a class="is-secondary" href="' + escapeHtml(detailHref) + '">View details</a>' +
                '<a class="is-primary" href="' + escapeHtml(directionsHref) + '">Get directions</a>' +
            '</div>';
    }

    /* ----------------------------------------------------------- the map itself */

    /**
     * options:
     *   mount        the element to draw into (required)
     *   spots        records straight from /api/spots — never a hard-coded list
     *   detailHref   spot -> the URL of its existing detail page
     *   legend       an element to render the category key into (optional)
     *   onReady      called with { shown, skipped } once the markers are placed
     */
    function mountTourismMap(options) {
        const mount = options.mount;
        if (!mount) return Promise.resolve(null);

        return loadLeaflet().then(function (L) {
            injectStyles();

            const map = L.map(mount, { scrollWheelZoom: false }).setView(DEFAULT_CENTRE, DEFAULT_ZOOM);
            L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);

            const state = { map: map, markers: [], shown: 0, skipped: 0, bounds: [] };

            // Re-framed on every change of size, so growing the map shows more of
            // the municipality rather than the same view in a bigger box.
            watchLabelZoom(map, mount);

            state.expander = addExpandControl(map, mount, function () {
                if (state.bounds.length === 1) map.setView(state.bounds[0], 15);
                else if (state.bounds.length > 1) {
                    map.fitBounds(state.bounds, { padding: [40, 40], maxZoom: 15 });
                }
            });

            state.setSpots = function (spots) {
                state.markers.forEach(function (marker) { map.removeLayer(marker); });
                state.markers = [];
                state.shown = 0;
                state.skipped = 0;

                const bounds = [];
                const seenCategories = new Set();

                (spots || []).forEach(function (spot) {
                    const point = pointOf(spot);
                    if (!point) {
                        // No pin means no marker. Never a guessed position, and
                        // never a marker at 0,0 — the visitor would believe it.
                        state.skipped += 1;
                        return;
                    }

                    const marker = L.marker([point.lat, point.lng], {
                        icon: markerIcon(spot),
                        title: spot.title || ''
                    }).addTo(map);

                    attachLabel(marker, spot);

                    marker.bindPopup(popupHtml(spot, options.detailHref
                        ? options.detailHref(spot)
                        : 'src/spot.html?spotId=' + encodeURIComponent(spot._id)));

                    state.markers.push(marker);
                    bounds.push([point.lat, point.lng]);
                    seenCategories.add(categoryOf(spot).label);
                    state.shown += 1;
                });

                state.bounds = bounds;      // kept so expanding can re-frame them
                if (bounds.length === 1) {
                    map.setView(bounds[0], 15);
                } else if (bounds.length > 1) {
                    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
                }

                if (options.legend) renderLegend(options.legend, seenCategories);
                map.invalidateSize();

                if (typeof options.onReady === 'function') {
                    options.onReady({ shown: state.shown, skipped: state.skipped });
                }
            };

            if (options.spots) state.setSpots(options.spots);
            return state;
        });
    }

    // Only the categories actually on the map are listed; a key to markers that
    // are not there is noise.
    function renderLegend(host, labels) {
        const entries = Object.keys(CATEGORIES)
            .map(function (key) { return CATEGORIES[key]; })
            .filter(function (meta) { return labels.has(meta.label); });

        if (entries.length === 0) { host.innerHTML = ''; host.hidden = true; return; }

        host.hidden = false;
        // Added, not assigned: the page sets its own layout classes on this
        // element, and overwriting className silently threw them away.
        host.classList.add('ztims-legend', 'text-on-surface-variant');
        host.innerHTML = entries.map(function (meta) {
            return '<span><span class="dot" style="background:' + meta.colour + '"></span>' +
                escapeHtml(meta.label) + '</span>';
        }).join('');
    }

    window.ZTIMS_MAP = {
        CATEGORIES: CATEGORIES,
        OSM_TILES: OSM_TILES,
        OSM_ATTRIBUTION: OSM_ATTRIBUTION,
        DEFAULT_CENTRE: DEFAULT_CENTRE,
        loadLeaflet: loadLeaflet,
        pointOf: pointOf,
        categoryOf: categoryOf,
        markerIcon: markerIcon,
        originIcon: originIcon,
        addExpandControl: addExpandControl,
        attachLabel: attachLabel,
        watchLabelZoom: watchLabelZoom,
        locationLine: locationLine,
        mountTourismMap: mountTourismMap
    };
})();
