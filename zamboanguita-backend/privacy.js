/* Erase old booking contact details and resolved-feedback contact details.
 * Counts and saved reports remain. Runs through the daily privacy maintenance. */
const { query, transaction } = require('./db');

const ERASED_NAME = 'Removed after one year (privacy)';
const RETAIN = "interval '1 year'";
const MANILA_TODAY = "(now() at time zone 'Asia/Manila')::date";

async function forgetOldVisitors() {
    return transaction(async client => {
        const feedback = await query(
            `update feedback set name = '', email = ''
              where status = 'resolved' and coalesce(status_updated_at, created_at) < now() - ${RETAIN}
                and (name <> '' or email <> '')`, [], client);
        // A room booking keeps its dates, rooms, counts, country and price;
        // the guest's name, email, phone and note go a year after check-out.
        const bookings = await query(
            `update bookings set guest_name = $1, email = '', phone = '', note = ''
              where check_out < ${MANILA_TODAY} - ${RETAIN} and guest_name <> $1`, [ERASED_NAME], client);
        const done = { feedback: feedback.rowCount, bookings: bookings.rowCount };
        if (done.feedback + done.bookings) {
            console.log(`🔒 Privacy: personal details erased from ${done.bookings} booking(s), ${done.feedback} feedback message(s) older than a year.`);
        }
        return done;
    }).then(async done => {
        // Shown on Settings → Data Privacy. Outside the erasure on purpose: a
        // database without this column yet must not stop the erasure itself.
        try {
            await query('update office_info set privacy_checked_at = now() where id = 1');
        } catch (error) {
            console.warn('⚠️  Could not record when the privacy check ran:', error && error.message);
        }
        return done;
    });
}

module.exports = { forgetOldVisitors, ERASED_NAME };
