// Attraction visitor reporting: real API calls against a LOCAL API (:8080) and LOCAL database only.
// Never point it at the live database: it clears the attraction_* tables first.
// Needs DATABASE_URL (local), TEST_MANAGER_PASSWORD (maria@x.test), TEST_OFFICER_PASSWORD (officer@lgu.test),
// and the offices' "Test Falls" and "Test Pool" attractions (office-run, counting) in the local database.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const bcrypt = require('../../../zamboanguita-backend/node_modules/bcryptjs');
const E = require('../../../zamboanguita-backend/attraction-engine');
const API = 'http://localhost:8080/api';
const DB = process.env.DATABASE_URL;
const sql = q => execFileSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-Atc', q], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const sqlErr = q => { try { sql(q); return ''; } catch (e) { return String(e.stderr || e.message); } };
let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗', label, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)); } };
let ipn = 1;
async function call(method, path, body, token, raw) {
    const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.95.0.' + (ipn++ % 250) };
    if (token) headers.Authorization = 'Bearer ' + token;
    // A reused idle connection can be closed by the server just as it is picked (Node's keep-alive timeout): a GET is safe to repeat once.
    const send = () => fetch(API + path, { method, headers, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) });
    const r = await send().catch(e => { if (method === 'GET' && e.cause && e.cause.code === 'UND_ERR_SOCKET') return send(); throw e; });
    const buf = Buffer.from(await r.arrayBuffer());
    let data = null; try { data = JSON.parse(buf.toString()); } catch {}
    return { status: r.status, data, buf, type: r.headers.get('content-type') || '' };
}
const login = async (email, password) => (await call('POST', '/login', { email, password, role: 'staff' })).data;
const key = () => crypto.randomBytes(8).toString('hex');
const PW = process.env.TEST_MANAGER_PASSWORD, OPW = process.env.TEST_OFFICER_PASSWORD;
const today = E.manilaToday();

