/* The offline gate's service worker — lets src/admin/admin_gate.html open, and
 * keep working, at a spot with no signal at all.
 *
 * Registered by that page only, with its scope narrowed to it, so it never
 * touches any other page. It keeps a copy of the page and what the page loads
 * (theme, Tailwind, fonts, the QR reader). The page is fetched fresh whenever
 * the network answers within a few seconds, so a new version still arrives;
 * everything else is served from the copy and refreshed behind it. /api is
 * never cached here: the gate list and the scans are the page's own business,
 * kept in IndexedDB.
 *
 * Lives in public/ so it is served from the site root: Vite would otherwise
 * bundle and rename it.
 */
const CACHE = 'ztims-gate-v1';
const PAGE_WAIT_MS = 3000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('ztims-gate-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
})()));

const isApi = url => url.origin === self.location.origin && url.pathname.startsWith('/api/');
const keep = response => response && (response.ok || response.type === 'opaque');

// What the page loaded before this worker was in charge: copied once, so the
// very first visit is already enough to work offline.
async function cacheAll(urls) {
    const cache = await caches.open(CACHE);
    await Promise.all(urls.map(async raw => {
        const url = new URL(raw, self.location.href);
        if (!/^https?:$/.test(url.protocol) || isApi(url) || await cache.match(url.href)) return;
        const own = url.origin === self.location.origin;
        let response = null;
        try { response = await fetch(url.href, { mode: own ? 'same-origin' : 'cors', credentials: 'omit' }); } catch { /* try once more below */ }
        if (!keep(response) && !own) {
            try { response = await fetch(url.href, { mode: 'no-cors' }); } catch { /* offline: nothing to keep */ }
        }
        if (keep(response)) await cache.put(url.href, response);
    }));
}

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'cache' && Array.isArray(event.data.urls)) event.waitUntil(cacheAll(event.data.urls));
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (!/^https?:$/.test(url.protocol) || isApi(url)) return;

    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE);
            const network = fetch(request).then(response => {
                if (response.ok) cache.put(request, response.clone());
                return response;
            });
            const late = new Promise(resolve => setTimeout(resolve, PAGE_WAIT_MS, null));
            const first = await Promise.race([network.catch(() => null), late]);
            if (first) return first;
            const copy = await cache.match(request, { ignoreSearch: true });
            return copy || network;
        })());
        return;
    }

    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const copy = await cache.match(request);
        const network = fetch(request).then(response => {
            if (keep(response)) cache.put(request, response.clone());
            return response;
        });
        if (copy) { event.waitUntil(network.catch(() => null)); return copy; }
        return network;
    })());
});
