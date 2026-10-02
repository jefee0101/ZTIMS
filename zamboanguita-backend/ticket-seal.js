/* Sealed tickets — a QR code a phone can check with no signal at all.
 *
 * The QR holds the ticket's facts (code, attraction, date, people by kind) and
 * an ECDSA P-256 signature over them, made with a private key only this server
 * has (TICKET_SEAL_KEY). The officer's offline gate page carries the matching
 * PUBLIC key, which can check a seal but never make one, so a forged or edited
 * QR fails the check without asking the server. P-256 because every phone
 * browser's WebCrypto verifies it; the signature is the 64-byte raw r||s that
 * WebCrypto expects (Node's 'ieee-p1363' encoding).
 *
 *     ZT1.<payload, base64url JSON>.<signature, base64url>
 *     payload: { c: code, s: spot id, d: 'YYYY-MM-DD', k: [regular, senior, pwd, student, child] }
 *
 * The date is sealed in, so moving a ticket issues a new QR. What a seal cannot
 * say is that a ticket was cancelled or used since — that is what the gate list
 * downloaded before going out, and syncing afterwards, are for.
 *
 * TICKET_SEAL_KEY is a base64 PKCS#8 P-256 private key (`npm run seal-key` makes
 * one). Unset, tickets carry their plain code, as before, and the offline check
 * says it is not set up. The key must stay the same across deploys: changing it
 * invalidates every sealed QR already sent.
 */
const crypto = require('crypto');

const PREFIX = 'ZT1';
const KINDS = ['countRegular', 'countSenior', 'countPwd', 'countStudent', 'countChild'];

let cached;   // { privateKey, publicJwk } or null
function keys() {
    if (cached !== undefined) return cached;
    const raw = String(process.env.TICKET_SEAL_KEY || '').trim();
    if (!raw) return (cached = null);
    try {
        const privateKey = crypto.createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
        if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails.namedCurve !== 'prime256v1') {
            throw new Error('not a P-256 key');
        }
        const { kty, crv, x, y } = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
        cached = { privateKey, publicJwk: { kty, crv, x, y } };
    } catch (error) {
        console.error('❌ TICKET_SEAL_KEY is not a usable P-256 private key; tickets are not sealed:', error.message);
        cached = null;
    }
    return cached;
}

const sealConfigured = () => Boolean(keys());
const publicKey = () => (keys() ? keys().publicJwk : null);

const b64url = buffer => Buffer.from(buffer).toString('base64url');

/* What goes in a ticket's QR: the sealed token, or the plain code when sealing
   is not set up. `ticket` is the model (camelCase) or a raw row. */
function qrContent(ticket) {
    const k = keys();
    if (!k) return ticket.code;
    const payload = {
        c: ticket.code,
        s: String(ticket.spotId ?? ticket.spot_id),
        d: String(ticket.visitDate ?? ticket.visit_date).slice(0, 10),
        k: KINDS.map(f => Number(ticket[f] ?? ticket[f.replace(/[A-Z]/g, m => '_' + m.toLowerCase())] ?? 0))
    };
    const body = b64url(JSON.stringify(payload));
    const signature = crypto.sign('sha256', Buffer.from(`${PREFIX}.${body}`), { key: k.privateKey, dsaEncoding: 'ieee-p1363' });
    return `${PREFIX}.${body}.${b64url(signature)}`;
}

/* A scanned QR or typed text: the ticket code it names, or null. A sealed one is
   believed only if its signature checks out. */
function codeFrom(text) {
    const value = String(text || '').trim();
    if (!value.startsWith(`${PREFIX}.`)) return value;          // a plain code, typed or from an older QR
    const k = keys();
    const parts = value.split('.');
    if (!k || parts.length !== 3) return null;
    const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`),
        { key: crypto.createPublicKey(k.privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'));
    if (!ok) return null;
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).c || null; } catch (e) { return null; }
}

/* A fresh key, printed as the line to put in the environment. */
function newKeyLine() {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return `TICKET_SEAL_KEY=${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')}`;
}

module.exports = { sealConfigured, publicKey, qrContent, codeFrom, newKeyLine, PREFIX };

if (require.main === module) console.log(newKeyLine());
