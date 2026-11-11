// Accommodation reporting: security checks against a LOCAL API (:8080) and LOCAL database only.
// Run after api-checks.js (it relies on the state that suite leaves: Maria's place with
// September and October 2026 finalized, Juan's place with a room).
// Needs DATABASE_URL (local), TEST_MANAGER_PASSWORD, TEST_OFFICER_PASSWORD. It gives one local
// visitor a known password and adds one local Support Staff account; never point it at live.
const { execFileSync } = require('child_process');
const bcrypt = require('../../../zamboanguita-backend/node_modules/bcryptjs');
const API = 'http://localhost:8080/api';
const DB = process.env.DATABASE_URL;
const sql = q => execFileSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-Atc', q], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const sqlErr = q => { try { sql(q); return ''; } catch (e) { return String(e.stderr || e.message); } };
let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗', label, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); } };
let ipn = 1;
async function call(method, path, body, token, raw) {
    const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.91.0.' + (ipn++ % 250) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) });
    const buf = Buffer.from(await r.arrayBuffer());
    let data = null; try { data = JSON.parse(buf.toString()); } catch {}
    return { status: r.status, data, buf, type: r.headers.get('content-type') || '' };
}
const login = async (email, password) => (await call('POST', '/login', { email, password, role: 'staff' })).data;
const SPOT = '5b623f31b0f74d0bb5630dbe';
const PW = process.env.TEST_MANAGER_PASSWORD, OPW = process.env.TEST_OFFICER_PASSWORD;

