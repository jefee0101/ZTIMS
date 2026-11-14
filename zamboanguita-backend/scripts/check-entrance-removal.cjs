const crypto=require('crypto');
module.exports=async function(c,f,invoices,refunds,{baseURL,gatewayURL}){
 if(![baseURL,gatewayURL].every(u=>['127.0.0.1','localhost','[::1]'].includes(new URL(u).hostname)))throw Error('Local checks only.');let count=0;const ok=(b,m,x)=>{if(!b)throw Error(m+': '+JSON.stringify(x));count++;console.log('PASS '+m);};
 const q=(s,p=[])=>c.query(s,p),id=()=>crypto.randomBytes(12).toString('hex');
 const call=async(method,path,body,token=f.visitorToken,headers={})=>{const r=await fetch(baseURL+'/api'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
 const visitor=JSON.parse(Buffer.from(f.visitorToken.split('.')[1],'base64')).sub;
 const officer=(await q('select id from tourism_officers limit 1')).rows[0].id;
 const jwt=require('jsonwebtoken');const off=jwt.sign({sub:officer,role:'admin',sv:0},process.env.JWT_SECRET,{issuer:'ztims-api',audience:'ztims-web',expiresIn:'1h'});
 const attraction=id();await q("insert into spots(id,title,description,location,category,type,status,entrance_fee) values($1,'Local attraction','Local test','Local test','NATURE','spot','published',50)",[attraction]);
 for(let i=0;i<2;i++){const t=id();await q("insert into tickets(id,code,spot_id,visit_date,count_regular,fee_regular,full_name,email,status,is_demo,visitor_id) values($1,$2,$3,'2026-10-10',1,50,'Local guest','local@example.test','used',true,$4)",[t,'OLD-'+t,attraction,visitor]);await q("insert into online_checkouts(ticket_id,amount,session_id,expires_at) values($1,50,$2,now()+interval '1 hour')",[t,'old-'+t]);}
 const fingerprint=async()=>JSON.stringify((await q("select (select jsonb_agg(t order by id) from tickets t) as old_rows,(select jsonb_agg(t order by id) from online_checkouts t) as old_checkouts,(select jsonb_agg(t order by id) from payments t) as old_payments")).rows);
 const before=await fingerprint();
 for(const [m,p] of [['GET','/tickets'],['POST','/tickets'],['GET','/tickets/offer/'+attraction],['POST','/tickets/check'],['POST','/tickets/'+id()+'/admit'],['GET','/payments'],['GET','/payments/checkout/'+id()],['PATCH','/payments/'+id()+'/receipt'],['POST','/payments/'+id()+'/refund'],['GET','/payments/export.xlsx'],['POST','/payments/demo'],['DELETE','/payments/demo'],['GET','/visitors/me/tickets'],['POST','/manage/refund-closure']]){const r=await call(m,p,undefined,off);ok(r.status===404,'retired route '+m+' '+p,r);}
 let r=await call('POST',`/spots/${attraction}/close-date`,{date:new Date(Date.now()+86400000).toISOString().slice(0,10),reason:'Local closure'},off);ok(r.status===201,'closing attraction date only records closure',r);
 r=await call('POST','/manage/lookup',{code:'OLD-'+(await q('select id from tickets limit 1')).rows[0].id});ok(r.status===404,'old entrance code cannot open through Manage',r);
 r=await call('POST',`/spots/${attraction}/reviews`,{rating:5,body:'Local test'});ok(r.status===403,'used legacy admission cannot prove attraction review',r);
 const gw=require('../xendit-gateway');const testKey=process.env.XENDIT_SECRET_KEY;process.env.XENDIT_SECRET_KEY='xnd_production_local';ok(!gw.gatewayState().online,'live gateway key refused');process.env.XENDIT_SECRET_KEY=testKey;
 r=await call('PUT',`/rooms/manage/${f.spotId}/settings`,{acceptsBookings:true,allowPayAtProperty:true,allowPayOnline:true,paymentInstructions:'Local test'},f.managerToken);ok(r.status===200,'room online payment enabled',r);
 const day=n=>new Date(Date.now()+(8+24*n)*3600000).toISOString().slice(0,10);
 async function booking(offset){const r=await call('POST','/bookings',{spotId:f.spotId,checkIn:day(offset),checkOut:day(offset+2),adults:1,children:0,paymentChoice:'online',rooms:[{roomId:f.roomIds[1],units:1}]});ok(r.status===201,'room request created',r);return (await q('select * from bookings where spot_id=$1 and check_in=$2',[f.spotId,day(offset)])).rows[0];}
 let b=await booking(30);r=await call('POST','/bookings/pay',{code:b.code});ok(r.status===409,'payment waits for manager confirmation',r);
 r=await call('POST',`/bookings/manage/item/${b.id}/confirm`,{},f.managerToken);ok(r.status===200,'room request confirmed',r);
 r=await call('POST','/bookings/pay',{code:b.code});ok(r.status===200&&r.data.payUrl.startsWith(gatewayURL+'/'),'room checkout uses local Xendit stand-in',r);
 let checkout=(await q('select * from booking_checkouts where booking_id=$1',[b.id])).rows[0];let inv=invoices.get(checkout.session_id);ok(inv.external_id==='ztims-b-'+checkout.id,'booking external ID unchanged');ok(inv.success_redirect_url.includes('manage.html?code='),'room return page preserved');
 inv.status='PAID';inv.paid_amount=inv.amount;inv.payment_channel='GCASH';
 r=await call('POST','/payments/webhook',inv,'',{'x-callback-token':'wrong'});ok(r.status===401,'webhook rejects wrong callback token',r);
 const cb=()=>call('POST','/payments/webhook',{id:inv.id,external_id:inv.external_id},'',{'x-callback-token':process.env.XENDIT_CALLBACK_TOKEN});
 r=await cb();ok(r.status===200,'unchanged webhook routes booking payment',r);await cb();
 const paid=(await q('select * from booking_payments where booking_id=$1',[b.id])).rows;ok(paid.length===1&&paid[0].is_demo&&paid[0].channel==='online','callback replay records one demo payment',paid);
 r=await call('POST','/manage/lookup',{code:b.code});ok(r.status===200&&r.data.item.payment.hasOnlinePayment,'booking Manage displays paid state',r);
 r=await call('POST','/manage/cancel',{code:b.code});ok(r.status===200&&r.data.refunded===Number(b.total_amount),'room cancellation refunds online in full',r);ok(refunds.some(x=>x.invoice_id===inv.id&&x.amount===Number(b.total_amount)),'refund sent through retained gateway');
 b=await booking(40);await call('POST',`/bookings/manage/item/${b.id}/confirm`,{},f.managerToken);await call('POST','/bookings/pay',{code:b.code});checkout=(await q('select * from booking_checkouts where booking_id=$1',[b.id])).rows[0];inv=invoices.get(checkout.session_id);inv.status='PAID';inv.paid_amount=inv.amount;inv.payment_channel='PAYMAYA';
 r=await call('POST','/manage/lookup',{code:b.code});ok(r.status===200&&r.data.item.payment.hasOnlinePayment,'return lookup settles room payment without webhook',r);
 await q("update bookings set status='completed' where id=$1",[b.id]);r=await call('POST',`/spots/${f.spotId}/reviews`,{rating:5,body:'Local completed stay'});ok(r.status===201,'completed accommodation booking still proves review',r);
 r=await call('POST','/payments/webhook',{id:'old-invoice',external_id:'ztims-'+id()},'',{'x-callback-token':process.env.XENDIT_CALLBACK_TOKEN});ok(r.status===200&&r.data.ignored,'old checkout callback ignored',r);
 ok(before===await fingerprint(),'two legacy admissions and checkouts remain byte-for-byte unchanged');
 console.log('ROOM GATEWAY / REMOVAL CHECKS PASSED: '+count);
};
