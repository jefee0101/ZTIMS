/* Accommodation reports as Excel files, laid out like the four DOT templates
 * the Tourism Office supplied (PDFs; the original workbooks were not):
 *
 *   DAE-1A   Monthly Recording Format for Accommodation Establishment
 *   DAE-1B   (daily)  the v4a "Daily-Sum-Monthly" sheet: days 1–31 across
 *   DAE-1B / DAE 2 (2019)  the monthly-total sheet
 *   FORM A   (Sum) Annual Report: months across, total, share, previous year
 *
 * Rebuilt from the PDFs: headings, the country rows and their grouping and
 * order, the fills (yellow headings, blue regions, light-blue subtotals,
 * green totals, the pale spacer rows), borders, merged headings, units, the
 * signature lines, A4 pages and the PDFs' page breaks. The formulas are ZTIMS's
 * own (sums, and rates that read "n/a" instead of #DIV/0!), not recovered ones.
 *
 * Adjustments, on purpose:
 * - DAE-1A has one column per room the place really has (the form says
 *   "adjust number of columns = number of rooms"), so more than 15 is fine.
 * - A month shorter than 31 days keeps the 31 day columns of DAE-1B with the
 *   days that do not exist shaded and empty; DAE-1A lists only its real days.
 * - ZTIMS's residence list has five countries the 2019 templates have no row
 *   for (Macau, Oman, Qatar, Andorra, Turkey): they are counted in "Others and
 *   unspecified non-Philippine residences". Israel sits under Middle East as
 *   on the templates. "Union of Serbia and Montenegro" has no residence in
 *   ZTIMS, so its row stays blank.
 * - A blank cell is a figure ZTIMS does not have (a month not reported, a
 *   2025 month with no male/female split); 0 is a real zero.
 *
 * Every text that came from a person (an enterprise's name, codes, reasons)
 * goes in as plain text, and one starting with = + - @ or a tab gets a
 * leading apostrophe, so no spreadsheet program can take it for a formula.
 */
const ExcelJS = require('exceljs');

