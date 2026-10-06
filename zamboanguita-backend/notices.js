/* The emails a visitor gets about their own ticket or booking: receipts when
 * it is paid, and notices when it is moved, cancelled, refunded, given a
 * guide, or when the office closes the destination on their date.
 *
 * Each reads the record fresh from the database, so what is emailed is what is
 * stored. All of them go through mailer.js, which never throws: a notice that
 * cannot be sent is logged, and the change it reports stands regardless.
 *
 * Links go to the Manage page with the code only — never the email address,
 * which the visitor types there themselves.
 */
const QRCode = require('qrcode');
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

async function bookingRow(bookingId) {
    const { rows } = await query(`
        select b.*, s.title as spot_title, g.full_name as guide_name, rg.full_name as requested_name, rg.guide_fee as requested_fee,
               p.amount as paid_amount, p.method as paid_method, p.channel as paid_channel, p.receipt_number
          from guide_bookings b join spots s on s.id = b.spot_id
          left join tourist_guides g on g.id = b.guide_id
          left join tourist_guides rg on rg.id = b.requested_guide_id
          left join payments p on p.booking_id = b.id
         where b.id = $1`, [bookingId]);
    return rows[0] || null;
}

const METHOD = { cash: 'Cash', gcash: 'GCash', maya: 'Maya', card: 'Card', bank: 'Online banking', grabpay: 'GrabPay', shopeepay: 'ShopeePay', qrph: 'QR Ph' };
const paidLine = row => `${pesos(row.paid_amount)} · ${METHOD[row.paid_method] || row.paid_method || 'online'}${row.paid_channel === 'online' ? ' · online' : ' · at the office'}`;

/* The QR on a ticket, as a PNG attachment: mail apps block images written into
   the message itself, but show an attached one. */
async function qrAttachment(content) {
    return {
        filename: 'ticket-qr.png',
        content: await QRCode.toBuffer(content, { type: 'png', margin: 1, width: 400, errorCorrectionLevel: 'M' }),
        cid: 'ticketqr'
    };
}

/* ---------------------------------------------------------------- tickets */

async function ticketReceipt(ticketId, origin, { qrContent } = {}) {
    const t = await ticketRow(ticketId);
    if (!t) return { sent: false, reason: 'not_found' };
    const body = compose({
        heading: 'Your entrance ticket',
        intro: `Show this QR code at the entrance of ${t.spot_title}. Save this email or take a screenshot: there may be no signal at the attraction.`,
        qrCid: 'ticketqr',
        rows: [
            ['Ticket code', t.code],
            ['Attraction', t.spot_title],
            ['Date', niceDate(t.visit_date)],
            ['People', `${t.people}: ${describeKinds(t)}`],
            ['Paid', paidLine(t)]
        ],
        paragraphs: [
            'Valid on this date only. Senior citizens, persons with disability and students: bring your ID for the discounted price.',
            'You can move the date or cancel until 11:59 PM the day before your visit. A used ticket cannot be refunded.'
        ],
        link: { label: 'Manage my ticket', url: manageUrl(origin, t.code) }
    });
    return sendMail({ to: t.email, subject: `Your ticket ${t.code} — ${t.spot_title}, ${niceDate(t.visit_date)}`,
        ...body, attachments: [await qrAttachment(qrContent || t.code)] });
}

