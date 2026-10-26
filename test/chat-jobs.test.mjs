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
test('interrupted inference is retried once only when nothing reached the user; never after text or a second attempt',async()=>{
  /* รีสตาร์ตก่อนมีตัวอักษรออกไป → ทำใหม่หนึ่งครั้ง */
  let n=0;const f=fixture(async(e,a,b,send)=>{n++;await send({type:'text',delta:'retried answer'});await send({type:'done'})}),b=body();await f.create(b);
  let m=await f.storage.get('m:'+b.jobId);m.status='running';m.attempts=1;await f.storage.put('m:'+b.jobId,m);
  await f.engine.alarm();assert.equal(n,1);let r=(await f.engine.read('one',b.jobId)).job;assert.equal(r.status,'complete');assert.equal(r.text,'retried answer');
  /* มีข้อความออกไปแล้ว → ไม่ทำซ้ำ */
  let k=0;const g=fixture(async()=>{k++}),c=body();await g.create(c);
  m=await g.storage.get('m:'+c.jobId);m.status='running';m.attempts=1;m.hadText=true;await g.storage.put('m:'+c.jobId,m);
  await g.engine.alarm();assert.equal(k,0);assert.equal((await g.engine.read('one',c.jobId)).job.status,'error');
  /* ลองซ้ำไปแล้วหนึ่งรอบ → ไม่ทำซ้ำอีก */
  const h=fixture(async()=>{k++}),d=body();await h.create(d);
  m=await h.storage.get('m:'+d.jobId);m.status='running';m.attempts=2;await h.storage.put('m:'+d.jobId,m);
  await h.engine.alarm();assert.equal(k,0);r=(await h.engine.read('one',d.jobId)).job;assert.equal(r.status,'error');assert.equal(r.notice,'failed');
});
async function drain(stream){const rd=stream.getReader(),dec=new TextDecoder(),out=[];let buf='';for(;;){const {done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});const parts=buf.split('\n\n');buf=parts.pop();for(const p of parts)if(p.startsWith('data: '))out.push(JSON.parse(p.slice(6)))}return out}
test('live channel: snapshot first, then each step/text/sources event in order, then end; steps and sources are also persisted for polling clients',async()=>{
  let release;const gate=new Promise(r=>release=r);
  const f=fixture(async(e,a,b,send)=>{await gate;await send({type:'step',id:'kb',state:'start',at:5});await send({type:'step',id:'kb',state:'done',n:2,ms:40});
    await send({type:'sources',items:[{title:'T',host:'toyota.co.th',url:'https://toyota.co.th/x'}]});await send({type:'text',delta:'สวัส'});await send({type:'text',delta:'ดี'});await send({type:'notice',kind:'cut'});await send({type:'done'})}),b=body();
  await f.create(b);const live=await f.engine.stream('one',b.jobId);assert.ok(live);
  assert.equal(await f.engine.stream('two',b.jobId),null,'another account cannot follow the job');
  const got=drain(live),run=f.engine.alarm();release();await run;const ev=await got;
  assert.equal(ev[0].type,'snapshot');assert.equal(ev.at(-1).type,'end');assert.equal(ev.at(-1).status,'complete');
  const types=ev.map(e=>e.type).filter(t=>t!=='ping');assert.deepEqual(types,['snapshot','step','step','sources','text','text','notice','done','end']);
  const seq=ev.slice(1).map(e=>e.seq);assert.deepEqual(seq,[...seq].sort((x,y)=>x-y),'events carry increasing sequence numbers');
  const job=(await f.engine.read('one',b.jobId)).job;assert.equal(job.text,'สวัสดี');assert.deepEqual(job.steps.map(s=>[s.id,s.state,s.n]),[['kb','done',2]]);
  assert.equal(job.sources[0].host,'toyota.co.th');assert.equal(job.notice,'cut');
  /* ต่อใหม่หลังจบ: ได้ snapshot แล้ว end ทันที ไม่ค้าง */
  const again=await drain(await f.engine.stream('one',b.jobId));assert.deepEqual(again.map(e=>e.type),['snapshot','end']);
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

test('completion delivery is durable, private, and retries without rerunning inference',async()=>{
  let calls=0,deliveries=0;const f=fixture(async(e,a,b,send)=>{calls++;await send({type:'text',delta:'private answer'})}),b=body();
  f.engine.notify=async(uid,job)=>{assert.equal(uid,'one');assert.equal(job.id,b.jobId);assert.equal(job.text,undefined);assert.equal(job.contents,undefined);deliveries++;if(deliveries===1)throw Error('temporary delivery failure')};
  await f.create(b);await f.engine.alarm();assert.equal(calls,1);assert.equal(deliveries,1);assert.equal((await f.engine.read('one',b.jobId)).job.status,'complete');
  const m=await f.storage.get('m:'+b.jobId);assert.ok(m.deliveryAt>Date.now());m.deliveryAt=Date.now()-1;await f.storage.put('m:'+b.jobId,m);
  const fresh=new ChatJobEngine(f.ctx,f.env,f.engine.execute,f.engine.notify);await fresh.alarm();assert.equal(calls,1);assert.equal(deliveries,2);
  await fresh.alarm();assert.equal(deliveries,2);assert.equal((await f.storage.get('m:'+b.jobId)).deliveryAt,null);
});

test('explicit cancellation and purge never send completion notifications',async()=>{
  for(const action of ['cancel','purge']){let n=0;const f=fixture(),b=body();f.engine.notify=async()=>{n++};await f.create(b);await f.engine[action]('one',b.jobId);await f.engine.alarm();assert.equal(n,0)}
});

test('failed delivery is bounded, but the completed answer remains readable',async()=>{
  let n=0;const f=fixture(),b=body();f.engine.notify=async()=>{n++;throw Error('offline')};await f.create(b);
  for(let i=0;i<5;i++){const m=await f.storage.get('m:'+b.jobId);m.deliveryAt=Date.now()-1;await f.storage.put('m:'+b.jobId,m);await f.engine.alarm()}
  assert.equal(n,3);assert.equal((await f.engine.read('one',b.jobId)).job.text,'fixture answer');
});
