/* Stable Xendit callback path for room-booking payments only. */
const express=require('express');
const {gatewayState,callbackTokenMatches,siteOrigin}=require('./xendit-gateway');
module.exports=function paymentsRouter(){
    const router=express.Router();
    router.post('/payments/webhook', async (req, res) => {
        try {
            if (!String(process.env.XENDIT_CALLBACK_TOKEN || '').trim() || !gatewayState().online) return res.status(404).end();
            if (!callbackTokenMatches(req.get('x-callback-token'))) return res.status(401).end();

            const body = req.body || {};
            const invoiceId = typeof body.id === 'string' ? body.id : '';
            const externalId = typeof body.external_id === 'string' ? body.external_id : '';
            // A room booking's invoice (booking-payments.js) is settled there,
            // by the same rule: ask Xendit, never believe the body.
            const bookingMatch = /^ztims-b-([0-9a-f]{24})$/.exec(externalId);
            if (invoiceId && bookingMatch) {
                const settled = await require('./booking-payments').settleById(bookingMatch[1], invoiceId, siteOrigin(req));
                return res.status(200).json(settled ? { received: true } : { ignored: true });
            }
            return res.status(200).json({ ignored: true });
        } catch (error) {
            // A non-2xx makes Xendit try again later, which is what we want
            // when the gateway or the database was briefly unreachable.
            console.error('❌ Payment webhook failure:', error && error.message);
            return res.status(500).end();
        }
    });

    return router;
};
