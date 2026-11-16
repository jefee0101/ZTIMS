/* Integration regression checks for the actual DAE-1B and monthly package.
 * Only the explicit isolated local database ztims_report_test is accepted.
 * Set DATABASE_URL and JWT_SECRET; seed accounts using local test fixtures.
 * The script clears accommodation records in that test database only.
 * KEEP_REPORT_SERVER=1 leaves the local API + built pages open for UI checks. */
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const backend = path.resolve(__dirname, '../../../zamboanguita-backend');
const { Client } = require(path.join(backend, 'node_modules/pg'));
const jwt = require(path.join(backend, 'node_modules/jsonwebtoken'));
const ExcelJS = require(path.join(backend, 'node_modules/exceljs'));
const express = require(path.join(backend, 'node_modules/express'));
const dbURL = new URL(process.env.DATABASE_URL || 'postgres://invalid');
assert(['127.0.0.1','localhost','[::1]'].includes(dbURL.hostname) && dbURL.pathname === '/ztims_report_test', 'Only the isolated local test database is allowed');
assert(process.env.JWT_SECRET, 'A local test JWT_SECRET is required');
const A = '5b623f31b0f74d0bb5630dbe', B = '2f9d15101bf34b3382a3b6b4';
const token = (sub, role) => jwt.sign({ sub, role, sv: 0 }, process.env.JWT_SECRET, { issuer: 'ztims-api', audience: 'ztims-web', expiresIn: '2h' });
const manager = token('222222222222222222222222','establishment_manager');
const other = token('333333333333333333333333','establishment_manager');
const officer = token('111111111111111111111111','admin');
const PORT = Number(process.env.REPORT_TEST_PORT || 8088), base = `http://127.0.0.1:${PORT}/api`;
let server, app, checks = 0;
const check = (value, message) => { assert(value, message); checks++; console.log('PASS', message); };
async function call(method, url, body, auth = manager, expected = 200) {
    const r = await fetch(base + url, { method, headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json();
    assert.equal(r.status, expected, `${method} ${url}: ${JSON.stringify(data).slice(0,400)}`);
    return data;
}
async function excel(url, auth = officer) {
    const r = await fetch(base + url, { headers: { Authorization: 'Bearer ' + auth } });
    assert.equal(r.status, 200, await (r.ok ? Promise.resolve('') : r.text()));
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer())); return wb;
}
const value = cell => cell.type === ExcelJS.ValueType.Formula ? cell.result : cell.value;
const rowNamed = (sheet, name) => { let row; sheet.eachRow(r => { if (r.getCell(1).value === name) row=r; }); assert(row, name); return row; };
(async () => {
    const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
    await db.query('truncate accommodation_changes, accommodation_period_events, accommodation_periods, accommodation_report_version_counts, accommodation_report_versions, accommodation_stay_guests, accommodation_stay_rooms, accommodation_stays, accommodation_room_unavailability, accommodation_closed_periods, accommodation_rooms, accommodation_profiles, rate_limits cascade');
    await db.end();
    app = require(path.join(backend, 'server'));
    // Vercel serves the static pages separately from the API's Helmet policy.
    // Reuse its real page policy when hosting the built pages in this harness.
    const pageHeaders = JSON.parse(fs.readFileSync(path.resolve(backend, '../vercel.json'),'utf8')).headers[0].headers;
    const site = express();
    site.use((req,res,next) => {
        if (req.path.startsWith('/api/')) return app(req,res,next);
        for (const h of pageHeaders) res.setHeader(h.key,h.value);
        next();
    });
    site.use(express.static(path.resolve(backend, '../Zamboanguita-project/dist')));
    server = await new Promise(resolve => { const s = site.listen(PORT, '127.0.0.1', () => resolve(s)); });
    const room = {};
    for (const spot of [A,B]) {
        await call('PUT', `/accommodation/${spot}/profile`, { accommodationType:'resort', reportingFrom:'2026-01', dotClassification:'Test classification', aeCode:'TEST-' + spot.slice(-4) });
        room[spot] = (await call('POST', `/accommodation/${spot}/rooms`, { roomNumber:'101', sleeps:4, availableFrom:'2026-01-01' }, manager, 201)).room._id;
    }
    const stay = (spot, from, until, code, male, female) => call('POST', `/accommodation/${spot}/stays`, {
        checkIn:from, checkOut:until, rooms:[{roomId:room[spot]}], guests:[{residence:code,male,female}]
    },manager,201);
    const first = (await stay(A,'2026-01-01','2026-01-03','ph-filipino',1,1)).stay;
    await stay(A,'2026-01-31','2026-02-02','JP',1,0);
    await stay(A,'2026-02-05','2026-02-07','ph-foreign',1,1);
    await stay(B,'2026-01-02','2026-01-03','US',1,0);
    const jan = await call('POST', `/accommodation/${A}/months/2026/1/submit`, {expectedVersion:0}, manager,201);
    const savedId=jan.versions[0]._id;
    await call('POST', `/accommodation/${B}/months/2026/1/submit`, {expectedVersion:0}, manager,201);
    await call('POST', `/accommodation/${A}/months/2026/2/submit`, {expectedVersion:0}, manager,201);
    const saved = (await call('GET', `/accommodation/versions/${savedId}`, null,officer)).version;
    check(saved.detail.daily[0].checkIn===2 && saved.detail.daily[30].checkIn===1, 'DAE-1A daily arrivals are saved with the submission');
    const grand=saved.dae1b.find(r=>r.kind==='grand');
    check(grand.days[0]===2 && grand.days[30]===1 && grand.total===3,'DAE-1B preserves daily residence counts and monthly total');
    check(saved.detail.daily[30].guestNights===1 && saved.figures.guestNights===5,'Cross-month stays split nights without repeating arrivals');
    const wb=await excel(`/accommodation/${A}/months/2026/1/export.xlsx?version=1`);
    check(wb.worksheets.map(s=>s.name).join(',')==='DAE-1A,DAE-1B','Monthly export contains both actual forms and no Manual-Summary');
    const grandExcel=rowNamed(wb.getWorksheet('DAE-1B'),'GRAND TOTAL GUEST ARRIVALS');
    check(value(grandExcel.getCell(2))===2 && value(grandExcel.getCell(32))===1 && value(grandExcel.getCell(33))===3,'Export daily columns and totals match the saved DAE-1B');
    const blank=await excel('/accommodation/templates/dae1b.xlsx');
    check(blank.worksheets.length===1 && blank.worksheets[0].name==='DAE-1B','Blank template excludes Manual-Summary');
    const feb=await excel(`/accommodation/${A}/months/2026/2/export.xlsx?version=1`);
    const febGrand=rowNamed(feb.getWorksheet('DAE-1B'),'GRAND TOTAL GUEST ARRIVALS');
    check(value(febGrand.getCell(30))==null && value(febGrand.getCell(32))==null,'February keeps non-existent day columns empty');
    const scope=await call('GET','/accommodation/form-a?year=2026',null,officer);
    check(scope.grandTotal===6 && scope.months[0].reported===2,'Annual Form A aggregates all resorts and keeps each submitted month');
    check(scope.months.length===12 && scope.rows.every(r=>r.months.slice(2).every(x=>x===null)) && scope.partII.months[0] && scope.partII.months[1] && scope.partII.months.slice(2).every(x=>x===null),'Form A has all 12 months: January and February remain filled, unreported months stay blank');
    const fa=await excel('/accommodation/form-a.xlsx?year=2026');
    const fg=rowNamed(fa.getWorksheet('FORM A'),'GRAND TOTAL GUEST ARRIVALS');
    check(value(fg.getCell(2))===4 && value(fg.getCell(3))===2 && value(fg.getCell(4))==null && value(fg.getCell(14))===6,'Annual Form A export preserves reported months and sums the year correctly');
    await call('GET',`/accommodation/${A}/months/2026/13`,null,officer,400);
    await call('GET',`/accommodation/versions/${savedId}`,null,other,403);
    await call('GET','/accommodation/form-a?year=2026',null,manager,403);
    check(true,'Month validation and manager/enterprise access controls remain enforced');
    await call('PUT',`/accommodation/stays/${first._id}`,{revision:first.revision,checkIn:'2026-01-02',checkOut:'2026-01-04',rooms:[{roomId:room[A]}],guests:[{residence:'ph-filipino',male:1,female:1}],reason:'Correct arrival date'},manager);
    const changed=await call('GET',`/accommodation/${A}/months/2026/1`);
    check(changed.state.state==='changed' && changed.figures.arrivals===3 && changed.state.differences.some(d=>d.field==='dailyDetail'),'A daily-only correction is detected even when monthly totals do not change');
    const tracker=await call('GET','/accommodation/tracker?year=2026',null,officer);
    check(tracker.enterprises.find(s=>s._id===A).months[0].state==='changed','Tracker detects the same daily-only correction');
    const immutable=(await call('GET',`/accommodation/versions/${savedId}`,null,officer)).version;
    check(JSON.stringify(saved)===JSON.stringify(immutable),'Previously submitted DAE-1A and DAE-1B remain unchanged after register edits');
    const corrected=await call('POST',`/accommodation/${A}/months/2026/1/submit`,{expectedVersion:1,reason:'Correct arrival date'},manager,201);
    const v2=(await call('GET',`/accommodation/versions/${corrected.versions[1]._id}`,null,officer)).version;
    check(v2.detail.daily[0].checkIn===0 && v2.detail.daily[1].checkIn===2 && v2.figures.arrivals===3,'Correction creates a new version containing both corrected daily forms');
    await call('POST',`/accommodation/${A}/months/2026/1/finalize`,{expectedVersion:2},officer);
    await call('POST',`/accommodation/${A}/months/2026/1/submit`,{expectedVersion:2,reason:'Should be locked'},manager,409);
    check(true,'Finalization still locks the monthly package');
    const out=process.env.REPORT_TEST_OUTPUT;
    if(out){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'ui-fixture.json'),JSON.stringify({manager,officer,spot:A,base:`http://127.0.0.1:${PORT}`,savedId},null,2));fs.writeFileSync(path.join(out,'test-results.json'),JSON.stringify({checks,passed:true},null,2));fs.writeFileSync(path.join(out,'sample-DAE-1A-DAE-1B.xlsx'),Buffer.from(await wb.xlsx.writeBuffer()));}
    console.log(`${checks} monthly package checks passed`);
    if(!process.env.KEEP_REPORT_SERVER){await new Promise(r=>server.close(r));await app.closeDatabase();}
    else console.log(`Local UI check server: http://127.0.0.1:${PORT}`);
})().catch(async e=>{console.error(e);if(server)await new Promise(r=>server.close(r));if(app)await app.closeDatabase();process.exit(1);});
