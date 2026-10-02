/* Keeping visitors' personal data no longer than needed (Data Privacy Act of
 * 2012, Section 11: kept only as long as the purpose requires).
 *
 * A visitor's name, phone number and email are needed for the tour or ticket,
 * a refund or complaint about it, and that year's reports. One year after the
 * visit they are erased; what is left — the date, the destination, how many
 * people, the country, the amount paid and its OR number — names nobody and
 * keeps Statistics and Collections whole. Feedback loses its name and email one
 * year after it was resolved; the message stays.
 *
 * Runs daily from Vercel's cron (GET /api/maintenance/privacy, CRON_SECRET),
 * and whenever the officer opens Guide Bookings, so it happens even where no
 * cron is set up. Running it twice changes nothing the second time.
 */
const { query, transaction } = require('./db');

const ERASED_NAME = 'Removed after one year (privacy)';
const RETAIN = "interval '1 year'";
const MANILA_TODAY = "(now() at time zone 'Asia/Manila')::date";

async function forgetOldVisitors() {
    return transaction(async client => {
        const bookings = await query(
            `update guide_bookings set full_name = $1, contact_number = '', email = '', notes = ''
              where preferred_date < ${MANILA_TODAY} - ${RETAIN} and full_name <> $1`, [ERASED_NAME], client);
        const tickets = await query(
            `update tickets set full_name = $1, contact_number = '', email = ''
              where visit_date < ${MANILA_TODAY} - ${RETAIN} and full_name <> $1`, [ERASED_NAME], client);
        const feedback = await query(
            `update feedback set name = '', email = ''
              where status = 'resolved' and coalesce(status_updated_at, created_at) < now() - ${RETAIN}
                and (name <> '' or email <> '')`, [], client);
        const done = { bookings: bookings.rowCount, tickets: tickets.rowCount, feedback: feedback.rowCount };
        if (done.bookings + done.tickets + done.feedback) {
            console.log(`🔒 Privacy: personal details erased from ${done.bookings} booking(s), ${done.tickets} ticket(s), ${done.feedback} feedback message(s) older than a year.`);
        }
        return done;
    });
}

module.exports = { forgetOldVisitors, ERASED_NAME };
