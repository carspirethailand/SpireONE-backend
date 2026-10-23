import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChatJobEngine} from '../src/chat-jobs.mjs';
const key=Buffer.alloc(32,7).toString('base64');
const body=()=>({jobId:crypto.randomUUID(),sessionId:'s1792720000000',carId:'car-1',contents:[{role:'user',parts:[{text:'fixture private question'}]}]});
function fixture(execute=async(e,a,b,send)=>{await send({type:'text',delta:'fixture answer'});await send({type:'done'})}){
  const map=new Map();let alarm=null,queue=Promise.resolve();
  const storage={async get(k){return structuredClone(map.get(k))},async put(k,v){if(typeof k==='string')map.set(k,structuredClone(v));else for(const [a,b]of Object.entries(k))map.set(a,structuredClone(b))},async delete(k){for(const x of Array.isArray(k)?k:[k])map.delete(x)},async list({prefix}={}){return new Map([...map].filter(([k])=>!prefix||k.startsWith(prefix)).map(([k,v])=>[k,structuredClone(v)]))},async setAlarm(at){alarm=at},async deleteAlarm(){alarm=null},async deleteAll(){map.clear()},transaction(fn){const p=queue.then(()=>fn(storage));queue=p.catch(()=>{});return p}};
  const ctx={storage},env={APP_DATA_KEY:key},engine=new ChatJobEngine(ctx,env,execute);
  return {map,storage,ctx,env,engine,get alarm(){return alarm},create:b=>engine.create('one',{role:'user'},b)};
}
test('durable jobs encrypt payload/result, finish without a subscriber and erase input',async()=>{
  const f=fixture(),b=body();assert.equal((await f.create(b)).job.status,'queued');
  assert.ok(!JSON.stringify([...f.map]).includes('fixture private question'));
  assert.ok([...f.map].some(([k,v])=>k.startsWith('input:')&&v.startsWith('enc:v1:')));
  const fresh=new ChatJobEngine(f.ctx,f.env,f.engine.execute);await fresh.alarm();
  const r=await fresh.read('one',b.jobId);assert.equal(r.job.status,'complete');assert.equal(r.job.text,'fixture answer');
  assert.ok(![...f.map.keys()].some(k=>k.startsWith('input:')));assert.ok(!JSON.stringify([...f.map]).includes('fixture answer'));
});
test('same id is idempotent; conflicting payload and fourth queued answer are rejected',async()=>{
  const f=fixture(),b=body();await f.create(b);assert.equal((await f.create(b)).job.id,b.jobId);
  assert.equal((await f.create({...b,carId:'different'})).status,409);
  await f.create(body());await f.create(body());assert.equal((await f.create(body())).status,409);
});
test('all read/cancel/create/purge methods isolate the owning account',async()=>{
  const f=fixture(),b=body();await f.create(b);
  assert.equal((await f.engine.read('two',b.jobId)).status,404);assert.equal((await f.engine.cancel('two',b.jobId)).status,404);
  assert.deepEqual((await f.engine.list('two')).jobs,[]);assert.equal((await f.engine.create('two',{role:'user'},body())).status,404);
  await f.engine.purge('two');assert.equal((await f.engine.read('one',b.jobId)).job.status,'queued');
});
test('cancelled queued work never executes',async()=>{
  let n=0;const f=fixture(async()=>{n++}),b=body();await f.create(b);await f.engine.cancel('one',b.jobId);await f.engine.alarm();
  assert.equal(n,0);assert.equal((await f.engine.read('one',b.jobId)).job.status,'cancelled');assert.ok(![...f.map.keys()].some(k=>k.startsWith('input:')));
});
test('cancel/purge during inference cannot resurrect encrypted results',async()=>{
  for(const action of ['cancel','purge']){let started,release;const ready=new Promise(r=>started=r),pause=new Promise(r=>release=r);
    const f=fixture(async(e,a,b,send)=>{started();await pause;await send({type:'text',delta:'must not reappear'})}),b=body();await f.create(b);const work=f.engine.alarm();await ready;
    await f.engine[action]('one',b.jobId);release();await work;
    const r=await f.engine.read('one',b.jobId);assert.equal(action==='purge'?r.status:r.job.status,action==='purge'?404:'cancelled');assert.ok(![...f.map.keys()].some(k=>k.startsWith('result:')));
  }
});
test('alarm recovery does not repeat an interrupted paid inference',async()=>{
  let n=0;const f=fixture(async()=>{n++}),b=body();await f.create(b);const m=await f.storage.get('m:'+b.jobId);m.status='running';await f.storage.put('m:'+b.jobId,m);
  await f.engine.alarm();assert.equal(n,0);assert.equal((await f.engine.read('one',b.jobId)).job.status,'error');
});
test('expired work and results are removed and no alarm remains',async()=>{
  const f=fixture(),b=body();await f.create(b);const m=await f.storage.get('m:'+b.jobId);m.expiresAt=Date.now()-1;await f.storage.put('m:'+b.jobId,m);
  await f.engine.alarm();assert.equal(f.map.size,0);assert.equal(f.alarm,null);
});
test('invalid scope, oversized payload and missing encryption fail closed',async()=>{
  const f=fixture();assert.equal((await f.create({...body(),carId:'../other'})).status,400);
  assert.equal((await f.create({...body(),contents:'x'.repeat(24*1024*1024)})).status,413);
  assert.equal((await new ChatJobEngine(f.ctx,{},()=>{}).create('one',{role:'user'},body())).status,503);
});
