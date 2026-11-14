/* Read-only reviews for the selected manager-owned accommodation enterprise. */
(function () {
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const date = s => new Date(s).toLocaleDateString('en-PH',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Manila'});
    async function start(root) {
        if (!window.ztimsEnterprise) return setTimeout(() => start(root), 50);
        root.innerHTML = '<p role="status" aria-busy="true">Loading reviews…</p>';
        try {
            const response = await fetch('/api/spots?mine=true', {headers:{Authorization:'Bearer '+(localStorage.getItem('authToken') || '')}});
            if (response.status === 401) { location.assign('../staff_login.html?next=resort/resort_reviews.html'); return; }
            if (!response.ok) throw Error('Could not load your enterprises.');
            window.ztimsEnterprise.set(await response.json());
        } catch (error) {
            root.innerHTML = `<p role="alert">${esc(error.message)}</p><button class="btn btn-secondary" id="mrRetryEnterprise">Try again</button>`;
            root.querySelector('#mrRetryEnterprise').addEventListener('click', () => start(root), {once:true});
            return;
        }
        window.ztimsEnterprise.mount(document.getElementById('enterpriseSwitcherSlot'));
        const spot = window.ztimsEnterprise.current();
        if (!spot || spot.type !== 'accommodation') {
            root.innerHTML = `<p>${spot ? 'Reviews are available for accommodation enterprises.' : 'No enterprises available.'}</p><a class="btn btn-secondary" href="resort_enterprises.html">My enterprises</a>`;
            return;
        }
        root.innerHTML = `<p id="mrSummary" class="text-lg font-bold"></p><div class="grid sm:grid-cols-2 gap-3">
            <label><span class="field-label">Rating</span><select id="mrRating" class="field w-full"><option value="">All ratings</option>${[5,4,3,2,1].map(n => `<option value="${n}">${n} ${n === 1 ? 'star' : 'stars'}</option>`).join('')}</select></label>
            <label><span class="field-label">Search</span><input id="mrSearch" type="search" class="field w-full" maxlength="120" placeholder="Search reviews"/></label></div>
            <div id="mrRows" class="glass-panel divide-y divide-outline-variant/30"></div><div class="flex flex-wrap items-center justify-between gap-3"><p id="mrCount" class="text-support"></p><div class="flex gap-2"><button id="mrPrev" class="btn btn-secondary">Previous</button><button id="mrNext" class="btn btn-secondary">Next</button></div></div>`;
        let page = 1, pages = 1, request = 0, timer;
        const previous = root.querySelector('#mrPrev'), next = root.querySelector('#mrNext');
        async function load() {
            const current = ++request;
            previous.disabled = next.disabled = true;
            root.querySelector('#mrRows').innerHTML = '<p class="p-4" role="status" aria-busy="true">Loading reviews…</p>';
            try {
                const params = new URLSearchParams({page:String(page),rating:root.querySelector('#mrRating').value,search:root.querySelector('#mrSearch').value});
                const response = await fetch('/api/reviews/manage/' + encodeURIComponent(spot._id) + '?' + params, {headers:{Authorization:'Bearer '+(localStorage.getItem('authToken') || '')}});
                if (current !== request) return;
                if (response.status === 401) { location.assign('../staff_login.html?next=resort/resort_reviews.html'); return; }
                const data = await response.json();
                if (!response.ok) throw Error(data.message || 'Could not load reviews.');
                if (current !== request) return;
                pages = data.pages;
                root.querySelector('#mrSummary').textContent = data.count ? `${data.average.toFixed(1)} out of 5 · ${data.count} ${data.count === 1 ? 'review' : 'reviews'}` : 'No reviews yet';
                root.querySelector('#mrRows').innerHTML = data.items.length ? data.items.map(r => `<article class="p-4 space-y-2"><div class="flex flex-wrap items-center justify-between gap-2"><b aria-label="${r.rating} out of 5 stars">${'★'.repeat(r.rating)}${'☆'.repeat(5-r.rating)}</b><span class="text-support">${esc(date(r.createdAt))}</span></div><p class="whitespace-pre-wrap break-words">${esc(r.body || 'Rating only')}</p><p class="text-support break-words">${esc(r.author)} · Completed stay</p></article>`).join('') : '<p class="p-5">No reviews match.</p>';
                root.querySelector('#mrCount').textContent = `${data.total} ${data.total === 1 ? 'review' : 'reviews'} · Page ${page} of ${pages}`;
                previous.disabled = page <= 1; next.disabled = page >= pages;
            } catch (error) {
                if (current !== request) return;
                root.querySelector('#mrSummary').textContent = '';
                root.querySelector('#mrCount').textContent = '';
                root.querySelector('#mrRows').innerHTML = `<p class="p-4" role="alert">${esc(error.message)}</p><button class="btn btn-secondary m-4" data-retry>Try again</button>`;
            }
        }
        root.addEventListener('click', event => { if (event.target.closest('[data-retry]')) load(); });
        previous.onclick = () => { if (page > 1) { page--; load(); } };
        next.onclick = () => { if (page < pages) { page++; load(); } };
        root.querySelector('#mrRating').onchange = () => { page = 1; load(); };
        root.querySelector('#mrSearch').oninput = () => { clearTimeout(timer); page = 1; ++request; previous.disabled = next.disabled = true; timer = setTimeout(load,250); };
        load();
    }
    window.ZTIMSManagerReviews = {start};
})();
