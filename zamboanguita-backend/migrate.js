/* Sets the database up, deliberately, by a person: `npm run migrate`.
 *
 *   db/schema.sql   — creates whatever tables, indexes and rules are missing.
 *                     Safe to run again; nothing that exists is touched.
 *   bootstrapAdmin  — creates the first Tourism Officer, if INITIAL_ADMIN_EMAIL
 *                     and INITIAL_ADMIN_PASSWORD are set and there is none.
 *
 * None of this runs when the server starts. A serverless host has no single
 * start: every cold instance would run it, and bootstrapAdmin would race with
 * itself across instances that each believe they are the first.
 *
 * Use it on a new database, after pulling a change to db/schema.sql, or to use
 * INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD (and ADMIN_PASSWORD_RESET) once
 * and then delete them. Moving the records over from MongoDB is a separate,
 * one-time step: scripts/copy-from-mongo.js.
 *
 * Reading the environment the same way the server does, it needs the same
 * variables set — at minimum DATABASE_URL and JWT_SECRET.
 */
require('dotenv').config();

const app = require('./server');

app.runMigrations()
    .then(() => {
        console.log('✅ Migrations finished.');
        // Said explicitly: an open connection pool would keep the process alive.
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Migrations failed:', error);
        // Non-zero, so a CI step or a shell `&&` chain actually notices.
        process.exit(1);
    });
