const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs');
const path=require('path'),os=require('os');
const fixture=JSON.parse(fs.readFileSync(process.env.ROOMS_FIXTURE || path.join(os.tmpdir(),'ztims-room-check-fixture.json')));
const origin=process.env.ROOMS_BROWSER_ORIGIN || 'http://127.0.0.1:3000';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname))throw Error('Browser checks require a local website.');
const out=process.env.ROOMS_SCREENSHOTS || path.join(os.tmpdir(),'ztims-room-check-screenshots');fs.mkdirSync(out,{recursive:true});
const assert=(c,m)=>{if(!c)throw Error(m);console.log('PASS '+m);};
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  for(const width of [1440,390]) for(const theme of ['light','dark']){
   const context=await browser.newContext({viewport:{width,height:width===390?844:1000},colorScheme:theme,reducedMotion:'reduce'});
   await context.addInitScript(({f,theme})=>{localStorage.setItem('theme',theme);localStorage.setItem('authToken',f.managerToken);localStorage.setItem('userRole','establishment_manager');localStorage.setItem('userEmail',f.managerEmail);localStorage.setItem('ztimsEnterprise',f.spotId);localStorage.setItem('ztimsVisitorToken',f.visitorToken);},{f:fixture,theme});
   // Synthetic fixture photos are rendered locally; no uploads or real records.
   await context.route('https://res.cloudinary.com/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#7A2E00"/><text x="30" y="100" fill="#FAF7F2" font-size="24">Local test photo</text></svg>'}));
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   page.on('response',async r=>{if(r.request().method()==='DELETE')console.log('DELETE RESULT',r.status(),await r.text());});
   await page.goto(origin+'/src/resort/resort_rooms.html',{waitUntil:'networkidle'});
   await page.waitForSelector('.ur-group',{timeout:20000});
   assert(await page.locator('.ur-row').count()>=5,`${width} ${theme}: numbered rooms mounted`);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width} ${theme}: manager has no page overflow`);
   const styles=await page.locator('.ur-group').first().evaluate(el=>({bg:getComputedStyle(el).backgroundColor,fg:getComputedStyle(el).color}));
   assert(theme==='light'?styles.bg==='rgb(253, 251, 247)':styles.bg==='rgb(28, 26, 24)',`${width} ${theme}: correct room surface`);
   await page.screenshot({path:`${out}/rooms-${width}-${theme}.png`,fullPage:true});
   await page.locator('[data-unified="edit"]').first().click();
   await page.waitForSelector('#urPhotos');
   assert(await page.locator('#urPhotos img').count()===2,`${width} ${theme}: multiple photos in editor`);
   await page.getByRole('button',{name:'Make cover',exact:true}).click();
   let uploadCount=0;
   await page.route('**/api/uploads/signature',r=>r.fulfill({json:{signed:false}}));
   await page.route('https://api.cloudinary.com/v1_1/**',r=>r.fulfill({json:{secure_url:`https://res.cloudinary.com/xeo3pvpw/image/upload/local-ui-${++uploadCount}.png`}}));
   await page.locator('#urFiles').setInputFiles([1,2].map(n=>({name:`photo${n}.png`,mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64')})));
   await page.waitForFunction(()=>document.querySelectorAll('#urPhotos img').length===4);
   assert(uploadCount===2,`${width} ${theme}: two photo files uploaded through shared uploader (local service stub)`);
   await page.locator('[data-remove-photo="3"]').click();await page.locator('[data-remove-photo="2"]').click();
   await page.locator('#urRate').fill('1375');
   await page.locator('.acc-window .ztims-modal').evaluate(el=>el.scrollTop=0);
   await page.screenshot({path:`${out}/room-editor-${width}-${theme}.png`});
   await page.getByRole('button',{name:'Save room',exact:true}).click();
   await page.waitForSelector('#urRate',{state:'detached'});
   assert((await page.locator('.ur-row').first().innerText()).includes('1,375'),`${width} ${theme}: room saved through UI`);
   // Real API save/delete, ordinary unused room available after the finalized month.
   const uiNumber=`UI-${width}-${theme}-${Date.now().toString().slice(-4)}`;
   await page.locator('[data-unified="add"]').first().click();
   await page.locator('#urNumber').fill(uiNumber);
   await page.getByRole('button',{name:'Save room',exact:true}).click();await page.waitForSelector('#urNumber',{state:'detached'});
   const added=page.locator('.ur-row').filter({hasText:`Room ${uiNumber}`});await added.waitFor();
   await added.getByRole('button',{name:'Delete',exact:true}).click();
   await page.getByRole('button',{name:'Keep',exact:true}).click();
   await page.locator('.ztims-dialog').waitFor({state:'detached'});
   assert(await added.count()===1,`${width} ${theme}: delete cancel preserves room`);
   await added.getByRole('button',{name:'Delete',exact:true}).click();
   await page.locator('.ztims-dialog').getByRole('button',{name:'Delete',exact:true}).click();
   try{await added.waitFor({state:'detached',timeout:8000});}catch(e){await page.screenshot({path:out+'/delete-failure.png',fullPage:true});console.log('ERRORS',errors,await page.locator('body').innerText());throw e;}
   assert(true,`${width} ${theme}: unused room delete confirmed`);
   await page.goto(`${origin}/src/spot.html?spotId=${fixture.spotId}`,{waitUntil:'networkidle'});
   await page.locator('#roomOffer [data-act="rooms"]').click();
   try{await page.waitForSelector('#roomModal:not([hidden])',{timeout:10000});}catch(e){console.log('VISITOR OPEN FAILED',errors,await page.locator('body').innerText());await page.screenshot({path:out+'/visitor-open-failure.png'});throw e;}
   const from=new Date(Date.now()+7*86400000).toISOString().slice(0,10),until=new Date(Date.now()+9*86400000).toISOString().slice(0,10);
   await page.locator('#rbIn').fill(from);await page.locator('#rbIn').dispatchEvent('change');await page.locator('#rbOut').fill(until);
   await page.locator('#rbNext').click();await page.waitForSelector('.rb-room');
   assert((await page.locator('.rb-room').first().innerText()).includes('Room 101'),`${width} ${theme}: visitor picks exact room`);
   await page.locator('.rb-room-gallery summary').first().click();
   await page.screenshot({path:`${out}/visitor-rooms-${width}-${theme}.png`,fullPage:true});
   assert(await page.locator('#roomModal').evaluate(el=>el.scrollWidth<=el.clientWidth+1),`${width} ${theme}: visitor picker has no horizontal overflow`);
   assert(errors.length===0,`${width} ${theme}: no page script errors: ${errors.join('; ')}`);
   await context.close();
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
