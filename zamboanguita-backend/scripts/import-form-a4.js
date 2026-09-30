/* Loads a year of Form A4 that was kept on paper into ZTIMS, as the
 * municipality's total for each month.
 *
 *   DATABASE_URL=… npm run import-form-a4 -- db/form-a4-2025.json --dry-run
 *   DATABASE_URL=… npm run import-form-a4 -- db/form-a4-2025.json
 *
 * --dry-run   checks the file against the residences table and prints what
 *             would be written, month by month. Writes nothing. Run it first.
 *
 * The file holds, per month, the arrivals by residence (totals only — the
 * printed sheet was not split by sex), the number of rooms, the room-nights
 * occupied and the guest nights. Each month becomes one `municipal_total`
 * report. Such a month then refuses per-establishment reports, so it is never
 * counted twice; to move a month over to per-establishment reports, the
 * officer voids its municipal total.
 *
 * The months are locked as they land: a printed sheet already went to the
 * province. The officer can unlock one with a reason if a figure is wrong.
 *
 * A month that already has a municipal total is skipped, never overwritten, so
 * running this twice changes nothing. A month that already has
 * per-establishment reports stops the whole import instead — the office should
 * decide which of the two is the record. Every write happens in one
 * transaction: the year lands whole, or not at all.
 *
 * When `printedGrandTotal` is in the file, each month's total is compared with
 * it and any difference is printed, so a slip on the paper sheet is seen, not
 * silently carried over or silently fixed.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const IMPORTER = { role: 'import', email: 'printed Form A4' };

function readFile(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(data.year)) throw new Error('The file has no "year".');
    if (!Array.isArray(data.months) || !data.months.length) throw new Error('The file has no "months".');
    const seen = new Set();
    for (const m of data.months) {
        if (!Number.isInteger(m.month) || m.month < 1 || m.month > 12) throw new Error(`A month of ${m.month} is not 1–12.`);
        if (seen.has(m.month)) throw new Error(`Month ${m.month} appears twice.`);
        seen.add(m.month);
        for (const [code, total] of Object.entries(m.counts || {})) {
            if (!Number.isInteger(total) || total < 0) throw new Error(`Month ${m.month}, ${code}: ${total} is not a whole number ≥ 0.`);
        }
        for (const key of ['rooms', 'roomNightsOccupied', 'guestNights']) {
            if (m[key] != null && (!Number.isInteger(m[key]) || m[key] < 0)) throw new Error(`Month ${m.month}: ${key} ${m[key]} is not a whole number ≥ 0.`);
        }
    }
    return data;
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const file = args.find(a => !a.startsWith('--'));
    if (!file) throw new Error('Name the file to import, e.g. db/form-a4-2025.json');
    if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the database to import into.');

    const data = readFile(path.resolve(file));
    const { transaction, query, closePool } = require('../db');
    try {
        const known = new Set((await query('select code from residences')).rows.map(r => r.code));
        const unknown = [...new Set(data.months.flatMap(m => Object.keys(m.counts || {})).filter(c => !known.has(c)))];
        if (unknown.length) throw new Error(`Not a Form A4 row: ${unknown.join(', ')}. Run "npm run migrate" first if the residences table is empty.`);

        const existing = (await query(
            `select month, kind from monthly_reports where year = $1 and status = 'submitted'`, [data.year])).rows;
        const hasTotal = new Set(existing.filter(r => r.kind === 'municipal_total').map(r => r.month));
        const perPlace = [...new Set(existing.filter(r => r.kind === 'accommodation').map(r => r.month))];
        const clash = data.months.filter(m => perPlace.includes(m.month) && !hasTotal.has(m.month)).map(m => m.month);
        if (clash.length) throw new Error(`${data.year}: months ${clash.join(', ')} already have establishment reports. Decide which is the record before importing.`);

        let grand = 0, printed = 0;
        const todo = [];
        for (const m of [...data.months].sort((a, b) => a.month - b.month)) {
            const total = Object.values(m.counts || {}).reduce((a, b) => a + b, 0);
            grand += total;
            const print = data.printedGrandTotal ? data.printedGrandTotal[m.month - 1] : null;
            if (print != null) printed += print;
            const note = print != null && print !== total ? `   ≠ printed ${print} (difference ${print - total})` : '';
            const state = hasTotal.has(m.month) ? 'already recorded — skipped' : 'to import';
            console.log(`${data.year}-${String(m.month).padStart(2, '0')}  arrivals ${String(total).padStart(6)}  rooms ${m.rooms ?? '–'}  room-nights ${m.roomNightsOccupied ?? '–'}  guest nights ${m.guestNights ?? '–'}  ${state}${note}`);
            if (!hasTotal.has(m.month)) todo.push(m);
        }
        console.log(`Year: ${grand} arrivals${data.printedGrandTotal ? `, printed ${printed}` : ''}. ${todo.length} month(s) to import.`);
        if (dryRun || !todo.length) { if (dryRun) console.log('Dry run: nothing written.'); return; }

        await transaction(async client => {
            for (const m of todo) {
                const { rows } = await query(
                    `insert into monthly_reports (kind, year, month, rooms, room_nights_occupied, guest_nights,
                        submitted_by_role, submitted_by_email, locked_at, locked_by_email)
                     values ('municipal_total', $1, $2, $3, $4, $5, $6, $7, now(), $7) returning id`,
                    [data.year, m.month, m.rooms ?? null, m.roomNightsOccupied ?? null, m.guestNights ?? null, IMPORTER.role, IMPORTER.email], client);
                const id = rows[0].id;
                for (const [code, total] of Object.entries(m.counts || {})) {
                    if (total > 0) {
                        await query(`insert into monthly_report_counts (report_id, residence_code, total) values ($1, $2, $3)`, [id, code, total], client);
                    }
                }
                await query(
                    `insert into report_changes (report_id, action, changed_by_role, changed_by_email, note)
                     values ($1, 'created', $2, $3, $4)`,
                    [id, IMPORTER.role, IMPORTER.email, String(data.source || '').slice(0, 500)], client);
            }
        });
        console.log(`Imported ${todo.length} month(s) of ${data.year}, locked.`);
    } finally {
        await closePool();
    }
}

main().catch(error => {
    console.error('✖', error.message);
    process.exit(1);
});
