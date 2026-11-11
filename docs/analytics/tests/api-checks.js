// Analytics: real API calls against a LOCAL API (:8080) and LOCAL database only (read-only on the data:
// it inserts one local visitor account and removes it). Expected figures are computed here from the raw
// tables with SQL, never by the code under test.
// Needs DATABASE_URL (local), TEST_MANAGER_PASSWORD (maria@x.test), TEST_OFFICER_PASSWORD (officer@lgu.test).
// Support Staff (falls.staff, pool.staff) get a known password set by this script for the local run.
const { execFileSync } = require('child_process');
const bcrypt = require('../../../zamboanguita-backend/node_modules/bcryptjs');
const API = 'http://localhost:8080/api';
const DB = process.env.DATABASE_URL;
if (!/localhost|127\.0\.0\.1/.test(DB || '')) { console.error('Local database only.'); process.exit(2); }
const sql = q => execFileSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-Atc', q], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const rows = q => sql(q).split('\n').filter(Boolean).map(r => r.split('|'));
let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗', label, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)); } };
let ipn = 1;
async function call(path, token, method = 'GET') {
    const headers = { 'X-Forwarded-For': '10.97.0.' + (ipn++ % 250) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(API + path, { method, headers });
    const buf = Buffer.from(await r.arrayBuffer());
    let data = null; try { data = JSON.parse(buf.toString()); } catch {}
    return { status: r.status, data, buf, type: r.headers.get('content-type') || '', cache: r.headers.get('cache-control') };
}
async function login(email, password) {
    const r = await fetch(API + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.97.1.' + (ipn++ % 250) }, body: JSON.stringify({ email, password, role: 'staff' }) });
    return (await r.json()).token;
}
const SPOT = { falls: '4b0dcc1722fc4e0bacc7b752', pool: '39fbfa3a5f6041dfabca3943', lavanya: '5b623f31b0f74d0bb5630dbe', juan: 'af4ceef49b7c4782ba729cae', sea: '2f9d15101bf34b3382a3b6b4' };
(async () => {
    const SSPW = 'Coral-Lantern-Wave-71';
    sql(`update support_staff set password_hash = '${bcrypt.hashSync(SSPW, 10)}', must_change_password = false where email in ('falls.staff@lgu.test','pool.staff@lgu.test')`);
    sql(`delete from visitors where email = 'analytics.visitor@x.test'`);
    sql(`insert into visitors (email, email_verified_at, password_hash, full_name, status) values ('analytics.visitor@x.test', now(), '${bcrypt.hashSync('Fern-Quartz-Meadow-42', 10)}', 'Test Visitor', 'active')`);
    const officer = await login('officer@lgu.test', process.env.TEST_OFFICER_PASSWORD);
    const maria = await login('maria@x.test', process.env.TEST_MANAGER_PASSWORD);
    const falls = await login('falls.staff@lgu.test', SSPW), pool = await login('pool.staff@lgu.test', SSPW);
    const vr = await fetch(API + '/visitors/sign-in', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.97.2.1' }, body: JSON.stringify({ email: 'analytics.visitor@x.test', password: 'Fern-Quartz-Meadow-42' }) });
    const visitor = (await vr.json()).token;
    ok(officer && maria && falls && pool && visitor, 'five accounts signed in (officer, manager, two Support Staff, visitor)');

    console.log('\nAccess');
    const routes = ['/analytics/accommodation', '/analytics/accommodation/places', '/analytics/attractions', '/analytics/attractions/places', '/analytics/reservations', '/analytics/coverage', '/analytics/accommodation/export.xlsx', '/analytics/attractions/export.xlsx'];
    for (const r of routes) ok((await call(r)).status === 401, `no token: 401 ${r}`);
    for (const r of routes) ok((await call(r, visitor)).status === 401 || (await call(r, visitor)).status === 403, `visitor token refused ${r}`);
    ok((await call('/analytics/accommodation', pool)).status === 403, 'Support Staff cannot read accommodation');
    ok((await call('/analytics/reservations', pool)).status === 403, 'Support Staff cannot read reservations');
    ok((await call('/analytics/attractions', maria)).status === 403, 'manager cannot read attractions');
    ok((await call('/analytics/coverage', maria)).status === 403 && (await call('/analytics/coverage', falls)).status === 403, 'coverage is the officer\'s only');
    ok((await call('/analytics/accommodation', officer)).cache === 'no-store', 'responses are never cached');

    console.log('\nAccommodation: official, August to November 2026');
    const Q = '?from=2026-08&to=2026-11';
    const acc = (await call('/analytics/accommodation' + Q, officer)).data;
    ok(acc && acc.success && acc.periods.length === 4, 'four monthly periods', acc && acc.periods && acc.periods.length);
    const by = k => acc.periods.find(p => p.key === k);
    // Raw oracle: the finalized version of each enterprise-month.
    const fin = rows(`select v.spot_id, v.year, v.month, v.arrivals, v.guest_nights, v.room_nights_occupied, v.room_nights_available from accommodation_periods p join accommodation_report_versions v on v.id = p.finalized_version_id where p.finalized_at is not null and p.year = 2026 and p.month between 8 and 11`);
    const sumM = (m, i) => fin.filter(r => +r[2] === m).reduce((a, r) => a + +r[i], 0);
    for (const m of [8, 9, 10]) {
        const p = by('2026-' + String(m).padStart(2, '0'));
        ok(p.figures && p.figures.arrivals === sumM(m, 3) && p.figures.guestNights === sumM(m, 4), `${m}: arrivals and guest nights are the finalized versions' sums`, { got: p.figures, want: [sumM(m, 3), sumM(m, 4)] });
    }
    ok(by('2026-09').figures.arrivals === 8, 'September uses version 2 (8), never version 1 (7) and never both (15)');
    ok(by('2026-10').figures.arrivals === 16, 'October uses version 2 (16)');
    ok(by('2026-08').figures.arrivals === 0 && by('2026-08').figures.guestNights === 0, 'August: Juan Inn\'s confirmed 0 is 0, and Lavanya\'s unfinalized 11 is not added');
    ok(by('2026-08').figures.roomNightsAvailable === 31, 'August room-nights available only from the finalized place (31)');
    ok(by('2026-11').figures === null, 'November: only a legacy manual version, not finalized: no official figures (null, not 0)');
    ok(by('2026-09').complete === false && by('2026-09').coverage.expected === 3, 'September is incomplete: 3 places expected, only Lavanya finalized', by('2026-09').coverage);
    ok(by('2026-09').coverage.finalized === 1 && by('2026-09').coverage.missing === 2, 'September coverage: 1 finalized, 2 missing (never 0)', by('2026-09').coverage);
    ok(acc.peakLow.arrivals.peak === null && acc.peakLow.arrivals.ranked === 0, 'no peak or low is named from incomplete months', acc.peakLow.arrivals);
    ok(acc.peakLow.arrivals.excluded.length >= 3, 'the months left out of the ranking are listed', acc.peakLow.arrivals.excluded);
    const rate = by('2026-10').rates;
    ok(rate && Math.abs(rate.occupancyRate - 13 / 212) < 1e-9 && Math.abs(rate.averageLengthOfStay - 41 / 16) < 1e-9, 'rates come from the summed counts (13/212, 41/16)', rate);
    ok(by('2026-11').rates === null, 'no rate without figures');

    console.log('\nAccommodation: operational labels the same months differently');
    const op = (await call('/analytics/accommodation' + Q + '&mode=operational', officer)).data;
    const opBy = k => op.periods.find(p => p.key === k);
    ok(op.mode === 'operational' && opBy('2026-08').figures.arrivals === 11, 'operational August: latest saved versions (Lavanya 11 + Juan 0)', opBy('2026-08').figures);
    ok(opBy('2026-09').figures.arrivals === 8 && opBy('2026-10').figures.arrivals === 16, 'operational still takes only the latest version of a month');
    ok(opBy('2026-11').figures && opBy('2026-11').figures.arrivals === 1, 'operational November includes the legacy manual version (1)');
    ok(opBy('2026-08').coverage.submitted === 1 && opBy('2026-08').coverage.finalized === 1, 'operational coverage says which were only submitted', opBy('2026-08').coverage);

    console.log('\nAccommodation: periods, filters, comparisons');
    const q = (await call('/analytics/accommodation?from=2026-08&to=2026-11&granularity=quarter&mode=operational', officer)).data;
    ok(q.periods.map(p => p.key).join() === '2026-Q3,2026-Q4', 'quarters group the months', q.periods.map(p => p.key));
    const q3 = q.periods[0].figures, q4 = q.periods[1].figures;
    ok(q3.arrivals === 11 + 8 && q4.arrivals === 16 + 1, 'quarter totals are the sums of their months (19, 17)', [q3.arrivals, q4.arrivals]);
    ok(q.periods[1].complete === false, 'Q4 (Oct, Nov, only part of the period so far) is not complete');
    const one = (await call('/analytics/accommodation?from=2026-08&to=2026-11&mode=operational&spotId=' + SPOT.lavanya, officer)).data;
    ok(one.places === 1 && one.periods.find(p => p.key === '2026-08').figures.arrivals === 11, 'spotId filter: one place');
    const brgy = (await call('/analytics/accommodation?from=2026-08&to=2026-11&mode=operational&barangay=mayabon', officer)).data;
    ok(brgy.places === 1 && brgy.periods.every(p => p.figures === null), 'barangay filter (case-insensitive): Sea Horizon has no reports, so null, not 0', brgy.periods.map(p => p.figures));
    const cat = (await call('/analytics/accommodation?from=2026-08&to=2026-11&category=BEACH', officer)).data;
    ok(cat.places === 3, 'category filter: three beach places to stay', cat.places);
    const bbox = (await call('/analytics/accommodation?from=2026-08&to=2026-11&bbox=123.0,9.0,123.5,9.2', officer)).data;
    ok(bbox.places === 2, 'bbox filter: only the two places with a pin inside', bbox.places);
    const cmp = (await call('/analytics/accommodation?from=2026-08&to=2026-11&compare=previous-year', officer)).data;
    ok(cmp.comparison && cmp.comparison[0].periods.every(c => c.comparable === false && c.difference === null), 'comparison: nothing comparable yet, difference null, with a reason', cmp.comparison && cmp.comparison[0].periods[0]);
    ok(cmp.comparison[0].periods[0].reason && /not complete|Nothing/.test(cmp.comparison[0].periods[0].reason), 'the reason is stated');

    console.log('\nAccommodation: the 2025 paper totals stay separate');
    const y25 = (await call('/analytics/accommodation?from=2025-01&to=2025-12&granularity=year', officer)).data;
    const raw25 = rows(`select sum(c.total) from monthly_reports r join monthly_report_counts c on c.report_id = r.id where r.kind = 'municipal_total' and r.status = 'submitted' and r.year = 2025`)[0][0];
    const rawGN = rows(`select sum(guest_nights) from monthly_reports where kind = 'municipal_total' and status = 'submitted' and year = 2025`)[0][0];
    ok(y25.baseline && y25.baseline.periods[0].figures.arrivals === +raw25, `baseline arrivals = the paper total (${raw25})`, y25.baseline && y25.baseline.periods[0]);
    ok(y25.baseline.periods[0].figures.guestNights === +rawGN, `baseline guest nights = ${rawGN}`);
    ok(y25.periods[0].figures === null && y25.periods[0].municipalTotal === true, 'enterprise series does not receive the paper total (no double count)');
    ok(!('sex' in y25.baseline.periods[0].figures), 'the paper total has no invented sex split');
    const y25m = (await call('/analytics/accommodation?from=2025-12&to=2025-12', officer)).data;
    ok(y25m.baseline.periods[0].figures.arrivals === 2403, 'December 2025: 2,403 arrivals as on paper');
    const filtered25 = (await call('/analytics/accommodation?from=2025-01&to=2025-12&barangay=poblacion', officer)).data;
    ok(filtered25.baseline === null, 'a filtered view never shows the municipal paper total');
    const mgr25 = (await call('/analytics/accommodation?from=2025-01&to=2025-12', maria)).data;
    ok(mgr25.baseline === null, 'a manager never sees the municipal paper total');

    console.log('\nAccommodation: manager scope');
    const m = (await call('/analytics/accommodation' + Q + '&mode=operational', maria)).data;
    ok(m.places === 2, 'Maria sees her two places to stay only', m.places);
    ok(m.periods.find(p => p.key === '2026-08').figures.arrivals === 11, 'Maria\'s August = Lavanya only (Juan Inn is not hers)');
    ok((await call('/analytics/accommodation?spotId=' + SPOT.juan, maria)).status === 403, 'another manager\'s enterprise: 403');
    ok((await call('/analytics/accommodation?spotId=' + SPOT.falls, maria)).status === 403, 'an attraction id on the accommodation route: refused');
    const mp = (await call('/analytics/accommodation/places' + Q + '&mode=operational', maria)).data;
    ok(mp.byPlace.length === 2 && mp.byPlace.every(p => ['Lavanya Resort', 'Sea Horizon Beach Resort'].includes(p.place.name)), 'manager places list holds only own enterprises');
    const op2 = (await call('/analytics/accommodation/places' + Q + '&mode=operational', officer)).data;
    const lav = op2.byPlace.find(p => p.place.name === 'Lavanya Resort');
    ok(lav.value === 11 + 8 + 16 + 1, 'places: Lavanya arrivals = 36 over the four months', lav);
    ok(op2.byPlace.find(p => p.place.name === 'Sea Horizon Beach Resort').value === null, 'a place that never reported has value null, not 0');
    ok(op2.byBarangay.reduce((a, b) => a + (b.value || 0), 0) === op2.byPlace.reduce((a, b) => a + (b.value || 0), 0), 'barangay groups add up to the places (no double counting)');

    console.log('\nBenchmark and stays (manager only)');
    ok((await call('/analytics/accommodation/benchmark?spotId=' + SPOT.lavanya + '&from=2026-08&to=2026-11', officer)).status === 403, 'officer: no benchmark route');
    const bm = (await call('/analytics/accommodation/benchmark?spotId=' + SPOT.lavanya + '&from=2026-08&to=2026-11', maria)).data;
    ok(bm && bm.months.every(x => x.municipal.suppressed === true && x.municipal.arrivals === null), 'municipal comparison suppressed below the minimum group (3 finalized places)', bm && bm.months[1]);
    ok((await call('/analytics/accommodation/benchmark?spotId=' + SPOT.juan + '&from=2026-08&to=2026-11', maria)).status === 403, 'benchmark of someone else\'s place: 403');
    const st = await call('/analytics/accommodation/stays?spotId=' + SPOT.lavanya + '&from=2026-08-01&to=2026-10-31', maria);
    ok(st.status === 200, 'stays pattern for own enterprise');
    const rawArr = +rows(`select coalesce(sum(g.male + g.female), 0) from accommodation_stay_guests g join accommodation_stays s on s.id = g.stay_id where s.spot_id = '${SPOT.lavanya}' and s.status = 'active' and g.starts_on between '2026-08-01' and '2026-10-31'`)[0][0];
    ok(st.data.arrivals.total === rawArr, `stay-level arrivals equal the register's guest rows (${rawArr})`, st.data.arrivals.total);
    ok((await call('/analytics/accommodation/stays?spotId=' + SPOT.lavanya + '&from=2026-08-01&to=2026-10-31', officer)).status === 403, 'officer does not read stay-level detail');
    ok((await call('/analytics/accommodation/stays?spotId=' + SPOT.juan + '&from=2026-08-01&to=2026-10-31', maria)).status === 403, 'stay-level for another manager\'s place: 403');
    ok(st.data.arrivals.days.every(d => d.value === null || Number.isInteger(d.value)) && st.data.arrivals.days.filter(d => d.value === null).length >= 0, 'days before reporting start are null');

    console.log('\nAttractions: official');
    const att = (await call('/analytics/attractions?from=2026-08&to=2026-11', officer)).data;
    ok(att && att.success && att.periods.length === 4, 'attraction series');
    const aBy = k => att.periods.find(p => p.key === k);
    ok(aBy('2026-10').figures.visits === 1681, 'October: Test Pool\'s finalized total 1,681');
    ok(aBy('2026-10').figures.residence.zamboanguita === 20 && aBy('2026-10').figures.residence.foreign === 15 && aBy('2026-10').figures.residenceUnrecorded === 1591, 'residence classes and the unrecorded part stay apart (20, 15, 1,591)', aBy('2026-10').figures);
    ok(aBy('2026-10').figures.sex === null && aBy('2026-10').figures.sexUnrecorded === 1681, 'no sex recorded: null, never 0 and never estimated');
    ok(aBy('2026-09').figures === null, 'September: not submitted, so null (not 0)', aBy('2026-09').figures);
    ok(aBy('2026-10').complete === false && aBy('2026-10').coverage.finalized === 1, 'October is not complete (the other counting attractions have no finalized report)', aBy('2026-10').coverage);
    ok(att.peakLow.visits.peak === null, 'no peak from incomplete months');
    const fmo = (await call('/analytics/attractions?from=2024-02&to=2024-02', officer)).data;
    ok(fmo.periods[0].figures.visits === 563, 'Test Falls February 2024: version 3 (563), not 559 and not a sum of versions', fmo.periods[0].figures);
    const raw = +rows(`select sum(total) from attraction_daily_counts where spot_id = '${SPOT.falls}' and count_date between '2024-02-01' and '2024-02-29'`)[0][0];
    ok(raw === 563, 'and it equals the daily counts it was built from (563)');
    const av = (await call('/analytics/attractions?from=2026-10&to=2026-10&mode=operational', officer)).data;
    ok(av.mode === 'operational' && av.periods[0].figures.visits >= 1681, 'operational includes at least the official figure');

    console.log('\nAttractions: Support Staff scope');
    const sp = (await call('/analytics/attractions?from=2026-08&to=2026-11&mode=operational', pool)).data;
    ok(sp.places === 1 && sp.periods.find(p => p.key === '2026-10').figures.visits === 1681, 'Test Pool\'s staff see their one attraction');
    const sf = (await call('/analytics/attractions?from=2024-02&to=2024-02', pool)).data;
    ok(sf.periods[0].figures === null, 'Test Pool\'s staff cannot see Test Falls\' 2024 figures');
    ok((await call('/analytics/attractions?spotId=' + SPOT.falls, pool)).status === 403, 'another attraction\'s id: 403');
    ok((await call('/analytics/attractions?from=2024-02&to=2024-02&mode=official', falls)).data.periods[0].figures.visits === 563, 'Test Falls\' own staff see 563');

    console.log('\nAttractions: daily pattern');
    const d = (await call('/analytics/attractions/daily?from=2026-10-01&to=2026-10-31', pool)).data;
    const rawDaily = rows(`select count_date, total from attraction_daily_counts where spot_id = '${SPOT.pool}' and count_date between '2026-10-01' and '2026-10-31' order by 1`);
    ok(d.days.length === 31, '31 days');
    ok(d.summary.visits === rawDaily.reduce((a, r) => a + +r[1], 0), `daily total = the daily counts (${rawDaily.reduce((a, r) => a + +r[1], 0)}) = the submitted month`, d.summary);
    ok(d.summary.visits === 1681, 'and equals the finalized month (1,681)');
    ok(d.days.every(x => x.value === null || Number.isInteger(x.value)) && d.summary.recordedDays === rawDaily.length, 'recorded days match the rows');
    ok(d.weekdays.reduce((a, w) => a + w.days, 0) === d.summary.recordedDays, 'weekday means use recorded days only');
    ok(d.rolling7.length === 31, 'rolling average per day');
    ok((await call('/analytics/attractions/daily?from=2026-10-01&to=2026-10-31&spotId=' + SPOT.falls, pool)).status === 403, 'staff of another attraction: 403 on daily');
    ok((await call('/analytics/attractions/daily?from=2026-10-01&to=2026-10-31', officer)).status === 400, 'officer must name the attraction');
    const od = (await call('/analytics/attractions/daily?from=2026-10-01&to=2026-10-31&spotId=' + SPOT.pool, officer)).data;
    ok(od.summary.visits === 1681, 'officer reads the same daily figures');
    const ap = (await call('/analytics/attractions/places?from=2026-10&to=2026-10', officer)).data;
    ok(ap.byPlace.find(p => p.place.name === 'Test Pool').value === 1681 && ap.byPlace.find(p => p.place.name === 'Test Falls').value === null, 'places: Pool 1,681; Falls null for the month');

    console.log('\nReservations');
    const rv = (await call('/analytics/reservations?from=2026-01&to=2026-11', officer)).data;
    const rawB = rows(`select b.status, count(*) from bookings b join spots s on s.id = b.spot_id where s.type = 'accommodation' and s.managed_by is not null and (b.requested_at at time zone 'Asia/Manila')::date between '2026-01-01' and '2026-11-30' group by 1`);
    const rawTotal = rawB.reduce((a, r) => a + +r[1], 0);
    ok(rv.total.requests === rawTotal, `reservations total = the bookings table (${rawTotal})`, rv.total);
    ok(rv.months.reduce((a, x) => a + x.requests, 0) === rawTotal, 'months add up to the total');
    ok(JSON.stringify(rv).indexOf('guest') === -1 && !/@/.test(JSON.stringify(rv)), 'no guest names or emails in reservations');
    ok(!('arrivals' in rv.total), 'reservations never carry arrivals');
    const rm = (await call('/analytics/reservations?from=2026-01&to=2026-11', maria)).data;
    const rawM = +rows(`select count(*) from bookings b join spots s on s.id = b.spot_id where s.managed_by = (select id from establishment_managers where email = 'maria@x.test') and s.type = 'accommodation' and (b.requested_at at time zone 'Asia/Manila')::date between '2026-01-01' and '2026-11-30'`)[0][0];
    ok(rm.total.requests === rawM, `manager's reservations are only their own (${rawM})`, rm.total);

    console.log('\nCoverage');
    const cv = (await call('/analytics/coverage', officer)).data;
    ok(cv.gaps.length === 5 && cv.gaps.every(g => Number.isInteger(g.count)), 'five gap counts');
    ok(cv.gaps.find(g => g.id === 'private_attractions').count === +rows(`select count(*) from spots where type = 'spot' and status = 'published' and managed_by is not null`)[0][0], 'manager-run attractions match the table');

    console.log('\nExports equal the screens');
    const xa = await call('/analytics/accommodation/export.xlsx?from=2026-08&to=2026-11&mode=operational', officer);
    ok(xa.status === 200 && /spreadsheetml/.test(xa.type) && xa.buf.slice(0, 2).toString() === 'PK', 'accommodation Excel downloads');
    const ExcelJS = require('../../../zamboanguita-backend/node_modules/exceljs');
    let wb = new ExcelJS.Workbook(); await wb.xlsx.load(xa.buf);
    let ws = wb.getWorksheet('Periods');
    const cells = []; ws.eachRow(r => cells.push(r.values.slice(1)));
    const hi = cells.findIndex(r => r[0] === 'Period'), head = cells[hi], tbl = cells.slice(hi + 1, hi + 5);
    ok(head[0] === 'Period' && tbl.length === 4, 'sheet header and four period rows');
    ok(tbl.every((r, i) => (r[1] === null || r[1] === undefined ? op.periods[i].figures === null : r[1] === op.periods[i].figures.arrivals)), 'Excel arrivals = the screen\'s arrivals, month by month (blank = not reported)', tbl.map(r => r[1]));
    ok(tbl.every((r, i) => (r[2] ?? null) === (op.periods[i].figures ? op.periods[i].figures.guestNights : null)), 'Excel guest nights = the screen', { tbl: tbl.map(r => r.slice(0, 4)), screen: op.periods.map(p => p.figures && p.figures.guestNights) });
    const xt = await call('/analytics/attractions/export.xlsx?from=2026-08&to=2026-11', officer);
    wb = new ExcelJS.Workbook(); await wb.xlsx.load(xt.buf); ws = wb.getWorksheet('Periods');
    const ac0 = []; ws.eachRow(r => ac0.push(r.values.slice(1)));
    const ah = ac0.findIndex(r => r[0] === 'Period'), aT = ac0.slice(ah + 1, ah + 5);
    ok(aT[1][0] === 'September 2026' && aT[1][1] == null, 'Excel September visits blank (not 0)', aT[1]);
    ok(aT[2][0] === 'October 2026' && aT[2][1] === 1681, 'Excel October visits 1,681 = the screen', aT[2]);
    ok((await call('/analytics/attractions/export.xlsx?from=2026-08&to=2026-11', maria)).status === 403, 'manager cannot export attractions');

    console.log('\nInput safety and bounds');
    for (const bad of ['from=2026-13&to=2026-14', 'from=2026-12&to=2026-01', 'from=2000-01&to=2100-12', 'granularity=week', 'mode=all', "barangay='%3Bdrop%20table%20spots--" + '%20'.repeat(0), 'spotId=zzz', 'category=BOATS', 'bbox=1,2,3', 'bbox=5,5,1,1', 'extra=1', 'from=2026-01&from=2026-02', 'compare=lastweek']) {
        const r = await call('/analytics/accommodation?' + bad, officer);
        ok(r.status === 400 || (r.status === 200 && /barangay/.test(bad)), `refused or harmless: ${bad.slice(0, 40)}`, r.status);
    }
    ok(sql(`select count(*) from spots`) === '9', 'injection attempt left the spots table intact');
    ok((await call('/analytics/accommodation?from=2023-01&to=2026-12', officer)).status === 400, 'more than 36 months is refused');
    ok((await call('/analytics/attractions/daily?from=2025-01-01&to=2026-12-31&spotId=' + SPOT.pool, officer)).status === 400, 'more than 366 days is refused');
    const err = (await call('/analytics/accommodation?spotId=' + '0'.repeat(24), officer));
    ok(err.status === 404 && !/select|from spots|pg_|stack/i.test(JSON.stringify(err.data)), 'unknown id: a plain 404, no SQL in the message');

    console.log('\nQuery count (efficiency)');
    const t0 = Date.now(); await call('/analytics/accommodation?from=2026-01&to=2026-11&compare=previous-year&mode=operational', officer); const tA = Date.now() - t0;
    const t1 = Date.now(); await call('/analytics/attractions?from=2026-01&to=2026-11&mode=operational', officer); const tT = Date.now() - t1;
    ok(tA < 2500 && tT < 4000, `an 11-month series with comparison answers in ${tA} ms (accommodation) and ${tT} ms (attractions)`);

    sql(`delete from visitors where email = 'analytics.visitor@x.test'`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
