import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url),{Miniflare}=require(resolve('node_modules/miniflare')),{build}=require(resolve('node_modules/esbuild'));
const bundle=await build({entryPoints:['test/fixtures/studio-live-runtime-worker.mjs'],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
const worker={name:'studio-test',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-06-27',durableObjects:{LIVE:{className:'CendonStudioLive',useSQLite:true}}};
const {convertV4MiniflareOptions}=require(resolve('node_modules/miniflare'));
const mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(worker):worker);
const sockets=[],events=[];const wait=async(fn)=>{for(let n=0;n<200&&!fn();n++)await new Promise(r=>setTimeout(r,10));assert.ok(fn(),'socket event timeout')};
const headers={Upgrade:'websocket','Sec-WebSocket-Protocol':'cendon-studio.v1'};
async function open(uid){const r=await mf.dispatchFetch('https://fixture.test/?uid='+uid,{headers});assert.equal(r.status,101);assert.equal(r.headers.get('Sec-WebSocket-Protocol'),'cendon-studio.v1');const ws=r.webSocket;sockets.push(ws);ws.addEventListener('message',e=>events.push({uid,data:e.data==='pong'?'pong':JSON.parse(e.data)}));ws.accept();await wait(()=>events.some(e=>e.uid===uid&&e.data.type==='ready'));return ws;}
try{
 const one=await open('one'),two=await open('two');events.length=0;const began=performance.now();
 const emitted=await(await mf.dispatchFetch('https://fixture.test/emit?uid=one')).json();assert.equal(emitted.sent,1);await wait(()=>events.some(e=>e.data.type==='invalidate'));const elapsedMs=Math.round(performance.now()-began);
 assert.ok(elapsedMs<1000);assert.equal(events.filter(e=>e.data.type==='invalidate').length,1);assert.equal(events[0].uid,'one');assert.deepEqual(events[0].data.topics,['posts','jobs']);assert.deepEqual(Object.keys(events[0].data).sort(),['at','revision','topics','type']);
 one.send('ping');await wait(()=>events.some(e=>e.data==='pong'));
 const replacement=await open('one');one.close(1000,'');await new Promise(r=>setTimeout(r,30));events.length=0;await mf.dispatchFetch('https://fixture.test/emit?uid=one');await wait(()=>events.some(e=>e.data.type==='invalidate'));assert.equal(events.filter(e=>e.data.type==='invalidate').length,1,'replacement receives next update');
 assert.equal((await mf.dispatchFetch('https://fixture.test/?uid=one&expired=1',{headers})).status,403);
 for(let n=0;n<7;n++)await open('two');assert.equal((await mf.dispatchFetch('https://fixture.test/?uid=two',{headers})).status,429);
 replacement.send('{"uid":"two"}');await new Promise(r=>replacement.addEventListener('close',r,{once:true}));
 console.log(JSON.stringify({ok:true,actualWorkerd:true,sqliteDurableObject:true,isolatedUsers:2,localInvalidationMs:elapsedMs,reconnect:true,autoPong:true,connectionLimit:8,invalidLeaseDenied:true,arbitraryMessagesDenied:true,businessDataOnSocket:0}));
}finally{for(const s of sockets)try{s.close(1000,'')}catch{}await mf.dispose()}
