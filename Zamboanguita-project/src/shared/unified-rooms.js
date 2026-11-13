/* One manager setup: types contain the actual numbered rooms. */
(function () {
    const esc=s=>window.ztimsAcc.esc(s);
    const money=n=>'₱'+Number(n).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
    function mount(el,spot,data,reload,editType,toggleActive,uploadOptions={}) {
        const A=window.ztimsAcc, rooms=data.numberedRooms || [];
        const button=(label,action,id,kind='secondary')=>`<button type="button" class="btn btn-${kind} min-h-[44px]" data-unified="${action}" data-key="${esc(id)}">${label}</button>`;
        const roomRows=list=>list.length?`<div class="ur-list">${list.map(r=>`<div class="ur-row">
            <div class="ur-thumb">${r.photoUrl?`<img src="${esc(r.photoUrl)}" alt="Room ${esc(r.roomNumber)}" loading="lazy"/>`:'<span>Room</span>'}</div>
            <div class="ur-room"><b>Room ${esc(r.roomNumber)}</b><span>${esc(r.description || '')}</span>
            <span>${r.maxGuests} guests${r.availableUntil?' · Last night '+A.fmtDate(A.addDays(r.availableUntil,-1),true):''}${r.shared?' · Shared':''}</span></div>
            <div class="ur-rate"><b>${Number.isFinite(r.rate)?money(r.rate):'Set price'}</b><span>per night${r.rateOverride===null?' · Type rate':''}</span><span>${r.photos.length} photos</span></div>
            <div class="ur-actions">${button('Manage','edit',r._id)}${button('Delete','delete',r._id,'cancel')}</div>
        </div>`).join('')}</div>`:'<div class="ztims-empty">No rooms added. Add a room number to offer this type.</div>';
        el.className='space-y-5';
        el.innerHTML=`<div class="flex flex-wrap gap-3"><span class="tone-pill tone-neutral rounded-pill">${data.rooms.length} room ${data.rooms.length===1?'type':'types'}</span><span class="tone-pill tone-neutral rounded-pill">${rooms.length} ${rooms.length===1?'room':'rooms'}</span></div>`+
            data.rooms.map(t=>{const numbered=rooms.filter(r=>r.roomTypeId===t._id);return `<section class="ur-group">
                <div class="ur-group-head"><div><h3>${esc(t.name)}</h3><p>${numbered.length} rooms · Default ${money(t.rate)} / night${!t.active?' · Retired':''}</p></div>
                <div class="ur-actions">${button('Edit type','type',t._id)}${button(t.active?'Retire':'Bring back','active',t._id)}${button('Add room','add',t._id,'primary')}${button('Delete type','delete-type',t._id,'cancel')}</div></div>
                ${roomRows(numbered)}</section>`;}).join('')+
            (rooms.some(r=>!r.roomTypeId)?`<section class="ur-group"><div class="ur-group-head"><h3>Rooms needing a type</h3></div>${roomRows(rooms.filter(r=>!r.roomTypeId))}</section>`:'');
        el.onclick=async e=>{
            const b=e.target.closest('[data-unified]');if(!b)return;
            const id=b.dataset.key, action=b.dataset.unified;
            if(action==='active')return toggleActive(data.rooms.find(t=>t._id===id));
            if(action==='type')return editType(data.rooms.find(t=>t._id===id));
            if(action==='add')return roomWindow(null,data.rooms.find(t=>t._id===id));
            if(action==='edit')return roomWindow(rooms.find(r=>r._id===id));
            const isType=action==='delete-type', record=(isType?data.rooms:rooms).find(r=>r._id===id);
            if(!record)return;
            const yes=await window.ztimsDialog.confirm({title:`Delete ${isType?record.name:'Room '+record.roomNumber}?`,
                message:isType?'Only an empty type without booking history can be deleted.':'Only an unused room without booking, stay, or finalized reporting history can be deleted.',confirmLabel:'Delete',cancelLabel:'Keep',tone:'danger'});
            if(!yes)return;
            b.disabled=true;
            try {await A.api(isType?`/rooms/manage/types/${id}`:`/room-inventory/rooms/${id}`,{method:'DELETE'});A.toast(isType?'Room type deleted':'Room deleted');await reload();}
            catch(err){A.toast(err.message,'error');}finally{b.disabled=false;}
        };
        function roomWindow(r,t) {
            t=t || data.rooms.find(t=>t._id===r.roomTypeId);
            let photos=(r?.photos || []).slice(), uploading=false;
            const w=A.openWindow({title:r?'Manage Room '+r.roomNumber:'Add room · '+t.name,
                body:`<div class="grid sm:grid-cols-2 gap-4">
                    <label class="block"><span class="field-label">Room number</span><input id="urNumber" class="field" maxlength="20" value="${esc(r?.roomNumber || '')}"${r?' disabled':''}/></label>
                    <label class="block"><span class="field-label">Room type</span><select id="urType" class="field"${t?' disabled':''}>${data.rooms.map(x=>`<option value="${esc(x._id)}"${x._id===t?._id?' selected':''}>${esc(x.name)}</option>`).join('')}</select></label>
                    <label class="block"><span class="field-label">Nightly rate override (optional)</span><input id="urRate" type="number" class="field" min="0.01" max="1000000" step="0.01" placeholder="Use type rate" value="${r?.rateOverride ?? ''}"/></label>
                    <label class="block"><span class="field-label">Guests per room</span><input id="urGuests" type="number" class="field" min="1" max="30" value="${r?.maxGuests || t?.maxGuests || 2}"/></label>
                    <label class="block sm:col-span-2"><span class="field-label">Room details</span><input id="urDescription" class="field" maxlength="80" value="${esc(r?.description || '')}"/></label>
                    <label class="block"><span class="field-label">Available from</span><input id="urFrom" class="field" type="date" value="${r?.availableFrom || A.manilaToday()}"${r?' disabled':''}/></label>
                    <label class="block"><span class="field-label">Last available night (optional)</span><input id="urUntil" class="field" type="date" value="${r?.availableUntil?A.addDays(r.availableUntil,-1):''}"/></label>
                </div>
                <fieldset class="space-y-3"><legend class="field-label">Room photos · up to 12</legend><div id="urPhotos" class="ur-photos"></div>
                <label class="btn btn-secondary min-h-[44px] cursor-pointer">Add photos<input id="urFiles" type="file" accept="image/jpeg,image/png,image/webp" multiple class="sr-only"/></label><p id="urUploadStatus" role="status"></p></fieldset>`,
                actions:[{label:'Cancel',kind:'cancel'},{label:'Save room',kind:'primary',run:async()=>{
                    if(uploading)throw Error('Wait for the photo uploads to finish.');
                    const q=id=>w.el.querySelector('#'+id).value;
                    const body={roomNumber:q('urNumber').trim(),roomTypeId:q('urType'),rateOverride:q('urRate')===''?null:Number(q('urRate')),
                        maxGuests:Number(q('urGuests')),description:q('urDescription').trim(),availableFrom:q('urFrom'),availableUntil:q('urUntil')?A.addDays(q('urUntil'),1):null,photos};
                    await A.api(r?`/room-inventory/rooms/${r._id}`:`/room-inventory/${spot._id}/rooms`,{method:r?'PUT':'POST',body});
                    A.toast('Room saved');await reload();
                }}]});
            w.el.classList.add('ur-window');
            w.el.querySelector('input:not(:disabled),select:not(:disabled),button').focus();
            w.el.addEventListener('keydown',e=>{if(e.key!=='Tab')return;
                const focusable=Array.from(w.el.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')).filter(x=>x.getClientRects().length);
                const first=focusable[0],last=focusable[focusable.length-1];
                if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
                else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
            });
            const renderPhotos=()=>{w.el.querySelector('#urPhotos').innerHTML=photos.map((url,i)=>`<div><img src="${esc(url)}" alt="Room photo ${i+1}"/><div class="flex flex-wrap gap-2">${i===0?'<b>Cover photo</b>':`<button type="button" class="pg-btn pg-btn--plain" data-cover="${i}">Make cover</button>`}<button type="button" class="pg-btn pg-btn--plain" data-remove-photo="${i}">Remove photo ${i+1}</button></div></div>`).join('');};
            renderPhotos();window.ZTIMS_UPLOAD.reset();
            w.el.querySelector('#urPhotos').onclick=e=>{if(uploading)return;const b=e.target.closest('[data-cover],[data-remove-photo]');if(!b)return;
                if(b.dataset.cover!==undefined){const i=Number(b.dataset.cover);photos.unshift(photos.splice(i,1)[0]);}else photos.splice(Number(b.dataset.removePhoto),1);renderPhotos();};
            w.el.querySelector('#urFiles').onchange=async e=>{
                const files=Array.from(e.target.files);if(!files.length)return;
                if(photos.length+files.length>12){w.error('Choose up to 12 photos in total.');e.target.value='';return;}
                uploading=true;w.busy(true);w.error('');e.target.disabled=true;
                const status=w.el.querySelector('#urUploadStatus');
                try {for(let i=0;i<files.length;i++){status.textContent=`Uploading photo ${i+1} of ${files.length}…`;
                    const url=await window.ZTIMS_UPLOAD.uploadImage(files[i],{...uploadOptions,apiBase:'/api'});if(!photos.includes(url))photos.push(url);if(!w.el.isConnected)return;renderPhotos();}
                    status.textContent='Photos ready to save';
                }catch(err){status.textContent='';w.error(err.message);}finally{uploading=false;w.busy(false);e.target.disabled=false;e.target.value='';}
            };
        }
    }
    window.ZTIMSRooms={mount};
})();
