/* Excel files for attraction visits, laid out like the supplied forms: VAR 1
 * (one attraction, one month), DTA2M (all attractions, one month), VAR 3M
 * (all attractions, one year) and VAR 2 (one attraction by month).
 * Sources: 311485232-Visitor-Count-for-Tourist-Attraction-and-LGU.pdf (VAR 1
 * pages 1–4, VAR 2 pages 7–8, VAR 3M pages 10–12) and 826073915-DTA2M-1.pdf.
 *
 * The numbers come from attraction-engine.js through the same consolidation
 * the screens use; nothing is added up differently here. Empty cells are
 * "not recorded" and a typed 0 is a confirmed zero: they are never mixed.
 * Totals are formulas that stay blank when nothing they add is recorded.
 * Residence Male/Female cells are left empty (sex by residence is not
 * recorded, so it is never estimated). Visits not classified by residence are
 * on a ZTIMS note outside the official grid, after a blank column. Text people
 * typed is written so it is never read as a formula.
 *
 * Print arrangement, as the PDFs print: VAR 1, VAR 2 and VAR 3M on A4 portrait,
 * DTA2M on A4 landscape, each continuing sideways onto further pages. The PDFs
 * break where the original sheets' widths happened to end (sometimes inside a
 * column group); these files break at the nearest group boundary instead, so
 * no group is split. Adaptations (listed in docs/attraction-reporting/04):
 * one row per real day (day 31 included, decision D2), one row or column
 * group per attraction, empty cells for "not recorded", the ZTIMS notes.
 */
const JSZip = require('jszip');
const { workbook, toBuffer: plainBuffer, safeText } = require('./accommodation-excel');
const E = require('./attraction-engine');

const FONT = 'Arial';
const YELLOW = 'FFFFFF00', GREEN = 'FF92D050', DARK_GREEN = 'FF00B050', GREY = 'FFEDEDED';
const thin = { style: 'thin', color: { argb: 'FF000000' } }, medium = { style: 'medium', color: { argb: 'FF000000' } }, dashed = { style: 'dashed', color: { argb: 'FF595959' } };
const BOX = { top: thin, left: thin, bottom: thin, right: thin };
const NUM = '#,##0';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const colName = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const blankSum = range => `IF(COUNT(${range})=0,"",SUM(${range}))`;

