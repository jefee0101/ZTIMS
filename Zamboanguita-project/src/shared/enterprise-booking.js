/* Optional bookings, per accommodation enterprise. Uses the existing flag. */
(function () {
    const host = document.getElementById('enterpriseBookingControls');
    if (!host) return;
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    let sequence = 0;
    function draw(data) {
        const spot = window.ztimsEnterprise && ztimsEnterprise.current();
        host.hidden = !data || !spot || spot.type !== 'accommodation';
        if (host.hidden) return;
        const on = data.settings.acceptsBookings;
        host.innerHTML = `<div class="ent-booking-head"><h2>Accept bookings through ZTIMS</h2><label class="sf-switch"><input type="checkbox" role="switch" aria-label="Accept bookings through ZTIMS" ${on ? 'checked' : ''}><span class="sf-switch__track" aria-hidden="true"></span><span>${on ? 'On' : 'Off'}</span></label></div>
            <p class="text-support">${data.settings.pausedByOffice ? 'New requests are paused by the Tourism Office.' : on ? 'Visitors can request rooms from your listing.' : 'New booking requests are off. Visitors can contact your enterprise directly.'}</p>
            <div class="ent-booking-actions"><a class="btn btn-primary" href="resort_register.html">Guest Register</a><a class="btn btn-secondary" href="resort_statistics.html">Monthly report</a><a class="btn btn-secondary" href="resort_rooms.html">Rooms</a></div>
            ${!on && data.hasBookings ? '<p class="text-support">Existing bookings, payment records and refunds remain available.</p>' : ''}
            <p class="text-error" role="alert" data-error hidden></p>`;
        host.querySelector('input').addEventListener('change', async event => {
            const input = event.target, enabled = input.checked, id = spot._id, mine = ++sequence;
            input.disabled = true;
            try {
                const latest = await ztimsEnterprise.bookingAccess(true);
                if (!enabled && latest.hasBookings) {
                    if (!window.ztimsDialog) throw new Error('The confirmation could not be loaded. Reload and try again.');
                    const yes = await ztimsDialog.confirm({ title: 'Turn off new bookings?', message: 'Visitors will no longer send new requests. Existing bookings, payment records and refunds remain available.', confirmLabel: 'Turn off new bookings', cancelLabel: 'Keep bookings on' });
                    if (!yes) { input.checked = on; return; }
                }
                const response = await fetch(`/api/bookings/manage/${encodeURIComponent(id)}/enabled`, {
                    method: 'PATCH', headers: { Authorization: 'Bearer ' + localStorage.getItem('authToken'), 'Content-Type':'application/json' }, body: JSON.stringify({enabled})
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message || 'The booking setting could not be saved.');
                if (mine !== sequence || ztimsEnterprise.current()?._id !== id) return;
                await ztimsEnterprise.syncBookingNavigation(true);
                if (window.showToast) showToast(enabled ? 'Bookings are on.' : 'New bookings are off. Visitor recording stays available.', 'success');
                host.querySelector('input')?.focus();
            } catch (error) {
                if (!input.isConnected || mine !== sequence) return;
                input.checked = on;
                const box = host.querySelector('[data-error]'); box.hidden = false;
                box.innerHTML = `${esc(error.message)} <a class="font-bold underline" href="resort_rooms.html#settings">Booking settings</a>`;
            } finally { if (input.isConnected) input.disabled = false; }
        });
    }
    document.addEventListener('ztims-booking-access', event => {
        if (event.detail.spotId === window.ztimsEnterprise?.current()?._id) draw(event.detail.access);
    });
})();
