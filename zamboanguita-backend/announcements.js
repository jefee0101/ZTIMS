/* Announcements and the calendar of events.
 *
 * Only the Tourism Officer posts; there is no approval step, so a notice is
 * live when it is saved. The public sees a notice until its end, and an event
 * that has ended moves to the past events. Nothing is deleted: `hidden` takes
 * a notice down and brings it back, and the officer's list keeps everything.
 * Times are Manila time: a time typed without an offset is read as Manila's.
 *
 * Mounted at /api by server.js, which hands over its sign-in check and the
 * listing photos' source check (the same hosts as listings).
 */
const express = require('express');
const { query } = require('./db');
const { announcements: Announcement, ANNOUNCEMENT_CATEGORIES } = require('./models');

const TITLE_MAX = 140;
const BODY_MAX = 4000;
const PAGE_MAX = 50;
const isId = value => /^[0-9a-f]{24}$/i.test(String(value || ''));

/* "2026-11-21T07:00" is Manila's 7 AM; a time with its own offset or Z is
   taken as given. Null when it is not a time at all. */
function manilaTime(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const local = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(text);
    const date = new Date(local ? text.replace(' ', 'T') + '+08:00' : text);
    return Number.isNaN(date.getTime()) ? null : date;
}

/* One row as the pages read it. `state` saves every page working it out. */
function shape(row, { officer = false } = {}) {
    const now = Date.now();
    const ended = new Date(row.ends_at).getTime() < now;
    const item = {
        _id: row.id,
        category: row.category,
        title: row.title,
        body: row.body,
        bodyOther: row.body_other,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        spotId: row.spot_id,
        place: row.place_title ? { _id: row.spot_id, title: row.place_title, barangay: row.place_barangay || '' } : null,
        photoUrl: row.photo_url,
        state: row.hidden ? 'hidden' : ended ? 'ended' : new Date(row.starts_at).getTime() > now ? 'upcoming' : 'live',
        updatedAt: row.updated_at
    };
    if (officer) {
        item.hidden = row.hidden;
        item.createdByEmail = row.created_by_email;
        item.createdAt = row.created_at;
    }
    return item;
}

/* A notice with its place. The public only sees a place that is itself on
   the site; the officer sees whatever the notice points at. */
const SELECT = (publicOnly) => `
    select a.*, s.title as place_title, s.barangay as place_barangay
      from announcements a
      left join spots s on s.id = a.spot_id${publicOnly ? " and s.status = 'published'" : ''}`;

function paging(q) {
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 10, 1), PAGE_MAX);
    const page = Math.max(parseInt(q.page, 10) || 1, 1);
    return { limit, page, offset: (page - 1) * limit };
}

const publicCache = res => res.set('Cache-Control', 'public, max-age=60');

