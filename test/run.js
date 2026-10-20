// Offline logic tests. Needs: npm i playwright-core, and a Chromium (set CHROMIUM_PATH or use Playwright's). Run: node test/run.js
// Uses a stub style so it works without network. It does NOT test real OpenFreeMap rendering.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT=path.resolve(__dirname,'..'), T=__dirname;
const srv = http.createServer((q,r)=>{ let u=q.url.split('?')[0]; let f = /^\/test[\w-]*\.html$/.test(u)?path.join(T,u):path.join(ROOT,u);
  fs.readFile(f,(e,d)=>{ if(e){r.writeHead(404);r.end();return;} r.writeHead(200,{'content-type':f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':f.endsWith('.json')?'application/json':'text/html'}); r.end(d);});}).listen(8765);
const STUB = {version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#eef'}}]};
const data = JSON.parse(fs.readFileSync(ROOT+'/data/atlanta-mock.json'));
const res=[]; const ok=(n,c,x='')=>{res.push([c?'PASS':'FAIL',n,x]);};
(async()=>{
 const b = await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined, args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
 for (const vp of [{w:1280,h:800,n:'desktop'},{w:390,h:844,n:'mobile'}]) {
  const p = await b.newPage({viewport:{width:vp.w,height:vp.h}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto('http://localhost:8765/test.html');
  await p.evaluate(([s,d])=>new Promise(r=>{window.lm=LazerMap.init('#m',{style:s,data:d,market:'atlanta-ga',onReady:r});}),[STUB,data]);
  await p.waitForTimeout(400);
  const info = await p.evaluate(()=>{const m=lm.map,c=document.querySelector('.lm-canvas').getBoundingClientRect();
    const pins=[...document.querySelectorAll('.lm-pin')].map(e=>e.getBoundingClientRect());
    return {n:pins.length,zoom:m.getZoom(),minZoom:m.getMinZoom(),maxZoom:m.getMaxZoom(),inside:pins.every(r=>r.left>=c.left&&r.right<=c.right&&r.top>=c.top&&r.bottom<=c.bottom),
      status:document.querySelector('.lm-status').hidden, hasMaxBounds:!!m.getMaxBounds()};});
  ok(vp.n+': 14 pins, all inside viewport', info.n===14&&info.inside, JSON.stringify(info));
  ok(vp.n+': ready state hides overlay', info.status);
  ok(vp.n+': maxZoom=10 and minZoom<fit zoom', info.maxZoom===10 && info.minZoom<info.zoom, `min ${info.minZoom.toFixed(2)} fit ${info.zoom.toFixed(2)}`);
  const z = await p.evaluate(()=>{lm.map.jumpTo({zoom:15});return lm.map.getZoom();});
  ok(vp.n+': cannot zoom beyond 10', z<=10, 'zoom='+z);
  const pan = await p.evaluate(()=>{lm.map.jumpTo({center:[-87.6,41.9]});const c=lm.map.getCenter();return c.lng.toFixed(1)+','+c.lat.toFixed(1);});
  ok(vp.n+': pan limited to market area', parseFloat(pan.split(',')[1])<36, 'center after jump to Chicago: '+pan);
  // a11y
  const a11y = await p.evaluate(async()=>{const b=document.querySelector('.lm-pin');b.focus();await new Promise(r=>setTimeout(r,100));
    const tip=document.querySelector('[role=tooltip]');const d=b.getAttribute('aria-describedby');
    const res={isButton:b.tagName==='BUTTON',label:b.getAttribute('aria-label'),tip:!!tip&&tip.id===d,text:tip&&tip.textContent};
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));await new Promise(r=>setTimeout(r,50));
    res.closed=!document.querySelector('[role=tooltip]');b.click();await new Promise(r=>setTimeout(r,50));res.pinned=!!document.querySelector('[role=tooltip]');b.blur();await new Promise(r=>setTimeout(r,50));res.stays=!!document.querySelector('[role=tooltip]');
    b.click();await new Promise(r=>setTimeout(r,50));res.toggled=!document.querySelector('[role=tooltip]');return res;});
  ok(vp.n+': pin is button w/ label; focus shows tooltip linked by aria-describedby', a11y.isButton&&a11y.tip&&/Lazer opportunities/.test(a11y.text), JSON.stringify(a11y));
  ok(vp.n+': Esc closes; click pins (touch); click again toggles', a11y.closed&&a11y.pinned&&a11y.stays&&a11y.toggled);
  // privacy: no 5-digit numbers in visible DOM text, coords not in DOM attributes
  const priv = await p.evaluate(()=>{const t=document.body.innerText+document.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g,'');return {zip:/\b\d{5}\b/.test(document.querySelector('#m').innerText), coordAttr:/data-(lat|lng|ncf)|-84\.\d/.test(document.querySelector('#m').outerHTML.replace(/style="[^"]*"/g,'')) };});
  ok(vp.n+': no ZIP-like text and no coordinates in map DOM', !priv.zip&&!priv.coordAttr, JSON.stringify(priv));
  // resize refit
  await p.setViewportSize({width:vp.n==='desktop'?900:1100,height:700}); await p.waitForTimeout(900);
  const after = await p.evaluate(()=>{const c=document.querySelector('.lm-canvas').getBoundingClientRect();return [...document.querySelectorAll('.lm-pin')].every(e=>{const r=e.getBoundingClientRect();return r.left>=c.left&&r.right<=c.right&&r.top>=c.top&&r.bottom<=c.bottom;});});
  ok(vp.n+': refit on resize keeps all pins visible', after);
  ok(vp.n+': no page errors', errs.length===0, errs.join('|'));
  await p.close();
 }
 // single point, market filter, sanitizer, error/empty states
 let p = await b.newPage({viewport:{width:1000,height:700}}); await p.goto('http://localhost:8765/test.html');
 const s = await p.evaluate(([s,d])=>{ const g=LazerMap.sanitizePoints([{id:'a b!',label:'Facility ZIP 30336',lng:-84.56901,lat:33.73544,zip:'30336',street:'x',market:'t'},{label:'ok',lng:'bad',lat:1},{label:'Fine Area',lng:-84.123456,lat:33.987654}],{coordPrecision:2,labels:{fallbackArea:'Lazer location area'}});return g;},[STUB,data]);
 ok('sanitizer: rounds to 2 decimals, strips extra fields, generalizes ZIP label, drops invalid', s.length===2&&s[0].lng===-84.57&&s[0].lat===33.74&&s[0].label==='Lazer location area'&&!('zip' in s[0])&&!('street' in s[0])&&s[1].lat===33.99, JSON.stringify(s));
 const one = await p.evaluate(([s])=>new Promise(r=>{LazerMap.init('#m',{style:s,data:[{id:'x',label:'Solo Area',lng:-96.8,lat:32.78}],onReady:a=>r({z:a.map.getZoom(),n:a.points.length})});}),[STUB]);
 ok('single-point market uses fixed zoom (<=10)', one.n===1&&one.z<=10&&one.z>=8, JSON.stringify(one));
 const mk = await p.evaluate(([s])=>new Promise(r=>{LazerMap.init('#m',{style:s,market:'chi',data:[{id:'1',label:'A',lng:-84.4,lat:33.7,market:'atl'},{id:'2',label:'B',lng:-87.6,lat:41.8,market:'chi'},{id:'3',label:'C',lng:-87.7,lat:41.9,market:'chi'}],onReady:a=>r({n:a.points.length,c:a.map.getCenter().lat})});}),[STUB]);
 ok('market filter shows only that market and fits to it', mk.n===2&&mk.c>41, JSON.stringify(mk));
 const em = await p.evaluate(([s,d])=>{LazerMap.init('#m',{style:s,data:d,market:'none'});return new Promise(r=>setTimeout(()=>{const st=document.querySelector('.lm-status');r({hidden:st.hidden,state:st.dataset.state,role:st.getAttribute('role'),txt:st.innerText});},400));},[STUB,data]);
 ok('empty market shows empty state (alert)', !em.hidden&&em.state==='empty'&&em.role==='alert', JSON.stringify(em));
 // real style URL unreachable from sandbox -> graceful error + retry + fallback list
 const er = await p.evaluate(([d])=>{LazerMap.init('#m',{data:d,loadTimeoutMs:4000});return new Promise(r=>setTimeout(()=>{const st=document.querySelector('.lm-status');r({state:st.dataset.state,retry:getComputedStyle(st.querySelector('.lm-retry')).display!=='none',fallbackItems:st.querySelectorAll('.lm-fallback li').length,role:st.getAttribute('role'),txt:st.querySelector('p').textContent});},3000));},[data]);
 ok('style load failure shows error, retry button and text fallback list', er.state==='error'&&er.retry&&er.fallbackItems>=14&&er.role==='alert', JSON.stringify(er));

 { const pr = await b.newPage({viewport:{width:1000,height:700}}); await pr.goto('http://localhost:8765/test-css-order.html');
   const o = await pr.evaluate(([s,d])=>new Promise(r=>{LazerMap.init('#m',{style:s,data:d,onReady:a=>{const c=document.querySelector('.lm-canvas').getBoundingClientRect(),h=document.querySelector('#m').getBoundingClientRect();r({canvasH:Math.round(c.height),rootH:Math.round(h.height),w:Math.round(c.width),rootW:Math.round(h.width)});}});}),[STUB,data]);
   ok('canvas fills container even if maplibre-gl.css loads after lazer-map.css', o.canvasH===o.rootH&&o.w===o.rootW&&o.rootH>300, JSON.stringify(o)); await pr.close(); }

 // ===================== R4M.2B refinement tests =====================
 const SNAP = () => { const m=lm.map, root=document.querySelector('#m'), cv=document.querySelector('.lm-canvas'), cc=document.querySelector('.maplibregl-canvas-container'); const c=m.getCenter();
   return {c:[c.lng,c.lat], z:m.getZoom(), sc:[root.scrollLeft,root.scrollTop,cv.scrollLeft,cv.scrollTop,cc.scrollLeft,cc.scrollTop], win:[scrollX,scrollY], mv:window.__mv,
     pins:[...document.querySelectorAll('.lm-pin')].map(e=>{const r=e.getBoundingClientRect();return [r.left,r.top];}),
     inside:[...document.querySelectorAll('.lm-pin')].every(e=>{const r=e.getBoundingClientRect(),b=root.getBoundingClientRect();return r.left>=b.left&&r.right<=b.right&&r.top>=b.top&&r.bottom<=b.bottom;}),
     tips:document.querySelectorAll('[role=tooltip]').length, maxB:!!m.getMaxBounds(), minZ:m.getMinZoom()}; };
 const open = async (vp, points) => { const cx=await b.newContext({viewport:{width:vp[0],height:vp[1]},isMobile:vp[0]<600,hasTouch:vp[0]<600}); const pg=await cx.newPage(); await pg.goto('http://localhost:8765/test.html');
   await pg.evaluate(([s,d])=>new Promise(r=>{window.__mv=0;window.lm=LazerMap.init('#m',{style:s,data:d,market:d.market||undefined,onReady:a=>{a.map.on('movestart',()=>window.__mv++);r();}});}),[STUB,points||data.points.map(p=>p)]); await pg.waitForTimeout(450); return {cx,pg}; };
 const near = (a,b,e) => Math.abs(a-b) <= e;
 const rootBox = pg => pg.evaluate(()=>{const r=document.querySelector('#m').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};});

 const tryTest = async (name, fn) => { try { await fn(); } catch (e) { ok(name+' (test threw)', false, String(e.message).split('\n')[0]); } };
 await tryTest('initial visibility sweep', async () => {
 // 5. all 14 markers visible before any interaction, nothing under a control, across phone/tablet/desktop sizes
 { const VPS=[[320,568],[360,640],[375,667],[390,844],[414,896],[430,932],[768,1024],[820,1180],[1024,768],[1280,800],[1440,900],[1920,1080]]; const bad=[];
   for (const vp of VPS) { const {cx,pg}=await open(vp);
     const r=await pg.evaluate(()=>{const root=document.querySelector('#m').getBoundingClientRect();const pins=[...document.querySelectorAll('.lm-pin')].map(e=>{const q=e.getBoundingClientRect();return {x:q.left+q.width/2,y:q.top+q.height/2};});
       const ctr=[...document.querySelectorAll('.maplibregl-ctrl-group,.lm-reset-group,.maplibregl-ctrl-attrib')].map(e=>e.getBoundingClientRect()).filter(q=>q.width>0);const R=11;
       const inside=pins.every(q=>q.x-R>=root.left&&q.x+R<=root.right&&q.y-R>=root.top&&q.y+R<=root.bottom);
       const hit=pins.some(q=>ctr.some(c=>{const nx=Math.max(c.left,Math.min(q.x,c.right)),ny=Math.max(c.top,Math.min(q.y,c.bottom));return Math.hypot(q.x-nx,q.y-ny)<R+4;}));
       return {n:pins.length,inside,hit,tips:document.querySelectorAll('[role=tooltip]').length,z:lm.map.getZoom()};});
     if (!(r.n===14&&r.inside&&!r.hit&&r.tips===0&&r.z<=10)) bad.push(vp.join('x')+' '+JSON.stringify(r)); await cx.close(); }
   ok('initial view, 12 viewport sizes (320 to 1920 px): all 14 pins visible, none under a control, no tooltip open', bad.length===0, bad.join(' | ')); }

 });
 await tryTest('reset view', async () => {
 // 1. Reset view: returns to the original fit (all pins), restores limits, closes tooltip; works by mouse and keyboard
 for (const vp of [[1280,800],[390,844]]) { const n=vp[0]<600?'mobile':'desktop'; const {cx,pg}=await open(vp); const s0=await pg.evaluate(SNAP); const rb=await rootBox(pg);
   const btn=await pg.evaluate(()=>{const e=document.querySelector('.lm-reset');return e?{label:e.getAttribute('aria-label'),text:e.textContent.trim(),h:e.getBoundingClientRect().height}:null;});
   ok(n+': reset control is a labelled button ("Reset view"), at least 30px tall', !!btn&&btn.label==='Reset view'&&btn.text==='Reset view'&&btn.h>=30, JSON.stringify(btn));
   await pg.mouse.move(rb.x+rb.w/2,rb.y+rb.h/2); await pg.mouse.down(); await pg.mouse.move(rb.x+rb.w/2-140,rb.y+rb.h/2-70,{steps:8}); await pg.mouse.up();
   await pg.click('.maplibregl-ctrl-zoom-in'); await pg.click('.maplibregl-ctrl-zoom-in'); await pg.waitForTimeout(900);
   const pin0=await pg.evaluate(()=>{const r=document.querySelector('.lm-pin').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];});
   await pg.evaluate(()=>{document.querySelector('.lm-pin').click();}); await pg.waitForTimeout(150);
   const s1=await pg.evaluate(SNAP); ok(n+': after pan + zoom + open tooltip the view really differs', !near(s1.z,s0.z,0.2)&&s1.tips===1, `z ${s0.z.toFixed(2)} -> ${s1.z.toFixed(2)}`);
   await pg.focus('.lm-reset'); await pg.keyboard.press('Enter'); await pg.waitForTimeout(1100); const s2=await pg.evaluate(SNAP);
   ok(n+': Reset (keyboard Enter) returns to the original view and shows all 14 pins', near(s2.z,s0.z,0.002)&&near(s2.c[0],s0.c[0],0.002)&&near(s2.c[1],s0.c[1],0.002)&&s2.inside, `z ${s2.z.toFixed(3)} vs ${s0.z.toFixed(3)}`);
   ok(n+': Reset closes the tooltip and restores zoom/pan limits (min zoom below fit, max 10)', s2.tips===0&&s2.maxB&&s2.minZ<s2.z&&(await pg.evaluate(()=>lm.map.getMaxZoom()))===10, JSON.stringify({tips:s2.tips,maxB:s2.maxB,minZ:s2.minZ}));
   await pg.mouse.move(rb.x+rb.w/2,rb.y+rb.h/2); await pg.mouse.down(); await pg.mouse.move(rb.x+rb.w/2+120,rb.y+rb.h/2+60,{steps:6}); await pg.mouse.up(); await pg.waitForTimeout(300);
   await pg.click('.lm-reset'); await pg.waitForTimeout(1100); const s3=await pg.evaluate(SNAP);
   ok(n+': Reset (mouse click) also returns to the original view', near(s3.z,s0.z,0.002)&&near(s3.c[0],s0.c[0],0.002)&&near(s3.c[1],s0.c[1],0.002)&&s3.inside);
   await pg.click('.lm-reset'); await pg.waitForTimeout(900); const s4=await pg.evaluate(SNAP);
   ok(n+': Reset when already at the original view changes nothing and keeps the limits', near(s4.z,s0.z,0.002)&&s4.maxB&&s4.inside); await cx.close(); }
 });
 await tryTest('single-point reset', async () => {
 { const one=[{id:'solo',label:'Solo Area',lng:-96.8,lat:32.78,market:undefined}]; const {cx,pg}=await open([1000,700],one); const z0=await pg.evaluate(()=>lm.map.getZoom());
   await pg.click('.maplibregl-ctrl-zoom-in'); await pg.waitForTimeout(700); await pg.click('.lm-reset'); await pg.waitForTimeout(1000); const z1=await pg.evaluate(()=>lm.map.getZoom());
   ok('single-point market: Reset returns to the fixed zoom (<=10)', near(z1,z0,0.01)&&z1<=10, `${z0} -> ${z1}`); await cx.close(); }

 });
 await tryTest('tooltip stability', async () => {
 // 2. tooltip stability: opening a tooltip never pans/zooms the map or shifts the layout (tap on mobile, click on desktop)
 for (const vp of [[390,844],[1280,800]]) { const n=vp[0]<600?'mobile':'desktop'; const {cx,pg}=await open(vp); const bad=[];
   for (let i=0;i<14;i++) { const a=await pg.evaluate(SNAP); const pos=await pg.evaluate(i=>{const r=document.querySelectorAll('.lm-pin')[i].getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];},i);
     if (vp[0]<600) await pg.touchscreen.tap(pos[0],pos[1]); else await pg.mouse.click(pos[0],pos[1]); await pg.waitForTimeout(250);
     const d=await pg.evaluate(SNAP); const tip=await pg.evaluate(()=>{const t=document.querySelector('.lm-tooltip .maplibregl-popup-content');if(!t)return null;const q=t.getBoundingClientRect(),r=document.querySelector('#m').getBoundingClientRect();return q.left>=r.left-0.5&&q.right<=r.right+0.5&&q.top>=r.top-0.5&&q.bottom<=r.bottom+0.5;});
     const moved=Math.max(...a.pins.map((p,k)=>Math.hypot(p[0]-d.pins[k][0],p[1]-d.pins[k][1])));
     if (a.c.join()!==d.c.join()||a.z!==d.z||a.sc.join()!==d.sc.join()||a.win.join()!==d.win.join()||a.mv!==d.mv||moved>0.01||tip!==true||d.tips!==1) bad.push('pin '+i+' '+JSON.stringify({moved,tip,mv:[a.mv,d.mv]}));
     await pg.keyboard.press('Escape'); await pg.waitForTimeout(60); }
   ok(n+': opening each of the 14 tooltips causes no pan, zoom, scroll or pin shift, and the tooltip stays inside the map', bad.length===0, bad.join(' | '));
   await pg.evaluate(()=>document.querySelector('.lm-pin').focus()); const k0=await pg.evaluate(SNAP); for (let i=0;i<14;i++){await pg.keyboard.press('Tab');await pg.waitForTimeout(40);} const k1=await pg.evaluate(SNAP);
   ok(n+': tabbing through all pins moves nothing', k0.c.join()===k1.c.join()&&k0.z===k1.z&&k0.sc.join()===k1.sc.join()&&k0.mv===k1.mv); await cx.close(); }
 });
 await tryTest('no redundant fit', async () => {
 { const {cx,pg}=await open([1280,800]); await pg.waitForTimeout(1500); const mv=await pg.evaluate(()=>window.__mv);
   ok('no redundant fit after load: the map does not move by itself once ready (was a 500 ms animated refit)', mv===0, 'move events: '+mv); await cx.close(); }

 });
 await tryTest('resize behavior', async () => {
 // resize: never undo the user's own pan/zoom; refit (instantly) only when the user has not moved the map
 { const {cx,pg}=await open([1280,800]); const rb=await rootBox(pg); await pg.click('.maplibregl-ctrl-zoom-in'); await pg.waitForTimeout(700);
   await pg.mouse.move(rb.x+rb.w/2,rb.y+rb.h/2); await pg.mouse.down(); await pg.mouse.move(rb.x+rb.w/2-90,rb.y+rb.h/2-40,{steps:5}); await pg.mouse.up(); await pg.waitForTimeout(400);
   const a=await pg.evaluate(SNAP); await pg.setViewportSize({width:1100,height:700}); await pg.waitForTimeout(900); const d=await pg.evaluate(SNAP);
   ok('resize after the user zoomed/panned keeps their view (no automatic refit)', near(a.z,d.z,0.001)&&near(a.c[0],d.c[0],0.01)&&near(a.c[1],d.c[1],0.01), `z ${a.z.toFixed(3)} -> ${d.z.toFixed(3)}`); await cx.close(); }
 { const {cx,pg}=await open([1280,800]); await pg.setViewportSize({width:900,height:700}); await pg.waitForTimeout(900); const d=await pg.evaluate(SNAP);
   ok('resize with an untouched map refits so all pins stay visible', d.inside&&d.tips===0); await cx.close(); }

 });
 await tryTest('zoom cap + keyboard', async () => {
 // 6. zoom cap and keyboard accessibility preserved
 { const {cx,pg}=await open([1280,800]); await pg.focus('.maplibregl-canvas'); for (let i=0;i<9;i++){await pg.keyboard.press('Equal');await pg.waitForTimeout(350);} await pg.waitForTimeout(600);
   const z=await pg.evaluate(()=>lm.map.getZoom()); ok('keyboard zoom (+) stops at the cap of 10', z<=10&&z>9.99, 'zoom '+z.toFixed(3));
   await pg.evaluate(()=>{lm.reset();}); await pg.waitForTimeout(900);
   await pg.evaluate(()=>{document.activeElement&&document.activeElement.blur();document.body.focus();}); const seen=new Set(); let pins=0;
   for (let i=0;i<24;i++){await pg.keyboard.press('Tab');const a=await pg.evaluate(()=>{const e=document.activeElement;return e?(e.className||e.tagName)+'':'';});if(/lm-pin/.test(a))pins++;seen.add(/lm-pin/.test(a)?'pin':/zoom-in/.test(a)?'zoom-in':/zoom-out/.test(a)?'zoom-out':/lm-reset/.test(a)?'reset':/maplibregl-canvas/.test(a)?'canvas':a);}
   ok('keyboard: Tab reaches all 14 pins, zoom in, zoom out and Reset view', pins>=14&&seen.has('zoom-in')&&seen.has('zoom-out')&&seen.has('reset'), 'pins '+pins+' '+[...seen].join(','));
   await pg.evaluate(()=>document.querySelector('.lm-pin').focus()); await pg.waitForTimeout(100); const t1=await pg.evaluate(()=>document.querySelectorAll('[role=tooltip]').length); await pg.keyboard.press('Escape'); const t2=await pg.evaluate(()=>document.querySelectorAll('[role=tooltip]').length);
   ok('keyboard: focusing a pin shows its tooltip, Escape closes it', t1===1&&t2===0, t1+' -> '+t2); await cx.close(); }

 });
 await tryTest('privacy guard', async () => {
 // 7. privacy: unchanged behaviour plus a warning when un-generalized coordinates reach the page
 { const p2=await b.newPage(); await p2.goto('http://localhost:8765/test.html');
   const r=await p2.evaluate(()=>{const w=[];const orig=console.warn;console.warn=m=>w.push(String(m));
     const hi=LazerMap.sanitizePoints([{id:'a',label:'Area A',lng:-84.56901,lat:33.73544},{id:'b',label:'ZIP+4 30336-1234 site',lng:-84.5,lat:33.7},{id:'c',label:'Suite A30336B',lng:-84.5,lat:33.7}],{coordPrecision:2,labels:{fallbackArea:'Lazer location area'}});
     const clean=LazerMap.sanitizePoints([{id:'a',label:'Area A',lng:-84.57,lat:33.74}],{coordPrecision:2,labels:{fallbackArea:'x'}});
     console.warn=orig;return {hi,w,cleanOk:clean.length===1};});
   ok('privacy guard: rounds, strips ZIP-like labels (incl. ZIP+4 and digits glued to letters)', r.hi[0].lng===-84.57&&r.hi[0].lat===33.74&&r.hi[1].label==='Lazer location area'&&r.hi[2].label==='Lazer location area', JSON.stringify(r.hi));
   ok('privacy guard warns that rounding in the browser is not protection when input is more precise than public precision', r.w.some(x=>/pre-generalized/.test(x))&&r.cleanOk, JSON.stringify(r.w));
   await p2.close(); }

 });
 await tryTest('interstate style + marker size', async () => {
 // 3 + 4. softer interstates (still clearly visible, distinct from primary roads) and marker size
 { const lum=h=>{const v=[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(x=>x<=0.03928?x/12.92:Math.pow((x+0.055)/1.055,2.4));return 0.2126*v[0]+0.7152*v[1]+0.0722*v[2];};
   const cr=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
   const p3=await b.newPage(); await p3.goto('http://localhost:8765/test.html');
   const st=await p3.evaluate(()=>{const s={layers:[{id:'road_motorway',type:'line',paint:{}},{id:'road_motorway_casing',type:'line',paint:{}},{id:'road_trunk_primary',type:'line',paint:{}},{id:'highway-shield-us-interstate',type:'symbol',minzoom:11}]};LazerMap.patchStyle(s);return s.layers.map(l=>({id:l.id,color:l.paint&&l.paint['line-color'],minzoom:l.minzoom}));});
   const mw=st[0].color, cs=st[1].color, tr=st[2].color, land='#f8f4ee';
   ok('interstate fill is softer than before (#f59e0b) and its casing still has strong contrast (>=3:1) against land', mw!=='#f59e0b'&&cr(cs,land)>=3, `fill ${mw} casing ${cs} contrast ${cr(cs,land).toFixed(1)}:1`);
   ok('interstates stay distinct from primary roads and interstate shields still show from zoom 7', Math.abs(parseInt(mw.slice(1,3),16)-parseInt(tr.slice(1,3),16))+Math.abs(parseInt(mw.slice(3,5),16)-parseInt(tr.slice(3,5),16))+Math.abs(parseInt(mw.slice(5,7),16)-parseInt(tr.slice(5,7),16))>=60&&st[3].minzoom===7, JSON.stringify({mw,tr,shield:st[3].minzoom}));
   await p3.close();
   for (const [w,exp] of [[1280,'18px'],[390,'18px'],[340,'16px']]) { const {cx,pg}=await open([w,800]); const px=await pg.evaluate(()=>getComputedStyle(document.querySelector('.lm-pin'),'::before').width);
     ok('marker red fill is '+exp+' at '+w+' px wide (white ring adds 2px each side)', px===exp, px); await cx.close(); } }
 });
 await tryTest('attribution vs reset', async () => {
 for (const w of [320,390,768,1280]) { const {cx,pg}=await open([w,800]);
   const r=await pg.evaluate(()=>{const a=document.querySelector('.maplibregl-ctrl-attrib'),b=document.querySelector('.lm-reset');if(!a||!b)return {missing:true};const A=a.getBoundingClientRect(),B=b.getBoundingClientRect();return {open:a.classList.contains('maplibregl-compact-show'),overlap:!(A.right<=B.left||A.left>=B.right||A.bottom<=B.top||A.top>=B.bottom),hasBtn:!!a.querySelector('summary,button')};});
   ok('attribution starts collapsed to the (i) button and does not cover Reset at '+w+' px (credit stays reachable)', !r.missing&&!r.open&&!r.overlap&&r.hasBtn, JSON.stringify(r)); await cx.close(); } });
 const files = fs.readdirSync(ROOT+'/src').map(f=>fs.readFileSync(ROOT+'/src/'+f,'utf8')).join('')+fs.readFileSync(ROOT+'/index.html','utf8').replace(/does-not-exist/,'')+fs.readFileSync(ROOT+'/data/atlanta-mock.json','utf8');
 ok('no No Code Flow references in project source', !/ncf|nocodeflow|no code flow/i.test(files));
 await b.close(); srv.close();
 res.forEach(r=>console.log(r[0],r[1],r[0]==='FAIL'||process.env.V?'\n     '+r[2]:'')); console.log(res.filter(r=>r[0]==='FAIL').length+' failures / '+res.length);
})();
