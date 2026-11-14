/* Disposable local Postgres + local Xendit stand-in. No real gateway calls.
 * NODE_ENV=test DATABASE_URL=postgres://.../example_rooms_test node scripts/check-room-gateway.cjs */
const fs=require('fs'),path=require('path'),http=require('http');
const u=new URL(process.env.DATABASE_URL || 'postgres://invalid/');
if(process.env.NODE_ENV!=='test'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||!/_rooms_test$/.test(u.pathname)){
 console.error('Use a disposable LOCAL *_rooms_test database with NODE_ENV=test.');process.exit(1);
}
process.env.JWT_SECRET='local-room-gateway-checks';process.env.XENDIT_SECRET_KEY='xnd_development_local_only';process.env.XENDIT_CALLBACK_TOKEN='local-callback-only';
const {Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL});
const invoices=new Map(),refunds=[];let app,server,mock;
(async()=>{
 await c.connect();
 await c.query("do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if; if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$");
 await c.query(fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8'));
 mock=http.createServer(async(req,res)=>{let raw='';for await(const x of req)raw+=x;const b=raw?JSON.parse(raw):{};res.setHeader('Content-Type','application/json');
  if(req.method==='POST'&&req.url==='/v2/invoices'){const id='local-'+(invoices.size+1);const invoice={id,...b,invoice_url:process.env.XENDIT_API_BASE+'/pay/'+id,status:'PENDING'};invoices.set(id,invoice);res.end(JSON.stringify(invoice));}
  else if(req.method==='GET'&&req.url.startsWith('/v2/invoices/'))res.end(JSON.stringify(invoices.get(req.url.split('/').pop())));
  else if(req.method==='POST'&&req.url==='/refunds'){refunds.push(b);res.end(JSON.stringify({id:'refund-'+refunds.length,status:'SUCCEEDED'}));}
  else{res.statusCode=404;res.end('{}');}
 });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 process.env.XENDIT_API_BASE=`http://127.0.0.1:${mock.address().port}`;
 app=require('../server');server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const baseURL=`http://127.0.0.1:${server.address().port}`;
 const fixture=await require('./check-room-api.cjs')(c,{baseURL});
 await require('./check-entrance-removal.cjs')(c,fixture,invoices,refunds,{baseURL,gatewayURL:process.env.XENDIT_API_BASE});
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 if(server)await new Promise(r=>server.close(r));if(mock)await new Promise(r=>mock.close(r));if(app)await app.closeDatabase();await c.end();
});
