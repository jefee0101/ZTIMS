/* The three tasks that used to run every time the server started.
 *
 *   migrateEstablishmentNames  — renames carried over from "resort owner"
 *   migrateSpotManagement      — fills in which manager owns which listing
 *   bootstrapAdmin             — creates the first Tourism Officer, if none
 *
 * They ran on boot because there was exactly one boot: one process, started
 * once, serving until it stopped. A serverless host has no such moment. Every
 * cold instance would run all three, and bootstrapAdmin would race with itself
 * across instances that each believe they are the first.
 *
 * So they are run deliberately, by a person, with `npm run migrate`. All three
 * are idempotent and all three have already run against the live database —
 * this exists for a fresh database, or to use INITIAL_ADMIN_EMAIL /
 * INITIAL_ADMIN_PASSWORD (and ADMIN_PASSWORD_RESET) once and then delete them.
 *
 * Reading the environment the same way the server does, it needs the same
 * variables set — at minimum MONGO_URI and JWT_SECRET.
 */
require('dotenv').config();

const app = require('./server');

app.runMigrations()
    .then(() => {
        console.log('✅ Migrations finished.');
        // The connection pool keeps the event loop alive, so say when to stop.
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Migrations failed:', error);
        // Non-zero, so a CI step or a shell `&&` chain actually notices.
        process.exit(1);
    });
