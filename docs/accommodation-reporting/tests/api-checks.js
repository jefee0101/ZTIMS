// Accommodation reporting: real API calls against a LOCAL API (:8080) and LOCAL database only.
// Never point it at the live database: it clears the accommodation_* tables first.
// Needs DATABASE_URL (local), TEST_MANAGER_PASSWORD (maria@x.test and juan@x.test), TEST_OFFICER_PASSWORD
// (officer@lgu.test), the 2025 import (scripts/import-form-a4.js) and two private places to stay of maria's.
const { execFileSync } = require('child_process');
const API = 'http://localhost:8080/api';
const DB = process.env.DATABASE_URL;
const sql = q => execFileSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-Atc', q], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const sqlErr = q => { try { sql(q); return ''; } catch (e) { return String(e.stderr || e.message); } };
let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗', label, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)); } };
let ipn = 1;
async function call(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.90.0.' + (ipn++ % 250) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await r.json(); } catch {}
    return { status: r.status, data };
}
const login = async (email, password) => (await call('POST', '/login', { email, password, role: 'staff' })).data.token;

const SPOT = '5b623f31b0f74d0bb5630dbe', OTHER = '2f9d15101bf34b3382a3b6b4';

(async () => {
    // ---- clean slate for the new tables only (local test database) ----
    sql(`set session_replication_role = replica; delete from accommodation_changes; delete from accommodation_period_events; delete from accommodation_periods;
         delete from accommodation_report_version_counts; delete from accommodation_report_versions; delete from accommodation_stay_guests; delete from accommodation_stay_rooms;
         delete from accommodation_stays; delete from accommodation_room_unavailability; delete from accommodation_closed_periods; delete from accommodation_rooms; delete from accommodation_profiles;
         delete from rate_limits;`);
    // juan gets a place to stay of his own (local only), for the cross-enterprise checks.
    const juanId = sql(`select id from establishment_managers where email = 'juan@x.test'`);
    const JUAN = sql(`select id from spots where managed_by = '${juanId}' and type = 'accommodation' limit 1`) ||
        sql(`insert into spots (title, location, description, type, category, barangay, status, managed_by, enterprise_name) select 'Juan Inn', location, description, 'accommodation', category, barangay, 'published', '${juanId}', 'Juan Inn' from spots where id = '${SPOT}' returning id`).split('\n')[0];
    const maria = await login('maria@x.test', process.env.TEST_MANAGER_PASSWORD);
    const juan = await login('juan@x.test', process.env.TEST_MANAGER_PASSWORD);
    const officer = await login('officer@lgu.test', process.env.TEST_OFFICER_PASSWORD);
    ok(maria && juan && officer, 'three staff sign-ins');

    console.log('Preserved 2025 data (same as live)');
    ok(sql(`select count(*)||'/'||sum((select count(*) from monthly_report_counts c where c.report_id=r.id)) from monthly_reports r where kind='municipal_total' and year=2025`) === '12/321', '12 municipal months, 321 residence rows');
    const before2025 = sql(`select md5(string_agg(r.id||r.month||r.rooms||r.room_nights_occupied||r.guest_nights||c.residence_code||c.total, ',' order by r.month, c.residence_code)) from monthly_reports r join monthly_report_counts c on c.report_id=r.id where r.kind='municipal_total'`);

    console.log('Profile, rooms, out of service, closed');
    let r = await call('POST', `/accommodation/${SPOT}/stays`, { checkIn: '2026-08-01', checkOut: '2026-08-02', rooms: [], guests: [] }, maria);
    ok(r.status === 409 && r.data.code === 'NOT_SET_UP', 'no stays before the profile', r.data);
    r = await call('PUT', `/accommodation/${SPOT}/profile`, { accommodationType: 'resort', reportingFrom: '2026-08' }, maria);
    ok(r.status === 200 && r.data.profile.reportingFrom === '2026-08-01', 'profile saved', r.data);
    r = await call('PUT', `/accommodation/${SPOT}/profile`, { accommodationType: 'resort', reportingFrom: '2026-08' }, juan);
    ok(r.status === 403, "another manager cannot edit Maria's profile");
    const room = {};
    for (const [n, s, shared] of [['101', 2], ['102', 2], ['103', 2], ['201', 4], ['202', 4], ['301', 3], ['D1', 6, true]]) {
        r = await call('POST', `/accommodation/${SPOT}/rooms`, { roomNumber: n, sleeps: s, shared: !!shared, availableFrom: '2026-01-01' }, maria);
        room[n] = r.data.room && r.data.room._id;
    }
    ok(Object.values(room).every(Boolean), 'seven rooms added (D1 shared)');
    r = await call('POST', `/accommodation/${SPOT}/rooms`, { roomNumber: '101', sleeps: 2, availableFrom: '2026-01-01' }, maria);
    ok(r.status === 409, 'duplicate room number refused');
    r = await call('POST', `/accommodation/${SPOT}/rooms`, { roomNumber: '999', sleeps: 2, availableFrom: '2026-01-01' }, officer);
    ok(r.status === 403, 'officer cannot add rooms');
    r = await call('POST', `/accommodation/${JUAN}/rooms`, { roomNumber: 'J1', sleeps: 2, availableFrom: '2026-01-01' }, juan);
    const juanRoom = r.data.room._id;
    r = await call('POST', `/accommodation/${SPOT}/out-of-service`, { roomId: room['301'], startsOn: '2026-09-15', endsOn: '2026-10-05', reason: 'Renovation' }, maria);
    ok(r.status === 201, 'room 301 out of service 15 Sep to 5 Oct', r.data);
    r = await call('POST', `/accommodation/${SPOT}/closed-periods`, { startsOn: '2026-07-01', endsOn: '2026-07-31', reason: 'Closed for repairs' }, maria);
    ok(r.status === 201, 'closed all of July', r.data);

    console.log('Stays');
    const g = (residence, male, female, from, until) => ({ residence, male, female, from, until });
    const stay = async (checkIn, checkOut, rooms, guests, tok = maria) => call('POST', `/accommodation/${SPOT}/stays`, { checkIn, checkOut, rooms, guests }, tok);
    const R = (id, from, until) => ({ roomId: room[id], from, until });
    const made = {};
    const plan = [
        ['a1', '2026-08-08', '2026-08-11', [R('102')], [g('ph-filipino', 1, 1)]],
        ['a2', '2026-08-15', '2026-08-18', [R('201')], [g('KR', 2, 2)]],
        ['a3', '2026-08-22', '2026-08-24', [R('301')], [g('CA', 1, 1)]],
        ['a4', '2026-08-28', '2026-09-02', [R('103')], [g('ph-filipino', 2, 1)]],
        ['b1', '2026-09-05', '2026-09-07', [R('101')], [g('overseas-filipino', 1, 1)]],
        ['b2', '2026-09-12', '2026-09-15', [R('202')], [g('DE', 1, 1)]],
        ['b3', '2026-09-27', '2026-10-01', [R('201')], [g('JP', 1, 2)]],
        // dated change in guests: one joins on 4 Oct, one leaves on 5 Oct
        ['c1', '2026-10-03', '2026-10-06', [R('103')], [g('ph-filipino', 1, 1), g('ph-filipino', 0, 1, '2026-10-04'), g('ph-foreign', 1, 0, '2026-10-03', '2026-10-05')]],
        ['c2', '2026-10-12', '2026-10-15', [R('202')], [g('US', 2, 0)]],
        // two parties sharing the dormitory the same nights: one room-night each night
        ['c3', '2026-10-20', '2026-10-22', [R('D1')], [g('DE', 1, 1)]],
        ['c4', '2026-10-20', '2026-10-22', [R('D1')], [g('AU', 2, 0)]],
        // across the month end, with a transfer on 1 Nov: one arrival, nights split
        ['c5', '2026-10-29', '2026-11-03', [R('202', '2026-10-29', '2026-11-01'), R('201', '2026-11-01', '2026-11-03')], [g('ph-filipino', 2, 2)]],
        ['d1', '2026-11-01', '2026-11-04', [R('102')], [g('AU', 1, 1)]]
    ];
    for (const [k, i, o, rooms, guests] of plan) { r = await stay(i, o, rooms, guests); made[k] = r.data.stay; if (r.status !== 201) console.log(k, r.status, r.data); }
    ok(Object.values(made).every(Boolean), `${plan.length} stays recorded`);
    ok(made.c5.reference === 'ST-000012', 'references count up per enterprise', made.c5.reference);
    // refusals
    r = await stay('2026-11-02', '2026-11-03', [R('201')], [g('ph-filipino', 1, 0)]);
    ok(r.status === 409 && r.data.code === 'ROOM_TAKEN', 'room already taken that night', r.data);
    r = await stay('2026-10-01', '2026-10-03', [R('301')], [g('ph-filipino', 1, 0)]);
    ok(r.status === 409 && r.data.code === 'ROOM_OUT_OF_SERVICE', 'room out of service', r.data);
    r = await stay('2026-07-10', '2026-07-12', [R('101')], [g('ph-filipino', 1, 0)]);
    ok(r.status === 409 && r.data.code === 'BEFORE_REPORTING', 'a stay before reporting starts is refused', r.data);
    r = await call('POST', `/accommodation/${SPOT}/closed-periods`, { startsOn: '2026-11-05', endsOn: '2026-11-05', reason: 'Typhoon' }, maria);
    const cp = r.data._id;
    r = await stay('2026-11-04', '2026-11-06', [R('101')], [g('ph-filipino', 1, 0)]);
    ok(r.status === 409 && r.data.code === 'PLACE_CLOSED', 'no stay over a closed day', r.data);
    r = await call('POST', `/accommodation/${SPOT}/closed-periods`, { startsOn: '2026-11-02', endsOn: '2026-11-02', reason: 'Typhoon' }, maria);
    ok(r.status === 409 && r.data.code === 'STAY_IN_PERIOD', 'no closed day over a stay', r.data);
    r = await call('POST', `/accommodation/closed-periods/${cp}/void`, { reason: 'Opened after all' }, maria);
    ok(r.status === 200 && sql(`select void_reason from accommodation_closed_periods where id = '${cp}'`) === 'Opened after all', 'a closed period is voided with a reason, not deleted');
    ok(/NO_DELETE/.test(sqlErr(`delete from accommodation_closed_periods where id = '${cp}'`)), 'the database refuses deleting it');
    r = await stay('2026-11-20', '2026-11-22', [R('101')], [g('ph-filipino', 1, 0)]);
    ok(r.status === 400 && r.data.code === 'FUTURE_ARRIVAL', 'check-in after today refused (a booking is not an arrival)', r.data);
    r = await stay('2026-10-24', '2026-10-26', [R('101', '2026-10-24', '2026-10-25')], [g('ph-filipino', 1, 0)]);
    ok(r.status === 400 && r.data.code === 'NIGHT_WITHOUT_ROOM', 'every night needs a room', r.data);
    r = await stay('2026-10-24', '2026-10-26', [R('101')], [g('ph-filipino', 1, 0, '2026-10-25')]);
    ok(r.status === 400 && r.data.code === 'STAY_GUEST_DATES', 'someone must arrive at check-in', r.data);
    r = await stay('2026-10-24', '2026-10-26', [R('101')], [g('ph-filipino', 1.5, 0)]);
    ok(r.status === 400, 'fractional count refused');
    r = await stay('2026-10-24', '2026-10-26', [R('101')], [g('ph-filipino', -1, 2)]);
    ok(r.status === 400, 'negative count refused');
    r = await stay('2026-10-24', '2026-10-26', [{ roomId: juanRoom }], [g('ph-filipino', 1, 0)]);
    ok(r.status === 400 && r.data.code === 'BAD_ROOMS', "another enterprise's room refused", r.data);
    r = await stay('2026-10-24', '2026-10-26', [R('101')], [g('XX', 1, 0)]);
    ok(r.status === 400, 'unknown residence refused');
    r = await stay('2026-10-24', '2026-10-26', [R('101')], [g('ph-filipino', 1, 0)], officer);
    ok(r.status === 403, 'officer cannot record a stay');
    r = await call('POST', `/accommodation/${SPOT}/stays`, { checkIn: '2026-10-24', checkOut: '2026-10-26', rooms: [R('101')], guests: [g('ph-filipino', 1, 0)] }, juan);
    ok(r.status === 403, "another manager cannot record in Maria's enterprise");
    const [p1, p2] = await Promise.all([stay('2026-10-24', '2026-10-26', [R('101')], [g('ph-filipino', 1, 0)]), stay('2026-10-25', '2026-10-27', [R('101')], [g('JP', 1, 0)])]);
    ok([p1.status, p2.status].sort().join() === '201,409', 'two requests for the same room at once: one wins', [p1.status, p2.status, p1.data.code, p2.data.code]);
    made.race = (p1.status === 201 ? p1 : p2).data.stay;

    console.log('Figures (oracle: independent loops over the stays)');
    const month = async (y, m, tok = maria) => (await call('GET', `/accommodation/${SPOT}/months/${y}/${m}`, null, tok)).data;
    const all = sql(`select json_agg(json_build_object('id', s.id, 'in', s.check_in, 'out', s.check_out,
                      'rooms', (select json_agg(json_build_object('room', a.room_id, 'from', a.starts_on, 'until', a.ends_on)) from accommodation_stay_rooms a where a.stay_id = s.id),
                      'guests', (select json_agg(json_build_object('m', g.male, 'f', g.female, 'from', g.starts_on, 'until', g.ends_on)) from accommodation_stay_guests g where g.stay_id = s.id)))
                     from accommodation_stays s where s.spot_id = '${SPOT}' and s.status = 'active'`);
    const stays = JSON.parse(all);
    function oracle(y, m) {
        const days = new Date(Date.UTC(y, m, 0)).getUTCDate(); let arr = 0, gn = 0, rn = 0;
        for (let d = 1; d <= days; d++) {
            const D = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const rooms = new Set();
            for (const s of stays) { for (const x of s.guests) { if (x.from === D) arr += x.m + x.f; if (x.from <= D && D < x.until) gn += x.m + x.f; }
                                     for (const a of s.rooms) if (a.from <= D && D < a.until) rooms.add(a.room); }
            rn += rooms.size;
        }
        return { arr, gn, rn };
    }
    for (const [y, m] of [[2026, 8], [2026, 9], [2026, 10]]) {
        const f = (await month(y, m)).figures, o = oracle(y, m);
        ok(f.arrivals === o.arr && f.guestNights === o.gn && f.roomNightsOccupied === o.rn, `${y}-${m}: arrivals ${f.arrivals}, guest-nights ${f.guestNights}, room-nights ${f.roomNightsOccupied}`, { f: [f.arrivals, f.guestNights, f.roomNightsOccupied], o });
    }
    const oct = await month(2026, 10);
    ok(oct.figures.daily[19].roomsOccupied === 1 && oct.figures.daily[19].guestNights === 4, 'shared dormitory, 20 Oct: 4 guests in one room-night', oct.figures.daily[19]);
    ok(oct.figures.daily[3].checkIn === 1 && oct.figures.daily[2].checkIn === 3, 'guest joining on 4 Oct is an arrival that day; 3 arrived on 3 Oct', [oct.figures.daily[2].checkIn, oct.figures.daily[3].checkIn]);
    ok(oct.figures.daily[3].guestNights === 4 && oct.figures.daily[4].guestNights === 3, 'guest leaving 5 Oct: 4 guests the 4th, 3 the 5th', [oct.figures.daily[3].guestNights, oct.figures.daily[4].guestNights]);
    ok(oct.figures.roomNightsAvailable === 7 * 31 - 5, 'October available: 7 rooms × 31 − 5 nights out of service', oct.figures.roomNightsAvailable);
    const nov = await month(2026, 11);
    ok(nov.figures.counts['ph-filipino'] === undefined && nov.figures.daily[0].roomsOccupied === 2, 'November: the 29 Oct family is not a November arrival; transfer keeps one room a night', [nov.figures.counts, nov.figures.daily[0].roomsOccupied]);
    ok(nov.figures.partial === true && nov.figures.through === '2026-11-10', 'November in progress: nights through yesterday', nov.figures.through);
    const jul = await month(2026, 7);
    ok(jul.state.state === 'not_operating' && jul.figures.roomNightsAvailable === 0, 'July: not operating, not zero arrivals', jul.state);
    const jun = await month(2026, 6);
    ok(jun.state.state === 'not_recorded', 'June: before reporting started (missing, not zero)', jun.state);
    ok(Math.abs(oct.figures.occupancyRate - oct.figures.roomNightsOccupied / oct.figures.roomNightsAvailable) < 1e-12 && Math.abs(oct.figures.averageLengthOfStay - oct.figures.guestNights / oct.figures.arrivals) < 1e-12, 'monthly rates are the template ratios');

    console.log('Submissions, versions, finalize, reopen');
    r = await call('POST', `/accommodation/${SPOT}/months/2026/11/submit`, { expectedVersion: 1 }, maria);
    ok(r.status === 409, 'November cannot be submitted before it ends', r.data);
    const [s1, s2] = await Promise.all([call('POST', `/accommodation/${SPOT}/months/2026/8/submit`, { expectedVersion: 0 }, maria), call('POST', `/accommodation/${SPOT}/months/2026/8/submit`, { expectedVersion: 0 }, maria)]);
    ok([s1.status, s2.status].sort().join() === '201,409', 'the same submission twice at once: one version', [s1.status, s2.status, s2.data.code]);
    r = await call('POST', `/accommodation/${SPOT}/months/2026/8/submit`, { expectedVersion: 1, reason: 'again' }, maria);
    ok(r.status === 409 && r.data.code === 'ALREADY_SUBMITTED', 'resubmitting an unchanged month refused', r.data);
    for (const m of [9, 10]) { r = await call('POST', `/accommodation/${SPOT}/months/2026/${m}/submit`, { expectedVersion: 0 }, maria); ok(r.status === 201 && r.data.state.state === 'submitted', `2026-${m} submitted as v1`); }
    r = await call('POST', `/accommodation/${SPOT}/months/2026/9/submit`, { expectedVersion: 0 }, officer);
    ok(r.status === 403, 'officer cannot submit for an enterprise');
    r = await call('POST', `/accommodation/${SPOT}/months/2026/9/finalize`, { expectedVersion: 1 }, maria);
    ok(r.status === 403, 'manager cannot finalize');
    r = await call('POST', `/accommodation/${SPOT}/months/2026/9/finalize`, { expectedVersion: 1 }, officer);
    ok(r.status === 200 && r.data.state.state === 'finalized', 'officer finalizes September v1', r.data.state);
    const sepV1 = sql(`select md5(row(v.*)::text) from accommodation_report_versions v where spot_id='${SPOT}' and year=2026 and month=9`);

    // Finalized: nothing that changes September moves.
    const b3 = made.b3, a4 = made.a4;
    r = await call('PUT', `/accommodation/stays/${b3._id}`, { ...b3, reason: 'Correction', revision: b3.revision, checkOut: '2026-10-02', rooms: [{ roomId: room['201'], from: b3.checkIn, until: '2026-10-02' }], guests: [g('JP', 1, 2, b3.checkIn, '2026-10-02')] }, maria);
    ok(r.status === 409 && r.data.code === 'PERIOD_FINALIZED' && r.data.month === '2026-09', 'a stay with September nights cannot change', r.data);
    r = await call('POST', `/accommodation/stays/${a4._id}/void`, { reason: 'mistake', revision: a4.revision }, maria);
    ok(r.status === 409 && r.data.code === 'PERIOD_FINALIZED', 'nor be voided');
    r = await call('POST', `/accommodation/${SPOT}/out-of-service`, { roomId: room['101'], startsOn: '2026-09-20', endsOn: '2026-09-21', reason: 'Leak' }, maria);
    ok(r.status === 409 && r.data.code === 'PERIOD_FINALIZED', 'no out-of-service inside September');
    r = await call('PATCH', `/accommodation/rooms/${room['D1']}`, { availableUntil: '2026-09-10' }, maria);
    ok(r.status === 409, 'room availability cannot end inside September', r.data);
    r = await call('POST', `/accommodation/${SPOT}/rooms`, { roomNumber: '401', sleeps: 2, availableFrom: '2026-09-01' }, maria);
    ok(r.status === 409 && r.data.code === 'PERIOD_FINALIZED', 'a room cannot be added back into September');
    ok(/PERIOD_FINALIZED/.test(sqlErr(`update accommodation_stays set check_out = '2026-09-03' where id = '${a4._id}'`)), 'the database refuses it too, without the API');
    ok(/IMMUTABLE/.test(sqlErr(`update accommodation_report_versions set arrivals = 0 where spot_id = '${SPOT}'`)), 'a saved version cannot be updated');
    ok(/IMMUTABLE/.test(sqlErr(`delete from accommodation_report_versions where spot_id = '${SPOT}'`)), 'nor deleted');
    ok(/IMMUTABLE/.test(sqlErr(`delete from accommodation_period_events`)), 'events cannot be deleted');
    ok(/COUNTS_DO_NOT_ADD_UP/.test(sqlErr(`begin; insert into accommodation_report_versions (spot_id, year, month, version, provenance, rooms, room_nights_available, room_nights_occupied, guest_nights, arrivals) values ('${SPOT}', 2026, 6, 1, 'register', 7, 210, 0, 0, 5); commit;`)), 'a version whose residence counts do not add up is refused');

    // A correction across two periods: c5 (29 Oct to 3 Nov) gains a guest who was there from the start.
    const c5 = made.c5;
    r = await call('PUT', `/accommodation/stays/${c5._id}`, { ...c5, revision: c5.revision, guests: [g('ph-filipino', 2, 3)] }, maria);
    ok(r.status === 400 && r.data.code === 'BAD_REASON', 'a change needs a reason');
    r = await call('PUT', `/accommodation/stays/${c5._id}`, { ...c5, revision: c5.revision, reason: 'One more guest from the start', guests: [g('ph-filipino', 2, 3)] }, maria);
    ok(r.status === 200, 'stay corrected', r.data);
    const aff = r.data.affected || [];
    ok(aff.map(a => a.month).join() === '2026-10,2026-11', 'every affected period is named', aff.map(a => a.month));
    ok(aff[0].state === 'changed' && aff[0].differences.some(d => d.field === 'arrivals' && d.saved + 1 === d.now), 'October now differs from v1', aff[0]);
    r = await call('PUT', `/accommodation/stays/${c5._id}`, { ...c5, revision: c5.revision, reason: 'stale', guests: [g('ph-filipino', 2, 2)] }, maria);
    ok(r.status === 409 && r.data.code === 'STALE', 'an edit made from an old copy is refused');
    r = await call('POST', `/accommodation/${SPOT}/months/2026/10/finalize`, { expectedVersion: 1 }, officer);
    ok(r.status === 409 && r.data.code === 'REGISTER_CHANGED', 'officer cannot finalize October while it differs from v1', r.data.code);
    r = await call('POST', `/accommodation/${SPOT}/months/2026/10/submit`, { expectedVersion: 1 }, maria);
    ok(r.status === 400, 'a correction needs a reason');
    r = await call('POST', `/accommodation/${SPOT}/months/2026/10/submit`, { expectedVersion: 1, reason: 'Guest numbers corrected' }, maria);
    ok(r.status === 201 && r.data.versions.length === 2 && r.data.versions[1].figures.arrivals === r.data.versions[0].figures.arrivals + 1, 'October v2 saved; v1 kept unchanged', r.data.versions && r.data.versions.map(v => v.figures.arrivals));
    r = await call('POST', `/accommodation/${SPOT}/months/2026/10/finalize`, { expectedVersion: 2 }, officer);
    ok(r.status === 200, 'October v2 finalized');
    r = await call('POST', `/accommodation/${SPOT}/months/2026/9/reopen`, { reason: 'short' }, officer);
    ok(r.status === 400, 'reopen needs a reason of 10 characters');
    r = await call('POST', `/accommodation/${SPOT}/months/2026/9/reopen`, { reason: 'Japanese guests stayed one more night' }, officer);
    ok(r.status === 200 && r.data.state.state === 'reopened', 'September reopened with a reason');
    r = await call('POST', `/accommodation/${SPOT}/months/2026/9/finalize`, { expectedVersion: 1 }, officer);
    ok(r.status === 409 && r.data.code === 'NO_CURRENT_VERSION', 'after reopening, the enterprise must submit again before finalizing');
    // b3 also has October nights, and October is finalized: still refused, naming October.
    r = await call('PUT', `/accommodation/stays/${b3._id}`, { ...b3, reason: 'One more night', revision: b3.revision, checkOut: '2026-10-02', rooms: [{ roomId: room['201'], from: b3.checkIn, until: '2026-10-02' }], guests: [g('JP', 1, 2, b3.checkIn, '2026-10-02')] }, maria);
    ok(r.status === 409 && r.data.month === '2026-10', 'a stay reaching a still-finalized October is refused, naming it', r.data);
    // a September-only correction goes through
    r = await call('PUT', `/accommodation/stays/${made.b2._id}`, { ...made.b2, revision: made.b2.revision, reason: 'Guest numbers corrected', guests: [g('DE', 2, 1)] }, maria);
    ok(r.status === 200 && r.data.affected[0].state === 'reopened', 'September stay corrected after reopening');
    r = await call('POST', `/accommodation/${SPOT}/months/2026/9/submit`, { expectedVersion: 1, reason: 'Guest numbers corrected' }, maria);
    ok(r.status === 201 && r.data.versions.length === 2, 'September v2 submitted');
    ok(sql(`select md5(row(v.*)::text) from accommodation_report_versions v where spot_id='${SPOT}' and year=2026 and month=9 and version=1`) === sepV1, 'September v1 is byte-for-byte what it was');
    r = await call('POST', `/accommodation/${SPOT}/months/2026/9/finalize`, { expectedVersion: 2 }, officer);
    ok(r.status === 200, 'September v2 finalized');
    const ev = sql(`select string_agg(action || coalesce(':' || nullif(reason, ''), ''), ' > ' order by at, id) from accommodation_period_events where spot_id='${SPOT}' and year=2026 and month=9`);
    ok(ev === 'submitted > finalized > reopened:Japanese guests stayed one more night > submitted:Guest numbers corrected > finalized', 'September history: who did what, in order', ev);
    ok(sql(`select count(*) from accommodation_changes where entity='stay' and entity_id='${c5._id}' and action='edited' and affected_months = '{2026-10,2026-11}'`) === '1', 'the stay change log names both months');
    ok(sql(`select count(*) from accommodation_changes where (before::text || after::text) ~* '(name|email|phone)'`) === '0', 'no personal details in the change log');

    console.log('Enterprise year');
    r = await call('GET', `/accommodation/${SPOT}/year/2026`, null, maria);
    const y = r.data;
    const vs = y.months.filter(m => m.latestVersion).map(m => m.latestVersion.figures);
    const occ = vs.reduce((a, v) => a + v.roomNightsOccupied, 0) / vs.reduce((a, v) => a + v.roomNightsAvailable, 0);
    const avgOfRates = vs.reduce((a, v) => a + v.roomNightsOccupied / v.roomNightsAvailable, 0) / vs.length;
    ok(Math.abs(y.totals.occupancyRate - occ) < 1e-12 && Math.abs(y.totals.occupancyRate - avgOfRates) > 1e-6, 'annual occupancy is Σ occupied ÷ Σ available, not the mean of monthly rates', [y.totals.occupancyRate, avgOfRates]);
    ok(y.months.map(m => m.state).slice(0, 10).join() === 'not_recorded,not_recorded,not_recorded,not_recorded,not_recorded,not_recorded,not_operating,submitted,finalized,finalized', 'month states Jan–Oct', y.months.map(m => m.state));
    ok(y.complete === false && y.totals.months === 3, 'incomplete year: totals from 3 reported months only');
    r = await call('GET', `/accommodation/${SPOT}/year/2026`, null, juan);
    ok(r.status === 403, "another manager cannot read Maria's year");
    r = await call('GET', `/accommodation/${SPOT}/year/2026`, null, officer);
    ok(r.status === 200, 'officer reads it');

    console.log('Municipal: FORM A and historical totals');
    ok(/MUNICIPAL_TOTAL_MONTH/.test(sqlErr(`begin; insert into accommodation_report_versions (spot_id, year, month, version, provenance, rooms, room_nights_available, room_nights_occupied, guest_nights, arrivals) values ('${SPOT}', 2025, 3, 1, 'register', 1, 31, 0, 0, 0); commit;`)), 'no enterprise version for a 2025 municipal month');
    ok(/ENTERPRISE_REPORTS_EXIST/.test(sqlErr(`insert into monthly_reports (kind, year, month, rooms) values ('municipal_total', 2026, 8, 1)`)), 'no municipal total for a month enterprises reported');
    r = await call('GET', '/accommodation/form-a?year=2025', null, officer);
    const a25 = r.data;
    ok(a25.grandTotal === 19298 && a25.months.every(m => m.source === 'municipal_total'), '2025: all 12 months from the paper totals, 19,298 arrivals (the rows; printed 19,308)', a25.grandTotal);
    ok(a25.comparison.comparableMonths.length === 0 && a25.rows.every(x => x.comparison === null), '2025 vs 2024: no baseline, no % difference');
    ok(a25.volumePerSex.months.length === 0 && a25.volumePerSex.notRecordedMonths.length === 12, '2025: volume per sex not recorded, not zero');
    ok(a25.partII.months[0].roomNightsAvailableDerived === true && a25.partII.months[0].roomNightsAvailable === 183 * 31, '2025 room-nights available derived from rooms × days and marked so');
    ok(a25.rows.map(x => x.code).slice(0, 3).join() === 'ph-filipino,ph-foreign,BN' && a25.rows.slice(-2).map(x => x.code).join() === 'overseas-filipino,unspecified', 'rows in the form\'s order, sections kept');
    r = await call('GET', '/accommodation/form-a?year=2026', null, officer);
    let a26 = r.data;
    const aug = a26.months[7];
    ok(aug.source === 'enterprise_reports' && aug.complete === false && aug.missing >= 1, '2026 Aug: enterprise reports, incomplete (others missing, not zero)', aug);
    ok(a26.comparison.comparableMonths.length === 0 && a26.partII.comparison === null, 'incomplete coverage: no comparison with 2025');
    ok(a26.months[0].source === 'none' && a26.rows[0].months[0] === null, 'January 2026: no source, shown as missing', a26.months[0]);
    ok(Math.abs(a26.partII.total.occupancyRate - a26.partII.total.roomNightsOccupied / a26.partII.total.roomNightsAvailable) < 1e-12, 'FORM A annual occupancy is a ratio of sums');
    // Make August complete: every other enterprise closed all August (local test only), then compare.
    const others = sql(`select string_agg(id, ',') from spots where type='accommodation' and managed_by is not null and id <> '${SPOT}'`).split(',');
    for (const o of others) sql(`insert into accommodation_closed_periods (spot_id, starts_on, ends_on, reason) values ('${o}', '2026-08-01', '2026-08-31', 'test: closed')`);
    a26 = (await call('GET', '/accommodation/form-a?year=2026', null, officer)).data;
    ok(a26.comparison.comparableMonths.join() === '8', 'August complete: compared with August 2025 only', a26.comparison);
    const ph = a26.rows.find(x => x.code === 'ph-filipino');
    ok(ph.comparison.previous === 888 && ph.comparison.current === a26.rows.find(x => x.code === 'ph-filipino').months[7], 'Filipino residents: Aug 2026 vs Aug 2025 (888)', ph.comparison);
    ok(a26.rows.find(x => x.code === 'overseas-filipino').comparison.percentDifference === null, 'zero baseline (Aug 2025 overseas Filipinos 0): % difference unavailable');
    sql(`set session_replication_role = replica; delete from accommodation_closed_periods where reason = 'test: closed'`);

    console.log('Tracker and the old routes');
    r = await call('GET', '/accommodation/tracker?year=2026', null, officer);
    const row = r.data.enterprises.find(e => e._id === SPOT), other = r.data.enterprises.find(e => e._id === OTHER);
    ok(row.months[8].state === 'finalized' && row.months[8].latestVersion === 2 && other.months[7].state === 'not_set_up', 'tracker: per enterprise and month', [row.months[8], other.months[7]]);
    r = await call('GET', '/accommodation/tracker?year=2026', null, maria);
    ok(r.status === 403, 'managers do not see the tracker');
    r = await call('PUT', `/statistics/reports/${SPOT}/2026/10`, { rooms: 7, roomNightsOccupied: 1, guestNights: 1, counts: [{ code: 'US', male: 1, female: 0 }] }, maria);
    ok(r.status === 409 && r.data.code === 'USE_STAY_REGISTER', 'hand-typed monthly report for a place to stay: refused', r.data);
    r = await call('POST', `/statistics/register/${SPOT}`, { date: '2026-10-05', nights: 1, rooms: 1, guests: [{ code: 'US', male: 1, female: 0 }] }, maria);
    ok(r.status === 409 && r.data.code === 'USE_STAY_REGISTER', 'old Guest Register for a place to stay: refused');
    r = await call('GET', `/statistics/form-a4?year=2025`, null, officer);
    ok(r.status === 200 && r.data.municipalTotalMonths.length === 12, 'the existing Form A4 still reads 2025 as before');
    ok(sql(`select md5(string_agg(r.id||r.month||r.rooms||r.room_nights_occupied||r.guest_nights||c.residence_code||c.total, ',' order by r.month, c.residence_code)) from monthly_reports r join monthly_report_counts c on c.report_id=r.id where r.kind='municipal_total'`) === before2025, '2025 municipal data unchanged by all of the above');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
