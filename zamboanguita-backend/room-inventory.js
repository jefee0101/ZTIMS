/* Numbered rooms are the booking inventory and the reporting inventory.
 * Type-only booking lines are historical: never guess a room for them. */
const { query, transaction } = require('./db');
const day = v => v == null ? null : String(v).slice(0, 10);
const problem = (status, message) => Object.assign(new Error(message), { status, code:'ROOM_INVENTORY' });
const lockPlace = (id, client) => query("select pg_advisory_xact_lock(hashtextextended('accommodation:' || $1, 0))", [id], client);
const HOLDING = "(b.status in ('confirmed','checked_in') or (b.status='requested' and b.expires_at > now()))";

async function catalog(spotId, client) {
    return (await query(`select r.*, t.name as type_name, t.description as type_description,
        t.beds, t.base_rate as default_rate, t.active as type_active,
        coalesce((select jsonb_agg(p.url order by p.position) from accommodation_room_photos p where p.room_id=r.id),'[]') as photos
        from accommodation_rooms r left join room_types t on t.id=r.room_type_id
        where r.spot_id=$1 order by t.position, t.name, lower(r.room_number)`, [spotId], client)).rows;
}
const shape = r => ({ _id:r.id, roomTypeId:r.room_type_id, roomNumber:r.room_number,
    name:`${r.type_name || 'Room'} · Room ${r.room_number}`, typeName:r.type_name || '',
    description:r.label || r.type_description || '', beds:r.beds || 1, maxGuests:r.sleeps,
    rate:Number(r.nightly_rate ?? r.default_rate), rateOverride:r.nightly_rate == null ? null : Number(r.nightly_rate),
    shared:r.shared, availableFrom:day(r.available_from), availableUntil:day(r.available_until),
    photos:r.photos || [], photoUrl:(r.photos || [])[0] || '', active:r.type_active === true });

async function freeRooms(spotId, from, until, {client, exclude='', perNight=false}={}) {
    let sql=`select r.id, r.room_type_id, r.room_number, t.name as type_name,
        t.description, r.label, t.beds, r.sleeps as max_guests, coalesce(r.nightly_rate,t.base_rate) as base_rate,
        coalesce((select jsonb_agg(p.url order by p.position) from accommodation_room_photos p where p.room_id=r.id),'[]') as photos,
        t.active, t.position, 1 as units,
        case when not t.active or r.shared or r.available_from > $2::date or (r.available_until is not null and r.available_until < $3::date)
          or exists(select 1 from accommodation_closed_periods c where c.spot_id=r.spot_id and c.voided_at is null and c.starts_on < $3 and c.ends_on >= $2)
          or exists(select 1 from accommodation_room_unavailability u where u.room_id=r.id and u.voided_at is null and u.starts_on < $3 and u.ends_on >= $2)
          or exists(select 1 from accommodation_stay_rooms a join accommodation_stays s on s.id=a.stay_id
              where a.room_id=r.id and s.status='active' and a.starts_on < $3 and a.ends_on > $2
              and ($4='' or coalesce(s.booking_id,'') <> $4))
          or exists(select 1 from booking_rooms br join bookings b on b.id=br.booking_id
              where b.spot_id=r.spot_id and b.id <> $4 and b.check_in < $3 and b.check_out > $2 and ${HOLDING}
              and (br.room_id=r.id or (br.room_id is null and br.room_type_id=r.room_type_id)))
          or exists(select 1 from room_blocks k where k.room_type_id=r.room_type_id and k.starts_on < $3 and k.ends_on >= $2)
          then 0 else 1 end as free
        from accommodation_rooms r join room_types t on t.id=r.room_type_id
        where r.spot_id=$1 ${perNight?'':'and t.active'} order by t.position,t.name,r.room_number`;
    if(perNight) {
        sql=sql.replace(/\$2(?:::date)?/g,'n.night::date').replace(/\$3(?:::date)?/g,'(n.night::date+1)')
            .replace('select r.id,','select n.night::date as night, r.id,')
            .replace('where r.spot_id=$1',"cross join generate_series($2::date,$3::date-1,interval '1 day') n(night) where r.spot_id=$1");
    }
    const rows=(await query(sql,[spotId,from,until,exclude],client)).rows;
    // Keep selection IDs distinct from their parent type IDs.
    return rows.map(r=>({...r,name:`${r.type_name} · Room ${r.room_number}`,photo_url:r.photos[0] || ''}));
}

