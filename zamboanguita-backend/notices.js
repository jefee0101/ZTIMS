/* The emails a visitor gets about their own ticket: a receipt when it is
 * paid, and notices when it is moved, cancelled, refunded, or when the office
 * closes the destination on their date.
 *
 * Each reads the record fresh from the database, so what is emailed is what is
 * stored. All of them go through mailer.js, which never throws: a notice that
 * cannot be sent is logged, and the change it reports stands regardless.
 *
 * Links go to Move or cancel (manage.html) with the code only — never the
 * email address. That page opens only for the signed-in account holding the
 * ticket or booking; signed out, it asks the visitor to sign in first.
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
        link: { label: 'Move or cancel (sign in)', url: manageUrl(origin, t.code) }
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
        link: { label: 'Move or cancel (sign in)', url: manageUrl(origin, t.code) }
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

/* ---------------------------------------------------------------- bookings */

/* Room booking at a private place to stay (bookings.js). The guest's emails
   link to the Manage page with the code; the manager's link to their Bookings
   page with the code. Neither link carries an email address, and the Review
   request button only opens the request: it never confirms anything. */

const BOOKING_FOOTER = 'Sent by ZTIMS, the Zamboanguita Tourism Information Management System, for the resort named above.\n'
    + 'You are getting this because this email address was given for this booking. We send nothing else.';
const MANAGER_FOOTER = 'Sent by ZTIMS, the Zamboanguita Tourism Information Management System, to the Enterprise Manager of the resort named above.';
const reviewUrl = (origin, code) => `${siteUrl(origin)}/src/resort/resort_bookings.html?code=${encodeURIComponent(code)}`;

async function bookingRow(bookingId) {
    const { rows } = await query(`
        select b.*, s.title as spot_title, coalesce(nullif(s.enterprise_name, ''), s.title) as resort_name,
               coalesce(nullif(s.phone, ''), m.phone) as resort_phone,
               coalesce(nullif(s.contact_email, ''), m.contact_email) as resort_email,
               m.email as manager_email, m.manager_name,
               coalesce(es.check_in_time, '14:00') as check_in_time, coalesce(es.check_out_time, '12:00') as check_out_time,
               coalesce(es.payment_instructions, '') as payment_instructions, coalesce(es.free_cancel_days, 2) as free_cancel_days,
               (select string_agg(br.units || ' × ' || rt.name || coalesce(' · Room ' || rn.room_number,''), ', ' order by rt.position, rn.room_number)
                  from booking_rooms br join room_types rt on rt.id = br.room_type_id left join accommodation_rooms rn on rn.id=br.room_id where br.booking_id = b.id) as rooms_text,
               (select name from residences r where r.code = b.country_code) as country_name
          from bookings b join spots s on s.id = b.spot_id
          left join establishment_managers m on m.id = s.managed_by
          left join enterprise_booking_settings es on es.spot_id = s.id
         where b.id = $1`, [bookingId]);
    return rows[0] || null;
}

const hhmm = value => String(value || '').slice(0, 5);
const manilaTime = iso => new Date(iso).toLocaleString('en-PH', {
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila'
});
const stayRows = b => [
    ['Booking code', b.code],
    ['Resort', b.resort_name],
    ['Check-in', `${niceDate(b.check_in)}, from ${hhmm(b.check_in_time)}`],
    ['Check-out', `${niceDate(b.check_out)}, by ${hhmm(b.check_out_time)}`],
    ['Nights', String(b.nights)],
    ['Rooms', b.rooms_text || ''],
    ['Guests', `${b.adults} adult${b.adults === 1 ? '' : 's'}${b.children ? `, ${b.children} child${b.children === 1 ? '' : 'ren'}` : ''}`],
    ['Total', pesos(b.total_amount)],
    ['Payment', b.payment_choice === 'online' ? 'Online, after the resort confirms' : 'At the property']
];
const resortContact = b => [b.resort_phone, b.resort_email].filter(Boolean).join(' · ');
const guestMail = (b, subject, body) => sendMail({ to: b.email, subject, ...compose({ footer: BOOKING_FOOTER, ...body }) });
const managerMail = (b, subject, body) => (b.manager_email
    ? sendMail({ to: b.manager_email, subject, ...compose({ footer: MANAGER_FOOTER, ...body }) })
    : Promise.resolve({ sent: false, reason: 'no_manager' }));

