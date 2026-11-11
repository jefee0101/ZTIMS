/* Excel files for attraction visits, laid out like the supplied forms: VAR 1
 * (one attraction, one month), DTA2M (all attractions, one month), VAR 3M
 * (all attractions, one year) and VAR 2 (one attraction by month).
 *
 * The numbers come from attraction-engine.js through the same consolidation
 * the screens use; nothing is added up differently here. Empty cells are
 * "not recorded" and a typed 0 is a confirmed zero: they are never mixed.
 * Totals are formulas that stay blank when nothing they add is recorded.
 * Residence Male/Female cells are left empty (sex by residence is not
 * recorded, so it is never estimated). Visits not classified by residence are
 * on a ZTIMS note outside the official grid. Text people typed is written so it
 * is never read as a formula. The supplied VAR 1 grid has no day 31; these
 * files give one row for every real day of the month (decision D2, option A).
 */
const { workbook, toBuffer, safeText } = require('./accommodation-excel');

const FONT = 'Arial';
const YELLOW = 'FFFFFF00', GREEN = 'FF92D050', GREY = 'FFEDEDED';
const thin = { style: 'thin', color: { argb: 'FF000000' } }, dashed = { style: 'dashed', color: { argb: 'FF595959' } };
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
    if (o.border !== false) cell.border = o.dashed ? { top: thin, bottom: thin, left: dashed, right: dashed } : BOX;
    cell.alignment = { vertical: 'middle', horizontal: o.align || 'left', wrapText: !!o.wrap };
    if (o.numFmt) cell.numFmt = o.numFmt;
    return cell;
}
const head = (ws, r, c, text, o = {}) => put(ws, r, c, text, { fill: YELLOW, bold: true, align: 'center', wrap: true, ...o });
const merge = (ws, r1, c1, r2, c2) => { ws.mergeCells(r1, c1, r2, c2); };
const plain = (ws, r, c, text, o = {}) => put(ws, r, c, text, { border: false, ...o });
const page = (ws, landscape = true) => {
    ws.pageSetup = { paperSize: 9, orientation: landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
    ws.headerFooter = { oddFooter: 'Page &P of &N' };
};
const FORM_NOTE = 'Note: *Total number must be recorded, ** Sex & ***Residence entries are optional. Total number of this month must be reported.';
const NOT_TOURISTS = 'Visits to attractions. Not added to accommodation arrivals or guest-nights, and not a count of unique tourists.';
/* A number or an empty cell: null is "not recorded", never 0. */
const n = v => (v === null || v === undefined ? null : v);

/* ---- VAR 1 ------------------------------------------------------------------ */
function addVar1(wb, { attraction, figures: f, status }) {
    const ws = wb.addWorksheet('VAR 1');
    ws.columns = [{ width: 7 }, { width: 11 }, ...Array.from({ length: 12 }, () => ({ width: 9 })), { width: 26 }];
    plain(ws, 1, 1, 'Tourism Attraction Visitor Record', { bold: true, size: 12 });
    plain(ws, 2, 1, '( This recording form can be used instead of just counting the visitors )', { size: 8 });
    plain(ws, 3, 1, status, { italic: true, size: 8, color: status.startsWith('NOT SUBMITTED') ? 'FFB3261E' : 'FF000000' });
    [['Month/Year:', `${MONTHS[f.month - 1]} ${f.year}`], ['Name of Municipality:', 'Zamboanguita'], ['Name of attraction/ Spot:', safeText(attraction.name)], ['Type of Tourism Attraction:', safeText(attraction.type)]]
        .forEach(([k, v], i) => { plain(ws, 4 + i, 1, k, { bold: true }); plain(ws, 4 + i, 5, v); });
    const top = 9;
    head(ws, top, 1, 'Day'); merge(ws, top, 1, top + 3, 1); head(ws, top, 2, 'Week Day (Mon-Sun)'); merge(ws, top, 2, top + 3, 2);
    head(ws, top, 3, '*** Place of Residence'); merge(ws, top, 3, top, 11); head(ws, top, 12, '* Grand Total Number of Visitors'); merge(ws, top, 12, top + 2, 14);
    head(ws, top, 15, 'ZTIMS note (not part of the form)', { fill: GREY, dashed: true }); merge(ws, top, 15, top + 3, 15);
    head(ws, top + 1, 3, 'Philippines'); merge(ws, top + 1, 3, top + 1, 8); head(ws, top + 1, 9, 'Foreign Country Residence'); merge(ws, top + 1, 9, top + 2, 11);
    head(ws, top + 2, 3, 'This province'); merge(ws, top + 2, 3, top + 2, 5); head(ws, top + 2, 6, 'Other Province'); merge(ws, top + 2, 6, top + 2, 8);
    for (let g = 0; g < 4; g++) ['Male', 'Female', 'Total'].forEach((t, i) => head(ws, top + 3, 3 + g * 3 + i, t));
    const first = top + 4;
    f.daily.forEach((d, i) => {
        const r = first + i, c = d.count;
        put(ws, r, 1, i + 1, { align: 'center' }); put(ws, r, 2, DAYS[d.weekday], { align: 'center' });
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
        put(ws, r, 15, note, { size: 8, dashed: true, color: 'FF595959' });
    });
    const last = first + f.daily.length - 1, tr = last + 1;
    put(ws, tr, 1, 'Total of this Month ****', { bold: true, fill: GREEN }); merge(ws, tr, 1, tr, 2);
    const sum = { 5: f.residence.zamboanguita + f.residence.negrosOriental, 8: f.residence.otherProvince, 11: f.residence.foreign, 12: f.sexRecorded ? f.male : null, 13: f.sexRecorded ? f.female : null, 14: f.total };
    for (let col = 3; col <= 14; col++) {
        const L = colName(col), applies = sum[col] !== undefined;
        put(ws, tr, col, applies ? { formula: blankSum(`${L}${first}:${L}${last}`), result: sum[col] === null ? '' : sum[col] } : null, { bold: true, fill: GREEN, align: 'right', numFmt: NUM });
    }
    put(ws, tr, 15, f.residenceUnrecorded ? `${f.residenceUnrecorded} visits: residence not recorded` : '', { dashed: true, bold: true, size: 8 });
    plain(ws, tr + 2, 1, FORM_NOTE, { size: 8 });
    plain(ws, tr + 3, 1, 'Empty cells are not recorded; a 0 is a confirmed zero. Residence Male and Female are left empty: residence totals and sex totals are recorded separately, so sex by residence is not known.', { size: 8 });
    plain(ws, tr + 4, 1, `${f.sexUnrecorded} of ${f.total} visits have no sex recorded; ${f.residenceUnrecorded} have no residence recorded. They are not assigned to any class.`, { size: 8 });
    plain(ws, tr + 5, 1, `Dates recorded ${f.dates} · confirmed zero ${f.zero} · authorized closures ${f.closed}${f.missing.length + f.scheduled.length ? ' · NOT RECORDED ' + (f.missing.length + f.scheduled.length) : ''}. This sheet has one row for every real day of the month; the supplied grid stops at day 30.`, { size: 8 });
    plain(ws, tr + 6, 1, NOT_TOURISTS, { size: 8 });
    plain(ws, tr + 8, 1, 'Prepared by: ______________________', { size: 9 }); plain(ws, tr + 8, 8, 'Noted by: ______________________', { size: 9 });
    ws.views = [{ state: 'frozen', xSplit: 2, ySplit: top + 3 }];
    page(ws);
}

/* ---- DTA2M ------------------------------------------------------------------ */
const KIND_LABEL = { final: 'Finalized', submitted: 'Submitted, not final', reopened: 'Reopened, last submitted', draft: 'Draft, not submitted', none: 'Not submitted', nostaff: 'No Support Staff', before: 'Before reporting', future: 'Not yet' };
function addDta2m(wb, d) {
    const ws = wb.addWorksheet('DTA2M');
    ws.columns = [{ width: 28 }, { width: 10 }, ...Array.from({ length: 15 }, () => ({ width: 8 })), { width: 22 }, { width: 24 }];
    plain(ws, 1, 1, 'Tourism Attraction Visitor Record', { bold: true, size: 12 });
    plain(ws, 2, 1, '( This recording form can be used instead of just counting the visitors )', { size: 8 });
    const official = d.mode === 'official';
    plain(ws, 3, 1, official ? 'Official: finalized monthly versions only.' + (d.issued ? ` Issued ${String(d.issued.at).slice(0, 10)} (${d.issued.status}).` : '') : 'OPERATIONAL, NOT OFFICIAL: includes submitted and draft figures.', { italic: true, size: 8, color: official ? 'FF000000' : 'FFB3261E' });
    plain(ws, 4, 1, 'Month/Year:', { bold: true }); plain(ws, 4, 3, `${MONTHS[d.month - 1]} ${d.year}`);
    plain(ws, 5, 1, 'Name of Municipality:', { bold: true }); plain(ws, 5, 3, 'Zamboanguita');
    const top = 7;
    head(ws, top, 1, 'Visitor Attraction: Name'); merge(ws, top, 1, top + 2, 1); head(ws, top, 2, 'Attraction Code'); merge(ws, top, 2, top + 2, 2);
    head(ws, top, 3, '*** Place of Residence'); merge(ws, top, 3, top, 14); head(ws, top, 15, '* Grand Total Number of Visitors'); merge(ws, top, 15, top + 1, 17);
    head(ws, top, 18, 'ZTIMS notes (not part of the form)', { fill: GREY, dashed: true }); merge(ws, top, 18, top + 2, 19);
    head(ws, top + 1, 3, 'Philippines'); merge(ws, top + 1, 3, top + 1, 11); head(ws, top + 1, 12, 'Foreign Country Residence'); merge(ws, top + 1, 12, top + 1, 14);
    ['This Municipality', 'This Province', 'Other Province', 'Foreign Country Residence'].forEach((t, g) => { if (g < 3) { head(ws, top + 2, 3 + g * 3, t); merge(ws, top + 2, 3 + g * 3, top + 2, 5 + g * 3); } });
    head(ws, top + 2, 12, 'Male'); head(ws, top + 2, 13, 'Female'); head(ws, top + 2, 14, 'Total');
    ['Male', 'Female', 'Total'].forEach((t, i) => head(ws, top + 2, 15 + i, t));
    const first = top + 3;
    d.rows.forEach((row, i) => {
        const r = first + i, x = row.dta2m;
        put(ws, r, 1, safeText(row.spot.title)); put(ws, r, 2, row.code ? safeText(row.code) : '', { align: 'center' });
        for (let c = 3; c <= 17; c++) put(ws, r, c, null, { align: 'right', numFmt: NUM });
        if (x.included) {
            put(ws, r, 5, x.thisMunicipality, { align: 'right', numFmt: NUM }); put(ws, r, 8, x.thisProvince, { align: 'right', numFmt: NUM });
            put(ws, r, 11, x.otherProvince, { align: 'right', numFmt: NUM }); put(ws, r, 14, x.foreign, { align: 'right', numFmt: NUM });
            put(ws, r, 15, n(x.male), { align: 'right', numFmt: NUM }); put(ws, r, 16, n(x.female), { align: 'right', numFmt: NUM }); put(ws, r, 17, x.total, { align: 'right', numFmt: NUM, bold: true });
        } else for (let c = 1; c <= 17; c++) ws.getRow(r).getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } };
        put(ws, r, 18, KIND_LABEL[row.source.kind] + (row.source.version ? ` v${row.source.version}` : '') + (row.source.pending ? ' (correction pending)' : ''), { size: 8, dashed: true });
        put(ws, r, 19, x.included ? (x.residenceUnrecorded ? `${x.residenceUnrecorded} visits: residence not recorded` : '') : 'Not included, not zero', { size: 8, dashed: true });
    });
    const last = first + d.rows.length - 1, tr = last + 1, cols = { 5: d.totals.thisMunicipality, 8: d.totals.thisProvince, 11: d.totals.otherProvince, 14: d.totals.foreign, 15: d.totals.sexAny ? d.totals.male : null, 16: d.totals.sexAny ? d.totals.female : null, 17: d.totals.total };
    put(ws, tr, 1, 'Total of this Month ****', { bold: true, fill: GREEN }); merge(ws, tr, 1, tr, 2);
    for (let c = 3; c <= 17; c++) { const L = colName(c); put(ws, tr, c, cols[c] === undefined ? null : d.rows.length ? { formula: blankSum(`${L}${first}:${L}${last}`), result: d.totals.included ? (cols[c] === null ? '' : cols[c]) : '' } : null, { bold: true, fill: GREEN, align: 'right', numFmt: NUM }); }
    put(ws, tr, 18, `${d.totals.included} of ${d.rows.length} attractions included`, { bold: true, size: 8, dashed: true });
    put(ws, tr, 19, d.totals.residenceUnrecorded ? `${d.totals.residenceUnrecorded} visits: residence not recorded` : '', { bold: true, size: 8, dashed: true });
    plain(ws, tr + 2, 1, FORM_NOTE, { size: 8 });
    plain(ws, tr + 3, 1, 'This Municipality is Zamboanguita; This Province is the rest of Negros Oriental (the classes never overlap). Residence Male and Female are left empty: sex by residence is not recorded.', { size: 8 });
    plain(ws, tr + 4, 1, 'An attraction without a usable month is listed with its status and left empty: not submitted is not zero.', { size: 8 });
    plain(ws, tr + 5, 1, NOT_TOURISTS, { size: 8 });
    ws.views = [{ state: 'frozen', xSplit: 2, ySplit: top + 2 }];
    page(ws);
}

