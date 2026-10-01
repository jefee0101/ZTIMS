/* Online payments — a DEMONSTRATION, in the payment gateway's test mode.
 *
 * A visitor may pay a guide booking online, or buy an entrance ticket to an
 * attraction the Tourism Office runs. The money side is a Xendit invoice: the
 * visitor pays on Xendit's own hosted page (GCash, Maya, cards, online banking
 * — whatever the account has switched on), and ZTIMS never sees a card number
 * or a wallet PIN.
 *
 * TEST MODE ONLY. The secret key must be a development key (xnd_development_…);
 * a production key, or anything else, is refused and online payment switches
 * itself off, so no real money can move. Collecting real fees would need a
 * municipal ordinance, the Municipal Treasurer, a merchant account in the
 * municipality's name and official receipts under COA rules. Every record an
 * online payment makes is marked is_demo, and so is the sample data the
 * officer can load for a demonstration; both come out with one button.
 *
 * How a payment is confirmed: never by the visitor's browser coming back, and
 * never by the body of a webhook. The server asks Xendit itself, with its own
 * key (settle) — when the visitor returns, and when Xendit's callback arrives
 * carrying the account's verification token; whichever is first, the other
 * finds the work done. The invoice must be ours (its external_id), in pesos and
 * for the amount we asked. Amounts are decided here, from the fees on record.
 *
 * Money stays out of the statistics: Form A4 and the Arrivals Report are
 * counts only, and nothing here writes to them.
 *
 * Mounted at /api by server.js, which hands over its sign-in checks and its
 * shared rate limiter so this file enforces the same rules.
 */
const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const { query, transaction } = require('./db');
const attractions = require('./attractions');
const {
    bookings: GuideBooking, payments: Payment, tickets: Ticket, checkouts: Checkout,
    guides: TouristGuide, officers: TourismOfficer, spots: Spot
} = require('./models');

// XENDIT_API_BASE exists for local tests against a stand-in; leave it unset.
const gatewayApi = () => (process.env.XENDIT_API_BASE || 'https://api.xendit.co').replace(/\/+$/, '');
const CHECKOUT_MINUTES = 30;
const MIN_ONLINE_AMOUNT = 20;          // a safe floor: card payments below ₱20 are refused
const MAX_TICKET_PEOPLE = 20;
const TICKET_DAYS_AHEAD = 60;
const MANILA_OFFSET_HOURS = 8;
const ONLINE_LABEL = 'Online (Xendit test mode)';
const DEMO_BOOKING_PREFIX = 'TG-DEMO-';
const TEST_KEY_PREFIX = 'xnd_development_';

/* ---------------------------------------------------------------- gateway */

function gatewayKey() {
    return String(process.env.XENDIT_SECRET_KEY || '').trim();
}

/* Online payment is on only with a TEST (development) key. Anything else — a
   production key above all — is refused outright: this build is a
   demonstration and must never take real money. */
function gatewayState() {
    const key = gatewayKey();
    if (!key) return { online: false, reason: 'not_configured' };
    if (!key.startsWith(TEST_KEY_PREFIX) || key.length <= TEST_KEY_PREFIX.length) return { online: false, reason: 'live_key_refused' };
    return { online: true, mode: 'test' };
}

/* Optional: which of the account's methods the invoice offers (Xendit's own
   codes, e.g. GCASH,PAYMAYA,CREDIT_CARD). Unset, Xendit shows every method the
   account has switched on, which is the safer default — naming one the account
   lacks makes Xendit refuse the invoice. */
const METHODS = String(process.env.XENDIT_METHODS || '')
    .split(',').map(m => m.trim().toUpperCase()).filter(m => /^[A-Z0-9_]{2,40}$/.test(m));

/* The callback token compared in constant time. Both sides are hashed first so
   the comparison does not leak the token's length either. */
function callbackTokenMatches(given) {
    const expected = String(process.env.XENDIT_CALLBACK_TOKEN || '').trim();
    if (!expected || !given) return false;
    const a = crypto.createHash('sha256').update(String(given)).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

async function gateway(method, path, body, extraHeaders = {}) {
    let res;
    try {
        res = await fetch(gatewayApi() + path, {
            method,
            headers: {
                Authorization: 'Basic ' + Buffer.from(gatewayKey() + ':').toString('base64'),
                'Content-Type': 'application/json',
                Accept: 'application/json',
                ...extraHeaders
            },
            body: body ? JSON.stringify(body) : undefined,
            redirect: 'error',
            signal: AbortSignal.timeout(15000)
        });
    } catch (error) {
        const e = new Error('The payment service could not be reached. Try again, or pay at the Municipal Tourism Office.');
        e.status = 502;
        throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        // Xendit's error code and message only — never the request, which
        // carries the key in its header.
        console.error('❌ Xendit refused:', res.status, String(data.error_code || ''), String(data.message || '').slice(0, 200));
        const e = new Error('The payment service refused this request. Try again, or pay at the Municipal Tourism Office.');
        e.status = 502;
        throw e;
    }
    return data;
}

// Xendit's channel and method codes → the short names the office's pages show.
const METHOD_NAMES = {
    GCASH: 'gcash', PAYMAYA: 'maya', GRABPAY: 'grabpay', SHOPEEPAY: 'shopeepay',
    CREDIT_CARD: 'card', CARD: 'card', QRPH: 'qrph', QR_CODE: 'qrph',
    DD_BPI: 'bank', DD_UBP: 'bank', DD_RCBC: 'bank', DD_CHINABANK: 'bank', BPI: 'bank', UBP: 'bank',
    RCBC: 'bank', CHINABANK: 'bank', DIRECT_DEBIT: 'bank', BANK_TRANSFER: 'bank'
};
function methodOf(invoice) {
    const raw = String(invoice.payment_channel || invoice.payment_method || '').toUpperCase();
    return METHOD_NAMES[raw] || (raw ? raw.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30) : 'online');
}

/* Visitors are only ever sent to Xendit's own https pages (a stand-in's, in
   local tests). */
function isGatewayPage(url) {
    let u;
    try { u = new URL(url); } catch (error) { return false; }
    if (process.env.XENDIT_API_BASE) return u.protocol === 'http:' || u.protocol === 'https:';
    return u.protocol === 'https:' && (u.hostname === 'xendit.co' || u.hostname.endsWith('.xendit.co'));
}

/* Each checkout's invoice carries this, so an invoice is only ever matched to
   the checkout that opened it. */
const externalIdOf = checkoutId => `ztims-${checkoutId}`;

/* The payment inside an invoice, or null when it is not paid — or not
   provably ours, in pesos, for the amount we asked. */