function put(ws, r, c, value, o = {}) {
    const cell = ws.getRow(r).getCell(c);
    cell.value = value === undefined ? null : value;
    cell.font = { name: FONT, size: o.size || 9, bold: !!o.bold, italic: !!o.italic, color: { argb: o.color || 'FF000000' } };
    if (o.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
    if (o.border !== false) cell.border = o.dashed ? { top: thin, bottom: thin, left: dashed, right: dashed } : o.heavy ? { top: medium, bottom: medium, left: thin, right: thin } : BOX;
    cell.alignment = { vertical: 'middle', horizontal: o.align || 'left', wrapText: !!o.wrap };
    if (o.numFmt) cell.numFmt = o.numFmt;
    return cell;
}
const head = (ws, r, c, text, o = {}) => put(ws, r, c, text, { fill: YELLOW, bold: true, align: 'center', wrap: true, ...o });
const merge = (ws, r1, c1, r2, c2) => { ws.mergeCells(r1, c1, r2, c2); };
const plain = (ws, r, c, text, o = {}) => put(ws, r, c, text, { border: false, ...o });
/* "Label:" right-aligned, its value on an underlined line, as the forms print their header fields. */
function field(ws, r, labelFrom, labelTo, label, valueFrom, valueTo, value) {
    plain(ws, r, labelFrom, label, { align: 'right' });
    if (labelTo > labelFrom) merge(ws, r, labelFrom, r, labelTo);
    for (let c = valueFrom; c <= valueTo; c++) { const cell = plain(ws, r, c, c === valueFrom ? value : null); cell.border = { bottom: thin }; }
    if (valueTo > valueFrom) merge(ws, r, valueFrom, r, valueTo);
}
/* A4, the form's orientation, actual size; `colBreaks` are the last columns of each page part,
   `rowBreak` the last row of the first page down. Pages run down, then over, as the PDFs do. */
function printLayout(ws, { landscape = false, colBreaks = [], rowBreak = null, scale = 100 }) {
    ws.pageSetup = { paperSize: 9, orientation: landscape ? 'landscape' : 'portrait', fitToPage: false, scale, pageOrder: 'downThenOver',
        margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
    ws.headerFooter = { oddFooter: 'Page &P of &N' };
    if (rowBreak) ws.getRow(rowBreak).addPageBreak();
    ws.ztimsColBreaks = colBreaks;
}
/* ExcelJS writes row breaks but not column breaks: they are added to each sheet's XML here. */
async function toBuffer(wb) {
    const buffer = await plainBuffer(wb);
    const sheets = wb.worksheets.filter(ws => ws.ztimsColBreaks && ws.ztimsColBreaks.length);
    if (!sheets.length) return buffer;
    const zip = await JSZip.loadAsync(buffer);
    for (const ws of sheets) {
        const path = `xl/worksheets/sheet${ws.id}.xml`;
        const file = zip.file(path);
        if (!file) continue;
        let xml = await file.async('string');
        const list = ws.ztimsColBreaks;
        const tag = `<colBreaks count="${list.length}" manualBreakCount="${list.length}">${list.map(c => `<brk id="${c}" max="1048575" man="1"/>`).join('')}</colBreaks>`;
        // Schema order: … pageSetup, headerFooter, rowBreaks, colBreaks, … drawing …
        if (xml.includes('</rowBreaks>')) xml = xml.replace('</rowBreaks>', '</rowBreaks>' + tag);
        else if (/<headerFooter[^>]*\/>/.test(xml)) xml = xml.replace(/(<headerFooter[^>]*\/>)/, '$1' + tag);
        else if (xml.includes('</headerFooter>')) xml = xml.replace('</headerFooter>', '</headerFooter>' + tag);
        else xml = xml.replace(/(<pageSetup[^>]*\/>)/, '$1' + tag);
        zip.file(path, xml);
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const FORM_NOTE = 'Note: *Total number must be recorded, ** Sex & ***Residence entries are optional. Total number of this month must be reported.';
const NOT_TOURISTS = 'Visits to attractions. Not added to accommodation arrivals or guest-nights, and not a count of unique tourists.';
/* A number or an empty cell: null is "not recorded", never 0. */
const n = v => (v === null || v === undefined ? null : v);
const statusLine = (ws, r, c, text, bad) => plain(ws, r, c, text, { italic: true, size: 8, color: bad ? 'FFB3261E' : 'FF000000' });
/* A note wrapped across columns c1–c2 (the first page part), so it never runs onto a page of its own. */
function note(ws, r, c1, c2, text, o = {}) {
    plain(ws, r, c1, text, { size: 8, wrap: true, ...o });
    merge(ws, r, c1, r, c2);
    let chars = 0; for (let c = c1; c <= c2; c++) chars += ws.getColumn(c).width || 9;
    ws.getRow(r).height = Math.max(12, Math.ceil(String(text).length * 1.15 / chars) * 11);
}
/* The residence header shared by DTA2M and VAR 2: four header rows from `top`, groups of Male/Female/Total. */
function residenceHeader(ws, top, nameLabel, philippine) {
    head(ws, top, 1, 'Visitor Attraction'); merge(ws, top, 1, top, 2);
    head(ws, top + 1, 1, nameLabel); merge(ws, top + 1, 1, top + 3, 1); head(ws, top + 1, 2, 'Attraction Code'); merge(ws, top + 1, 2, top + 3, 2);
    const fEnd = 2 + philippine.length * 3, gStart = fEnd + 4;
    head(ws, top, 3, '*** Place of Residence'); merge(ws, top, 3, top, fEnd + 3);
    head(ws, top + 1, 3, 'Philippines'); merge(ws, top + 1, 3, top + 1, fEnd);
    philippine.forEach((t, g) => { head(ws, top + 2, 3 + g * 3, t); merge(ws, top + 2, 3 + g * 3, top + 2, 5 + g * 3); });
    head(ws, top + 1, fEnd + 1, 'Foreign Country Residence'); merge(ws, top + 1, fEnd + 1, top + 2, fEnd + 3);
    head(ws, top, gStart, '* Grand Total Number of Visitors'); merge(ws, top, gStart, top + 2, gStart + 2);
    for (let c = 3; c <= gStart + 2; c += 3) ['Male', 'Female', 'Total'].forEach((t, i) => head(ws, top + 3, c + i, t));
    return { fEnd, gStart };
}

/* ---- VAR 1 ------------------------------------------------------------------ */
function addVar1(wb, { attraction, figures: f, status }) {
    const ws = wb.addWorksheet('VAR 1');
    // A Day, B Week Day, C–H Philippines (This province, Other Province), I–K Foreign, L–N Grand Total, O gap, P ZTIMS note.
    ws.columns = [{ width: 6 }, { width: 10 }, ...Array.from({ length: 12 }, () => ({ width: 8.5 })), { width: 2 }, { width: 28 }];
    plain(ws, 1, 1, 'Tourism Attraction Visitor Record', { bold: true, size: 11 });
    plain(ws, 1, 12, '(VAR 1)', { align: 'center' }); merge(ws, 1, 12, 1, 14);
    plain(ws, 2, 1, '( This recording form can be used instead of just counting the visitors )', { size: 8 });
    statusLine(ws, 3, 1, status, status.startsWith('NOT SUBMITTED'));
    field(ws, 4, 1, 5, 'Month/Year:', 6, 8, `${MONTHS[f.month - 1]} ${f.year}`);
    field(ws, 5, 1, 5, 'Name of Municipality:', 6, 8, 'Zamboanguita');
    field(ws, 6, 1, 5, 'Name of attraction/ Spot:', 6, 8, safeText(attraction.name));
    plain(ws, 8, 1, 'Type of Tourism Attraction:', { align: 'right' }); merge(ws, 8, 1, 8, 3);
    put(ws, 8, 4, safeText(attraction.type || ''), { align: 'center' }); merge(ws, 8, 4, 8, 5);
    const top = 9;
    head(ws, top, 1, 'Date'); merge(ws, top, 1, top, 2);
    head(ws, top + 1, 1, 'Day'); merge(ws, top + 1, 1, top + 3, 1); head(ws, top + 1, 2, 'Week Day (Mon-Sun)'); merge(ws, top + 1, 2, top + 3, 2);
    head(ws, top, 3, '*** Place of Residence'); merge(ws, top, 3, top, 11); head(ws, top, 12, '* Grand Total Number of Visitors'); merge(ws, top, 12, top + 2, 14);
    head(ws, top + 1, 3, 'Philippines'); merge(ws, top + 1, 3, top + 1, 8); head(ws, top + 1, 9, 'Foreign Country Residence'); merge(ws, top + 1, 9, top + 2, 11);
    head(ws, top + 2, 3, 'This province'); merge(ws, top + 2, 3, top + 2, 5); head(ws, top + 2, 6, 'Other Province'); merge(ws, top + 2, 6, top + 2, 8);
    for (let g = 0; g < 4; g++) ['Male', 'Female', 'Total'].forEach((t, i) => head(ws, top + 3, 3 + g * 3 + i, t));
    head(ws, top, 16, 'ZTIMS note (not part of the form)', { fill: GREY, dashed: true }); merge(ws, top, 16, top + 3, 16);
    const first = top + 4;
    f.daily.forEach((d, i) => {
        const r = first + i, c = d.count;
        put(ws, r, 1, i + 1, { align: 'center', size: 10 }); put(ws, r, 2, DAYS[d.weekday], { align: 'center', size: 10 });
        for (let col = 3; col <= 14; col++) put(ws, r, col, null, { align: 'right', numFmt: NUM });
        let note = '';
        if (c) {
            const hasRes = c.total === 0 || c.residence.zamboanguita !== null || c.residence.negrosOriental !== null || c.residence.otherProvince !== null || c.residence.foreign !== null || c.residenceComplete;
            if (hasRes) {
                put(ws, r, 5, (c.residence.zamboanguita || 0) + (c.residence.negrosOriental || 0), { align: 'right', numFmt: NUM });
                put(ws, r, 8, c.residence.otherProvince || 0, { align: 'right', numFmt: NUM }); put(ws, r, 11, c.residence.foreign || 0, { align: 'right', numFmt: NUM });
            }
            if (c.total > 0 && (c.male !== null || c.female !== null)) { put(ws, r, 12, c.male || 0, { align: 'right', numFmt: NUM }); put(ws, r, 13, c.female || 0, { align: 'right', numFmt: NUM }); }
            put(ws, r, 14, c.total, { align: 'right', numFmt: NUM, bold: true });
            const known = ['zamboanguita', 'negrosOriental', 'otherProvince', 'foreign'].reduce((a, k) => a + (c.residence[k] || 0), 0);
            if (c.total - known > 0) note = `${c.total - known} visits: residence not recorded`;
        } else {
            note = { closed: `Closed (authorized): ${safeText(d.why || '')}`, missing: 'Not recorded', scheduled: 'Scheduled closure, not recorded', today: 'Not recorded yet', future: 'Not yet', before: 'Before reporting' }[d.state] || '';
            for (let col = 1; col <= 14; col++) ws.getRow(r).getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } };
        }
        put(ws, r, 16, note, { size: 8, dashed: true, color: 'FF595959' });
    });
    const last = first + f.daily.length - 1, tr = last + 1;
    ws.getRow(tr).height = 24;
    put(ws, tr, 1, 'Total of this Month ****', { bold: true, fill: GREEN, wrap: true, align: 'center', heavy: true }); merge(ws, tr, 1, tr, 2);
    const rk = E.residenceKnown(f);
    const sum = { 5: rk ? f.residence.zamboanguita + f.residence.negrosOriental : null, 8: rk ? f.residence.otherProvince : null, 11: rk ? f.residence.foreign : null, 12: f.sexRecorded ? f.male : null, 13: f.sexRecorded ? f.female : null, 14: f.total };
    for (let col = 3; col <= 14; col++) {
        const L = colName(col), applies = sum[col] !== undefined;
        put(ws, tr, col, applies ? { formula: blankSum(`${L}${first}:${L}${last}`), result: sum[col] === null ? '' : sum[col] } : null, { bold: true, fill: GREEN, align: 'right', numFmt: NUM, heavy: true });
    }
    put(ws, tr, 16, f.residenceUnrecorded ? `${f.residenceUnrecorded} visits: residence not recorded` : '', { dashed: true, bold: true, size: 8 });
    note(ws, tr + 1, 1, 8, FORM_NOTE);
    // ZTIMS notes, below the form.
    plain(ws, tr + 3, 1, 'ZTIMS notes (not part of the form):', { size: 8, bold: true });
    note(ws, tr + 4, 1, 8, 'Empty cells are not recorded; a 0 is a confirmed zero. Residence Male and Female are left empty: residence and sex are recorded separately, so sex by residence is not known.');
    note(ws, tr + 5, 1, 8, `${f.sexUnrecorded} of ${f.total} visits have no sex recorded; ${f.residenceUnrecorded} have no residence recorded. They are not assigned to any class.`);
    note(ws, tr + 6, 1, 8, `Dates recorded ${f.dates} · confirmed zero ${f.zero} · authorized closures ${f.closed}${f.missing.length + f.scheduled.length ? ' · NOT RECORDED ' + (f.missing.length + f.scheduled.length) : ''}. One row for every real day of the month; the supplied grid stops at day 30.`);
    note(ws, tr + 7, 1, 8, NOT_TOURISTS);
    ws.views = [{ state: 'frozen', xSplit: 2, ySplit: top + 3 }];
    // As the PDF: days 1–28 on page 1, the rest on page 2; Foreign and Grand Total on pages 3–4.
    printLayout(ws, { landscape: false, colBreaks: [8], rowBreak: first + 27 });
}

/* ---- DTA2M ------------------------------------------------------------------ */
const KIND_LABEL = { final: 'Finalized', submitted: 'Submitted, not final', reopened: 'Reopened, last submitted', draft: 'Draft, not submitted', none: 'Not submitted', nostaff: 'No Support Staff', before: 'Before reporting', future: 'Not yet' };
function addDta2m(wb, d) {
    const ws = wb.addWorksheet('DTA2M');
    // A Name, B Code, C–K Philippines, L–N Foreign, O–Q Grand Total, R gap, S–T ZTIMS notes.
    ws.columns = [{ width: 24 }, { width: 9 }, ...Array.from({ length: 15 }, () => ({ width: 7.5 })), { width: 2 }, { width: 22 }, { width: 26 }];
    plain(ws, 1, 1, 'Tourism Attraction Visitor Record', { bold: true, size: 11 });
    plain(ws, 1, 12, 'DTA2M', { align: 'center' }); merge(ws, 1, 12, 1, 17);
    plain(ws, 2, 1, '( This recording form can be used instead of just counting the visitors )', { size: 8 });
    const official = d.mode === 'official';
    statusLine(ws, 3, 1, official ? 'Official: finalized monthly versions only.' + (d.issued ? ` Issued ${String(d.issued.at).slice(0, 10)} (${d.issued.status}).` : '') : 'OPERATIONAL, NOT OFFICIAL: includes submitted and draft figures.', !official);
    field(ws, 4, 1, 6, 'Month/Year:', 7, 14, `${MONTHS[d.month - 1]} ${d.year}`);
    field(ws, 5, 1, 6, 'Name of Municipality:', 7, 14, 'Zamboanguita');
    const top = 7;
    residenceHeader(ws, top, 'Name', ['This Municipality', 'This Province', 'Other Province']);
    head(ws, top, 19, 'ZTIMS notes (not part of the form)', { fill: GREY, dashed: true }); merge(ws, top, 19, top + 3, 20);
    const first = top + 4;
    d.rows.forEach((row, i) => {
        const r = first + i, x = row.dta2m;
        put(ws, r, 1, safeText(row.spot.title), { size: 10 }); put(ws, r, 2, row.code ? safeText(row.code) : '', { align: 'center' });
        for (let c = 3; c <= 17; c++) put(ws, r, c, null, { align: 'right', numFmt: NUM });
        if (x.included) {
            put(ws, r, 5, x.thisMunicipality, { align: 'right', numFmt: NUM }); put(ws, r, 8, x.thisProvince, { align: 'right', numFmt: NUM });
            put(ws, r, 11, x.otherProvince, { align: 'right', numFmt: NUM }); put(ws, r, 14, x.foreign, { align: 'right', numFmt: NUM });
            put(ws, r, 15, n(x.male), { align: 'right', numFmt: NUM }); put(ws, r, 16, n(x.female), { align: 'right', numFmt: NUM }); put(ws, r, 17, x.total, { align: 'right', numFmt: NUM, bold: true });
        } else for (let c = 1; c <= 17; c++) ws.getRow(r).getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } };
        put(ws, r, 19, KIND_LABEL[row.source.kind] + (row.source.version ? ` v${row.source.version}` : '') + (row.source.pending ? ' (correction pending)' : ''), { size: 8, dashed: true });
        put(ws, r, 20, x.included ? (x.residenceUnrecorded ? `${x.residenceUnrecorded} visits: residence not recorded` : '') : 'Not included, not zero', { size: 8, dashed: true });
    });
    // The form keeps one empty row before its total.
    const blank = first + d.rows.length;
    for (let c = 1; c <= 17; c++) put(ws, blank, c, null);
    const last = blank, tr = last + 1, cols = { 5: d.totals.thisMunicipality, 8: d.totals.thisProvince, 11: d.totals.otherProvince, 14: d.totals.foreign, 15: d.totals.sexAny ? d.totals.male : null, 16: d.totals.sexAny ? d.totals.female : null, 17: d.totals.total };
    ws.getRow(tr).height = 24;
    put(ws, tr, 1, 'Total of this Month ****', { bold: true, fill: GREEN, heavy: true, align: 'center' }); merge(ws, tr, 1, tr, 2);
    for (let c = 3; c <= 17; c++) {
        const L = colName(c);
        put(ws, tr, c, cols[c] === undefined ? null : d.rows.length ? { formula: blankSum(`${L}${first}:${L}${last}`), result: d.totals.included ? (cols[c] === null ? '' : cols[c]) : '' } : null,
            { bold: true, fill: c === 15 || c === 16 ? DARK_GREEN : GREEN, align: 'right', numFmt: NUM, heavy: true });
    }
    put(ws, tr, 19, `${d.totals.included} of ${d.rows.length} attractions included`, { bold: true, size: 8, dashed: true });
    put(ws, tr, 20, d.totals.residenceUnrecorded ? `${d.totals.residenceUnrecorded} visits: residence not recorded` : '', { bold: true, size: 8, dashed: true });
    note(ws, tr + 1, 1, 11, FORM_NOTE);
    plain(ws, tr + 3, 1, 'ZTIMS notes (not part of the form):', { size: 8, bold: true });
    note(ws, tr + 4, 1, 11, 'This Municipality is Zamboanguita; This Province is the rest of Negros Oriental (the classes never overlap). Residence Male and Female are left empty: sex by residence is not recorded.');
    note(ws, tr + 5, 1, 11, 'An attraction without a usable month is listed with its status and left empty: not submitted is not zero. Empty residence cells: residence not recorded.');
    note(ws, tr + 6, 1, 11, NOT_TOURISTS);
    ws.views = [{ state: 'frozen', xSplit: 2, ySplit: top + 3 }];
    // As the PDF: landscape, the Philippine columns on page 1, Foreign and Grand Total continued on page 2.
    printLayout(ws, { landscape: true, colBreaks: [11] });
}