/* ---- VAR 3M ----------------------------------------------------------------- */
function addVar3m(wb, d) {
    const ws = wb.addWorksheet('VAR 3M');
    const A = d.attractions, cols = 1 + A.length * 3 + 3;
    ws.columns = [{ width: 14 }, ...Array.from({ length: A.length * 3 + 3 }, () => ({ width: 10 }))];
    plain(ws, 1, 1, 'VAR 3M', { size: 9 }); plain(ws, 2, 1, 'Annual Report on Same Day Visitors by Attraction', { bold: true, size: 12 });
    const official = d.mode === 'official';
    plain(ws, 3, 1, official ? 'Official: finalized monthly versions only.' + (d.issued ? ` Issued ${String(d.issued.at).slice(0, 10)} (${d.issued.status}).` : '') : 'OPERATIONAL, NOT OFFICIAL: includes submitted and draft figures.', { italic: true, size: 8, color: official ? 'FF000000' : 'FFB3261E' });
    [['Municipality:', 'Zamboanguita'], ['Province:', 'Negros Oriental'], ['Period:', `January to December ${d.year}`]].forEach(([k, v], i) => { plain(ws, 4 + i, 1, k, { bold: true }); plain(ws, 4 + i, 2, v); });
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
        for (let j = 0; j < 3; j++) { const L = []; A.forEach((a, i) => L.push(`${colName(2 + i * 3 + j)}${r}`)); const k = ['domestic', 'foreign', 'total'][j], v = d.byMonth[m]; put(ws, r, g0 + j, A.length ? { formula: blankSum(L.join(',')), result: v ? v[k] : '' } : null, { align: 'right', numFmt: NUM }); }
    });
    const last = first + 11, tr = last + 1;
    put(ws, tr, 1, 'Total:', { fill: YELLOW, bold: true, align: 'right' });
    for (let c = 2; c < g0 + 3; c++) { const L = colName(c), i = Math.floor((c - 2) / 3), j = (c - 2) % 3, k = ['domestic', 'foreign', 'total'][j], v = c >= g0 ? d.grand : d.totals[i];
        const any = c >= g0 ? d.byMonth.some(Boolean) : A[i].months.some(m => m.cell.included); put(ws, tr, c, { formula: blankSum(`${L}${first}:${L}${last}`), result: any ? v[k] : '' }, { bold: true, align: 'right', numFmt: NUM }); }
    put(ws, tr + 1, 1, 'ZTIMS note: residence not recorded', { dashed: true, size: 8, wrap: true });
    A.forEach((a, i) => { put(ws, tr + 1, 2 + i * 3, d.totals[i].unrecorded, { dashed: true, size: 8, align: 'right', numFmt: NUM }); merge(ws, tr + 1, 2 + i * 3, tr + 1, 4 + i * 3); });
    put(ws, tr + 1, g0, d.grand.unrecorded, { dashed: true, size: 8, align: 'right', numFmt: NUM, bold: true }); merge(ws, tr + 1, g0, tr + 1, g0 + 2);
    plain(ws, tr + 3, 1, '* Domestic and Foreign are the residence that was recorded. Domestic is Zamboanguita, the rest of Negros Oriental and other Philippine provinces. Domestic + Foreign is below Total by the visits with no residence recorded (the ZTIMS note row, outside the form); they are not added to either column.', { size: 8 });
    plain(ws, tr + 4, 1, 'An empty month is not submitted or not finalized: it is not zero. The title says "Same Day Visitors"; ZTIMS counts visits to the attraction and cannot tell same-day visitors from overnight guests (decision D4).', { size: 8 });
    plain(ws, tr + 5, 1, NOT_TOURISTS + (d.legacy && d.legacy.note ? ' ' + d.legacy.note : ''), { size: 8 });
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: top + 1 }];
    page(ws);
    return cols;
}

