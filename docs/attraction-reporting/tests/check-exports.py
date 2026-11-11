# Reads the Excel files the API test downloaded, recalculates them in LibreOffice, and checks them against the figures
# the test posted: a recorded 0 is a 0, a missing value is an empty cell, day 31 exists, nothing typed becomes a formula.
import glob, json, os, subprocess, sys
import openpyxl

d, want = sys.argv[1], json.loads(sys.argv[2])
RECALC = glob.glob('/root/.claude/skills/synced/*/xlsx/scripts/recalc.py')
out = []
def ok(c, label): out.append(('✓ ' if c else '✗ ') + label)

for f in sorted(glob.glob(os.path.join(d, '*.xlsx'))):
    if not RECALC:
        ok(False, 'recalc script not found'); break
    res = subprocess.run(['python3', RECALC[0], f, '90'], capture_output=True, text=True)
    try: j = json.loads(res.stdout)
    except Exception: j = {'status': 'bad', 'total_errors': -1}
    ok(j.get('status') == 'success' and j.get('total_errors') == 0, f"{os.path.basename(f)} recalculates in LibreOffice with 0 errors ({j.get('total_formulas')} formulas)")

def load(name, data_only=True): return openpyxl.load_workbook(os.path.join(d, name + '.xlsx'), data_only=data_only)
def find(ws, text, col=1):
    for r in range(1, ws.max_row + 1):
        v = ws.cell(r, col).value
        if isinstance(v, str) and text in v: return r
    return None

# VAR 1, October 2026 (31 days), version 1
wb = load('var1'); ws = wb['VAR 1']
days = [r for r in range(1, ws.max_row + 1) if isinstance(ws.cell(r, 1).value, int)]
ok(len(days) == want['octDays'] and ws.cell(days[-1], 1).value == 31, 'VAR 1 has a row for day 31 (one row per real day)')
by = {ws.cell(r, 1).value: r for r in days}
ok(ws.cell(by[3], 5).value == 50 and ws.cell(by[3], 8).value == 25 and ws.cell(by[3], 11).value == 15 and ws.cell(by[3], 14).value == 100, 'day 3: This province 50, Other Province 25, Foreign 15, Grand Total 100')
ok(all(ws.cell(by[3], c).value is None for c in (3, 4, 6, 7, 9, 10, 12, 13)), 'day 3: residence Male/Female and the sex columns are empty (never estimated)')
ok('10 visits' in str(ws.cell(by[3], 16).value), 'day 3: the 10 unclassified visits are on the ZTIMS note, outside the form')
ok(ws.cell(by[5], 14).value == 0 and ws.cell(by[5], 5).value == 0, 'day 5 (confirmed zero): a typed 0, not an empty cell')
ok(ws.cell(by[27], 14).value is None and 'Closed (authorized)' in str(ws.cell(by[27], 16).value), 'day 27 (authorized closure): empty total, closure named, not zero')
tr = find(ws, 'Total of this Month')
ok(ws.cell(tr, 14).value == want['octTotal'], f"VAR 1 total row = {want['octTotal']} (sum of the daily counts)")
ok(ws.cell(tr, 5).value == 50 and ws.cell(tr, 8).value == 25 and ws.cell(tr, 11).value == 15, 'VAR 1 total row: This province 50, Other Province 25, Foreign 15 (zero days add 0)')
ok(ws.cell(tr, 12).value in (None, ''), 'VAR 1 total of male is blank when no sex was recorded (unknown, not 0)')
bad = [c.coordinate for row in ws.iter_rows() for c in row if c.data_type == 'f' and ('HYPERLINK' in str(c.value).upper() or 'EVIL' in str(c.value).upper())]
txt = [str(c.value) for row in ws.iter_rows() for c in row if isinstance(c.value, str) and 'evil.test' in c.value]
ok(not bad and txt, 'an attraction named "=HYPERLINK(...)" is written as text, never a formula')
wf = load('var1', data_only=False)['VAR 1']
ok(str(wf.cell(tr, 14).value).startswith('=IF(COUNT('), 'the total row is a formula that stays blank when nothing is recorded')

# VAR 1, February 2024 (leap), latest version
ws = load('var1leap')['VAR 1']
days = [r for r in range(1, ws.max_row + 1) if isinstance(ws.cell(r, 1).value, int)]
ok(len(days) == want['febLeapDays'] and ws.cell(days[-1], 1).value == 29, 'VAR 1 for February 2024 has 29 day rows (leap year)')
ok('Version' in str(ws.cell(3, 1).value), 'VAR 1 names the saved version it shows')

# draft is marked
ws = load('draft')['VAR 1']
ok('NOT SUBMITTED' in str(ws.cell(3, 1).value), 'an export of the daily counts now says NOT SUBMITTED')

# DTA2M October 2026, official: only finalized attractions have figures
ws = load('dta2m')['DTA2M']
r = find(ws, 'HYPERLINK')
ok(r is not None and ws.cell(r, 5).value == 20 and ws.cell(r, 8).value == 30 and ws.cell(r, 11).value == 25 and ws.cell(r, 14).value == 15, 'DTA2M: This Municipality 20, This Province 30, Other Province 25, Foreign 15')
ok(ws.cell(r, 17).value == want['octTotal'] and all(ws.cell(r, c).value is None for c in (3, 4, 6, 7, 9, 10, 12, 13)), 'DTA2M: Grand Total from the finalized version; residence Male/Female empty')
rf = find(ws, 'Test Falls')
ok(rf is not None and ws.cell(rf, 17).value is None and 'Not' in str(ws.cell(rf, 19).value) + str(ws.cell(rf, 20).value), 'DTA2M: an attraction with no finalized month is empty and says so (not zero)')
tr = find(ws, 'Total of this Month')
ok(ws.cell(tr, 17).value == want['octTotal'], 'DTA2M total row adds only the included attraction')

# VAR 3M annual
wb = load('annual'); ws = wb['VAR 3M']
oct_r = find(ws, 'October')
hdr = None
for c in range(2, ws.max_column + 1):
    v = ws.cell(8, c).value
    if isinstance(v, str) and 'HYPERLINK' in v: hdr = c
ok(hdr is not None, 'VAR 3M has a column group for the attraction')
ok(ws.cell(oct_r, hdr).value == want['dom'] and ws.cell(oct_r, hdr + 1).value == want['frn'] and ws.cell(oct_r, hdr + 2).value == want['octTotal'], 'VAR 3M October: Domestic 75, Foreign 15, Total = the confirmed total (not 90)')
jan = find(ws, 'January')
ok(ws.cell(jan, hdr).value is None and ws.cell(jan, hdr + 2).value is None, 'VAR 3M January: empty (not submitted), not 0')
nt = find(ws, 'ZTIMS note: residence not recorded')
ok(ws.cell(nt, hdr).value == want['octTotal'] - 90, 'VAR 3M ZTIMS note row: the unclassified visits, kept out of Domestic and Foreign')
ok(any(s.startswith('VAR 2') for s in wb.sheetnames), 'VAR 2 sheets are generated with VAR 3M (one source)')
print('\n'.join(out))