/* ---- VAR 3M ----------------------------------------------------------------- */
function addVar3m(wb, d) {
    const ws = wb.addWorksheet('VAR 3M');
    const A = d.attractions, cols = 1 + A.length * 3 + 3;
    ws.columns = [{ width: 13 }, ...Array.from({ length: A.length * 3 + 3 }, () => ({ width: 9.5 }))];
    plain(ws, 1, 1, 'VAR 3M', { size: 9 }); plain(ws, 2, 1, 'Annual Report on Same Day Visitors by Attraction', { bold: true, size: 11 });
    const official = d.mode === 'official';
    statusLine(ws, 3, 1, official ? 'Official: finalized monthly versions only.' + (d.issued ? ` Issued ${String(d.issued.at).slice(0, 10)} (${d.issued.status}).` : '') : 'OPERATIONAL, NOT OFFICIAL: includes submitted and draft figures.', !official);
    [['Municipality:', 'Zamboanguita'], ['Province:', 'Negros Oriental'], ['Period:', `January to December ${d.year}`]].forEach(([k, v], i) => {
        plain(ws, 4 + i, 1, k, { bold: true, size: 10 });
        for (let c = 2; c <= 4; c++) { const cell = plain(ws, 4 + i, c, c === 2 ? v : null); cell.border = { bottom: thin }; }
        merge(ws, 4 + i, 2, 4 + i, 4);
    });
    const top = 8;
    head(ws, top, 1, 'Month'); merge(ws, top, 1, top + 1, 1);
    A.forEach((a, i) => { head(ws, top, 2 + i * 3, `${safeText(a.spot.title)} - (${a.code ? safeText(a.code) : 'Code pending'})`); merge(ws, top, 2 + i * 3, top, 4 + i * 3); ['Domestic', 'Foreign', 'Total'].forEach((t, j) => head(ws, top + 1, 2 + i * 3 + j, t)); });
    const g0 = 2 + A.length * 3; head(ws, top, g0, 'Grand Total Visitors'); merge(ws, top, g0, top, g0 + 2); ['Domestic', 'Foreign', 'Total'].forEach((t, j) => head(ws, top + 1, g0 + j, t));
    const first = top + 2;
    MONTHS.forEach((mn, m) => {
        const r = first + m; put(ws, r, 1, mn, { fill: YELLOW, bold: true });
        A.forEach((a, i) => {
            const c = a.months[m].cell, mark = c.included && c.unrecorded ? ' *' : '';
            ['domestic', 'foreign', 'total'].forEach((k, j) => put(ws, r, 2 + i * 3 + j, c.included ? c[k] : null, { align: 'right', numFmt: NUM + (j < 2 && mark ? '"*"' : '') }));
        });
        for (let j = 0; j < 3; j++) { const L = []; A.forEach((a, i) => L.push(`${colName(2 + i * 3 + j)}${r}`)); const k = ['domestic', 'foreign', 'total'][j], v = d.byMonth[m]; put(ws, r, g0 + j, A.length ? { formula: blankSum(L.join(',')), result: v && v[k] != null ? v[k] : '' } : null, { align: 'right', numFmt: NUM }); }
    });
    const last = first + 11, tr = last + 1;
    put(ws, tr, 1, 'Total:', { fill: YELLOW, bold: true, align: 'right', heavy: true });
    for (let c = 2; c < g0 + 3; c++) { const L = colName(c), i = Math.floor((c - 2) / 3), j = (c - 2) % 3, k = ['domestic', 'foreign', 'total'][j], v = c >= g0 ? d.grand : d.totals[i];
        const any = c >= g0 ? d.byMonth.some(Boolean) : A[i].months.some(m => m.cell.included); put(ws, tr, c, { formula: blankSum(`${L}${first}:${L}${last}`), result: any && v[k] != null ? v[k] : '' }, { bold: true, align: 'right', numFmt: NUM, heavy: true }); }
    // ZTIMS rows, below the form and apart from it.
    put(ws, tr + 2, 1, 'ZTIMS note: residence not recorded', { dashed: true, size: 8, wrap: true });
    A.forEach((a, i) => { put(ws, tr + 2, 2 + i * 3, d.totals[i].unrecorded, { dashed: true, size: 8, align: 'right', numFmt: NUM }); merge(ws, tr + 2, 2 + i * 3, tr + 2, 4 + i * 3); });
    put(ws, tr + 2, g0, d.grand.unrecorded, { dashed: true, size: 8, align: 'right', numFmt: NUM, bold: true }); merge(ws, tr + 2, g0, tr + 2, g0 + 2);
    ws.getRow(tr + 2).height = 36;
    note(ws, tr + 4, 1, Math.min(7, g0 + 2), '* Domestic and Foreign are the residence that was recorded: Domestic is Zamboanguita, the rest of Negros Oriental and other Philippine provinces. Domestic + Foreign is below Total by the visits with no residence recorded (the ZTIMS note row); they are not added to either column. Empty: residence not recorded that month.');
    note(ws, tr + 5, 1, Math.min(7, g0 + 2), 'An empty month is not submitted or not finalized: it is not zero. The title says "Same Day Visitors"; ZTIMS counts visits to the attraction and cannot tell same-day visitors from overnight guests (decision D4).');
    note(ws, tr + 6, 1, Math.min(7, g0 + 2), NOT_TOURISTS + (d.legacy && d.legacy.note ? ' ' + d.legacy.note : ''));
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: top + 1 }];
    // As the PDF: portrait, Month and two attraction groups on the first page, then two groups per page sideways.
    const breaks = [];
    for (let g = 2; g < A.length + 1; g += 2) breaks.push(1 + g * 3);
    printLayout(ws, { landscape: false, colBreaks: breaks });
    return cols;
}