(async () => {
    sql(`update spots set title = 'Test Pool' where title like '=HYPERLINK%'`);   // an earlier aborted run may have left the injection title
    const A = sql(`select id from spots where title = 'Test Falls' and type = 'spot' and managed_by is null`);
    const B = sql(`select id from spots where title = 'Test Pool' and type = 'spot' and managed_by is null`);
    const C = sql(`select id from spots where title = 'Peace Statue' and type = 'spot' and managed_by is null`);
    const MGR_SPOT = sql(`select id from spots where managed_by is not null and type = 'spot' limit 1`);
    const STAY = sql(`select id from spots where type = 'accommodation' and managed_by is not null limit 1`);
    ok(A && B && C, 'three office-run attractions exist locally');

    // ---- clean slate for the attraction tables only (local test database) ----
    const h2025 = () => sql(`select md5(string_agg(r.id||r.month||coalesce(r.rooms,0)||coalesce(r.room_nights_occupied,0)||coalesce(r.guest_nights,0)||c.residence_code||c.total, ',' order by r.month, c.residence_code)) from monthly_reports r join monthly_report_counts c on c.report_id=r.id where r.kind='municipal_total'`);
    const before2025 = h2025(), legacyBefore = sql(`select md5(string_agg(row(m.*)::text, ',' order by m.id)) from monthly_reports m where m.kind = 'attraction'`);
    const legacyCount = sql(`select count(*) from monthly_reports where kind = 'attraction'`);
    sql(`set session_replication_role = replica; delete from attraction_outputs; delete from attraction_period_events; delete from attraction_periods; delete from attraction_report_versions;
         delete from attraction_count_changes; delete from attraction_daily_counts; delete from attraction_settings;
         delete from spot_closed_dates where spot_id in ('${A}', '${B}', '${C}'); delete from rate_limits;`);
    // Support Staff for A, B and C (local accounts; one active each).
    const hash = bcrypt.hashSync('Coral-Ridge-Lantern-47', 10);
    for (const [spot, email] of [[A, 'falls.staff@lgu.test'], [B, 'pool.staff@lgu.test'], [C, 'sec.staff@lgu.test']]) {
        sql(`update support_staff set status = 'inactive' where spot_id = '${spot}' and email <> '${email}'`);
        if (!sql(`select 1 from support_staff where email = '${email}'`)) sql(`insert into support_staff (email, password_hash, full_name, position, spot_id, must_change_password) values ('${email}', '${hash}', 'Staff ${email.slice(0, 5)}', 'Support Staff', '${spot}', false)`);
        sql(`update support_staff set status = 'active', must_change_password = false, spot_id = '${spot}', password_hash = '${hash}' where email = '${email}'`);
    }
    const sa = (await login('falls.staff@lgu.test', 'Coral-Ridge-Lantern-47')).token, sb = (await login('pool.staff@lgu.test', 'Coral-Ridge-Lantern-47')).token;
    const sc = (await login('sec.staff@lgu.test', 'Coral-Ridge-Lantern-47')).token;
    const officer = (await login('officer@lgu.test', OPW)).token, maria = (await login('maria@x.test', PW)).token;
    const vEmail = sql(`select email from visitors where status = 'active' order by created_at limit 1`);
    sql(`update visitors set password_hash = '${bcrypt.hashSync(PW, 10)}', email_verified_at = coalesce(email_verified_at, now()) where email = '${vEmail}'`);
    const tourist = (await call('POST', '/visitors/sign-in', { email: vEmail, password: PW })).data.token;
    ok(sa && sb && sc && officer && maria && tourist, 'staff A, staff B, staff C, officer, manager and tourist all signed in');

    const put = (tok, spot, date, body) => call('PUT', `/attraction-visits/${spot}/days/${date}`, { requestKey: key(), revision: 0, ...body }, tok);
    const month = (tok, spot, y, m) => call('GET', `/attraction-visits/${spot}/months/${y}/${m}`, undefined, tok);

    console.log('Access: roles and assignments');
    let r = await put(sa, A, '2024-02-01', { total: 10 });
    ok(r.status === 201, 'Support Staff A records on A', r.data);
    const routes = [['GET', `/attraction-visits/${A}/months/2024/2`], ['PUT', `/attraction-visits/${A}/days/2024-02-02`, { total: 5, requestKey: key(), revision: 0 }],
        ['POST', `/attraction-visits/${A}/days/confirm-zero`, { dates: ['2024-02-03'], requestKey: key() }], ['POST', `/attraction-visits/${A}/months/2024/2/submit`, { expectedVersion: 0 }],
        ['POST', `/attraction-visits/${A}/months/2024/2/finalize`, { expectedVersion: 1 }], ['POST', `/attraction-visits/${A}/months/2024/2/reopen`, { reason: 'trying to reopen it' }],
        ['GET', `/attraction-visits/${A}/months/2024/2/export.xlsx?version=current`], ['PUT', `/attraction-visits/${A}/settings`, { reportingFrom: '2024-01' }],
        ['GET', '/attraction-visits/tracker?year=2024'], ['GET', '/attraction-visits/consolidated/monthly?year=2024&month=2'], ['GET', '/attraction-visits/consolidated/annual?year=2024'],
        ['GET', `/attraction-visits/consolidated/attraction/${A}?year=2024`], ['GET', '/attraction-visits/consolidated/monthly.xlsx?year=2024&month=2'], ['GET', '/attraction-visits/consolidated/annual.xlsx?year=2024'],
        ['POST', '/attraction-visits/outputs', { kind: 'VAR3M', year: 2024 }], ['GET', '/attraction-visits/outputs?year=2024'], ['GET', '/attraction-visits/me']];
    for (const [who, tok] of [['no token', null], ['tourist', tourist], ['enterprise manager', maria]]) {
        const bad = []; for (const [m, p, b] of routes) { const x = await call(m, p, b, tok); if (![401, 403].includes(x.status)) bad.push(m + ' ' + p + ' ' + x.status); }
        ok(!bad.length, `${who}: all ${routes.length} attraction-visit routes refused`, bad);
    }
    let bad = []; for (const [m, p, b] of routes.filter(x => /\/attraction-visits\/[0-9a-f]{24}\//.test(x[1]) && !/consolidated|settings/.test(x[1]))) { const x = await call(m, p, b, sb); if (![403, 404].includes(x.status)) bad.push(m + ' ' + p + ' ' + x.status); }
    ok(!bad.length, 'Support Staff B cannot read, record, submit or export attraction A (403)', bad);
    bad = []; for (const [m, p, b] of routes.filter(x => /consolidated|tracker|outputs|settings|finalize|reopen/.test(x[1]))) { const x = await call(m, p, b, sa); if (![403].includes(x.status)) bad.push(m + ' ' + p + ' ' + x.status); }
    ok(!bad.length, 'Support Staff cannot use the officer\'s routes (finalize, reopen, settings, tracker, consolidation, outputs)', bad);
    r = await call('PUT', `/attraction-visits/${A}/days/2024-02-02`, { total: 5, requestKey: key(), revision: 0 }, officer);
    ok(r.status === 403, 'the officer cannot record counts', r.data);
    r = await call('POST', `/attraction-visits/${A}/days/confirm-zero`, { dates: ['2024-02-03'], requestKey: key() }, officer);
    ok(r.status === 403, 'the officer cannot confirm zeros either');
    r = await call('PUT', `/attraction-visits/${MGR_SPOT}/days/2024-02-02`, { total: 5, requestKey: key(), revision: 0 }, sa);
    ok([403, 404].includes(r.status), 'a manager-run attraction is not reachable', r.status);
    r = await call('PUT', `/attraction-visits/${STAY}/days/2024-02-02`, { total: 5, requestKey: key(), revision: 0 }, sa);
    ok([403, 404].includes(r.status), 'a place to stay is not reachable', r.status);
    r = await call('GET', `/attraction-visits/${encodeURIComponent("x' or 1=1 --")}/months/2024/2`, undefined, officer);
    ok(r.status === 404, 'an id carrying SQL is a plain not-found', r.status);
    r = await call('GET', '/attraction-visits/me', undefined, sa);
    ok(r.status === 200 && r.data.attraction._id === A, 'Support Staff sees their own assigned attraction');
    sql(`update support_staff set status = 'inactive' where email = 'sec.staff@lgu.test'`);
    r = await call('GET', `/attraction-visits/${C}/months/2024/2`, undefined, sc);
    ok(r.status === 401, 'a deactivated Support Staff account stops at once', r.status);
    sql(`update support_staff set status = 'active' where email = 'sec.staff@lgu.test'`);

    console.log('Validation, server side');
    const badBodies = [['no total', {}], ['negative', { total: -1 }], ['fraction', { total: 1.5 }], ['text', { total: 'abc' }], ['too large', { total: 100001 }],
        ['unknown field', { total: 5, status: 'finalized' }], ['role field', { total: 5, role: 'admin' }], ['attraction field', { total: 5, spotId: B }],
        ['residence over total', { total: 10, residence: { zamboanguita: 11 } }], ['residence sum over total', { total: 10, residence: { zamboanguita: 6, foreign: 5 } }],
        ['unknown class', { total: 10, residence: { elsewhere: 1 } }], ['complete but short', { total: 10, residence: { zamboanguita: 5 }, residenceComplete: true }],
        ['sex over total', { total: 10, sex: { male: 6, female: 5 } }], ['sex complete but short', { total: 10, sex: { male: 4, female: 5 }, sexComplete: true }],
        ['zero with breakdown', { total: 0, residence: { zamboanguita: 0 } }], ['negative class', { total: 10, residence: { foreign: -1 } }], ['flag not boolean', { total: 10, residenceComplete: 'yes' }],
        ['bad revision', { total: 10, revision: 'x' }]];
    bad = []; for (const [label, body] of badBodies) { const x = await put(sa, A, '2024-02-05', body); if (x.status !== 400) bad.push(label + ' ' + x.status); }
    ok(!bad.length, `${badBodies.length} invalid bodies are refused with 400`, bad);
    r = await call('PUT', `/attraction-visits/${A}/days/2024-02-05`, { total: 5, revision: 0 }, sa);
    ok(r.status === 400, 'a save without a request key is refused');
    for (const d of ['2024-02-30', '2024-13-01', 'abc', '2023-02-29', '1999-12-31', '2101-01-01']) { const x = await put(sa, A, d, { total: 1 }); if (x.status !== 400) bad.push(d + ' ' + x.status); }
    ok(!bad.length, 'impossible calendar dates (30 Feb, month 13, 29 Feb 2023, out of range) are refused', bad);
    r = await put(sa, A, E.addDays(today, 1), { total: 5 });
    ok(r.status === 400 && r.data.code === 'FUTURE_DATE', 'a future date is refused', r.data);
    r = await put(sa, A, '2024-01-31', { total: 5 });
    ok(r.status === 409 && r.data.code === 'BEFORE_REPORTING', 'a date before the first reporting month is refused', r.data);
    r = await call('PUT', `/attraction-visits/${A}/days/2024-02-05`, '{"total":' + '9'.repeat(1.2e6) + '}', sa, true);
    ok(r.status === 413, 'a body over 1 MB is refused (413)', r.status);
    ok(sql(`select count(*) from attraction_daily_counts where spot_id = '${A}'`) === '1', 'refused saves wrote nothing');

    console.log('Totals only, partial, complete, zero: missing, zero and unknown stay different');
    r = await put(sa, A, '2024-02-02', { total: 100, residence: { zamboanguita: 20, negrosOriental: 30, otherProvince: 25, foreign: 15 } });
    ok(r.status === 201 && r.data.count.residenceComplete === false, 'the approved scenario: total 100, residence 90 known, 10 unrecorded', r.data);
    r = await put(sa, A, '2024-02-03', { total: 40, residence: { zamboanguita: 40 }, residenceComplete: true, sex: { male: 15, female: 25 }, sexComplete: true });
    ok(r.status === 201 && r.data.count.residenceComplete && r.data.count.sexComplete, 'a complete day');
    r = await put(sa, A, '2024-02-04', { total: 0 });
    ok(r.status === 201 && r.data.count.total === 0 && r.data.count.residence.zamboanguita === null, 'a confirmed zero');
    r = await put(sa, A, '2024-02-06', { total: 7, residence: { foreign: 0 }, sex: { male: 3 } });
    ok(r.status === 201 && r.data.count.residence.foreign === 0 && r.data.count.residence.zamboanguita === null && r.data.count.female === null, 'a known 0 differs from an unknown (null)', r.data.count);
    let v = (await month(sa, A, 2024, 2)).data;
    const day = d => v.figures.daily.find(x => x.date === d);
    ok(day('2024-02-05').state === 'missing' && day('2024-02-04').state === 'zero' && day('2024-02-02').state === 'counted', 'missing, zero and counted are different states');
    ok(v.figures.days === 29, 'February 2024 has 29 days (leap year)');
    ok(v.figures.total === 10 + 100 + 40 + 0 + 7 && v.figures.residence.zamboanguita === 60 && v.figures.domestic === 20 + 30 + 25 + 40, 'monthly totals are worked out on the server', v.figures);
    ok(v.figures.residenceUnrecorded === 10 + 10 + 7 && v.figures.residence.foreign === 15, 'unrecorded residence is counted, never assigned to a class', v.figures.residenceUnrecorded);
    ok(v.figures.sexUnrecorded === 10 + 100 + 0 + 7 - 3 + 0 && v.figures.male === 18 && v.figures.female === 25, 'sex is independent of residence; unknown sex is not zero', [v.figures.sexUnrecorded, v.figures.male, v.figures.female]);
    ok(!JSON.stringify(v.figures).includes('sexByResidence'), 'no sex-by-residence figure exists anywhere');

    console.log('Retries, concurrent saves, lost updates');
    const k1 = key();
    const first = await call('PUT', `/attraction-visits/${A}/days/2024-02-07`, { total: 33, revision: 0, requestKey: k1 }, sa);
    const retry = await call('PUT', `/attraction-visits/${A}/days/2024-02-07`, { total: 33, revision: 0, requestKey: k1 }, sa);
    ok(first.status === 201 && retry.status === 200 && retry.data.replayed === true && retry.data.count.revision === 1, 'a retried save (same key) returns the first result, no second record', [first.status, retry.status]);
    ok(sql(`select count(*) from attraction_daily_counts where spot_id = '${A}' and count_date = '2024-02-07'`) === '1' && sql(`select count(*) from attraction_count_changes where spot_id = '${A}' and count_date = '2024-02-07'`) === '1', '… one record and one history row');
    const same = key();
    const par = await Promise.all(Array.from({ length: 8 }, () => call('PUT', `/attraction-visits/${A}/days/2024-02-08`, { total: 21, revision: 0, requestKey: same }, sa)));
    ok(par.filter(x => x.status === 201).length === 1 && par.every(x => [200, 201].includes(x.status)) && sql(`select count(*) from attraction_daily_counts where spot_id = '${A}' and count_date = '2024-02-08'`) === '1', 'eight identical saves at once: one record', par.map(x => x.status));
    const racers = await Promise.all(Array.from({ length: 6 }, (_, i) => call('PUT', `/attraction-visits/${A}/days/2024-02-09`, { total: 10 + i, revision: 0, requestKey: key() }, sa)));
    ok(racers.filter(x => x.status === 201).length === 1 && racers.filter(x => x.status === 409).length === 5, 'six different first saves of one date: one wins, five told to reload', racers.map(x => x.status));
    const cur = (await month(sa, A, 2024, 2)).data.figures.daily.find(d => d.date === '2024-02-09').count;
    const edits = await Promise.all([1, 2, 3].map(i => call('PUT', `/attraction-visits/${A}/days/2024-02-09`, { total: 50 + i, revision: cur.revision, requestKey: key() }, sa)));
    ok(edits.filter(x => x.status === 200).length === 1 && edits.filter(x => x.status === 409 && x.data.code === 'STALE').length === 2, 'three edits of one revision: one wins, two get STALE with the server record (no lost update)', edits.map(x => x.status));
    ok(edits.find(x => x.status === 409).data.server.total > 50, '… the refusal carries the server\'s record');
    r = await call('PUT', `/attraction-visits/${A}/days/2024-02-09`, { total: 5, revision: 1, requestKey: key() }, sa);
    ok(r.status === 409 && r.data.code === 'STALE', 'a stale revision is refused');
    ok(Number(sql(`select count(*) from attraction_count_changes where spot_id = '${A}' and count_date = '2024-02-09'`)) === 2, 'each change is in the attributable history (created, updated)');
    ok(sql(`select string_agg(updated_by_email || ':' || updated_by_role, ',') from attraction_daily_counts where spot_id = '${A}' and count_date = '2024-02-09'`) === 'falls.staff@lgu.test:support_staff', 'the record names who changed it, from the token');

    console.log('Closed dates and confirmed zeros');
    sql(`insert into spot_closed_dates (spot_id, closed_date, reason) values ('${A}', '2024-02-10', 'Typhoon advisory')`);
    r = await put(sa, A, '2024-02-10', { total: 1 });
    ok(r.status === 409 && r.data.code === 'CLOSED_DATE', 'a count on an authorized closure is refused', r.data);
    v = (await month(sa, A, 2024, 2)).data;
    ok(v.figures.daily.find(d => d.date === '2024-02-10').state === 'closed' && v.figures.closed === 1, 'a closure is its own state, not a zero');
    r = await call('POST', `/attraction-visits/${A}/days/confirm-zero`, { dates: ['2024-02-11', '2024-02-12'], requestKey: 'zero-key-0001' }, sa);
    const again = await call('POST', `/attraction-visits/${A}/days/confirm-zero`, { dates: ['2024-02-11', '2024-02-12'], requestKey: 'zero-key-0001' }, sa);
    ok(r.status === 201 && r.data.confirmed.length === 2 && again.status === 200 && again.data.replayed, 'bulk confirm-zero, and its retry adds nothing');
    r = await call('POST', `/attraction-visits/${A}/days/confirm-zero`, { dates: ['2024-02-13', '2024-02-02'], requestKey: key() }, sa);
    ok(r.status === 409 && r.data.code === 'ALREADY_RECORDED' && sql(`select count(*) from attraction_daily_counts where spot_id = '${A}' and count_date = '2024-02-13'`) === '0', 'bulk confirm-zero is all or nothing');
    r = await call('POST', `/attraction-visits/${A}/days/confirm-zero`, { dates: [E.addDays(today, 2)], requestKey: key() }, sa);
    ok(r.status === 400, 'zeros cannot be confirmed for future dates');

    console.log('Lifecycle: incomplete month, Submit, locked, Finalize, Reopen, correction, resubmission');
    r = await call('POST', `/attraction-visits/${A}/months/2024/2/submit`, { expectedVersion: 0 }, sa);
    ok(r.status === 409 && r.data.code === 'MONTH_INCOMPLETE' && r.data.missing.length > 5, 'an incomplete month cannot be submitted, and the missing dates are named', r.data.code);
    for (let d = 1; d <= 29; d++) { const date = `2024-02-${E.pad(d)}`; v = (await month(sa, A, 2024, 2)).data; const st = v.figures.daily.find(x => x.date === date).state; if (st === 'missing') await put(sa, A, date, { total: d % 5 === 0 ? 0 : d }); }
    v = (await month(sa, A, 2024, 2)).data;
    ok(v.state.state === 'ready' && v.figures.complete && v.figures.days === 29, 'every date counted or closed: ready to submit', v.state);
    const oracle = v.figures.total;
    r = await call('POST', `/attraction-visits/${A}/months/2024/2/submit`, { expectedVersion: 5 }, sa);
    ok(r.status === 409 && r.data.code === 'STALE', 'submit names the version it saw (stale is refused)');
    const subs = await Promise.all(Array.from({ length: 5 }, () => call('POST', `/attraction-visits/${A}/months/2024/2/submit`, { expectedVersion: 0 }, sa)));
    ok(subs.filter(x => x.status === 201).length === 1 && subs.filter(x => x.status === 409).length === 4, 'five submits at once: one version 1, four refused', subs.map(x => x.status));
    ok(sql(`select count(*) from attraction_report_versions where spot_id = '${A}' and year = 2024 and month = 2`) === '1' && sql(`select count(*) from attraction_period_events where spot_id = '${A}' and action = 'submitted'`) === '1', '… one version and one event');
    v = (await month(sa, A, 2024, 2)).data;
    ok(v.state.state === 'submitted' && v.versions[0].figures.total === oracle, 'submitted v1 holds the figures worked out from the daily counts');
    r = await put(sa, A, '2024-02-20', { total: 1, revision: 1 });
    ok(r.status === 409 && r.data.code === 'PERIOD_LOCKED', 'a submitted month locks recording (PUT)', r.data);
    r = await call('POST', `/attraction-visits/${A}/days/confirm-zero`, { dates: ['2024-02-20'], requestKey: key() }, sa);
    ok(r.status === 409, 'a submitted month locks bulk confirm-zero too', r.data);
    r = await call('POST', `/attraction-visits/${A}/months/2024/2/submit`, { expectedVersion: 1 }, sa);
    ok(r.status === 409 && r.data.code === 'ALREADY_SUBMITTED', 'a submitted month cannot be submitted again');
    ok(/PERIOD_LOCKED/.test(sqlErr(`update attraction_daily_counts set total = total, revision = revision + 1 where spot_id = '${A}' and count_date = '2024-02-20'`)), 'database trigger: a submitted month\'s count cannot be edited in SQL');
    ok(/IMMUTABLE/.test(sqlErr(`delete from attraction_daily_counts where spot_id = '${A}' and count_date = '2024-02-20'`)), 'database trigger: a count can never be deleted');
    ok(/IMMUTABLE/.test(sqlErr(`update attraction_report_versions set total = total + 1 where spot_id = '${A}'`)), 'database trigger: a saved version cannot be altered');
    ok(/IMMUTABLE/.test(sqlErr(`delete from attraction_report_versions where spot_id = '${A}'`)), '… or removed');
    ok(/IMMUTABLE/.test(sqlErr(`update attraction_period_events set reason = 'x' where spot_id = '${A}'`)), '… and its history is never edited');
    r = await call('POST', `/attraction-visits/${A}/months/2024/2/finalize`, { expectedVersion: 9 }, officer);
    ok(r.status === 409 && r.data.code === 'STALE', 'finalize names the version it reviewed');
    const fins = await Promise.all(Array.from({ length: 4 }, () => call('POST', `/attraction-visits/${A}/months/2024/2/finalize`, { expectedVersion: 1 }, officer)));
    ok(fins.filter(x => x.status === 200).length === 1 && sql(`select count(*) from attraction_period_events where spot_id = '${A}' and action = 'finalized'`) === '1', 'four finalizes at once: one event', fins.map(x => x.status));
    v = (await month(sa, A, 2024, 2)).data;
    ok(v.state.state === 'finalized' && v.state.finalizedVersion === 1, 'finalized v1');
    r = await put(sa, A, '2024-02-20', { total: 1, revision: 1 });
    ok(r.status === 409 && r.data.code === 'PERIOD_LOCKED', 'a finalized month locks recording');
    r = await call('POST', `/attraction-visits/${A}/months/2024/2/reopen`, { reason: 'short' }, officer);
    ok(r.status === 400, 'reopening needs a reason of 10 characters');
    r = await call('POST', `/attraction-visits/${A}/months/2024/2/reopen`, { reason: 'Count for 2 Feb was revised after a check' }, officer);
    ok(r.status === 200 && r.data.state.state === 'reopened' && r.data.events.at(-1).reason.startsWith('Count for 2 Feb'), 'reopened with the reason on record');
    // An output issued from the finalized month before it was reopened is superseded below; here: first issue, then reopen again later.
    const day2 = (await month(sa, A, 2024, 2)).data.figures.daily.find(d => d.date === '2024-02-02').count;
    r = await put(sa, A, '2024-02-02', { total: 104, revision: day2.revision, residence: { zamboanguita: 24, negrosOriental: 30, otherProvince: 25, foreign: 15 } });
    ok(r.status === 200 && r.data.count.total === 104, 'the Support Staff corrects a date in a reopened month');
    r = await call('POST', `/attraction-visits/${A}/months/2024/2/submit`, { expectedVersion: 1 }, sa);
    ok(r.status === 400, 'a correction needs a reason');
    r = await call('POST', `/attraction-visits/${A}/months/2024/2/submit`, { expectedVersion: 1, reason: 'Corrected 2 Feb to 104' }, sa);
    ok(r.status === 201 && r.data.state.version === 2, 'resubmitted as version 2', r.data.code);
    v = (await month(sa, A, 2024, 2)).data;
    ok(v.versions.length === 2 && v.versions[0].figures.total === oracle && v.versions[1].figures.total === oracle - 100 + 104, 'version 1 is kept exactly; version 2 has the correction');
    ok(v.versions[1].changes.length === 1 && v.versions[1].changes[0].date === '2024-02-02' && v.versions[1].changes[0].from === 100 && v.versions[1].changes[0].to === 104, 'the change list names the date, before and after', v.versions[1].changes);
    ok(v.state.finalizedVersion === 1 && v.state.state === 'submitted', 'v1 stays the finalized (official) version until v2 is finalized');
    ok(v.events.map(e => e.action).join() === 'submitted,finalized,reopened,submitted', 'history: submitted, finalized, reopened, submitted');
    r = await call('POST', `/attraction-visits/${A}/months/2024/2/finalize`, { expectedVersion: 2 }, officer);
    ok(r.status === 200, 'v2 finalized');
    ok(/BAD_TRANSITION/.test(sqlErr(`update attraction_periods set state = 'submitted' where spot_id = '${A}' and month = 2`)), 'database trigger: finalized cannot go back to submitted');
    ok(/IMMUTABLE_DELETE/.test(sqlErr(`delete from attraction_periods where spot_id = '${A}'`)), '… and a month\'s state is never removed');
    ok(/VERSION_DRIFT|PERIOD_LOCKED|MONTH_INCOMPLETE/.test(sqlErr(`insert into attraction_report_versions (spot_id, year, month, version, dates_counted, total, res_unrecorded, sex_unrecorded, daily) values ('${A}', 2024, 2, 3, 1, 5, 5, 5, '[]')`)), 'database trigger: a hand-made version that does not match the daily counts is refused');

    console.log('Day 31 and a second attraction (October 2026, 31 days)');
    sql(`insert into spot_closed_dates (spot_id, closed_date, reason) values ('${B}', '2026-10-27', 'Typhoon advisory')`);
    for (let d = 1; d <= 31; d++) { const date = `2026-10-${E.pad(d)}`; if (d === 27) continue; r = await put(sb, B, date, d === 3 ? { total: 100, residence: { zamboanguita: 20, negrosOriental: 30, otherProvince: 25, foreign: 15 } } : d === 5 ? { total: 0 } : { total: d + 40 }); if (r.status !== 201) { ok(false, 'record ' + date, r.data); break; } }
    v = (await month(sb, B, 2026, 10)).data;
    ok(v.figures.days === 31 && v.figures.daily.length === 31 && v.figures.daily[30].date === '2026-10-31' && v.figures.daily[30].state === 'counted', 'day 31 is recorded and shown');
    ok(v.figures.closed === 1 && v.figures.zero === 1 && v.figures.complete, 'one closure, one confirmed zero, month complete');
    ok(v.figures.daily[2].count.total === 100 && v.figures.domestic === 75 && v.figures.foreignKnown === 15 && v.figures.residenceUnrecorded >= 10, 'scenario: 100 visits, 75 known domestic, 15 known foreign, 10 unclassified (on that date)', [v.figures.domestic, v.figures.foreignKnown]);
    const sum31 = Array.from({ length: 31 }, (_, i) => i + 1).filter(d => d !== 27 && d !== 5).reduce((a, d) => a + (d === 3 ? 100 : d + 40), 0);
    ok(v.figures.total === sum31, 'the monthly total equals the sum of its 30 counted dates', [v.figures.total, sum31]);
    r = await call('POST', `/attraction-visits/${B}/months/2026/10/submit`, { expectedVersion: 0 }, sb);
    ok(r.status === 201, 'October (31 days) submitted');
    // Feb 2025: 28 days; the next-month Nov 2026 is still open and cannot be submitted.
    r = await call('POST', `/attraction-visits/${B}/months/${today.slice(0, 4)}/${+today.slice(5, 7)}/submit`, { expectedVersion: 0 }, sb);
    ok(r.status === 409 && ['MONTH_NOT_ENDED', 'BEFORE_REPORTING'].includes(r.data.code), 'the current month cannot be submitted before it ends', r.data.code);
    r = await put(sb, B, '2025-02-01', { total: 5 });
    ok(r.status === 409 && r.data.code === 'BEFORE_REPORTING', 'before B\'s first reporting month (October 2026) is refused');
    r = await call('PUT', `/attraction-visits/${B}/settings`, { reportingFrom: '2025-02' }, officer);
    ok(r.status === 200 && r.data.reportingFrom === '2025-02-01', 'the officer can set the first reporting month');
    for (let d = 1; d <= 28; d++) await put(sb, B, `2025-02-${E.pad(d)}`, { total: d });
    v = (await month(sb, B, 2025, 2)).data;
    ok(v.figures.days === 28 && v.figures.complete && v.figures.total === 406, 'February 2025 has 28 days and adds up (406)', [v.figures.days, v.figures.total]);
    r = await put(sb, B, '2025-02-29', { total: 1 });
    ok(r.status === 400, '29 February 2025 does not exist');

    console.log('Consolidation: official = finalized only, no double counting, nothing shown as zero');
    let m = (await call('GET', '/attraction-visits/consolidated/monthly?year=2024&month=2&mode=official', undefined, officer)).data;
    const rowA = m.attractions.find(x => x._id === A);
    ok(rowA.source.kind === 'final' && rowA.source.version === 2 && rowA.row.total === oracle - 100 + 104, 'DTA2M official uses finalized v2 once (not v1 and v2)', rowA);
    ok(rowA.row.thisMunicipality === 24 + 40 && rowA.row.thisProvince === 30 && rowA.row.otherProvince === 25 && rowA.row.foreign === 15, 'DTA2M columns (This Municipality, This Province, Other Province, Foreign) come from the version', rowA.row);
    ok(m.totals.total === rowA.row.total && m.totals.included === m.attractions.filter(x => x.row.included).length, 'the total row adds only included attractions');
    const rowB = m.attractions.find(x => x._id === B);
    ok(!rowB || !rowB.row.included, 'B has no February 2024 (it started later): not included, not zero');
    m = (await call('GET', '/attraction-visits/consolidated/monthly?year=2026&month=10&mode=official', undefined, officer)).data;
    ok(m.attractions.find(x => x._id === B).source.kind === 'none' && m.attractions.find(x => x._id === B).row.included === false, 'a submitted but not finalized month is "none" in the official view, never 0');
    m = (await call('GET', '/attraction-visits/consolidated/monthly?year=2026&month=10&mode=operational', undefined, officer)).data;
    ok(m.attractions.find(x => x._id === B).source.kind === 'submitted' && m.attractions.find(x => x._id === B).row.included, 'the operational view includes it, labeled submitted');
    r = await call('POST', `/attraction-visits/${B}/months/2026/10/finalize`, { expectedVersion: 1 }, officer);
    const an = (await call('GET', '/attraction-visits/consolidated/annual?year=2026&mode=official', undefined, officer)).data;
    const aB = an.attractions.find(x => x._id === B), oct = aB.months[9].cell;
    ok(oct.included && oct.total === sum31 && oct.domestic === 75 && oct.foreign === 15 && oct.unrecorded === sum31 - 90, 'VAR 3M: Domestic 75, Foreign 15 as recorded, Total confirmed, the unrecorded kept apart', oct);
    ok(oct.domestic + oct.foreign < oct.total, 'Domestic + Foreign is below Total: the form is not falsely completed');
    ok(aB.months[0].cell.included === false && aB.months[10].cell.included === false, 'months with no finalized version are not included (not zero)');
    ok(an.grand.total === an.totals.reduce((a, t) => a + t.total, 0), 'the grand total adds the attraction totals');
    const an2025 = (await call('GET', '/attraction-visits/consolidated/annual?year=2025&mode=official', undefined, officer)).data;
    ok(an2025.legacy.municipalTotalMonths === 12 && /not allocated to attractions/.test(an2025.legacy.note) && an2025.grand.total === 0, '2025: the municipal totals are noted, not allocated to attractions, and add nothing');

    console.log('Issued outputs, superseded when a month is reopened');
    r = await call('POST', '/attraction-visits/outputs', { kind: 'DTA2M', year: 2024, month: 2 }, officer);
    const out1 = r.data.output;
    ok(r.status === 201 && out1.composition.length === 1 && out1.composition[0].version === 2, 'an issued DTA2M names the exact finalized version it used', r.data);
    r = await call('POST', '/attraction-visits/outputs', { kind: 'VAR3M', year: 2024 }, officer);
    const var1out = r.data.output;
    const xl0 = await call('GET', `/attraction-visits/outputs/${out1._id}/export.xlsx`, undefined, officer);
    ok(xl0.status === 200 && /spreadsheetml/.test(xl0.type), 'the issued output downloads');
    r = await call('POST', `/attraction-visits/${A}/months/2024/2/reopen`, { reason: 'Reopened again to check a total' }, officer);
    let list = (await call('GET', '/attraction-visits/outputs?year=2024', undefined, officer)).data.outputs;
    ok(list.find(o => o._id === out1._id).status === 'needs_regeneration' && list.find(o => o._id === var1out._id).status === 'needs_regeneration', 'reopening marks the issued DTA2M and VAR 3M as needing regeneration (kept, not edited)');
    m = (await call('GET', '/attraction-visits/consolidated/monthly?year=2024&month=2&mode=official', undefined, officer)).data;
    ok(m.attractions.find(x => x._id === A).source.pending === true && m.attractions.find(x => x._id === A).source.version === 2, 'while reopened, the last finalized version stays official and is marked pending');
    const xl1 = await call('GET', `/attraction-visits/outputs/${out1._id}/export.xlsx`, undefined, officer);
    ok(xl1.status === 200 && xl1.buf.length > 1000, 'the earlier issued version can still be downloaded exactly as issued');
    await call('POST', `/attraction-visits/${A}/months/2024/2/submit`, { expectedVersion: 2, reason: 'No change after the check' }, sa);
    await call('POST', `/attraction-visits/${A}/months/2024/2/finalize`, { expectedVersion: 3 }, officer);
    r = await call('POST', '/attraction-visits/outputs', { kind: 'DTA2M', year: 2024, month: 2 }, officer);
    list = (await call('GET', '/attraction-visits/outputs?year=2024&', undefined, officer)).data.outputs;
    ok(r.status === 201 && list.find(o => o._id === out1._id).status === 'superseded' && list.filter(o => o.kind === 'DTA2M' && o.status === 'current').length === 1 && r.data.output.composition[0].version === 3, 'issuing the replacement supersedes the old one; only one is current and it uses v3');
    ok(/IMMUTABLE/.test(sqlErr(`update attraction_outputs set composition = '[]' where id = '${out1._id}'`)) && /IMMUTABLE_DELETE/.test(sqlErr(`delete from attraction_outputs where id = '${out1._id}'`)), 'an issued output\'s composition is never edited or removed');
    r = await call('POST', '/attraction-visits/outputs', { kind: 'DTA2M', year: 2020, month: 1 }, officer);
    ok(r.status === 409 && r.data.code === 'NOTHING_FINALIZED', 'nothing is issued when nothing is finalized');

    console.log('Statistics separation and historical data');
    ok(h2025() === before2025, 'the 2025 municipal totals are exactly as before');
    ok(sql(`select md5(string_agg(row(m.*)::text, ',' order by m.id)) from monthly_reports m where m.kind = 'attraction'`) === legacyBefore && sql(`select count(*) from monthly_reports where kind = 'attraction'`) === legacyCount, 'earlier attraction reports are untouched');
    const legacyMonth = sql(`select year || '-' || month from monthly_reports where kind = 'attraction' limit 1`);
    if (legacyMonth) {
        const [ly, lm] = legacyMonth.split('-');
        const fa = (await call('GET', `/statistics/form-a4?year=${ly}&from=${lm}&to=${lm}`, undefined, officer)).data;
        const legacyTotal = Number(sql(`select coalesce(sum(c.total), 0) from monthly_reports r join monthly_report_counts c on c.report_id = r.id where r.kind = 'attraction' and r.status = 'submitted' and r.year = ${ly} and r.month = ${lm}`));
        const allTotal = Object.values(fa.counts).reduce((a, c) => a + c.total[lm - 1], 0);
        const accTotal = Number(sql(`select coalesce(sum(c.total), 0) from monthly_reports r join monthly_report_counts c on c.report_id = r.id where r.kind = 'accommodation' and r.status = 'submitted' and r.year = ${ly} and r.month = ${lm}`))
            + Number(sql(`select coalesce(sum(v.arrivals), 0) from (select distinct on (spot_id) arrivals from accommodation_report_versions where year = ${ly} and month = ${lm} order by spot_id, version desc) v`));
        ok(legacyTotal > 0 && allTotal !== accTotal + legacyTotal && fa.places.every(p => p.kind === 'accommodation'), `the Arrivals Report (Form A4) no longer adds attraction visits (${legacyMonth}: legacy attraction ${legacyTotal}, report ${allTotal})`, [allTotal, accTotal, legacyTotal]);
    } else ok(true, '(no earlier attraction report to compare)');
    r = await call('PUT', `/statistics/reports/${A}/2026/10`, { counts: [{ code: 'ph-filipino', male: 3, female: 4 }] }, officer);
    ok(r.status === 403 || r.status === 409, 'the old monthly report no longer takes an attraction\'s figures (officer)', r.status);
    r = await call('PUT', `/statistics/reports/${A}/2026/10`, { counts: [{ code: 'ph-filipino', male: 3, female: 4 }] }, sa);
    ok(r.status === 409 && r.data.code === 'USE_DAILY_RECORD', 'nor does Support Staff\'s old route (409 USE_DAILY_RECORD)', r.data);
    r = await call('POST', `/statistics/register/${A}`, { date: '2026-10-01', guests: [{ code: 'ph-filipino', male: 1, female: 0 }] }, sa);
    ok(r.status === 409 && r.data.code === 'USE_DAILY_RECORD', 'the attraction Guest Register is retired (409)', r.data);
    ok(/LEGACY_ATTRACTION_FROZEN/.test(sqlErr(`insert into monthly_reports (kind, spot_id, year, month) values ('attraction', '${A}', 2020, 1)`)), 'database: no new old-style attraction report');
    ok(/LEGACY_ATTRACTION_FROZEN/.test(sqlErr(`update monthly_reports set guest_nights = 1 where kind = 'attraction'`)) || legacyCount === '0', 'database: an old attraction report\'s figures cannot change');
    ok(/LEGACY_REGISTER_FROZEN/.test(sqlErr(`insert into register_entries (spot_id, entry_date) values ('${A}', '2020-01-01')`)), 'database: no new attraction Guest Register entry');
    const legEntry = sql(`select e.id from register_entries e join spots s on s.id = e.spot_id where s.type = 'spot' limit 1`), legReport = sql(`select id from monthly_reports where kind = 'attraction' limit 1`);
    if (legEntry) ok(/LEGACY_REGISTER_FROZEN/.test(sqlErr(`insert into register_entry_guests (entry_id, residence_code, male, female) values ('${legEntry}', 'PH', 1, 0)`)) && /LEGACY_REGISTER_FROZEN/.test(sqlErr(`delete from register_entry_guests where entry_id = '${legEntry}'`)), 'database: an earlier attraction register entry\'s guests cannot change or be removed');
    if (legReport) ok(/LEGACY_ATTRACTION_FROZEN/.test(sqlErr(`delete from monthly_report_counts where report_id = '${legReport}'`)), 'database: an earlier attraction report\'s country rows cannot be removed');
    ok(sql(`select count(*) from monthly_reports where kind = 'municipal_total' and year = 2025`) === '12', 'all twelve 2025 municipal months are still there');
    const tr = (await call('GET', '/attraction-visits/tracker?year=2024', undefined, officer)).data;
    ok(tr.attractions.find(x => x._id === A).months[1].state === 'submitted' || tr.attractions.find(x => x._id === A).months[1].state === 'finalized', 'the tracker reads the new module', tr.attractions.find(x => x._id === A).months[1]);

    console.log('Excel: one aggregation, zero versus blank, day 31, formula injection');
    sql(`update spots set title = '=HYPERLINK("http://evil.test","x")' where id = '${B}'`);
    const files = {};
    const get = async (name, path, tok) => { const x = await call('GET', path, undefined, tok); files[name] = x; return x; };
    await get('var1', `/attraction-visits/${B}/months/2026/10/export.xlsx?version=1`, sb);
    await get('var1leap', `/attraction-visits/${A}/months/2024/2/export.xlsx?version=latest`, sa);
    await get('dta2m', '/attraction-visits/consolidated/monthly.xlsx?year=2026&month=10&mode=official', officer);
    await get('annual', '/attraction-visits/consolidated/annual.xlsx?year=2026&mode=official', officer);
    await get('draft', `/attraction-visits/${A}/months/2024/2/export.xlsx?version=current`, sa);
    ok(Object.values(files).every(x => x.status === 200 && /spreadsheetml/.test(x.type)), 'all five exports download', Object.entries(files).map(([k, x]) => k + ':' + x.status));
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-xl-'));
    for (const [k, x] of Object.entries(files)) fs.writeFileSync(path.join(dir, k + '.xlsx'), x.buf);
    const py = execFileSync('python3', ['-I', path.join(__dirname, 'check-exports.py'), dir, JSON.stringify({ octTotal: sum31, febLeapDays: 29, octDays: 31, dom: 75, frn: 15 })]).toString();
    console.log(py.trim().split('\n').map(l => '  ' + l).join('\n'));
    const pyRes = py.trim().split('\n').filter(l => /^(✓|✗)/.test(l));
    pyRes.forEach(l => { if (l.startsWith('✓')) pass++; else fail++; });
    r = await get('forbid', `/attraction-visits/${B}/months/2026/10/export.xlsx?version=1`, sa);
    ok(r.status === 403, 'another attraction\'s Support Staff cannot download its VAR 1');
    sql(`update spots set title = 'Test Pool' where id = '${B}'`);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
