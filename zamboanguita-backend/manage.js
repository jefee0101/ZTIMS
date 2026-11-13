/* "Move or cancel" — a signed-in visitor moves the date of, or cancels, a
 * ticket or room booking their own account holds (visitors.js'
 * requireVisitor). There is no public search: since 9 November 2026 nothing
 * opens by code and email. A ticket or booking opens only for the account
 * whose visitor_id it carries; any other code is answered exactly like one
 * that does not exist. Ones bought as a guest before accounts join the
 * account that signs in with their email (linkOldRecords) and open then.
 *
 * The rules (the office's decisions):
 *   - a change is possible until 11:59 PM, Manila time, the day before the
 *     visit — never on the day, never after;
 *   - a used ticket is never moved or refunded;
 *   - moving keeps the price; the new day must be one the destination opens;
 *   - a visitor's cancellation refunds the amount less the share the office
 *     keeps there (spots.cancel_keep_percent); the office's own cancellation
 *     (payments.js, closures) refunds everything.
 *
 * Room bookings (bookings.js) use the same routes with their own rules: a
 * change closes at the resort's free-cancel days before check-in, and new
 * dates go back to the resort to confirm.
 *
 * Mounted at /api by server.js. Every change is emailed to the visitor.
 */
const express = require('express');
const { query } = require('./db');
const { tickets: Ticket, payments: Payment, spots: Spot } = require('./models');
const attractions = require('./attractions');
const notices = require('./notices');
const bookings = require('./bookings');
const { requireVisitor } = require('./visitors');

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
const NOT_FOUND = 'This ticket or booking is not in your account.';

/* The signed-in visitor's own ticket or booking with this code, or null. */
async function findRecord(code, visitorId) {
    const wanted = normaliseCode(code);
    if (wanted.length < 5 || !visitorId) return null;
    const { rows } = await query(
        `select id from tickets where regexp_replace(upper(code), '[^A-Z0-9]', '', 'g') = $1 and visitor_id = $2`, [wanted, visitorId]);
    if (rows[0]) return { kind: 'ticket', record: await Ticket.findById(rows[0].id) };
    const booking = await bookings.findOwnBooking(code, visitorId);
    if (booking) return { kind: 'booking', record: booking };
    return null;
}

/* Until when it can be changed, and whether it still can. */
function changeWindow(visitDate) {
    const lastDay = addDays(String(visitDate).slice(0, 10), -1);
    return { lastDay, open: manilaToday() <= lastDay };
}

async function paymentFor(id) {
    return (await Payment.findOne({ ticketId: id })) || null;
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
    const payment = await paymentFor(record._id);
    const window = changeWindow(record.visitDate);
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

    const live = record.status === 'valid';
    const closed = record.status === 'closed';
    return {
        ...base,
        code: record.code, visitDate: record.visitDate, people: record.people,
        kindsText: attractions.describeKinds(record), name: record.fullName, maxDate: addDays(manilaToday(), TICKET_DAYS_AHEAD),
        canMove: (live && window.open) || closed, canCancel: live && window.open, canRefundClosure: closed,
        why: closed ? `The office closed ${spot ? spot.title : 'the attraction'} on this date. Choose a full refund, or move the ticket to another date.`
            : record.status === 'used' ? 'This ticket was used at the entrance, so it can no longer be moved or refunded.'
            : record.status === 'cancelled' ? 'This ticket is cancelled.'
            : record.status !== 'valid' ? 'This ticket was never paid for.'
            : !window.open ? 'Changes close at 11:59 PM the day before the visit.' : ''
    };
}

