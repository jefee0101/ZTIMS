# Reconcile the exported workbooks (recalculated by LibreOffice) with the saved versions in the database.
import json, subprocess, sys, os
from openpyxl import load_workbook
DB = os.environ['DATABASE_URL']
def sql(q): return subprocess.check_output(['psql', DB, '-Atc', q]).decode().strip()
ok = bad = 0
def check(c, label, extra=''):
    global ok, bad
    if c: ok += 1; print('  ✓', label)
    else: bad += 1; print('  ✗', label, extra)
SPOT = '5b623f31b0f74d0bb5630dbe'
v = json.loads(sql(f"select row_to_json(v) from accommodation_report_versions v where spot_id='{SPOT}' and year=2026 and month=10 and version=2"))
wb = load_workbook('xl/calc/oct-v2.xlsx', data_only=True)
def find(ws, text, col=1):
    for row in ws.iter_rows():
        c = row[col-1]
        if isinstance(c.value, str) and c.value.strip().startswith(text): return c.row
a = wb['DAE-1A']
tr = find(a, 'TOTAL OF THIS MONTH')
vals = [c.value for c in a[tr] if isinstance(c.value, (int, float))]
check(vals[-3:] == [v['arrivals'], v['guest_nights'], v['room_nights_occupied']], 'DAE-1A totals (5)(6)(7) = version arrivals, guest-nights, room-nights', (vals[-3:], v['arrivals'], v['guest_nights'], v['room_nights_occupied']))
check(a.cell(4, [c.column for c in a[4] if c.value == '(4) Total Number of Rooms :'][0] + 2).value == v['rooms'], 'DAE-1A (4) rooms = version rooms')
for name, col in (('DAE-1B (daily)', 33), ('DAE-1B DAE 2 (2019)', 2)):
    ws = wb[name]
    g = find(ws, 'GRAND TOTAL GUEST ARRIVALS')
    check(ws.cell(g, col).value == v['arrivals'], f'{name}: grand total = version arrivals ({v["arrivals"]})', ws.cell(g, col).value)
    for label, key in (('1. Rooms Occupied', 'room_nights_occupied'), ('2. Rooms available for the month', 'room_nights_available'), ('3. Total Guest nights', 'guest_nights')):
        r = find(ws, label); check(ws.cell(r, col).value == v[key], f'{name}: {label} = version {key}', (ws.cell(r, col).value, v[key]))
    r = find(ws, '1. Average Monthly Occupancy Rate'); x = ws.cell(r, col).value
    check(abs(x - v['room_nights_occupied'] / v['room_nights_available']) < 1e-9, f'{name}: occupancy = occupied / available')
    r = find(ws, '2. Average Length of Stay'); x = ws.cell(r, col).value
    check(abs(x - v['guest_nights'] / v['arrivals']) < 1e-9, f'{name}: length of stay = guest-nights / arrivals')
    counts = json.loads(sql(f"select coalesce(json_object_agg(residence_code, json_build_object('m', male, 'f', female)), '{{}}') from accommodation_report_version_counts where version_id='{v['id']}'"))
    m = sum(c['m'] for c in counts.values()); f = sum(c['f'] for c in counts.values())
    rows = [r for r in range(1, ws.max_row + 1) if ws.cell(r, 1).value == 'x. Total']
    check([ws.cell(r, col).value for r in rows] == [m, f], f'{name}: volume per sex totals = version male {m}, female {f}', [ws.cell(r, col).value for r in rows])
    if col == 33:
        daysum = sum((ws.cell(g, c).value or 0) for c in range(2, 33))
        check(daysum == v['arrivals'], 'DAE-1B daily: the 31 day columns add up to the month', daysum)
        check(all(ws.cell(g, c).value in (None, '') or c <= 32 for c in range(2, 33)), 'DAE-1B daily: day columns present')
# FORM A 2025 = the preserved municipal totals
fa = load_workbook('xl/calc/forma-2025.xlsx', data_only=True)['FORM A']
g = find(fa, 'GRAND TOTAL GUEST ARRIVALS')
months = [fa.cell(g, c).value for c in range(2, 14)]
db = [int(x) for x in sql("select string_agg(t::text, ',' order by month) from (select month, (select sum(total) from monthly_report_counts c where c.report_id=r.id) t from monthly_reports r where kind='municipal_total' and year=2025) x").split(',')]
check(months == db, 'FORM A 2025: monthly grand totals = the 12 paper months', (months, db))
check(fa.cell(g, 14).value == 19298, 'FORM A 2025: year total 19,298')
r = find(fa, 'NO. OF ROOMS OCCUPIED')
check([fa.cell(r, c).value for c in range(2, 14)] == [int(x) for x in sql("select string_agg(room_nights_occupied::text, ',' order by month) from monthly_reports where kind='municipal_total'").split(',')], 'FORM A 2025: rooms occupied by month = paper sheets')
check(fa.cell(g, 16).value in (None, '') and fa.cell(g, 17).value in (None, ''), 'FORM A 2025: no 2024 baseline, previous year and % difference blank')
r = find(fa, 'a. ') # not present in FORM A; volume per sex is not on FORM A
# FORM A 2026 = latest versions, missing months blank
fb = load_workbook('xl/calc/forma-2026.xlsx', data_only=True)['FORM A']
g = find(fb, 'GRAND TOTAL GUEST ARRIVALS')
latest = json.loads(sql("select coalesce(json_object_agg(month, s), '{}') from (select month, sum(arrivals) s from (select distinct on (spot_id, month) * from accommodation_report_versions where year=2026 order by spot_id, month, version desc) x group by month) y"))
for mo in range(1, 13):
    cell = fb.cell(g, 1 + mo).value
    want = latest.get(str(mo))
    check((cell in (None, '') and want is None) or cell == want, f'FORM A 2026 {mo:02d}: ' + ('blank (no report)' if want is None else f'{want} arrivals'), (cell, want))
an = load_workbook('xl/calc/annual-2026.xlsx', data_only=True)['Annual summary']
g = find(an, 'GRAND TOTAL GUEST ARRIVALS')
own = json.loads(sql(f"select coalesce(json_object_agg(month, arrivals), '{{}}') from (select distinct on (month) * from accommodation_report_versions where spot_id='{SPOT}' and year=2026 order by month, version desc) x"))
check([an.cell(g, 1 + m).value or None for m in range(1, 13)] == [own.get(str(m)) for m in range(1, 13)], 'Enterprise annual: each month = its latest version, blank when none')
r = find(an, 'AVERAGE OCCUPANCY RATE')
occ = sql(f"select sum(room_nights_occupied)::float/sum(room_nights_available) from (select distinct on (month) * from accommodation_report_versions where spot_id='{SPOT}' and year=2026 order by month, version desc) x")
check(abs(an.cell(r, 14).value - float(occ)) < 1e-9, 'Enterprise annual occupancy = Σ occupied ÷ Σ available')
print(f'\n{ok} passed, {bad} failed'); sys.exit(1 if bad else 0)
