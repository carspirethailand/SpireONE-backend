import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER} from './tech-fixtures.mjs';
import {handleTech} from '../src/techs.js';

/* แก้/ยกเลิกข้อความในแชตกับช่าง: เฉพาะข้อความของตัวเอง แก้ได้ 15 นาที ยกเลิกได้ 24 ชม.
   อีกฝ่ายเห็นการเปลี่ยนในรอบดึงถัดไป · เบอร์/ไลน์ยังถูกซ่อน · ข้อความเดิมเก็บไว้ให้ทีมงานเท่านั้น */
const MECH='mech|mech@unit.test',OTHER='other|other@unit.test',ADMIN_T='boss|boss@unit.test';
const MIN=60000;
function setup(){
  const f=fixture();
  globalThis.fetch=async()=>Response.json({});
  const call=async(token,path,body)=>{const r=await handleTech(new Request('https://unit.test'+path,{method:body?'POST':'GET',headers:token?{Authorization:'Bearer '+token}:{},body:body?JSON.stringify(body):undefined}),
    f.env,undefined,{verifyToken:async t=>{const [uid,email]=t.split('|');return {sub:uid,email,email_verified:true};},ctx:{waitUntil(){}}});
    return {...await r.json(),status:r.status};};
  return {f,call};
}
async function room(f,call){
  await call('','/api/tech/ping');
  f.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at) VALUES (?,?,?,?,1,0,0,?,?)')
    .run('t_mech','mech','0899999999',JSON.stringify({name:'ช่าง ทดสอบ',shop:'อู่ทดสอบ',lat:13.75,lng:100.5,radius:30,cats:['air'],mobile:true}),Date.now(),Date.now());
  const r=await call(USER,'/api/tech/threads',{techId:'t_mech',text:'สวัสดีครับ ล้างแอร์เท่าไหร่'});
  return {tid:r.thread.id,mid:r.message.id};
}
const age=(f,id,ms)=>f.sqlite.prepare('UPDATE tech_messages SET at = at - ? WHERE id = ?').run(ms,id);

test('edit: the sender fixes a typo, the other side sees it on the next poll, contacts stay hidden',async()=>{
  const {f,call}=setup();const {tid,mid}=await room(f,call);
  const seen=(await call(MECH,'/api/tech/threads/'+tid)).messages;const since=Math.max(...seen.map(m=>m.editedAt||m.at));
  const r=await call(USER,`/api/tech/messages/${mid}/edit`,{text:'สวัสดีครับ ล้างแอร์ราคาเท่าไหร่ โทร 0812345678'});
  assert.equal(r.status,200,JSON.stringify(r));assert.ok(r.message.editedAt);
  assert.ok(!/0812345678/.test(r.message.text),'editing is not a way around hidden phone numbers');
  const poll=await call(MECH,`/api/tech/threads/${tid}?after=${mid}&since=${since}`);
  assert.equal(poll.messages.length,1,'the edited old message comes back with the poll');
  assert.equal(poll.messages[0].id,mid);assert.match(poll.messages[0].text,/ราคาเท่าไหร่/);assert.ok(poll.messages[0].editedAt);
  assert.equal((await call(MECH,`/api/tech/threads/${tid}?after=${mid}`)).messages.length,0,'old clients without since are unaffected');
  assert.equal(f.sqlite.prepare('SELECT orig_text FROM tech_messages WHERE id=?').get(mid).orig_text,'สวัสดีครับ ล้างแอร์เท่าไหร่','the first version is kept for disputes');
});

test('edit/unsend: only your own messages, within the time limits, not read-only staff',async()=>{
  const {f,call}=setup();const {tid,mid}=await room(f,call);
  assert.equal((await call(MECH,`/api/tech/messages/${mid}/edit`,{text:'แก้ของคนอื่น'})).status,404,'cannot edit the customer message');
  assert.equal((await call(OTHER,`/api/tech/messages/${mid}/delete`,{})).status,404,'outsiders cannot even tell it exists');
  assert.equal((await call(ADMIN_T,`/api/tech/messages/${mid}/delete`,{})).status,404,'staff cannot change what users wrote');
  assert.equal((await call(USER,`/api/tech/messages/${mid}/edit`,{text:''})).status,400,'a text-only message cannot become empty');
  age(f,mid,16*MIN);
  const late=await call(USER,`/api/tech/messages/${mid}/edit`,{text:'สายไปแล้ว'});
  assert.equal(late.status,409);assert.match(late.error,/15 นาที/);
  age(f,mid,24*60*MIN);
  const old=await call(USER,`/api/tech/messages/${mid}/delete`,{});
  assert.equal(old.status,409);assert.match(old.error,/24 ชั่วโมง/);
});

test('unsend: both sides see a placeholder, text and files are gone from the room, the list says it was unsent',async()=>{
  const {f,call}=setup();const {tid}=await room(f,call);
  const reply=(await call(MECH,'/api/tech/threads/'+tid,{text:'ราคา 1,500 บาทครับ'})).message;
  const r=await call(MECH,`/api/tech/messages/${reply.id}/delete`,{});
  assert.equal(r.status,200);assert.equal(r.message.deleted,true);assert.equal(r.message.text,'');
  const msgs=(await call(USER,'/api/tech/threads/'+tid)).messages;
  const gone=msgs.find(m=>m.id===reply.id);assert.equal(gone.deleted,true);assert.equal(gone.text,'');assert.equal(gone.media,undefined);
  assert.equal((await call(USER,'/api/tech/threads')).threads[0].last.text,'ยกเลิกข้อความแล้ว');
  assert.equal((await call(MECH,`/api/tech/messages/${reply.id}/edit`,{text:'กลับมา'})).status,409,'an unsent message stays unsent');
  assert.equal(f.sqlite.prepare('SELECT orig_text FROM tech_messages WHERE id=?').get(reply.id).orig_text,'ราคา 1,500 บาทครับ');
});

test('job chat: edits follow the same rules and stop once the job is closed',async()=>{
  const {f,call}=setup();await room(f,call);
  const id='11111111-2222-4333-8444-555555555555';
  const made=await call(USER,'/api/tech/jobs',{id,techId:'t_mech',car:'Honda City 2019',symptom:'แอร์ไม่เย็น มีลมออกแต่ไม่เย็น',area:'บางนา',address:'99/1 ซอย 5',phone:'0812345678',requestedTime:'พรุ่งนี้เช้า',mode:'mobile'});
  assert.equal(made.status,200,JSON.stringify(made));
  const msg=(await call(USER,'/api/tech/jobs/'+id,{action:'message',message:'มาได้กี่โมงครับ'})).message;
  const r=await call(USER,`/api/tech/messages/${msg.id}/edit`,{text:'มาได้กี่โมงครับ ไลน์ myline99'});
  assert.equal(r.status,200);assert.ok(!/myline99/.test(r.message.text),'hidden until the price is accepted');
  const poll=await call(MECH,`/api/tech/jobs/${id}/messages?after=${msg.id}&since=${r.message.editedAt}`);
  assert.equal(poll.messages[0].id,msg.id);
  f.sqlite.prepare("UPDATE tech_jobs SET status='cancelled' WHERE id=?").run(id);
  assert.equal((await call(USER,`/api/tech/messages/${msg.id}/delete`,{})).status,409,'closed jobs are a fixed record');
});