module.exports = function manageRouter({ sharedRateLimit, refund, siteOrigin }) {
    const router = express.Router();
    const limit = sharedRateLimit('manage', {
        windowMs: 60 * 60 * 1000,
        limit: 40,
        // Per account: the routes need a signed-in visitor.
        keyGenerator: req => `visitor:${req.visitor.id}`,
        message: { success: false, message: 'Too many tries. Please wait a while, or contact the Municipal Tourism Office.' }
    });

    const fail = (res, error, label) => {
        if (error && error.status) return res.status(error.status).json({ success: false, message: error.message });
        console.error(label, error);
        return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    };

    async function load(req) {
        const found = await findRecord(req.body && req.body.code, req.visitor.id);
        if (!found || !found.record) throw problem(404, NOT_FOUND);
        return found;
    }

    router.post('/manage/lookup', requireVisitor, limit, async (req, res) => {
        try {
            const found = await load(req);
            if (found.kind === 'booking') {
                await bookings.sweepBookings(siteOrigin(req)).catch(error => console.error('❌ Booking sweep failure:', error));
                // Back from paying online: the payment shows at once.
                await require('./booking-payments').settlePendingFor(found.record.id, siteOrigin(req)).catch(() => {});
                const fresh = await load(req);
                return res.json({ success: true, item: await bookings.describeForVisitor(fresh.record) });
            }
            res.json({ success: true, item: await describe(found) });
        } catch (error) { fail(res, error, '❌ Manage lookup failure:'); }
    });

    router.post('/manage/move', requireVisitor, limit, async (req, res) => {
        try {
            const found = await load(req);
            if (found.kind === 'booking') {
                const done = await bookings.visitorMove(found.record, req.body, siteOrigin(req));
                const fresh = await load(req);
                return res.json({ success: true, emailed: done.emailed,
                    message: 'New dates sent to the resort. It will confirm or decline them by email.',
                    item: await bookings.describeForVisitor(fresh.record) });
            }
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

            const from = found.record.visitDate;
            if (date === from) throw problem(400, 'That is already the ticket\'s date.');
            // Only a valid ticket on the date we read: a gate scan or a second
            // tab in between leaves it alone.
            const { rowCount } = await query(
                `update tickets set visit_date = $2, status = 'valid'
                  where id = $1 and status in ('valid', 'closed') and visit_date = $3`, [found.record._id, date, from]);
            if (!rowCount) throw problem(409, 'This ticket changed just now. Look it up again.');
            const told = await notices.ticketMoved(found.record._id, from, origin);
            return res.json({ success: true, emailed: told.sent, message: `Moved to ${attractions.niceDate(date)}. The same ticket code works on the new date.`, item: await describe(await load(req)) });
        } catch (error) { fail(res, error, '❌ Manage move failure:'); }
    });

    router.post('/manage/cancel', requireVisitor, limit, async (req, res) => {
        try {
            const found = await load(req);
            if (found.kind === 'booking') {
                const done = await bookings.visitorCancel(found.record, siteOrigin(req));
                const fresh = await load(req);
                return res.json({ success: true, emailed: done.emailed, refunded: done.refunded,
                    message: done.refunded ? `Cancelled. ₱${done.refunded.toLocaleString('en-PH')} is on its way back to you. The resort has been told.` : 'Cancelled. The resort has been told.',
                    item: await bookings.describeForVisitor(fresh.record) });
            }
            const view = await describe(found);
            if (!view.canCancel) throw problem(409, view.why || 'This can no longer be cancelled.');
            const origin = siteOrigin(req);
            const payment = await paymentFor(found.record._id);
            const reason = 'Cancelled by the visitor';

            if (payment && !payment.refundedAt) {
                const done = await refund(payment._id, reason, VISITOR, { amount: view.refund });
                const kept = money(done.amount - done.refundAmount);
                const told = await notices.ticketCancelled(found.record._id, { refundAmount: done.refundAmount, keptAmount: kept, byVisitor: true }, origin);
                return res.json({ success: true, emailed: told.sent, message: done.refundAmount > 0
                    ? `Cancelled. ${'₱' + done.refundAmount.toLocaleString('en-PH', { minimumFractionDigits: 2 })} is being refunded to the way you paid.`
                    : 'Cancelled. Nothing is refunded.', item: await describe(await load(req)) });
            }

            throw problem(409, 'This ticket was never paid for.');
        } catch (error) { fail(res, error, '❌ Manage cancel failure:'); }
    });

    /* Closed by the office: the visitor takes the full refund. */
    router.post('/manage/refund-closure', requireVisitor, limit, async (req, res) => {
        try {
            const found = await load(req);
            if (found.kind === 'booking') throw problem(409, 'There is no closure refund to take here.');
            const view = await describe(found);
            if (!view.canRefundClosure) throw problem(409, view.why || 'There is no closure refund to take here.');
            const payment = await paymentFor(found.record._id);
            if (!payment || payment.refundedAt) throw problem(409, 'This was already refunded.');
            const done = await refund(payment._id, 'The office closed this date: refunded in full', VISITOR);
            const origin = siteOrigin(req);
            const told = await notices.ticketCancelled(found.record._id, { refundAmount: done.refundAmount, byVisitor: false, reason: 'closed that day' }, origin);
            res.json({ success: true, emailed: told.sent,
                message: `Refunded in full: ₱${done.refundAmount.toLocaleString('en-PH', { minimumFractionDigits: 2 })} is on its way back to the way you paid.`,
                item: await describe(await load(req)) });
        } catch (error) { fail(res, error, '❌ Closure refund failure:'); }
    });

    return router;
};