function paidPaymentOf(invoice, checkout) {
    if (!invoice || !['PAID', 'SETTLED'].includes(String(invoice.status))) return null;
    if (invoice.id !== checkout.sessionId || invoice.external_id !== externalIdOf(checkout._id)) {
        console.error(`❌ Invoice ${invoice.id} does not belong to checkout ${checkout._id}; ignored.`);
        return null;
    }
    const asked = money(checkout.amount);
    const paidAmount = money(invoice.paid_amount != null ? invoice.paid_amount : invoice.amount);
    if (String(invoice.currency || 'PHP') !== 'PHP' || money(invoice.amount) !== asked || paidAmount < asked) {
        console.error(`❌ Invoice ${invoice.id} is for ${invoice.currency} ${invoice.amount} (paid ${paidAmount}), not PHP ${asked}; not recorded.`);
        return null;
    }
    const paidAt = invoice.paid_at ? new Date(invoice.paid_at) : new Date();
    return {
        ref: invoice.id,
        amount: asked,
        method: methodOf(invoice),
        paidAt: Number.isNaN(paidAt.getTime()) ? new Date() : paidAt
    };
}

/* ---------------------------------------------------------------- helpers */

function manilaToday() {
    return new Date(Date.now() + MANILA_OFFSET_HOURS * 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(dayKey, n) {
    const d = new Date(dayKey + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
const dayOf = value => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10));
const money = n => Math.round(Number(n) * 100) / 100;

function siteOrigin(req) {
    const configured = String(process.env.PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
    return configured || `${req.protocol}://${req.get('host')}`;
}

function fail(res, status, message, extra = {}) {
    return res.status(status).json({ success: false, message, ...extra });
}
function failure(res, error, label) {
    if (error && error.status) return fail(res, error.status, error.message);
    console.error(label, error);
    return fail(res, 500, 'Something went wrong. Please try again.');
}

// Ticket codes avoid letters and digits that read alike (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode(length) {
    const bytes = crypto.randomBytes(length);
    return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
function codePrefix(title) {
    // "Jumao-as Falls" → JF: a hyphenated word counts once.
    const words = String(title || '').toUpperCase().split(/\s+/).map(w => w.replace(/[^A-Z]/g, '')).filter(Boolean);
    const initials = words.slice(0, 2).map(w => w[0]).join('');
    return (initials + 'XX').slice(0, 2);
}
const newTicketCode = title => `${codePrefix(title)}-${randomCode(4)}-${randomCode(1)}`;
const normaliseCode = code => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* Where the fee for a booking comes from: the assigned guide's fee, else the
   lowest fee among the guides free for that destination. Fixed on the checkout. */
async function bookingFee(booking) {
    if (booking.guideId) {
        const guide = await TouristGuide.findById(booking.guideId);
        if (guide) return money(guide.guideFee);
    }
    const guides = await TouristGuide.find({ assignedSpots: booking.spotId, status: 'available' });
    if (!guides.length) return null;
    return money(Math.min(...guides.map(g => Number(g.guideFee) || 0)));
}

/* An attraction sells tickets when the office runs it, it is published and
   charges an entrance fee. */
async function ticketOffer(spotId) {
    const spot = await Spot.findById(spotId);
    if (!spot) return { available: false, reason: 'not_found' };
    const fee = money(spot.entranceFee);
    const eligible = spot.type === 'spot' && spot.status === 'published' && !spot.managedBy && fee > 0;
    return { available: eligible, spot, unitFee: fee };
}

/* ---------------------------------------------------------------- checkout */

async function openCheckout(req, { kind, bookingId = null, ticketId = null, amount, name, description }) {
    const row = await Checkout.create({
        kind, bookingId, ticketId, amount,
        expiresAt: new Date(Date.now() + CHECKOUT_MINUTES * 60 * 1000),
        isDemo: true
    });
    const back = `${siteOrigin(req)}/src/payment.html?c=${row._id}`;
    try {
        const invoice = await gateway('POST', '/v2/invoices', {
            external_id: externalIdOf(row._id),
            amount,
            currency: 'PHP',
            description: `${name} — ${description}`.slice(0, 250),
            invoice_duration: CHECKOUT_MINUTES * 60,
            success_redirect_url: back,
            failure_redirect_url: `${back}&cancelled=1`,
            items: [{ name: name.slice(0, 120), quantity: 1, price: amount }],
            ...(METHODS.length ? { payment_methods: METHODS } : {})
        });
        const url = String(invoice.invoice_url || '');
        if (!invoice.id || !isGatewayPage(url) || invoice.external_id !== externalIdOf(row._id)) {
            const e = new Error('The payment service gave an unexpected answer. Please pay at the Municipal Tourism Office.');
            e.status = 502;
            throw e;
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

/* Records a paid checkout, once. Safe to call from the return page and the
   webhook at the same moment: the checkout row is locked while it is decided. */
async function recordPaid(checkoutId, paid) {
    return transaction(async client => {
        const { rows } = await query('select * from online_checkouts where id = $1 for update', [checkoutId], client);
        const checkout = Checkout.fromRow(rows[0]);
        if (!checkout || checkout.status === 'paid' || checkout.status === 'duplicate') return checkout;

        let duplicate = false;
        if (checkout.kind === 'guide_booking') {
            const booking = await GuideBooking.findById(checkout.bookingId, { client });
            const existing = await Payment.findOne({ bookingId: checkout.bookingId }, { client });
            if (!booking || existing || booking.status === 'cancelled') {
                duplicate = true;
            } else {
                await Payment.create({
                    bookingId: booking._id, amount: paid.amount, method: paid.method, channel: 'online',
                    gatewayRef: paid.ref, paidAt: paid.paidAt, recordedByEmail: ONLINE_LABEL, isDemo: true
                }, { client });
                booking.status = 'confirmed';
                booking.statusUpdatedAt = new Date();
                booking.isDemo = true;
                await GuideBooking.save(booking, { client });
            }
        } else {
            const ticket = await Ticket.findById(checkout.ticketId, { client });
            const existing = await Payment.findOne({ ticketId: checkout.ticketId }, { client });
            if (!ticket || existing || ticket.status === 'cancelled') {
                duplicate = true;
            } else {
                await Payment.create({
                    ticketId: ticket._id, amount: paid.amount, method: paid.method, channel: 'online',
                    gatewayRef: paid.ref, paidAt: paid.paidAt, recordedByEmail: ONLINE_LABEL, isDemo: true
                }, { client });
                ticket.status = 'valid';
                await Ticket.save(ticket, { client });
            }
        }

        checkout.status = duplicate ? 'duplicate' : 'paid';
        checkout.method = paid.method;
        checkout.paymentRef = paid.ref;
        checkout.paidAt = paid.paidAt;
        await Checkout.save(checkout, { client });
        if (duplicate) console.warn(`⚠️ Checkout ${checkout._id} was paid but its ${checkout.kind} was already paid or cancelled — refund it.`);
        else console.log(`💳 Online payment (test mode) recorded for checkout ${checkout._id}`);
        return checkout;
    });
}

/* Asks the gateway how a pending checkout stands, and records it if paid.
   This is the only way a payment is ever believed. Xendit's callback may also
   re-check an expired one (lateToo): a payment made in the last seconds of the
   invoice can arrive after our own window closed, and must not be lost. */
async function settle(checkout, { lateToo = false } = {}) {
    const open = checkout && (checkout.status === 'pending' || (lateToo && checkout.status === 'expired'));
    if (!open || !checkout.sessionId) return checkout;
    if (!gatewayState().online) return checkout;
    const invoice = await gateway('GET', `/v2/invoices/${encodeURIComponent(checkout.sessionId)}`);
    const paid = paidPaymentOf(invoice, checkout);
    if (paid) return recordPaid(checkout._id, paid);
    // Past our own window the invoice has expired at Xendit too
    // (invoice_duration), so no payment can arrive on it any more. A paid
    // invoice that failed the checks above stays pending, for a person to see.
    const paidThere = invoice.status === 'PAID' || invoice.status === 'SETTLED';
    if (!paidThere && checkout.status === 'pending' && (invoice.status === 'EXPIRED' || new Date(checkout.expiresAt) < new Date())) {
        checkout.status = 'expired';
        await Checkout.save(checkout);
    }
    return checkout;
}

/* ---------------------------------------------------------------- public views */

async function qrSvg(code) {
    return QRCode.toString(code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
}

async function spotTitle(spotId) {
    const { rows } = await query('select title from spots where id = $1', [spotId]);
    return rows[0] ? rows[0].title : '';
}

async function checkoutView(checkout) {
    const view = { id: checkout._id, kind: checkout.kind, status: checkout.status, amount: money(checkout.amount),
                   method: checkout.method, testMode: true };
    // A visitor who cancelled at the gateway can go back to the same checkout
    // while it is open.
    if (checkout.status === 'pending' && checkout.checkoutUrl && new Date(checkout.expiresAt) > new Date()) {
        view.payUrl = checkout.checkoutUrl;
    }
    if (checkout.kind === 'guide_booking') {
        const b = await GuideBooking.findById(checkout.bookingId);
        if (b) {
            view.booking = { reference: b.reference, spot: await spotTitle(b.spotId), preferredDate: dayOf(b.preferredDate),
                             preferredTime: b.preferredTime, visitors: b.visitors, status: b.status };
        }
    } else {
        const t = await Ticket.findById(checkout.ticketId);
        if (t) {
            view.ticket = { spot: await spotTitle(t.spotId), spotId: t.spotId, visitDate: dayOf(t.visitDate), people: t.people,
                            unitFee: money(t.unitFee), status: t.status, name: t.fullName,
                            kinds: attractions.kindsOf(t), kindsText: attractions.describeKinds(t) };
            // The code and its QR only once paid: an unpaid ticket gets nobody in.
            if (['valid', 'used'].includes(t.status)) {
                view.ticket.code = t.code;
                view.ticket.qr = await qrSvg(t.code);
            }
        }
    }
    return view;
}

/* ---------------------------------------------------------------- officer views */

async function listPayments(from, to) {
    const { rows } = await query(`
        select p.*, b.reference as booking_ref, b.full_name as booking_name, bs.title as booking_spot,
               t.code as ticket_code, t.full_name as ticket_name, t.people as ticket_people, t.visit_date as ticket_date,
               t.status as ticket_status,
               ts.title as ticket_spot
          from payments p
          left join guide_bookings b on b.id = p.booking_id
          left join spots bs on bs.id = b.spot_id
          left join tickets t on t.id = p.ticket_id
          left join spots ts on ts.id = t.spot_id
         where (p.paid_at at time zone 'Asia/Manila')::date between $1 and $2
         order by p.paid_at desc`, [from, to]);
    return rows.map(r => ({
        _id: r.id,
        paidAt: r.paid_at,
        day: new Date(new Date(r.paid_at).getTime() + MANILA_OFFSET_HOURS * 3600 * 1000).toISOString().slice(0, 10),
        kind: r.booking_id ? 'guide_fee' : 'entrance_fee',
        reference: r.booking_id ? r.booking_ref : r.ticket_code,
        place: r.booking_id ? r.booking_spot : r.ticket_spot,
        payer: r.booking_id ? r.booking_name : r.ticket_name,
        people: r.ticket_people || null,
        ticketStatus: r.ticket_status || null,
        channel: r.channel,
        method: r.method,
        amount: money(r.amount),
        receiptNumber: r.receipt_number,
        gatewayRef: r.gateway_ref,
        recordedByEmail: r.recorded_by_email,
        refundedAt: r.refunded_at,
        refundReason: r.refund_reason,
        isDemo: r.is_demo
    }));
}

function summarise(list) {
    const kept = list.filter(p => !p.refundedAt);
    const sum = items => money(items.reduce((a, p) => a + p.amount, 0));
    const byDay = new Map();
    for (const p of kept) {
        const d = byDay.get(p.day) || { day: p.day, guideFees: 0, entranceFees: 0, count: 0 };
        d[p.kind === 'guide_fee' ? 'guideFees' : 'entranceFees'] = money(d[p.kind === 'guide_fee' ? 'guideFees' : 'entranceFees'] + p.amount);
        d.count += 1;
        byDay.set(p.day, d);
    }
    return {
        total: sum(kept),
        guideFees: sum(kept.filter(p => p.kind === 'guide_fee')),
        entranceFees: sum(kept.filter(p => p.kind === 'entrance_fee')),
        online: sum(kept.filter(p => p.channel === 'online')),
        counter: sum(kept.filter(p => p.channel === 'counter')),
        refunded: sum(list.filter(p => p.refundedAt)),
        count: kept.length,
        awaitingReceipt: kept.filter(p => !p.receiptNumber).length,
        daily: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day))
    };
}

function rangeFrom(q) {
    const today = manilaToday();
    const month = /^\d{4}-\d{2}$/.test(String(q.month || '')) ? q.month : null;
    let from = /^\d{4}-\d{2}-\d{2}$/.test(String(q.from || '')) ? q.from : null;
    let to = /^\d{4}-\d{2}-\d{2}$/.test(String(q.to || '')) ? q.to : null;
    if (month) {
        from = `${month}-01`;
        const [y, m] = month.split('-').map(Number);
        to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    }
    return { from: from || `${today.slice(0, 7)}-01`, to: to || today };
}

/* ---------------------------------------------------------------- demo data */

const DEMO_NAMES = {
    PH: ['Maria Santos', 'Juan Reyes', 'Angela Cruz', 'Mark Villanueva', 'Kristine Dela Peña', 'Paolo Garcia', 'Jasmine Tan', 'Carlo Mendoza'],
    US: ['Emily Carter', 'Jacob Miller', 'Olivia Brooks', 'Ethan Walker'],
    FR: ['Camille Martin', 'Louis Bernard', 'Chloé Dubois', 'Hugo Lefèvre'],
    DE: ['Lukas Weber', 'Anna Schneider', 'Felix Wagner', 'Lea Fischer'],
    KR: ['Kim Min-ji', 'Park Ji-hoon', 'Lee Seo-yeon', 'Choi Woo-jin'],
    JP: ['Haruka Sato', 'Yuto Tanaka', 'Aoi Suzuki'],
    AU: ['Chloe Anderson', 'Liam Thompson', 'Mia Kelly'],
    GB: ['Oliver Hughes', 'Amelia Clarke', 'Harry Evans'],
    RU: ['Anastasia Ivanova', 'Dmitri Petrov', 'Elena Smirnova'],
    CH: ['Noah Keller', 'Lina Meier']
};
// Weighted like the 2025 Form A4: mostly Filipino, then France, USA, Russia, Germany…
const DEMO_COUNTRIES = ['PH', 'PH', 'PH', 'PH', 'PH', 'PH', 'FR', 'FR', 'US', 'US', 'RU', 'DE', 'KR', 'JP', 'AU', 'GB', 'CH'];
const DIAL = { PH: '+63', US: '+1', FR: '+33', DE: '+49', KR: '+82', JP: '+81', AU: '+61', GB: '+44', RU: '+7', CH: '+41' };

function demoRandom(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* The generated sample only: bookings with TG-DEMO- references, tickets that
   never went through a checkout, and their payments. Test-mode payments made
   through the real checkout stay, so loading the sample never wipes one. */
async function removeSample(client) {
    await query(`
        delete from payments
         where booking_id in (select id from guide_bookings where reference like '${DEMO_BOOKING_PREFIX}%')
            or ticket_id in (select id from tickets t where t.is_demo
                             and not exists (select 1 from online_checkouts c where c.ticket_id = t.id))`, [], client);
    await query(`delete from tickets t where t.is_demo
                   and not exists (select 1 from online_checkouts c where c.ticket_id = t.id)`, [], client);
    await query(`delete from guide_bookings where reference like '${DEMO_BOOKING_PREFIX}%'`, [], client);
}

/* Everything marked demo: the sample and every test-mode payment. */
async function removeDemo(client) {
    const counts = {};
    counts.payments = (await query(`
        delete from payments where is_demo
            or booking_id in (select id from guide_bookings where is_demo)
            or ticket_id in (select id from tickets where is_demo)`, [], client)).rowCount;
    await query(`delete from online_checkouts where is_demo
            and (booking_id is null or booking_id in (select id from guide_bookings where is_demo))
            and (ticket_id is null or ticket_id in (select id from tickets where is_demo))`, [], client);
    counts.tickets = (await query('delete from tickets where is_demo', [], client)).rowCount;
    counts.bookings = (await query('delete from guide_bookings where is_demo', [], client)).rowCount;
    return counts;
}

async function seedDemo(officerEmail) {
    const rand = demoRandom(Date.now());
    const pick = list => list[Math.floor(rand() * list.length)];
    const chance = p => rand() < p;
    const today = manilaToday();
    const nowMs = Date.now();

    const guideSpots = (await query(`
        select s.id, s.title, g.id as guide_id, g.guide_fee, g.max_group_size, g.available_days
          from spots s join tourist_guide_spots ts on ts.spot_id = s.id join tourist_guides g on g.id = ts.guide_id
         where s.requires_guide and s.status = 'published' and g.status = 'available'`)).rows;
    const ticketSpots = (await query(`
        select id, title, entrance_fee, student_fee, child_fee, child_age_max from spots
         where type = 'spot' and status = 'published' and managed_by is null and entrance_fee > 0`)).rows;

    const onlineMethod = () => pick(['gcash', 'gcash', 'gcash', 'maya', 'maya', 'card', 'card']);
    let orNumber = 4100000 + Math.floor(rand() * 1000);
    const nextOr = () => `OR-${++orNumber}`;
    const person = () => {
        const country = pick(DEMO_COUNTRIES);
        const name = pick(DEMO_NAMES[country]);
        const email = name.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.') + '@example.com';
        const phone = `${DIAL[country]} ${String(900000000 + Math.floor(rand() * 99999999))}`;
        return { country, name, email, phone };
    };
    const paidTime = (visitDay, maxDaysBefore) => {
        const visitMs = new Date(visitDay + 'T01:00:00Z').getTime();
        const at = visitMs - Math.floor(rand() * maxDaysBefore * 86400000) - 3600000;
        return new Date(Math.min(at, nowMs - 600000));
    };

    return transaction(async client => {
        await removeSample(client);
        let bookings = 0, tickets = 0, payments = 0;

        // ---- guide bookings, over the last 75 days and the next 14
        const taken = new Set();
        const byFee = new Map();
        for (const row of guideSpots) {
            if (!byFee.has(row.id)) byFee.set(row.id, []);
            byFee.get(row.id).push(row);
        }
        const spotIds = [...byFee.keys()];
        let serial = 0;
        for (let i = 0; spotIds.length && i < 42; i++) {
            const spotId = pick(spotIds);
            const guides = byFee.get(spotId);
            const guide = pick(guides);
            const offset = Math.floor(rand() * 90) - 75;
            const day = addDays(today, offset);
            const time = pick(['07:00', '08:00', '09:00', '13:00', '14:00']);
            const slot = `${guide.guide_id}|${day}|${time}`;
            if (taken.has(slot)) continue;
            taken.add(slot);

            const p = person();
            const visitors = 1 + Math.floor(rand() * Math.min(5, guide.max_group_size || 1));
            let status, withGuide = true, paid = true;
            if (offset < 0) status = chance(0.85) ? 'completed' : chance(0.5) ? 'no_show' : 'cancelled';
            else if (offset === 0) status = 'confirmed';
            else if (chance(0.25)) { status = 'pending_payment'; paid = false; withGuide = false; }
            else { status = 'confirmed'; withGuide = !chance(0.25); }

            const reference = DEMO_BOOKING_PREFIX + String(++serial).padStart(4, '0');
            const created = paidTime(day, 12);
            const booking = (await query(`
                insert into guide_bookings (reference, spot_id, guide_id, full_name, contact_number, email, nationality, visitors,
                                            preferred_date, preferred_time, status, status_updated_at, is_demo, created_at, updated_at)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13, $13) returning id`,
                [reference, spotId, withGuide ? guide.guide_id : null, p.name, p.phone, p.email, p.country, visitors,
                 day, time, status, created, created], client)).rows[0];
            bookings++;

            if (paid) {
                const online = chance(0.7);
                const paidAt = created;
                const ageDays = (nowMs - paidAt.getTime()) / 86400000;
                await query(`
                    insert into payments (booking_id, amount, method, receipt_number, paid_at, recorded_by_email, channel,
                                          gateway_ref, refunded_at, refund_reason, refunded_by_email, is_demo)
                    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)`,
                    [booking.id, guide.guide_fee, online ? onlineMethod() : 'cash',
                     !online || ageDays > 2 ? nextOr() : '', paidAt,
                     online ? ONLINE_LABEL : officerEmail, online ? 'online' : 'counter',
                     online ? `demo_pay_${crypto.randomBytes(6).toString('hex')}` : '',
                     status === 'cancelled' ? new Date(paidAt.getTime() + 86400000) : null,
                     status === 'cancelled' ? 'Cancelled by the office: bad weather' : '',
                     status === 'cancelled' ? officerEmail : ''], client);
                payments++;
            }
        }

        // ---- entrance tickets, over the last 75 days and the next 10
        for (let offset = -75; offset <= 10; offset++) {
            const day = addDays(today, offset);
            const weekend = [0, 6].includes(new Date(day + 'T00:00:00Z').getUTCDay());
            for (const spot of ticketSpots) {
                const count = Math.floor(rand() * (weekend ? 4 : 2.2));
                for (let n = 0; n < count; n++) {
                    const p = person();
                    const people = 1 + Math.floor(rand() * 6);
                    const unit = money(spot.entrance_fee);
                    // Mostly regular; now and then a senior, a PWD, a student or a child.
                    const fees = attractions.feeTable(spot);
                    const counts = { regular: 0, senior: 0, pwd: 0, student: 0, child: 0 };
                    for (let k = 0; k < people; k++) {
                        const r = rand();
                        const kind = r < 0.10 ? 'senior' : r < 0.14 ? 'pwd' : r < 0.24 ? 'student' : r < 0.36 ? 'child' : 'regular';
                        counts[fees[kind] === null ? 'regular' : kind] += 1;
                    }
                    const unitFees = {};
                    let total = 0;
                    for (const kind of Object.keys(counts)) {
                        if (!counts[kind]) continue;
                        unitFees[kind] = fees[kind];
                        total += counts[kind] * fees[kind];
                    }
                    const amount = money(total);
                    let status = 'valid', usedAt = null;
                    const cancelled = chance(0.03);
                    if (cancelled) status = 'cancelled';
                    else if (offset < 0 && chance(0.9)) status = 'used';
                    else if (offset === 0 && chance(0.4)) status = 'used';
                    if (status === 'used') {
                        usedAt = new Date(new Date(day + 'T00:00:00Z').getTime() + (8 + Math.floor(rand() * 8)) * 3600000 - MANILA_OFFSET_HOURS * 3600000);
                        if (usedAt.getTime() > nowMs) usedAt = new Date(nowMs - 300000);
                    }
                    const paidAt = paidTime(day, 5);
                    const ticket = (await query(`
                        insert into tickets (code, spot_id, visit_date, people, unit_fee, amount, full_name, email, contact_number,
                                             status, used_at, used_by_email, is_demo, created_at, updated_at,
                                             count_regular, count_senior, count_pwd, count_student, count_child, fee_breakdown)
                        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13, $13, $14, $15, $16, $17, $18, $19)
                        on conflict (code) do nothing returning id`,
                        [newTicketCode(spot.title), spot.id, day, people, unit, amount, p.name, p.email, p.phone,
                         status, usedAt, usedAt ? officerEmail : '', paidAt,
                         counts.regular, counts.senior, counts.pwd, counts.student, counts.child, unitFees], client)).rows[0];
                    if (!ticket) continue;
                    tickets++;
                    const ageDays = (nowMs - paidAt.getTime()) / 86400000;
                    await query(`
                        insert into payments (ticket_id, amount, method, receipt_number, paid_at, recorded_by_email, channel,
                                              gateway_ref, refunded_at, refund_reason, refunded_by_email, is_demo)
                        values ($1, $2, $3, $4, $5, $6, 'online', $7, $8, $9, $10, true)`,
                        [ticket.id, amount, onlineMethod(), ageDays > 2 ? nextOr() : '', paidAt, ONLINE_LABEL,
                         `demo_pay_${crypto.randomBytes(6).toString('hex')}`,
                         cancelled ? new Date(paidAt.getTime() + 3600000) : null,
                         cancelled ? 'Cancelled by the office: attraction closed for repairs' : '',
                         cancelled ? officerEmail : ''], client);
                    payments++;
                }
            }
        }
        return { bookings, tickets, payments };
    });
}

/* ---------------------------------------------------------------- refunds */

async function refund(paymentId, reason, officerEmail) {
    const payment = await Payment.findById(paymentId);
    if (!payment) { const e = new Error('That payment could not be found.'); e.status = 404; throw e; }
    if (payment.refundedAt) { const e = new Error('That payment was already refunded.'); e.status = 409; throw e; }

    // A used ticket is never refundable: the visitor got in. The ticket is
    // taken out of use FIRST, by one conditional update, so the gate cannot
    // admit it while the money is on its way back; if the refund then fails,
    // it is put back as it was.
    let ticketBefore = null;
    if (payment.ticketId) {
        ticketBefore = await transaction(async client => {
            const { rows } = await query('select status from tickets where id = $1 for update', [payment.ticketId], client);
            if (rows[0] && rows[0].status === 'used') {
                const e = new Error('This ticket was already used at the gate, so it cannot be refunded.');
                e.status = 409;
                throw e;
            }
            await query(`update tickets set status = 'cancelled' where id = $1`, [payment.ticketId], client);
            return rows[0] ? rows[0].status : null;
        });
    }
    try {
        return await sendRefund(payment, reason, officerEmail);
    } catch (error) {
        if (ticketBefore && ticketBefore !== 'cancelled') {
            await query(`update tickets set status = $2 where id = $1 and status = 'cancelled'`, [payment.ticketId, ticketBefore]).catch(() => {});
        }
        throw error;
    }
}

async function sendRefund(payment, reason, officerEmail) {
    // A real test-mode payment — one an invoice of ours paid — goes back
    // through the gateway. Seeded demo payments and cash handed back at the
    // counter are recorded only.
    const { rows: paidBy } = await query(
        `select id from online_checkouts where payment_ref = $1 and status = 'paid' limit 1`, [payment.gatewayRef || '']);
    if (payment.channel === 'online' && payment.gatewayRef && paidBy.length) {
        if (!gatewayState().online) { const e = new Error('Online payment is switched off, so this refund cannot be sent.'); e.status = 409; throw e; }
        // The idempotency key makes a second click (or a second officer) ask
        // for the same refund, never a second one.
        await gateway('POST', '/refunds', {
            invoice_id: payment.gatewayRef,
            amount: money(payment.amount),
            reason: 'CANCELLATION'
        }, { 'Idempotency-key': `ztims-refund-${payment._id}` });
    }

    return transaction(async client => {
        payment.refundedAt = new Date();
        payment.refundReason = reason;
        payment.refundedByEmail = officerEmail;
        await Payment.save(payment, { client });
        if (payment.bookingId) {
            const booking = await GuideBooking.findById(payment.bookingId, { client });
            if (booking && booking.status !== 'cancelled') {
                booking.status = 'cancelled';
                booking.statusNote = `Refunded: ${reason}`.slice(0, 500);
                booking.statusUpdatedAt = new Date();
                await GuideBooking.save(booking, { client });
            }
        } else if (payment.ticketId) {
            const ticket = await Ticket.findById(payment.ticketId, { client });
            if (ticket && ticket.status !== 'cancelled') {
                ticket.status = 'cancelled';
                await Ticket.save(ticket, { client });
            }
        }
        return payment;
    });
}

/* ---------------------------------------------------------------- the router */

module.exports = function paymentsRouter({ requireAdmin, sharedRateLimit, isPubliclyVisible }) {
    const router = express.Router();

    const checkoutLimit = sharedRateLimit('checkout', {
        windowMs: 60 * 60 * 1000,
        limit: 20,
        message: { success: false, message: 'Too many payment attempts from this connection. Please try again later.' }
    });

    const officerEmail = async req => {
        const officer = await TourismOfficer.findById(req.auth.sub);
        return officer ? officer.email : 'the Tourism Office';
    };

    /* PUBLIC: is online payment on? The pages ask before offering it. */
    router.get('/payments/config', (req, res) => {
        const state = gatewayState();
        res.json({ online: state.online, testMode: true, methods: METHODS, minAmount: MIN_ONLINE_AMOUNT });
    });

    /* PUBLIC: pay a guide booking online. The reference and the booking's email
       together, so a reference alone (they run in sequence) opens nothing. */
    router.post('/guide-bookings/:reference/checkout', checkoutLimit, async (req, res) => {
        try {
            if (!gatewayState().online) return fail(res, 409, 'Online payment is not available right now. Please pay at the Municipal Tourism Office.');
            const reference = String(req.params.reference || '').trim().toUpperCase();
            const email = String((req.body && req.body.email) || '').trim().toLowerCase();
            const booking = await GuideBooking.findOne({ reference });
            if (!booking || !email || booking.email !== email) return fail(res, 404, 'No booking matches that reference and email address.');
            if (booking.status !== 'pending_payment') return fail(res, 409, `${booking.reference} does not need paying: it is ${booking.status.replace('_', ' ')}.`);
            if (await Payment.findOne({ bookingId: booking._id })) return fail(res, 409, `${booking.reference} is already paid.`);

            // An open checkout is reused, so paying twice takes two deliberate tries.
            const open = (await Checkout.find({ bookingId: booking._id, status: 'pending' }))
                .find(c => new Date(c.expiresAt) > new Date() && c.checkoutUrl);
            if (open) return res.json({ success: true, checkoutUrl: open.checkoutUrl, checkoutId: open._id });

            const amount = await bookingFee(booking);
            if (amount === null) return fail(res, 409, 'No guide fee is set for this destination yet. Please pay at the Municipal Tourism Office.');
            if (amount < MIN_ONLINE_AMOUNT) return fail(res, 409, `Online payments start at ₱${MIN_ONLINE_AMOUNT}. Please pay at the Municipal Tourism Office.`);
            const title = await spotTitle(booking.spotId);
            const checkout = await openCheckout(req, {
                kind: 'guide_booking', bookingId: booking._id, amount,
                name: `Tourist guide · ${title}`.slice(0, 120),
                description: `${booking.reference} · ${dayOf(booking.preferredDate)} ${booking.preferredTime} · ${booking.visitors} visitor${booking.visitors === 1 ? '' : 's'}`
            });
            return res.status(201).json({ success: true, checkoutUrl: checkout.checkoutUrl, checkoutId: checkout._id });
        } catch (error) {
            return failure(res, error, '❌ Booking checkout failure:');
        }
    });

    /* PUBLIC: does this attraction sell tickets online? */
    router.get('/tickets/offer/:spotId', async (req, res) => {
        try {
            const offer = await ticketOffer(req.params.spotId);
            const available = offer.available && gatewayState().online;
            res.json({
                available,
                unitFee: offer.unitFee || 0,
                maxPeople: MAX_TICKET_PEOPLE,
                daysAhead: TICKET_DAYS_AHEAD,
                minAmount: MIN_ONLINE_AMOUNT,
                testMode: true,
                // What each kind of visitor pays (null: not offered here).
                fees: available ? attractions.feeTable(offer.spot) : null,
                // Which days can be chosen: open weekdays, less closed dates.
                ...(available ? await attractions.visitCalendar(offer.spot, TICKET_DAYS_AHEAD + 1) : {})
            });
        } catch (error) {
            return failure(res, error, '❌ Ticket offer failure:');
        }
    });

    /* PUBLIC: buy entrance tickets. The ticket exists unpaid until the gateway
       says it is paid; only then does it get anybody in. */
    router.post('/tickets', checkoutLimit, async (req, res) => {
        try {
            if (!gatewayState().online) return fail(res, 409, 'Online tickets are not available right now. Entrance fees are paid at the gate.');
            const body = req.body || {};
            const offer = await ticketOffer(body.spotId);
            if (!offer.available) return fail(res, 404, 'This attraction does not sell tickets online.');
            const fullName = String(body.fullName || '').trim();
            const email = String(body.email || '').trim().toLowerCase();
            const contactNumber = String(body.contactNumber || '').trim();
            const visitDate = String(body.visitDate || '').trim();
            const today = manilaToday();

            if (!fullName) return fail(res, 400, 'Please give the name the tickets are under.');
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'Please give a valid email address.');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) return fail(res, 400, 'Please choose the date of your visit.');
            if (visitDate < today) return fail(res, 400, 'That date has already passed.');
            if (visitDate > addDays(today, TICKET_DAYS_AHEAD)) return fail(res, 400, `Tickets can be bought up to ${TICKET_DAYS_AHEAD} days ahead.`);
            // How many of each kind, priced here from the fees on record. A
            // request that only says how many people is all at the regular price.
            const counts = body.counts && typeof body.counts === 'object' ? body.counts : { regular: body.people };
            const priced = attractions.priceTickets(offer.spot, counts, { maxPeople: MAX_TICKET_PEOPLE });
            const people = priced.people;
            const day = await attractions.dayVerdict(offer.spot, visitDate);
            if (!day.open) return fail(res, 409, day.reason);
            const amount = priced.amount;
            if (amount < MIN_ONLINE_AMOUNT) return fail(res, 400, `Online payments start at ₱${MIN_ONLINE_AMOUNT}. Add a person, or pay at the gate.`);

            let ticket = null;
            for (let attempt = 0; attempt < 5 && !ticket; attempt++) {
                try {
                    ticket = await Ticket.create({
                        code: newTicketCode(offer.spot.title), spotId: offer.spot._id, visitDate, people,
                        unitFee: offer.unitFee, amount, fullName, email, contactNumber, isDemo: true,
                        countRegular: priced.counts.regular, countSenior: priced.counts.senior, countPwd: priced.counts.pwd,
                        countStudent: priced.counts.student, countChild: priced.counts.child, feeBreakdown: priced.unitFees
                    });
                } catch (error) {
                    if (error && error.code === 11000) continue;
                    throw error;
                }
            }
            if (!ticket) return fail(res, 503, 'The system is busy. Please try again in a moment.');

            const checkout = await openCheckout(req, {
                kind: 'ticket', ticketId: ticket._id, amount,
                name: `Entrance · ${offer.spot.title}`.slice(0, 120),
                description: `${visitDate} · ${attractions.describeKinds(ticket)}`
            });
            return res.status(201).json({ success: true, checkoutUrl: checkout.checkoutUrl, checkoutId: checkout._id });
        } catch (error) {
            return failure(res, error, '❌ Ticket purchase failure:');
        }
    });

    /* PUBLIC: where the gateway sends the visitor back. The checkout id is a
       random 24-character id, known only to whoever started the payment. */
    router.get('/payments/checkout/:id', async (req, res) => {
        try {
            if (!/^[0-9a-f]{24}$/.test(req.params.id)) return fail(res, 404, 'That payment could not be found.');
            let checkout = await Checkout.findById(req.params.id);
            if (!checkout) return fail(res, 404, 'That payment could not be found.');
            try { checkout = await settle(checkout); } catch (error) { /* the page asks again */ }
            return res.json({ success: true, checkout: await checkoutView(checkout) });
        } catch (error) {
            return failure(res, error, '❌ Checkout status failure:');
        }
    });

    /* PUBLIC: Xendit's callback that an invoice changed. It must carry the
       account's verification token (X-CALLBACK-TOKEN), and even then its body
       is only a hint: the checkout it names is settled by asking Xendit
       directly, so a forged or replayed callback can record nothing. Unknown
       invoices — Xendit's own "test" callback among them — get a plain 200. */
    router.post('/payments/webhook', async (req, res) => {
        try {
            if (!String(process.env.XENDIT_CALLBACK_TOKEN || '').trim() || !gatewayState().online) return res.status(404).end();
            if (!callbackTokenMatches(req.get('x-callback-token'))) return res.status(401).end();

            const body = req.body || {};
            const invoiceId = typeof body.id === 'string' ? body.id : '';
            const externalId = typeof body.external_id === 'string' ? body.external_id : '';
            const match = /^ztims-([0-9a-f]{24})$/.exec(externalId);
            if (!invoiceId || !match) return res.status(200).json({ ignored: true });
            const checkout = await Checkout.findById(match[1]);
            if (!checkout || checkout.sessionId !== invoiceId) return res.status(200).json({ ignored: true });
            await settle(checkout, { lateToo: true });
            return res.status(200).json({ received: true });
        } catch (error) {
            // A non-2xx makes Xendit try again later, which is what we want
            // when the gateway or the database was briefly unreachable.
            console.error('❌ Payment webhook failure:', error && error.message);
            return res.status(500).end();
        }
    });

    /* ---- the Tourism Office ------------------------------------------------ */

    router.get('/payments', requireAdmin, async (req, res) => {
        try {
            const { from, to } = rangeFrom(req.query);
            const list = await listPayments(from, to);
            const duplicates = (await query(
                `select c.id, c.kind, c.amount, c.method, c.payment_ref, c.paid_at, b.reference, t.code
                   from online_checkouts c left join guide_bookings b on b.id = c.booking_id left join tickets t on t.id = c.ticket_id
                  where c.status = 'duplicate' order by c.paid_at desc limit 50`)).rows;
            const demo = (await query(`select
                    (select count(*) from guide_bookings where is_demo)::int as bookings,
                    (select count(*) from tickets where is_demo)::int as tickets,
                    (select count(*) from payments where is_demo)::int as payments`)).rows[0];
            res.json({ from, to, gateway: gatewayState(), summary: summarise(list), payments: list, duplicates, demo });
        } catch (error) {
            return failure(res, error, '❌ Collections failure:');
        }
    });

    router.patch('/payments/:id/receipt', requireAdmin, async (req, res) => {
        try {
            const payment = await Payment.findById(req.params.id);
            if (!payment) return fail(res, 404, 'That payment could not be found.');
            payment.receiptNumber = String((req.body && req.body.receiptNumber) || '').trim().slice(0, 40);
            await Payment.save(payment);
            res.json({ success: true, message: payment.receiptNumber ? `OR ${payment.receiptNumber} recorded.` : 'OR number cleared.', payment });
        } catch (error) {
            return failure(res, error, '❌ Receipt number failure:');
        }
    });

    /* The office cancels, the visitor is refunded: the one refund rule. */
    router.post('/payments/:id/refund', requireAdmin, async (req, res) => {
        try {
            const reason = String((req.body && req.body.reason) || '').trim();
            if (!reason) return fail(res, 400, 'Give the reason for the refund, for example "bad weather".');
            const payment = await refund(req.params.id, reason.slice(0, 300), await officerEmail(req));
            res.json({ success: true, message: `₱${money(payment.amount).toLocaleString('en-PH')} refunded. The booking or ticket is cancelled.`, payment });
        } catch (error) {
            return failure(res, error, '❌ Refund failure:');
        }
    });

    router.get('/payments/export.xlsx', requireAdmin, async (req, res) => {
        try {
            const { from, to } = rangeFrom(req.query);
            const list = await listPayments(from, to);
            const wb = new ExcelJS.Workbook();
            wb.creator = 'ZTIMS';
            const ws = wb.addWorksheet('Collections');
            ws.columns = [
                { header: 'Date', key: 'day', width: 12 }, { header: 'Time', key: 'time', width: 8 },
                { header: 'For', key: 'kind', width: 13 }, { header: 'Reference', key: 'reference', width: 16 },
                { header: 'Place', key: 'place', width: 26 }, { header: 'Paid by', key: 'payer', width: 22 },
                { header: 'Channel', key: 'channel', width: 9 }, { header: 'Method', key: 'method', width: 9 },
                { header: 'Amount (₱)', key: 'amount', width: 12 }, { header: 'OR number', key: 'or', width: 13 },
                { header: 'Refunded', key: 'refunded', width: 30 }, { header: 'Demo', key: 'demo', width: 7 }
            ];
            ws.getRow(1).font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
            ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003D5B' } };
            for (const p of [...list].reverse()) {
                ws.addRow({
                    day: p.day,
                    time: new Date(new Date(p.paidAt).getTime() + MANILA_OFFSET_HOURS * 3600000).toISOString().slice(11, 16),
                    kind: p.kind === 'guide_fee' ? 'Guide fee' : 'Entrance fee',
                    reference: p.reference, place: p.place, payer: p.payer,
                    channel: p.channel === 'online' ? 'Online' : 'Counter', method: p.method,
                    amount: p.amount, or: p.receiptNumber,
                    refunded: p.refundedAt ? `Yes — ${p.refundReason}` : '', demo: p.isDemo ? 'Yes' : ''
                });
            }
            const last = ws.rowCount;
            const kept = list.filter(p => !p.refundedAt).reduce((a, p) => a + p.amount, 0);
            const total = ws.addRow({ place: 'Total collected (refunds excluded)',
                amount: { formula: `SUMIFS(I2:I${last},K2:K${last},"")`, result: money(kept) } });
            total.font = { name: 'Arial', bold: true };
            ws.getColumn('amount').numFmt = '#,##0.00';
            ws.eachRow(row => row.eachCell(cell => { cell.font = { name: 'Arial', ...(cell.font || {}) }; }));
            ws.views = [{ state: 'frozen', ySplit: 1 }];
            ws.addRow({});
            ws.addRow({ day: 'Test-mode demonstration: no real money was collected.' });

            const buffer = await wb.xlsx.writeBuffer();
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="ZTIMS_Collections_${from}_to_${to}.xlsx"`);
            res.send(Buffer.from(buffer));
        } catch (error) {
            return failure(res, error, '❌ Collections export failure:');
        }
    });

    /* Demonstration data: load a realistic three months, or take it all out. */
    router.post('/payments/demo', requireAdmin, async (req, res) => {
        try {
            const made = await seedDemo(await officerEmail(req));
            res.status(201).json({ success: true, message: `Demo data loaded: ${made.bookings} guide bookings, ${made.tickets} tickets and ${made.payments} payments.`, ...made });
        } catch (error) {
            return failure(res, error, '❌ Demo data failure:');
        }
    });

    router.delete('/payments/demo', requireAdmin, async (req, res) => {
        try {
            const removed = await transaction(client => removeDemo(client));
            res.json({ success: true, message: `Demo data removed: ${removed.bookings} guide bookings, ${removed.tickets} tickets and ${removed.payments} payments.`, ...removed });
        } catch (error) {
            return failure(res, error, '❌ Demo data removal failure:');
        }
    });

    /* Tickets: the day's list, and the gate's check. */
    router.get('/tickets', requireAdmin, async (req, res) => {
        try {
            const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : manilaToday();
            const { rows } = await query(`
                select t.*, s.title as spot_title, p.id as payment_id, p.method, p.refunded_at
                  from tickets t join spots s on s.id = t.spot_id left join payments p on p.ticket_id = t.id
                 where t.visit_date = $1 and t.status <> 'pending_payment'
                 order by s.title, t.created_at`, [date]);
            res.json({
                date, today: manilaToday(),
                tickets: rows.map(r => ({
                    _id: r.id, code: r.code, spot: r.spot_title, people: r.people, amount: money(r.amount),
                    kinds: attractions.kindsOf(r), kindsText: attractions.describeKinds(r),
                    name: r.full_name, status: r.status, usedAt: r.used_at, paymentId: r.payment_id,
                    method: r.method, isDemo: r.is_demo
                }))
            });
        } catch (error) {
            return failure(res, error, '❌ Ticket list failure:');
        }
    });

    async function ticketByCode(code) {
        const wanted = normaliseCode(code);
        if (wanted.length < 5) return null;
        const { rows } = await query(`
            select t.*, s.title as spot_title from tickets t join spots s on s.id = t.spot_id
             where regexp_replace(upper(t.code), '[^A-Z0-9]', '', 'g') = $1`, [wanted]);
        return rows[0] || null;
    }

    function verdictOf(t) {
        const today = manilaToday();
        const date = dayOf(t.visit_date);
        if (t.status === 'pending_payment') return ['not_paid', 'This ticket was never paid for.'];
        if (t.status === 'cancelled') return ['cancelled', 'This ticket was cancelled and refunded.'];
        if (t.status === 'used') return ['used', 'Already used.'];
        if (date !== today) return ['wrong_date', date < today ? `This ticket was for ${date}.` : `This ticket is for ${date}, not today.`];
        // Discounted kinds show an ID at the entrance: say whose to check.
        const withId = attractions.kindsOf(t).filter(k => k.needsId);
        const idCount = withId.reduce((n, k) => n + k.count, 0);
        const idNote = idCount ? ` Check ${idCount === 1 ? 'the ID' : `${idCount} IDs`} (${withId.map(k => k.label.toLowerCase()).join(', ')}).` : '';
        return ['valid', `Valid for ${t.people} ${t.people === 1 ? 'person' : 'people'}: ${attractions.describeKinds(t)}.${idNote}`];
    }

    router.post('/tickets/check', requireAdmin, async (req, res) => {
        try {
            const t = await ticketByCode(req.body && req.body.code);
            if (!t) return res.json({ found: false, verdict: 'not_found', message: 'No ticket has that code.' });
            const [verdict, message] = verdictOf(t);
            res.json({
                found: true, verdict, message,
                ticket: { _id: t.id, code: t.code, spot: t.spot_title, visitDate: dayOf(t.visit_date), people: t.people,
                          kinds: attractions.kindsOf(t), kindsText: attractions.describeKinds(t),
                          name: t.full_name, status: t.status, usedAt: t.used_at, usedByEmail: t.used_by_email, isDemo: t.is_demo }
            });
        } catch (error) {
            return failure(res, error, '❌ Ticket check failure:');
        }
    });

    /* Lets the group in. Only a valid ticket for today, and only once: the
       update itself checks, so two phones scanning at once cannot both admit. */
    router.post('/tickets/:id/admit', requireAdmin, async (req, res) => {
        try {
            const email = await officerEmail(req);
            const { rows } = await query(`
                update tickets set status = 'used', used_at = now(), used_by_email = $2
                 where id = $1 and status = 'valid' and visit_date = $3 returning *`, [req.params.id, email, manilaToday()]);
            if (!rows[0]) return fail(res, 409, 'This ticket cannot be used now. Check it again to see why.');
            res.json({ success: true, message: `Admitted: ${rows[0].people} ${rows[0].people === 1 ? 'person' : 'people'}.` });
        } catch (error) {
            return failure(res, error, '❌ Ticket admit failure:');
        }
    });

    return router;
};

module.exports.gatewayState = gatewayState;
module.exports.DEMO_BOOKING_PREFIX = DEMO_BOOKING_PREFIX;
