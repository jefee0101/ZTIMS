/* Selected-enterprise payment register. The server owns scope and arithmetic. */
(function () {
    async function mount(root) {
        const A = window.ztimsAcc, esc = A.esc, spot = ztimsEnterprise.current();
        if (!spot || spot.type !== 'accommodation') { root.innerHTML = '<div class="ztims-empty">Payment records are available for your accommodation enterprises.</div>'; return; }
        const money = n => new Intl.NumberFormat('en-PH', {style:'currency',currency:'PHP'}).format(Number(n || 0));
        const methods = {cash:'Cash',gcash:'GCash',maya:'Maya',bank:'Bank transfer',card:'Card',other:'Other'};
        const today = () => new Date(Date.now()+8*3600e3).toISOString().slice(0,10);
        let month = today().slice(0,7), page = 1, sequence = 0;
        const bookingLink = code => `resort_bookings.html?code=${encodeURIComponent(code)}`;
        async function draw() {
            const mine = ++sequence;
            root.innerHTML = '<div class="ztims-empty" role="status">Loading payment records…</div>';
            try {
                const access = await ztimsEnterprise.bookingAccess();
                if (!access.settings.acceptsBookings && !access.hasBookings) {
                    root.innerHTML = '<div class="ztims-empty">Bookings are off. <a class="font-bold underline" href="resort_spots.html">Open Enterprise</a></div>'; return;
                }
                const data = await A.api(`/bookings/manage/${spot._id}/payment-records?month=${encodeURIComponent(month)}&page=${page}`);
                if (mine !== sequence) return;
                root.innerHTML = `<div class="bkm-bar"><label><span class="field-label">Month received</span><input class="field" type="month" data-month value="${esc(month)}"></label><a class="btn btn-secondary" href="resort_bookings.html">${access.settings.acceptsBookings ? 'Bookings' : 'Existing bookings'}</a></div>
                    ${!access.settings.acceptsBookings ? '<p class="text-support">New requests are off. Existing bookings and their payment history remain available.</p>' : ''}
                    <div class="ent-payment-totals"><section class="glass-panel"><h2 class="field-label">Recorded onsite, net</h2><p class="ent-payment-value">${money(data.onsiteReceived)}</p></section><section class="glass-panel"><h2 class="field-label">Online demonstration, net</h2><p class="ent-payment-value">${money(data.demonstrationReceived)}</p></section></div>
                    <p class="text-support">Onsite amounts are recorded receipts, less recorded refunds. Online demonstration amounts are simulated funds and are kept separate.</p>
                    <section class="glass-panel"><h2 class="text-lg font-bold mb-3">Payment history</h2><div class="ent-payment-scroll"><table class="ztims-table w-full"><thead><tr><th>Received</th><th>Booking</th><th>Method</th><th>Amount</th><th>Status</th></tr></thead><tbody>${data.items.length ? data.items.map(p => `<tr><td>${esc(p.received_on)}</td><td><a class="font-bold underline" href="${bookingLink(p.code)}">${esc(p.code)}</a>${p.reference ? `<br><span class="text-support">${esc(p.reference)}</span>` : ''}</td><td>${esc(methods[p.method] || p.method)}<br><span class="text-support">${p.is_demo ? 'Demonstration' : p.channel === 'manual' ? 'Recorded onsite' : 'Online'}</span></td><td>${money(p.amount)}</td><td>${p.refunded_at ? `Refunded ${money(p.refund_amount)}` : 'Recorded'}</td></tr>`).join('') : '<tr><td colspan="5">No payments received in this month.</td></tr>'}</tbody></table></div><div class="bkm-bar mt-4"><span class="text-support">${data.total} payment records · Page ${page}</span><div class="flex gap-2"><button class="btn btn-secondary" data-prev ${page===1?'disabled':''}>Previous</button><button class="btn btn-secondary" data-next ${page*data.pageSize>=data.total?'disabled':''}>Next</button></div></div></section>
                    <section class="glass-panel"><h2 class="text-lg font-bold mb-3">Booking balances</h2><p class="text-support mb-3">Confirmed stays checking in during ${esc(month)}. Balances follow booking payments, including demonstration transactions.</p><div class="ent-payment-scroll"><table class="ztims-table w-full"><thead><tr><th>Booking</th><th>Guest</th><th>Balance</th><th>Action</th></tr></thead><tbody>${data.balances.length ? data.balances.map(b=>`<tr><td><a class="font-bold underline" href="${bookingLink(b.code)}">${esc(b.code)}</a></td><td>${esc(b.guest_name)}</td><td>${money(b.balance)}</td><td><button class="btn btn-secondary" data-record="${esc(b.id)}">Record payment</button></td></tr>`).join('') : '<tr><td colspan="4">No outstanding booking balances in this month.</td></tr>'}</tbody></table></div>${data.balanceCount>data.balances.length?'<p class="text-support mt-3">First 100 shown. Open Bookings for additional records.</p>':''}</section>`;
                root.querySelector('[data-month]').addEventListener('change',e=>{if(e.target.value){month=e.target.value;page=1;draw();}});
                root.querySelector('[data-prev]').addEventListener('click',()=>{page--;draw();});
                root.querySelector('[data-next]').addEventListener('click',()=>{page++;draw();});
                root.querySelectorAll('[data-record]').forEach(button=>button.addEventListener('click',()=>record(data.balances.find(b=>b.id===button.dataset.record))));
            } catch (error) {
                if (mine !== sequence) return;
                root.innerHTML = `<div class="ztims-empty" role="alert">${esc(error.message)} <button class="btn btn-secondary" data-retry>Try again</button></div>`;
                root.querySelector('[data-retry]').addEventListener('click',draw);
            }
        }
        async function record(booking) {
            const values = await ztimsDialog.form({ title:'Record a payment',message:`${booking.code} · Balance ${money(booking.balance)}`,fields:[
                {name:'amount',label:'Amount received (₱)',type:'number',value:String(booking.balance),required:true},
                {name:'method',label:'Paid with',type:'select',value:'cash',options:Object.entries(methods).map(([value,label])=>({value,label}))},
                {name:'receivedOn',label:'Received on',type:'date',value:today(),required:true},
                {name:'reference',label:'Reference (optional)'}],confirmLabel:'Record payment',validate:v=>!(Number(v.amount)>0)?'Give the amount received.':v.receivedOn>today()?'The received date cannot be in the future.':'' });
            if (!values) return;
            try { await A.api(`/bookings/manage/item/${booking.id}/payments`,{method:'POST',body:{amount:Number(values.amount),method:values.method,receivedOn:values.receivedOn,reference:(values.reference||'').trim()}}); draw(); }
            catch(error){if(window.showToast)showToast(error.message,'error');}
        }
        draw();
    }
    window.ztimsBookingPayments = { mount };
})();
