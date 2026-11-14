/* Attraction opening days, displayed onsite fees and closures. Officer writes only. */
const express = require('express');
const { query } = require('./db');
const { spots: Spot, closedDates: ClosedDate, officers: TourismOfficer } = require('./models');
const { WEEK, NAMES, parseOpenDays, formatOpenDays, weekdayOf, isOpenOn } = require('./open-days');

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
   offered. Regular is the entrance fee. */
function feeTable(spot) {
    const regular = money(spot.entranceFee || spot.entrance_fee || 0);
    const student = spot.studentFee ?? spot.student_fee;
    const child = spot.childFee ?? spot.child_fee;
    const childAgeMax = spot.childAgeMax ?? spot.child_age_max;
    return {
        regular,
        student: student === null || student === undefined ? null : money(student),
        child: child === null || child === undefined || !childAgeMax ? null : money(child),
        childAgeMax: childAgeMax || null
    };
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

function setupView(spot, closedDates) {
    const fees = feeTable(spot);
    return {
        _id: spot._id,
        title: spot.title,
        type: spot.type,
        officeRun: !spot.managedBy,
        entranceFee: fees.regular,
        studentFee: spot.studentFee,
        childFee: spot.childFee,
        childAgeMax: spot.childAgeMax,
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

    // Both routes only mark the date closed. No purchase or refund side effects.
    async function closeDate(req,res){
        try{
            const spot=await Spot.findById(req.params.id);
            if(!spot)return fail(res,404,'That destination could not be found.');
            const date=String(req.body?.date || '').trim();
            const reason=String(req.body?.reason || '').trim().slice(0,200);
            if(!isDateKey(date))return fail(res,400,'Choose the date it is closed.');
            if(date<manilaToday())return fail(res,400,'That date has already passed.');
            const who=await officerEmail(req);
            await query(`insert into spot_closed_dates(spot_id,closed_date,reason,created_by_email) values($1,$2,$3,$4)
                on conflict(spot_id,closed_date) do update set reason=excluded.reason`,[spot._id,date,reason,who]);
            return res.status(201).json({success:true,message:`${spot.title} is closed on ${niceDate(date)}.`});
        }catch(error){console.error('Closure failure:',error);return fail(res,500,'Could not save that closed date.');}
    }
    router.post('/spots/:id/closed-dates',requireAdmin,closeDate);
    router.post('/spots/:id/close-date',requireAdmin,closeDate);

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
module.exports.dayVerdict = dayVerdict;
module.exports.visitCalendar = visitCalendar;
module.exports.closedDatesFor = closedDatesFor;
module.exports.niceDate = niceDate;