/* ---- VAR 2 ------------------------------------------------------------------ */
function addVar2(wb, { year, mode, attraction: a }) {
    const ws = wb.addWorksheet(`VAR 2 ${safeText(a.spot.title).replace(/[\\/?*[\]:]/g, ' ').slice(0, 22)}`);
    // A Name / Month, B Code, C–H Philippines (This province, Other Province), I–K Foreign, L–N Grand Total, O gap, P ZTIMS note.
    ws.columns = [{ width: 17 }, { width: 9 }, ...Array.from({ length: 12 }, () => ({ width: 7.5 })), { width: 2 }, { width: 26 }];
    plain(ws, 1, 1, 'Tourism Attraction Visitor Record', { bold: true, size: 11 });
    plain(ws, 1, 9, 'VAR 2', { align: 'center' }); merge(ws, 1, 9, 1, 14);
    plain(ws, 2, 1, '( This recording form can be used instead of just counting the visitors )', { size: 8 });
    statusLine(ws, 3, 1, mode === 'official' ? 'Official: finalized monthly versions only.' : 'OPERATIONAL, NOT OFFICIAL: includes submitted and draft figures.', mode !== 'official');
    field(ws, 4, 1, 5, 'Month/Year:', 6, 8, `January - December ${year}`);
    field(ws, 5, 1, 5, 'Name of Municipality:', 6, 8, 'Zamboanguita');
    const top = 7;
    residenceHeader(ws, top, 'Name / Month', ['This province', 'Other Province']);
    head(ws, top, 16, 'ZTIMS note (not part of the form)', { fill: GREY, dashed: true }); merge(ws, top, 16, top + 3, 16);
    put(ws, top + 4, 1, safeText(a.spot.title), { bold: true, size: 10 }); put(ws, top + 4, 2, a.code ? safeText(a.code) : '', { align: 'center' });
    for (let c = 3; c <= 14; c++) put(ws, top + 4, c, null);
    const first = top + 5;
    a.months.forEach((m, i) => {
        const r = first + i, x = E_dta2m(m.source); put(ws, r, 1, MONTHS[i], { align: 'center', size: 10 }); put(ws, r, 2, null);
        for (let c = 3; c <= 14; c++) put(ws, r, c, null, { align: 'right', numFmt: NUM });
        if (x) { put(ws, r, 5, E.addN(x.thisMunicipality, x.thisProvince), { align: 'right', numFmt: NUM }); put(ws, r, 8, x.otherProvince, { align: 'right', numFmt: NUM }); put(ws, r, 11, x.foreign, { align: 'right', numFmt: NUM });
            put(ws, r, 12, n(x.male), { align: 'right', numFmt: NUM }); put(ws, r, 13, n(x.female), { align: 'right', numFmt: NUM }); put(ws, r, 14, x.total, { align: 'right', numFmt: NUM, bold: true });
            put(ws, r, 16, x.residenceUnrecorded ? `${x.residenceUnrecorded} visits: residence not recorded` : '', { size: 8, dashed: true }); }
        else { for (let c = 3; c <= 14; c++) ws.getRow(r).getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } }; put(ws, r, 16, m.source.kind === 'future' ? '' : m.source.kind === 'before' ? 'Before reporting' : 'Not submitted, not zero', { size: 8, dashed: true }); }
    });
    const last = first + 11, blank = last + 1, tr = blank + 1;
    for (let c = 1; c <= 14; c++) put(ws, blank, c, null);
    ws.getRow(tr).height = 24;
    put(ws, tr, 1, 'Total of this Month ****', { bold: true, fill: GREEN, heavy: true, align: 'center' }); merge(ws, tr, 1, tr, 2);
    const used = a.months.map(m => E_dta2m(m.source)).filter(Boolean), tot = used.reduce((acc, x) => ({ p: E.addN(acc.p, E.addN(x.thisMunicipality, x.thisProvince)), o: E.addN(acc.o, x.otherProvince), f: E.addN(acc.f, x.foreign), m: acc.m + (x.male || 0), w: acc.w + (x.female || 0), s: acc.s || x.male !== null, t: acc.t + x.total }), { p: null, o: null, f: null, m: 0, w: 0, s: false, t: 0 });
    const res = { 5: tot.p == null ? '' : tot.p, 8: tot.o == null ? '' : tot.o, 11: tot.f == null ? '' : tot.f, 12: tot.s ? tot.m : '', 13: tot.s ? tot.w : '', 14: tot.t };
    for (let c = 3; c <= 14; c++) { const L = colName(c); put(ws, tr, c, res[c] === undefined ? null : { formula: blankSum(`${L}${first}:${L}${last}`), result: used.length ? res[c] : '' }, { bold: true, fill: c === 12 || c === 13 ? DARK_GREEN : GREEN, align: 'right', numFmt: NUM, heavy: true }); }
    note(ws, tr + 1, 1, 8, FORM_NOTE);
    plain(ws, tr + 3, 1, 'Prepared by:', { bold: true, size: 11 }); plain(ws, tr + 3, 6, 'Noted by:', { bold: true, size: 11 });
    note(ws, tr + 6, 1, 8, 'ZTIMS notes (not part of the form): VAR 2 is the annual view of the same monthly versions as DTA2M and VAR 3M; nothing is entered separately. This province is Zamboanguita and the rest of Negros Oriental. Residence Male and Female are left empty. ' + NOT_TOURISTS);
    // As the PDF: portrait, Philippine columns on page 1, Foreign and Grand Total continued on page 2.
    printLayout(ws, { landscape: false, colBreaks: [8] });
}
const { dta2mRow } = E;
const E_dta2m = src => { const r = dta2mRow(src); return r.included ? r : null; };

module.exports = { workbook, toBuffer, addVar1, addDta2m, addVar3m, addVar2 };
