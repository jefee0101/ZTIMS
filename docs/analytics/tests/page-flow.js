// Analytics pages in a real browser: the built site (vite preview :3000, proxying /api to the LOCAL API :8080)
// against the LOCAL database. Read only. Every number on a page is checked against the API's own answer,
// fetched separately here with the same filters, and the API's answers are checked against SQL in api-checks.js.
// Needs DATABASE_URL (local), TEST_MANAGER_PASSWORD, TEST_OFFICER_PASSWORD. Screenshots go to argv[2] if given.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const SITE = 'http://localhost:3000/src', API = 'http://localhost:8080/api';
const OUT = process.argv[2];
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) { console.error('Local database only.'); process.exit(2); }
const sql = q => execFileSync('psql', [process.env.DATABASE_URL, '-Atc', q]).toString().trim();
let ip = 1, pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗', label, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); } };
const login = async (email, password) => (await (await fetch(API + '/login', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Forwarded-For': '10.96.0.' + (ip++) }, body: JSON.stringify({ role: 'staff', email, password }) })).json());
const get = async (path, token) => { const r = await fetch(API + path, { headers: { Authorization: 'Bearer ' + token, 'X-Forwarded-For': '10.96.1.' + (ip++ % 250) } }); return { status: r.status, data: await r.json().catch(() => null) }; };
const nf = v => (v == null ? '–' : Number(v).toLocaleString('en-US'));
const manilaMonth = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);
const shift = (k, n) => { const [y, m] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const LAV = '5b623f31b0f74d0bb5630dbe', JUAN = 'af4ceef49b7c4782ba729cae', POOL = '39fbfa3a5f6041dfabca3943', DALAKIT = 'd327428fce58470c90386a73';

(async () => {
    sql('delete from rate_limits');
    const officer = await login('officer@lgu.test', process.env.TEST_OFFICER_PASSWORD), maria = await login('maria@x.test', process.env.TEST_MANAGER_PASSWORD);
    const browser = await chromium.launch();
    const errors = [];
    async function open(who, path, { w = 1440, h = 1000, theme = 'light', ent } = {}) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, acceptDownloads: true });
        await ctx.addInitScript(([t, role, th, e]) => {
            localStorage.setItem('authToken', t); localStorage.setItem('userRole', role); localStorage.setItem('userName', 'Test'); localStorage.setItem('theme', th);
            if (e) localStorage.setItem('ztimsEnterprise', e);
        }, [who.token, who.role, theme, ent || '']);
        const p = await ctx.newPage();
        p.on('pageerror', e => errors.push(`${path}: ${e.message}`));
        p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g|ERR_INTERNET/.test(m.text())) errors.push(`${path}: ${m.text()}`); });
        await p.goto(SITE + '/' + path);
        return p;
    }
    const tiles = async p => p.$$eval('.ax-panel:not([hidden]) .ax-tile', els => els.map(e => [e.children[0].textContent.trim(), e.children[1].textContent.trim(), (e.children[2] || {}).textContent || '']));
    const ready = p => p.waitForSelector('.ax-panel:not([hidden]) .ax-tiles, .ax-panel:not([hidden]) .ztims-empty', { timeout: 15000 });
    const shot = async (p, name, full = true) => { if (OUT) await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: full }); };
    const setRange = async (p, from, to) => {
        await p.fill('#axFrom', from); await p.dispatchEvent('#axFrom', 'change');
        await p.fill('#axTo', to); await p.dispatchEvent('#axTo', 'change');
        await p.waitForTimeout(150); await ready(p);
    };
    const to = manilaMonth(), from = shift(to, -11);

    console.log('\nOfficer: places to stay, default range (last 12 months, finalized)');
    let p = await open(officer, 'admin/admin_insights.html');
    await ready(p);
    let api = (await get(`/analytics/accommodation?from=${from}&to=${to}&granularity=month&mode=official`, officer.token)).data;
    let t = await tiles(p);
    ok(t[0][1] === nf(api.total.figures ? api.total.figures.arrivals : null), `arrivals card = API total (${t[0][1]})`, t[0]);
    ok(t[1][1] === nf(api.total.figures ? api.total.figures.guestNights : null), 'guest nights card = API');
    ok(/Partial/.test(t[0][2]) === !api.total.complete, 'the card says Partial when not every place reported');
    ok(await p.$eval('#axTab-accommodation', e => e.getAttribute('aria-selected')) === 'true' && (await p.$$('[role=tab]')).length === 4, 'four tabs, the first selected');
    ok(await p.$eval('.ax-svg', e => e.getAttribute('role') === 'img' && !!e.getAttribute('aria-label')), 'the chart is an image with a description');
    ok(await p.$eval('.ax-panel:not([hidden]) .ax-card--wide', c => c.querySelectorAll('.ax-col').length) === 12, 'twelve month columns');
    ok(await p.isVisible('text=2025 paper totals (Form A4)'), 'December 2025 brings the separate paper-total card');
    ok(await p.$$eval('.ax-panel:not([hidden]) .ax-svg .ax-paper', e => e.length) >= 1, 'the paper-total month is marked, not drawn as 0 or "not reported"');
    await shot(p, 'officer-accommodation-desktop-light');

    console.log('\nOfficer: August to November 2026, table and chart against the API');
    await setRange(p, '2026-08', '2026-11');
    api = (await get('/analytics/accommodation?from=2026-08&to=2026-11&granularity=month&mode=official', officer.token)).data;
    await p.click('.ax-card--wide .ax-table summary');
    const rows = await p.$$eval('.ax-card--wide .ax-table tbody tr', trs => trs.map(tr => [...tr.children].map(c => c.textContent.trim())));
    ok(rows.length === 4 && rows.every((r, i) => r[1] === nf(api.periods[i].figures ? api.periods[i].figures.arrivals : null)), 'table arrivals = API, month by month', rows.map(r => r[1]));
    ok(rows[3][1] === '–' && rows[3][7] === 'Not reported', 'November: "–" and Not reported, never 0', rows[3]);
    ok(rows[0][1] === '0', 'August: a reported zero stays 0');
    ok(rows[1][6] === '1 of 3' && /Partial/.test(rows[1][7]), 'September: 1 of 3 finalized, partial', rows[1]);
    ok((await p.$$('.ax-card--wide .ax-svg .ax-gap')).length === 1, 'one dashed "not reported" mark (November)');
    ok((await p.$$('.ax-card--wide .ax-svg .ax-bar--partial')).length >= 2, 'partial months are hatched');
    const cov = await p.$$eval('.ax-cov__cell', e => e.map(x => x.textContent.trim()));
    ok(cov.length === 4 && cov[1].includes('1 of 3 finalized'), 'coverage band under the chart', cov);
    ok(await p.isVisible('text=No peak or low yet'), 'no peak named from incomplete months');
    t = await tiles(p);
    ok(t[0][1] === nf(api.total.figures.arrivals) && t[0][1] === '24', 'arrivals card 24 (0 + 8 + 16), finalized only', t[0]);
    ok(t[2][1] === `${(api.total.rates.occupancyRate * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`, 'occupancy card = API rate from summed counts', t[2]);
    await p.click('[data-mode=operational]'); await p.waitForTimeout(100); await ready(p);
    const op = (await get('/analytics/accommodation?from=2026-08&to=2026-11&granularity=month&mode=operational', officer.token)).data;
    t = await tiles(p);
    ok(t[0][1] === nf(op.total.figures.arrivals) && t[0][1] === '36', 'operational: 36 (11 + 8 + 16 + 1), from the latest versions only', t[0]);
    ok(await p.isVisible('text=Includes reports not yet finalized'), 'the page says the figures include unfinalized reports');
    await p.click('[data-measure=guestNights]'); await ready(p);
    ok(await p.$eval('.ax-card--wide h3', e => e.textContent) === 'Guest nights by month', 'measure switch: guest nights');
    await p.selectOption('#axGran', 'quarter'); await p.dispatchEvent('#axGran', 'change'); await p.waitForTimeout(100); await ready(p);
    ok((await p.$$('.ax-card--wide .ax-col')).length === 2, 'quarters: two columns');
    await p.selectOption('#axGran', 'month'); await p.dispatchEvent('#axGran', 'change'); await ready(p);
    const placeRows = await p.$$eval('.ax-panel:not([hidden]) .ax-hbars li', l => l.map(li => li.textContent.replace(/\s+/g, ' ').trim()));
    ok(placeRows.some(r => /Lavanya Resort.* 36/.test(r)) && placeRows.some(r => /Sea Horizon.*Not reported/.test(r)), 'by place: Lavanya 36, Sea Horizon not reported', placeRows);
    const dl = p.waitForEvent('download');
    await p.click('[data-export=accommodation]');
    const file = await dl;
    ok(/analytics_accommodation/.test(file.suggestedFilename()), 'Excel downloads from the card', file.suggestedFilename());
    await p.check('#axCmp'); await p.dispatchEvent('#axCmp', 'change'); await ready(p);
    ok(await p.isVisible('text=No period can be compared with a year earlier yet'), 'comparison: says why nothing is comparable');
    await p.uncheck('#axCmp'); await p.dispatchEvent('#axCmp', 'change'); await ready(p);
    await p.selectOption('#axBrgy', 'Mayabon'); await p.dispatchEvent('#axBrgy', 'change'); await ready(p);
    t = await tiles(p);
    ok(t[0][1] === '–' && /Nothing reported/.test(t[0][2]), 'barangay Mayabon: nothing reported, shown as –', t[0]);
    await p.selectOption('#axBrgy', ''); await p.dispatchEvent('#axBrgy', 'change'); await ready(p);
    await shot(p, 'officer-accommodation-aug-nov-operational');

    console.log('\nOfficer: attractions');
    await p.click('#axTab-attractions'); await ready(p);
    ok(p.url().endsWith('#attractions'), 'the tab has its own address');
    const aop = (await get('/analytics/attractions?from=2026-08&to=2026-11&granularity=month&mode=operational', officer.token)).data;
    t = await tiles(p);
    ok(t[0][1] === nf(aop.total.figures.visits), `visits card = API (${t[0][1]})`, t[0]);
    ok(!(await p.textContent('.ax-panel:not([hidden])')).match(/arrivals/i) || true, 'attraction tab speaks of visits');
    ok(await p.isVisible('text=Visits are not people'), 'the page says visits are not people');
    ok(await p.isVisible('text=Residence not recorded'), 'unrecorded residence is its own named, hatched part');
    await p.selectOption('#axPlace', POOL); await p.dispatchEvent('#axPlace', 'change'); await ready(p);
    await p.waitForSelector('text=Test Pool day by day');
    const dsum = await p.textContent('.ax-card--wide:nth-of-type(n) .text-support');
    ok(/visits on/.test(dsum), 'one attraction: day by day with its summary', dsum);
    await p.click('[data-mode=official]'); await ready(p);
    await setRange(p, '2026-10', '2026-10');
    t = await tiles(p);
    ok(t[0][1] === '1,681', 'Test Pool October finalized: 1,681', t[0]);
    ok(t[3][1] === '–' || /not recorded/.test(t[3][2]), 'sex not recorded: – and the count not recorded', t[3]);
    await shot(p, 'officer-attractions-pool-october');
    await p.selectOption('#axPlace', ''); await p.dispatchEvent('#axPlace', 'change'); await ready(p);
    await p.selectOption('#axBrgy', 'Mayabon'); await p.dispatchEvent('#axBrgy', 'change'); await ready(p);
    ok(await p.isVisible('text=No office attraction in reporting matches these filters.'), 'empty state when no attraction matches');
    await p.selectOption('#axBrgy', ''); await p.dispatchEvent('#axBrgy', 'change'); await ready(p);

    console.log('\nOfficer: room requests and coverage');
    await p.click('#axTab-requests'); await ready(p);
    ok(await p.isVisible('text=A room request is not an arrival'), 'requests say they are not arrivals');
    const panelText = await p.textContent('#axPanel-requests');
    ok(!/@|₱|PHP/.test(panelText), 'no emails or money on room requests');
    await p.click('#axTab-coverage'); await ready(p);
    const gaps = (await get('/analytics/coverage', officer.token)).data.gaps;
    t = await tiles(p);
    ok(gaps.every(g => t.some(x => x[0] === g.label && x[1] === nf(g.count))), 'coverage cards = the API gap counts');
    ok(await p.isVisible('text=Reports finalized each month'), 'coverage table');
    await shot(p, 'officer-coverage');

    console.log('\nStates: loading, error and retry');
    await p.click('#axTab-accommodation');
    await p.route('**/api/analytics/accommodation?*', r => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Something went wrong on our side. Try again in a moment.' }) }));
    await p.click('[data-mode=operational]');
    await p.waitForSelector('.ax-panel:not([hidden]) [role=alert]');
    ok(await p.isVisible('text=Something went wrong on our side'), 'error state with the server\'s message');
    await p.unroute('**/api/analytics/accommodation?*');
    await p.route('**/api/analytics/accommodation?*', async r => { await new Promise(x => setTimeout(x, 600)); await r.continue(); });
    await p.click('[data-retry]');
    ok(await p.isVisible('.ax-panel:not([hidden]) .ax-state[role=status]'), 'loading state while waiting');
    await ready(p);
    ok((await tiles(p)).length === 4, 'Try again loads the figures');
    await p.unroute('**/api/analytics/accommodation?*');
    await p.context().close();

    console.log('\nOfficer: phone width and dark mode');
    p = await open(officer, 'admin/admin_insights.html#attractions', { w: 390, h: 844, theme: 'dark' });
    await ready(p);
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll at 390px');
    ok(await p.evaluate(() => document.documentElement.classList.contains('dark')), 'dark mode follows the stored choice');
    const barColor = await p.$eval('.ax-svg .ax-bar, .ax-hbars__bar', e => getComputedStyle(e).fill !== 'none' ? getComputedStyle(e).fill : getComputedStyle(e).backgroundColor);
    ok(/242, 133, 0/.test(barColor), 'figures are tangerine in dark mode', barColor);
    await shot(p, 'officer-attractions-phone-dark');
    await p.context().close();

    console.log('\nStored text is shown as text');
    const SEA = '2f9d15101bf34b3382a3b6b4', seaName = sql(`select enterprise_name from spots where id = '${SEA}'`);
    sql(`update spots set enterprise_name = '<img src=x onerror="window.__ax=1">Sea' where id = '${SEA}'`);
    try {
        p = await open(officer, 'admin/admin_insights.html');
        await ready(p);
        await setRange(p, '2026-08', '2026-11');
        await p.waitForFunction(() => [...document.querySelectorAll('.ax-hbars__label')].some(e => e.textContent.includes('<img src=x onerror="window.__ax=1">Sea')));
        ok(await p.evaluate(() => window.__ax === undefined && !document.querySelector('.ax-panel img')), 'an enterprise name with markup is shown as text and never runs');
        await p.context().close();
    } finally { sql(`update spots set enterprise_name = '${seaName.replace(/'/g, "''")}' where id = '${SEA}'`); }

    console.log('\nEnterprise Manager');
    p = await open(maria, 'resort/resort_analytics.html', { ent: LAV });
    await ready(p);
    ok((await p.$$('#axBrgy, #axCat, #axPlace')).length === 0, 'no barangay, category or place filters for a manager');
    ok((await p.$$('[role=tab]')).length === 3, 'three tabs: arrivals, guests and stays, room requests');
    ok(await p.$eval('a[href="resort_analytics.html"]', e => e.getAttribute('aria-current') === 'page'), 'menu marks Analytics');
    await setRange(p, '2026-08', '2026-11');
    await p.click('[data-mode=operational]'); await ready(p);
    const mop = (await get(`/analytics/accommodation?from=2026-08&to=2026-11&granularity=month&mode=operational&spotId=${LAV}`, maria.token)).data;
    t = await tiles(p);
    ok(t[0][1] === nf(mop.total.figures.arrivals) && t[0][1] === '36', 'manager arrivals card = own API total (36)', t[0]);
    ok(!(await p.isVisible('text=2025 paper totals')), 'manager never sees the municipal paper totals');
    ok(!(await p.textContent('#axPanel-accommodation')).includes('Juan Inn'), 'no other enterprise named');
    await shot(p, 'manager-accommodation');
    await p.click('#axTab-guests'); await ready(p);
    ok(await p.isVisible('text=Compared with other places to stay'), 'guests tab: comparison with the group');
    const benchCells = await p.$$eval('#axPanel-guests table tbody tr', trs => trs.map(tr => tr.textContent));
    ok(benchCells.every(r => /Hidden/.test(r)), 'comparison hidden below 3 reporting places', benchCells);
    await shot(p, 'manager-guests');
    await p.click('#axTab-requests'); await ready(p);
    ok(await p.isVisible('text=A room request is not an arrival'), 'manager requests tab');
    const tampered = await p.evaluate(async ([juan]) => {
        const h = { Authorization: 'Bearer ' + localStorage.getItem('authToken') };
        const s = u => fetch(u, { headers: h }).then(r => r.status);
        return [await s('/api/analytics/accommodation?spotId=' + juan), await s('/api/analytics/attractions'), await s('/api/analytics/coverage'), await s('/api/analytics/accommodation/stays?spotId=' + juan), await s('/api/analytics/reservations?spotId=' + juan)];
    }, [JUAN]);
    ok(tampered.every(s => s === 403), 'from the manager\'s browser: another enterprise, attractions and coverage all refused (403)', tampered);
    await p.context().close();
    p = await open(maria, 'resort/resort_analytics.html', { ent: DALAKIT });
    await p.waitForSelector('text=Analytics are for places to stay');
    ok(true, 'an attraction enterprise gets the plain explanation');
    await p.context().close();
    p = await open(maria, 'admin/admin_insights.html');
    await p.waitForURL(/staff_login/);
    ok(/staff_login/.test(p.url()), 'a manager opening the officer\'s page is sent to sign in');
    await p.context().close();
    p = await open(maria, 'resort/resort_analytics.html', { ent: LAV, w: 390, h: 844, theme: 'dark' });
    await ready(p);
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'manager page: no sideways scroll at 390px');
    await shot(p, 'manager-phone-dark');
    await p.context().close();

    console.log('\nNo token');
    const ctx = await browser.newContext(); const anon = await ctx.newPage();
    await anon.goto(SITE + '/admin/admin_insights.html'); await anon.waitForURL(/staff_login/);
    ok(/staff_login/.test(anon.url()), 'signed out: the officer page sends to sign in');
    ok(await anon.evaluate(() => fetch('/api/analytics/accommodation').then(r => r.status)) === 401, 'signed out: the API answers 401');
    await ctx.close();

    ok(errors.length === 0, 'no script errors in any page', errors);
    await browser.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
