/* Groups are the editable source; a database trigger maintains daily reports.
 * Residence and sex remain independent observations, not inferred cross-tabs. */
const {query,transaction}=require('./db');
const E=require('./attraction-engine');
const ID=/^[a-f0-9]{24}$/i,KEY=/^[A-Za-z0-9_-]{8,64}$/;
const shape=r=>({_id:r.id,reference:'AG-'+String(r.group_no).padStart(6,'0'),date:E.toDate(r.visit_date),total:r.total,
 residence:{zamboanguita:r.res_zamboanguita,negrosOriental:r.res_negros_oriental,otherProvince:r.res_other_province,foreign:r.res_foreign},
 male:r.male,female:r.female,status:r.status,revision:r.revision,reason:r.reason,createdAt:r.created_at,updatedAt:r.updated_at});
module.exports=function({router,requireSupportStaff,writeLimit,handle,placeFor,lock,assertDateOpen,ensureSettings,who,refuse}){
 const available=async client=>(await query("select to_regclass('public.attraction_visit_groups') is not null as ready",[],client)).rows[0].ready;
 async function ready(){if(!await available())refuse(503,'GROUP_SETUP','Group recording is being prepared. Please contact the Tourism Office.');}
 const body=(b,allowed)=>{if(!b||typeof b!=='object'||Array.isArray(b))refuse(400,'BAD_COUNT','Give a group record.');for(const k of Object.keys(b))if(!allowed.includes(k))refuse(400,'BAD_FIELD',`"${k}" cannot be set here.`);return b;};
 const key=b=>{if(typeof b.requestKey!=='string'||!KEY.test(b.requestKey))refuse(400,'BAD_COUNT','A valid request key is required.');return b.requestKey;};
 function counts(b){const p=E.parseCount({total:Number(b.sex?.male)+Number(b.sex?.female),residence:b.residence,sex:b.sex,requestKey:key(b)});if(p.errors)refuse(400,'BAD_COUNT',p.errors[0],{errors:p.errors});if(!p.value.total)refuse(400,'BAD_COUNT','Record at least one visitor. Confirm a zero date separately.');return p.value;}
 router.get('/attraction-visits/group-recording',requireSupportStaff,handle(async(req,res)=>{res.set('Cache-Control','no-store');res.json({available:await available()});}));
 router.get('/attraction-visits/:spotId/groups',requireSupportStaff,handle(async(req,res)=>{
  await ready();const spot=await placeFor(req,req.params.spotId);const month=String(req.query.month||E.manilaToday().slice(0,7));
  if(!/^(20\d\d|2100)-(0[1-9]|1[0-2])$/.test(month))refuse(400,'BAD_PERIOD','Choose a valid reporting month.');
  const page=Number(req.query.page||1);if(!Number.isSafeInteger(page)||page<1||page>100000)refuse(400,'BAD_PAGE','Choose a valid page.');
  const date=String(req.query.date||'');if(date&&(!E.isDate(date)||!date.startsWith(month+'-')))refuse(400,'BAD_DATE','Choose a date in the selected month.');
  const status=String(req.query.status||'active');if(!['active','voided','all'].includes(status))refuse(400,'BAD_STATUS','Choose active, voided or all groups.');
  const first=month+'-01',last=E.lastDay(+month.slice(0,4),+month.slice(5));
  const result=await query(`with matches as (select * from attraction_visit_groups where spot_id=$1 and visit_date between $2 and $3 and ($4::date is null or visit_date=$4::date) and ($5='all' or status=$5)) select (select count(*)::int from matches) total,coalesce((select jsonb_agg(x) from (select * from matches order by visit_date desc,group_no desc limit 50 offset $6) x),'[]'::jsonb) items`,[spot.id,first,last,date||null,status,(page-1)*50]);
  // $4 null is an unfiltered date; avoid casting an empty string to a date.
  const legacy=await query('select count_date,total,revision from attraction_daily_counts where spot_id=$1 and count_date between $2 and $3 and not group_managed and total>0 order by count_date desc',[spot.id,first,last]);
  const daily=await query("select visit_date,count(*)::int groups from attraction_visit_groups where spot_id=$1 and visit_date between $2 and $3 and status='active' group by visit_date order by visit_date",[spot.id,first,last]);
  res.set('Cache-Control','no-store');res.json({page,pageSize:50,total:result.rows[0].total,items:result.rows[0].items.map(shape),daily:daily.rows.map(r=>({date:E.toDate(r.visit_date),groups:r.groups})),legacy:legacy.rows.map(r=>({date:E.toDate(r.count_date),total:r.total,revision:r.revision}))});
 }));
 const values=v=>[v.res.zamboanguita,v.res.negrosOriental,v.res.otherProvince,v.res.foreign,v.male,v.female];
 router.post('/attraction-visits/:spotId/groups',requireSupportStaff,writeLimit,handle(async(req,res)=>{
  await ready();const b=body(req.body,['date','residence','sex','requestKey']),v=counts(b),date=String(b.date||'');
  if(!E.isDate(date)||date<'2000-01-01'||date>'2100-12-31')refuse(400,'BAD_DATE','Choose a real visit date.');
  const actor=who(req);let replayed=false;
  const saved=await transaction(async client=>{const s=await placeFor(req,req.params.spotId,{write:true},client);await lock(s.id,client);
   const prior=(await query('select * from attraction_visit_groups where spot_id=$1 and create_request_key=$2',[s.id,key(b)],client)).rows[0];if(prior){replayed=true;return prior;}
   await assertDateOpen(s,date,client);await ensureSettings(s,date,client);
   return(await query(`insert into attraction_visit_groups(spot_id,visit_date,res_zamboanguita,res_negros_oriental,res_other_province,res_foreign,male,female,create_request_key,last_request_key,actor_email,actor_role) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11) returning *`,[s.id,date,...values(v),key(b),actor.email,actor.role],client)).rows[0];
  });res.status(replayed?200:201).json({success:true,replayed,group:shape(saved)});
 }));
 async function change(req,res,voiding){
  await ready();const b=body(req.body,voiding?['revision','reason','requestKey']:['revision','reason','requestKey','residence','sex']);key(b);
  if(!ID.test(req.params.id)||!Number.isInteger(b.revision)||b.revision<1)refuse(400,'BAD_COUNT','Reload the group before changing it.');
  const reason=typeof b.reason==='string'?b.reason.trim():'';if(reason.length<3||reason.length>300)refuse(400,'BAD_REASON','Give a correction reason of 3 to 300 characters.');
  const v=voiding?null:counts(b),actor=who(req);let replayed=false;
  const saved=await transaction(async client=>{const s=await placeFor(req,req.params.spotId,{write:true},client);await lock(s.id,client);
   const old=(await query('select * from attraction_visit_groups where id=$1 and spot_id=$2 for update',[req.params.id,s.id],client)).rows[0];if(!old)refuse(404,'NOT_FOUND','Group record not found.');
   if(old.last_request_key===key(b)){replayed=true;return old;}await assertDateOpen(s,E.toDate(old.visit_date),client);
   if(old.revision!==b.revision)refuse(409,'STALE','This group changed. Reload it before correcting it.');if(old.status==='voided')refuse(409,'GROUP_VOIDED','This group was already voided.');
   const r=voiding?await query(`update attraction_visit_groups set status='voided',revision=revision+1,reason=$3,last_request_key=$4,actor_email=$5,actor_role=$6 where id=$1 and spot_id=$2 returning *`,[old.id,s.id,reason,key(b),actor.email,actor.role],client):await query(`update attraction_visit_groups set res_zamboanguita=$3,res_negros_oriental=$4,res_other_province=$5,res_foreign=$6,male=$7,female=$8,revision=revision+1,reason=$9,last_request_key=$10,actor_email=$11,actor_role=$12 where id=$1 and spot_id=$2 returning *`,[old.id,s.id,...values(v),reason,key(b),actor.email,actor.role],client);
   return r.rows[0];
  });res.json({success:true,replayed,group:shape(saved)});
 }
 router.put('/attraction-visits/:spotId/groups/:id',requireSupportStaff,writeLimit,handle((req,res)=>change(req,res,false)));
 router.post('/attraction-visits/:spotId/groups/:id/void',requireSupportStaff,writeLimit,handle((req,res)=>change(req,res,true)));
};
