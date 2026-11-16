/* Private office messages only. Enterprise reviews live in the manager portal. */
(function () {
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const date = s => new Date(s).toLocaleDateString('en-PH', {day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Manila'});
    const topics = {listing:'Listing information',problem:'Something not working',suggestion:'Suggestion',booking:'Room booking',other:'Other'};
    async function api(path, options = {}) {
        const response = await fetch('/api' + path, {...options, headers:{Authorization:'Bearer ' + (localStorage.getItem('authToken') || ''),'Content-Type':'application/json'}});
        if (response.status === 401) { location.assign('../staff_login.html?next=admin/admin_feedback.html'); throw Error('Please sign in again.'); }
        const data = await response.json();
        if (!response.ok) throw Error(data.message || 'Could not load feedback.');
        return data;
    }
    function start(root) {
        let places = [], messages = [], place = '', status = 'open', search = '', topic = 'all';
        const context = message => {
            try {
                const url = new URL(message.page, location.origin), id = url.searchParams.get('spotId');
                return url.pathname === '/src/spot.html' && places.some(p => p._id === id) ? id : '';
            } catch { return ''; }
        };
        function rows() {
            const items = messages.filter(m => {
                const id = context(m);
                if (place === 'general' ? Boolean(id) : place && id !== place) return false;
                if (status === 'open' ? m.status === 'resolved' : status !== 'all' && m.status !== status) return false;
                if (topic !== 'all' && m.topic !== topic) return false;
                return !search || [m.message,m.name,m.email].some(v => String(v || '').toLowerCase().includes(search.toLowerCase()));
            });
            root.querySelector('#ufRows').innerHTML = items.length ? items.map(m => `<details class="p-4">
                <summary class="cursor-pointer min-h-[44px] flex flex-wrap items-center gap-3"><span class="flex-1 basis-full sm:basis-0 min-w-0"><b class="block">${esc(places.find(p => p._id === context(m))?.title || 'Tourism Office / general')}</b><span class="block truncate">${esc(m.message.slice(0,120))}</span></span><span class="text-support">${esc(date(m.createdAt))} · ${esc(m.status)}</span><span class="text-support">Details ▾</span></summary>
                <div class="space-y-3 pt-3"><p class="whitespace-pre-wrap break-words">${esc(m.message)}</p><p class="text-support break-words">${esc(m.name || 'Anonymous')}${m.email ? ' · ' + esc(m.email) : ''}</p><p class="text-support break-words">Topic: ${esc(topics[m.topic] || 'Other')}${m.page ? ' · Context: ' + esc(context(m) ? 'Attraction page' : m.page) : ''}</p>
                <div class="flex flex-wrap gap-2">${m.status === 'new' ? `<button class="btn btn-secondary" data-state="read" data-id="${esc(m._id)}">Mark read</button>` : ''}<button class="btn btn-secondary" data-state="${m.status === 'resolved' ? 'read' : 'resolved'}" data-id="${esc(m._id)}">${m.status === 'resolved' ? 'Reopen' : 'Mark resolved'}</button></div></div></details>`).join('') : '<p class="p-5">No messages match.</p>';
            root.querySelector('#ufCount').textContent = `${items.length} ${items.length === 1 ? 'message' : 'messages'}`;
        }
        async function load() {
            root.innerHTML = '<p role="status" aria-busy="true">Loading feedback…</p>';
            try {
                const data = await Promise.all([api('/spots'),api('/feedback')]);
                places = data[0].filter(p => p.type === 'spot' && !p.managedBy); messages = data[1];
                root.innerHTML = `<div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <label><span class="field-label">Attraction</span><select class="field w-full" id="ufPlace"><option value="">All office feedback</option><option value="general">Tourism Office / general</option>${places.map(p => `<option value="${esc(p._id)}">${esc(p.title)}</option>`).join('')}</select></label>
                    <label><span class="field-label">Status</span><select class="field w-full" id="ufStatus">${['open','new','read','resolved','all'].map(v => `<option value="${v}">${v[0].toUpperCase()+v.slice(1)}</option>`).join('')}</select></label>
                    <label><span class="field-label">Topic</span><select class="field w-full" id="ufFilter"><option value="all">All topics</option>${Object.entries(topics).map(([v,label]) => `<option value="${v}">${label}</option>`).join('')}</select></label>
                    <label><span class="field-label">Search</span><input class="field w-full" id="ufSearch" type="search" placeholder="Search feedback"/></label></div>
                    <p id="ufError" role="alert" class="text-error" hidden></p><div class="glass-panel divide-y divide-outline-variant/30" id="ufRows"></div><p id="ufCount" class="text-support"></p>`;
                for (const [id,value,update] of [['ufPlace',place,v=>place=v],['ufStatus',status,v=>status=v],['ufFilter',topic,v=>topic=v],['ufSearch',search,v=>search=v]]) {
                    const field = root.querySelector('#'+id); field.value = value;
                    field.addEventListener(id === 'ufSearch' ? 'input' : 'change', e => { update(e.target.value); rows(); });
                }
                rows();
            } catch (error) { root.innerHTML = `<p role="alert">${esc(error.message)}</p><button class="btn btn-secondary" data-retry>Try again</button>`; }
        }
        root.addEventListener('click', async event => {
            const button = event.target.closest('button');
            if (!button) return;
            if (button.hasAttribute('data-retry')) return load();
            if (!button.dataset.state) return;
            const error = root.querySelector('#ufError'); error.hidden = true; button.disabled = true;
            try {
                const result = await api('/feedback/' + encodeURIComponent(button.dataset.id) + '/status', {method:'PATCH',body:JSON.stringify({status:button.dataset.state})});
                messages = messages.map(m => m._id === button.dataset.id ? result.feedback : m); rows();
            } catch (e) { error.textContent = e.message; error.hidden = false; }
            finally { button.disabled = false; }
        });
        load();
    }
    window.ZTIMSFeedback = {start};
})();
