/* A hit counter for express-rate-limit that lives in MongoDB.
 *
 * The library's default store keeps its counts in the memory of the process
 * that happens to handle the request. That was fine while the API was one
 * long-running process. On a serverless host every warm instance has its own
 * memory, and so its own count: ten instances would allow ten times the
 * attempts, and a fresh instance starts every visitor back at zero. For the
 * login and password-reset limits that is the whole point gone.
 *
 * Every instance reads and writes the same document here instead, so a limit
 * of 10 means 10 however many instances are running.
 *
 * One document per (limiter, client) pair:
 *
 *   { _id: 'login:203.0.113.7', hits: 3, expiresAt: <end of this window> }
 *
 * The TTL index only tidies up. MongoDB sweeps expired documents about once a
 * minute, so one can outlive its window by up to that long — which is why
 * increment() checks expiresAt itself rather than trusting a document's mere
 * existence to mean the window is still open.
 */
const mongoose = require('mongoose');

const RateLimitHitSchema = new mongoose.Schema({
    _id: String,
    hits: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true }
}, { versionKey: false });

RateLimitHitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RateLimitHit = mongoose.models.RateLimitHit
    || mongoose.model('RateLimitHit', RateLimitHitSchema, 'ratelimits');

class MongoRateLimitStore {
    /* `prefix` keeps each limiter's counts apart. Two limiters sharing a
       prefix would add their hits together for the same visitor. */
    constructor(prefix) {
        if (!prefix) throw new Error('MongoRateLimitStore needs a prefix.');
        this.prefix = `${prefix}:`;
        this.localKeys = false;
        this.windowMs = 60 * 1000;
    }

    init(options) {
        this.windowMs = options.windowMs;
    }

    async get(key) {
        const doc = await RateLimitHit.findById(this.prefix + key).lean();
        if (!doc || doc.expiresAt <= new Date()) return undefined;
        return { totalHits: doc.hits, resetTime: doc.expiresAt };
    }

    /* Counting and starting a new window happen in one atomic update, so two
       instances handling the same visitor at the same moment cannot both read
       "2" and both write "3".

       Both $cond branches test the document's expiresAt as it was *before*
       this update — within one $set stage every expression sees the input
       document — so they always agree on whether the window is still open.
       An upserted document has no expiresAt at all, which compares as not
       open, so a first visit starts a window at one hit. */
    async increment(key) {
        const now = new Date();
        const windowOpen = { $gt: ['$expiresAt', now] };

        const doc = await RateLimitHit.findOneAndUpdate(
            { _id: this.prefix + key },
            [{
                $set: {
                    hits: { $cond: [windowOpen, { $add: [{ $ifNull: ['$hits', 0] }, 1] }, 1] },
                    expiresAt: { $cond: [windowOpen, '$expiresAt', new Date(now.getTime() + this.windowMs)] }
                }
            }],
            // Mongoose 9 refuses an array update unless told it is a pipeline.
            { upsert: true, new: true, updatePipeline: true, lean: true }
        );

        return { totalHits: doc.hits, resetTime: doc.expiresAt };
    }

    /* Used when a limiter is set to skip successful or failed requests. None
       here are, but the interface requires it. */
    async decrement(key) {
        await RateLimitHit.updateOne(
            { _id: this.prefix + key, hits: { $gt: 0 }, expiresAt: { $gt: new Date() } },
            { $inc: { hits: -1 } }
        );
    }

    async resetKey(key) {
        await RateLimitHit.deleteOne({ _id: this.prefix + key });
    }

    async resetAll() {
        await RateLimitHit.deleteMany({ _id: { $regex: `^${this.prefix}` } });
    }
}

module.exports = { MongoRateLimitStore, RateLimitHit };
