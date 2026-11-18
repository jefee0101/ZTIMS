/* One manager page; side-by-side records/reports on desktop and an in-page
 * view switch on small screens. The selected enterprise and month are shared. */
(function () {
    function mount(el, spot) {
        const A = window.ztimsAcc;
        const params = new URLSearchParams(location.search);
        const queryMonth = params.get('month');
        const validMonth = queryMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(queryMonth);
        let period = (validMonth ? queryMonth : A.manilaToday().slice(0, 7)).split('-').map(Number);
        const active = params.get('view') === 'report' ? 'report' : 'register';
        el.classList.add('acc-workspace');
        const main = el.closest('main'), header = document.querySelector('body > header');
        if (main && header) {
            const clearHeader = () => { main.style.paddingTop = Math.ceil(header.getBoundingClientRect().height) + 24 + 'px'; };
            clearHeader();
            if (window.ResizeObserver) new ResizeObserver(clearHeader).observe(header);
        }
        el.innerHTML = `<h1 class="text-3xl sm:text-4xl font-black font-headline tracking-tighter text-on-surface">Guest Records and Reports</h1>
            <div class="acc-workspace__nav" role="group" aria-label="Workspace view"><button type="button" data-page="register" class="btn btn-secondary">Records</button><button type="button" data-page="report" class="btn btn-secondary">Reports</button></div>
            <div class="acc-workspace__panes"><section class="acc-workspace__register space-y-5" data-pane="register" aria-label="Guest Register"></section><section class="acc-workspace__report space-y-5" data-pane="report" aria-label="Tourist Influx Report"></section></div>`;
        function selectView(view, updateUrl = false) {
            el.dataset.active = view;
            el.querySelectorAll('[data-page]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.page === view)));
            if (updateUrl) {
                const url = new URL(location.href); url.searchParams.set('view', view);
                history.replaceState(null, '', url.pathname + url.search + url.hash);
            }
        }
        el.querySelectorAll('[data-page]').forEach(button => {
            button.addEventListener('click', () => selectView(button.dataset.page, true));
        });
        selectView(active);
        let register, report;
        function sync(y, m, source) {
            period = [y, m];
            const url = new URL(location.href); url.searchParams.set('month', A.monthKey(y, m));
            history.replaceState(null, '', url.pathname + url.search + url.hash);
            if (source !== 'register' && register) register.setPeriod(y, m);
            if (source !== 'report' && report) report.setPeriod(y, m);
        }
        register = window.ztimsAccRegister.mount(el.querySelector('[data-pane="register"]'), spot, {
            embedded: true, period, onPeriod: sync,
            onChange(y, m) { sync(y, m, 'register'); }
        });
        report = window.ztimsAccReport.mount(el.querySelector('[data-pane="report"]'), spot, {
            period, onPeriod: sync, onSubmitted() { register.refresh(); }
        });
        // The combined page owns the h1; pane titles remain section headings.
        el.querySelectorAll('[data-pane] h1').forEach(old => {
            const title = document.createElement('h2'); title.className = 'text-xl font-bold';
            title.textContent = old.textContent; old.replaceWith(title);
        });
    }
    (function ready() {
        if (!window.ztimsAcc || !window.ztimsAcc.mountForms || !window.ztimsAccRegister || !window.ztimsAccReport) return setTimeout(ready, 20);
        window.ztimsAccWorkspace = { mount };
    })();
})();
