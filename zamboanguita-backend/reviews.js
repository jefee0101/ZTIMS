/* Reviews of places (November 2026), mounted at /api.

   The user's decisions:
   - Only a signed-in visitor who has been there may review a place: a completed stay of theirs there. The server checks it; the page only hides the form.
   - One review per visitor per place (reviews_one_per_place). The visitor may
     edit or delete their own. Editing a review the officer hid keeps it hidden.
   - The Tourism Officer may hide a review, or show it again, always with a
     reason; each is a review_changes row. Hidden reviews leave the public's
     list and its average. Managers cannot reply, and nobody but the officer
     can hide.
   - Ratings and counts only: nothing here carries a price or money.
   - A deleted account's reviews stay, shown as "Former visitor". */
const express = require('express');
const { query, transaction } = require('./db');
const { requireVisitor, FORMER_VISITOR } = require('./visitors');

const MAX_BODY = 600;
const MAX_REASON = 300;
const PAGE = 10;

const isId = value => /^[0-9a-f]{24}$/i.test(String(value || ''));
const problem = (status, message, code) => Object.assign(new Error(message), { status, code });

/* "Maria Santos" → "Maria S.": enough to be a person, not a full name. */
function publicName(fullName, status) {
    if (status === 'deleted') return FORMER_VISITOR;
    const words = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'Visitor';
    return words.length === 1 ? words[0] : `${words[0]} ${words[words.length - 1][0].toUpperCase()}.`;
}

