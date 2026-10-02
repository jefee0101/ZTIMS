/* "Manage my ticket / booking" — a visitor moves the date or cancels, with no
 * account: the ticket code (or booking reference) AND the email it was bought
 * with, together. Either alone opens nothing, and a wrong pair is answered
 * exactly like one that does not exist. The routes are rate-limited like the
 * sign-in, so codes cannot be tried in bulk.
 *
 * The rules (the office's decisions):
 *   - a change is possible until 11:59 PM, Manila time, the day before the
 *     visit — never on the day, never after;
 *   - a used ticket is never moved or refunded;
 *   - moving keeps the price; the new day must be one the destination opens;
 *   - a visitor's cancellation refunds the amount less the share the office
 *     keeps there (spots.cancel_keep_percent); the office's own cancellation
 *     (payments.js, closures) refunds everything;
 *   - a moved guide booking loses its guide and goes back to the office to
 *     confirm one for the new date;
 *   - a booking paid in cash at the counter is cancelled at the counter, where
 *     the refund is handed over; it can still be moved here.
 *
 * Mounted at /api by server.js. Every change is emailed to the visitor.
 */
const express = require('express');
const QRCode = require('qrcode');
const { query } = require('./db');
const { tickets: Ticket, bookings: GuideBooking, payments: Payment, spots: Spot, guides: TouristGuide } = require('./models');
const attractions = require('./attractions');
const notices = require('./notices');

const MANILA_OFFSET_HOURS = 8;
const TICKET_DAYS_AHEAD = 60;
const VISITOR = 'the visitor (Manage page)';

