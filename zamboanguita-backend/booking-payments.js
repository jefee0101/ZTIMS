/*
 * Room bookings: pay at the property or pay online (November 2026, the user's
 * choice; mockup in docs/booking-payment/mockup.html).
 *
 * The guest chooses when asking for the rooms (bookings.payment_choice). The
 * resort says which ways it takes (enterprise_booking_settings
 * .allow_pay_at_property / .allow_pay_online). An online payment is made only
 * after the resort confirms, for what is still owed, on a Xendit hosted
 * invoice — the same test-mode demonstration as tickets (payments.js), with
 * the same rules:
 *   - the server works out the amount (the booking's total less what is paid);
 *   - a payment is believed only when the server asks Xendit itself (settle);
 *     Xendit's callback only names the checkout to settle;
 *   - the invoice must match its checkout (external_id ztims-b-<id>), be in
 *     PHP and for the amount asked;
 *   - the checkout row is locked while a payment is recorded, so the return
 *     page and the callback arriving together record it once;
 *   - every record is is_demo; a live key switches online payment off.
 * A guest who cancels within the resort's free-cancellation window gets an
 * online payment back in full. ZTIMS never holds money for the resort.
 */
const express = require('express');
const { query, transaction } = require('./db');
const { bookingCheckouts: Checkout, BOOKING_ONLINE_METHODS } = require('./models');
const payments = require('./payments');
const { requireVisitor } = require('./visitors');

const ONLINE_LABEL = 'Online (Xendit test mode)';
const MANILA_OFFSET_HOURS = 8;
const money = n => Math.round(Number(n) * 100) / 100;
const manilaDay = date => new Date(new Date(date).getTime() + MANILA_OFFSET_HOURS * 3600 * 1000).toISOString().slice(0, 10);
const externalIdOf = checkoutId => `ztims-b-${checkoutId}`;
const isId = value => /^[0-9a-f]{24}$/.test(String(value || ''));

function problem(status, message, code) {
    const e = new Error(message);
    e.status = status;
    if (code) e.code = code;
    return e;
}

/* The ways a resort takes payment right now. Online only while the resort
   allows it AND the gateway is on (a test key). */
function optionsFor(settings) {
    const online = Boolean(settings.allowPayOnline && payments.gatewayState().online);
    const atProperty = Boolean(settings.allowPayAtProperty);
    return { atProperty, online };
}

/* What a booking has paid (less refunds), what it still owes, and what the
   guest can do about it. `settings` is bookings.js's shaped settings. */
async function paymentState(b, settings, client) {
    const { rows: paid } = await query(
        `select id, amount, method, channel, received_on, reference, refunded_at, refund_amount, created_at
           from booking_payments where booking_id = $1 order by received_on, created_at`, [b.id], client);
    const net = paid.reduce((s, p) => s + Number(p.amount) - Number(p.refund_amount || 0), 0);
    const owed = Math.max(0, money(Number(b.total_amount) - net));
    const online = paid.filter(p => p.channel === 'online');
    const options = optionsFor(settings);
    const live = ['requested', 'confirmed'].includes(b.status);
    const { rows: open } = await query(
        `select id, checkout_url from booking_checkouts
          where booking_id = $1 and status = 'pending' and expires_at > now() and checkout_url <> ''
          order by created_at desc limit 1`, [b.id], client);
    const enough = owed >= payments.MIN_ONLINE_AMOUNT;
    return {
        choice: b.payment_choice || 'property',
        options,
        paidTotal: money(net),
        owed,
        paidOnline: online.filter(p => !p.refunded_at).map(p => ({
            amount: money(p.amount), method: p.method, paidOn: p.received_on, reference: p.reference
        })),
        refunded: online.filter(p => p.refunded_at).map(p => ({ amount: money(p.refund_amount), refundedAt: p.refunded_at })),
        hasOnlinePayment: online.some(p => !p.refunded_at),
        // Pay now: chosen online, confirmed by the resort, something owed.
        canPayOnline: (b.payment_choice === 'online') && b.status === 'confirmed' && enough && options.online,
        openPayUrl: open[0] ? open[0].checkout_url : '',
        // Switch: before anything was paid online, while the booking is live.
        canSwitchToProperty: live && b.payment_choice === 'online' && !online.some(p => !p.refunded_at) && options.atProperty,
        canSwitchToOnline: live && b.payment_choice !== 'online' && options.online && enough
    };
}

