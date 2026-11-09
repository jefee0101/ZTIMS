/* The Support Staff portal's shared bits (src/staff/*.html; the API is
   zamboanguita-backend/support-staff.js): reads the signed-in person and
   their one attraction once per page (GET /api/support-staff/me), puts the
   attraction's name in the header (#staffPlace) and the person's name in the
   "Entered by" banner (#staffWho / #staffWhoName), and keeps the corner
   menu's name current.

   window.ztimsStaff.me() → a promise of { fullName, position, email, spot: {
   _id, title, … } }, or null when it could not be read. Nothing here is a
   control: the server decides what Support Staff may do. */
(function () {
    'use strict';

    let promise = null;
    function me() {
        if (!promise) {
            promise = fetch('/api/support-staff/me', {
                headers: { Authorization: 'Bearer ' + (localStorage.getItem('authToken') || '') }
            }).then(r => (r.ok ? r.json() : null)).catch(() => null);
        }
        return promise;
    }

    function fill(person) {
        if (!person) return;
        const place = document.getElementById('staffPlace');
        if (place && person.spot) place.textContent = person.spot.title;
        const who = document.getElementById('staffWho');
        const name = document.getElementById('staffWhoName');
        if (who && name) {
            name.textContent = person.fullName || person.email;
            who.hidden = false;
        }
        try { if (person.fullName) localStorage.setItem('userName', person.fullName); } catch (e) { /* private browsing */ }
    }

    window.ztimsStaff = { me };
    if (localStorage.getItem('userRole') === 'support_staff') me().then(fill);
})();
