/* The emails a visitor gets about their own ticket: a receipt when it is
 * paid, and notices when it is moved, cancelled, refunded, or when the office
 * closes the destination on their date.
 *
 * Each reads the record fresh from the database, so what is emailed is what is
 * stored. All of them go through mailer.js, which never throws: a notice that
 * cannot be sent is logged, and the change it reports stands regardless.
 *
 * Links go to the Manage page with the code only — never the email address,
 * which the visitor types there themselves.
 */
const { query } = require('./db');
const { sendMail, compose, niceDate, pesos } = require('./mailer');
const { describeKinds } = require('./attractions');

function siteUrl(origin) {
    const configured = String(process.env.PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
    return configured || String(origin || '').replace(/\/+$/, '');
}
const manageUrl = (origin, code) => `${siteUrl(origin)}/src/manage.html?code=${encodeURIComponent(code)}`;

async function ticketRow(ticketId) {
    const { rows } = await query(`
        select t.*, s.title as spot_title, p.amount as paid_amount, p.method as paid_method, p.channel as paid_channel
          from tickets t join spots s on s.id = t.spot_id left join payments p on p.ticket_id = t.id
         where t.id = $1`, [ticketId]);
    return rows[0] || null;
}

const METHOD = { cash: 'Cash', gcash: 'GCash', maya: 'Maya', card: 'Card', bank: 'Online banking', grabpay: 'GrabPay', shopeepay: 'ShopeePay', qrph: 'QR Ph' };
const paidLine = row => `${pesos(row.paid_amount)} · ${METHOD[row.paid_method] || row.paid_method || 'online'}${row.paid_channel === 'online' ? ' · online' : ' · at the office'}`;

/* ---------------------------------------------------------------- tickets */

async function ticketReceipt(ticketId, origin) {
    const t = await ticketRow(ticketId);
    if (!t) return { sent: false, reason: 'not_found' };
    const body = compose({
        heading: 'Your entrance ticket',
        intro: `Your ticket code is ${t.code}. Show it at ${t.spot_title}, on this email or a screenshot: there may be no signal at the attraction.`,
        rows: [
            ['Ticket code', t.code],
            ['Attraction', t.spot_title],
            ['Date', niceDate(t.visit_date)],
            ['People', `${t.people}: ${describeKinds(t)}`],
            ['Paid', paidLine(t)]
        ],
        paragraphs: [
            'Valid on this date only. Students: bring your school ID for the student price.',
            'You can move the date or cancel until 11:59 PM the day before your visit. A used ticket cannot be refunded.'
        ],
        link: { label: 'Manage my ticket', url: manageUrl(origin, t.code) }
    });
    return sendMail({ to: t.email, subject: `Your ticket ${t.code} — ${t.spot_title}, ${niceDate(t.visit_date)}`, ...body });
}

async function ticketMoved(ticketId, fromDate, origin) {
    const t = await ticketRow(ticketId);
    if (!t) return { sent: false, reason: 'not_found' };
    const body = compose({
        heading: 'Your ticket has a new date',
        intro: `Your ticket for ${t.spot_title} is now for ${niceDate(t.visit_date)} (it was for ${niceDate(fromDate)}). The ticket code is the same.`,
        rows: [['Ticket code', t.code], ['New date', niceDate(t.visit_date)], ['People', `${t.people}: ${describeKinds(t)}`]],
        link: { label: 'Manage my ticket', url: manageUrl(origin, t.code) }
    });
    return sendMail({ to: t.email, subject: `Ticket ${t.code} moved to ${niceDate(t.visit_date)}`, ...body });
}

/* `byVisitor`: the visitor cancelled (the office's share is kept); otherwise
   the office cancelled and everything was refunded. */
async function ticketCancelled(ticketId, { refundAmount, keptAmount = 0, byVisitor, reason }, origin) {
    const t = await ticketRow(ticketId);
    if (!t) return { sent: false, reason: 'not_found' };
    const rows = [['Ticket code', t.code], ['Attraction', t.spot_title], ['Date', niceDate(t.visit_date)], ['Refund', pesos(refundAmount)]];
    if (keptAmount > 0) rows.push(['Kept by the office', pesos(keptAmount)]);
    const body = compose({
        heading: 'Your ticket is cancelled',
        intro: byVisitor
            ? `You cancelled ticket ${t.code}. ${refundAmount > 0 ? `${pesos(refundAmount)} is being refunded to the way you paid.` : 'Nothing is refunded.'}`
            : `The Municipal Tourism Office cancelled ticket ${t.code}${reason ? ` (${reason})` : ''}, and refunded it in full.`,
        rows
    });
    return sendMail({ to: t.email, subject: `Ticket ${t.code} cancelled`, ...body });
}

/* ---------------------------------------------------------------- closures */

/* The office closed the destination on the visitor's date: the ticket is out
   of use, and the visitor chooses a full refund or a new date. */
async function closureNotice(ticketId, { reason }, origin) {
    const row = await ticketRow(ticketId);
    if (!row) return { sent: false, reason: 'not_found' };
    const body = compose({
        heading: `${row.spot_title} is closed on ${niceDate(row.visit_date)}`,
        intro: `We are sorry: the Municipal Tourism Office has had to close ${row.spot_title} on ${niceDate(row.visit_date)}${reason ? ` (${reason})` : ''}. `
            + `Your ticket ${row.code} cannot be used that day.`,
        rows: [['Ticket code', row.code], ['Paid', paidLine(row)]],
        paragraphs: [
            `Please choose on the Manage page: a full refund of ${pesos(row.paid_amount)}, or another date with the same ticket. Or ask the Municipal Tourism Office.`
        ],
        link: { label: 'Choose a refund or a new date', url: manageUrl(origin, row.code) }
    });
    return sendMail({ to: row.email, subject: `Closed on ${niceDate(row.visit_date)}: choose a refund or a new date (${row.code})`, ...body });
}

module.exports = {
    manageUrl, siteUrl, closureNotice,
    ticketReceipt, ticketMoved, ticketCancelled
};
