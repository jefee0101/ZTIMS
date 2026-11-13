/* Local-only integration checks. Use a disposable database named *_rooms_test.
 * NODE_ENV=test DATABASE_URL=postgres://.../ztims_rooms_test node scripts/check-rooms.cjs
 * Creates synthetic records; never drops or deletes existing data. */
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const u=new URL(process.env.DATABASE_URL || 'postgres://invalid/');
if(process.env.NODE_ENV!=='test'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||!/_rooms_test$/.test(u.pathname)) {
    console.error('Use NODE_ENV=test and a disposable LOCAL database named *_rooms_test.');process.exit(1);
}
process.env.JWT_SECRET='isolated-room-regression-checks-only';
const {Client}=require('pg');
const client=new Client({connectionString:process.env.DATABASE_URL});
let app,server;
(async()=>{
    await client.connect();
    await client.query("do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if; if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$");
    const schema=fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8');
    // Seed the earlier table shape first: migration must preserve pooled bookings.
    await client.query(schema.split('-- Unified room inventory (14 November 2026).')[0]);
    const id=()=>crypto.randomBytes(12).toString('hex');const mid=id(),sid=id(),tid=id(),bid=id();
    await client.query("insert into establishment_managers(id,email,password_hash) values($1,$2,'local-check')",[mid,mid+'@example.test']);
    await client.query("insert into spots(id,title,location,category,description,type,status,managed_by) values($1,'Local migration check','Local test','BEACH','Local test','accommodation','published',$2)",[sid,mid]);
    await client.query("insert into room_types(id,spot_id,name,base_rate,units) values($1,$2,'Legacy',700,3)",[tid,sid]);
    await client.query("insert into bookings(id,code,spot_id,guest_name,country_code,adults,check_in,check_out,total_amount,status) values($1,$2,$3,'Local guest','ph-filipino',1,'2026-10-10','2026-10-12',2800,'completed')",[bid,'MIG-'+bid.slice(0,8),sid]);
    await client.query('insert into booking_rooms(booking_id,room_type_id,units,rate_per_night) values($1,$2,2,700)',[bid,tid]);
    for(let i=1;i<=2;i++){await client.query(schema);console.log('PASS migration/schema run '+i);}
    const migrated=(await client.query('select room_id,units,rate_per_night from booking_rooms where booking_id=$1',[bid])).rows[0];
    if(migrated.room_id!==null||Number(migrated.units)!==2||Number(migrated.rate_per_night)!==700)throw Error('Legacy booking changed during migration.');
    console.log('PASS earlier composite-key booking preserved');
    app=require('../server');server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const baseURL=`http://127.0.0.1:${server.address().port}`;
    const fixturePath=process.env.ROOMS_FIXTURE || path.join(os.tmpdir(),'ztims-room-check-fixture.json');
    await require('./check-room-api.cjs')(client,{baseURL,fixturePath});
    if(process.argv.includes('--serve')) {
        // Isolated process only: browser runs need more than the coarse 150-request
        // cushion. Auth/form limits still use the unchanged database-backed store.
        const timer=setInterval(()=>{for(const l of app._router.stack)if(typeof l.handle.resetKey==='function')l.handle.resetKey('127.0.0.1');},5000);
        console.log('LOCAL BROWSER API: '+baseURL+'; synthetic fixture: '+fixturePath);
        await new Promise(r=>{process.once('SIGINT',r);process.once('SIGTERM',r);});clearInterval(timer);
    }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
    if(server)await new Promise(r=>server.close(r));if(app)await app.closeDatabase();await client.end();
});