async function ticketMoved(ticketId, fromDate, origin, { qrContent } = {}) {
    const t = await ticketRow(ticketId);
    if (!t) return { sent: false, reason: 'not_found' };
    const body = compose({
        heading: 'Your ticket has a new date',
        intro: `Your ticket for ${t.spot_title} is now for ${niceDate(t.visit_date)} (it was for ${niceDate(fromDate)}). The code and QR are the same.`,
        qrCid: 'ticketqr',
        rows: [['Ticket code', t.code], ['New date', niceDate(t.visit_date)], ['People', `${t.people}: ${describeKinds(t)}`]],
        link: { label: 'Manage my ticket', url: manageUrl(origin, t.code) }
    });
    return sendMail({ to: t.email, subject: `Ticket ${t.code} moved to ${niceDate(t.visit_date)}`, ...body,
        attachments: [await qrAttachment(qrContent || t.code)] });
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

/* ---------------------------------------------------------------- guide bookings */

function bookingRows(b) {
    const rows = [
        ['Reference', b.reference],
        ['Destination', b.spot_title],
        ['Date and time', `${niceDate(b.preferred_date)}, ${b.preferred_time}`],
        ['Visitors', String(b.visitors)]
    ];
    if (b.guide_name) rows.push(['Your guide', b.guide_name]);
    else rows.push(['Guide asked for', b.requested_name || 'Any available guide']);
    return rows;
}

async function bookingReceived(bookingId, origin, { payOnline } = {}) {
    const b = await bookingRow(bookingId);
    if (!b) return { sent: false, reason: 'not_found' };
    const body = compose({
        heading: 'We have your guide booking',
        intro: `Thank you. Booking ${b.reference} is saved. It is confirmed once it is paid.`,
        rows: bookingRows(b),
        paragraphs: [
            payOnline
                ? 'Pay online from the Manage page, or onsite at the Municipal Tourism Office. Quote your reference.'
                : 'Please pay at the Municipal Tourism Office. Quote your reference.',
            'The office confirms your guide. You can move the date or cancel until 11:59 PM the day before.'
        ],
        link: { label: 'Manage my booking', url: manageUrl(origin, b.reference) }
    });
    return sendMail({ to: b.email, subject: `Guide booking ${b.reference} received`, ...body });
}

async function bookingPaid(bookingId, origin) {
    const b = await bookingRow(bookingId);
    if (!b || b.paid_amount == null) return { sent: false, reason: 'not_found' };
    const body = compose({
        heading: 'Payment received — your booking is confirmed',
        intro: `Booking ${b.reference} is paid and confirmed. The office ${b.guide_name ? 'has assigned your guide' : 'will confirm your guide'}.`,
        rows: [...bookingRows(b), ['Paid', paidLine(b)], ...(b.receipt_number ? [['Official receipt', b.receipt_number]] : [])],
        link: { label: 'Manage my booking', url: manageUrl(origin, b.reference) }
    });
    return sendMail({ to: b.email, subject: `Receipt — guide booking ${b.reference}`, ...body });
}

async function guideAssigned(bookingId, origin) {
    const b = await bookingRow(bookingId);
    if (!b || !b.guide_name) return { sent: false, reason: 'not_found' };
    const body = compose({
        heading: `Your guide is ${b.guide_name}`,
        intro: `The Municipal Tourism Office has confirmed ${b.guide_name} as your guide for booking ${b.reference}.`,
        rows: bookingRows(b),
        link: { label: 'Manage my booking', url: manageUrl(origin, b.reference) }
    });
    return sendMail({ to: b.email, subject: `Your guide for ${b.reference}: ${b.guide_name}`, ...body });
}

async function bookingMoved(bookingId, from, origin) {
    const b = await bookingRow(bookingId);
    if (!b) return { sent: false, reason: 'not_found' };
    const body = compose({
        heading: 'Your booking has a new date',
        intro: `Booking ${b.reference} is now for ${niceDate(b.preferred_date)} at ${b.preferred_time} (it was ${niceDate(from.date)} at ${from.time}). The office will confirm your guide for the new date.`,
        rows: bookingRows(b),
        link: { label: 'Manage my booking', url: manageUrl(origin, b.reference) }
    });
    return sendMail({ to: b.email, subject: `Booking ${b.reference} moved to ${niceDate(b.preferred_date)}`, ...body });
}

async function bookingCancelled(bookingId, { refundAmount = 0, keptAmount = 0, byVisitor, reason }, origin) {
    const b = await bookingRow(bookingId);
    if (!b) return { sent: false, reason: 'not_found' };
    const rows = bookingRows(b);
    if (b.paid_amount != null) {
        rows.push(['Refund', pesos(refundAmount)]);
        if (keptAmount > 0) rows.push(['Kept by the office', pesos(keptAmount)]);
    }
    const body = compose({
        heading: 'Your guide booking is cancelled',
        intro: byVisitor
            ? `You cancelled booking ${b.reference}.${b.paid_amount != null ? (refundAmount > 0 ? ` ${pesos(refundAmount)} is being refunded to the way you paid.` : ' Nothing is refunded.') : ''}`
            : `The Municipal Tourism Office cancelled booking ${b.reference}${reason ? ` (${reason})` : ''}${b.paid_amount != null ? ', and refunded it in full' : ''}.`,
        rows
    });
    return sendMail({ to: b.email, subject: `Guide booking ${b.reference} cancelled`, ...body });
}

/* ---------------------------------------------------------------- closures */

/* The office closed the destination on the visitor's date: the ticket or
   booking is out of use, and the visitor chooses a full refund or a new date. */
async function closureNotice(kind, id, { reason }, origin) {
    const isTicket = kind === 'ticket';
    const row = isTicket ? await ticketRow(id) : await bookingRow(id);
    if (!row) return { sent: false, reason: 'not_found' };
    const code = isTicket ? row.code : row.reference;
    const date = isTicket ? row.visit_date : row.preferred_date;
    const body = compose({
        heading: `${row.spot_title} is closed on ${niceDate(date)}`,
        intro: `We are sorry: the Municipal Tourism Office has had to close ${row.spot_title} on ${niceDate(date)}${reason ? ` (${reason})` : ''}. `
            + `Your ${isTicket ? 'ticket' : 'guide booking'} ${code} cannot be used that day.`,
        rows: [[isTicket ? 'Ticket code' : 'Reference', code], ['Paid', paidLine(row)]],
        paragraphs: [
            `Please choose on the Manage page: a full refund of ${pesos(row.paid_amount)}, or another date${isTicket ? ' with the same ticket' : ' (the office then confirms your guide)'}. Or ask the Municipal Tourism Office.`
        ],
        link: { label: 'Choose a refund or a new date', url: manageUrl(origin, code) }
    });
    return sendMail({ to: row.email, subject: `Closed on ${niceDate(date)}: choose a refund or a new date (${code})`, ...body });
}

module.exports = {
    manageUrl, siteUrl, closureNotice,
    ticketReceipt, ticketMoved, ticketCancelled,
    bookingReceived, bookingPaid, guideAssigned, bookingMoved, bookingCancelled
};