/* A new invoice for what the booking still owes. */
async function openCheckout(origin, b, amount, resortName) {
    const row = await Checkout.create({
        bookingId: b.id, amount,
        expiresAt: new Date(Date.now() + payments.CHECKOUT_MINUTES * 60 * 1000),
        isDemo: true
    });
    const back = `${origin}/src/manage.html?code=${encodeURIComponent(b.code)}&paid=${row._id}`;
    try {
        const name = `Room booking ${b.code}`;
        const invoice = await payments.gateway('POST', '/v2/invoices', {
            external_id: externalIdOf(row._id),
            amount,
            currency: 'PHP',
            description: `${name} — ${resortName}, ${b.check_in} to ${b.check_out}`.slice(0, 250),
            invoice_duration: payments.CHECKOUT_MINUTES * 60,
            success_redirect_url: back,
            failure_redirect_url: `${back}&cancelled=1`,
            items: [{ name: name.slice(0, 120), quantity: 1, price: amount }],
            ...(payments.METHODS.length ? { payment_methods: payments.METHODS } : {})
        });
        const url = String(invoice.invoice_url || '');
        if (!invoice.id || !payments.isGatewayPage(url) || invoice.external_id !== externalIdOf(row._id)) {
            throw problem(502, 'The payment service gave an unexpected answer. Try again later, or pay at the property.');
        }
        row.sessionId = String(invoice.id);
        row.checkoutUrl = url;
        await Checkout.save(row);
        return row;
    } catch (error) {
        row.status = 'expired';
        await Checkout.save(row).catch(() => {});
        throw error;
    }
}

/* The payment inside an invoice, or null when it is not paid — or not
   provably this checkout's, in pesos, for the amount asked. */
function paidPaymentOf(invoice, checkout) {
    if (!invoice || !['PAID', 'SETTLED'].includes(String(invoice.status))) return null;
    if (invoice.id !== checkout.sessionId || invoice.external_id !== externalIdOf(checkout._id)) {
        console.error(`❌ Invoice ${invoice.id} does not belong to booking checkout ${checkout._id}; ignored.`);
        return null;
    }
    const asked = money(checkout.amount);
    const paidAmount = money(invoice.paid_amount != null ? invoice.paid_amount : invoice.amount);
    if (String(invoice.currency || 'PHP') !== 'PHP' || money(invoice.amount) !== asked || paidAmount < asked) {
        console.error(`❌ Invoice ${invoice.id} is for ${invoice.currency} ${invoice.amount} (paid ${paidAmount}), not PHP ${asked}; not recorded.`);
        return null;
    }
    const paidAt = invoice.paid_at ? new Date(invoice.paid_at) : new Date();
    const method = payments.methodOf(invoice);
    return {
        ref: String(invoice.id), amount: asked,
        method: BOOKING_ONLINE_METHODS.includes(method) ? method : 'other',
        paidAt: Number.isNaN(paidAt.getTime()) ? new Date() : paidAt
    };
}

/* Records a paid checkout, once. A payment for a booking that is no longer
   confirmed, or already paid, is marked duplicate and sent back. */
async function recordPaid(checkoutId, paid) {
    const result = await transaction(async client => {
        const { rows } = await query('select * from booking_checkouts where id = $1 for update', [checkoutId], client);
        const checkout = Checkout.fromRow(rows[0]);
        if (!checkout || checkout.status === 'paid' || checkout.status === 'duplicate') return { checkout, justPaid: false };
        const { rows: found } = await query('select * from bookings where id = $1 for update', [checkout.bookingId], client);
        const b = found[0];
        const { rows: sums } = await query(
            'select coalesce(sum(amount - coalesce(refund_amount, 0)), 0) as net from booking_payments where booking_id = $1', [checkout.bookingId], client);
        const owed = b ? money(Number(b.total_amount) - Number(sums[0].net)) : 0;
        const duplicate = !b || !['confirmed', 'checked_in', 'completed'].includes(b.status) || owed + 0.001 < paid.amount;
        if (!duplicate) {
            await query(`
                insert into booking_payments (booking_id, amount, method, received_on, reference, recorded_by_email, channel, gateway_ref, is_demo)
                values ($1, $2, $3, $4, $5, $6, 'online', $7, true)`,
                [b.id, paid.amount, paid.method, manilaDay(paid.paidAt), paid.ref, ONLINE_LABEL, paid.ref], client);
            await query('insert into booking_changes (booking_id, action, before, after, by_email) values ($1, $2, null, $3, $4)',
                [b.id, 'paid_online', JSON.stringify({ amount: paid.amount, method: paid.method }), ONLINE_LABEL], client);
        }
        checkout.status = duplicate ? 'duplicate' : 'paid';
        checkout.method = paid.method;
        checkout.paymentRef = paid.ref;
        checkout.paidAt = paid.paidAt;
        await Checkout.save(checkout, { client });
        return { checkout, justPaid: !duplicate, duplicate };
    });
    if (result.duplicate) {
        // Nothing to pay for any more: send it straight back, in full.
        console.warn(`⚠️ Booking checkout ${checkoutId} was paid but its booking no longer needed it — refunding.`);
        await payments.gateway('POST', '/refunds', { invoice_id: paid.ref, amount: paid.amount, reason: 'DUPLICATE' },
            { 'Idempotency-key': `ztims-brefund-dup-${checkoutId}` })
            .catch(error => console.error('❌ Duplicate booking payment not refunded; refund it by hand:', error.message));
    } else if (result.justPaid) {
        console.log(`💳 Online booking payment (test mode) recorded for checkout ${checkoutId}`);
    }
    return result;
}

