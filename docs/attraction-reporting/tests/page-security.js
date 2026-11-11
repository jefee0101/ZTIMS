// Pages: stored markup in an attraction's name, code and a reopening reason never runs; cross-site requests get no CORS grant; download names are safe. LOCAL only.
// Needs the built site on http://localhost:3000 (npm run build, then ZTIMS_API=http://localhost:8080 npx vite preview --port 3000)
// and the LOCAL API on :8080 with DATABASE_URL pointing at the LOCAL database. Never point it at live data: it clears the attraction_* tables.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const SITE = 'http://localhost:3000/src/', API = 'http://localhost:8080/api', DB = process.env.DATABASE_URL;
const sql = q => execFileSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-Atc', q]).toString().trim();
let pass = 0, fail = 0; const ok = (c, l, x) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l, x === undefined ? '' : String(x).slice(0, 300)); } };
const ip = () => '10.44.' + (1 + Math.floor(Math.random() * 200)) + '.' + (1 + Math.floor(Math.random() * 250));
const call = async (m, p, b, t, extra) => { const r = await fetch(API + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Forwarded-For': ip() }, t ? { Authorization: 'Bearer ' + t } : {}, extra || {}), body: b ? JSON.stringify(b) : undefined }); let d = null; const txt = await r.text(); try { d = JSON.parse(txt); } catch {} return { status: r.status, data: d, headers: r.headers }; };
const login = async (e, p) => (await call('POST', '/login', { email: e, password: p, role: 'staff' })).data;
(async () => {
  const B = sql(`select id from spots where title = 'Test Pool' and type = 'spot' and managed_by is null`);
  const NAME = `<img src=x onerror="window.__xss=1">Pool`;
  sql(`update spots set title = '${NAME.replace(/'/g, "''")}' where id = '${B}'`);
  const off = (await login('officer@lgu.test', 'Mango-Harbor-Tide-89')).token, pool = (await login('pool.staff@lgu.test', 'Coral-Ridge-Lantern-47')).token;
  await call('PUT', `/attraction-visits/${B}/settings`, { attractionCode: '<b>X</b>' }, off);
  const re = await call('POST', `/attraction-visits/${B}/months/2026/10/reopen`, { reason: '<img src=x onerror="window.__xss=2"> logbook fix' }, off);
  ok(re.status === 200, 'the officer reopens with a reason holding markup (stored as text)', JSON.stringify(re.data).slice(0, 200));
  const b = await chromium.launch();
  const page = async (tok, role) => { const c = await b.newContext({ viewport: { width: 1400, height: 1000 } }); let n = 0;
    await c.route('**/api/**', r => r.continue({ headers: Object.assign({}, r.request().headers(), { 'x-forwarded-for': '10.43.' + (1 + n % 200) + '.' + (1 + (n++ % 250)) }) }));
    await c.addInitScript(([t, r]) => { localStorage.setItem('authToken', t); localStorage.setItem('userRole', r); }, [tok, role]);
    const p = await c.newPage(); p.dialogs = 0; p.on('dialog', d => { p.dialogs++; d.dismiss(); }); return p; };
  const s = await page(pool, 'support_staff');
  await s.goto(SITE + 'staff/staff_register.html?month=2026-10'); await s.waitForSelector('.att-day');
  ok((await s.locator('[data-banner]').innerText()).includes('<img src=x onerror="window.__xss=2"> logbook fix'), 'the record shows the reopening reason as text');
  await s.goto(SITE + 'staff/staff_statistics.html?month=2026-10'); await s.waitForSelector('[data-view] .acc-part');
  ok((await s.locator('[data-view] .acc-part').first().innerText()).includes(NAME), 'the report shows the attraction name as text');
  ok(await s.evaluate(() => window.__xss === undefined), 'no stored markup ran on the Support Staff pages');
  const o = await page(off, 'admin');
  await o.goto(SITE + 'admin/admin_statistics.html#attractions'); await o.waitForSelector('.att-track');
  await o.click(`button.att-cellbtn[data-spot="${B}"][data-month="10"]`); await o.waitForSelector('.acc-window .stat-tiles');
  ok((await o.locator('.acc-window').innerText()).includes('logbook fix'), 'the officer\'s review shows the reason');
  await o.click('.acc-window button:has-text("Close")');
  await o.click('[data-sub="monthly"]'); await o.selectOption('[data-subpanel] [data-month]', '2026-10'); await o.waitForSelector('.acc-grid');
  ok((await o.locator('[data-subpanel]').innerText()).includes('<b>X</b>'), 'DTA2M shows the code as text');
  await o.click('[data-sub="annual"]'); await o.waitForSelector('[data-subpanel] table');
  await o.click('[data-sub="issued"]'); await o.waitForTimeout(800);
  ok(await o.evaluate(() => window.__xss === undefined) && o.dialogs === 0 && s.dialogs === 0, 'no stored markup ran on the officer\'s pages');
  await b.close();
  // Downloads: a safe file name whatever the attraction is called; a formula-looking name stays text (checked in check-exports.py).
  const x = await fetch(`${API}/attraction-visits/${B}/months/2026/10/export.xlsx?version=1`, { headers: { Authorization: 'Bearer ' + off, 'X-Forwarded-For': ip() } });
  const cd = x.headers.get('content-disposition') || '';
  ok(x.status === 200 && /^attachment; filename="[A-Za-z0-9_.-]+"$/.test(cd), 'the download name is letters, digits, _ . - only', cd);
  ok(x.headers.get('cache-control') === 'no-store', 'downloads are not cached');
  // Cross-site: the sign-in is a bearer token, never a cookie, so a page elsewhere cannot ride it; the API grants no other origin.
  const cors = await call('GET', '/attraction-visits/tracker?year=2026', null, off, { Origin: 'https://evil.test' });
  ok(!cors.headers.get('access-control-allow-origin'), 'no CORS grant for another site', cors.headers.get('access-control-allow-origin'));
  const pre = await fetch(`${API}/attraction-visits/${B}/days/2026-10-02`, { method: 'OPTIONS', headers: { Origin: 'https://evil.test', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type', 'X-Forwarded-For': ip() } });
  ok(!pre.headers.get('access-control-allow-origin'), 'the browser preflight from another site is refused', pre.status);
  const noAuth = await call('PUT', `/attraction-visits/${B}/days/2026-10-02`, { total: 1, revision: 1, requestKey: 'abcdefgh12' }, null);
  ok(noAuth.status === 401, 'a write with no token (as a cross-site form would send) is refused', noAuth.status);
  // Responses carry no credentials.
  const mv = await call('GET', `/attraction-visits/${B}/months/2026/10`, null, pool);
  ok(!/password|hash|token|secret/i.test(JSON.stringify(mv.data)), 'the month view carries no password, hash, token or secret');
  const err = await call('GET', `/attraction-visits/${B}/months/2026/13`, null, pool);
  ok(err.status === 400 && !/at |\.js:|select |from /i.test(JSON.stringify(err.data)), 'an error answers in words, with no stack or SQL', JSON.stringify(err.data));
  // Restore the local test attraction.
  sql(`update spots set title = 'Test Pool' where id = '${B}'`);
  await call('PUT', `/attraction-visits/${B}/settings`, { attractionCode: 'ZA-02' }, off);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
