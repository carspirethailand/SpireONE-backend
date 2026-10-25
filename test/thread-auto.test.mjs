import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER} from './tech-fixtures.mjs';

/* ร้านที่ตั้งคำทักทายและตอบกลับอัตโนมัติไว้ใน Studio → ตั้งค่า */
async function shop(data){
  const f=fixture();await f.call('','/api/tech/ping');const at=Date.now();
  f.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at) VALUES (?,?,?,?,1,0,0,?,?)')
    .run('t_auto','mechanic','0899999999',JSON.stringify({name:'ช่างทดสอบ',shop:'ร้านทดสอบ',cats:['eng'],...data}),at,at);
  return f;
}
const MECH='mechanic|mechanic@unit.test';
const msgs=async(f,token,id)=>(await f.call(token,'/api/tech/threads/'+id)).messages;

test('customer opens a chat: the greeting is the first message, then the question, then one auto-reply',async()=>{
  const f=await shop({greet:'สวัสดีครับ ร้านทดสอบยินดีต้อนรับ',autoReply:{on:true,text:'ได้รับข้อความแล้ว จะตอบภายใน 30 นาทีครับ'}});
  const r=await f.call(USER,'/api/tech/threads',{techId:'t_auto',text:'รับซ่อมแอร์ Honda City ไหมครับ'});
  assert.equal(r.status,200);assert.equal(r.auto.kind,'auto');
  const m=await msgs(f,USER,r.thread.id);
  assert.deepEqual(m.map(x=>[x.role,x.kind||'',x.text]),[
    ['technician','greet','สวัสดีครับ ร้านทดสอบยินดีต้อนรับ'],
    ['customer','','รับซ่อมแอร์ Honda City ไหมครับ'],
    ['technician','auto','ได้รับข้อความแล้ว จะตอบภายใน 30 นาทีครับ']]);
  /* ร้านเห็นห้องเดียวกัน และยังรู้ว่ามีลูกค้ารอ (ข้อความอัตโนมัติไม่นับเป็นข้อความที่ร้านยังไม่ได้อ่าน) */
  assert.equal((await msgs(f,MECH,r.thread.id)).length,3);
  /* ทักซ้ำใน 12 ชม. ร้านยังไม่ตอบ → ไม่ส่งข้อความอัตโนมัติซ้ำ */
  const again=await f.call(USER,'/api/tech/threads/'+r.thread.id,{text:'ราคาประมาณเท่าไหร่ครับ'});
  assert.equal(again.status,200);assert.equal(again.auto,undefined);
  assert.equal((await msgs(f,USER,r.thread.id)).filter(x=>x.kind==='auto').length,1);
});

test('after 12 hours without a shop reply the auto-reply goes out again; a shop reply resets it',async()=>{
  const f=await shop({autoReply:{on:true,text:'ร้านปิดแล้ว พรุ่งนี้ตอบครับ'}});
  const r=await f.call(USER,'/api/tech/threads',{techId:'t_auto',text:'สวัสดีครับ'});
  f.sqlite.prepare("UPDATE tech_messages SET at = at - 13*3600000 WHERE job_id = ?").run(r.thread.id);
  assert.equal((await f.call(USER,'/api/tech/threads/'+r.thread.id,{text:'ยังอยู่ไหมครับ'})).auto.kind,'auto');
  assert.equal((await f.call(MECH,'/api/tech/threads/'+r.thread.id,{text:'อยู่ครับ'})).auto,undefined,'shop replies never trigger it');
  assert.equal((await f.call(USER,'/api/tech/threads/'+r.thread.id,{text:'ขอบคุณครับ'})).auto,undefined);
});

test('nothing automatic when the shop has not turned it on; no greeting in an existing chat',async()=>{
  const f=await shop({autoReply:{on:false,text:'ไม่ควรส่ง'}});
  const r=await f.call(USER,'/api/tech/threads',{techId:'t_auto',text:'สวัสดีครับ'});
  assert.deepEqual((await msgs(f,USER,r.thread.id)).map(x=>x.role),['customer']);
  f.sqlite.prepare('UPDATE tech_profiles SET data = ? WHERE id = ?').run(JSON.stringify({name:'ช่าง',shop:'ร้าน',cats:['eng'],greet:'ยินดีต้อนรับ'}),'t_auto');
  await f.call(USER,'/api/tech/threads',{techId:'t_auto',text:'ถามอีกเรื่องครับ'});
  assert.ok(!(await msgs(f,USER,r.thread.id)).some(x=>x.kind==='greet'),'greeting only opens a new chat');
});

test('quote requests keep their auto-reply, now labelled as automatic',async()=>{
  const f=await shop({autoReply:{on:true,text:'ได้รับคำขอราคาแล้วครับ'}});
  const id=crypto.randomUUID();
  assert.equal((await f.call(USER,'/api/tech/jobs',{id,techId:'t_auto',car:'Honda City 2020',symptom:'แอร์ไม่เย็น มีเสียงดัง',area:'บางนา กรุงเทพ',address:'ถนนบางนา-ตราด กม.5',phone:'0812345678',requestedTime:'พรุ่งนี้ 10:00',mode:'shop'})).status,200);
  const m=(await f.call(USER,`/api/tech/jobs/${id}/messages?after=0`)).messages;
  assert.deepEqual(m.map(x=>[x.role,x.kind]),[['technician','auto']]);
});