/* Asks the gateway how a pending checkout stands, and records it if paid. */
async function settle(checkout, { lateToo = false, origin = '' } = {}) {
    const open = checkout && (checkout.status === 'pending' || (lateToo && checkout.status === 'expired'));
    if (!open || !checkout.sessionId || !payments.gatewayState().online) return checkout;
    const invoice = await payments.gateway('GET', `/v2/invoices/${encodeURIComponent(checkout.sessionId)}`);
    const paid = paidPaymentOf(invoice, checkout);
    if (paid) {
        const { justPaid } = await recordPaid(checkout._id, paid);
        if (justPaid) await require('./notices').bookingPaidOnline(checkout.bookingId, paid, origin).catch(() => {});
        return Checkout.findById(checkout._id);
    }
    const paidThere = invoice.status === 'PAID' || invoice.status === 'SETTLED';
    if (!paidThere && checkout.status === 'pending' && (invoice.status === 'EXPIRED' || new Date(checkout.expiresAt) < new Date())) {
        checkout.status = 'expired';
        await Checkout.save(checkout);
    }
    return checkout;
}

/* Xendit's callback (payments.js's webhook routes ztims-b-<id> here). */
async function settleById(checkoutId, invoiceId, origin) {
    const checkout = await Checkout.findById(checkoutId);
    if (!checkout || checkout.sessionId !== invoiceId) return null;
    return settle(checkout, { lateToo: true, origin });
}

/* Before a booking is shown to its guest: settles its open checkouts, so a
   visitor back from Xendit sees the payment at once. */
async function settlePendingFor(bookingId, origin) {
    const { rows } = await query(
        `select id from booking_checkouts where booking_id = $1 and session_id <> ''
            and (status = 'pending' or (status = 'expired' and created_at > now() - interval '1 day'))
          order by created_at desc limit 3`, [bookingId]);
    for (const r of rows) {
        const checkout = await Checkout.findById(r.id);
        try { await settle(checkout, { lateToo: true, origin }); } catch (error) { /* the page asks again */ }
    }
}

/* Sends back every online payment of a booking, in full (the guest cancelled
   within the free-cancellation window). Each refund carries its own
   idempotency key, so a second attempt asks for the same refund. Returns the
   amount refunded. Throws before anything is changed when the gateway is off. */
async function refundOnline(bookingId, reason, byEmail) {
    const { rows } = await query(
        `select * from booking_payments where booking_id = $1 and channel = 'online' and refunded_at is null and gateway_ref <> ''`, [bookingId]);
    if (!rows.length) return 0;
    if (!payments.gatewayState().online) {
        throw problem(409, 'Online payment is switched off just now, so the refund cannot be sent. Try again later, or contact the resort.');
    }
    let total = 0;
    for (const p of rows) {
        const amount = money(p.amount);
        await payments.gateway('POST', '/refunds', { invoice_id: p.gateway_ref, amount, reason: 'CANCELLATION' },
            { 'Idempotency-key': `ztims-brefund-${p.id}` });
        await query(`update booking_payments set refunded_at = now(), refund_amount = $2, refund_reason = $3 where id = $1 and refunded_at is null`,
            [p.id, amount, String(reason || '').slice(0, 300)]);
        await query('insert into booking_changes (booking_id, action, before, after, by_email) values ($1, $2, null, $3, $4)',
            [bookingId, 'refunded_online', JSON.stringify({ amount }), byEmail || ''], null);
        total += amount;
    }
    return money(total);
}

