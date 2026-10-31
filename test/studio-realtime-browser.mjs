// Actual backend + SQLite D1 + actual DO/WebSocket + extracted production Studio
// controller in Chrome. Render adapter is minimal; no real account or jobs.
import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {readFile} from 'node:fs/promises';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),mfModule=require(resolve('node_modules/miniflare')),{build}=require(resolve('node_modules/esbuild'));
const frontend=resolve(process.argv[2]||'../frontend'),home=await readFile(join(frontend,'index.html'),'utf8'),script=await readFile(join(frontend,'studio-live.js'),'utf8');
const part=(a,b)=>{const i=home.indexOf(a),j=home.indexOf(b,i);assert.ok(i>=0&&j>i,a);return home.slice(i,j)};
const page=`<!doctype html><meta charset="utf-8"><body><main id="vTech"><input id="draft" value="preserve my form"><div id="dBody"></div></main><section id="bs"></section><section id="chat"></section><script>
const API=location.origin;window.BACKEND_URL=API;const $=id=>document.getElementById(id);let U={uid:'mechanic',getIdToken:async()=> 'mechanic'},MODE='tech',DT='queue',ME={technician:{id:'t_fixture',online:true}},JOBS=[],POSTS=[],THREADS=[],JOBS_OK=false,JOBS_ERR=null,ATLAS=null,VIEW='list';window.auth={get currentUser(){return U}};
const SEEN=new Set(),SEEN_URG=new Set();let firstNear=true,firstUrg=true,URG_KEY='',NEAR=null,NEAR_OWNER=null,FIND_NEW=false,DSTATS=null,alertT=0;
const T=(a,b)=>a,ls={get:()=>null,set(){}},myShop=()=>ME.technician,techJobs=()=>JOBS.filter(j=>j.side==='technician'),urgJob=j=>j.urgent;
function drawTab(){$('dBody').textContent=JSON.stringify({jobs:JOBS.map(j=>({id:j.id,status:j.status})),near:NEAR?.posts.map(p=>p.id)||[]});window.paintAt=performance.now()}
const renderActive=()=>{},renderUsed=()=>{},syncGarage=()=>{},saveSnap=()=>{},watchJobs=()=>{},bellDiff=()=>{},stuBadges=()=>{},markUnread=()=>{},stuChrome=()=>{},stuHead=()=>{},tabFind=()=>drawTab(),toast=()=>{},ding=()=>{},greet=()=>{};const LiveShare={sync(){}},RoamShare={sync(){},stop(){}};
function checkedNear(d){if(!Array.isArray(d?.posts)||!d.center)throw Error('bad near');return d}
${part('async function api(path,o){','function needLogin(){')}
${part('let RJ=null,JOBS_EPOCH=0,','/* ═══ งานของฉัน ═══ */')}
${part('let PULSE="",PULSE_OK=null,','/* ═══ ลูกค้า: ประกาศหาช่าง ═══ */')}
async function refreshMe(){return true}
window.state=()=>({jobs:JOBS,near:NEAR,threads:THREADS});window.switchAccount=()=>{U={uid:'other',getIdToken:async()=> 'other'};ME={};MODE='customer';stopAlerts();CendonStudioLive.refresh()};
startAlerts();</script><script src="/studio-live.js"></script>`;
const bundled=await build({entryPoints:['test/fixtures/studio-realtime-browser-worker.mjs'],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
const worker={name:'studio-browser',script:bundled.outputFiles[0].text,modules:true,compatibilityDate:'2026-06-27',durableObjects:{STUDIO_LIVE:{className:'CendonStudioLive',useSQLite:true}},d1Databases:['DB'],bindings:{HTML:page,SCRIPT:script}};
const mf=new mfModule.Miniflare(mfModule.convertV4MiniflareOptions?mfModule.convertV4MiniflareOptions(worker):worker);let browser;
try{
 const base=(await mf.ready).origin,DB=await mf.getD1Database('DB');await DB.exec('CREATE TABLE users(uid TEXT PRIMARY KEY,role TEXT,banned INTEGER,name TEXT)');await mf.dispatchFetch(base+'/api/tech/ping');
 await DB.prepare('INSERT INTO tech_profiles(id,uid,data,verified,test,suspended,online,created_at,updated_at) VALUES (?,?,?,1,0,0,1,1,1)').bind('t_fixture','mechanic',JSON.stringify({name:'Synthetic',shop:'Fixture shop',lat:13.75,lng:100.5,radius:30,cats:['eng'],mobile:true})).run();
 const {chromium}=await import(pathToFileURL(join(process.env.CENDON_NODE_PACKAGES,'playwright/index.mjs')));browser=await chromium.launch({headless:true,channel:'chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});const p=await browser.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto(base);await p.waitForFunction(()=>CendonStudioLive.state()==='live'&&window.state().near);await p.waitForTimeout(50);
 const post={id:crypto.randomUUID(),lat:13.76,lng:100.51,car:'Toyota Vios 2018',symptom:'แบตหมด สตาร์ทไม่ติด',cat:'eng',area:'บางนา',address:'ริมถนนบางนา กม.3',phone:'0812345678',requestedTime:'ด่วน ตอนนี้',mode:'mobile',urgent:true};
 const began=performance.now(),r=await mf.dispatchFetch(base+'/api/tech/posts',{method:'POST',headers:{Authorization:'Bearer customer'},body:JSON.stringify(post)});assert.equal(r.status,200,await r.text());await p.waitForFunction(id=>document.querySelector('#dBody').textContent.includes(id),post.id);const urgentVisibleMs=Math.round(performance.now()-began);assert.ok(urgentVisibleMs<1000,'local urgent visibility exceeded 1 s: '+urgentVisibleMs);
 // A stuck inbox must not withhold a direct request that already arrived.
 await p.route('**/api/tech/threads',route=>new Promise(()=>{}));const job={...post,id:crypto.randomUUID(),techId:'t_fixture'};const second=performance.now(),j=await mf.dispatchFetch(base+'/api/tech/jobs',{method:'POST',headers:{Authorization:'Bearer customer'},body:JSON.stringify(job)});assert.equal(j.status,200,await j.text());await p.waitForFunction(id=>document.querySelector('#dBody').textContent.includes(id),job.id);const stalledInboxJobMs=Math.round(performance.now()-second);assert.ok(stalledInboxJobMs<1000);
 const third={...job,id:crypto.randomUUID()},thirdAt=performance.now();assert.equal((await mf.dispatchFetch(base+'/api/tech/jobs',{method:'POST',headers:{Authorization:'Bearer customer'},body:JSON.stringify(third)})).status,200);await p.waitForFunction(id=>document.querySelector('#dBody').textContent.includes(id),third.id);const repeatedJobMs=Math.round(performance.now()-thirdAt);assert.ok(repeatedJobMs<1000,'another event must interrupt a stalled refresh');
 await p.locator('#draft').fill('do not replace while editing');const closedAt=performance.now();await mf.dispatchFetch(base+'/api/tech/posts/'+post.id+'/close',{method:'POST',headers:{Authorization:'Bearer customer'},body:'{}'});await p.waitForFunction(()=>state().near.posts.length===0);assert.ok(performance.now()-closedAt<1000,'closure must not wait for stalled inbox');assert.equal(await p.locator('#draft').inputValue(),'do not replace while editing');
 await p.evaluate(()=>switchAccount());await p.waitForFunction(()=>CendonStudioLive.state()==='live');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,actualBackendD1AndWebSocket:true,syntheticOnly:true,urgentVisibleMs,stalledInboxJobMs,repeatedJobMs,formPreserved:true,accountSwitch:true,realAccountWrites:0}));
}finally{await browser?.close();await mf.dispose()}