const FONT = 'Arial';
const C = { YELLOW: 'FFFFFF00', BLUE: 'FF0070C0', LIGHTBLUE: 'FF00B0F0', GREEN: 'FF92D050', SAGE: 'FFD8E4BC',
            ORANGE: 'FFFFC000', GREY: 'FFD9D9D9', WHITE: 'FFFFFFFF', CHECKIN: 'FFFFF2CC' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const thin = { style: 'thin', color: { argb: 'FF000000' } };
const BOX = { top: thin, left: thin, bottom: thin, right: thin };
const NUM = '#,##0';

/* The 2019 templates' rows, in their order. `codes` are ZTIMS residences. */
const TEMPLATE = [
    { t: 'spacer' },
    { t: 'section', label: 'PHILIPPINE RESIDENTS' },
    { t: 'row', label: 'FILIPINO NATIONALITY', codes: ['ph-filipino'], indent: 1 },
    { t: 'row', label: 'FOREIGN NATIONALITY', codes: ['ph-foreign'], indent: 1 },
    { t: 'total', label: 'TOTAL PHILIPPINE RESIDENTS', sum: 'ph' },
    { t: 'spacer' },
    { t: 'section', label: 'NON-PHILIPPINE RESIDENTS' },
    { t: 'spacer' },
    { t: 'section', label: 'ASIA' },
    { t: 'region', label: 'ASEAN', rows: [['BRUNEI', 'BN'], ['CAMBODIA', 'KH'], ['INDONESIA', 'ID'], ['LAOS', 'LA'], ['MALAYSIA', 'MY'], ['MYANMAR', 'MM'], ['SINGAPORE', 'SG'], ['THAILAND', 'TH'], ['VIETNAM', 'VN']] },
    { t: 'region', label: 'EAST ASIA', rows: [['CHINA', 'CN'], ['HONGKONG', 'HK'], ['JAPAN', 'JP'], ['KOREA', 'KR'], ['TAIWAN', 'TW']] },
    { t: 'region', label: 'SOUTH ASIA', rows: [['BANGLADESH', 'BD'], ['INDIA', 'IN'], ['IRAN', 'IR'], ['NEPAL', 'NP'], ['PAKISTAN', 'PK'], ['SRI LANKA', 'LK']], breakAfter: 'dae1bDaily' },
    { t: 'region', label: 'MIDDLE EAST', rows: [['BAHRAIN', 'BH'], ['EGYPT', 'EG'], ['ISRAEL', 'IL'], ['JORDAN', 'JO'], ['KUWAIT', 'KW'], ['SAUDI ARABIA', 'SA'], ['UNITED ARAB EMIRATES', 'AE']], breakAfter: 'monthly' },
    { t: 'section', label: 'AMERICA' },
    { t: 'region', label: 'NORTH AMERICA', rows: [['CANADA', 'CA'], ['MEXICO', 'MX'], ['USA', 'US']] },
    { t: 'region', label: 'SOUTH AMERICA', rows: [['ARGENTINA', 'AR'], ['BRAZIL', 'BR'], ['COLOMBIA', 'CO'], ['PERU', 'PE'], ['VENEZUELA', 'VE']] },
    { t: 'section', label: 'EUROPE' },
    { t: 'region', label: 'WESTERN EUROPE', rows: [['AUSTRIA', 'AT'], ['BELGIUM', 'BE'], ['FRANCE', 'FR'], ['GERMANY', 'DE'], ['LUXEMBOURG', 'LU'], ['NETHERLANDS', 'NL'], ['SWITZERLAND', 'CH']] },
    { t: 'region', label: 'NORTHERN EUROPE', rows: [['DENMARK', 'DK'], ['FINLAND', 'FI'], ['IRELAND', 'IE'], ['NORWAY', 'NO'], ['SWEDEN', 'SE'], ['UNITED KINGDOM', 'GB']] },
    { t: 'region', label: 'SOUTHERN EUROPE', rows: [['GREECE', 'GR'], ['ITALY', 'IT'], ['PORTUGAL', 'PT'], ['SPAIN', 'ES'], ['UNION OF SERBIA AND MONTENEGRO', null]] },
    { t: 'region', label: 'EASTERN EUROPE', rows: [['COMMONWEALTH OF INDEPENDENT STATES', 'cis'], ['POLAND', 'PL'], ['RUSSIA', 'RU']], breakAfter: 'dae1bDaily' },
    { t: 'region', label: 'AUSTRALASIA/PACIFIC', top: true, rows: [['AUSTRALIA', 'AU'], ['GUAM', 'GU'], ['NAURU', 'NR'], ['NEW ZEALAND', 'NZ'], ['PAPUA NEW GUINEA', 'PG']], breakAfter: 'monthly' },
    { t: 'region', label: 'AFRICA', top: true, rows: [['NIGERIA', 'NG'], ['SOUTH AFRICA', 'ZA']] },
    { t: 'others', label: 'OTHERS AND UNSPECIFIED', label2: 'NON-PHILIPPINE RESIDENCES', codes: ['other-foreign', 'MO', 'OM', 'QA', 'AD', 'TR'] },
    { t: 'spacer' },
    { t: 'total', label: 'TOTAL NON-PHILIPPINE RESIDENTS', sum: 'non' },
    { t: 'spacer' },
    { t: 'ofil', label: 'OVERSEAS FILIPINOS*', codes: ['overseas-filipino'] },
    { t: 'spacer' },
    { t: 'grand', label: 'GRAND TOTAL GUEST ARRIVALS' }
];
const FOOTNOTE = '* Philippine passport holders permanently residing abroad; excludes overseas Filipino workers';
const FOOTNOTE_2 = 'and Former Filipinos';

/* Text a person typed, safe in a cell: never read as a formula. */
function safeText(value) {
    const s = String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/* A cell's number as written: a formula's cached result or a plain value,
   null when blank. Read through cell.result: exceljs's cell.value leaves out
   a cached result of 0 or "", which would turn a real zero into "no report". */
function cellNumber(cell) {
    const v = cell.type === 6 ? cell.result : cell.value;   // 6: ExcelJS.ValueType.Formula
    return v === '' || v === undefined || v === null ? null : v;
}
const colName = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
function style(cell, o = {}) {
    cell.font = { name: FONT, size: o.size || 8, bold: !!o.bold, italic: !!o.italic, color: { argb: o.color || 'FF000000' } };
    if (o.fill) cell.fill = fill(o.fill);
    if (o.border !== false) cell.border = BOX;
    cell.alignment = { vertical: 'middle', horizontal: o.align || 'left', wrapText: !!o.wrap, indent: o.indent || 0 };
    if (o.numFmt) cell.numFmt = o.numFmt;
}
/* A sum that stays blank when every cell it adds is blank (nothing reported). */
const blankSum = range => `IF(COUNT(${range})=0,"",SUM(${range}))`;
const sumOf = list => (list.some(v => v != null) ? list.reduce((a, v) => a + (v || 0), 0) : null);

/* The rows of Part I, filled by `value(codes, col)` → number | null. */
function partOne(ws, startRow, cols, value, opts = {}) {
    let r = startRow;
    const rowsOf = { ph: [], non: [], ofil: [], subtotals: [] };
    const codesAt = {};          // row number -> the residence codes it adds up
    const allCodes = [];
    const firstCol = 2, lastCol = firstCol + cols.length - 1;
    const write = (label, kind, nums, extra = {}) => {
        const row = ws.getRow(r);
        row.height = kind === 'spacer' ? 6 : (opts.rowHeight || 10.5);
        const c0 = row.getCell(1);
        c0.value = label;
        const base = { ph: {}, section: { fill: C.BLUE, bold: true, color: 'FFFFFFFF' }, region: { fill: C.BLUE, bold: true, italic: true, color: 'FFFFFFFF' },
            row: { bold: true, italic: true }, subtotal: { fill: C.LIGHTBLUE, bold: true, italic: true }, total: { fill: C.GREEN, bold: true },
            spacer: { fill: C.SAGE }, grand: { fill: C.YELLOW, bold: true }, ofil: { fill: C.BLUE, bold: true, italic: true, color: 'FFFFFFFF' },
            breakdown: { fill: C.GREEN, bold: true } }[kind] || {};
        style(c0, { ...base, indent: extra.indent || 0, size: 7 });
        cols.forEach((col, i) => {
            const cell = row.getCell(firstCol + i);
            const v = nums ? nums[i] : undefined;
            if (v && typeof v === 'object') cell.value = v; else if (v != null) cell.value = v;
            const cellFill = kind === 'spacer' ? C.SAGE : kind === 'section' || kind === 'region' ? C.BLUE
                : kind === 'subtotal' ? C.LIGHTBLUE : kind === 'total' || kind === 'breakdown' ? C.GREEN : kind === 'grand' ? C.YELLOW
                : (opts.shade && opts.shade(i)) ? C.GREY : null;
            style(cell, { fill: cellFill, align: 'right', numFmt: NUM, bold: kind !== 'row', italic: kind === 'subtotal', size: 7 });
        });
        if (extra.codes) codesAt[r] = extra.codes;
        if (opts.afterRow) opts.afterRow(row, kind);
        r += 1;
        return r - 1;
    };
    const codesOf = rows => rows.flatMap(x => codesAt[x] || []);
    const valueRow = codes => cols.map((_, i) => value(codes, i));
    const formulaRow = (rows, numsFallback) => cols.map((_, i) => {
        const L = colName(firstCol + i);
        if (!rows.length) return null;
        const f = rows.map(x => `${L}${x}`).join(',');
        const result = sumOf(rows.map(x => cellNumber(ws.getRow(x).getCell(firstCol + i))).map(v => (v === '' ? null : v)));
        return { formula: `IF(COUNT(${f})=0,"",SUM(${f}))`, result: result == null ? '' : result };
    });
    for (const item of TEMPLATE) {
        if (item.t === 'spacer') { write('', 'spacer'); continue; }
        if (item.t === 'section') { write(item.label, 'section'); continue; }
        if (item.t === 'row') { allCodes.push(...item.codes); rowsOf.ph.push(write(item.label, 'row', valueRow(item.codes), { indent: 1, codes: item.codes })); continue; }
        if (item.t === 'total') {
            const rows = item.sum === 'ph' ? rowsOf.ph : rowsOf.subtotals.concat(rowsOf.non);
            const at = write(item.label, 'total', formulaRow(rows), { codes: codesOf(rows) });
            if (item.sum === 'ph') rowsOf.phTotal = at; else rowsOf.nonTotal = at;
            continue;
        }
        if (item.t === 'region') {
            if (item.top) write(item.label, 'section'); else write(item.label, 'region', null, { indent: 1 });
            const these = item.rows.map(([label, code]) => { if (code) allCodes.push(code); return write(label, 'row', code ? valueRow([code]) : cols.map(() => null), { indent: 2, codes: code ? [code] : [] }); });
            rowsOf.subtotals.push(write('SUB-TOTAL', 'subtotal', formulaRow(these), { indent: 4, codes: codesOf(these) }));
            write('', 'spacer');
            if (item.breakAfter && opts.breaks === item.breakAfter) ws.getRow(r - 1).addPageBreak();
            continue;
        }
        if (item.t === 'others') {
            write(item.label, 'section');
            allCodes.push(...item.codes);
            rowsOf.non.push(write(item.label2, 'ofil', valueRow(item.codes), { codes: item.codes }));
            continue;
        }
        if (item.t === 'ofil') { allCodes.push(...item.codes); rowsOf.ofilRow = write(item.label, 'ofil', valueRow(item.codes), { codes: item.codes }); continue; }
        if (item.t === 'grand') {
            const unspec = valueRow(['unspecified']);
            const parts = [rowsOf.phTotal, rowsOf.nonTotal, rowsOf.ofilRow];
            const grand = cols.map((_, i) => {
                const L = colName(firstCol + i);
                const f = parts.map(x => `${L}${x}`).concat([`${L}${r + 4}`]).join(',');
                const vals = parts.map(x => cellNumber(ws.getRow(x).getCell(firstCol + i))).concat([unspec[i]]).map(v => (v === '' ? null : v));
                const s = sumOf(vals);
                return { formula: `IF(COUNT(${f})=0,"",SUM(${f}))`, result: s == null ? '' : s };
            });
            write(item.label, 'grand', grand, { codes: allCodes.concat(['unspecified']) });
            const ref = x => cols.map((_, i) => { const v = cellNumber(ws.getRow(x).getCell(firstCol + i)); return { formula: `IF(${colName(firstCol + i)}${x}="","",${colName(firstCol + i)}${x})`, result: v == null ? '' : v }; });
            write(' Total Philippine Residents', 'breakdown', ref(rowsOf.phTotal), { indent: 1, codes: codesAt[rowsOf.phTotal] });
            write(' Total Non-Philippine Residents', 'breakdown', ref(rowsOf.nonTotal), { indent: 1, codes: codesAt[rowsOf.nonTotal] });
            write(' Total Overseas Filipinos', 'breakdown', ref(rowsOf.ofilRow), { indent: 1, codes: codesAt[rowsOf.ofilRow] });
            write(opts.unspecifiedLabel || ' Total Guest with Unspecified Residence', 'breakdown', unspec, { indent: 1, codes: ['unspecified'] });
        }
    }
    return { nextRow: r, firstCol, lastCol, rowsOf, codesAt };
}

function headerRows(ws, rows) {
    for (const [r, c, text, o] of rows) {
        if (!ws.getRow(r).height) ws.getRow(r).height = 11.5;
        const cell = ws.getRow(r).getCell(c);
        cell.value = text;
        style(cell, { border: false, size: 9, ...o });
    }
}
function signature(ws, r, withDate) {
    headerRows(ws, [[r, 1, 'Prepared by:', { size: 8 }], [r, 3, '______________________________', {}], [r + 1, 3, 'Signature over Printed Name', { size: 8, align: 'center' }],
                    [r, 12, '______________________________', {}], [r + 1, 12, 'Position/Designation', { size: 8, align: 'center' }]]);
    if (withDate) headerRows(ws, [[r - 1, 22, 'Date Submitted:', { size: 8 }], [r, 22, '______________', {}]]);
}
function a4(ws, landscape, titleRows, onePage) {
    ws.pageSetup = { paperSize: 9, orientation: landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: onePage ? 1 : 0,
                     margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }, printTitlesRow: titleRows };
    ws.headerFooter = { oddFooter: 'Page &P of &N' };
}

/* ---- DAE-1A -------------------------------------------------------------- */
function addDae1A(wb, ctx) {
    const ws = wb.addWorksheet('DAE-1A');
    const d = ctx.detail;
    const days = ctx.days;
    const rooms = d && d.rooms.length ? d.rooms : Array.from({ length: 15 }, (_, i) => String(i + 1));
    const roomCols = rooms.length, c5 = 3 + roomCols, c6 = c5 + 1, c7 = c6 + 1;
    ws.columns = [{ width: 4 }, { width: 5 }, ...rooms.map(() => ({ width: 5.2 })), { width: 9 }, { width: 10 }, { width: 9 }];
    headerRows(ws, [[1, 1, 'Monthly Recording Format for Accommodation Establishment', { bold: true, size: 10 }],
                    [2, 1, '(This form is provided for small & medium Accommodation Establishments that do not have', { size: 7 }],
                    [3, 1, 'an established/computerized guests and room occupancy recording system.)', { size: 7 }],
                    [3, c5, 'Month of ' + (ctx.month ? MONTHS[ctx.month - 1] : '__________'), { bold: true, size: 8 }],
                    [3, c7, 'Year ' + (ctx.year || '______'), { bold: true, size: 8 }],
                    [4, c5, '(4) Total Number of Rooms :', { bold: true, size: 8 }],
                    [5, 1, safeText(ctx.enterpriseName || ''), { bold: true, size: 9 }]]);
    const form = ws.getRow(1).getCell(c6); form.value = 'Form: DAE-1A'; style(form, { bold: true, size: 9 }); ws.mergeCells(1, c6, 1, c7);
    const total4 = ws.getRow(4).getCell(c7); total4.value = d ? ctx.rooms : null; style(total4, { align: 'center', bold: true, size: 8 });
    if (ctx.status) headerRows(ws, [[6, 3, ctx.status, { italic: true, size: 8, color: 'FFC00000' }]]);
    // Table head: rows 7–8.
    const h = 7;
    ws.mergeCells(h, 1, h, 2); style(Object.assign(ws.getRow(h).getCell(1), { value: 'Date' }), { bold: true, align: 'center' });
    ws.mergeCells(h, 3, h, 2 + roomCols); style(Object.assign(ws.getRow(h).getCell(3), { value: 'Room Identification (adjust number of columns=number of rooms)' }), { bold: true, align: 'center', wrap: true, size: 7 });
    const heads = [[c5, '(5)\nNumber of Guests Check IN\n(unit: visitors)'], [c6, '(6)\nNumber of Guests staying over-night\n(Guest Nights)'], [c7, '(7)\nNumber of Rooms Occupied by Guests\n(unit: rooms)']];
    for (const [c, text] of heads) { ws.mergeCells(h, c, h + 1, c); style(Object.assign(ws.getRow(h).getCell(c), { value: text }), { bold: true, align: 'center', wrap: true, size: 7 }); }
    style(Object.assign(ws.getRow(h + 1).getCell(1), { value: 'Day' }), { bold: true, align: 'center', size: 7 });
    style(Object.assign(ws.getRow(h + 1).getCell(2), { value: 'Day of the week\nSun-Sat' }), { bold: true, align: 'center', wrap: true, size: 6 });
    rooms.forEach((n, i) => style(Object.assign(ws.getRow(h + 1).getCell(3 + i), { value: `Room No.\n${safeText(n)}` }), { bold: true, align: 'center', wrap: true, size: 6 }));
    ws.getRow(h + 1).height = 42; ws.getRow(h).height = roomCols < 10 ? 26 : 16;
    const first = h + 2;
    const rowsShown = days || 31;
    for (let i = 0; i < rowsShown; i++) {
        const row = ws.getRow(first + i), info = d && d.daily[i];
        row.height = 12;
        style(Object.assign(row.getCell(1), { value: i + 1 }), { align: 'center' });
        const wd = ctx.year && ctx.month ? WEEKDAY[new Date(Date.UTC(ctx.year, ctx.month - 1, i + 1)).getUTCDay()] : '';
        style(Object.assign(row.getCell(2), { value: wd }), { align: 'center', size: 7 });
        rooms.forEach((n, j) => {
            const cell = row.getCell(3 + j);
            let v = null, arriving = false;
            if (info && info.rooms && Object.prototype.hasOwnProperty.call(info.rooms, n)) { v = info.rooms[n] === null ? 'x' : info.rooms[n]; arriving = (info.checkInRooms || []).includes(n); }
            if (v !== null) cell.value = v;
            style(cell, { align: 'center', fill: info && info.closed ? C.GREY : arriving ? C.YELLOW : null });
        });
        const counted = info && (ctx.countedDays == null || i < ctx.countedDays);
        for (const [c, key] of [[c5, 'checkIn'], [c6, 'guestNights'], [c7, 'roomsOccupied']]) {
            const cell = row.getCell(c);
            if (info && (key === 'checkIn' || counted)) cell.value = info[key];
            style(cell, { align: 'right', numFmt: NUM, fill: info && info.closed ? C.GREY : null });
        }
    }
    const tr = first + rowsShown;
    ws.mergeCells(tr, 1, tr, 2 + roomCols);
    style(Object.assign(ws.getRow(tr).getCell(1), { value: 'TOTAL OF THIS MONTH' }), { bold: true, align: 'right' });
    const totals = {};   // kept here: exceljs reads a cached result of 0 back as missing
    for (const c of [c5, c6, c7]) {
        const L = colName(c), range = `${L}${first}:${L}${tr - 1}`;
        const result = totals[c] = d ? d.daily.slice(0, rowsShown).reduce((a, x, i) => a + ((c === c5 || ctx.countedDays == null || i < ctx.countedDays) ? (x[c === c5 ? 'checkIn' : c === c6 ? 'guestNights' : 'roomsOccupied'] || 0) : 0), 0) : '';
        style(Object.assign(ws.getRow(tr).getCell(c), { value: { formula: blankSum(range), result } }), { bold: true, align: 'right', numFmt: NUM });
    }
    const L5 = `${colName(c5)}${tr}`, L6 = `${colName(c6)}${tr}`, L7 = `${colName(c7)}${tr}`;
    const avail = ctx.roomNightsAvailable;
    const rate = (num, den) => (den ? num / den : 'n/a');
    const tot = d ? { ci: totals[c5], gn: totals[c6], ro: totals[c7] } : null;
    const lines = [
        ['Average Guest-Night = Total Number of Guests nights / Total Number of Guests Check IN', `IF(OR(${L5}="",${L5}=0),"n/a",${L6}/${L5})`, tot ? rate(tot.gn, tot.ci) : '', '0.00'],
        ['Average Room Occupancy Rate = Total No. of Rooms Occupied by the Guests during the month / Total No. of Rooms Available during the month', null, tot ? rate(tot.ro, avail) : '', '0.0%'],
        ['Average Number of Guest per room = Total Number of Guests Nights / Total Number of Rooms Occupied by the Guests', `IF(OR(${L7}="",${L7}=0),"n/a",${L6}/${L7})`, tot ? rate(tot.gn, tot.ro) : '', '0.00']
    ];
    lines.forEach(([text, formula, result, fmt], i) => {
        const r = tr + 1 + i;
        headerRows(ws, [[r, 1, text, { size: 7 }]]);
        const cell = ws.getRow(r).getCell(c7);
        if (formula) cell.value = { formula, result }; else if (d) cell.value = result;
        style(cell, { align: 'right', numFmt: fmt, size: 8 });
    });
    const availRow = tr + 4;
    headerRows(ws, [[availRow, 1, 'Total No. of Rooms Available during the month (room-nights)', { size: 7 }]]);
    const ac = ws.getRow(availRow).getCell(c7); if (d) ac.value = avail; style(ac, { align: 'right', numFmt: NUM, size: 8 });
    const notes = ['Note:', 'The number of Guests Checked In are the highlighted ones. They are the newly checked in guests.',
        'The number of GUESTS STAYING OVERNIGHT are the total number of guests staying for the day',
        '      including those who checked in prior that day who still stayed until the same day.',
        'The NUMBER OF ROOMS OCCUPIED are the rooms occupied within the day.',
        '"x": the room was occupied by a party holding several rooms that night; its guests are counted in (6), not split by room.'];
    notes.forEach((t, i) => headerRows(ws, [[availRow + 2 + i, 1, t, { size: 7, bold: i === 0 }]]));
    a4(ws, roomCols > 18, '7:8', true);   // the DAE-1A is a one-page form, whatever the rooms
    return ws;
}

/* ---- DAE-1B (daily, v4a) and DAE-1B / DAE 2 (2019, monthly) ------------ */
function dae1bHead(ws, ctx, daily) {
    const typeName = { hotel: 'Hotel', resort: 'Resort', pension: 'Pension Inn/ Lodge', hostel: 'Youth Hostel/ Dormitory', apartel: 'Apartel/ Rented Homes/ Apartment', other: 'Others' }[ctx.profile.accommodationType] || '';
    const when = ctx.month ? `${MONTHS[ctx.month - 1]} ${ctx.year}` : '';
    if (daily) {
        headerRows(ws, [[1, 1, 'DAE-1B (Manual)', { size: 8 }], [2, 16, 'Region: ______', { bold: true }], [3, 14, when || '______________________________', { align: 'center' }],
                        [4, 14, '(Month, Year)', { size: 8, align: 'center' }], [6, 10, 'REPORT ON THE REGIONAL DISTRIBUTION OF TRAVELERS', { bold: true, size: 10 }],
                        [8, 1, 'Type of Accommodation', { bold: true, size: 8 }]]);
        ['Hotel', 'Resort', 'Pension Inn/ Lodge', 'Youth Hostel/ Dormitory', 'Apartel/ Rented Homes/ Apartment', 'Others, please specify: ' + (ctx.profile.accommodationType === 'other' ? safeText(ctx.profile.accommodationTypeOther) : '_______________')]
            .forEach((t, i) => { headerRows(ws, [[9 + i, 1, '      ' + t, { size: 7 }]]); const box = ws.getRow(9 + i).getCell(4); box.value = typeName && (t.startsWith(typeName)) ? 'X' : null; style(box, { align: 'center', size: 7 }); });
        headerRows(ws, [[16, 1, 'DOT Accreditation Classification: ' + (safeText(ctx.profile.dotClassification) || '______________________________'), { bold: true, size: 8 }],
                        [18, 1, 'Name of Establishment: ' + safeText(ctx.enterpriseName), { bold: true, size: 8 }],
                        [19, 1, 'AE ID Code (LGU Assigned): ' + (safeText(ctx.profile.aeCode) || '______________________________'), { bold: true, size: 8 }],
                        [21, 1, 'City/Municipality: Zamboanguita', { bold: true, size: 8 }], [22, 1, 'Province: Negros Oriental', { bold: true, size: 8 }]]);
        if (ctx.status) headerRows(ws, [[23, 10, ctx.status, { italic: true, size: 8, color: 'FFC00000' }]]);
        return 25;
    }
    headerRows(ws, [[1, 1, 'DAE-1B / DAE 2 (2019)', { bold: true, size: 9 }], [2, 2, 'Region: ______', { bold: true, align: 'center' }],
                    [3, 2, when || '______________________________', { align: 'center' }], [4, 2, '(Month, Year)', { italic: true, size: 8, align: 'center' }],
                    [6, 1, 'REPORT ON THE REGIONAL DISTRIBUTION OF TRAVELERS', { bold: true, size: 11 }],
                    [8, 1, 'Type of Accommodation : ' + (ctx.profile.accommodationType === 'other' ? 'Others, ' + safeText(ctx.profile.accommodationTypeOther) : typeName), { bold: true, size: 8 }],
                    [9, 1, 'DOT Accreditation Type: ' + safeText(ctx.profile.dotClassification), { bold: true, size: 8 }],
                    [11, 1, 'Name of AE / AE Coded ID: ' + safeText(ctx.enterpriseName) + (ctx.profile.aeCode ? ' / ' + safeText(ctx.profile.aeCode) : ''), { bold: true, size: 8 }],
                    [13, 1, 'City / Municipality: Zamboanguita', { bold: true, size: 8 }], [14, 1, 'Province: Negros Oriental', { bold: true, size: 8 }],
                    [15, 1, 'Region:', { bold: true, size: 8 }]]);
    if (ctx.status) headerRows(ws, [[16, 1, ctx.status, { italic: true, size: 8, color: 'FFC00000' }]]);
    const p = ws.getRow(17).getCell(1); p.value = 'PART I.  Guest Arrivals by Nationality / Country of Residence'; style(p, { bold: true, size: 10 }); ws.mergeCells(17, 1, 17, 2);
    return 19;
}

function addDae1B(wb, ctx, daily) {
    const ws = wb.addWorksheet(daily ? 'DAE-1B (daily)' : 'DAE-1B DAE 2 (2019)');
    const days = ctx.days || 31;
    const cols = daily ? Array.from({ length: 31 }, (_, i) => i) : [0];
    ws.columns = daily ? [{ width: 32 }, ...cols.map(() => ({ width: 3.6 })), { width: 7 }] : [{ width: 46 }, { width: 14 }];
    const top = dae1bHead(ws, ctx, daily);
    const head = ws.getRow(top);
    style(Object.assign(head.getCell(1), { value: 'COUNTRY OF RESIDENCE' }), { fill: C.YELLOW, bold: true, size: 7 });
    if (daily) cols.forEach(i => style(Object.assign(head.getCell(2 + i), { value: i + 1 }), { fill: C.YELLOW, bold: true, italic: true, align: 'right', size: 7 }));
    style(Object.assign(head.getCell(daily ? 33 : 2), { value: 'TOTAL' }), { fill: C.YELLOW, bold: true, align: 'center', size: 7 });
    const v = ctx.version;   // the saved version (or the register now)
    const has = !!v;
    const byDay = (codes, day, sex) => codes.reduce((a, code) => { const b = v.detail && v.detail.byDay[code]; return a + (b ? (sex ? b[sex][day] : b.male[day] + b.female[day]) : 0); }, 0);
    const monthTotal = codes => codes.reduce((a, code) => { const c = v.counts[code]; return a + (c ? c.male + c.female : 0); }, 0);
    const dailyAvailable = has && v.detail;
    const shade = i => daily && i >= days;
    const value = (codes, i) => {
        if (!has) return null;
        if (!daily) return monthTotal(codes);
        if (i >= days || !dailyAvailable) return null;
        return byDay(codes, i);
    };
    if (daily) for (let i = 1; i < top; i++) ws.getRow(i).height = 8.5;
    const res = partOne(ws, top + 1, cols, value, { breaks: daily ? 'dae1bDaily' : 'monthly', shade, rowHeight: daily ? 9 : 10.5,
        unspecifiedLabel: ' Total Guest with Unspecified Residence',
        afterRow: daily ? (row, kind) => {
            const L = colName(2), R = colName(32), r = row.number;
            const cell = row.getCell(33);
            const vals = cols.map(i => cellNumber(row.getCell(2 + i))).map(x => (x === '' || x == null ? null : x));
            if (kind !== 'spacer' && kind !== 'section' && kind !== 'region') {
                const s = sumOf(vals);
                cell.value = { formula: blankSum(`${L}${r}:${R}${r}`), result: s == null ? '' : s };
            }
            style(cell, { fill: kind === 'spacer' ? C.SAGE : kind === 'section' || kind === 'region' ? C.BLUE : kind === 'subtotal' ? C.LIGHTBLUE : kind === 'total' || kind === 'breakdown' ? C.GREEN : kind === 'grand' ? C.YELLOW : null, align: 'right', numFmt: NUM, size: 7 });
        } : null });
    let r = res.nextRow + 1;
    // Part II.
    const T = daily ? 33 : 2;
    const put = (label, values, total, o = {}) => {
        const row = ws.getRow(r);
        if (daily) row.height = 9;
        style(Object.assign(row.getCell(1), { value: label }), { size: 7, bold: !!o.bold, italic: !!o.italic, fill: o.fill || null });
        if (daily) cols.forEach(i => { const cell = row.getCell(2 + i); const x = values ? values(i) : null; if (x != null && i < days) cell.value = x; style(cell, { align: 'right', numFmt: o.fmt || NUM, size: 7, fill: o.fill && !values ? o.fill : shade(i) ? C.GREY : null }); });
        const tc = row.getCell(T);
        if (total !== undefined && total !== null) tc.value = total;
        style(tc, { align: 'right', numFmt: o.fmt || NUM, size: 7, fill: o.fill && !values && total === undefined ? o.fill : daily && values ? C.GREEN : o.fill && total === undefined ? o.fill : null });
        r += 1;
        return r - 1;
    };
    const titleRow = ws.getRow(r); style(Object.assign(titleRow.getCell(1), { value: 'PART II.  Other Indicators' }), { bold: true, size: 9 }); r += 2;
    put('A. DAE2:', null, undefined, { bold: true, fill: C.YELLOW });
    const dd = (key) => (has && v.detail && daily ? i => (i < days ? v.detail.daily[i][key] : null) : null);
    const occRow = put('1. Rooms Occupied', dd('roomsOccupied'), has ? v.roomNightsOccupied : null);
    const avRow = put('2. Rooms available for the month', dd('available'), has ? v.roomNightsAvailable : null);
    const gnRow = put('3. Total Guest nights', dd('guestNights'), has ? v.guestNights : null);
    put('Alternative Submission', null, undefined, { bold: true, italic: true, fill: C.SAGE });
    const TL = colName(T);
    const rateCell = (formula, result, fmt) => ({ formula, result: result == null ? 'n/a' : result });
    const occ = has && v.roomNightsAvailable ? v.roomNightsOccupied / v.roomNightsAvailable : null;
    const alos = has && v.arrivals ? v.guestNights / v.arrivals : null;
    const rowO = put('1. Average Monthly Occupancy Rate', null, has ? rateCell(`IF(OR(${TL}${avRow}="",${TL}${avRow}=0),"n/a",${TL}${occRow}/${TL}${avRow})`, occ) : null, { fmt: '0.0%' });
    const grandRow = res.rowsOf.phTotal ? res.nextRow - 5 : null;
    put('2. Average Length of Stay (in Nights)', null, has ? rateCell(`IF(OR(${TL}${grandRow}="",${TL}${grandRow}=0),"n/a",${TL}${gnRow}/${TL}${grandRow})`, alos) : null, { fmt: '0.00' });
    put('B. VOLUME PER SEX', null, undefined, { bold: true, fill: C.YELLOW });
    const sections = ctx.sections;
    const sexValue = (sec, sex) => (has ? (daily ? (v.detail ? i => (i < days ? Object.keys(v.detail.byDay).filter(c => sections[c] === sec).reduce((a, c) => a + v.detail.byDay[c][sex][i], 0) : null) : null) : null) : null);
    const sexTotal = (sec, sex) => (has ? Object.entries(v.counts).filter(([c]) => sections[c] === sec).reduce((a, [, x]) => a + x[sex], 0) : null);
    for (const [n, sex] of [['1. Male', 'male'], ['2. Female', 'female']]) {
        put(n, null, undefined, { bold: true });
        let sum = 0;
        for (const [label, sec] of [['a. Philippine Residents', 'philippine'], ['b. Non-Philippine/Foreign Residents (including unspecified)', 'foreign'], ['c. Overseas Filipinos', 'overseas_filipino'], ['d. Others/Unspecified Guest', 'unspecified']]) {
            const t = sexTotal(sec, sex); sum += t || 0;
            put(label, sexValue(sec, sex), t);
        }
        put('x. Total', has && daily && v.detail ? i => (i < days ? Object.values(v.detail.byDay).reduce((a, b) => a + b[sex][i], 0) : null) : null, has ? sum : null);
    }
    headerRows(ws, [[r, 1, FOOTNOTE, { size: 7 }], [r + 1, 1, FOOTNOTE_2, { size: 7 }]]);
    signature(ws, r + 4, !daily);
    a4(ws, daily, `${top}:${top}`);
    return ws;
}

/* ---- FORM A (municipal year) and an enterprise's annual summary --------- */
function addFormA(wb, ctx) {
    const ws = wb.addWorksheet(ctx.sheetName || 'FORM A');
    const months = Array.from({ length: 12 }, (_, i) => i);
    // Columns: country, 12 months, total, % share, previous year, % difference.
    const colT = 14, colS = 15, colP = 16, colD = 17;
    ws.columns = [{ width: 34 }, ...months.map(() => ({ width: 8 })), { width: 10 }, { width: 9 }, { width: 10 }, { width: 9 }];
    headerRows(ws, [[1, 1, 'FORM A (Sum) Annual Report', { bold: true, size: 9 }], [2, 8, 'Region: ______', { bold: true, align: 'center' }],
                    [3, 8, String(ctx.year), { align: 'center', bold: true }], [4, 8, '(Year)', { italic: true, size: 8, align: 'center' }],
                    [5, 6, 'REPORT ON THE REGIONAL DISTRIBUTION OF TRAVELERS', { bold: true, size: 10 }],
                    [6, 1, 'City/Municipality: Zamboanguita', { bold: true, size: 8 }], [7, 1, 'Province: Negros Oriental', { bold: true, size: 8 }]]);
    if (ctx.enterpriseName) headerRows(ws, [[8, 1, 'Name of Establishment: ' + safeText(ctx.enterpriseName), { bold: true, size: 8 }]]);
    if (ctx.status) headerRows(ws, [[8, 8, ctx.status, { italic: true, size: 8, color: 'FFC00000' }]]);
    const top = 10, head = ws.getRow(top);
    head.height = 30;
    style(Object.assign(head.getCell(1), { value: 'COUNTRY OF RESIDENCE' }), { fill: C.YELLOW, bold: true, align: 'center', size: 7 });
    months.forEach(i => style(Object.assign(head.getCell(2 + i), { value: MONTHS[i] }), { fill: C.YELLOW, bold: true, align: 'center', size: 7 }));
    style(Object.assign(head.getCell(colT), { value: 'TOTAL (Current Year)' }), { fill: C.YELLOW, bold: true, align: 'center', wrap: true, size: 7 });
    style(Object.assign(head.getCell(colS), { value: '% Share from Total Arrivals' }), { fill: C.ORANGE, bold: true, align: 'center', wrap: true, size: 7 });
    style(Object.assign(head.getCell(colP), { value: 'Total (Previous Year)' }), { fill: C.YELLOW, bold: true, align: 'center', wrap: true, size: 7 });
    style(Object.assign(head.getCell(colD), { value: '% Difference' }), { fill: C.ORANGE, bold: true, align: 'center', wrap: true, size: 7 });
    const monthHas = ctx.months.map(m => !!m);
    const value = (codes, i) => {
        const m = ctx.months[i];
        if (!m) return null;
        return codes.reduce((a, code) => { const c = m.counts[code]; return a + (c ? (c.unsplit || 0) + (c.male || 0) + (c.female || 0) : 0); }, 0);
    };
    const prevValue = codes => (ctx.previous ? codes.reduce((a, code) => a + (ctx.previous[code] || 0), 0) : null);
    const res = partOne(ws, top + 1, months, value, { breaks: 'monthly',
        unspecifiedLabel: ' Total Guest with Unidentified Residence',
        afterRow: (row, kind) => {
            const r = row.number;
            const fillOf = kind === 'spacer' ? C.SAGE : kind === 'section' || kind === 'region' ? C.BLUE : kind === 'subtotal' ? C.LIGHTBLUE : kind === 'total' || kind === 'breakdown' ? C.GREEN : kind === 'grand' ? C.YELLOW : null;
            for (const c of [colT, colS, colP, colD]) style(row.getCell(c), { fill: fillOf, align: 'right', size: 7, numFmt: c === colS || c === colD ? '0.00%' : NUM });
            if (['spacer', 'section', 'region'].includes(kind)) return;
            const vals = months.map(i => cellNumber(row.getCell(2 + i))).map(x => (x === '' || x == null ? null : x));
            const s = sumOf(vals);
            row.getCell(colT).value = { formula: blankSum(`B${r}:M${r}`), result: s == null ? '' : s };
            row._ztimsTotal = s;
        } });
    // % share, previous year, % difference: computed per row once the grand total is known.
    const grandRow = res.nextRow - 5;
    const grandTotal = cellNumber(ws.getRow(grandRow).getCell(colT));
    const T = colName(colT);
    for (let r = top + 1; r < res.nextRow; r++) {
        const row = ws.getRow(r);
        if (row._ztimsTotal === undefined) continue;
        const own = row._ztimsTotal;
        row.getCell(colS).value = { formula: `IF(OR(${T}${r}="",${T}$${grandRow}="",${T}$${grandRow}=0),"",${T}${r}/${T}$${grandRow})`,
                                    result: own == null || !grandTotal ? '' : own / grandTotal };
        // Previous year over the comparable months only (ctx.comparable);
        // blank when there are none (no baseline), n/a when the baseline is 0.
        const codes = res.codesAt[r];
        if (codes && ctx.comparable && ctx.comparable.length && ctx.previousMonths) {
            const sumMonths = (list, ms) => ms.reduce((a, m) => { const mm = list[m - 1]; return a + (mm ? codes.reduce((b, code) => { const c = mm.counts[code]; return b + (c ? (c.unsplit || 0) + (c.male || 0) + (c.female || 0) : 0); }, 0) : 0); }, 0);
            const prev = sumMonths(ctx.previousMonths, ctx.comparable), cur = sumMonths(ctx.months, ctx.comparable);
            row.getCell(colP).value = prev;
            row.getCell(colD).value = prev ? (cur - prev) / prev : 'n/a';
        }
    }
    let r = res.nextRow + 1;
    const p2 = ws.getRow(r); style(Object.assign(p2.getCell(1), { value: 'PART II.  OCCUPANCY RATE AND LENGTH OF STAY' }), { bold: true, size: 9 }); ws.mergeCells(r, 1, r, 4); r += 2;
    const partII = ctx.partII;
    const line = (label, key, fmt) => {
        const row = ws.getRow(r);
        style(Object.assign(row.getCell(1), { value: label }), { bold: true, size: 7 });
        months.forEach(i => { const cell = row.getCell(2 + i); const m = partII.months[i]; if (m && m[key] != null) cell.value = m[key]; style(cell, { align: 'right', numFmt: fmt, size: 7 }); });
        const t = row.getCell(colT); if (partII.total && partII.total[key] != null) t.value = partII.total[key]; style(t, { fill: C.YELLOW, align: 'right', numFmt: fmt, size: 7 });
        style(row.getCell(colS), { fill: C.YELLOW, size: 7 });
        const pc = row.getCell(colP); if (partII.previous && partII.previous[key] != null) pc.value = partII.previous[key]; style(pc, { fill: C.YELLOW, align: 'right', numFmt: fmt, size: 7 });
        const dc = row.getCell(colD);
        if (partII.previous && partII.previous[key] != null && partII.current) {
            const p = partII.previous[key], c = partII.current[key];
            dc.value = p && c != null ? (c - p) / p : 'n/a';
        }
        style(dc, { fill: C.YELLOW, align: 'right', numFmt: '0.00%', size: 7 });
        r += 1;
    };
    line('NO. OF ROOMS OCCUPIED', 'roomNightsOccupied', NUM);
    line('NO. OF ROOMS AVAILABLE', 'roomNightsAvailable', NUM);
    line('TOTAL GUEST-NIGHTS', 'guestNights', NUM);
    r += 1;
    line('AVERAGE OCCUPANCY RATE', 'occupancyRate', '0.0%');
    line('AVERAGE LENGTH OF STAY', 'averageLengthOfStay', '0.00');
    r += 1;
    headerRows(ws, [[r, 1, FOOTNOTE, { size: 7 }]]);
    (ctx.notes || []).forEach((t, i) => headerRows(ws, [[r + 1 + i, 1, t, { size: 7, italic: true }]]));
    signature(ws, r + 4 + (ctx.notes || []).length, false);
    a4(ws, true, `${top}:${top}`);
    return ws;
}

async function toBuffer(wb) { return Buffer.from(await wb.xlsx.writeBuffer()); }
function workbook() { const wb = new ExcelJS.Workbook(); wb.creator = 'ZTIMS'; wb.created = new Date(); return wb; }

module.exports = { TEMPLATE, safeText, addDae1A, addDae1B, addFormA, workbook, toBuffer };