/* ------------------------------------------------------------------ router */

module.exports = function bookingPaymentsRouter({ sharedRateLimit, siteOrigin }) {
    const router = express.Router();
    const payLimit = sharedRateLimit('booking-pay', {
        windowMs: 15 * 60 * 1000,
        limit: 20,
        keyGenerator: req => `visitor:${req.visitor.id}`,
        message: { success: false, message: 'Too many tries. Please wait a few minutes.' }
    });
    const bookings = () => require('./bookings');
    const fail = (res, error, label) => {
        if (error && error.status) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
        console.error(label, error);
        return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    };
    const own = async req => {
        const b = await bookings().findOwnBooking((req.body || {}).code, req.visitor.id);
        if (!b) throw problem(404, 'This ticket or booking is not in your account.');
        return b;
    };

    /* Pay now: opens (or reuses) an invoice for what is owed. */
    router.post('/bookings/pay', requireVisitor, payLimit, async (req, res) => {
        try {
            const b = await own(req);
            const settings = await bookings().settingsFor(b.spot_id);
            await settlePendingFor(b.id, siteOrigin(req));
            const state = await paymentState(b, settings);
            if (!state.canPayOnline) {
                throw problem(409, b.payment_choice !== 'online' ? 'This booking is to be paid at the property.'
                    : b.status === 'requested' ? 'You can pay once the resort confirms your booking.'
                    : !state.options.online ? 'Online payment is not available for this place just now. You can pay at the property.'
                    : state.owed < payments.MIN_ONLINE_AMOUNT ? 'Nothing is left to pay online.'
                    : 'This booking can no longer be paid online.');
            }
            if (state.openPayUrl) return res.json({ success: true, payUrl: state.openPayUrl });
            const { rows } = await query(`select coalesce(nullif(enterprise_name, ''), title) as name from spots where id = $1`, [b.spot_id]);
            const checkout = await openCheckout(siteOrigin(req), b, state.owed, rows[0] ? rows[0].name : '');
            return res.json({ success: true, payUrl: checkout.checkoutUrl });
        } catch (error) { return fail(res, error, '❌ Booking pay failure:'); }
    });

    /* Change of mind: pay at the property instead, or online instead. */
    router.post('/bookings/payment-choice', requireVisitor, payLimit, async (req, res) => {
        try {
            const choice = String((req.body || {}).choice || '');
            if (!['property', 'online'].includes(choice)) throw problem(400, 'Choose how you will pay.');
            const b = await own(req);
            const settings = await bookings().settingsFor(b.spot_id);
            const state = await paymentState(b, settings);
            if (choice === b.payment_choice) throw problem(400, 'That is already how you will pay.');
            if (choice === 'property' && !state.canSwitchToProperty) throw problem(409, 'This booking can no longer be switched to paying at the property.');
            if (choice === 'online' && !state.canSwitchToOnline) throw problem(409, 'Online payment is not available for this booking.');
            await transaction(async client => {
                const { rowCount } = await query(
                    `update bookings set payment_choice = $2 where id = $1 and payment_choice = $3 and status in ('requested', 'confirmed')`,
                    [b.id, choice, b.payment_choice], client);
                if (!rowCount) throw problem(409, 'This booking changed just now. Look it up again.');
                await query('insert into booking_changes (booking_id, action, before, after, by_email) values ($1, $2, $3, $4, $5)',
                    [b.id, 'payment_choice', JSON.stringify({ paymentChoice: b.payment_choice }), JSON.stringify({ paymentChoice: choice }), 'the guest (Manage page)'], client);
            });
            const fresh = await bookings().findOwnBooking(b.code, req.visitor.id);
            return res.json({ success: true, message: choice === 'online' ? 'You will pay online.' : 'You will pay at the property.',
                item: await bookings().describeForVisitor(fresh) });
        } catch (error) { return fail(res, error, '❌ Booking payment choice failure:'); }
    });

    return router;
};

module.exports.optionsFor = optionsFor;
module.exports.paymentState = paymentState;
module.exports.settleById = settleById;
module.exports.settlePendingFor = settlePendingFor;
module.exports.refundOnline = refundOnline;
