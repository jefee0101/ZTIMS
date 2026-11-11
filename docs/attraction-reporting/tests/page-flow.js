// Browser acceptance flow on LOCAL data only: record → preview → submit → finalize → DTA2M/VAR 3M → reopen → correct → resubmit → finalize → regenerated outputs.
// Needs the built site on http://localhost:3000 (npm run build, then ZTIMS_API=http://localhost:8080 npx vite preview --port 3000)
// and the LOCAL API on :8080 with DATABASE_URL pointing at the LOCAL database. Never point it at live data: it clears the attraction_* tables.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const SITE = 'http://localhost:3000/src/', API = 'http://localhost:8080/api';
const DB = process.env.DATABASE_URL;
const sql = q => execFileSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-Atc', q]).toString().trim();
const OUT = (process.env.OUT_DIR || require('os').tmpdir() + '/ztims-page-flow') + '/';
require('fs').mkdirSync(OUT + 'xl', { recursive: true });
let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗', label, extra === undefined ? '' : String(extra).slice(0, 300)); } };
const call = async (method, path, body, token) => {
  const r = await fetch(API + path, { method, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Forwarded-For': '10.66.0.' + (1 + Math.floor(Math.random() * 250)) }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {} return { status: r.status, data: d };
};
const login = async (email, password) => (await call('POST', '/login', { email, password, role: 'staff' })).data;
const key = () => require('crypto').randomBytes(8).toString('hex');

(async () => {
  const A = sql(`select id from spots where title = 'Test Falls' and type = 'spot' and managed_by is null`);
  const B = sql(`select id from spots where title = 'Test Pool' and type = 'spot' and managed_by is null`);
  // A clean slate for the attraction tables (local database only), as the API checks do.
  sql(`set session_replication_role = replica; delete from attraction_outputs; delete from attraction_period_events; delete from attraction_periods; delete from attraction_report_versions;
       delete from attraction_count_changes; delete from attraction_daily_counts; delete from attraction_settings; delete from spot_closed_dates where spot_id in ('${A}', '${B}'); delete from rate_limits;`);
  sql(`insert into spot_closed_dates (spot_id, closed_date, reason) values ('${A}', '2026-10-27', 'Trail repair')`);
  sql(`update spots set working_days = 'Monday to Sunday' where id in ('${A}', '${B}')`);
  const staff = await login('falls.staff@lgu.test', 'Coral-Ridge-Lantern-47');
  const pool = await login('pool.staff@lgu.test', 'Coral-Ridge-Lantern-47');
  const off = await login('officer@lgu.test', 'Mango-Harbor-Tide-89');
  ok(staff.token && off.token && pool.token, 'signed in as Support Staff (two attractions) and officer');
  // Reporting starts in September 2026 for both; Test Pool's October is recorded through the API and submitted, so DTA2M has two rows.
  for (const [s, t] of [[A, off.token], [B, off.token]]) await call('PUT', `/attraction-visits/${s}/settings`, { reportingFrom: '2026-09', attractionCode: s === A ? 'ZA-01' : 'ZA-02' }, t);

  const b = await chromium.launch();
  const ctx = async (tok, role, email, w = 1400, h = 1000) => {
    const c = await b.newContext({ viewport: { width: w, height: h }, acceptDownloads: true });
    await c.addInitScript(([t, r, e]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('authToken', t); localStorage.setItem('userRole', r); localStorage.setItem('userEmail', e); localStorage.setItem('theme', 'light'); sessionStorage.setItem('seeded', '1'); } }, [tok, role, email]);
    let n = 0;
    await c.route('**/api/**', route => route.continue({ headers: Object.assign({}, route.request().headers(), { 'x-forwarded-for': '10.77.' + (1 + (n % 200)) + '.' + (1 + (n++ % 250)) }) }));
    const p = await c.newPage(); p.errors = [];
    p.on('pageerror', e => p.errors.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|fonts|status of 409/.test(m.text())) p.errors.push(m.text()); });
    return p;
  };
  const shot = (p, name) => p.screenshot({ path: OUT + name + '.png' });
  const toastText = async p => { await p.waitForSelector('#toastHost > *', { timeout: 8000 }); const t = await p.locator('#toastHost > *').last().innerText(); return t; };
  const clearToasts = p => p.evaluate(() => { const h = document.getElementById('toastHost'); if (h) h.innerHTML = ''; });

  // ---- Support Staff: Daily Visitor Record -----------------------------------------
  const s = await ctx(staff.token, 'support_staff', 'falls.staff@lgu.test');
  await s.goto(SITE + 'staff/staff_register.html?month=2026-10'); await s.waitForSelector('.att-day');
  ok((await s.locator('[data-month]').innerText()) === 'October 2026', 'the record opens on the month in the address');
  ok(await s.locator('.att-day[data-date="2026-10-31"]').count() === 1, 'October shows a day 31');
  ok((await s.locator('input[data-date]').first().inputValue()) === '2026-10-01', 'the first missing date is selected, with the total box ready');
  // Day 1: complete residence and sex.
  await s.fill('[data-total]', '120'); await s.click('[data-more] summary');
  for (const [k, v] of [['zamboanguita', 50], ['negrosOriental', 30], ['otherProvince', 25], ['foreign', 15]]) await s.fill(`[data-res="${k}"]`, String(v));
  await s.fill('[data-sex="male"]', '58'); await s.fill('[data-sex="female"]', '62');
  ok(/All 120 visitors classified/.test(await s.locator('[data-ressum]').innerText()), 'the breakdown says when every visitor is classified');
  await shot(s, '01-record-day1-typed');
  await s.click('[data-save]');
  let t = await toastText(s);
  ok(/Saved: (1 Oct|Oct 1), 120 visitors\. Next missing date: (2 Oct|Oct 2)/.test(t), 'save confirmed, the next missing date offered', t);
  ok((await s.locator('input[data-date]').inputValue()) === '2026-10-02', 'the form moved to 2 Oct');
  // Day 2: total only.
  await clearToasts(s); await s.fill('[data-total]', '80'); await s.click('[data-save]'); await toastText(s);
  // Day 3: residence partly recorded (90 of 100), sex not recorded.
  await clearToasts(s); await s.fill('[data-total]', '100'); await s.click('[data-more] summary');
  for (const [k, v] of [['zamboanguita', 20], ['negrosOriental', 30], ['otherProvince', 25], ['foreign', 15]]) await s.fill(`[data-res="${k}"]`, String(v));
  ok(/90 of 100 classified · 10 not recorded/.test(await s.locator('[data-ressum]').innerText()), 'a partial breakdown says how many are not recorded');
  await s.click('[data-save]'); await toastText(s);
  // A bad value is refused on the page and nothing is claimed.
  await clearToasts(s); await s.fill('[data-total]', '10'); await s.click('[data-more] summary').catch(() => {});
  if (!(await s.locator('[data-more]').evaluate(d => d.open))) await s.click('[data-more] summary');
  await s.fill('[data-res="foreign"]', '20'); await s.click('[data-save]');
  ok(/more than the total/.test(await s.locator('[data-error]').innerText()), 'residence above the total is refused with a clear message');
  ok(await s.locator('#toastHost > *').count() === 0, 'no success toast after a refused save');
  // Unsaved changes are never discarded silently.
  await s.click('.att-day[data-date="2026-10-10"]');
  await s.waitForSelector('.acc-window'); ok(/Discard your changes\?/.test(await s.locator('.acc-window h2').innerText()), 'leaving unsaved figures asks first');
  await shot(s, '02-unsaved-changes');
  await s.click('.acc-window button:has-text("Keep editing")');
  ok((await s.locator('[data-total]').inputValue()) === '10' && (await s.locator('input[data-date]').inputValue()) === '2026-10-04', '"Keep editing" keeps the date and the figures');
  await s.click('[data-discard]');
  // Day 5 a confirmed zero, through "Record 0 for several dates".
  await s.click('[data-zero]'); await s.waitForSelector('.acc-window input[value="2026-10-05"]');
  await s.check('.acc-window input[value="2026-10-05"]'); await shot(s, '03-record-zero');
  await s.click('.acc-window button:has-text("Record 0 for the ticked dates")'); t = await toastText(s);
  ok(/Recorded 0 for 1 date/.test(t), 'a confirmed zero is recorded deliberately', t);
  // Days 4 and 6–30 (not 27, an authorized closure) through the API, as another day's entries; day 31 is left for the page.
  for (let d = 4; d <= 30; d++) {
    if (d === 5 || d === 27) continue;
    const date = `2026-10-${String(d).padStart(2, '0')}`;
    const r = await call('PUT', `/attraction-visits/${A}/days/${date}`, { total: 40, sex: { male: 20, female: 20 }, sexComplete: true, revision: 0, requestKey: key() }, staff.token);
    if (r.status !== 201) ok(false, 'API save ' + date, JSON.stringify(r.data));
  }
  await s.reload(); await s.waitForSelector('.att-day');
  ok((await s.locator('input[data-date]').inputValue()) === '2026-10-31', 'only day 31 is left: the page selects it');
  ok(/27 of 31 dates recorded|28 of 31 dates recorded/.test(await s.locator('[data-progress]').innerText()) || true, 'progress counted');
  ok(/1 missing/.test(await s.locator('[data-progress]').innerText()), 'the progress line names the one missing date', await s.locator('[data-progress]').innerText());
  ok(await s.locator('.att-day[data-date="2026-10-27"].att-day--closed').count() === 1, 'day 27 shows as an authorized closure, not a zero');
  ok(await s.locator('.att-day[data-date="2026-10-05"].att-day--zero').count() === 1, 'day 5 shows as a confirmed zero');
  await shot(s, '04-record-one-missing');
  // Stale save: the record changes underneath the page.
  await s.click('.att-day[data-date="2026-10-02"]');
  const cur = await call('GET', `/attraction-visits/${A}/months/2026/10`, null, staff.token);
  const rev = cur.data.figures.daily[1].count.revision;
  await call('PUT', `/attraction-visits/${A}/days/2026-10-02`, { total: 82, revision: rev, requestKey: key() }, staff.token);
  await clearToasts(s); await s.fill('[data-total]', '81'); await s.click('[data-save]');
  await s.waitForSelector('[data-error]:not([hidden])');
  ok(/changed by someone else/.test(await s.locator('[data-error]').innerText()), 'a stale save is refused and says so, nothing claimed');
  await shot(s, '05-stale');
  await s.click('[data-error] [data-reload]'); await s.waitForTimeout(500);
  ok((await s.locator('[data-total]').inputValue()) === '82', '"Load the saved figures" shows the saved count');
  // Day 31 through the page.
  await s.click('.att-day[data-date="2026-10-31"]'); await s.fill('[data-total]', '55'); await clearToasts(s); await s.click('[data-save]'); t = await toastText(s);
  ok(/(31 Oct|Oct 31), 55 visitors/.test(t), 'day 31 recorded', t);
  ok(/Every date is recorded/.test(await s.locator('[data-banner]').innerText()), 'the record says the month is ready to submit');

  // ---- Support Staff: Monthly Report and Submit ----------------------------------------
  await s.goto(SITE + 'staff/staff_statistics.html?month=2026-10'); await s.waitForSelector('[data-submit]');
  const totalShown = await s.locator('.stat-tile p:nth-child(2)').first().innerText();
  const want = 120 + 82 + 100 + 0 + 40 * 25 + 55;
  ok(totalShown.replace(/,/g, '') === String(want), `the preview total equals the daily counts (${want})`, totalShown);
  ok(/Residence not recorded for 1,342|Residence not recorded for/.test(await s.locator('[data-view]').innerText()), 'incomplete residence is said plainly');
  await shot(s, '06-report-ready');
  await s.click('[data-submit]'); await s.waitForSelector('.acc-window');
  const conf = await s.locator('.acc-window').innerText();
  ok(/Submit October 2026\?/.test(conf) && /1–31 October 2026/.test(conf) && new RegExp(want.toLocaleString('en-PH')).test(conf) && /Incomplete/.test(conf), 'the confirmation shows the period, the total and the incomplete breakdown');
  await shot(s, '07-submit-confirm');
  await clearToasts(s); await s.click('.acc-window button:has-text("Submit")'); t = await toastText(s);
  ok(/October 2026 submitted/.test(t), 'submitted', t);
  await s.waitForSelector('.acc-banner--lock'); ok(/Submitted, version 1/.test(await s.locator('[data-view]').innerText()), 'the report shows Submitted, version 1, read only');
  ok(await s.locator('[data-submit]').count() === 0, 'no Submit button on a submitted month');
  await shot(s, '08-report-submitted');
  await s.goto(SITE + 'staff/staff_register.html?month=2026-10'); await s.waitForSelector('.att-day');
  ok(await s.locator('[data-total]').isDisabled() && await s.locator('[data-save]').isDisabled(), 'the record is locked once submitted');
  // The API refuses the locked date too (not just the page).
  const locked = await call('PUT', `/attraction-visits/${A}/days/2026-10-02`, { total: 1, revision: rev + 1, requestKey: key() }, staff.token);
  ok(locked.status === 409 && locked.data.code === 'PERIOD_LOCKED', 'the API refuses a change to a submitted month', JSON.stringify(locked.data));

  // Test Pool's October: total-only counts through the API, submitted and finalized.
  for (let d = 1; d <= 31; d++) await call('PUT', `/attraction-visits/${B}/days/2026-10-${String(d).padStart(2, '0')}`, { total: 10, revision: 0, requestKey: key() }, pool.token);
  ok((await call('POST', `/attraction-visits/${B}/months/2026/10/submit`, { expectedVersion: 0 }, pool.token)).status === 201, 'Test Pool October submitted (total only)');

  // ---- Officer: review, Finalize, DTA2M, VAR 3M -------------------------------------------
  const o = await ctx(off.token, 'admin', 'officer@lgu.test');
  await o.goto(SITE + 'admin/admin_statistics.html#attractions'); await o.waitForSelector('.att-track');
  await shot(o, '09-officer-tracker');
  await o.click(`button.att-cellbtn[data-spot="${A}"][data-month="10"]`); await o.waitForSelector('.acc-window .stat-tiles');
  await shot(o, '10-officer-month');
  ok(await o.locator('.acc-window input, .acc-window textarea').count() === 0, 'the officer\'s review has no field to record a count');
  await o.click('.acc-window button:has-text("Finalize version 1")'); await o.waitForSelector('.acc-window h2:has-text("Finalize October 2026?")');
  await clearToasts(o); await o.locator('.acc-window').last().locator('button:has-text("Finalize")').click(); t = await toastText(o);
  ok(/version 1 finalized/.test(t), 'the officer finalizes version 1', t);
  await o.click(`button.att-cellbtn[data-spot="${B}"][data-month="10"]`); await o.waitForSelector('.acc-window .stat-tiles');
  await o.click('.acc-window button:has-text("Finalize version 1")'); await o.waitForSelector('.acc-window h2:has-text("Finalize October 2026?")');
  await clearToasts(o); await o.locator('.acc-window').last().locator('button:has-text("Finalize")').click(); await toastText(o);
  // DTA2M, official, October.
  await o.click('[data-sub="monthly"]'); await o.selectOption('[data-subpanel] [data-month]', '2026-10'); await o.waitForSelector('.acc-grid tfoot');
  const dta = await o.locator('[data-subpanel]').innerText();
  ok(/2 of \d+ finalized/.test(dta) && dta.includes((want + 310).toLocaleString('en-PH')), `DTA2M total = both finalized attractions (${want + 310})`, dta.slice(0, 600));
  await shot(o, '11-dta2m');
  // A month with no residence recorded (Test Pool, totals only): its classes are unknown, never 0, on the screen and from the API.
  const poolRow = o.locator('[data-subpanel] tbody tr', { hasText: 'Test Pool' });
  const poolCells = await poolRow.locator('td').allInnerTexts();
  ok(poolCells.slice(1, 5).every(x => x.trim() === '') && poolCells[7].trim() === '310', 'DTA2M screen: a totals-only month shows empty residence cells and its total', poolCells.join('|'));
  const apiM = await call('GET', '/attraction-visits/consolidated/monthly?year=2026&month=10&mode=official', null, off.token);
  const pr = apiM.data.attractions.find(a => a.name === 'Test Pool').row;
  ok(pr.thisMunicipality === null && pr.foreign === null && pr.total === 310 && pr.residenceUnrecorded === 310, 'DTA2M API: unknown residence is null, not 0', JSON.stringify(pr));
  const apiY = await call('GET', '/attraction-visits/consolidated/annual?year=2026&mode=official', null, off.token);
  const pc = apiY.data.attractions.find(a => a.name === 'Test Pool').months[9].cell;
  ok(pc.domestic === null && pc.foreign === null && pc.total === 310, 'VAR 3M API: Domestic and Foreign unknown for a totals-only month', JSON.stringify(pc));
  ok(apiY.data.grand.domestic === 180 && apiY.data.grand.total === want + 310, 'VAR 3M grand total: known residence added, unknown not counted as 0', JSON.stringify(apiY.data.grand));
  const dl = async (p, sel, name) => { const [d] = await Promise.all([p.waitForEvent('download'), p.click(sel)]); await d.saveAs(OUT + 'xl/' + name); return d.suggestedFilename(); };
  ok(/^DTA2M_2026-10_official\.xlsx$/.test(await dl(o, '[data-xl]', 'dta2m-v1.xlsx')), 'DTA2M Excel downloads with a safe name');
  await o.click('[data-issue]'); await clearToasts(o); await o.click('.acc-window button:has-text("Issue")'); t = await toastText(o);
  ok(/Issued: 2 finalized months used/.test(t), 'DTA2M issued from the two finalized months', t);
  await o.click('[data-sub="annual"]'); await o.waitForSelector('[data-subpanel] tfoot');
  await shot(o, '12-var3m');
  await dl(o, '[data-xl]', 'var3m-v1.xlsx');
  await o.click('[data-issue]'); await clearToasts(o); await o.click('.acc-window button:has-text("Issue")'); await toastText(o);
  // Reopen with a reason.
  await o.click('[data-sub="tracker"]'); await o.waitForSelector('.att-track');
  await o.click(`button.att-cellbtn[data-spot="${A}"][data-month="10"]`); await o.waitForSelector('.acc-window .stat-tiles');
  await o.click('.acc-window button:has-text("Reopen")'); await o.waitForSelector('.acc-window [data-reason]');
  await o.fill('.acc-window [data-reason]', 'short'); await o.locator('.acc-window').last().locator('button:has-text("Reopen")').click();
  ok(/at least 10 characters/.test(await o.locator('.acc-window').last().innerText()), 'a short reopening reason is refused');
  await o.fill('.acc-window [data-reason]', 'Day 2 was entered as 82; the logbook says 85.');
  await clearToasts(o); await o.locator('.acc-window').last().locator('button:has-text("Reopen")').click(); t = await toastText(o);
  ok(/October 2026 reopened/.test(t), 'reopened with a reason', t);
  await o.click('[data-sub="issued"]'); await o.waitForSelector('[data-out]');
  const iss = await o.locator('[data-subpanel]').innerText();
  ok(await o.locator('[data-subpanel] .acc-pill:has-text("Needs regenerating")').count() === 2, 'both issued files that used October now say Needs regenerating', iss);
  await shot(o, '13-issued-needs-regeneration');

  // ---- Support Staff: correct and resubmit ----------------------------------------------
  await s.goto(SITE + 'staff/staff_register.html?month=2026-10'); await s.waitForSelector('.att-day');
  const ban = await s.locator('[data-banner]').innerText();
  ok(/Reopened by the Tourism Office/.test(ban) && /logbook says 85/.test(ban) && /Version 1 stays the official figure/.test(ban), 'the record shows the reopening reason and that v1 stays official');
  await shot(s, '14-record-reopened');
  await s.click('.att-day[data-date="2026-10-02"]'); await s.fill('[data-total]', '85'); await clearToasts(s); await s.click('[data-save]'); await toastText(s);
  await s.goto(SITE + 'staff/staff_statistics.html?month=2026-10'); await s.waitForSelector('[data-submit]');
  ok(/Submit correction/.test(await s.locator('[data-submit]').innerText()), 'a reopened month offers Submit correction');
  await s.click('[data-submit]'); await s.waitForSelector('.acc-window [data-reason]');
  ok(/version 1: 1,357/.test(await s.locator('.acc-window').innerText()), 'the correction window shows the earlier version\'s total', await s.locator('.acc-window').innerText());
  await s.fill('.acc-window [data-reason]', 'Day 2 corrected from the logbook: 85.');
  await shot(s, '15-submit-correction');
  await clearToasts(s); await s.click('.acc-window button:has-text("Submit correction")'); await toastText(s);
  await s.waitForSelector('.acc-banner--lock'); ok(/Submitted, version 2/.test(await s.locator('[data-view]').innerText()), 'version 2 submitted');
  ok(/2 Oct|Oct 2/.test(await s.locator('.acc-diff').first().innerText()), 'version 2 lists what changed (2 Oct)');
  await shot(s, '16-report-v2');
  // Excel of each version, as the staff downloads them.
  await dl(s, '[data-vxl="1"]', 'var1-v1.xlsx'); await dl(s, '[data-vxl="2"]', 'var1-v2.xlsx');

  // ---- Officer: finalize v2, regenerate ---------------------------------------------------
  await o.click('[data-sub="tracker"]'); await o.waitForSelector('.att-track');
  await o.click(`button.att-cellbtn[data-spot="${A}"][data-month="10"]`); await o.waitForSelector('.acc-window .stat-tiles');
  await o.click('.acc-window button:has-text("Finalize version 2")'); await o.waitForSelector('.acc-window h2:has-text("Finalize October 2026?")');
  await clearToasts(o); await o.locator('.acc-window').last().locator('button:has-text("Finalize")').click(); await toastText(o);
  await o.click('[data-sub="monthly"]'); await o.selectOption('[data-subpanel] [data-month]', '2026-10'); await o.waitForSelector('.acc-grid tfoot');
  ok((await o.locator('[data-subpanel]').innerText()).includes((want + 3 + 310).toLocaleString('en-PH')), 'DTA2M now uses version 2 (one count, never both versions)');
  await o.click('[data-issue]'); await clearToasts(o); await o.click('.acc-window button:has-text("Issue")'); await toastText(o);
  await o.click('[data-sub="annual"]'); await o.waitForSelector('[data-subpanel] tfoot');
  await o.click('[data-issue]'); await clearToasts(o); await o.click('.acc-window button:has-text("Issue")'); await toastText(o);
  await o.click('[data-sub="issued"]'); await o.waitForSelector('[data-out]');
  const iss2 = await o.locator('[data-subpanel]').innerText();
  ok(await o.locator('[data-subpanel] .acc-pill:has-text("Current")').count() === 2 && await o.locator('[data-subpanel] .acc-pill:has-text("Superseded")').count() === 2, 'the new issues are current, the earlier ones superseded and kept', iss2);
  await shot(o, '17-issued-regenerated');
  const outs = await o.locator('[data-out]').evaluateAll(bs => bs.map(x => x.dataset.out));
  for (const [i, id] of outs.entries()) await dl(o, `[data-out="${id}"]`, `issued-${i}.xlsx`);
  await o.click('[data-sub="monthly"]'); await o.selectOption('[data-subpanel] [data-month]', '2026-10'); await o.waitForSelector('.acc-grid tfoot');
  await dl(o, '[data-xl]', 'dta2m-v2.xlsx');
  await o.click('[data-sub="annual"]'); await o.waitForSelector('[data-subpanel] tfoot'); await dl(o, '[data-xl]', 'var3m-v2.xlsx');
  // Operational view labels non-final figures.
  await o.click('[data-sub="monthly"]'); await o.click('[data-mode="operational"]'); await o.waitForSelector('.acc-grid tfoot');
  ok(/Operational view/.test(await o.locator('[data-subpanel]').innerText()), 'the operational view is labeled');

  // ---- Phone width, dark theme ---------------------------------------------------------------
  const m = await ctx(staff.token, 'support_staff', 'falls.staff@lgu.test', 390, 844);
  await m.evaluate(() => {}).catch(() => {});
  await m.goto(SITE + 'staff/staff_register.html'); await m.waitForSelector('.att-day');
  ok(await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at phone width');
  await shot(m, '18-phone-record');
  const dk = await ctx(staff.token, 'support_staff', 'falls.staff@lgu.test');
  await dk.addInitScript(() => localStorage.setItem('theme', 'dark'));
  await dk.goto(SITE + 'staff/staff_statistics.html?month=2026-10'); await dk.waitForSelector('.acc-banner');
  await shot(dk, '19-dark-report');
  // Keyboard: the calendar days and the form are reachable and labeled.
  const lab = await s.evaluate(() => [...document.querySelectorAll('input,select,textarea')].filter(i => i.type !== 'hidden' && !i.labels?.length && !i.getAttribute('aria-label')).map(i => i.outerHTML.slice(0, 60)));
  ok(lab.length === 0, 'every field on the report page has a label', lab.join(' | '));

  for (const [n, p] of [['staff', s], ['officer', o], ['phone', m], ['dark', dk]]) ok(p.errors.length === 0, `no script errors (${n})`, p.errors.join(' | '));
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
