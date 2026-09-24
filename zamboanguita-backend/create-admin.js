/* Creates a Tourism Officer account, or resets the password of an existing one.
 *
 *   INITIAL_ADMIN_EMAIL=… INITIAL_ADMIN_PASSWORD=… npm run create-admin
 *
 * Unlike `npm run migrate`, this changes an existing account's password
 * without asking for ADMIN_PASSWORD_RESET — running it by name is the
 * deliberate act. Remove both variables from wherever you set them afterwards.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query, closePool } = require('./db');

const { DATABASE_URL, INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD } = process.env;
if (!DATABASE_URL || !INITIAL_ADMIN_EMAIL || !INITIAL_ADMIN_PASSWORD) {
    throw new Error('Set DATABASE_URL, INITIAL_ADMIN_EMAIL, and INITIAL_ADMIN_PASSWORD before running this script.');
}

(async () => {
    const email = INITIAL_ADMIN_EMAIL.toLowerCase().trim();
    const passwordHash = await bcrypt.hash(INITIAL_ADMIN_PASSWORD, 12);
    // A reset also voids any emailed reset link still in flight.
    await query(
        `insert into tourism_officers (email, password_hash) values ($1, $2)
         on conflict (email) do update set password_hash = excluded.password_hash,
             reset_token_hash = null, reset_token_expires = null`,
        [email, passwordHash]
    );
    await closePool();
    console.log('Tourism Officer account created or updated.');
})().catch(async (error) => {
    console.error('Tourism Officer account setup failed:', error.message);
    await closePool().catch(() => {});
    process.exit(1);
});