/* To the guest: the request is in, nothing is booked until the resort says so. */
async function bookingReceived(bookingId, origin) {
    const b = await bookingRow(bookingId);
    if (!b || !b.email) return { sent: false, reason: 'not_found' };
    return guestMail(b, `Booking request ${b.code} — ${b.resort_name}`, {
        heading: 'We have sent your request to the resort',
        intro: `${b.resort_name} will confirm or decline by ${manilaTime(b.expires_at)}. Nothing is booked until it confirms, and nothing is paid yet.`,
        rows: stayRows(b),
        paragraphs: [b.payment_choice === 'online'
            ? 'If the resort confirms, we will email you a link to pay online. Nothing is charged if it declines.'
            : 'If the resort confirms, we will email you how to pay it at the property.'],
        link: { label: 'See my booking (sign in)', url: manageUrl(origin, b.code) }
    });
}

/* To the manager: a request (or a moved booking) to review. */
async function bookingNewRequest(bookingId, origin, { moved = false } = {}) {
    const b = await bookingRow(bookingId);
    if (!b) return { sent: false, reason: 'not_found' };
    return managerMail(b, `${moved ? 'Moved booking' : 'New booking request'} ${b.code} — ${niceDate(b.check_in)}`, {
        heading: moved ? 'A guest moved their booking: please review the new dates' : 'A new booking request',
        intro: `Please confirm or decline by ${manilaTime(b.expires_at)}. Unanswered, it expires and the rooms are free again.`,
        rows: [...stayRows(b), ['Guest', b.guest_name], ['From', b.country_name || b.country_code], ...(b.note ? [['Note', b.note]] : [])],
        link: { label: 'Review request', url: reviewUrl(origin, b.code) }
    });
}

/* To the manager, halfway through the response time. */
async function bookingReminder(bookingId, origin) {
    const b = await bookingRow(bookingId);
    if (!b || b.status !== 'requested') return { sent: false, reason: 'not_found' };
    return managerMail(b, `Reminder: booking request ${b.code} waits for an answer`, {
        heading: 'A booking request is still waiting',
        intro: `It expires at ${manilaTime(b.expires_at)} if it is not confirmed or declined.`,
        rows: [...stayRows(b), ['Guest', b.guest_name]],
        link: { label: 'Review request', url: reviewUrl(origin, b.code) }
    });
}

async function bookingConfirmed(bookingId, origin) {
    const b = await bookingRow(bookingId);
    if (!b || !b.email) return { sent: false, reason: 'not_found' };
    if (b.payment_choice === 'online') {
        return guestMail(b, `Confirmed: ${b.resort_name}, ${niceDate(b.check_in)} (${b.code}) — pay online`, {
            heading: 'Your booking is confirmed',
            intro: `${b.resort_name} has confirmed your stay. Pay ${pesos(b.total_amount)} online from your booking page (GCash, Maya, QR Ph, card or bank).`,
            rows: stayRows(b),
            paragraphs: [
                ...(resortContact(b) ? [`The resort: ${resortContact(b)}`] : []),
                `You can cancel until ${b.free_cancel_days > 1 ? `${b.free_cancel_days} days` : 'the day'} before check-in, 11:59 PM; an online payment is then returned in full.`
            ],
            link: { label: 'Pay online (sign in)', url: manageUrl(origin, b.code) }
        });
    }
    return guestMail(b, `Confirmed: ${b.resort_name}, ${niceDate(b.check_in)} (${b.code})`, {
        heading: 'Your booking is confirmed',
        intro: `${b.resort_name} has confirmed your stay. Pay the resort at the property, as it explains below.`,
        rows: stayRows(b),
        paragraphs: [
            ...(b.payment_instructions ? [`How to pay ${b.resort_name}:\n${b.payment_instructions}`] : []),
            ...(resortContact(b) ? [`The resort: ${resortContact(b)}`] : []),
            `You can move or cancel here until ${b.free_cancel_days > 1 ? `${b.free_cancel_days} days` : 'the day'} before check-in, 11:59 PM. A move goes back to the resort to confirm.`
        ],
        link: { label: 'See my booking (sign in)', url: manageUrl(origin, b.code) }
    });
}

async function bookingDeclined(bookingId, origin) {
    const b = await bookingRow(bookingId);
    if (!b || !b.email) return { sent: false, reason: 'not_found' };
    return guestMail(b, `Not available: ${b.resort_name}, ${niceDate(b.check_in)} (${b.code})`, {
        heading: 'The resort could not take your booking',
        intro: `${b.resort_name} declined your request${b.decline_reason ? `: ${b.decline_reason}` : '.'}`,
        rows: stayRows(b),
        paragraphs: ['Nothing was paid. You are welcome to ask for other dates, or to try another place in Zamboanguita.'],
        link: { label: 'Places to stay in Zamboanguita', url: `${siteUrl(origin)}/index.html?category=STAY#featured` }
    });
}