const money = n => Math.round(Number(n) * 100) / 100;
const manilaToday = () => new Date(Date.now() + MANILA_OFFSET_HOURS * 3600 * 1000).toISOString().slice(0, 10);
const isDateKey = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
function addDays(dateKey, n) {
    const d = new Date(`${dateKey}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
const normaliseCode = code => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function problem(status, message) {
    return Object.assign(new Error(message), { status });
}
const NOT_FOUND = 'Nothing matches that code and email address. Check both, exactly as on your ticket or booking email.';

/* The ticket or booking for a code and an email, or null. */
async function findRecord(code, email) {
    const wanted = normaliseCode(code);
    const address = String(email || '').trim().toLowerCase();
    if (wanted.length < 5 || !address) return null;
    if (wanted.startsWith('TG')) {
        const { rows } = await query(
            `select id from guide_bookings where regexp_replace(upper(reference), '[^A-Z0-9]', '', 'g') = $1 and email = $2`, [wanted, address]);
        if (rows[0]) return { kind: 'booking', record: await GuideBooking.findById(rows[0].id) };
    }
    const { rows } = await query(
        `select id from tickets where regexp_replace(upper(code), '[^A-Z0-9]', '', 'g') = $1 and email = $2`, [wanted, address]);
    if (rows[0]) return { kind: 'ticket', record: await Ticket.findById(rows[0].id) };
    return null;
}

/* Until when it can be changed, and whether it still can. */
function changeWindow(visitDate) {
    const lastDay = addDays(String(visitDate).slice(0, 10), -1);
    return { lastDay, open: manilaToday() <= lastDay };
}

async function paymentFor(kind, id) {
    const p = await Payment.findOne(kind === 'ticket' ? { ticketId: id } : { bookingId: id });
    return p || null;
}

/* What a visitor's own cancellation would refund now. */
function refundIfCancelled(payment, keepPercent) {
    if (!payment || payment.refundedAt) return { refund: 0, kept: 0 };
    const refund = money(payment.amount * (100 - keepPercent) / 100);
    return { refund, kept: money(payment.amount - refund) };
}

async function describe(found) {
    const { kind, record } = found;
    const spot = await Spot.findById(record.spotId);
    const keepPercent = Number(spot && spot.cancelKeepPercent) || 0;
    const payment = await paymentFor(kind, record._id);
    const date = kind === 'ticket' ? record.visitDate : record.preferredDate;
    const window = changeWindow(date);
    const calendar = spot ? await attractions.visitCalendar(spot, TICKET_DAYS_AHEAD + 1) : null;
    const base = {
        kind,
        spot: spot ? { _id: spot._id, title: spot.title } : null,
        status: record.status,
        keepPercent,
        changeUntil: window.lastDay,
        calendar,
        today: manilaToday(),
        paid: payment ? {
            amount: money(payment.amount), method: payment.method, channel: payment.channel,
            refundedAt: payment.refundedAt, refundAmount: payment.refundedAt ? money(payment.refundAmount ?? payment.amount) : 0
        } : null,
        ...refundIfCancelled(payment, keepPercent)
    };

    // Closed by the office: the visitor chooses a full refund or a new date,
    // whatever the deadline — the closure was not theirs.
    if (record.status === 'closed') {
        const full = payment && !payment.refundedAt ? money(payment.amount) : 0;
        Object.assign(base, { refund: full, kept: 0, closedByOffice: true });
    }

    if (kind === 'ticket') {
        const live = record.status === 'valid';
        const closed = record.status === 'closed';
        return {
            ...base,
            code: record.code, visitDate: record.visitDate, people: record.people,
            kindsText: attractions.describeKinds(record), name: record.fullName, maxDate: addDays(manilaToday(), TICKET_DAYS_AHEAD),
            // The QR again, for a visitor who lost the email — before they set off.
            qr: ['valid', 'used'].includes(record.status)
                ? await QRCode.toString(await module.exports.ticketQr(record._id), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
                : null,
            canMove: (live && window.open) || closed, canCancel: live && window.open, canRefundClosure: closed,
            why: closed ? `The office closed ${spot ? spot.title : 'the attraction'} on this date. Choose a full refund, or move the ticket to another date.`
                : record.status === 'used' ? 'This ticket was used at the gate, so it can no longer be moved or refunded.'
                : record.status === 'cancelled' ? 'This ticket is cancelled.'
                : record.status !== 'valid' ? 'This ticket was never paid for.'
                : !window.open ? 'Changes close at 11:59 PM the day before the visit.' : ''
        };
    }
    const live = ['pending_payment', 'confirmed'].includes(record.status);
    const counterPaid = payment && !payment.refundedAt && payment.channel === 'counter';
    const guide = record.guideId ? await TouristGuide.findById(record.guideId) : null;
    const asked = record.requestedGuideId ? await TouristGuide.findById(record.requestedGuideId) : null;
    return {
        ...base,
        reference: record.reference, preferredDate: record.preferredDate, preferredTime: record.preferredTime,
        visitors: record.visitors, name: record.fullName,
        guide: guide ? guide.fullName : null, requestedGuide: asked ? asked.fullName : null,
        maxDate: addDays(manilaToday(), 365),
        canMove: (live && window.open) || record.status === 'closed',
        canCancel: live && window.open && !counterPaid,
        canRefundClosure: record.status === 'closed' && !counterPaid,
        why: record.status === 'closed'
                ? `The office closed ${spot ? spot.title : 'the destination'} on this date. ${counterPaid
                    ? 'Move it to another date here, or go to the Municipal Tourism Office for your refund.'
                    : 'Choose a full refund, or move it to another date.'}`
            : !live ? `This booking is ${String(record.status).replace('_', ' ')}.`
            : !window.open ? 'Changes close at 11:59 PM the day before the tour.'
            : counterPaid ? 'This booking was paid at the Municipal Tourism Office. It can be moved here, but to cancel it please go to the office, where the refund is given.'
            : ''
    };
}

module.exports = function manageRouter({ sharedRateLimit, refund, siteOrigin }) {
    const router = express.Router();
    const limit = sharedRateLimit('manage', {
        windowMs: 60 * 60 * 1000,
        limit: 40,
        message: { success: false, message: 'Too many tries from this connection. Please wait a while, or contact the Municipal Tourism Office.' }
    });

    const fail = (res, error, label) => {
        if (error && error.status) return res.status(error.status).json({ success: false, message: error.message });
        console.error(label, error);
        return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    };

    async function load(body) {
        const found = await findRecord(body && body.code, body && body.email);
        if (!found || !found.record) throw problem(404, NOT_FOUND);
        return found;
    }

    router.post('/manage/lookup', limit, async (req, res) => {
        try {
            const found = await load(req.body);
            res.json({ success: true, item: await describe(found) });
        } catch (error) { fail(res, error, '❌ Manage lookup failure:'); }
    });

    router.post('/manage/move', limit, async (req, res) => {
        try {
            const found = await load(req.body);
            const view = await describe(found);
            if (!view.canMove) throw problem(409, view.why || 'This can no longer be moved.');
            const date = String((req.body && req.body.date) || '').trim();
            if (!isDateKey(date)) throw problem(400, 'Choose the new date.');
            if (date < manilaToday()) throw problem(400, 'That date has already passed.');
            if (date > view.maxDate) throw problem(400, 'That date is too far ahead.');
            const spot = await Spot.findById(found.record.spotId);
            const day = await attractions.dayVerdict(spot, date);
            if (!day.open) throw problem(409, day.reason);
            const origin = siteOrigin(req);

            if (found.kind === 'ticket') {
                const from = found.record.visitDate;
                if (date === from) throw problem(400, 'That is already the ticket\'s date.');
                // Only a valid ticket on the date we read: a gate scan or a second
                // tab in between leaves it alone.
                const { rowCount } = await query(
                    `update tickets set visit_date = $2, status = 'valid'
                      where id = $1 and status in ('valid', 'closed') and visit_date = $3`, [found.record._id, date, from]);
                if (!rowCount) throw problem(409, 'This ticket changed just now. Look it up again.');
                const told = await notices.ticketMoved(found.record._id, from, origin, { qrContent: await module.exports.ticketQr(found.record._id) });
                return res.json({ success: true, emailed: told.sent, message: `Moved to ${attractions.niceDate(date)}. The same QR code works on the new date.`, item: await describe(await load(req.body)) });
            }

            const time = String((req.body && req.body.time) || found.record.preferredTime).trim();
            if (!/^\d{2}:\d{2}$/.test(time)) throw problem(400, 'Choose a time.');
            const from = { date: found.record.preferredDate, time: found.record.preferredTime };
            if (date === from.date && time === from.time) throw problem(400, 'That is already the booking\'s date and time.');
            const booking = found.record;
            booking.preferredDate = date;
            booking.preferredTime = time;
            // The guide was confirmed for the old date: the office confirms one again.
            booking.guideId = null;
            // A closed booking was paid: moving it confirms it again on the new date.
            if (booking.status === 'closed') booking.status = 'confirmed';
            booking.statusNote = `Moved by the visitor from ${from.date} ${from.time}. The office confirms the guide again.`.slice(0, 500);
            booking.statusUpdatedAt = new Date();
            await GuideBooking.save(booking);
            const told = await notices.bookingMoved(booking._id, from, origin);
            return res.json({ success: true, emailed: told.sent, message: `Moved to ${attractions.niceDate(date)} at ${time}. The office will confirm your guide for the new date.`, item: await describe(await load(req.body)) });
        } catch (error) { fail(res, error, '❌ Manage move failure:'); }
    });

    router.post('/manage/cancel', limit, async (req, res) => {
        try {
            const found = await load(req.body);
            const view = await describe(found);
            if (!view.canCancel) throw problem(409, view.why || 'This can no longer be cancelled.');
            const origin = siteOrigin(req);
            const payment = await paymentFor(found.kind, found.record._id);
            const reason = 'Cancelled by the visitor';

            if (payment && !payment.refundedAt) {
                const done = await refund(payment._id, reason, VISITOR, { amount: view.refund });
                const kept = money(done.amount - done.refundAmount);
                const told = found.kind === 'ticket'
                    ? await notices.ticketCancelled(found.record._id, { refundAmount: done.refundAmount, keptAmount: kept, byVisitor: true }, origin)
                    : await notices.bookingCancelled(found.record._id, { refundAmount: done.refundAmount, keptAmount: kept, byVisitor: true }, origin);
                return res.json({ success: true, emailed: told.sent, message: done.refundAmount > 0
                    ? `Cancelled. ${'₱' + done.refundAmount.toLocaleString('en-PH', { minimumFractionDigits: 2 })} is being refunded to the way you paid.`
                    : 'Cancelled. Nothing is refunded.', item: await describe(await load(req.body)) });
            }

            // Not paid (a guide booking awaiting payment): nothing to refund.
            if (found.kind === 'ticket') throw problem(409, 'This ticket was never paid for.');
            const booking = found.record;
            booking.status = 'cancelled';
            booking.statusNote = reason;
            booking.statusUpdatedAt = new Date();
            await GuideBooking.save(booking);
            const told = await notices.bookingCancelled(booking._id, { byVisitor: true }, origin);
            return res.json({ success: true, emailed: told.sent, message: 'Cancelled. Nothing had been paid.', item: await describe(await load(req.body)) });
        } catch (error) { fail(res, error, '❌ Manage cancel failure:'); }
    });

    /* Closed by the office: the visitor takes the full refund. */
    router.post('/manage/refund-closure', limit, async (req, res) => {
        try {
            const found = await load(req.body);
            const view = await describe(found);
            if (!view.canRefundClosure) throw problem(409, view.why || 'There is no closure refund to take here.');
            const payment = await paymentFor(found.kind, found.record._id);
            if (!payment || payment.refundedAt) throw problem(409, 'This was already refunded.');
            const done = await refund(payment._id, 'The office closed this date: refunded in full', VISITOR);
            const origin = siteOrigin(req);
            const told = found.kind === 'ticket'
                ? await notices.ticketCancelled(found.record._id, { refundAmount: done.refundAmount, byVisitor: false, reason: 'closed that day' }, origin)
                : await notices.bookingCancelled(found.record._id, { refundAmount: done.refundAmount, byVisitor: false, reason: 'closed that day' }, origin);
            res.json({ success: true, emailed: told.sent,
                message: `Refunded in full: ₱${done.refundAmount.toLocaleString('en-PH', { minimumFractionDigits: 2 })} is on its way back to the way you paid.`,
                item: await describe(await load(req.body)) });
        } catch (error) { fail(res, error, '❌ Closure refund failure:'); }
    });

    return router;
};

// What a ticket's QR holds: sealed (ticket-seal.js) when a key is set. The
// date is sealed in, so a moved ticket's new QR is drawn from the new date.
module.exports.ticketQr = async ticketId => {
    const t = await Ticket.findById(ticketId);
    return t ? require('./ticket-seal').qrContent(t) : '';
};
