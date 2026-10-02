/* Attraction setup — what the Tourism Office decides, per destination, before a
 * visitor can buy a ticket or book a guide there:
 *
 *   - which weekdays it opens (spots.working_days, read by open-days.js),
 *   - which particular dates it is shut (spot_closed_dates),
 *   - what each kind of visitor pays: the regular entrance fee; senior citizens
 *     and persons with disability always 20% off it (a rule, not a setting);
 *     a student and a child price, each offered only when the office sets it,
 *     and the age up to which a visitor counts as a child,
 *   - and what share of the price it keeps when a visitor cancels.
 *
 * dayVerdict() is the one answer to "can visitors come on this date?", used by
 * ticket sales (payments.js) and guide bookings (server.js) alike, so a form
 * can never be told a day is open that the purchase would then refuse.
 *
 * Mounted at /api by server.js. Every write here is the officer's.
 */
const express = require('express');
const { query, transaction } = require('./db');
const { spots: Spot, closedDates: ClosedDate, officers: TourismOfficer } = require('./models');
const { WEEK, NAMES, parseOpenDays, formatOpenDays, weekdayOf, isOpenOn } = require('./open-days');

const SENIOR_PWD_DISCOUNT = 0.20;          // RA 9994 and RA 10754: 20% off for seniors and PWDs
const MANILA_OFFSET_HOURS = 8;

const money = n => Math.round(Number(n) * 100) / 100;
const manilaToday = () => new Date(Date.now() + MANILA_OFFSET_HOURS * 3600 * 1000).toISOString().slice(0, 10);
const isDateKey = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());

function niceDate(dateKey) {
    return new Date(`${dateKey}T00:00:00Z`).toLocaleDateString('en-PH', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
    });
}

/* What one person of each kind pays here, or null where that kind is not
   offered. Regular is the entrance fee; senior and PWD always 20% off it. */
function feeTable(spot) {
    const regular = money(spot.entranceFee || spot.entrance_fee || 0);
    const discounted = money(regular * (1 - SENIOR_PWD_DISCOUNT));
    const student = spot.studentFee ?? spot.student_fee;
    const child = spot.childFee ?? spot.child_fee;
    const childAgeMax = spot.childAgeMax ?? spot.child_age_max;
    return {
        regular,
        senior: discounted,
        pwd: discounted,
        student: student === null || student === undefined ? null : money(student),
        child: child === null || child === undefined || !childAgeMax ? null : money(child),
        childAgeMax: childAgeMax || null
    };
}

/* The kinds of visitor a ticket counts, in the order they are shown. Those
   with an ID to show at the entrance say so. */
const KINDS = [
    { key: 'regular', column: 'count_regular', field: 'countRegular', label: 'Regular', plural: 'regular', needsId: false },
    { key: 'senior', column: 'count_senior', field: 'countSenior', label: 'Senior citizen', plural: 'senior citizens', needsId: true },
    { key: 'pwd', column: 'count_pwd', field: 'countPwd', label: 'Person with disability', plural: 'PWDs', needsId: true },
    { key: 'student', column: 'count_student', field: 'countStudent', label: 'Student', plural: 'students', needsId: true },
    { key: 'child', column: 'count_child', field: 'countChild', label: 'Child', plural: 'children', needsId: false }
];

/* A ticket's people, kind by kind — from the model (countRegular…) or a raw
   row (count_regular…). Only the kinds it has. */
function kindsOf(ticket) {
    return KINDS.map(k => ({ key: k.key, label: k.label, needsId: k.needsId,
                             count: Number(ticket[k.field] ?? ticket[k.column] ?? 0) }))
        .filter(k => k.count > 0);
}