module.exports = function announcementsRouter({ requireAdmin, checkPhotoSources }) {
    const router = express.Router();

    const fail = (res, error, context) => {
        console.error(context, error);
        if (error && (error.name === 'ValidationError' || error.status === 400)) {
            return res.status(400).json({ success: false, message: error.message });
        }
        return res.status(500).json({ success: false, message: 'The announcements could not be loaded or saved.' });
    };

    /* PUBLIC: notices on the site now (not hidden, not ended), newest first.
       ?category= one of the four, ?spotId= one destination's, ?page=&limit=. */
    router.get('/announcements', async (req, res) => {
        try {
            const params = [];
            let where = 'where not a.hidden and a.ends_at >= now()';
            if (req.query.category) {
                if (!ANNOUNCEMENT_CATEGORIES.includes(req.query.category)) {
                    return res.status(400).json({ success: false, message: 'Choose advisory, event, closure or general.' });
                }
                params.push(req.query.category);
                where += ` and a.category = $${params.length}`;
            }
            if (req.query.spotId) {
                if (!isId(req.query.spotId)) return res.json({ items: [], total: 0, page: 1, pages: 0 });
                params.push(String(req.query.spotId));
                where += ` and a.spot_id = $${params.length}`;
            }
            const { limit, page, offset } = paging(req.query);
            const [{ rows }, { rows: count }] = await Promise.all([
                query(`${SELECT(true)} ${where} order by a.starts_at desc, a.created_at desc limit ${limit} offset ${offset}`, params),
                query(`select count(*)::int as n from announcements a ${where}`, params)
            ]);
            publicCache(res);
            return res.json({ items: rows.map(r => shape(r)), total: count[0].n, page, pages: Math.ceil(count[0].n / limit) });
        } catch (error) {
            return fail(res, error, '❌ Announcements list failure:');
        }
    });

    /* OFFICER: everything, hidden and ended included, newest first. */
    router.get('/announcements/admin', requireAdmin, async (req, res) => {
        try {
            const { rows } = await query(`${SELECT(false)} order by a.starts_at desc, a.created_at desc`);
            res.set('Cache-Control', 'no-store');
            return res.json(rows.map(r => shape(r, { officer: true })));
        } catch (error) {
            return fail(res, error, '❌ Announcements admin list failure:');
        }
    });

    /* PUBLIC: one notice. A past event stays readable (it is on Past events);
       any other ended notice, and a hidden one, is gone. */
    router.get('/announcements/:id', async (req, res) => {
        try {
            if (!isId(req.params.id)) return res.status(404).json({ success: false, message: 'That notice could not be found.' });
            const { rows } = await query(
                `${SELECT(true)} where a.id = $1 and not a.hidden and (a.ends_at >= now() or a.category = 'event')`, [req.params.id]);
            if (!rows.length) return res.status(404).json({ success: false, message: 'That notice could not be found.' });
            publicCache(res);
            return res.json(shape(rows[0]));
        } catch (error) {
            return fail(res, error, '❌ Announcement read failure:');
        }
    });

    /* PUBLIC: events for the calendar. ?month=YYYY-MM gives every event that
       touches that Manila month, ended ones included; without it, the events
       still to come (?limit=, soonest first). */
    router.get('/events', async (req, res) => {
        try {
            if (req.query.month !== undefined) {
                const match = /^(\d{4})-(\d{2})$/.exec(String(req.query.month));
                const month = match ? Number(match[2]) : 0;
                if (!match || month < 1 || month > 12) return res.status(400).json({ success: false, message: 'Give the month as YYYY-MM.' });
                const year = Number(match[1]);
                const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
                const { rows } = await query(
                    `${SELECT(true)} where a.category = 'event' and not a.hidden
                        and a.starts_at < ($2 || '-01T00:00:00+08:00')::timestamptz
                        and a.ends_at >= ($1 || '-01T00:00:00+08:00')::timestamptz
                      order by a.starts_at`, [match[0], next]);
                publicCache(res);
                return res.json(rows.map(r => shape(r)));
            }
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), PAGE_MAX);
            const { rows } = await query(
                `${SELECT(true)} where a.category = 'event' and not a.hidden and a.ends_at >= now()
                  order by a.starts_at limit ${limit}`);
            publicCache(res);
            return res.json(rows.map(r => shape(r)));
        } catch (error) {
            return fail(res, error, '❌ Events read failure:');
        }
    });

    /* PUBLIC: events that have ended, the latest first, a page at a time. */
    router.get('/events/past', async (req, res) => {
        try {
            const { limit, page, offset } = paging(req.query);
            const where = `where a.category = 'event' and not a.hidden and a.ends_at < now()`;
            const [{ rows }, { rows: count }] = await Promise.all([
                query(`${SELECT(true)} ${where} order by a.ends_at desc limit ${limit} offset ${offset}`),
                query(`select count(*)::int as n from announcements a ${where}`)
            ]);
            publicCache(res);
            return res.json({ items: rows.map(r => shape(r)), total: count[0].n, page, pages: Math.ceil(count[0].n / limit) });
        } catch (error) {
            return fail(res, error, '❌ Past events read failure:');
        }
    });

    /* What the officer sent, checked. Throws a 400 with the reason. */
    async function readNotice(body, existing) {
        const bad = message => Object.assign(new Error(message), { status: 400 });
        const b = body || {};
        const category = String(b.category || '');
        if (!ANNOUNCEMENT_CATEGORIES.includes(category)) throw bad('Choose advisory, event, closure or general.');
        const title = String(b.title || '').trim();
        if (!title) throw bad('Give the notice a title.');
        if (title.length > TITLE_MAX) throw bad(`Keep the title to ${TITLE_MAX} characters.`);
        const text = String(b.body || '').trim();
        if (!text) throw bad('Write the text in English.');
        if (text.length > BODY_MAX) throw bad(`Keep the text to ${BODY_MAX} characters.`);
        const other = String(b.bodyOther || '').trim();
        if (other.length > BODY_MAX) throw bad(`Keep the Filipino or Bisaya text to ${BODY_MAX} characters.`);
        const startsAt = manilaTime(b.startsAt);
        const endsAt = manilaTime(b.endsAt);
        if (!startsAt) throw bad('Give the start date and time.');
        if (!endsAt) throw bad('Give the end date and time.');
        if (endsAt < startsAt) throw bad('The end cannot be before the start.');

        let spotId = null;
        if (b.spotId) {
            if (!isId(b.spotId)) throw bad('That place could not be found.');
            const { rows } = await query('select id from spots where id = $1', [String(b.spotId)]);
            if (!rows.length) throw bad('That place could not be found.');
            spotId = rows[0].id;
        }
        const photoUrl = String(b.photoUrl || '').trim();
        if (photoUrl.length > 500) throw bad('That photo link is too long.');
        checkPhotoSources([photoUrl], existing ? [existing.photoUrl] : []);

        return { category, title, body: text, bodyOther: other, startsAt, endsAt, spotId, photoUrl };
    }

    async function officerEmail(req) {
        const { rows } = await query('select email from tourism_officers where id = $1', [String(req.auth.sub)]);
        return rows[0] ? rows[0].email : '';
    }

    async function readBack(id) {
        const { rows } = await query(`${SELECT(false)} where a.id = $1`, [id]);
        return shape(rows[0], { officer: true });
    }

    /* OFFICER: post a notice. Live when saved. */
    router.post('/announcements', requireAdmin, async (req, res) => {
        try {
            const notice = await readNotice(req.body);
            const saved = await Announcement.create({ ...notice, createdByEmail: await officerEmail(req) });
            console.log(`📣 Officer posted "${notice.title}" (${notice.category})`);
            return res.status(201).json({ success: true, message: 'Published.', announcement: await readBack(saved._id) });
        } catch (error) {
            return fail(res, error, '❌ Announcement create failure:');
        }
    });

    /* OFFICER: change a notice. Hidden or shown stays as it was. */
    router.put('/announcements/:id', requireAdmin, async (req, res) => {
        try {
            const existing = isId(req.params.id) ? await Announcement.findById(req.params.id) : null;
            if (!existing) return res.status(404).json({ success: false, message: 'That notice could not be found.' });
            Object.assign(existing, await readNotice(req.body, existing));
            await Announcement.save(existing);
            return res.json({ success: true, message: 'Saved.', announcement: await readBack(existing._id) });
        } catch (error) {
            return fail(res, error, '❌ Announcement update failure:');
        }
    });

    /* OFFICER: take a notice off the site, or put it back. Never deleted. */
    router.patch('/announcements/:id/hidden', requireAdmin, async (req, res) => {
        try {
            if (typeof (req.body || {}).hidden !== 'boolean') return res.status(400).json({ success: false, message: 'Say whether to hide or show it.' });
            const existing = isId(req.params.id) ? await Announcement.findById(req.params.id) : null;
            if (!existing) return res.status(404).json({ success: false, message: 'That notice could not be found.' });
            existing.hidden = req.body.hidden;
            await Announcement.save(existing);
            return res.json({ success: true, message: existing.hidden ? 'Hidden.' : 'Shown.', announcement: await readBack(existing._id) });
        } catch (error) {
            return fail(res, error, '❌ Announcement hide failure:');
        }
    });

    return router;
};

module.exports.manilaTime = manilaTime;
