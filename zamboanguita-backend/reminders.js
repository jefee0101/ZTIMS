/* The day-before reminder for a confirmed guide booking.
 *
 * Runs with the daily privacy job (Vercel's cron, GET /api/maintenance/privacy,
 * at 2 AM Manila) and whenever the officer opens Guide Bookings, so a tour
 * confirmed late the day before is still reminded. Each booking is claimed
 * before it is emailed (reminder_sent_at), so two runs at once send one email.
 * A booking moved to a later date is reminded again for the new date.
 */
const { query } = require('./db');
const notices = require('./notices');

const MANILA_TODAY = "(now() at time zone 'Asia/Manila')::date";

async function remindTomorrowsTours(origin) {
    let ids;
    try {
        ({ rows: ids } = await query(`
            update guide_bookings set reminder_sent_at = now()
             where status = 'confirmed' and email <> ''
               and preferred_date = ${MANILA_TODAY} + 1
               and coalesce((reminder_sent_at at time zone 'Asia/Manila')::date, '-infinity'::date) < ${MANILA_TODAY}
            returning id`));
    } catch (error) {
        // A database without reminder_sent_at yet (schema.sql not re-run).
        console.warn('⚠️  Tour reminders skipped:', error && error.message);
        return { reminded: 0 };
    }
    let reminded = 0;
    for (const { id } of ids) {
        if ((await notices.tourReminder(id, origin)).sent) reminded += 1;
    }
    if (ids.length) console.log(`⏰ Tour reminders: ${reminded} of ${ids.length} emailed for tomorrow.`);
    return { reminded, due: ids.length };
}

module.exports = { remindTomorrowsTours };