/* ---- VAR 2 ------------------------------------------------------------------ */
function addVar2(wb, { year, mode, attraction: a }) {
    const ws = wb.addWorksheet(`VAR 2 ${safeText(a.spot.title).replace(/[\\/?*[\]:]/g, ' ').slice(0, 22)}`);
    ws.columns = [{ width: 22 }, { width: 11 }, ...Array.from({ length: 6 }, () => ({ width: 11 })), { width: 22 }];
    plain(ws, 1, 1, 'Tourism Attraction Visitor Record', { bold: true, size: 12 }); plain(ws, 2, 1, 'VAR 2', { size: 8 });
    plain(ws, 3, 1, mode === 'official' ? 'Official: finalized monthly versions only.' : 'OPERATIONAL, NOT OFFICIAL: includes submitted and draft figures.', { italic: true, size: 8, color: mode === 'official' ? 'FF000000' : 'FFB3261E' });
    plain(ws, 4, 1, 'Month/Year:', { bold: true }); plain(ws, 4, 3, `January - December ${year}`); plain(ws, 5, 1, 'Name of Municipality:', { bold: true }); plain(ws, 5, 3, 'Zamboanguita');
    const top = 7;
    head(ws, top, 1, 'Name / Month'); merge(ws, top, 1, top + 1, 1); head(ws, top, 2, 'Attraction Code'); merge(ws, top, 2, top + 1, 2);
    head(ws, top, 3, 'This province'); merge(ws, top, 3, top + 1, 3); head(ws, top, 4, 'Other Province'); merge(ws, top, 4, top + 1, 4); head(ws, top, 5, 'Foreign Country Residence'); merge(ws, top, 5, top + 1, 5);
    head(ws, top, 6, '* Grand Total Number of Visitors'); merge(ws, top, 6, top, 8); ['Male', 'Female', 'Total'].forEach((t, i) => head(ws, top + 1, 6 + i, t));
    head(ws, top, 9, 'ZTIMS note (not part of the form)', { fill: GREY, dashed: true }); merge(ws, top, 9, top + 1, 9);
    put(ws, top + 2, 1, safeText(a.spot.title), { bold: true }); put(ws, top + 2, 2, a.code ? safeText(a.code) : '', { align: 'center' });
    for (let c = 3; c <= 8; c++) put(ws, top + 2, c, null);
    const first = top + 3;
    a.months.forEach((m, i) => {
        const r = first + i, x = E_dta2m(m.source); put(ws, r, 1, MONTHS[i], { align: 'right' }); put(ws, r, 2, null);
        if (x) { put(ws, r, 3, x.thisMunicipality + x.thisProvince, { align: 'right', numFmt: NUM }); put(ws, r, 4, x.otherProvince, { align: 'right', numFmt: NUM }); put(ws, r, 5, x.foreign, { align: 'right', numFmt: NUM });
            put(ws, r, 6, n(x.male), { align: 'right', numFmt: NUM }); put(ws, r, 7, n(x.female), { align: 'right', numFmt: NUM }); put(ws, r, 8, x.total, { align: 'right', numFmt: NUM, bold: true });
            put(ws, r, 9, x.residenceUnrecorded ? `${x.residenceUnrecorded} visits: residence not recorded` : '', { size: 8, dashed: true }); }
        else { for (let c = 3; c <= 8; c++) put(ws, r, c, null, { fill: GREY }); put(ws, r, 9, m.source.kind === 'future' ? '' : m.source.kind === 'before' ? 'Before reporting' : 'Not submitted, not zero', { size: 8, dashed: true }); }
    });
    const last = first + 11, tr = last + 1; put(ws, tr, 1, 'Total of this Month ****', { bold: true, fill: GREEN }); merge(ws, tr, 1, tr, 2);
    const used = a.months.map(m => E_dta2m(m.source)).filter(Boolean), tot = used.reduce((acc, x) => ({ p: acc.p + x.thisMunicipality + x.thisProvince, o: acc.o + x.otherProvince, f: acc.f + x.foreign, m: acc.m + (x.male || 0), w: acc.w + (x.female || 0), s: acc.s || x.male !== null, t: acc.t + x.total }), { p: 0, o: 0, f: 0, m: 0, w: 0, s: false, t: 0 });
    const res = { 3: tot.p, 4: tot.o, 5: tot.f, 6: tot.s ? tot.m : '', 7: tot.s ? tot.w : '', 8: tot.t };
    for (let c = 3; c <= 8; c++) { const L = colName(c); put(ws, tr, c, { formula: blankSum(`${L}${first}:${L}${last}`), result: used.length ? res[c] : '' }, { bold: true, fill: GREEN, align: 'right', numFmt: NUM }); }
    plain(ws, tr + 2, 1, FORM_NOTE, { size: 8 }); plain(ws, tr + 3, 1, 'VAR 2 is the annual view of the same monthly versions as DTA2M and VAR 3M. Nothing is entered separately. ' + NOT_TOURISTS, { size: 8 });
    plain(ws, tr + 5, 1, 'Prepared by: ______________________', { size: 9 }); plain(ws, tr + 5, 5, 'Noted by: ______________________', { size: 9 });
    page(ws);
}
const { dta2mRow } = require('./attraction-engine');
const E_dta2m = src => { const r = dta2mRow(src); return r.included ? r : null; };

module.exports = { workbook, toBuffer, addVar1, addDta2m, addVar3m, addVar2 };
