/* Room booking for private places to stay (decided 8 November 2026).
 *
 * A visitor asks for rooms at a resort; the resort's Enterprise Manager
 * confirms or declines by hand. The rules (see the notes repo's "Booking
 * system proposal"):
 *   - No visitor accounts: a booking is managed with its code AND the email,
 *     like a ticket (manage.js).
 *   - ZTIMS never holds the money. The guest pays the resort as its payment
 *     instructions say; the manager may record what was received.
 *   - A request holds its rooms until the resort's response time runs out;
 *     unanswered, it expires and the rooms are free again. The manager gets a
 *     reminder halfway through.
 *   - The server works out every price from the room types; the page's figure
 *     is never believed. A booking keeps the rates it was made at. The manager
 *     may adjust one request's total before confirming, with a reason.
 *   - Rooms are never overbooked: a request locks its room types' rows and
 *     counts again inside the same transaction.
 *   - Nothing is deleted. Every change is a booking_changes row (never a
 *     guest's name, email or phone in it), and privacy.js erases the guest's
 *     details a year after check-out.
 *   - A booking is not a count: a guest is counted only through the Guest
 *     Register entry the manager saves at check-in.
 *   - The Tourism Officer sees counts per enterprise and can pause one; no
 *     prices or money.
 *
 * Mounted at /api by server.js, which hands over its sign-in checks, the
 * shared rate limiter, the public-visibility rule and the photo source check.
 */
const express = require('express');
const crypto = require('crypto');
const { query, transaction } = require('./db');
const { spots: Spot, BOOKING_PAYMENT_METHODS } = require('./models');
const notices = require('./notices');

const MANILA_OFFSET_HOURS = 8;
const MAX_ROOM_LINES = 10;
const ZTIMS = 'ZTIMS';
const HOLDING = `(b.status in ('confirmed', 'checked_in') or (b.status = 'requested' and b.expires_at > now()))`;

