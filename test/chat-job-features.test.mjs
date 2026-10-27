import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{executeChatJob,generateChatAnswer} from '../src/worker.js';
function env(blocked=false){return {DEV_AUTH:'1',FIREBASE_PROJECT_ID:'job-test',GEMINI_KEY:'unit-not-a-key',ALLOWED_ORIGINS:'*',DB:{prepare(sql){return {bind(){return this},async first(){
  if(sql.startsWith('SELECT role,banned,email FROM users'))return {role:'user',banned:0};
  if(sql.includes('schema_version'))return {value:'24'};
  if(sql.includes('RETURNING count'))return {count:1,in_tok:1,out_tok:1};
  if(sql.includes('SELECT count FROM usage')&&blocked)return {count:999999};
  return null;
},async run(){return {}},async all(){return {results:[]}}}}}}};
const body=()=>({kind:'feature',jobId:crypto.randomUUID(),sessionId:'s1792720000000',carId:'car-one',contents:[{role:'user',parts:[{text:'Review quote'}]}],feature:{tool:'quote',attachments:[{mime:'image/jpeg',b64:'aGVsbG8='}],context:{car:{make:'Honda',model:'Civic'}},question:'Review quote',lang:'en'}});
test('durable executor runs the real feature pipeline without a request/browser signal',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async(url,init)=>{calls++;const payload=JSON.parse(init.body);assert.equal(payload.contents[0].parts[1].inlineData.data,'aGVsbG8=');assert.equal(init.headers['x-goog-api-key'],'unit-not-a-key');return Response.json({candidates:[{content:{parts:[{text:'Fixture reviewed quote'}]}}]})});
  const events=[];await executeChatJob(env(),{payload:{sub:'fixture'},role:'user'},body(),async e=>events.push(e),{active:async()=>true});
  assert.equal(calls,1);assert.equal(events.find(x=>x.type==='text_done').text,'Fixture reviewed quote');assert.equal(events.at(-1).type,'done');
});
test('durable feature executor still enforces tool quotas and never calls provider after denial',async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw Error('provider must not be called')});
  await assert.rejects(()=>executeChatJob(env(true),{payload:{sub:'fixture'},role:'user'},body(),async()=>{},{active:async()=>true}),/quota/);
});
test('background jobs remain authenticated before enqueue',async()=>{
  const r=await worker.fetch(new Request('https://test/api/ai/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body())}),env(),{});assert.equal(r.status,401);
});
test('only supported chat feature jobs may enqueue; live capture cannot be started by a background job',async()=>{
  for(const tool of ['baylive','ear','admin']){
    const b=body();b.feature.tool=tool;const e=env();let calls=0;e.CHAT_JOBS={getByName(){return {async create(){calls++;return {}}}}};
    const r=await worker.fetch(new Request('https://test/api/ai/jobs',{method:'POST',headers:{Authorization:'Bearer dev:fixture:fixture@unit.test','Content-Type':'application/json'},body:JSON.stringify(b)}),e,{});
    assert.equal(r.status,400);assert.equal(calls,0);
  }
});
test('a chat answer reports real steps in order (car → knowledge/history/spec → think → write → check); technical detail is for admins only',async t=>{
  const unparkAll=(await import('../src/fastai.js')).unpark;unparkAll();
  t.mock.method(globalThis,'fetch',async url=>{assert.match(String(url),/generativelanguage/);
    return new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text:'ลองเช็กน้ำยาแอร์ก่อนครับ'}]},finishReason:'STOP'}]})+'\n\n')});
  const chat=()=>({kind:'chat',jobId:crypto.randomUUID(),sessionId:'s1792720000000',carId:'car-one',make:'Honda',model:'City',year:'2019',contents:[{role:'user',parts:[{text:'แอร์ไม่เย็น'}]}]});
  const run=async role=>{const ev=[];await executeChatJob(env(),{payload:{sub:'fixture'},role},chat(),async e=>ev.push(e),{active:async()=>true});return ev};
  const ev=await run('user'),steps=ev.filter(e=>e.type==='step');
  const first=id=>steps.findIndex(s=>s.id===id);
  for(const id of ['car','kb','history','spec','think','write','check'])assert.ok(first(id)>=0,'step '+id+' is reported');
  assert.ok(first('car')<first('think')&&first('think')<first('write')&&first('write')<first('check'));
  assert.equal(steps.find(s=>s.id==='car'&&s.state==='done').car,'Honda City 2019');
  assert.equal(steps.find(s=>s.id==='check').state,'done');
  assert.ok(steps.every(s=>!('dev' in s)),'no model names or provider reasons for regular users');
  assert.equal(ev.find(e=>e.type==='text_done').text,'ลองเช็กน้ำยาแอร์ก่อนครับ');
  unparkAll();
  /* executeChatJob ลดสิทธิ์ตามฐานข้อมูลเสมอ — เรียกตัวตอบตรงด้วยบทบาทแอดมินที่ยืนยันแล้ว */
  const adminEv=[];await generateChatAnswer(env(),{payload:{sub:'fixture'},role:'owner'},chat(),async e=>adminEv.push(e));
  const admin=adminEv.filter(e=>e.type==='step'&&e.id==='think');
  assert.ok(admin.some(s=>s.dev&&s.dev.model),'admins see which model answered');
});