(async () => {
    sql('delete from rate_limits');
    const maria = (await login('maria@x.test', PW)).token, juan = (await login('juan@x.test', PW)).token, officer = (await login('officer@lgu.test', OPW)).token;
    const juanId = sql(`select id from establishment_managers where email = 'juan@x.test'`);
    const JUAN = sql(`select id from spots where managed_by = '${juanId}' and type = 'accommodation' order by created_at limit 1`);
    const mRoom = sql(`select id from accommodation_rooms where spot_id = '${SPOT}' and room_number = '101'`);
    const mRoom301 = sql(`select id from accommodation_rooms where spot_id = '${SPOT}' and room_number = '301'`);
    const jRoom = sql(`select id from accommodation_rooms where spot_id = '${JUAN}' limit 1`);
    const mStay = sql(`select id from accommodation_stays where spot_id = '${SPOT}' and status = 'active' limit 1`);
    const mVersion = sql(`select id from accommodation_report_versions where spot_id = '${SPOT}' limit 1`);
    const mClosed = sql(`select id from accommodation_closed_periods where spot_id = '${SPOT}' and voided_at is null limit 1`);
    const mOos = sql(`select id from accommodation_room_unavailability where spot_id = '${SPOT}' and voided_at is null limit 1`);
    ok(maria && juan && officer && JUAN && mRoom && jRoom && mStay && mVersion, 'state from api-checks.js is present');

    // A tourist (visitor) token: one local visitor, verified, with a known password.
    const vEmail = sql(`select email from visitors where status = 'active' order by created_at limit 1`);
    sql(`update visitors set password_hash = '${bcrypt.hashSync(PW, 10)}', email_verified_at = coalesce(email_verified_at, now()) where email = '${vEmail}'`);
    const tourist = (await call('POST', '/visitors/sign-in', { email: vEmail, password: PW })).data.token;
    ok(!!tourist, 'a visitor signs in (local account)');

    // A Support Staff token: added by the officer for an office attraction with nobody active.
    let staff = null;
    const attraction = sql(`select s.id from spots s where s.managed_by is null and s.type = 'spot' and s.status = 'published'
                              and not exists (select 1 from support_staff x where x.spot_id = s.id and x.status = 'active') limit 1`);
    const staffEmail = 'sec.staff@lgu.test';
    if (!sql(`select 1 from support_staff where email = '${staffEmail}'`)) {
        const add = await call('POST', '/support-staff', { fullName: 'Security Check', email: staffEmail, spotId: attraction, password: 'Coral-Ridge-Lantern-47', confirmPassword: OPW }, officer);
        ok(add.status === 201, 'officer adds a Support Staff account (local)', add.data);
    }
    sql(`update support_staff set status = 'active', must_change_password = false where email = '${staffEmail}'`);
    const sLogin = await login(staffEmail, 'Coral-Ridge-Lantern-47');
    staff = sLogin && sLogin.token;
    ok(!!staff && sLogin.role === 'support_staff', 'Support Staff signs in');

    console.log('Tourists and Support Staff: no accommodation route');
    const reads = [`/accommodation/${SPOT}/profile`, `/accommodation/${SPOT}/rooms`, `/accommodation/${SPOT}/stays?month=2026-09`, `/accommodation/stays/${mStay}`,
        `/accommodation/${SPOT}/months/2026/9`, `/accommodation/versions/${mVersion}`, `/accommodation/${SPOT}/year/2026`, `/accommodation/tracker?year=2026`,
        `/accommodation/form-a?year=2026`, `/accommodation/${SPOT}/months/2026/9/export.xlsx?version=1`, `/accommodation/form-a.xlsx?year=2026`,
        `/accommodation/${SPOT}/year/2026/export.xlsx`, `/accommodation/templates/dae1a.xlsx`];
    const writes = [['PUT', `/accommodation/${SPOT}/profile`, { accommodationType: 'hotel', reportingFrom: '2026-08' }],
        ['POST', `/accommodation/${SPOT}/rooms`, { roomNumber: 'X9', sleeps: 2, availableFrom: '2026-11-01' }],
        ['PATCH', `/accommodation/rooms/${mRoom}`, { label: 'x' }],
        ['POST', `/accommodation/${SPOT}/stays`, { checkIn: '2026-11-01', checkOut: '2026-11-02', rooms: [], guests: [] }],
        ['POST', `/accommodation/stays/${mStay}/void`, { reason: 'test', revision: 1 }],
        ['POST', `/accommodation/${SPOT}/months/2026/8/submit`, { expectedVersion: 0 }],
        ['POST', `/accommodation/${SPOT}/months/2026/10/reopen`, { reason: 'trying to reopen it' }],
        ['POST', `/accommodation/${SPOT}/months/2026/8/finalize`, { expectedVersion: 1 }]];
    for (const [who, tok] of [['tourist', tourist], ['Support Staff', staff], ['no token', null]]) {
        let bad = [];
        for (const p of reads) { const r = await call('GET', p, undefined, tok); if (![401, 403].includes(r.status)) bad.push(p + ' ' + r.status); }
        for (const [m, p, b] of writes) { const r = await call(m, p, b, tok); if (![401, 403].includes(r.status)) bad.push(m + ' ' + p + ' ' + r.status); }
        ok(!bad.length, `${who}: every accommodation read and write refused (${reads.length + writes.length} routes)`, bad);
    }

    console.log('Another enterprise: ids from Maria\'s place, used by Juan');
    let bad = [];
    for (const p of reads.filter(p => !/tracker|form-a|templates/.test(p))) { const r = await call('GET', p, undefined, juan); if (![403, 404].includes(r.status)) bad.push(p + ' ' + r.status); }
    for (const [m, p, b] of writes.filter(w => !/reopen|finalize/.test(w[1]))) { const r = await call(m, p, b, juan); if (![403, 404].includes(r.status)) bad.push(m + ' ' + p + ' ' + r.status); }
    for (const [m, p, b] of [['POST', `/accommodation/out-of-service/${mOos}/void`, { reason: 'not mine' }], ['POST', `/accommodation/closed-periods/${mClosed}/void`, { reason: 'not mine' }],
        ['PUT', `/accommodation/stays/${mStay}`, { checkIn: '2026-09-01', checkOut: '2026-09-02', rooms: [], guests: [], revision: 1, reason: 'x' }],
        ['POST', `/accommodation/${SPOT}/out-of-service`, { roomId: mRoom, startsOn: '2026-12-01', endsOn: '2026-12-02', reason: 'x' }],
        ['POST', `/accommodation/${SPOT}/closed-periods`, { startsOn: '2026-12-01', endsOn: '2026-12-02', reason: 'x' }]]) {
        const r = await call(m, p, b, juan); if (![403, 404].includes(r.status)) bad.push(m + ' ' + p + ' ' + r.status);
    }
    ok(!bad.length, 'Juan cannot read, export or change anything of Maria\'s (21 routes)', bad);
    // Juan's own stay pointing at Maria's room.
    let r = await call('POST', `/accommodation/${JUAN}/stays`, { checkIn: '2026-11-02', checkOut: '2026-11-03', rooms: [{ roomId: mRoom, from: '2026-11-02', until: '2026-11-03' }], guests: [{ residence: 'ph-filipino', male: 1, female: 0 }] }, juan);
    ok(r.status === 400 || r.status === 409 || r.status === 403, 'Juan cannot put a stay in Maria\'s room', r.status);
    r = await call('POST', `/accommodation/${JUAN}/out-of-service`, { roomId: mRoom, startsOn: '2026-12-01', endsOn: '2026-12-02', reason: 'x' }, juan);
    ok(r.status >= 400 && r.status < 500, 'Juan cannot mark Maria\'s room out of service through his own place', r.status);
    ok(sql(`select count(*) from accommodation_room_unavailability where room_id = '${mRoom}' and spot_id = '${JUAN}'`) === '0', '… and nothing was written');

    console.log('Managers on officer routes');
    bad = [];
    for (const [m, p, b] of [['GET', '/accommodation/tracker?year=2026'], ['GET', '/accommodation/form-a?year=2026'], ['GET', '/accommodation/form-a.xlsx?year=2026'],
        ['POST', `/accommodation/${SPOT}/months/2026/8/finalize`, { expectedVersion: 1 }], ['POST', `/accommodation/${SPOT}/months/2026/10/reopen`, { reason: 'I want to change it' }]]) {
        const res = await call(m, p, b, maria); if (res.status !== 403) bad.push(m + ' ' + p + ' ' + res.status);
    }
    ok(!bad.length, 'tracker, FORM A, its Excel, Finalize, Reopen: 403 for a manager', bad);
    r = await call('POST', `/accommodation/${SPOT}/rooms`, { roomNumber: 'O1', sleeps: 2, availableFrom: '2026-11-01' }, officer);
    ok(r.status === 403, 'the officer never writes rooms or stays');

    console.log('A finalized month (October 2026) cannot change, directly or indirectly');
    const octBefore = sql(`select md5(string_agg(row(v.*)::text, ',')) from accommodation_report_versions v where spot_id = '${SPOT}' and year = 2026 and month = 10`);
    const cases = [
        ['out of service in October', 'POST', `/accommodation/${SPOT}/out-of-service`, { roomId: mRoom, startsOn: '2026-10-20', endsOn: '2026-10-21', reason: 'Leak' }],
        ['closed period in October', 'POST', `/accommodation/${SPOT}/closed-periods`, { startsOn: '2026-10-25', endsOn: '2026-10-26', reason: 'Storm' }],
        ['a room retired mid-October', 'PATCH', `/accommodation/rooms/${mRoom}`, { availableUntil: '2026-10-15' }],
        ['a new room available from October', 'POST', `/accommodation/${SPOT}/rooms`, { roomNumber: 'N1', sleeps: 2, availableFrom: '2026-10-01' }],
        ['a stay with October nights', 'POST', `/accommodation/${SPOT}/stays`, { checkIn: '2026-10-30', checkOut: '2026-11-02', rooms: [{ roomId: mRoom, from: '2026-10-30', until: '2026-11-02' }], guests: [{ residence: 'ph-filipino', male: 1, female: 1 }] }],
        ['removing out of service that reaches October', 'POST', `/accommodation/out-of-service/${mOos}/void`, { reason: 'Finished early' }]];
    for (const [label, m, p, b] of cases) {
        const res = await call(m, p, b, maria);
        ok(res.status === 409, `refused: ${label}`, [res.status, res.data && res.data.code]);
    }
    // The database refuses too, whatever the API does.
    ok(/finalized|PERIOD_FINALIZED/i.test(sqlErr(`update accommodation_stay_guests set male = male + 1 where stay_id in (select s.id from accommodation_stays s where s.spot_id = '${SPOT}' and s.check_in between '2026-10-01' and '2026-10-31')`)),
        'database trigger: editing an October stay in SQL is refused');
    ok(/finalized|PERIOD_FINALIZED/i.test(sqlErr(`insert into accommodation_room_unavailability (spot_id, room_id, starts_on, ends_on, reason) values ('${SPOT}', '${mRoom}', '2026-10-10', '2026-10-11', 'sql')`)),
        'database trigger: out of service in October through SQL is refused');
    ok(/immutable|cannot|never/i.test(sqlErr(`update accommodation_report_versions set arrivals = arrivals + 1 where spot_id = '${SPOT}' and month = 10`)), 'database trigger: a saved version cannot be altered');
    ok(/immutable|cannot|never/i.test(sqlErr(`delete from accommodation_report_versions where spot_id = '${SPOT}' and month = 10`)), 'database trigger: a saved version cannot be deleted');
    ok(sql(`select md5(string_agg(row(v.*)::text, ',')) from accommodation_report_versions v where spot_id = '${SPOT}' and year = 2026 and month = 10`) === octBefore, 'October\'s versions unchanged');

    console.log('Bounded input, odd ids, injection');
    await call('PUT', `/accommodation/${JUAN}/profile`, { accommodationType: 'pension', reportingFrom: '2026-08' }, juan);
    r = await call('GET', `/accommodation/${encodeURIComponent("' or 1=1 --")}/months/2026/9`, undefined, maria);
    ok(r.status === 404 || r.status === 403, 'an id carrying SQL is a plain not-found', r.status);
    r = await call('GET', `/accommodation/${SPOT}/months/2026/13`, undefined, maria);
    ok(r.status === 400, 'month 13 refused');
    r = await call('POST', `/accommodation/${JUAN}/stays`, { checkIn: '2026-11-02', checkOut: '2026-11-03', rooms: [{ roomId: jRoom, from: '2026-11-02', until: '2026-11-03' }], guests: [{ residence: 'ph-filipino', male: -1, female: 0 }] }, juan);
    ok(r.status === 400, 'negative guests refused', r.status);
    r = await call('POST', `/accommodation/${JUAN}/stays`, { checkIn: '2026-11-02', checkOut: '2026-11-03', rooms: [{ roomId: jRoom, from: '2026-11-02', until: '2026-11-03' }], guests: [{ residence: 'ZZ', male: 1, female: 0 }] }, juan);
    ok(r.status === 400, 'unknown country of residence refused', r.status);
    r = await call('POST', `/accommodation/${JUAN}/stays`, { checkIn: '2026-11-02', checkOut: '2027-12-31', rooms: [{ roomId: jRoom, from: '2026-11-02', until: '2027-12-31' }], guests: [{ residence: 'ph-filipino', male: 1, female: 0 }] }, juan);
    ok(r.status === 400, 'a stay over 366 nights refused', r.status);
    r = await call('POST', `/accommodation/${JUAN}/rooms`, { roomNumber: 'X'.repeat(500), sleeps: 2, availableFrom: '2026-11-01' }, juan);
    ok(r.status !== 201 || (r.data.room && r.data.room.roomNumber.length <= 20), 'over-long room number cut to 20 or refused');
    r = await call('POST', `/accommodation/${JUAN}/rooms`, '{"roomNumber":"' + 'a'.repeat(1.2e6) + '"}', juan, true);
    ok(r.status === 413, 'a body over 1 MB is refused', r.status);
    r = await call('GET', `/accommodation/templates/${encodeURIComponent('../../server.js')}`, undefined, maria);
    ok(r.status === 404 || r.status === 400, 'template name cannot reach other files', r.status);

    console.log('Races');
    // Juan's place (set up above): a month to submit.
    const subs = await Promise.all(Array.from({ length: 6 }, () => call('POST', `/accommodation/${JUAN}/months/2026/8/submit`, { expectedVersion: 0 }, juan)));
    ok(subs.filter(x => x.status === 201).length === 1 && subs.filter(x => x.status === 409).length === 5, 'six submits at once: one version 1, five refused', subs.map(x => x.status));
    ok(sql(`select count(*) from accommodation_report_versions where spot_id = '${JUAN}' and year = 2026 and month = 8`) === '1', '… one version saved');
    const fins = await Promise.all(Array.from({ length: 4 }, () => call('POST', `/accommodation/${JUAN}/months/2026/8/finalize`, { expectedVersion: 1 }, officer)));
    ok(fins.filter(x => x.status === 200).length === 1, 'four finalizes at once: one succeeds', fins.map(x => x.status));
    ok(sql(`select count(*) from accommodation_period_events where spot_id = '${JUAN}' and month = 8 and action = 'finalized'`) === '1', '… one finalized event');
    const both = await Promise.all([0, 1, 2, 3].map(i => call('POST', `/accommodation/${JUAN}/stays`, { checkIn: '2026-11-03', checkOut: '2026-11-05', rooms: [{ roomId: jRoom, from: '2026-11-03', until: '2026-11-05' }], guests: [{ residence: 'KR', male: 1, female: i % 2 }] }, juan)));
    ok(both.filter(x => x.status === 201).length === 1, 'four stays for the same room and nights at once: one saved', both.map(x => x.status));
    const created = both.find(x => x.status === 201);
    const sid = created && created.data.stay._id;
    const edits = await Promise.all([1, 2].map(n => call('PUT', `/accommodation/stays/${sid}`, { checkIn: '2026-11-03', checkOut: '2026-11-0' + (5 + n), revision: created.data.stay.revision, reason: 'extended', rooms: [{ roomId: jRoom, from: '2026-11-03', until: '2026-11-0' + (5 + n) }], guests: [{ residence: 'KR', male: 1, female: 0 }] }, juan)));
    ok(edits.filter(x => x.status === 200).length === 1 && edits.filter(x => x.status === 409).length === 1, 'two edits of the same stay revision: one wins, one told to reload', edits.map(x => x.status));

    console.log('Exports: formula injection and personal details');
    const evil = '=HYPERLINK("http://evil.test","x")';
    sql(`update spots set enterprise_name = '${evil.replace(/'/g, "''")}' where id = '${JUAN}'`);
    await call('PUT', `/accommodation/${JUAN}/profile`, { accommodationType: 'other', accommodationTypeOther: '+cmd|calc', reportingFrom: '2026-08', aeCode: '@SUM(1)', dotClassification: '-2+3' }, juan);
    const xl = await call('GET', `/accommodation/${JUAN}/months/2026/8/export.xlsx?version=1`, undefined, juan);
    ok(xl.status === 200 && /spreadsheetml/.test(xl.type), 'Juan\'s August export downloads');
    const fs = require('fs'), os = require('os'), path = require('path');
    const file = path.join(os.tmpdir(), 'sec-export.xlsx');
    fs.writeFileSync(file, xl.buf);
    const scan = execFileSync('python3', ['-I', '-c', `
import openpyxl,sys,json
wb=openpyxl.load_workbook(sys.argv[1])
bad=[];texts=[]
for ws in wb:
  for row in ws.iter_rows():
    for c in row:
      v=c.value
      if isinstance(v,str):
        texts.append(v)
        if c.data_type=='f' and any(k in v.upper() for k in ('HYPERLINK','CMD','EVIL')): bad.append(ws.title+'!'+c.coordinate)
print(json.dumps({'bad':bad,'injected_as_text':sum(1 for t in texts if 'evil.test' in t or 'cmd|calc' in t or '@SUM' in t),'emails':[t for t in texts if '@' in t and '.' in t.split('@')[-1]]}))`, file]).toString();
    const s = JSON.parse(scan);
    ok(!s.bad.length && s.injected_as_text >= 2, 'names starting = + - @ land as text, never as formulas', s);
    ok(!s.emails.length, 'no email address in the export', s.emails);
    sql(`update spots set enterprise_name = 'Juan Inn' where id = '${JUAN}'`);

    console.log('Stored text shown on pages is escaped');
    r = await call('POST', `/accommodation/${JUAN}/closed-periods`, { startsOn: '2026-12-24', endsOn: '2026-12-25', reason: '<img src=x onerror=alert(1)>' }, juan);
    ok(r.status === 201, 'a reason with markup is stored as text (pages escape it; checked in the browser)');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