/* Called under the SAME enterprise lock as booking requests. Old type-only
 * reservations conservatively protect every room of that type. */
async function assertNotReserved(spotId, roomIds, from, until, exclude, client) {
    if (!roomIds.length) return;
    const hit=(await query(`select b.code from bookings b join booking_rooms br on br.booking_id=b.id
        join accommodation_rooms r on r.spot_id=b.spot_id and (br.room_id=r.id or (br.room_id is null and br.room_type_id=r.room_type_id))
        where b.spot_id=$1 and r.id=any($2::text[]) and b.check_in < $4 and b.check_out > $3
          and b.id <> $5 and ${HOLDING} limit 1`,[spotId,roomIds,from,until,exclude || ''],client)).rows[0];
    if(hit) throw problem(409,`A selected room is reserved by booking ${hit.code}. Choose another room or resolve that booking first.`);
}

function mount({router, requireEstablishmentManager, ownResort, checkPhotoSources, fail}) {
    const handle=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){
        if(e.code==='23505') e=problem(409,'That room number already exists.');
        if(e.code==='P0001') e=problem(409,e.message.startsWith('PERIOD_FINALIZED')?'This change affects a finalized month. Ask the Tourism Office to reopen it first.':e.message.startsWith('ROOM_HISTORY')?'This room has history and cannot be deleted. Set its last available night instead.':e.message);
        return fail(res,e,'Room inventory:');
    }};
    router.get('/room-inventory/:spotId',requireEstablishmentManager,handle(async(req,res)=>{
        const s=await ownResort(req,req.params.spotId);
        res.json({rooms:(await catalog(s.id)).map(shape)});
    }));
    async function save(req,res,editing){
        const body=req.body || {};
        const result=await transaction(async client=>{
            let old=editing?(await query('select * from accommodation_rooms where id=$1',[req.params.id],client)).rows[0]:null;
            if(editing&&!old) throw problem(404,'Room not found.');
            const s=await ownResort(req,editing?old.spot_id:req.params.spotId,client);
            await lockPlace(s.id,client);
            if(editing) old=(await query('select * from accommodation_rooms where id=$1 for update',[old.id],client)).rows[0];
            if(editing&&!old) throw problem(409,'This room was deleted. Reload Rooms.');
            const typeId=String(body.roomTypeId || old?.room_type_id || '');
            const t=(await query('select * from room_types where id=$1 and spot_id=$2',[typeId,s.id],client)).rows[0];
            if(!t) throw problem(400,'Choose a room type belonging to this enterprise.');
            if(!old && Number((await query('select count(*) as n from accommodation_rooms where room_type_id=$1',[typeId],client)).rows[0].n)>=500) throw problem(400,'A room type can contain up to 500 numbered rooms.');
            if(old && old.room_type_id && old.room_type_id !== typeId) throw problem(409,'An existing room cannot change type here.');
            const roomNumber=String(body.roomNumber ?? old?.room_number ?? '').trim();
            if(!roomNumber || roomNumber.length>20) throw problem(400,'Enter a room number of up to 20 characters.');
            if(old && old.room_number!==roomNumber) throw problem(409,'Room numbers with saved records cannot be renamed here.');
            const label=String(body.description ?? old?.label ?? '').trim();
            if(label.length>80) throw problem(400,'Keep the room description to 80 characters.');
            const rate=body.rateOverride===null || body.rateOverride==='' ? null : Number(body.rateOverride ?? old?.nightly_rate ?? t.base_rate);
            if(rate!==null && (!Number.isFinite(rate)||rate<=0||rate>1000000||Math.abs(Math.round(rate*100)-rate*100)>0.00001)) throw problem(400,'Enter a valid nightly price with up to two decimal places.');
            const sleeps=Number(body.maxGuests ?? old?.sleeps ?? t.max_guests);
            if(!Number.isInteger(sleeps)||sleeps<1||sleeps>30) throw problem(400,'Guests per room must be 1 to 30.');
            const from=String(body.availableFrom ?? (old?day(old.available_from):'')).slice(0,10);
            const valid=v=>{const d=new Date(v+'T00:00:00Z');return /^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;};
            if(!valid(from)) throw problem(400,'Choose the date the room becomes available.');
            const until=body.availableUntil===undefined?(old?day(old.available_until):null):(body.availableUntil || null);
            if(until&&(!valid(until)||until<=from)) throw problem(400,'Last available night must be on or after the first available night.');
            if(old && until && until!==day(old.available_until)) {
                await assertNotReserved(s.id,[old.id],until,'9999-12-31','',client);
                if((await query("select 1 from accommodation_stay_rooms a join accommodation_stays s on s.id=a.stay_id where a.room_id=$1 and s.status='active' and a.ends_on > $2 limit 1",[old.id,until],client)).rows.length)
                    throw problem(409,'An existing stay uses this room after that date.');
            }
            const photos=body.photos;
            if(!Array.isArray(photos)||photos.length>12||photos.some(p=>typeof p!=='string'||!p||p.length>500)||new Set(photos).size!==photos.length) throw problem(400,'Choose up to 12 different room photos.');
            const kept=old?(await query('select url from accommodation_room_photos where room_id=$1',[old.id],client)).rows.map(p=>p.url):[];
            checkPhotoSources(photos,kept);
            let r;
            if(old) {
                if(sleeps<old.sleeps) await assertNotReserved(s.id,[old.id],day(new Date().toISOString()),'9999-12-31','',client);
                r=(await query('update accommodation_rooms set label=$2,sleeps=$3,nightly_rate=$4,available_until=$5,room_type_id=$6 where id=$1 returning *',[old.id,label,sleeps,rate,until,typeId],client)).rows[0];
            } else r=(await query(`insert into accommodation_rooms(spot_id,room_number,room_type_id,label,sleeps,shared,available_from,nightly_rate)
                values($1,$2,$3,$4,$5,false,$6,$7) returning *`,[s.id,roomNumber,typeId,label,sleeps,from,rate],client)).rows[0];
            await query('delete from accommodation_room_photos where room_id=$1',[r.id],client);
            for(let i=0;i<photos.length;i++) await query('insert into accommodation_room_photos(room_id,position,url) values($1,$2,$3)',[r.id,i,photos[i]],client);
            await query('update room_types set units=(select count(*) from accommodation_rooms where room_type_id=$1) where id=$1',[typeId],client);
            await query(`insert into accommodation_changes(spot_id,entity,entity_id,action,reason,affected_months,before,after,actor_role,actor_email)
                values($1,'room',$2,$3,'Room setup','{}',$4,$5,$6,$7)`,[s.id,r.id,old?'edited':'created',old?JSON.stringify({roomNumber:old.room_number,rate:old.nightly_rate}):null,JSON.stringify({roomNumber:r.room_number,rate:r.nightly_rate}),req.auth.role,req.account?.email || ''],client);
            return shape((await catalog(s.id,client)).find(x=>x.id===r.id));
        });
        res.status(editing?200:201).json({success:true,room:result});
    }
    router.post('/room-inventory/:spotId/rooms',requireEstablishmentManager,handle((req,res)=>save(req,res,false)));
    router.put('/room-inventory/rooms/:id',requireEstablishmentManager,handle((req,res)=>save(req,res,true)));
    router.delete('/room-inventory/rooms/:id',requireEstablishmentManager,handle(async(req,res)=>{
        await transaction(async client=>{
            const r=(await query('select * from accommodation_rooms where id=$1',[req.params.id],client)).rows[0];
            if(!r) throw problem(404,'Room not found.');
            const s=await ownResort(req,r.spot_id,client); await lockPlace(s.id,client);
            await query('delete from accommodation_rooms where id=$1',[r.id],client);
            if(r.room_type_id) await query('update room_types set units=(select count(*) from accommodation_rooms where room_type_id=$1) where id=$1',[r.room_type_id],client);
            await query(`insert into accommodation_changes(spot_id,entity,entity_id,action,reason,affected_months,before,actor_role,actor_email)
                values($1,'room',$2,'deleted','Unused room removed','{}',$3,$4,$5)`,[s.id,r.id,JSON.stringify({roomNumber:r.room_number}),req.auth.role,req.account?.email || ''],client);
        }); res.json({success:true,message:'Room deleted.'});
    }));
}
module.exports={catalog,shape,freeRooms,lockPlace,assertNotReserved,mount};
