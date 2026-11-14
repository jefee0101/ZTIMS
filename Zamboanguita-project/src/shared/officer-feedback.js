/* Officer-only workspace. Messages stay private; reviews stay public. */
(function(){
    const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const date=s=>new Date(s).toLocaleDateString('en-PH',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Manila'});
    async function api(path,options={}){
        const r=await fetch('/api'+path,{...options,headers:{Authorization:'Bearer '+(localStorage.getItem('authToken')||''),'Content-Type':'application/json'}});
        if(r.status===401){location.assign('../staff_login.html?next=admin/admin_feedback.html');throw Error('Please sign in again.');}
        const data=await r.json();if(!r.ok)throw Error(data.message||'Could not load feedback.');return data;
    }
    function start(root){
        let places=[],messages=[],reviews=[],group=location.hash==='#enterprises'?'enterprises':'office',place='',status='open',search='',filter='all';
        if(group==='enterprises')status='visible';
        const office=()=>places.filter(p=>p.type==='spot'&&!p.managedBy);
        const enterprises=()=>places.filter(p=>p.type==='accommodation'&&p.managedBy);
        const name=p=>p.enterpriseName||p.title;
        const messagePlace=m=>{try{const u=new URL(m.page,location.origin);return u.pathname==='/src/spot.html'&&office().some(p=>p._id===u.searchParams.get('spotId'))?u.searchParams.get('spotId'):'';}catch{return '';}};
        async function load(){
            root.innerHTML='<p role="status" aria-busy="true">Loading feedback…</p>';
            try{[places,messages,reviews]=await Promise.all([api('/spots'),api('/feedback'),api('/reviews/admin')]);shell();}
            catch(e){root.innerHTML=`<p role="alert">${esc(e.message)}</p><button class="btn btn-secondary" data-retry>Try again</button>`;}
        }
        function shell(){
            const isOffice=group==='office';
            const list=isOffice?office():enterprises();
            if(!isOffice&&!list.some(p=>p._id===place))place=list[0]?._id||'';
            root.innerHTML=`<nav class="flex flex-wrap gap-2" aria-label="Feedback groups">
                <button class="btn ${isOffice?'btn-primary':'btn-secondary'}" data-group="office" aria-pressed="${isOffice}">Office-managed</button>
                <button class="btn ${!isOffice?'btn-primary':'btn-secondary'}" data-group="enterprises" aria-pressed="${!isOffice}">Enterprise reviews</button></nav>
                <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <label><span class="field-label">${isOffice?'Attraction':'Enterprise'}</span><select class="field w-full" id="ufPlace">${isOffice?'<option value="">All office feedback</option><option value="general">Tourism Office / general</option>':''}${list.map(p=>`<option value="${esc(p._id)}" ${place===p._id?'selected':''}>${esc(name(p))}</option>`).join('')}</select></label>
                <label><span class="field-label">Status</span><select class="field w-full" id="ufStatus">${(isOffice?['open','new','read','resolved','all']:['visible','hidden','all']).map(v=>`<option value="${v}" ${status===v?'selected':''}>${v==='visible'?'Shown':v[0].toUpperCase()+v.slice(1)}</option>`).join('')}</select></label>
                <label><span class="field-label">${isOffice?'Topic':'Rating'}</span><select class="field w-full" id="ufFilter">${(isOffice?['all','listing','problem','suggestion','booking','other']:['all','1','2','3','4','5']).map(v=>`<option value="${v}">${v==='all'?'All':isOffice?v:v+' stars'}</option>`).join('')}</select></label>
                <label><span class="field-label">Search</span><input class="field w-full" id="ufSearch" type="search" value="${esc(search)}" placeholder="Search feedback"/></label></div>
                <p id="ufError" role="alert" class="text-error" hidden></p><div class="glass-panel divide-y divide-outline-variant/30" id="ufRows"></div><p id="ufCount" class="text-support"></p>`;
            root.querySelector('#ufPlace').value=place;
            root.querySelector('#ufFilter').value=filter;
            root.querySelector('#ufPlace').onchange=e=>{place=e.target.value;rows();};
            root.querySelector('#ufStatus').onchange=e=>{status=e.target.value;rows();};
            root.querySelector('#ufFilter').onchange=e=>{filter=e.target.value;rows();};
            root.querySelector('#ufSearch').oninput=e=>{search=e.target.value;rows();};rows();
        }
        function rows(){
            const isOffice=group==='office';
            const items=(isOffice?messages:reviews.filter(r=>enterprises().some(p=>p._id===r.spot._id))).filter(r=>{
                if(isOffice){const id=messagePlace(r);if(place==='general'?!!id:place&&id!==place)return false;
                    if(status==='open'?r.status==='resolved':status!=='all'&&r.status!==status)return false;
                    if(filter!=='all'&&r.topic!==filter)return false;
                }else{if(r.spot._id!==place)return false;if(status!=='all'&&r.status!==status)return false;if(filter!=='all'&&r.rating!==Number(filter))return false;}
                return !search||[r.message,r.name,r.email,r.body,r.author].some(v=>String(v||'').toLowerCase().includes(search.toLowerCase()));
            });
            root.querySelector('#ufRows').innerHTML=items.length?items.map(r=>{
                const title=isOffice?(office().find(p=>p._id===messagePlace(r))?.title||'Tourism Office / general'):'★'.repeat(r.rating)+'☆'.repeat(5-r.rating);
                const text=isOffice?r.message:r.body||'Rating only';
                return `<details class="p-4"><summary class="cursor-pointer min-h-[44px] flex flex-wrap items-center gap-3"><span class="flex-1 basis-full sm:basis-0 min-w-0"><b class="block">${esc(title)}</b><span class="block truncate">${esc(text.slice(0,120))}</span></span><span class="text-support">${esc(date(r.createdAt))} · ${esc(r.status==='visible'?'Shown':r.status)}</span><span class="text-support">Details ▾</span></summary>
                <div class="space-y-3 pt-3"><p class="whitespace-pre-wrap break-words">${esc(text)}</p><p class="text-support break-words">${esc(isOffice?(r.name||'Anonymous')+(r.email?' · '+r.email:''):r.author)}</p>
                ${isOffice?`<p class="text-support break-words">Topic: ${esc(r.topic)}${r.page?' · Context: '+esc(messagePlace(r)?'Attraction page':r.page):''}</p>`:''}
                ${!isOffice&&r.hiddenReason?`<p class="break-words">Reason: ${esc(r.hiddenReason)}</p>`:''}
                ${!isOffice&&r.history?.length?`<details><summary class="cursor-pointer py-2">Moderation history</summary><ul class="space-y-2">${r.history.map(h=>`<li class="break-words">${esc(h.action==='hidden'?'Hidden':'Shown')} · ${esc(date(h.at))} · ${esc(h.by)}<br>${esc(h.reason)}</li>`).join('')}</ul></details>`:''}
                <div class="flex flex-wrap gap-2">${isOffice?`${r.status==='new'?`<button class="btn btn-secondary min-h-[44px]" data-state="read" data-id="${esc(r._id)}">Mark read</button>`:''}<button class="btn btn-secondary min-h-[44px]" data-state="${r.status==='resolved'?'read':'resolved'}" data-id="${esc(r._id)}">${r.status==='resolved'?'Reopen':'Mark resolved'}</button>`:`<button class="btn btn-secondary min-h-[44px]" data-review="${esc(r._id)}">${r.status==='hidden'?'Show review':'Hide review'}</button>`}</div></div></details>`;
            }).join(''):'<p class="p-5">'+(isOffice?'No messages match.':place?'No reviews match for this enterprise.':'No accommodation enterprises yet.')+'</p>';
            root.querySelector('#ufCount').textContent=items.length+' '+(isOffice?(items.length===1?'message':'messages'):(items.length===1?'review':'reviews'));
        }
        root.addEventListener('click',async e=>{
            const b=e.target.closest('button');if(!b)return;
            if(b.hasAttribute('data-retry'))return load();
            if(b.dataset.group){group=b.dataset.group;place='';status=group==='office'?'open':'visible';filter='all';search='';history.replaceState(null,'','#'+group);shell();return;}
            if(!b.dataset.state&&!b.dataset.review)return;
            const box=root.querySelector('#ufError');box.hidden=true;b.disabled=true;
            try{
                if(b.dataset.review){
                    const r=reviews.find(r=>r._id===b.dataset.review);
                    const answer=await window.ztimsDialog.form({title:r.status==='hidden'?'Show review':'Hide review',fields:[{name:'reason',label:'Reason',required:true,minlength:3,maxlength:300}],validate:v=>v.reason.trim().length<3?'Give a reason.':''});
                    if(!answer)return;
                    await api('/reviews/'+encodeURIComponent(r._id)+'/visibility',{method:'PATCH',body:JSON.stringify({hidden:r.status!=='hidden',reason:answer.reason.trim()})});
                    reviews=await api('/reviews/admin');
                }else{const result=await api('/feedback/'+encodeURIComponent(b.dataset.id)+'/status',{method:'PATCH',body:JSON.stringify({status:b.dataset.state})});messages=messages.map(r=>r._id===b.dataset.id?result.feedback:r);}
                rows();
            }catch(err){box.textContent=err.message;box.hidden=false;}finally{b.disabled=false;}
        });
        window.addEventListener('hashchange',()=>{group=location.hash==='#enterprises'?'enterprises':'office';place='';status=group==='office'?'open':'visible';filter='all';search='';shell();});
        load();
    }
    window.ZTIMSFeedback={start};
})();
