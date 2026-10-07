/* Emails to visitors — receipts and notices about their own ticket or booking,
 * never anything else (no newsletters, no marketing).
 *
 * Sent from the office's Gmail with an App Password (MAIL_USER, MAIL_PASSWORD),
 * the same account the staff password reset uses. Without them nothing is
 * sent and everything else still works: an email is a courtesy, never the
 * record. Sending never throws and never holds a request for long — a mail
 * server that is slow or refuses is logged and the visitor's purchase stands.
 *
 * MAIL_TRANSPORT=file:/path exists for local tests: messages are appended to
 * that file as JSON lines instead of being sent. Leave it unset.
 */
const nodemailer = require('nodemailer');
const fs = require('fs');

const SEND_TIMEOUT_MS = 8000;

let transport = null;
function mailTransport() {
    if (transport) return transport;
    const testFile = String(process.env.MAIL_TRANSPORT || '').startsWith('file:') ? process.env.MAIL_TRANSPORT.slice(5) : '';
    if (testFile) {
        transport = {
            sendMail: async message => {
                fs.appendFileSync(testFile, JSON.stringify({
                    to: message.to, subject: message.subject, text: message.text,
                    attachments: (message.attachments || []).map(a => a.filename)
                }) + '\n');
                return { messageId: 'test' };
            }
        };
    } else if (process.env.MAIL_USER && process.env.MAIL_PASSWORD) {
        transport = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASSWORD }
        });
    }
    return transport;
}

function mailConfigured() {
    return Boolean(mailTransport());
}

/* Sends one email. Resolves { sent: true } or { sent: false, reason } — never
   rejects, so no caller has to guard it. */
async function sendMail({ to, subject, text, html, attachments }) {
    const t = mailTransport();
    if (!t) return { sent: false, reason: 'not_configured' };
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to))) return { sent: false, reason: 'no_address' };
    try {
        await Promise.race([
            t.sendMail({
                from: `"Zamboanguita Tourism" <${process.env.MAIL_USER || 'no-reply@ztims.local'}>`,
                to, subject, text, html, attachments
            }),
            new Promise((resolve, reject) => setTimeout(() => reject(new Error('timed out')), SEND_TIMEOUT_MS))
        ]);
        return { sent: true };
    } catch (error) {
        // The address and the reason only: never the message, which may carry a code.
        console.error(`❌ Email to ${String(to).replace(/^(.).*(@.*)$/, '$1…$2')} not sent:`, error && error.message);
        return { sent: false, reason: 'failed' };
    }
}

/* ---------------------------------------------------------------- wording */

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const pesos = n => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function niceDate(dateKey) {
    return new Date(`${String(dateKey).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-PH', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
    });
}

const FOOTER = 'Municipal Tourism Office, Municipal Hall, Poblacion, Zamboanguita, Negros Oriental.\n'
    + 'You are getting this because this email address was given for this ticket or booking. We send nothing else.';

/* One email from labelled lines: plain text, and a simple HTML version of the
   same, so it reads well in any mail app. */
function compose({ heading, intro, rows = [], paragraphs = [], link, qrCid, footer = FOOTER }) {
    const text = [
        heading, '', intro, '',
        ...rows.map(([label, value]) => `${label}: ${value}`),
        ...(rows.length ? [''] : []),
        ...paragraphs.flatMap(p => [p, '']),
        ...(link ? [`${link.label}: ${link.url}`, ''] : []),
        '—', footer
    ].join('\n');
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#17212B;line-height:1.5">
        <h2 style="margin:0 0 8px;color:#003D5B">${escapeHtml(heading)}</h2>
        <p>${escapeHtml(intro)}</p>
        ${qrCid ? `<p style="text-align:center"><img src="cid:${qrCid}" alt="Ticket QR code" width="200" height="200"/></p>` : ''}
        ${rows.length ? `<table style="border-collapse:collapse;width:100%">${rows.map(([label, value]) =>
            `<tr><td style="padding:6px 8px;border-bottom:1px solid #e3e8ee;color:#566;width:40%">${escapeHtml(label)}</td>
                 <td style="padding:6px 8px;border-bottom:1px solid #e3e8ee;font-weight:bold">${escapeHtml(value)}</td></tr>`).join('')}</table>` : ''}
        ${paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('')}
        ${link ? `<p><a href="${escapeHtml(link.url)}" style="display:inline-block;background:#30638E;color:#fff;padding:10px 16px;text-decoration:none;font-weight:bold">${escapeHtml(link.label)}</a></p>` : ''}
        <p style="color:#667;font-size:12px;border-top:1px solid #e3e8ee;padding-top:8px">${escapeHtml(footer).replace(/\n/g, '<br>')}</p>
    </div>`;
    return { text, html };
}

module.exports = { sendMail, mailConfigured, compose, niceDate, pesos };
