/* Two existing manager subpages share one desktop workspace. On small
 * screens their normal URLs show one pane each, carrying the selected month. */
(function () {
    function mount(el, spot) {
        const A = window.ztimsAcc;
        const params = new URLSearchParams(location.search);
        const queryMonth = params.get('month');
        const validMonth = queryMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(queryMonth);
        let period = (validMonth ? queryMonth : A.manilaToday().slice(0, 7)).split('-').map(Number);
        const active = /resort_register\.html$/.test(location.pathname) ? 'register' : 'report';
        el.classList.add('acc-workspace');
        el.innerHTML = `<nav class="acc-workspace__nav" aria-label="Accommodation reporting"><a data-page="register" class="btn btn-secondary" ${active === 'register' ? 'aria-current="page"' : ''}>Guest Register</a><a data-page="report" class="btn btn-secondary" ${active === 'report' ? 'aria-current="page"' : ''}>Tourist Influx Report</a></nav>
            <div class="acc-workspace__panes"><section class="acc-workspace__register space-y-5" data-pane="register" aria-label="Guest Register"></section><section class="acc-workspace__report space-y-5" data-pane="report" aria-label="Tourist Influx Report"></section></div>`;
        el.dataset.active = active;
        const updateLinks = () => el.querySelectorAll('[data-page]').forEach(a => {
            a.href = `${a.dataset.page === 'register' ? 'resort_register' : 'resort_statistics'}.html?month=${A.monthKey(...period)}`;
        });
        let register, report;
        function sync(y, m, source) {
            period = [y, m];
            const url = new URL(location.href); url.searchParams.set('month', A.monthKey(y, m));
            history.replaceState(null, '', url.pathname + url.search + url.hash);
            updateLinks();
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
        updateLinks();
    }
    (function ready() {
        if (!window.ztimsAcc || !window.ztimsAcc.mountForms || !window.ztimsAccRegister || !window.ztimsAccReport) return setTimeout(ready, 20);
        window.ztimsAccWorkspace = { mount };
    })();
})();
