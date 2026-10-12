import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER} from './tech-fixtures.mjs';
import {handleTech} from '../src/techs.js';

/* ทักช่าง (คุยก่อนจ้าง): ห้องคุยไม่ใช่ใบงาน — ไม่ต้องกรอกที่อยู่/รถ/เวลา และไม่เกิดคำขอราคา */
const MECH='mech|mech@unit.test',OTHER='other|other@unit.test',ADMIN_T='boss|boss@unit.test';
function setup(){
  const f=fixture({LINE_CHANNEL_TOKEN:'test-only-token',APP_URL:'https://app.unit.test'});
  f.sqlite.exec('CREATE TABLE line_link (line_uid TEXT PRIMARY KEY, uid TEXT NOT NULL, lang TEXT, active INTEGER NOT NULL DEFAULT 1, linked_at INTEGER)');
  f.sqlite.prepare('INSERT INTO line_link VALUES (?,?,?,1,?)').run('Ucustomer','applicant','th',Date.now());
  f.sqlite.prepare('INSERT INTO line_link VALUES (?,?,?,1,?)').run('Umechanic','mech','th',Date.now());
  const pushes=[];
  globalThis.fetch=async(url,init)=>{if(String(url).startsWith('https://api.line.me/')){pushes.push(JSON.parse(init.body));return Response.json({});}throw Error('unexpected fetch '+url);};
  const call=async(token,path,body)=>{const waits=[];
    const r=await handleTech(new Request('https://unit.test'+path,{method:body?'POST':'GET',headers:token?{Authorization:'Bearer '+token}:{},body:body?JSON.stringify(body):undefined}),
      f.env,undefined,{verifyToken:async t=>{const [uid,email]=t.split('|');return {sub:uid,email,email_verified:true};},ctx:{waitUntil:p=>waits.push(p)}});
    await Promise.all(waits);return {...await r.json(),status:r.status};};
  return {f,call,pushes};
}
async function mechanic(f,call){
  await call('','/api/tech/ping');
  f.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at) VALUES (?,?,?,?,1,0,0,?,?)')
    .run('t_mech','mech','0899999999',JSON.stringify({name:'ช่าง ทดสอบ',shop:'อู่ทดสอบ',lat:13.75,lng:100.5,radius:30,cats:['air']}),Date.now(),Date.now());
  f.sqlite.prepare("INSERT INTO tech_gigs (uid,tech_id,kind,title,price,active,created_at,updated_at) VALUES ('mech','t_mech','package','ล้างแอร์ครบชุด',1800,1,?,?)").run(Date.now(),Date.now());
  return {tid:'t_mech',gid:f.sqlite.prepare('SELECT id FROM tech_gigs').get().id};
}
const words=p=>JSON.stringify(p.messages);

test('threads: a customer can just ask — no booking is created, and asking again reuses the same room',async()=>{
  const {f,call,pushes}=setup();const {tid,gid}=await mechanic(f,call);
  const r=await call(USER,'/api/tech/threads',{techId:tid,gigId:gid,text:'สนใจล้างแอร์ครับ ใช้เวลานานไหม'});
  assert.equal(r.status,200);assert.match(r.thread.id,/^[0-9a-f-]{36}$/);assert.equal(r.thread.role,'customer');
  assert.equal(r.thread.techName,'อู่ทดสอบ');assert.equal(r.thread.gig.title,'ล้างแอร์ครบชุด');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM tech_jobs').get().n,0,'asking is not a quote request');
  const again=await call(USER,'/api/tech/threads',{techId:tid,text:'อีกเรื่องครับ'});
  assert.equal(again.thread.id,r.thread.id,'one room per customer and shop');
  const room=await call(USER,'/api/tech/threads/'+r.thread.id);
  assert.deepEqual(room.messages.map(m=>m.text),['สนใจล้างแอร์ครับ ใช้เวลานานไหม','อีกเรื่องครับ']);
  /* ช่างเห็นห้องในรายการ (มีข้อความยังไม่อ่าน) ตอบได้ แล้วลูกค้าเห็นคำตอบ */
  const inbox=await call(MECH,'/api/tech/threads');
  assert.equal(inbox.threads.length,1);assert.equal(inbox.threads[0].role,'technician');assert.equal(inbox.threads[0].unread,2);
  assert.equal((await call(MECH,'/api/tech/me')).unreadThreads,1,'counted on the mechanic jobs button');
  assert.equal((await call(MECH,'/api/tech/threads/'+r.thread.id,{text:'ประมาณ 2 ชั่วโมงครับ'})).status,200);
  assert.equal((await call(MECH,'/api/tech/threads')).threads[0].unread,0,'reading the room clears unread');
  const mine=await call(USER,'/api/tech/threads?tech='+tid);
  assert.equal(mine.threads[0].last.text,'ประมาณ 2 ชั่วโมงครับ');assert.equal(mine.threads[0].unread,1);
  /* LINE: ช่างได้แจ้งครั้งเดียวแม้ลูกค้าพิมพ์สองข้อความ · ลูกค้าได้แจ้งตอนช่างตอบ · ปุ่มเปิดห้องคุย */
  const toMech=pushes.filter(p=>p.to==='Umechanic'),toCust=pushes.filter(p=>p.to==='Ucustomer');
  assert.equal(toMech.length,1);assert.match(words(toMech[0]),/ลูกค้าทักมา/);assert.match(words(toMech[0]),/\/messages\//);
  assert.equal(toCust.length,1);assert.match(words(toCust[0]),/ช่างตอบแล้ว/);
});

test('threads: private to the two sides, phone and LINE hidden, cannot message yourself',async()=>{
  const {f,call}=setup();const {tid}=await mechanic(f,call);
  const r=await call(USER,'/api/tech/threads',{techId:tid,text:'โทรหาผม 0812345678 หรือ line: myline99'});
  const room=await call(USER,'/api/tech/threads/'+r.thread.id);
  assert.ok(!/0812345678|myline99/.test(room.messages[0].text),'contacts are hidden like an unconfirmed job');
  assert.equal((await call(OTHER,'/api/tech/threads/'+r.thread.id)).status,403);
  assert.equal((await call(OTHER,'/api/tech/threads/'+r.thread.id,{text:'แอบอ่าน'})).status,403);
  assert.equal((await call(MECH,'/api/tech/threads',{techId:tid,text:'ทักตัวเอง'})).status,400);
  assert.equal((await call(USER,'/api/tech/threads',{techId:'nope',text:'สวัสดี'})).status,404);
  assert.equal((await call(USER,'/api/tech/threads',{techId:tid,text:''})).status,400);
  assert.equal((await call('','/api/tech/threads',{techId:tid,text:'สวัสดี'})).status,401);
  void ADMIN_T;
});
