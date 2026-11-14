/* Shared room-payment gateway. Development keys only; never accepts a live key. */
const crypto = require('crypto');
// XENDIT_API_BASE exists for local tests against a stand-in; leave it unset.
const gatewayApi = () => (process.env.XENDIT_API_BASE || 'https://api.xendit.co').replace(/\/+$/, '');
const CHECKOUT_MINUTES = 30;
const MIN_ONLINE_AMOUNT = 20;          // a safe floor: card payments below ₱20 are refused
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
        const e = new Error('The payment service could not be reached. Try again, or pay at the property.');
        e.status = 502;
        throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        // Xendit's error code and message only — never the request, which
        // carries the key in its header.
        console.error('❌ Xendit refused:', res.status, String(data.error_code || ''), String(data.message || '').slice(0, 200));
        const e = new Error('The payment service refused this request. Try again, or pay at the property.');
        e.status = 502;
        throw e;
    }
    return data;
}

// Xendit's channel and method codes → the short names the booking pages show.
const METHOD_NAMES = {
    GCASH: 'gcash', PAYMAYA: 'maya', GRABPAY: 'grabpay', SHOPEEPAY: 'shopeepay',
    CREDIT_CARD: 'card', CARD: 'card', QRPH: 'qrph', QR_CODE: 'qrph',
    DD_BPI: 'bank', DD_UBP: 'bank', DD_RCBC: 'bank', DD_CHINABANK: 'bank', BPI: 'bank', UBP: 'bank',
    RCBC: 'bank', CHINABANK: 'bank', DIRECT_DEBIT: 'bank', BANK_TRANSFER: 'bank',
    OTC: 'otc', OVER_THE_COUNTER: 'otc', '7ELEVEN': 'otc', CEBUANA: 'otc', ECPAY: 'otc', PALAWAN: 'otc', MLHUILLIER: 'otc'
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

function siteOrigin(req) {
    const configured = String(process.env.PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
    return configured || `${req.protocol}://${req.get('host')}`;
}

module.exports={gateway,gatewayState,callbackTokenMatches,METHODS,methodOf,isGatewayPage,MIN_ONLINE_AMOUNT,CHECKOUT_MINUTES,siteOrigin};
