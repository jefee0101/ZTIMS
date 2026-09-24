/* A hit counter for express-rate-limit that lives in the database.
 *
 * The library's default store keeps its counts in the memory of the process
 * that happens to handle the request. That was fine while the API was one
 * long-running process. On a serverless host every warm instance has its own
 * memory, and so its own count: ten instances would allow ten times the
 * attempts, and a fresh instance starts every visitor back at zero. For the
 * login and password-reset limits that is the whole point gone.
 *
 * Every instance reads and writes the same row here instead, so a limit of 10
 * means 10 however many instances are running.
 *
 * One row per (limiter, client) pair, in the rate_limits table:
 *
 *   key 'login:203.0.113.7' · hits 3 · expires_at <end of this window>
 *
 * The time comes from the database, not the instance, so every instance agrees
 * on when a window ends even if their clocks do not.
 */
const { query } = require('./db');

// How often an increment also sweeps expired rows away. Expired rows are
// already ignored, so this is tidying, not correctness — once in a hundred
// requests keeps the table small without a scheduled job.
const SWEEP_CHANCE = 0.01;

class PostgresRateLimitStore {
    /* `prefix` keeps each limiter's counts apart. Two limiters sharing a
       prefix would add their hits together for the same visitor. */
    constructor(prefix) {
        if (!prefix) throw new Error('PostgresRateLimitStore needs a prefix.');
        this.prefix = `${prefix}:`;
        this.localKeys = false;
        this.windowMs = 60 * 1000;
    }

    init(options) {
        this.windowMs = options.windowMs;
    }

    async get(key) {
        const { rows } = await query(
            `select hits, expires_at from rate_limits where key = $1 and expires_at > now()`,
            [this.prefix + key]
        );
        return rows[0] ? { totalHits: rows[0].hits, resetTime: rows[0].expires_at } : undefined;
    }

    /* Counting and starting a new window happen in one statement, so two
       instances handling the same visitor at the same moment cannot both read
       "2" and both write "3": the second waits for the first's row lock.

       Inside DO UPDATE, `rate_limits.` is the row as it was before this
       statement, for every expression alike — so both CASEs always agree on
       whether the window was still open. */
    async increment(key) {
        const { rows } = await query(
            `insert into rate_limits (key, hits, expires_at)
                 values ($1, 1, now() + $2 * interval '1 millisecond')
             on conflict (key) do update set
                 hits = case when rate_limits.expires_at > now() then rate_limits.hits + 1 else 1 end,
                 expires_at = case when rate_limits.expires_at > now() then rate_limits.expires_at else excluded.expires_at end
             returning hits, expires_at`,
            [this.prefix + key, this.windowMs]
        );

        if (Math.random() < SWEEP_CHANCE) {
            query(`delete from rate_limits where expires_at < now()`).catch(() => {});
        }

        return { totalHits: rows[0].hits, resetTime: rows[0].expires_at };
    }

    /* Used when a limiter is set to skip successful or failed requests. None
       here are, but the interface requires it. */
    async decrement(key) {
        await query(
            `update rate_limits set hits = hits - 1 where key = $1 and hits > 0 and expires_at > now()`,
            [this.prefix + key]
        );
    }

    async resetKey(key) {
        await query(`delete from rate_limits where key = $1`, [this.prefix + key]);
    }

    async resetAll() {
        await query(`delete from rate_limits where key like $1`, [this.prefix + '%']);
    }
}

module.exports = { PostgresRateLimitStore };