/* A rating is a whole number from 1 to 5, and the text at most 600 characters. */
function readReview(body) {
    const b = body || {};
    const rating = Number(b.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw problem(400, 'Choose a rating from 1 to 5 stars.', 'BAD_RATING');
    if (b.body !== undefined && typeof b.body !== 'string') throw problem(400, 'Write the review as text.');
    const text = String(b.body || '').trim();
    if (text.length > MAX_BODY) throw problem(400, `Keep the review to ${MAX_BODY} characters.`, 'TOO_LONG');
    return { rating, body: text };
}

const summaryOf = row => ({
    average: row && Number(row.count) ? Math.round(Number(row.average) * 10) / 10 : null,
    count: row ? Number(row.count) : 0
});

async function publishedSpot(spotId) {
    if (!isId(spotId)) throw problem(404, 'That place could not be found.');
    const { rows } = await query(`select id, title from spots where id = $1 and status = 'published'`, [spotId]);
    if (!rows.length) throw problem(404, 'That place could not be found.');
    return rows[0];
}

/* The visit that lets this visitor review the place: their latest completed stay. Null when there is none. */
async function proofOfVisit(visitorId, spotId, client) {
    const b = await query(`
        select b.id from bookings b join spots s on s.id=b.spot_id and s.type='accommodation'
         where b.visitor_id = $1 and b.spot_id = $2 and b.status = 'completed'
         order by b.check_out desc limit 1`, [visitorId, spotId], client);
    if (b.rows.length) return { bookingId: b.rows[0].id };
    return null;
}

const ownView = r => r && ({
    _id: r.id, rating: r.rating, body: r.body, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at
});

function reviewsRouter({ requireAdmin, sharedRateLimit }) {
    const router = express.Router();
    const writeLimit = sharedRateLimit('review-write', {
        windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
        message: { success: false, message: 'Too many changes. Please wait a while.' },
        keyGenerator: req => `visitor:${req.visitor ? req.visitor.id : req.ip}`
    });
    const fail = (res, error, label) => {
        if (error && error.status) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
        if (error && error.code === 11000) return res.status(409).json({ success: false, code: 'ALREADY_REVIEWED', message: 'You have already reviewed this place. Edit your review instead.' });
        console.error(label, error);
        return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    };

    /* ---- the public ------------------------------------------------- */

    // Every published place with visible reviews: its average and count, for
    // the cards on Home and Destinations.
    router.get('/reviews/summary', async (req, res) => {
        try {
            const { rows } = await query(`
                select r.spot_id, avg(r.rating) as average, count(*) as count
                  from reviews r join spots s on s.id = r.spot_id
                 where r.status = 'visible' and s.status = 'published' and s.type='accommodation'
                 group by r.spot_id`);
            res.set('Cache-Control', 'public, max-age=60');
            return res.json(Object.fromEntries(rows.map(r => [r.spot_id, summaryOf(r)])));
        } catch (error) { return fail(res, error, '❌ Review summary failure:'); }
    });

    // A place's visible reviews, newest first, with its average, its count and
    // how many gave each number of stars.
    router.get('/spots/:spotId/reviews', async (req, res) => {
        try {
            const spot = await publishedSpot(req.params.spotId);
            const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
            const [totals, stars, items] = await Promise.all([
                query(`select avg(rating) as average, count(*) as count from reviews where spot_id = $1 and status = 'visible'`, [spot.id]),
                query(`select rating, count(*) as count from reviews where spot_id = $1 and status = 'visible' group by rating`, [spot.id]),
                query(`
                    select r.id, r.rating, r.body, r.created_at, r.updated_at, v.full_name, v.status as visitor_status,
                           (r.booking_id is not null) as stayed
                      from reviews r join visitors v on v.id = r.visitor_id
                     where r.spot_id = $1 and r.status = 'visible'
                     order by r.created_at desc, r.id
                     limit $2 offset $3`, [spot.id, PAGE, (page - 1) * PAGE])
            ]);
            const summary = summaryOf(totals.rows[0]);
            const byStars = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
            for (const s of stars.rows) byStars[s.rating] = Number(s.count);
            res.set('Cache-Control', 'public, max-age=30');
            return res.json({
                ...summary, byStars, page, pages: Math.max(1, Math.ceil(summary.count / PAGE)),
                items: items.rows.map(r => ({
                    _id: r.id, rating: r.rating, body: r.body, author: publicName(r.full_name, r.visitor_status),
                    visit: r.stayed ? 'stay' : 'visit', createdAt: r.created_at
                }))
            });
        } catch (error) { return fail(res, error, '❌ Place reviews failure:'); }
    });

    /* ---- the signed-in visitor ------------------------------------- */

    // Whether this visitor may review the place, and their review if any.
    router.get('/spots/:spotId/reviews/mine', requireVisitor, async (req, res) => {
        try {
            const spot = await publishedSpot(req.params.spotId);
            const { rows } = await query('select * from reviews where visitor_id = $1 and spot_id = $2', [req.visitor.id, spot.id]);
            const proof = rows.length ? null : await proofOfVisit(req.visitor.id, spot.id);
            return res.json({ review: ownView(rows[0]) || null, canReview: !rows.length && Boolean(proof) });
        } catch (error) { return fail(res, error, '❌ Own review failure:'); }
    });

    router.post('/spots/:spotId/reviews', requireVisitor, writeLimit, async (req, res) => {
        try {
            const spot = await publishedSpot(req.params.spotId);
            const { rating, body } = readReview(req.body);
            const row = await transaction(async client => {
                const had = await query('select id from reviews where visitor_id = $1 and spot_id = $2', [req.visitor.id, spot.id], client);
                if (had.rows.length) throw problem(409, 'You have already reviewed this place. Edit your review instead.', 'ALREADY_REVIEWED');
                const proof = await proofOfVisit(req.visitor.id, spot.id, client);
                if (!proof) throw problem(403, 'You can review a place after a completed stay there.', 'NO_VISIT');
                const { rows } = await query(`
                    insert into reviews (visitor_id, spot_id, rating, body, booking_id)
                    values ($1, $2, $3, $4, $5) returning *`,
                    [req.visitor.id, spot.id, rating, body, proof.bookingId], client);
                return rows[0];
            });
            return res.status(201).json({ success: true, message: 'Thank you. Your review is posted.', review: ownView(row) });
        } catch (error) { return fail(res, error, '❌ Post review failure:'); }
    });

    async function ownReview(req) {
        if (!isId(req.params.id)) throw problem(404, 'That review could not be found.');
        const { rows } = await query('select * from reviews where id = $1 and visitor_id = $2', [req.params.id, req.visitor.id]);
        if (!rows.length) throw problem(404, 'That review could not be found.');
        return rows[0];
    }

    router.put('/reviews/:id', requireVisitor, writeLimit, async (req, res) => {
        try {
            const old = await ownReview(req);
            const { rating, body } = readReview(req.body);
            const { rows } = await query(
                'update reviews set rating = $2, body = $3 where id = $1 returning *', [old.id, rating, body]);
            const hidden = rows[0].status === 'hidden';
            return res.json({
                success: true, review: ownView(rows[0]),
                message: hidden ? 'Saved. It stays hidden by the Tourism Office.' : 'Your review is updated.'
            });
        } catch (error) { return fail(res, error, '❌ Edit review failure:'); }
    });

    router.delete('/reviews/:id', requireVisitor, writeLimit, async (req, res) => {
        try {
            const old = await ownReview(req);
            await query('delete from reviews where id = $1', [old.id]);
            return res.json({ success: true, message: 'Your review is deleted.' });
        } catch (error) { return fail(res, error, '❌ Delete review failure:'); }
    });

    /* ---- the Tourism Officer --------------------------------------- */

    // Every review, hidden ones too, with its place and the reasons given.
    // The author's name only: never their email, nor any price or money.
    router.get('/reviews/admin', requireAdmin, async (req, res) => {
        try {
            const { rows } = await query(`
                select r.id, r.rating, r.body, r.status, r.hidden_reason, r.hidden_by_email, r.hidden_at,
                       r.created_at, r.updated_at, (r.booking_id is not null) as stayed,
                       s.id as spot_id, s.title as spot_title, s.status as spot_status,
                       v.full_name, v.status as visitor_status,
                       (select json_agg(json_build_object('action', c.action, 'reason', c.reason, 'by', c.by_email, 'at', c.at) order by c.at)
                          from review_changes c where c.review_id = r.id) as history
                  from reviews r join spots s on s.id = r.spot_id join visitors v on v.id = r.visitor_id
                 order by r.created_at desc
                 limit 2000`);
            return res.json(rows.map(r => ({
                _id: r.id, rating: r.rating, body: r.body, status: r.status,
                hiddenReason: r.hidden_reason, hiddenBy: r.hidden_by_email, hiddenAt: r.hidden_at,
                createdAt: r.created_at, updatedAt: r.updated_at,
                visit: r.stayed ? 'stay' : 'visit',
                author: r.visitor_status === 'deleted' ? FORMER_VISITOR : (r.full_name || 'Visitor'),
                spot: { _id: r.spot_id, title: r.spot_title, published: r.spot_status === 'published' },
                history: r.history || []
            })));
        } catch (error) { return fail(res, error, '❌ Officer reviews failure:'); }
    });

    // Hide or show again; a reason is required either way.
    router.patch('/reviews/:id/visibility', requireAdmin, async (req, res) => {
        try {
            if (!isId(req.params.id)) throw problem(404, 'That review could not be found.');
            const hide = req.body && req.body.hidden;
            if (typeof hide !== 'boolean') throw problem(400, 'Say whether to hide the review.');
            const reason = String((req.body && req.body.reason) || '').trim();
            if (reason.length < 3) throw problem(400, 'Give a reason.', 'REASON_REQUIRED');
            if (reason.length > MAX_REASON) throw problem(400, `Keep the reason to ${MAX_REASON} characters.`);
            const by = String((req.account && req.account.email) || '');
            const row = await transaction(async client => {
                const { rows } = await query('select * from reviews where id = $1 for update', [req.params.id], client);
                if (!rows.length) throw problem(404, 'That review could not be found.');
                if ((rows[0].status === 'hidden') === hide) throw problem(409, hide ? 'That review is already hidden.' : 'That review is already shown.');
                const updated = hide
                    ? await query(`update reviews set status = 'hidden', hidden_reason = $2, hidden_by_email = $3, hidden_at = now() where id = $1 returning *`, [rows[0].id, reason, by], client)
                    : await query(`update reviews set status = 'visible', hidden_reason = '', hidden_by_email = '', hidden_at = null where id = $1 returning *`, [rows[0].id], client);
                await query('insert into review_changes (review_id, action, reason, by_email) values ($1, $2, $3, $4)',
                    [rows[0].id, hide ? 'hidden' : 'shown', reason, by], client);
                return updated.rows[0];
            });
            return res.json({ success: true, status: row.status, message: hide ? 'Review hidden from the public.' : 'Review shown again.' });
        } catch (error) { return fail(res, error, '❌ Review visibility failure:'); }
    });

    return router;
}

module.exports = reviewsRouter;
module.exports.publicName = publicName;