/* "2 regular, 1 senior citizen and 1 child" */
function describeKinds(ticket) {
    const parts = kindsOf(ticket).map(k => {
        const kind = KINDS.find(x => x.key === k.key);
        return `${k.count} ${k.count === 1 ? kind.label.toLowerCase() : kind.plural}`;
    });
    if (parts.length <= 1) return parts.join('');
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/* Prices a ticket from the counts a visitor chose, at this destination's fees.
   Throws a 400 with a plain message when a count is not allowed. */
function priceTickets(spot, rawCounts, { maxPeople = 20 } = {}) {
    const fees = feeTable(spot);
    const counts = {};
    let people = 0;
    for (const k of KINDS) {
        const raw = rawCounts && rawCounts[k.key];
        const n = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
        if (!Number.isInteger(n) || n < 0) {
            const e = new Error('Each number of people must be a whole number.'); e.status = 400; throw e;
        }
        if (n > 0 && fees[k.key] === null) {
            const e = new Error(`This attraction has no ${k.label.toLowerCase()} price.`); e.status = 400; throw e;
        }
        counts[k.key] = n;
        people += n;
    }
    if (people < 1 || people > maxPeople) {
        const e = new Error(`Choose between 1 and ${maxPeople} people.`); e.status = 400; throw e;
    }
    const unitFees = {};
    let amount = 0;
    for (const k of KINDS) {
        if (!counts[k.key]) continue;
        unitFees[k.key] = fees[k.key];
        amount += counts[k.key] * fees[k.key];
    }
    return { counts, people, unitFees, amount: money(amount), fees };
}

/* The closed dates from `from` (today by default) for `days` days ahead. */
async function closedDatesFor(spotId, { from = manilaToday(), days = 400 } = {}) {
    const { rows } = await query(
        `select id, closed_date, reason from spot_closed_dates
          where spot_id = $1 and closed_date >= $2 and closed_date < ($2::date + $3::int)
          order by closed_date`, [spotId, from, days]);
    return rows.map(r => ({ _id: r.id, date: r.closed_date, reason: r.reason }));
}

/* Whether visitors can come to this destination on that date, and if not, a
   sentence saying why. */
async function dayVerdict(spot, dateKey) {
    if (!isOpenOn(spot.workingDays, dateKey)) {
        const day = NAMES[WEEK.indexOf(weekdayOf(dateKey))];
        return { open: false, reason: `${spot.title} is closed on ${day}s (open: ${spot.workingDays}).` };
    }
    const closed = await ClosedDate.findOne({ spotId: spot._id, closedDate: dateKey });
    if (closed) {
        return { open: false, reason: `${spot.title} is closed on ${niceDate(dateKey)}${closed.reason ? ` (${closed.reason})` : ''}.` };
    }
    return { open: true };
}

/* What the public pages need to grey out days: the open weekdays (null when
   the text names none, meaning every day) and the upcoming closed dates. */
async function visitCalendar(spot, days) {
    return {
        openDays: parseOpenDays(spot.workingDays),
        openDaysText: spot.workingDays || 'Everyday',
        closedDates: (await closedDatesFor(spot._id, { days })).map(({ date, reason }) => ({ date, reason }))
    };
}

/* Sales already made for one date: what closing it would affect, and, once
   closed, how many visitors have still to choose a refund or a new date. */
async function salesOn(spotId, dateKey) {
    const { rows } = await query(`
        select (select count(*) from tickets where spot_id = $1 and visit_date = $2 and status = 'valid')::int as tickets,
               (select count(*) from guide_bookings where spot_id = $1 and preferred_date = $2
                   and status in ('pending_payment', 'confirmed'))::int as bookings,
               ((select count(*) from tickets where spot_id = $1 and visit_date = $2 and status = 'closed')
                + (select count(*) from guide_bookings where spot_id = $1 and preferred_date = $2 and status = 'closed'))::int as awaitingChoice`,
        [spotId, dateKey]);
    return { tickets: rows[0].tickets, bookings: rows[0].bookings, awaitingChoice: rows[0].awaitingchoice };
}

function setupView(spot, closedDates) {
    const fees = feeTable(spot);
    return {
        _id: spot._id,
        title: spot.title,
        type: spot.type,
        officeRun: !spot.managedBy,
        requiresGuide: Boolean(spot.requiresGuide),
        entranceFee: fees.regular,
        seniorPwdFee: fees.senior,
        studentFee: spot.studentFee,
        childFee: spot.childFee,
        childAgeMax: spot.childAgeMax,
        cancelKeepPercent: Number(spot.cancelKeepPercent) || 0,
        workingDays: spot.workingDays || 'Everyday',
        openDays: parseOpenDays(spot.workingDays),
        closedDates
    };
}

function fail(res, status, message, extra = {}) {
    return res.status(status).json({ success: false, message, ...extra });
}

/* A price field: empty means "not offered", otherwise pesos, not negative. */
function priceOrNull(value, label) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
        const e = new Error(`${label} must be an amount in pesos, or left empty.`);
        e.status = 400;
        throw e;
    }
    return money(n);
}

