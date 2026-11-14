/* Signed-in guests manage only their own room bookings. */
const express=require('express');
const bookings=require('./bookings');
const {requireVisitor}=require('./visitors');
const problem=(status,message)=>Object.assign(new Error(message),{status});
const NOT_FOUND='This booking is not in your account.';
async function findRecord(code,visitorId){
    const record=await bookings.findOwnBooking(code,visitorId);
    return record?{record}:null;
}
module.exports = function manageRouter({ sharedRateLimit, siteOrigin }) {
    const router = express.Router();
    const limit = sharedRateLimit('manage', {
        windowMs: 60 * 60 * 1000,
        limit: 40,
        // Per account: the routes need a signed-in visitor.
        keyGenerator: req => `visitor:${req.visitor.id}`,
        message: { success: false, message: 'Too many tries. Please wait a while, or contact the Municipal Tourism Office.' }
    });

    const fail = (res, error, label) => {
        if (error && error.status) return res.status(error.status).json({ success: false, message: error.message });
        console.error(label, error);
        return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    };

    async function load(req) {
        const found = await findRecord(req.body && req.body.code, req.visitor.id);
        if (!found || !found.record) throw problem(404, NOT_FOUND);
        return found;
    }

    router.post('/manage/lookup', requireVisitor, limit, async (req, res) => {
        try {
            const found = await load(req);

            await bookings.sweepBookings(siteOrigin(req)).catch(error => console.error('❌ Booking sweep failure:', error));
            // Back from paying online: the payment shows at once.
            await require('./booking-payments').settlePendingFor(found.record.id, siteOrigin(req)).catch(() => {});
            const fresh = await load(req);
            return res.json({ success: true, item: await bookings.describeForVisitor(fresh.record) });
        } catch (error) { fail(res, error, '❌ Manage lookup failure:'); }
    });

    router.post('/manage/move', requireVisitor, limit, async (req, res) => {
        try {
            const found = await load(req);

            const done = await bookings.visitorMove(found.record, req.body, siteOrigin(req));
            const fresh = await load(req);
            return res.json({ success: true, emailed: done.emailed,
                message: 'New dates sent to the resort. It will confirm or decline them by email.',
                item: await bookings.describeForVisitor(fresh.record) });
        } catch (error) { fail(res, error, '❌ Manage move failure:'); }
    });

    router.post('/manage/cancel', requireVisitor, limit, async (req, res) => {
        try {
            const found = await load(req);

            const done = await bookings.visitorCancel(found.record, siteOrigin(req));
            const fresh = await load(req);
            return res.json({ success: true, emailed: done.emailed, refunded: done.refunded,
                message: done.refunded ? `Cancelled. ₱${done.refunded.toLocaleString('en-PH')} is on its way back to you. The resort has been told.` : 'Cancelled. The resort has been told.',
                item: await bookings.describeForVisitor(fresh.record) });
        } catch (error) { fail(res, error, '❌ Manage cancel failure:'); }
    });

    return router;
};