const money = n => Math.round(Number(n) * 100) / 100;
const manilaToday = () => new Date(Date.now() + MANILA_OFFSET_HOURS * 3600 * 1000).toISOString().slice(0, 10);
const isDateKey = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function addDays(dateKey, n) {
    const d = new Date(`${dateKey}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
const daysBetween = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
const isId = value => /^[0-9a-f]{24}$/i.test(String(value || ''));
const looksLikeEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const wholeNumber = (value, min, max) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const hhmm = value => String(value || '').slice(0, 5);

function problem(status, message) {
    return Object.assign(new Error(message), { status });
}

/* ------------------------------------------------------------------ codes */

// Like ticket codes: no letters or digits that read alike (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const randomCode = length => Array.from(crypto.randomBytes(length), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
function codePrefix(title) {
    const words = String(title || '').toUpperCase().split(/\s+/).map(w => w.replace(/[^A-Z]/g, '')).filter(Boolean);
    return (words.slice(0, 2).map(w => w[0]).join('') + 'XX').slice(0, 2);
}
const newBookingCode = title => `${codePrefix(title)}-${randomCode(6)}`;
const normaliseCode = code => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* --------------------------------------------------------------- settings */

const DEFAULTS = {
    accepts_bookings: false, paused_by_office: false, response_hours: 24, check_in_time: '14:00', check_out_time: '12:00',
    min_nights: 1, max_nights: 14, advance_days: 180, free_cancel_days: 2, payment_instructions: '', updated_at: null
};

function shapeSettings(row) {
    const r = { ...DEFAULTS, ...(row || {}) };
    return {
        acceptsBookings: r.accepts_bookings, pausedByOffice: r.paused_by_office,
        open: Boolean(r.accepts_bookings && !r.paused_by_office),
        responseHours: r.response_hours, checkInTime: hhmm(r.check_in_time), checkOutTime: hhmm(r.check_out_time),
        minNights: r.min_nights, maxNights: r.max_nights, advanceDays: r.advance_days, freeCancelDays: r.free_cancel_days,
        paymentInstructions: r.payment_instructions, updatedAt: r.updated_at
    };
}

async function settingsFor(spotId, client) {
    const { rows } = await query('select * from enterprise_booking_settings where spot_id = $1', [spotId], client);
    return shapeSettings(rows[0]);
}

/* A stay's dates against the resort's rules. Returns the nights. */
function checkStay(settings, checkIn, checkOut) {
    if (!isDateKey(checkIn) || !isDateKey(checkOut)) throw problem(400, 'Choose the check-in and check-out dates.');
    const today = manilaToday();
    if (checkIn < today) throw problem(400, 'The check-in date has already passed.');
    if (checkIn > addDays(today, settings.advanceDays)) {
        throw problem(400, `This place takes bookings up to ${settings.advanceDays} days ahead.`);
    }
    const nights = daysBetween(checkIn, checkOut);
    if (nights < 1) throw problem(400, 'Check-out must be after check-in.');
    if (nights < settings.minNights) throw problem(400, `The shortest stay here is ${settings.minNights} night${settings.minNights === 1 ? '' : 's'}.`);
    if (nights > settings.maxNights) throw problem(400, `The longest stay here is ${settings.maxNights} nights.`);
    return nights;
}

/* --------------------------------------------------------------- the rooms */

/* Each room type of a place with how many rooms are free on every night of
   the stay: its units, less the rooms held by bookings (requested and not yet
   expired, confirmed, checked in), less blocked rooms. `exclude` leaves one
   booking out (when it is being moved). */
async function freeRooms(spotId, checkIn, checkOut, { client, exclude = '', activeOnly = true } = {}) {
    const { rows } = await query(`
        with nights as (
            select d::date as night from generate_series($2::date, $3::date - 1, interval '1 day') d)
        select rt.id, rt.name, rt.description, rt.beds, rt.max_guests, rt.base_rate, rt.units, rt.photo_url, rt.active, rt.position,
               greatest(0, min(rt.units - coalesce(held.units, 0) - coalesce(blocked.units, 0)))::int as free
          from room_types rt
         cross join nights n
          left join lateral (
                select sum(br.units) as units
                  from booking_rooms br join bookings b on b.id = br.booking_id
                 where br.room_type_id = rt.id and b.check_in <= n.night and b.check_out > n.night
                   and b.id <> $4 and ${HOLDING}) held on true
          left join lateral (
                select sum(k.units) as units from room_blocks k
                 where k.room_type_id = rt.id and k.starts_on <= n.night and k.ends_on >= n.night) blocked on true
         where rt.spot_id = $1 ${activeOnly ? 'and rt.active' : ''}
         group by rt.id
         order by rt.position, rt.name`, [spotId, checkIn, checkOut, exclude], client);
    return rows;
}

const shapeRoom = r => ({
    _id: r.id, name: r.name, description: r.description, beds: r.beds, maxGuests: r.max_guests,
    rate: money(r.base_rate), units: r.units, photoUrl: r.photo_url, active: r.active, position: r.position
});

/* ---------------------------------------------------------------- bookings */

async function bookingRooms(bookingId, client) {
    const { rows } = await query(`
        select br.room_type_id, br.units, br.rate_per_night, rt.name
          from booking_rooms br join room_types rt on rt.id = br.room_type_id
         where br.booking_id = $1 order by rt.position, rt.name`, [bookingId], client);
    return rows.map(r => ({ roomTypeId: r.room_type_id, name: r.name, units: r.units, ratePerNight: money(r.rate_per_night) }));
}

async function bookingRow(id, client, { lock = false } = {}) {
    const { rows } = await query(`select * from bookings where id = $1${lock ? ' for update' : ''}`, [id], client);
    return rows[0] || null;
}

async function logChange(client, bookingId, action, before, after, byEmail) {
    await query('insert into booking_changes (booking_id, action, before, after, by_email) values ($1, $2, $3, $4, $5)',
        [bookingId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, byEmail || ''], client);
}

/* What the change log keeps of a booking: never the guest's details. */
const snapshot = b => b && ({
    status: b.status, checkIn: b.check_in, checkOut: b.check_out, adults: b.adults, children: b.children,
    totalAmount: money(b.total_amount), expiresAt: b.expires_at
});

/* Locks the room types a stay needs, counts again, and refuses any shortfall.
   Every booking write that takes rooms goes through here, inside its own
   transaction, so two requests for the last room cannot both have it. */
async function holdRooms(client, spotId, lines, checkIn, checkOut, exclude = '') {
    const ids = [...new Set(lines.map(l => l.roomTypeId))].sort();
    const { rows: locked } = await query(
        'select id from room_types where id = any($1) and spot_id = $2 and active order by id for update', [ids, spotId], client);
    if (locked.length !== ids.length) throw problem(400, 'One of those rooms is not offered here any more. Choose again.');
    const free = new Map((await freeRooms(spotId, checkIn, checkOut, { client, exclude })).map(r => [r.id, r]));
    for (const line of lines) {
        const room = free.get(line.roomTypeId);
        if (!room || room.free < line.units) {
            const left = room ? room.free : 0;
            throw problem(409, left
                ? `Only ${left} ${room.name} room${left === 1 ? ' is' : 's are'} free for those dates. Choose again.`
                : `${room ? room.name : 'That room'} is fully booked for those dates. Choose other rooms or dates.`);
        }
    }
    return free;
}

/* --------------------------------------------------------------- the sweep */

/* Reminds the manager halfway through a request's response time, and expires
   what was not answered in time (its rooms are free again). Run by the daily
   cron and, at most once a minute per instance, before anything reads
   bookings, so nothing waits for the cron. Running it twice changes nothing. */
async function sweepBookings(origin) {
    const reminded = await query(`
        update bookings set reminder_sent_at = now()
         where status = 'requested' and reminder_sent_at is null and expires_at > now()
           and now() >= requested_at + (expires_at - requested_at) / 2
        returning id`);
    for (const r of reminded.rows) await notices.bookingReminder(r.id, origin);

    const expired = await transaction(async client => {
        const { rows } = await query(`
            update bookings set status = 'expired', decided_at = now(), decided_by_email = $1
             where status = 'requested' and expires_at <= now()
            returning *`, [ZTIMS], client);
        for (const b of rows) await logChange(client, b.id, 'expired', { status: 'requested' }, snapshot(b), ZTIMS);
        return rows;
    });
    for (const b of expired) await notices.bookingExpired(b.id, origin);
    if (reminded.rowCount || expired.length) {
        console.log(`🛏️  Bookings: ${reminded.rowCount} reminder(s) sent, ${expired.length} request(s) expired.`);
    }
    return { reminded: reminded.rowCount, expired: expired.length };
}

let lastSweep = 0;
async function sweepIfDue(origin) {
    if (Date.now() - lastSweep < 60 * 1000) return;
    lastSweep = Date.now();
    try { await sweepBookings(origin); } catch (error) { console.error('❌ Booking sweep failure:', error); }
}

/* --------------------------------------------------------- visitor (manage) */

async function findBooking(code, email) {
    const wanted = normaliseCode(code);
    const address = String(email || '').trim().toLowerCase();
    if (wanted.length < 5 || !address) return null;
    const { rows } = await query(
        `select * from bookings where regexp_replace(upper(code), '[^A-Z0-9]', '', 'g') = $1 and email = $2`, [wanted, address]);
    return rows[0] || null;
}

/* Changes close at 11:59 PM Manila time, the resort's free-cancel days before
   check-in (at least the day before). */
function changeWindow(checkIn, freeCancelDays) {
    const lastDay = addDays(String(checkIn).slice(0, 10), -Math.max(1, freeCancelDays));
    return { lastDay, open: manilaToday() <= lastDay };
}

async function describeForVisitor(b) {
    const spot = await Spot.findById(b.spot_id);
    const settings = await settingsFor(b.spot_id);
    const window = changeWindow(b.check_in, settings.freeCancelDays);
    const live = ['requested', 'confirmed'].includes(b.status);
    const why = b.status === 'checked_in' || b.status === 'completed' ? 'This stay has started, so it can no longer be changed here.'
        : b.status === 'declined' ? 'The resort declined this request.'
        : b.status === 'expired' ? 'The resort did not answer in time, so this request expired.'
        : b.status === 'cancelled' ? 'This booking is cancelled.'
        : b.status === 'no_show' ? 'This booking was marked as a no-show.'
        : !window.open ? 'Changes have closed. Contact the resort.' : '';
    return {
        kind: 'booking',
        code: b.code, status: b.status, name: b.guest_name,
        spot: spot ? { _id: spot._id, title: spot.title } : null,
        enterpriseName: spot ? (spot.enterpriseName || spot.title) : '',
        checkIn: b.check_in, checkOut: b.check_out, nights: b.nights, adults: b.adults, children: b.children,
        rooms: await bookingRooms(b.id), totalAmount: money(b.total_amount),
        expiresAt: b.status === 'requested' ? b.expires_at : null, declineReason: b.decline_reason,
        checkInTime: settings.checkInTime, checkOutTime: settings.checkOutTime,
        // The resort's payment instructions, once it has accepted the stay.
        paymentInstructions: ['confirmed', 'checked_in'].includes(b.status) ? settings.paymentInstructions : '',
        changeUntil: window.lastDay, today: manilaToday(),
        // The resort's limits, for the new-dates pickers (the server checks them again).
        minNights: settings.minNights, maxNights: settings.maxNights, lastCheckIn: addDays(manilaToday(), settings.advanceDays),
        canMove: live && window.open && settings.open, canCancel: live && window.open,
        why: why || (live && window.open && !settings.open ? 'The resort is not taking bookings right now, so the dates cannot be moved. You can still cancel.' : '')
    };
}

/* New dates, the same rooms at the same rates; back to Requested for the
   resort to confirm again. */
async function visitorMove(found, body, origin) {
    const checkIn = String((body && body.checkIn) || '').trim();
    const checkOut = String((body && body.checkOut) || '').trim();
    const view = await describeForVisitor(found);
    if (!view.canMove) throw problem(409, view.why || 'This booking can no longer be moved.');
    if (checkIn === found.check_in && checkOut === found.check_out) throw problem(400, 'Those are already the booking\'s dates.');
    const settings = await settingsFor(found.spot_id);
    const nights = checkStay(settings, checkIn, checkOut);
    await transaction(async client => {
        const b = await bookingRow(found.id, client, { lock: true });
        if (!b || !['requested', 'confirmed'].includes(b.status)) throw problem(409, 'This booking changed just now. Look it up again.');
        const lines = (await bookingRooms(b.id, client)).map(r => ({ roomTypeId: r.roomTypeId, units: r.units, rate: r.ratePerNight }));
        await holdRooms(client, b.spot_id, lines, checkIn, checkOut, b.id);
        const total = money(lines.reduce((sum, l) => sum + l.units * l.rate * nights, 0));
        const { rows } = await query(`
            update bookings set check_in = $2, check_out = $3, total_amount = $4, status = 'requested',
                   requested_at = now(), expires_at = now() + make_interval(hours => $5), reminder_sent_at = null,
                   decided_by_email = '', decided_at = null
             where id = $1 returning *`, [b.id, checkIn, checkOut, total, settings.responseHours], client);
        await logChange(client, b.id, 'moved', snapshot(b), snapshot(rows[0]), 'the guest (Manage page)');
    });
    const toGuest = await notices.bookingMoved(found.id, { from: found.check_in, to: found.check_out }, origin);
    await notices.bookingNewRequest(found.id, origin, { moved: true });
    return { emailed: toGuest.sent };
}

async function visitorCancel(found, origin) {
    const view = await describeForVisitor(found);
    if (!view.canCancel) throw problem(409, view.why || 'This booking can no longer be cancelled.');
    await transaction(async client => {
        const { rows } = await query(`
            update bookings set status = 'cancelled', decided_at = now(), decided_by_email = $2
             where id = $1 and status in ('requested', 'confirmed') returning *`, [found.id, 'the guest (Manage page)'], client);
        if (!rows.length) throw problem(409, 'This booking changed just now. Look it up again.');
        await logChange(client, found.id, 'cancelled', { status: found.status }, snapshot(rows[0]), 'the guest (Manage page)');
    });
    const told = await notices.bookingCancelled(found.id, { byGuest: true }, origin);
    return { emailed: told.sent };
}

/* ------------------------------------------------------------------ router */

module.exports = function bookingsRouter({ requireAdmin, requireEstablishmentManager, sharedRateLimit, isPubliclyVisible, siteOrigin, checkPhotoSources }) {
    const router = express.Router();
    const requestLimit = sharedRateLimit('booking-request', {
        windowMs: 60 * 60 * 1000,
        limit: 10,
        message: { success: false, message: 'Too many booking requests from this connection. Please wait a while, or contact the resort.' }
    });

    const fail = (res, error, label) => {
        if (error && error.status) return res.status(error.status).json({ success: false, message: error.message });
        if (error && error.name === 'ValidationError') return res.status(400).json({ success: false, message: error.message });
        console.error(label, error);
        return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    };

    /* A private place to stay that is on the public site. */
    async function publicResort(spotId) {
        if (!isId(spotId)) return null;
        const spot = await Spot.findByIdWithManager(spotId);
        if (!spot || spot.type !== 'accommodation' || !spot.managedBy || !isPubliclyVisible(spot)) return null;
        return spot;
    }

    /* ---- public ------------------------------------------------------ */

    /* The countries a guest can say they live in: Form A4's rows, which the
       Guest Register counts by, worded for a visitor. The Philippines first. */
    const VISITOR_COUNTRY = {
        'ph-filipino': 'Philippines (Filipino)',
        'ph-foreign': 'Philippines (foreign national living here)',
        'overseas-filipino': 'Overseas Filipino (living abroad)',
        'other-foreign': 'Another country',
        unspecified: 'Prefer not to say'
    };
    router.get('/rooms/countries', async (req, res) => {
        try {
            const { rows } = await query('select code, name, section from residences order by sort_order');
            const first = ['ph-filipino', 'ph-foreign', 'overseas-filipino'];
            const last = ['other-foreign', 'unspecified'];
            const named = rows.map(r => ({ code: r.code, name: VISITOR_COUNTRY[r.code] || r.name }));
            const countries = named.filter(r => !first.includes(r.code) && !last.includes(r.code)).sort((a, b) => a.name.localeCompare(b.name));
            res.set('Cache-Control', 'public, max-age=86400');
            return res.json([
                ...first.map(c => named.find(r => r.code === c)).filter(Boolean),
                ...countries,
                ...last.map(c => named.find(r => r.code === c)).filter(Boolean)
            ]);
        } catch (error) { return fail(res, error, '❌ Countries read failure:'); }
    });

    /* The places to stay taking bookings now (open, with a room to book), for
       Home's cards to offer Book a room. Ids only. */
    router.get('/rooms/open', async (req, res) => {
        try {
            const { rows } = await query(`
                select s.id from spots s
                  join establishment_managers m on m.id = s.managed_by
                  join enterprise_booking_settings es on es.spot_id = s.id
                 where s.type = 'accommodation' and s.status = 'published'
                   and m.active and coalesce(m.operational_status, '') not in ('inactive', 'closed')
                   and es.accepts_bookings and not es.paused_by_office
                   and exists (select 1 from room_types rt where rt.spot_id = s.id and rt.active)`);
            res.set('Cache-Control', 'public, max-age=60');
            return res.json(rows.map(r => r.id));
        } catch (error) { return fail(res, error, '❌ Open places read failure:'); }
    });

    /* What a resort offers: whether it takes bookings, its rules and rooms. */
    router.get('/rooms/:spotId', async (req, res) => {
        try {
            const spot = await publicResort(req.params.spotId);
            if (!spot) return res.status(404).json({ success: false, message: 'This place does not take bookings here.' });
            const settings = await settingsFor(spot._id);
            const { rows } = await query('select * from room_types where spot_id = $1 and active order by position, name', [spot._id]);
            res.set('Cache-Control', 'public, max-age=60');
            return res.json({
                spot: { _id: spot._id, title: spot.title, enterpriseName: spot.enterpriseName || spot.title },
                open: settings.open && rows.length > 0,
                rules: {
                    checkInTime: settings.checkInTime, checkOutTime: settings.checkOutTime, minNights: settings.minNights,
                    maxNights: settings.maxNights, advanceDays: settings.advanceDays, freeCancelDays: settings.freeCancelDays,
                    responseHours: settings.responseHours
                },
                rooms: rows.map(shapeRoom).map(({ active, units, position, ...room }) => room)
            });
        } catch (error) { return fail(res, error, '❌ Rooms read failure:'); }
    });

    /* Free rooms for a stay, each with its price for the stay. */
    router.get('/rooms/:spotId/availability', async (req, res) => {
        try {
            await sweepIfDue(siteOrigin(req));
            const spot = await publicResort(req.params.spotId);
            if (!spot) return res.status(404).json({ success: false, message: 'This place does not take bookings here.' });
            const settings = await settingsFor(spot._id);
            if (!settings.open) throw problem(409, 'This place is not taking bookings right now.');
            const checkIn = String(req.query.checkIn || ''), checkOut = String(req.query.checkOut || '');
            const nights = checkStay(settings, checkIn, checkOut);
            const rooms = await freeRooms(spot._id, checkIn, checkOut);
            res.set('Cache-Control', 'no-store');
            return res.json({
                checkIn, checkOut, nights,
                rooms: rooms.map(r => ({
                    _id: r.id, name: r.name, description: r.description, beds: r.beds, maxGuests: r.max_guests,
                    photoUrl: r.photo_url, rate: money(r.base_rate), free: r.free, stayPrice: money(r.base_rate * nights)
                }))
            });
        } catch (error) { return fail(res, error, '❌ Availability failure:'); }
    });

    /* A booking request: checked, priced by the server, rooms held. */
    router.post('/bookings', requestLimit, async (req, res) => {
        try {
            const body = req.body || {};
            // The form's hidden field: a bot that fills it is answered like a
            // person, and nothing is saved.
            if (String(body.website || '').trim()) {
                return res.status(201).json({ success: true, message: 'Request sent. The resort will answer by email.' });
            }
            const spot = await publicResort(body.spotId);
            if (!spot) throw problem(404, 'This place does not take bookings here.');
            const settings = await settingsFor(spot._id);
            if (!settings.open) throw problem(409, 'This place is not taking bookings right now.');

            const guestName = String(body.guestName || '').trim().replace(/\s+/g, ' ');
            if (guestName.length < 2 || guestName.length > 120) throw problem(400, 'Give the guest\'s full name.');
            const email = String(body.email || '').trim().toLowerCase();
            if (!looksLikeEmail(email) || email.length > 254) throw problem(400, 'Give an email address the resort can answer.');
            const phone = String(body.phone || '').trim();
            if (phone.replace(/[^0-9]/g, '').length < 7 || phone.length > 40) throw problem(400, 'Give a phone number the resort can call.');
            const countryCode = String(body.countryCode || '').trim();
            const { rows: country } = await query('select code from residences where code = $1', [countryCode]);
            if (!country.length) throw problem(400, 'Choose the country where the guest lives.');
            const adults = wholeNumber(body.adults, 1, 100);
            const children = wholeNumber(body.children ?? 0, 0, 100);
            if (adults === null) throw problem(400, 'At least one adult.');
            if (children === null) throw problem(400, 'Children must be a whole number, 0 or more.');
            const note = String(body.note || '').trim();
            if (note.length > 1000) throw problem(400, 'Keep the note to 1000 characters.');

            const checkIn = String(body.checkIn || ''), checkOut = String(body.checkOut || '');
            const nights = checkStay(settings, checkIn, checkOut);

            const list = Array.isArray(body.rooms) ? body.rooms : [];
            if (!list.length) throw problem(400, 'Choose at least one room.');
            if (list.length > MAX_ROOM_LINES) throw problem(400, 'Too many kinds of room in one request.');
            const lines = [];
            for (const item of list) {
                const roomTypeId = String((item && item.roomTypeId) || '');
                const units = wholeNumber(item && item.units, 1, 50);
                if (!isId(roomTypeId) || units === null) throw problem(400, 'Choose how many of each room.');
                if (lines.some(l => l.roomTypeId === roomTypeId)) throw problem(400, 'A room appears twice. Put it on one line.');
                lines.push({ roomTypeId, units });
            }

            const origin = siteOrigin(req);
            await sweepIfDue(origin);
            const created = await transaction(async client => {
                const free = await holdRooms(client, spot._id, lines, checkIn, checkOut);
                const sleeps = lines.reduce((sum, l) => sum + l.units * free.get(l.roomTypeId).max_guests, 0);
                if (sleeps < adults + children) {
                    throw problem(400, `Those rooms sleep ${sleeps}; you are ${adults + children}. Add a room.`);
                }
                // The price comes from the room types now, never from the page.
                const priced = lines.map(l => ({ ...l, rate: money(free.get(l.roomTypeId).base_rate) }));
                const total = money(priced.reduce((sum, l) => sum + l.units * l.rate * nights, 0));
                let row = null;
                for (let attempt = 0; attempt < 5 && !row; attempt++) {
                    try {
                        await query('savepoint booking_code', [], client);
                        ({ rows: [row] } = await query(`
                            insert into bookings (code, spot_id, guest_name, email, phone, country_code, adults, children,
                                                  check_in, check_out, total_amount, note, expires_at)
                            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now() + make_interval(hours => $13))
                            returning *`,
                            [newBookingCode(spot.title), spot._id, guestName, email, phone, countryCode, adults, children,
                                checkIn, checkOut, total, note, settings.responseHours], client));
                    } catch (error) {
                        if (error.code !== '23505' && error.code !== 11000) throw error;   // a code already used: draw again
                        await query('rollback to savepoint booking_code', [], client);
                    }
                }
                if (!row) throw new Error('Could not draw a free booking code.');
                for (const l of priced) {
                    await query('insert into booking_rooms (booking_id, room_type_id, units, rate_per_night) values ($1, $2, $3, $4)',
                        [row.id, l.roomTypeId, l.units, l.rate], client);
                }
                await logChange(client, row.id, 'requested', null, snapshot(row), 'the guest (booking form)');
                return row;
            });
            console.log(`🛏️  Booking ${created.code} requested at ${spot.title} (${nights} nights)`);
            const toGuest = await notices.bookingReceived(created.id, origin);
            await notices.bookingNewRequest(created.id, origin);
            return res.status(201).json({
                success: true, code: created.code, status: created.status, expiresAt: created.expires_at,
                nights, totalAmount: money(created.total_amount), emailed: toGuest.sent,
                message: 'Request sent. The resort will confirm or decline by email.'
            });
        } catch (error) { return fail(res, error, '❌ Booking request failure:'); }
    });

    /* ---- the manager: their own places to stay only ---------------- */

    async function managerEmail(req) {
        const { rows } = await query('select email from establishment_managers where id = $1', [String(req.auth.sub)]);
        return rows[0] ? rows[0].email : '';
    }

    /* The manager's own place to stay, or a 403/404. */
    async function ownResort(req, spotId, client) {
        if (!isId(spotId)) throw problem(404, 'That place could not be found.');
        const { rows } = await query('select id, title, type, managed_by from spots where id = $1', [spotId], client);
        const spot = rows[0];
        if (!spot) throw problem(404, 'That place could not be found.');
        if (String(spot.managed_by || '') !== String(req.auth.sub)) throw problem(403, 'You can only manage bookings for your own enterprises.');
        if (spot.type !== 'accommodation') throw problem(400, 'Only a place to stay takes room bookings.');
        return spot;
    }

    async function ownRoomType(req, id, client, { lock = false } = {}) {
        if (!isId(id)) throw problem(404, 'That room could not be found.');
        const { rows } = await query(`select * from room_types where id = $1${lock ? ' for update' : ''}`, [id], client);
        if (!rows[0]) throw problem(404, 'That room could not be found.');
        await ownResort(req, rows[0].spot_id, client);
        return rows[0];
    }

    async function ownBooking(req, id, client, { lock = false } = {}) {
        if (!isId(id)) throw problem(404, 'That booking could not be found.');
        const b = await bookingRow(id, client, { lock });
        if (!b) throw problem(404, 'That booking could not be found.');
        await ownResort(req, b.spot_id, client);
        return b;
    }

    /* A room type as the manager sends it. */
    function readRoomType(body, existing) {
        const b = body || {};
        const name = String(b.name ?? (existing ? existing.name : '')).trim();
        if (!name || name.length > 80) throw problem(400, 'Give the room a name (up to 80 characters).');
        const description = String(b.description ?? (existing ? existing.description : '')).trim();
        if (description.length > 1000) throw problem(400, 'Keep the description to 1000 characters.');
        const beds = wholeNumber(b.beds ?? (existing ? existing.beds : 1), 1, 20);
        if (beds === null) throw problem(400, 'Beds must be 1 to 20.');
        const maxGuests = wholeNumber(b.maxGuests ?? (existing ? existing.max_guests : 2), 1, 30);
        if (maxGuests === null) throw problem(400, 'Guests per room must be 1 to 30.');
        const rate = money(b.rate ?? (existing ? existing.base_rate : NaN));
        if (!(rate > 0) || rate > 1000000) throw problem(400, 'Give the price per night in pesos.');
        const units = wholeNumber(b.units ?? (existing ? existing.units : NaN), 1, 500);
        if (units === null) throw problem(400, 'How many rooms of this kind? 1 to 500.');
        const photoUrl = String(b.photoUrl ?? (existing ? existing.photo_url : '')).trim();
        if (photoUrl.length > 500) throw problem(400, 'That photo link is too long.');
        checkPhotoSources([photoUrl], existing ? [existing.photo_url] : []);
        const active = typeof b.active === 'boolean' ? b.active : (existing ? existing.active : true);
        const position = wholeNumber(b.position ?? (existing ? existing.position : 0), 0, 1000) ?? 0;
        return { name, description, beds, maxGuests, rate, units, photoUrl, active, position };
    }

    /* Everything for the manager's Rooms page. */
    router.get('/rooms/manage/:spotId', requireEstablishmentManager, async (req, res) => {
        try {
            const spot = await ownResort(req, req.params.spotId);
            const { rows: rooms } = await query('select * from room_types where spot_id = $1 order by position, name', [spot.id]);
            const { rows: blocks } = await query(`
                select k.* from room_blocks k join room_types rt on rt.id = k.room_type_id
                 where rt.spot_id = $1 and k.ends_on >= $2 order by k.starts_on`, [spot.id, manilaToday()]);
            return res.json({
                settings: await settingsFor(spot.id),
                rooms: rooms.map(shapeRoom),
                blocks: blocks.map(k => ({ _id: k.id, roomTypeId: k.room_type_id, startsOn: k.starts_on, endsOn: k.ends_on, units: k.units, reason: k.reason }))
            });
        } catch (error) { return fail(res, error, '❌ Rooms (manager) read failure:'); }
    });

    /* The Bookings page's month view: for each room type and night of one
       Manila month, the rooms booked (confirmed or checked in), waiting on a
       request still open, blocked, and free. The same "held" rule as
       freeRooms, so the view never disagrees with what can be booked. */
    router.get('/rooms/manage/:spotId/calendar', requireEstablishmentManager, async (req, res) => {
        try {
            await sweepIfDue(siteOrigin(req));
            const spot = await ownResort(req, req.params.spotId);
            const month = String(req.query.month || manilaToday().slice(0, 7));
            if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw problem(400, 'Give the month as YYYY-MM.');
            const first = `${month}-01`;
            const last = addDays(addDays(first, 32).slice(0, 7) + '-01', -1);
            const { rows } = await query(`
                with nights as (
                    select d::date as night from generate_series($2::date, $3::date, interval '1 day') d)
                select rt.id, rt.name, rt.units, rt.active, rt.position, to_char(n.night, 'YYYY-MM-DD') as night,
                       coalesce(held.booked, 0)::int as booked, coalesce(held.waiting, 0)::int as waiting,
                       coalesce(blocked.units, 0)::int as blocked
                  from room_types rt
                 cross join nights n
                  left join lateral (
                        select sum(br.units) filter (where b.status in ('confirmed', 'checked_in')) as booked,
                               sum(br.units) filter (where b.status = 'requested') as waiting
                          from booking_rooms br join bookings b on b.id = br.booking_id
                         where br.room_type_id = rt.id and b.check_in <= n.night and b.check_out > n.night
                           and ${HOLDING}) held on true
                  left join lateral (
                        select sum(k.units) as units from room_blocks k
                         where k.room_type_id = rt.id and k.starts_on <= n.night and k.ends_on >= n.night) blocked on true
                 where rt.spot_id = $1
                 order by rt.position, rt.name, n.night`, [spot.id, first, last]);
            const rooms = [];
            for (const r of rows) {
                let room = rooms[rooms.length - 1];
                if (!room || room._id !== r.id) rooms.push(room = { _id: r.id, name: r.name, units: r.units, active: r.active, nights: [] });
                room.nights.push({ date: r.night, booked: r.booked, waiting: r.waiting, blocked: r.blocked,
                    free: Math.max(0, r.units - r.booked - r.waiting - r.blocked) });
            }
            // A retired room type shows only while something still holds it that month.
            const shown = rooms.filter(r => r.active || r.nights.some(n => n.booked || n.waiting || n.blocked));
            return res.json({ month, first, last, today: manilaToday(), rooms: shown });
        } catch (error) { return fail(res, error, '❌ Rooms calendar failure:'); }
    });

    router.put('/rooms/manage/:spotId/settings', requireEstablishmentManager, async (req, res) => {
        try {
            const spot = await ownResort(req, req.params.spotId);
            const current = await settingsFor(spot.id);
            const b = req.body || {};
            const pick = (key, fallback) => (b[key] === undefined ? fallback : b[key]);
            const accepts = pick('acceptsBookings', current.acceptsBookings);
            if (typeof accepts !== 'boolean') throw problem(400, 'Say whether the place takes bookings.');
            const responseHours = wholeNumber(pick('responseHours', current.responseHours), 1, 72);
            if (responseHours === null) throw problem(400, 'The time to answer a request must be 1 to 72 hours.');
            const time = value => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? String(value) : null);
            const checkInTime = time(pick('checkInTime', current.checkInTime));
            const checkOutTime = time(pick('checkOutTime', current.checkOutTime));
            if (!checkInTime || !checkOutTime) throw problem(400, 'Give the check-in and check-out times as HH:MM.');
            const minNights = wholeNumber(pick('minNights', current.minNights), 1, 60);
            const maxNights = wholeNumber(pick('maxNights', current.maxNights), 1, 60);
            if (minNights === null || maxNights === null || maxNights < minNights) throw problem(400, 'Nights: the shortest stay 1 to 60, the longest at least the shortest.');
            const advanceDays = wholeNumber(pick('advanceDays', current.advanceDays), 1, 730);
            if (advanceDays === null) throw problem(400, 'How far ahead: 1 to 730 days.');
            const freeCancelDays = wholeNumber(pick('freeCancelDays', current.freeCancelDays), 0, 60);
            if (freeCancelDays === null) throw problem(400, 'Free cancellation: 0 to 60 days before check-in.');
            const paymentInstructions = String(pick('paymentInstructions', current.paymentInstructions)).trim();
            if (paymentInstructions.length > 2000) throw problem(400, 'Keep the payment instructions to 2000 characters.');
            if (accepts && !paymentInstructions) throw problem(400, 'Write how guests pay you before taking bookings.');
            const by = await managerEmail(req);
            // The office's pause is not the manager's to lift: it is left as it is.
            await query(`
                insert into enterprise_booking_settings
                    (spot_id, accepts_bookings, response_hours, check_in_time, check_out_time, min_nights, max_nights,
                     advance_days, free_cancel_days, payment_instructions, updated_by_email)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                on conflict (spot_id) do update set accepts_bookings = $2, response_hours = $3, check_in_time = $4,
                    check_out_time = $5, min_nights = $6, max_nights = $7, advance_days = $8, free_cancel_days = $9,
                    payment_instructions = $10, updated_by_email = $11`,
                [spot.id, accepts, responseHours, checkInTime, checkOutTime, minNights, maxNights, advanceDays, freeCancelDays, paymentInstructions, by]);
            return res.json({ success: true, message: 'Saved.', settings: await settingsFor(spot.id) });
        } catch (error) { return fail(res, error, '❌ Booking settings failure:'); }
    });

    router.post('/rooms/manage/:spotId/types', requireEstablishmentManager, async (req, res) => {
        try {
            const spot = await ownResort(req, req.params.spotId);
            const r = readRoomType(req.body);
            const { rows } = await query(`
                insert into room_types (spot_id, name, description, beds, max_guests, base_rate, units, photo_url, active, position)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
                [spot.id, r.name, r.description, r.beds, r.maxGuests, r.rate, r.units, r.photoUrl, r.active, r.position]);
            return res.status(201).json({ success: true, message: 'Room added.', room: shapeRoom(rows[0]) });
        } catch (error) { return fail(res, error, '❌ Room type create failure:'); }
    });

    /* A room type is changed or retired (active false), never deleted: old
       bookings keep pointing at it. A new price applies to new requests only. */
    router.put('/rooms/manage/types/:id', requireEstablishmentManager, async (req, res) => {
        try {
            const existing = await ownRoomType(req, req.params.id);
            const r = readRoomType(req.body, existing);
            const { rows } = await query(`
                update room_types set name = $2, description = $3, beds = $4, max_guests = $5, base_rate = $6, units = $7,
                       photo_url = $8, active = $9, position = $10 where id = $1 returning *`,
                [existing.id, r.name, r.description, r.beds, r.maxGuests, r.rate, r.units, r.photoUrl, r.active, r.position]);
            return res.json({ success: true, message: 'Saved.', room: shapeRoom(rows[0]) });
        } catch (error) { return fail(res, error, '❌ Room type update failure:'); }
    });

    /* Rooms taken out of booking for some nights. Refused where they are
       already held by bookings: those are the manager's to move or decline. */
    router.post('/rooms/manage/types/:id/blocks', requireEstablishmentManager, async (req, res) => {
        try {
            const b = req.body || {};
            const startsOn = String(b.startsOn || ''), endsOn = String(b.endsOn || '');
            if (!isDateKey(startsOn) || !isDateKey(endsOn)) throw problem(400, 'Give the first and last night to block.');
            if (endsOn < startsOn) throw problem(400, 'The last night cannot be before the first.');
            if (daysBetween(startsOn, endsOn) > 366) throw problem(400, 'Block up to a year at a time.');
            if (endsOn < manilaToday()) throw problem(400, 'Those nights have already passed.');
            const reason = String(b.reason || '').trim();
            if (reason.length > 200) throw problem(400, 'Keep the reason to 200 characters.');
            const by = await managerEmail(req);
            const block = await transaction(async client => {
                const room = await ownRoomType(req, req.params.id, client, { lock: true });
                const units = wholeNumber(b.units ?? room.units, 1, room.units);
                if (units === null) throw problem(400, `Block 1 to ${room.units} rooms.`);
                const free = await freeRooms(room.spot_id, startsOn, addDays(endsOn, 1), { client, activeOnly: false });
                const mine = free.find(r => r.id === room.id);
                if (!mine || mine.free < units) {
                    throw problem(409, `Only ${mine ? mine.free : 0} of these rooms are free on every one of those nights; the rest are booked or already blocked.`);
                }
                const { rows } = await query(`
                    insert into room_blocks (room_type_id, starts_on, ends_on, units, reason, created_by_email)
                    values ($1, $2, $3, $4, $5, $6) returning *`, [room.id, startsOn, endsOn, units, reason, by], client);
                return rows[0];
            });
            return res.status(201).json({ success: true, message: 'Blocked.', block: { _id: block.id, roomTypeId: block.room_type_id, startsOn: block.starts_on, endsOn: block.ends_on, units: block.units, reason: block.reason } });
        } catch (error) { return fail(res, error, '❌ Room block failure:'); }
    });

    /* Lifting a block gives the rooms back to booking. */
    router.delete('/rooms/manage/blocks/:id', requireEstablishmentManager, async (req, res) => {
        try {
            if (!isId(req.params.id)) throw problem(404, 'That block could not be found.');
            const { rows } = await query('select * from room_blocks where id = $1', [req.params.id]);
            if (!rows[0]) throw problem(404, 'That block could not be found.');
            await ownRoomType(req, rows[0].room_type_id);
            await query('delete from room_blocks where id = $1', [rows[0].id]);
            return res.json({ success: true, message: 'Block lifted.' });
        } catch (error) { return fail(res, error, '❌ Room block lift failure:'); }
    });

    /* The manager's view of one booking. */
    async function managerView(b) {
        const { rows: paid } = await query('select * from booking_payments where booking_id = $1 order by received_on, created_at', [b.id]);
        const { rows: changes } = await query('select action, before, after, by_email, at from booking_changes where booking_id = $1 order by at', [b.id]);
        const { rows: entry } = await query('select id from register_entries where booking_id = $1', [b.id]);
        const rooms = await bookingRooms(b.id);
        return {
            _id: b.id, code: b.code, spotId: b.spot_id, status: b.status,
            guestName: b.guest_name, email: b.email, phone: b.phone, countryCode: b.country_code,
            adults: b.adults, children: b.children, checkIn: b.check_in, checkOut: b.check_out, nights: b.nights,
            rooms, totalAmount: money(b.total_amount), note: b.note,
            requestedAt: b.requested_at, expiresAt: b.expires_at, decidedAt: b.decided_at, decidedByEmail: b.decided_by_email,
            declineReason: b.decline_reason, createdAt: b.created_at,
            payments: paid.map(p => ({ _id: p.id, amount: money(p.amount), method: p.method, receivedOn: p.received_on, reference: p.reference, recordedByEmail: p.recorded_by_email })),
            paidTotal: money(paid.reduce((s, p) => s + Number(p.amount), 0)),
            changes: changes.map(c => ({ action: c.action, before: c.before, after: c.after, byEmail: c.by_email, at: c.at })),
            // At check-in the Guest Register entry is filled from the booking;
            // the manager adds male and female and saves it (statistics.js).
            registerEntryId: entry[0] ? entry[0].id : null,
            registerDraft: ['checked_in', 'completed'].includes(b.status) && !entry[0] ? {
                bookingId: b.id, date: b.check_in, nights: b.nights, rooms: rooms.reduce((s, r) => s + r.units, 0),
                countryCode: b.country_code, guests: b.adults + b.children
            } : null
        };
    }

    /* The Bookings list. ?status= one status; ?when=upcoming|past|all. */
    router.get('/bookings/manage/:spotId', requireEstablishmentManager, async (req, res) => {
        try {
            await sweepIfDue(siteOrigin(req));
            const spot = await ownResort(req, req.params.spotId);
            const params = [spot.id];
            let where = 'where b.spot_id = $1';
            if (req.query.status) {
                params.push(String(req.query.status));
                where += ` and b.status = $${params.length}`;
            }
            if (req.query.when === 'upcoming') { params.push(manilaToday()); where += ` and b.check_out >= $${params.length}`; }
            if (req.query.when === 'past') { params.push(manilaToday()); where += ` and b.check_out < $${params.length}`; }
            const { rows } = await query(`
                select b.*, coalesce((select sum(p.amount) from booking_payments p where p.booking_id = b.id), 0) as paid,
                       (select string_agg(br.units || ' × ' || rt.name, ', ' order by rt.position)
                          from booking_rooms br join room_types rt on rt.id = br.room_type_id where br.booking_id = b.id) as rooms_text
                  from bookings b ${where}
                 order by (b.status = 'requested') desc, b.check_in, b.created_at limit 500`, params);
            return res.json(rows.map(b => ({
                _id: b.id, code: b.code, status: b.status, guestName: b.guest_name, countryCode: b.country_code,
                adults: b.adults, children: b.children, checkIn: b.check_in, checkOut: b.check_out, nights: b.nights,
                roomsText: b.rooms_text || '', totalAmount: money(b.total_amount), paid: money(b.paid),
                requestedAt: b.requested_at, expiresAt: b.expires_at
            })));
        } catch (error) { return fail(res, error, '❌ Bookings list failure:'); }
    });

    router.get('/bookings/manage/item/:id', requireEstablishmentManager, async (req, res) => {
        try {
            await sweepIfDue(siteOrigin(req));
            return res.json(await managerView(await ownBooking(req, req.params.id)));
        } catch (error) { return fail(res, error, '❌ Booking read failure:'); }
    });

    /* One decision, inside one transaction on the locked booking. */
    async function decide(req, res, label, work) {
        try {
            const by = await managerEmail(req);
            const result = await transaction(async client => {
                const b = await ownBooking(req, req.params.id, client, { lock: true });
                const after = await work(client, b, by);
                return { before: b, after };
            });
            const view = await managerView(result.after);
            return { by, before: result.before, view };
        } catch (error) {
            fail(res, error, label);
            return null;
        }
    }

    router.post('/bookings/manage/item/:id/confirm', requireEstablishmentManager, async (req, res) => {
        const done = await decide(req, res, '❌ Booking confirm failure:', async (client, b, by) => {
            if (b.status !== 'requested') throw problem(409, 'Only a request waiting for an answer can be confirmed.');
            if (new Date(b.expires_at) <= new Date()) throw problem(409, 'This request expired before it was answered. Its rooms are free again.');
            const { rows } = await query(`update bookings set status = 'confirmed', decided_at = now(), decided_by_email = $2 where id = $1 returning *`, [b.id, by], client);
            await logChange(client, b.id, 'confirmed', snapshot(b), snapshot(rows[0]), by);
            return rows[0];
        });
        if (!done) return;
        const told = await notices.bookingConfirmed(done.view._id, siteOrigin(req));
        return res.json({ success: true, emailed: told.sent, message: 'Confirmed. The guest has been told how to pay.', booking: done.view });
    });

    router.post('/bookings/manage/item/:id/decline', requireEstablishmentManager, async (req, res) => {
        const reason = String((req.body || {}).reason || '').trim();
        if (!reason || reason.length > 300) return res.status(400).json({ success: false, message: 'Give the guest a reason (up to 300 characters).' });
        const done = await decide(req, res, '❌ Booking decline failure:', async (client, b, by) => {
            if (b.status !== 'requested') throw problem(409, 'Only a request waiting for an answer can be declined.');
            const { rows } = await query(`update bookings set status = 'declined', decided_at = now(), decided_by_email = $2, decline_reason = $3 where id = $1 returning *`, [b.id, by, reason], client);
            await logChange(client, b.id, 'declined', snapshot(b), { ...snapshot(rows[0]), reason }, by);
            return rows[0];
        });
        if (!done) return;
        const told = await notices.bookingDeclined(done.view._id, siteOrigin(req));
        return res.json({ success: true, emailed: told.sent, message: 'Declined. The guest has been told, and the rooms are free again.', booking: done.view });
    });

    /* A different total for one request, before confirming, with a reason. */
    router.post('/bookings/manage/item/:id/price', requireEstablishmentManager, async (req, res) => {
        const b0 = req.body || {};
        const total = money(b0.totalAmount);
        const reason = String(b0.reason || '').trim();
        if (!(total >= 0) || total > 10000000 || !Number.isFinite(Number(b0.totalAmount))) {
            return res.status(400).json({ success: false, message: 'Give the new total in pesos.' });
        }
        if (!reason || reason.length > 300) return res.status(400).json({ success: false, message: 'Say why the price changes (up to 300 characters).' });
        const done = await decide(req, res, '❌ Booking price failure:', async (client, b, by) => {
            if (b.status !== 'requested') throw problem(409, 'The price can only change before the booking is confirmed.');
            const { rows } = await query('update bookings set total_amount = $2 where id = $1 returning *', [b.id, total], client);
            await logChange(client, b.id, 'price_adjusted', snapshot(b), { ...snapshot(rows[0]), reason }, by);
            return rows[0];
        });
        if (!done) return;
        return res.json({ success: true, message: 'The total is changed. Confirm the booking to tell the guest.', booking: done.view });
    });

    /* Money the guest paid the resort directly. */
    router.post('/bookings/manage/item/:id/payments', requireEstablishmentManager, async (req, res) => {
        const p = req.body || {};
        const amount = money(p.amount);
        const method = String(p.method || '');
        const receivedOn = String(p.receivedOn || '');
        const reference = String(p.reference || '').trim();
        if (!(amount > 0) || amount > 10000000) return res.status(400).json({ success: false, message: 'Give the amount received in pesos.' });
        if (!BOOKING_PAYMENT_METHODS.includes(method)) return res.status(400).json({ success: false, message: 'Choose how it was paid.' });
        if (!isDateKey(receivedOn) || receivedOn > manilaToday()) return res.status(400).json({ success: false, message: 'Give the day it was received (not a later day).' });
        if (reference.length > 120) return res.status(400).json({ success: false, message: 'Keep the reference to 120 characters.' });
        const done = await decide(req, res, '❌ Booking payment failure:', async (client, b, by) => {
            if (!['confirmed', 'checked_in', 'completed'].includes(b.status)) throw problem(409, 'Record a payment once the booking is confirmed.');
            await query(`insert into booking_payments (booking_id, amount, method, received_on, reference, recorded_by_email)
                         values ($1, $2, $3, $4, $5, $6)`, [b.id, amount, method, receivedOn, reference, by], client);
            await logChange(client, b.id, 'payment_recorded', null, { amount, method, receivedOn }, by);
            return b;
        });
        if (!done) return;
        return res.status(201).json({ success: true, message: 'Payment recorded.', booking: done.view });
    });

    /* Checked in, Completed, No-show. */
    const NEXT = {
        checked_in: { from: ['confirmed'], onOrAfterCheckIn: true },
        completed: { from: ['checked_in'] },
        no_show: { from: ['confirmed'], onOrAfterCheckIn: true }
    };
    router.post('/bookings/manage/item/:id/status', requireEstablishmentManager, async (req, res) => {
        const status = String((req.body || {}).status || '');
        const rule = NEXT[status];
        if (!rule) return res.status(400).json({ success: false, message: 'Choose Checked in, Completed or No-show.' });
        const done = await decide(req, res, '❌ Booking status failure:', async (client, b, by) => {
            if (!rule.from.includes(b.status)) {
                throw problem(409, status === 'completed' ? 'Only a guest who has checked in can be marked completed.' : 'Only a confirmed booking can be marked that way.');
            }
            if (rule.onOrAfterCheckIn && manilaToday() < b.check_in) throw problem(409, 'That can only be marked on or after the check-in date.');
            const { rows } = await query('update bookings set status = $2 where id = $1 returning *', [b.id, status], client);
            await logChange(client, b.id, status, snapshot(b), snapshot(rows[0]), by);
            return rows[0];
        });
        if (!done) return;
        return res.json({
            success: true, booking: done.view,
            message: status === 'checked_in' ? 'Checked in. Save the Guest Register entry to count the guests.'
                : status === 'completed' ? 'Completed.' : 'Marked as a no-show. The rooms are free again.'
        });
    });

    /* ---- the Tourism Officer: counts and a pause, no money ---------- */

    router.get('/bookings/overview', requireAdmin, async (req, res) => {
        try {
            const { rows } = await query(`
                select s.id, s.title, coalesce(nullif(s.enterprise_name, ''), s.title) as enterprise_name, m.manager_name,
                       coalesce(es.accepts_bookings, false) as accepts_bookings, coalesce(es.paused_by_office, false) as paused_by_office,
                       (select count(*) from room_types rt where rt.spot_id = s.id and rt.active)::int as room_types,
                       (select coalesce(sum(rt.units), 0) from room_types rt where rt.spot_id = s.id and rt.active)::int as rooms,
                       (select jsonb_object_agg(x.status, x.n) from (select status, count(*) as n from bookings b where b.spot_id = s.id group by status) x) as by_status,
                       (select count(*) from bookings b where b.spot_id = s.id and b.status in ('confirmed', 'checked_in') and b.check_out >= $1)::int as upcoming
                  from spots s
                  join establishment_managers m on m.id = s.managed_by
                  left join enterprise_booking_settings es on es.spot_id = s.id
                 where s.type = 'accommodation' and s.status <> 'archived'
                 order by enterprise_name`, [manilaToday()]);
            return res.json(rows.map(r => ({
                spotId: r.id, title: r.title, enterpriseName: r.enterprise_name, managerName: r.manager_name,
                acceptsBookings: r.accepts_bookings, pausedByOffice: r.paused_by_office,
                open: r.accepts_bookings && !r.paused_by_office, roomTypes: r.room_types, rooms: r.rooms,
                counts: Object.fromEntries(['requested', 'confirmed', 'checked_in', 'completed', 'declined', 'expired', 'cancelled', 'no_show']
                    .map(s => [s, Number((r.by_status || {})[s] || 0)])),
                upcoming: r.upcoming
            })));
        } catch (error) { return fail(res, error, '❌ Bookings overview failure:'); }
    });

    /* Pauses (or resumes) one enterprise's bookings. A request already made
       stays for the manager to answer. */
    router.patch('/bookings/overview/:spotId/pause', requireAdmin, async (req, res) => {
        try {
            const paused = (req.body || {}).paused;
            if (typeof paused !== 'boolean') throw problem(400, 'Say whether to pause or resume.');
            if (!isId(req.params.spotId)) throw problem(404, 'That place could not be found.');
            const { rows } = await query(`select id, title from spots where id = $1 and type = 'accommodation' and managed_by is not null`, [req.params.spotId]);
            if (!rows[0]) throw problem(404, 'That place could not be found.');
            const { rows: me } = await query('select email from tourism_officers where id = $1', [String(req.auth.sub)]);
            await query(`insert into enterprise_booking_settings (spot_id, paused_by_office, updated_by_email) values ($1, $2, $3)
                         on conflict (spot_id) do update set paused_by_office = $2, updated_by_email = $3`, [rows[0].id, paused, me[0] ? me[0].email : '']);
            console.log(`🛏️  Officer ${paused ? 'paused' : 'resumed'} bookings at ${rows[0].title}`);
            return res.json({ success: true, message: paused ? `Bookings at ${rows[0].title} are paused.` : `Bookings at ${rows[0].title} are open again.`, settings: await settingsFor(rows[0].id) });
        } catch (error) { return fail(res, error, '❌ Bookings pause failure:'); }
    });

    return router;
};

module.exports.sweepBookings = sweepBookings;
module.exports.findBooking = findBooking;
module.exports.describeForVisitor = describeForVisitor;
module.exports.visitorMove = visitorMove;
module.exports.visitorCancel = visitorCancel;
module.exports.manilaToday = manilaToday;