module.exports = function attractionsRouter({ requireAdmin }) {
    const router = express.Router();

    const officerEmail = async req => {
        const officer = await TourismOfficer.findById(req.auth.sub);
        return officer ? officer.email : '';
    };

    router.get('/spots/:id/setup', requireAdmin, async (req, res) => {
        try {
            const spot = await Spot.findById(req.params.id);
            if (!spot) return fail(res, 404, 'That destination could not be found.');
            const closed = await closedDatesFor(spot._id);
            for (const c of closed) Object.assign(c, await salesOn(spot._id, c.date));
            res.json({ success: true, setup: setupView(spot, closed), today: manilaToday() });
        } catch (error) {
            console.error('❌ Attraction setup read failure:', error);
            fail(res, 500, 'Could not read this destination\'s setup.');
        }
    });

    router.put('/spots/:id/setup', requireAdmin, async (req, res) => {
        try {
            const spot = await Spot.findById(req.params.id);
            if (!spot) return fail(res, 404, 'That destination could not be found.');
            const body = req.body || {};

            if (body.openDays !== undefined) {
                const days = Array.isArray(body.openDays) ? WEEK.filter(d => body.openDays.includes(d)) : [];
                if (!days.length) return fail(res, 400, 'Tick at least one day the destination is open. To shut it for a while, add closed dates instead.');
                spot.workingDays = formatOpenDays(days);
            }
            if (body.studentFee !== undefined) spot.studentFee = priceOrNull(body.studentFee, 'The student price');
            if (body.childFee !== undefined) spot.childFee = priceOrNull(body.childFee, 'The child price');
            if (body.childAgeMax !== undefined) {
                if (body.childAgeMax === null || body.childAgeMax === '') spot.childAgeMax = null;
                else {
                    const age = Number(body.childAgeMax);
                    if (!Number.isInteger(age) || age < 1 || age > 17) return fail(res, 400, 'The child age limit must be a whole number from 1 to 17.');
                    spot.childAgeMax = age;
                }
            }
            if (spot.childFee !== null && spot.childFee !== undefined && !spot.childAgeMax) {
                return fail(res, 400, 'Say up to what age the child price applies, or leave the child price empty.');
            }
            if (body.cancelKeepPercent !== undefined) {
                const pct = Number(body.cancelKeepPercent);
                if (!Number.isFinite(pct) || pct < 0 || pct > 100) return fail(res, 400, 'The share kept on a cancellation must be from 0 to 100 percent.');
                spot.cancelKeepPercent = Math.round(pct * 100) / 100;
            }

            await Spot.save(spot);
            console.log(`🎫 Setup of ${spot.title} saved by ${await officerEmail(req)}`);
            const closed = await closedDatesFor(spot._id);
            res.json({ success: true, message: `${spot.title}'s setup is saved.`, setup: setupView(spot, closed) });
        } catch (error) {
            if (error && error.status) return fail(res, error.status, error.message);
            console.error('❌ Attraction setup save failure:', error);
            fail(res, 500, 'Could not save this destination\'s setup.');
        }
    });

    /* A date the destination is shut. One that already has sales is refused
       here: closing it means cancelling them and telling each visitor, which
       is the closure action's job, not a quiet entry in a list. */
    router.post('/spots/:id/closed-dates', requireAdmin, async (req, res) => {
        try {
            const spot = await Spot.findById(req.params.id);
            if (!spot) return fail(res, 404, 'That destination could not be found.');
            const date = String((req.body && req.body.date) || '').trim();
            const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
            if (!isDateKey(date)) return fail(res, 400, 'Choose the date it is closed.');
            if (date < manilaToday()) return fail(res, 400, 'That date has already passed.');

            const sales = await salesOn(spot._id, date);
            if (sales.tickets || sales.bookings) {
                const parts = [];
                if (sales.tickets) parts.push(`${sales.tickets} ticket${sales.tickets === 1 ? '' : 's'}`);
                if (sales.bookings) parts.push(`${sales.bookings} guide booking${sales.bookings === 1 ? '' : 's'}`);
                const verb = sales.tickets + sales.bookings === 1 ? 'exists' : 'exist';
                return fail(res, 409, `${parts.join(' and ')} already ${verb} for ${niceDate(date)}. Use "Close this date" so each visitor is refunded or moved.`, { sales });
            }

            const closed = await ClosedDate.create({ spotId: spot._id, closedDate: date, reason, createdByEmail: await officerEmail(req) });
            res.status(201).json({ success: true, message: `${spot.title} is closed on ${niceDate(date)}.`, closed });
        } catch (error) {
            if (error && error.code === 11000) return fail(res, 409, 'That date is already marked closed.');
            console.error('❌ Closed date failure:', error);
            fail(res, 500, 'Could not save that closed date.');
        }
    });

    /* Closing a date that already has sales: one action. The date is marked
       closed; every paid ticket and booking for it becomes 'closed' (out of
       use, the visitor to choose a full refund or a new date on the Manage
       page); unpaid ones are cancelled. Each visitor is emailed. All the
       changes are one transaction; the emails follow it. */
    router.post('/spots/:id/close-date', requireAdmin, async (req, res) => {
        try {
            const spot = await Spot.findById(req.params.id);
            if (!spot) return fail(res, 404, 'That destination could not be found.');
            const date = String((req.body && req.body.date) || '').trim();
            const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
            if (!isDateKey(date)) return fail(res, 400, 'Choose the date to close.');
            if (date < manilaToday()) return fail(res, 400, 'That date has already passed.');
            const who = await officerEmail(req);
            const note = `The office closed ${spot.title} on this date${reason ? ` (${reason})` : ''}.`.slice(0, 500);

            const changed = await transaction(async client => {
                await query(`
                    insert into spot_closed_dates (spot_id, closed_date, reason, created_by_email) values ($1, $2, $3, $4)
                    on conflict (spot_id, closed_date) do update
                       set reason = case when excluded.reason <> '' then excluded.reason else spot_closed_dates.reason end`,
                    [spot._id, date, reason, who], client);
                const ids = async (sql, params) => (await query(sql, params, client)).rows.map(r => r.id);
                return {
                    tickets: await ids(`update tickets set status = 'closed'
                                         where spot_id = $1 and visit_date = $2 and status = 'valid' returning id`, [spot._id, date]),
                    // Never paid: no ticket to keep. A payment that still lands on
                    // one is recorded as a duplicate, for a refund.
                    unpaidTickets: await ids(`update tickets set status = 'cancelled'
                                         where spot_id = $1 and visit_date = $2 and status = 'pending_payment' returning id`, [spot._id, date]),
                    bookings: await ids(`update guide_bookings b set status = 'closed', status_note = $3, status_updated_at = now()
                                         where b.spot_id = $1 and b.preferred_date = $2 and b.status in ('pending_payment', 'confirmed')
                                           and exists (select 1 from payments p where p.booking_id = b.id and p.refunded_at is null) returning id`,
                                         [spot._id, date, note]),
                    unpaidBookings: await ids(`update guide_bookings b set status = 'cancelled', status_note = $3, status_updated_at = now()
                                         where b.spot_id = $1 and b.preferred_date = $2 and b.status = 'pending_payment'
                                           and not exists (select 1 from payments p where p.booking_id = b.id) returning id`,
                                         [spot._id, date, note])
                };
            });

            // After the record is safe, tell each visitor. (Required here, not at
            // the top: notices.js uses this file too.)
            const notices = require('./notices');
            const origin = `${req.protocol}://${req.get('host')}`;
            let emailed = 0;
            for (const id of changed.tickets) emailed += (await notices.closureNotice('ticket', id, { reason }, origin)).sent ? 1 : 0;
            for (const id of changed.bookings) emailed += (await notices.closureNotice('booking', id, { reason }, origin)).sent ? 1 : 0;
            for (const id of changed.unpaidBookings) emailed += (await notices.bookingCancelled(id, { byVisitor: false, reason: note }, origin)).sent ? 1 : 0;

            const affected = changed.tickets.length + changed.bookings.length;
            const told = affected + changed.unpaidBookings.length;
            console.log(`🚧 ${spot.title} closed on ${date} by ${who}: ${affected} to choose, ${changed.unpaidBookings.length + changed.unpaidTickets.length} unpaid cancelled`);
            res.status(201).json({
                success: true,
                message: `${spot.title} is closed on ${niceDate(date)}. ${affected
                    ? `${affected} visitor${affected === 1 ? '' : 's'} with a paid ticket or booking will choose a full refund or a new date.`
                    : 'Nothing paid was affected.'}${told ? ` ${emailed} of ${told} emailed.` : ''}`,
                changed: { tickets: changed.tickets.length, bookings: changed.bookings.length,
                           unpaidTickets: changed.unpaidTickets.length, unpaidBookings: changed.unpaidBookings.length },
                emailed
            });
        } catch (error) {
            console.error('❌ Closure failure:', error);
            fail(res, 500, 'Could not close that date.');
        }
    });

    router.delete('/spots/:id/closed-dates/:closedId', requireAdmin, async (req, res) => {
        try {
            const closed = await ClosedDate.findById(req.params.closedId);
            if (!closed || String(closed.spotId) !== String(req.params.id)) return fail(res, 404, 'That closed date no longer exists.');
            await ClosedDate.deleteById(closed._id);
            res.json({ success: true, message: `Open again on ${niceDate(closed.closedDate)}.` });
        } catch (error) {
            console.error('❌ Closed date removal failure:', error);
            fail(res, 500, 'Could not reopen that date.');
        }
    });

    return router;
};

module.exports.feeTable = feeTable;
module.exports.KINDS = KINDS;
module.exports.kindsOf = kindsOf;
module.exports.describeKinds = describeKinds;
module.exports.priceTickets = priceTickets;
module.exports.dayVerdict = dayVerdict;
module.exports.visitCalendar = visitCalendar;
module.exports.closedDatesFor = closedDatesFor;
module.exports.salesOn = salesOn;
module.exports.niceDate = niceDate;
module.exports.SENIOR_PWD_DISCOUNT = SENIOR_PWD_DISCOUNT;
