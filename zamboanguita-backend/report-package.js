// ZIP packages contain workbooks only: never guest names or register records.
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const crypto = require('crypto');
const safe = value => String(value || 'Report').normalize('NFKC').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 65);
const fingerprint = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
function manifest(kind, year, month, entries, extra = {}) {
    const complete = entries.length > 0 && entries.every(e => e.ready || e.exempt) && extra.ended;
    return { kind, year, month, complete, entries, ...extra, fingerprint: fingerprint({ entries, ...extra }) };
}
async function send(res, data, files) {
    const root = `ZTIMS_${data.kind}_${data.year}-${String(data.month).padStart(2,'0')}${data.complete ? '' : '_DRAFT'}`;
    const zip = new JSZip(), folder = zip.folder(root), generated = new Date().toISOString();
    for (const [name, buffer] of files) folder.file(name, buffer);
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Report checklist');
    const text = v => /^[=+@-]/.test(String(v)) ? "'" + v : String(v ?? '');
    ws.addRow(['ZTIMS submission package', data.complete ? 'Complete' : 'DRAFT']);
    ws.addRow(['Reporting period', `${data.year}-${String(data.month).padStart(2,'0')}`]);
    ws.addRow(['Generated (UTC)', generated]);
    ws.addRow(['Delivery', 'Downloaded package only; not proof of delivery to another office.']);
    ws.addRow(['Enterprise / attraction', 'Report', 'Version', 'Status', 'Included', 'File']);
    for (const e of data.entries) ws.addRow([text(e.name), e.report, e.version || '', text(e.status), e.file ? 'Yes' : 'No', e.file || '']);
    ws.columns = [35,25,12,40,12,85].map(width=>({width}));
    ws.getRow(5).font = {bold:true}; ws.views=[{state:'frozen',ySplit:5}];
    folder.file(`Report_Checklist_${data.year}-${String(data.month).padStart(2,'0')}.xlsx`, await wb.xlsx.writeBuffer());
    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition',`attachment; filename="${root}.zip"`);
    res.setHeader('Cache-Control','no-store');
    res.send(await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
}
module.exports = { safe, fingerprint, manifest, send };
