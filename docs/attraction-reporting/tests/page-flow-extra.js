// Attraction pages, extra acceptance checks through real API calls on a LOCAL API and database only:
// year boundary, a change of Support Staff, an attraction switched off, and agreement of daily counts,
// the monthly report, DTA2M, VAR 3M and the Excel cells. Run after page-flow.js (it uses October 2026 as that run left it).
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const bcrypt = require('../../../zamboanguita-backend/node_modules/bcryptjs');
const ExcelJS = require('../../../zamboanguita-backend/node_modules/exceljs');
const API = 'http://localhost:8080/api', DB = process.env.DATABASE_URL;
const sql = q => execFileSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-Atc', q]).toString().trim();
let pass = 0, fail = 0; const ok = (c, l, x) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l, x === undefined ? '' : String(x).slice(0, 300)); } };
const ip = () => '10.33.' + (1 + Math.floor(Math.random() * 200)) + '.' + (1 + Math.floor(Math.random() * 250));
const call = async (m, p, b, t) => { const r = await fetch(API + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Forwarded-For': ip() }, t ? { Authorization: 'Bearer ' + t } : {}), body: b ? JSON.stringify(b) : undefined });
  const buf = Buffer.from(await r.arrayBuffer()); let d = null; try { d = JSON.parse(buf.toString()); } catch {} return { status: r.status, data: d, buf }; };
const login = async (e, p) => (await call('POST', '/login', { email: e, password: p, role: 'staff' })).data;
const key = () => crypto.randomBytes(8).toString('hex');
const cellsOf = async buf => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };
const num = c => (c && c.value && typeof c.value === 'object' && 'result' in c.value ? c.value.result : c ? c.value : null);
(async () => {
  const A = sql(`select id from spots where title = 'Test Falls' and type = 'spot' and managed_by is null`);
  const C = sql(`select id from spots where title = 'Peace Statue' and type = 'spot' and managed_by is null`);
  const PW = 'Coral-Ridge-Lantern-47';
  const off = (await login('officer@lgu.test', 'Mango-Harbor-Tide-89')).token;
  let staff = (await login('falls.staff@lgu.test', PW)).token;

  console.log('Agreement: daily counts = monthly report = DTA2M = VAR 3M = Excel cells');
  const m = (await call('GET', `/attraction-visits/${A}/months/2026/10`, null, staff)).data;
  const daily = m.figures.daily.reduce((a, d) => a + (d.count ? d.count.total : 0), 0);
  const v2 = m.versions.find(x => x.version === 2);
  ok(daily === m.figures.total && v2 && v2.figures.total === daily, `daily counts ${daily} = live month = version 2`, JSON.stringify([daily, m.figures.total, v2 && v2.figures.total]));
  const dta = (await call('GET', '/attraction-visits/consolidated/monthly?year=2026&month=10&mode=official', null, off)).data;
  const rowA = dta.attractions.find(a => a._id === A).row;
  ok(rowA.total === daily && rowA.version === 2, 'DTA2M uses version 2 of Test Falls and its total');
  const y = (await call('GET', '/attraction-visits/consolidated/annual?year=2026&mode=official', null, off)).data;
  ok(y.byMonth[9].total === dta.totals.total && y.grand.total === dta.totals.total, 'VAR 3M October and year total = DTA2M October total (only October is finalized)', JSON.stringify([y.byMonth[9].total, dta.totals.total]));
  const x1 = await cellsOf((await call('GET', `/attraction-visits/${A}/months/2026/10/export.xlsx?version=2`, null, off)).buf);
  const v1 = x1.getWorksheet('VAR 1'); let tr = 0; v1.eachRow((r, i) => { if (String(r.getCell(1).value).startsWith('Total of this Month')) tr = i; });
  ok(num(v1.getRow(tr).getCell(14)) === daily, 'VAR 1 Excel total cell = daily counts', num(v1.getRow(tr).getCell(14)));
  const x2 = await cellsOf((await call('GET', '/attraction-visits/consolidated/monthly.xlsx?year=2026&month=10&mode=official', null, off)).buf);
  const d2 = x2.getWorksheet('DTA2M'); let t2 = 0; d2.eachRow((r, i) => { if (String(r.getCell(1).value).startsWith('Total of this Month')) t2 = i; });
  ok(num(d2.getRow(t2).getCell(17)) === dta.totals.total, 'DTA2M Excel grand total = the screen total', num(d2.getRow(t2).getCell(17)));
  const x3 = await cellsOf((await call('GET', '/attraction-visits/consolidated/annual.xlsx?year=2026&mode=official', null, off)).buf);
  const v3 = x3.getWorksheet('VAR 3M'); let oct = 0, t3 = 0; v3.eachRow((r, i) => { if (r.getCell(1).value === 'October') oct = i; if (r.getCell(1).value === 'Total:') t3 = i; });
  const g0 = 2 + y.attractions.length * 3;
  ok(num(v3.getRow(oct).getCell(g0 + 2)) === y.byMonth[9].total && num(v3.getRow(t3).getCell(g0 + 2)) === y.grand.total, 'VAR 3M Excel October and year cells = the screen', JSON.stringify([num(v3.getRow(oct).getCell(g0 + 2)), num(v3.getRow(t3).getCell(g0 + 2))]));
  const breaks = (await call('GET', '/attraction-visits/consolidated/monthly.xlsx?year=2026&month=10&mode=official', null, off)).buf;
  const JSZip = require('../../../zamboanguita-backend/node_modules/jszip');
  const xml = await (await JSZip.loadAsync(breaks)).file('xl/worksheets/sheet1.xml').async('string');
  ok(/<colBreaks count="1"[^>]*><brk id="11"/.test(xml) && /orientation="landscape"/.test(xml), 'DTA2M prints landscape and continues sideways after the Philippine columns');

  console.log('Year boundary: December and January are separate months and separate years');
  sql(`update attraction_settings set reporting_from = '2025-12-01' where spot_id = '${A}'`);
  for (const [date, total] of [['2025-12-31', 77], ['2026-01-01', 33]]) {
    const r = await call('PUT', `/attraction-visits/${A}/days/${date}`, { total, revision: 0, requestKey: key() }, staff);
    ok(r.status === 201, `recorded ${date}`, JSON.stringify(r.data));
  }
  const dec = (await call('GET', `/attraction-visits/${A}/months/2025/12`, null, staff)).data, jan = (await call('GET', `/attraction-visits/${A}/months/2026/1`, null, staff)).data;
  ok(dec.figures.days === 31 && dec.figures.daily[30].count.total === 77 && jan.figures.daily[0].count.total === 33 && dec.figures.total === 77 && jan.figures.total === 33, '31 Dec counts in December 2025, 1 Jan in January 2026');
  const y25 = (await call('GET', '/attraction-visits/consolidated/annual?year=2025&mode=operational', null, off)).data;
  const fa25 = y25.attractions.find(a => a._id === A);
  ok(fa25 && fa25.months[11].cell.total === 77 && fa25.months.slice(0, 11).every(x => !x.cell.included), 'VAR 3M 2025 (operational) shows only December for Test Falls');
  const y26 = (await call('GET', '/attraction-visits/consolidated/annual?year=2026&mode=operational', null, off)).data;
  ok(y26.attractions.find(a => a._id === A).months[0].cell.total === 33, 'VAR 3M 2026 January holds the 1 January count, not December\'s');
  const legacy25 = sql(`select count(*) from monthly_reports where kind = 'municipal_total' and year = 2025 and status = 'submitted'`);
  ok(y25.legacy.municipalTotalMonths === Number(legacy25), `the 2025 municipal totals (${legacy25} months) are reported apart, not added to attraction visits`);

  console.log('A change of Support Staff: the record stays with the attraction');
  const hash = bcrypt.hashSync(PW, 10);
  sql(`update support_staff set status = 'inactive', session_version = session_version + 1 where email = 'falls.staff@lgu.test'`);
  ok((await call('GET', `/attraction-visits/${A}/months/2026/10`, null, staff)).status === 401, 'the replaced person\'s open session stops at once');
  const tk = (await call('GET', '/attraction-visits/tracker?year=2026', null, off)).data.attractions.find(a => a._id === A);
  ok(tk.supportStaff === '', 'the tracker shows the attraction without Support Staff');
  if (!sql(`select 1 from support_staff where email = 'falls2.staff@lgu.test'`)) sql(`insert into support_staff (email, password_hash, full_name, position, spot_id, must_change_password) values ('falls2.staff@lgu.test', '${hash}', 'Staff falls two', 'Aide', '${A}', false)`);
  sql(`update support_staff set status = 'active', spot_id = '${A}', must_change_password = false, password_hash = '${hash}' where email = 'falls2.staff@lgu.test'`);
  const staff2 = (await login('falls2.staff@lgu.test', PW)).token;
  const m2 = await call('GET', `/attraction-visits/${A}/months/2026/10`, null, staff2);
  ok(m2.status === 200 && m2.data.versions.length === 2 && m2.data.events.some(e => e.actorEmail === 'falls.staff@lgu.test'), 'the new person sees the month, its versions and who did what before');
  const jan2 = (await call('GET', `/attraction-visits/${A}/months/2026/1`, null, staff2)).data;
  const r2 = await call('PUT', `/attraction-visits/${A}/days/2026-01-01`, { total: 34, revision: jan2.figures.daily[0].count.revision, requestKey: key() }, staff2);
  ok(r2.status === 200 && sql(`select updated_by_email from attraction_daily_counts where spot_id = '${A}' and count_date = '2026-01-01'`) === 'falls2.staff@lgu.test', 'the new person can correct an open month, and the change names them');
  ok((await call('GET', `/attraction-visits/${C}/months/2026/10`, null, staff2)).status === 403, 'the new person cannot open another attraction');

  console.log('An attraction switched off ("Count visitors here" off): no new counts, records kept');
  sql(`update spots set counts_visitors = false where id = '${C}'`);
  const sc = (await login('sec.staff@lgu.test', PW)).token;
  const off1 = await call('PUT', `/attraction-visits/${C}/days/2026-11-02`, { total: 5, revision: 0, requestKey: key() }, sc);
  ok(off1.status === 409 && off1.data.code === 'NOT_COUNTED', 'a count for an attraction that no longer counts is refused', JSON.stringify(off1.data));
  ok((await call('GET', '/attraction-visits/me', null, sc)).data.countsVisitors === false, 'the page learns the attraction is not counted (it shows a message, not a form)');
  sql(`update spots set counts_visitors = true where id = '${C}'`);

  // Put the local accounts back as the other checks expect them.
  sql(`update support_staff set status = 'inactive' where email = 'falls2.staff@lgu.test'; update support_staff set status = 'active' where email = 'falls.staff@lgu.test'`);
  sql(`delete from rate_limits`);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
