/* node test/chat-jobs-runtime.mjs <existing node_modules directory> */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url),modules=resolve(process.argv[2]||'node_modules');
const {Miniflare}=require(resolve(modules,'miniflare')),{build}=require(resolve(modules,'esbuild'));
const root=resolve(import.meta.dirname,'..');await mkdir(resolve(root,'.qa'),{recursive:true});
const persist=await mkdtemp(resolve(root,'.qa/chat-jobs-runtime-'));
const bundled=await build({entryPoints:[resolve(root,'test/fixtures/chat-jobs-runtime-worker.mjs')],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
const options={modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-06-27',durableObjects:{JOBS:{className:'TestJobs',useSQLite:true}},durableObjectsPersist:persist,bindings:{APP_DATA_KEY:Buffer.alloc(32,9).toString('base64')}};
let mf=new Miniflare(options);const call=async(uid,id,b)=>{const r=await mf.dispatchFetch('https://fixture.test/?uid='+uid+(id?'&id='+id:''),b?{method:'POST',body:JSON.stringify(b)}:{});return r.json()};
const b={jobId:crypto.randomUUID(),sessionId:'s1792720000000',carId:'car-one',contents:[{role:'user',parts:[{text:'Synthetic only'}]}]};
try{
  assert.equal((await call('one',null,b)).job.id,b.jobId);
  /* ช่องสดผ่าน RPC จริง: snapshot → step → text → done → end */
  const live=await mf.dispatchFetch('https://fixture.test/?uid=one&events=1&id='+b.jobId);assert.equal(live.status,200);
  const events=(await live.text()).split('\n\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6))).filter(e=>e.type!=='ping');
  assert.deepEqual(events.map(e=>e.type),['snapshot','step','text','done','end']);assert.equal(events.at(-1).status,'complete');
  assert.equal((await mf.dispatchFetch('https://fixture.test/?uid=two&events=1&id='+b.jobId)).status,404);
  // No stream/subscriber remains open; the actual workerd alarm finishes the job.
  let r;for(let n=0;n<100;n++){r=await call('one',b.jobId);if(r.job?.status==='complete')break;await new Promise(r=>setTimeout(r,30))}
  assert.equal(r.job.status,'complete');assert.equal(r.job.text,'Runtime fixture answer');
  let notification;for(let n=0;n<50;n++){notification=await(await mf.dispatchFetch('https://fixture.test/?uid=one&id='+b.jobId+'&notice=1')).json();if(notification.notice)break;await new Promise(r=>setTimeout(r,30))}
  assert.deepEqual(notification.notice,{uid:'one',id:b.jobId,status:'complete'});
  assert.equal((await(await mf.dispatchFetch('https://fixture.test/?uid=two&id='+b.jobId+'&notice=1')).json()).notice,null);
  assert.equal((await call('two',b.jobId)).status,404);
  await mf.dispose();mf=new Miniflare(options);
  assert.equal((await call('one',b.jobId)).job.text,'Runtime fixture answer','encrypted result survives runtime restart');
  console.log('PASS: actual SQLite DO + RPC + alarm + detached client + account isolation + persisted runtime restart + live RPC stream (8 checks)');
}finally{await mf.dispose()}