async function bookingExpired(bookingId, origin) {
    const b = await bookingRow(bookingId);
    if (!b || !b.email) return { sent: false, reason: 'not_found' };
    return guestMail(b, `No answer from ${b.resort_name}: request ${b.code} expired`, {
        heading: 'Your request expired',
        intro: `${b.resort_name} did not answer in time, so the request has expired and nothing is booked. Nothing was paid.`,
        rows: stayRows(b),
        paragraphs: [`You can ask again, or contact the resort${resortContact(b) ? `: ${resortContact(b)}` : ''}.`],
        link: { label: 'Places to stay in Zamboanguita', url: `${siteUrl(origin)}/index.html?category=STAY#featured` }
    });
}

/* The guest's new dates, back with the resort to confirm. */
async function bookingMoved(bookingId, { from, to }, origin) {
    const b = await bookingRow(bookingId);
    if (!b || !b.email) return { sent: false, reason: 'not_found' };
    return guestMail(b, `Booking ${b.code}: new dates sent to ${b.resort_name}`, {
        heading: 'Your new dates are with the resort',
        intro: `You moved your stay (it was ${niceDate(from)} to ${niceDate(to)}). ${b.resort_name} will confirm or decline the new dates by ${manilaTime(b.expires_at)}.`,
        rows: stayRows(b),
        link: { label: 'See my booking (sign in)', url: manageUrl(origin, b.code) }
    });
}

/* A guest's cancellation: both sides are told. */
async function bookingCancelled(bookingId, { byGuest = true, refunded = 0 } = {}, origin) {
    const b = await bookingRow(bookingId);
    if (!b) return { sent: false, reason: 'not_found' };
    await managerMail(b, `Cancelled by the guest: booking ${b.code}`, {
        heading: 'A guest cancelled their booking',
        intro: refunded ? `The rooms are free again. The guest's online payment of ${pesos(refunded)} was returned to them.`
            : 'The rooms are free again. If the guest paid you anything, settle it with them directly.',
        rows: [...stayRows(b), ['Guest', b.guest_name]],
        link: { label: 'Open the booking', url: reviewUrl(origin, b.code) }
    });
    if (!b.email) return { sent: false, reason: 'not_found' };
    return guestMail(b, `Booking ${b.code} cancelled`, {
        heading: 'Your booking is cancelled',
        intro: byGuest && refunded
            ? `You cancelled your booking at ${b.resort_name}. Your online payment of ${pesos(refunded)} is on its way back to you, by the way you paid.`
            : byGuest
            ? `You cancelled your booking at ${b.resort_name}. If you paid the resort anything, it settles that with you directly.`
            : `Your booking at ${b.resort_name} is cancelled.`,
        rows: stayRows(b)
    });
}

/* Paid online: a receipt to the guest and a line to the manager. */
async function bookingPaidOnline(bookingId, paid, origin) {
    const b = await bookingRow(bookingId);
    if (!b) return { sent: false, reason: 'not_found' };
    const methodNames = { gcash: 'GCash', maya: 'Maya', qrph: 'QR Ph', card: 'Card', bank: 'Bank', otc: 'Over the counter' };
    const how = methodNames[paid.method] || 'Online';
    await managerMail(b, `Paid online: booking ${b.code}`, {
        heading: 'A guest paid their booking online',
        intro: `${pesos(paid.amount)} paid online (${how}).`,
        rows: [...stayRows(b), ['Guest', b.guest_name]],
        link: { label: 'Open the booking', url: reviewUrl(origin, b.code) }
    });
    if (!b.email) return { sent: false, reason: 'not_found' };
    return guestMail(b, `Paid: booking ${b.code} — ${b.resort_name}`, {
        heading: 'Payment received',
        intro: `We received your online payment of ${pesos(paid.amount)} (${how}) for your stay at ${b.resort_name}.`,
        rows: [...stayRows(b), ['Paid online', `${pesos(paid.amount)}, reference ${paid.ref}`]],
        link: { label: 'See my booking (sign in)', url: manageUrl(origin, b.code) }
    });
}

module.exports = {
    bookingPaidOnline,
    manageUrl, siteUrl, closureNotice,
    ticketReceipt, ticketMoved, ticketCancelled,
    bookingReceived, bookingNewRequest, bookingReminder, bookingConfirmed,
    bookingDeclined, bookingExpired, bookingMoved, bookingCancelled
};
