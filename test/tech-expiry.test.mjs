/* คำขอ/ข้อเสนอที่หมดอายุ: ระบบยกเลิกให้ ทั้งสองฝ่ายเห็นตรงกัน ไม่ค้างใน "ต้องทำต่อ" ของช่าง และกดต่อไม่ได้ */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER} from './tech-fixtures.mjs';
import {withMechanic,MECH,post} from './tech-safety.test.mjs';
import {expireOpenJobs} from '../src/techs.js';

const H=3600e3,D=24*H;
const req=(over={})=>({id:crypto.randomUUID(),techId:'t_mech',car:'Honda City 2019',symptom:'แอร์ไม่เย็น มีลมออกแต่ไม่เย็น',area:'บางนา กรุงเทพ',
  address:'99/1 ซอยทดสอบ บางนา',phone:'0812345678',requestedTime:'พรุ่งนี้ 10:00',mode:'shop',...over});
const age=(f,id,ms,col='created_at')=>f.sqlite.prepare(`UPDATE tech_jobs SET ${col}=?, updated_at=? WHERE id=?`).run(Date.now()-ms,Date.now()-ms,id);
const quote=async(f,id)=>{const rv=(await f.call(MECH,'/api/tech/jobs/'+id)).job.revision;
  return f.call(MECH,'/api/tech/jobs/'+id,{action:'quote',revision:rv,labor:500,parts:0,travel:0,scope:'ตรวจเช็กระบบแอร์ทั้งหมด',appointment:'พรุ่งนี้',warranty:30})};
const row=(f,id)=>f.sqlite.prepare('SELECT status,resolution,history FROM tech_jobs WHERE id=?').get(id);

test('unanswered request: open for 48 hours, then cancelled by the system for both sides',async()=>{
  const f=fixture();await withMechanic(f);
  const fresh=await f.call(USER,'/api/tech/jobs',req());const old=await f.call(USER,'/api/tech/jobs',req({car:'Mazda 2 2019'}));
  age(f,old.id,49*H);
  const mine=(await f.call(MECH,'/api/tech/jobs')).jobs;
  const a=mine.find(j=>j.id===fresh.id),b=mine.find(j=>j.id===old.id);
  assert.equal(a.status,'requested');assert.ok(Math.abs(a.expiresAt-(Date.now()+48*H))<60e3,'fresh request says when it expires');assert.equal(a.expired,false);
  assert.equal(b.status,'cancelled');assert.equal(b.expired,true);assert.equal(b.needsMe,false);
  const r=row(f,old.id);assert.match(r.resolution,/48 ชั่วโมง/);assert.equal(JSON.parse(r.history).at(-1).by,'system');
  /* ลูกค้าเห็นเหตุผลเดียวกัน */
  assert.match((await f.call(USER,'/api/tech/jobs/'+old.id)).job.resolution,/หมดอายุ/);
});

test('urgent request: expires after 3 hours and the mechanic can no longer quote it',async()=>{
  const f=fixture();await withMechanic(f);
  const u=await f.call(USER,'/api/tech/jobs',req({urgent:true,symptom:'แบตหมด',mode:'mobile',requestedTime:'ด่วน — ตอนนี้'}));
  age(f,u.id,2*H);assert.equal((await f.call(MECH,'/api/tech/jobs')).jobs[0].status,'requested');
  const rv=(await f.call(MECH,'/api/tech/jobs/'+u.id)).job.revision;
  age(f,u.id,3*H+60e3);
  const q=await f.call(MECH,'/api/tech/jobs/'+u.id,{action:'quote',revision:rv,labor:300,parts:0,travel:100,scope:'เปลี่ยนแบตเตอรี่ใหม่',appointment:'30 นาที',warranty:30});
  assert.equal(q.status,410);assert.match(q.error,/งานด่วน/);
  assert.equal(row(f,u.id).status,'cancelled');
});

test('offers on a job post expire with the post; the customer cannot accept a stale offer',async()=>{
  const f=fixture();await withMechanic(f);
  const p=post(),p2=post({car:'BYD Atto 3 2023'});
  assert.equal((await f.call(USER,'/api/tech/posts',p)).status,200);assert.equal((await f.call(USER,'/api/tech/posts',p2)).status,200);
  const o=await f.call(MECH,`/api/tech/posts/${p.id}/offer`,{labor:800,parts:0,travel:0,scope:'ตรวจเช็กระบบไฟทั้งคัน',appointment:'พรุ่งนี้',warranty:30});
  const o2=await f.call(MECH,`/api/tech/posts/${p2.id}/offer`,{labor:900,parts:0,travel:0,scope:'ตรวจเช็กระบบไฟทั้งคัน',appointment:'พรุ่งนี้',warranty:30});
  /* ประกาศแรกอายุเกิน 48 ชม. — ข้อเสนอเพิ่งส่งเมื่อชั่วโมงก่อนก็หมดตามประกาศ */
  f.sqlite.prepare('UPDATE tech_posts SET created_at=? WHERE id=?').run(Date.now()-49*H,p.id);
  const rv=(await f.call(USER,'/api/tech/jobs/'+o2.id)).job.revision;
  const g=(await f.call(USER,'/api/tech/groups/'+p.id)).jobs;assert.equal(g[0].status,'cancelled');assert.match(g[0].resolution,/ประกาศหาช่าง/);
  const acc=await f.call(USER,'/api/tech/jobs/'+o.id,{action:'accept',revision:1,consent:true});assert.equal(acc.status,409,'already cancelled');
  /* ประกาศที่ยังไม่หมด รับได้ตามปกติ */
  assert.equal((await f.call(USER,'/api/tech/jobs/'+o2.id,{action:'accept',revision:rv,consent:true})).status,200);
  const mine=(await f.call(MECH,'/api/tech/jobs')).jobs;
  assert.equal(mine.find(j=>j.id===o.id).expired,true);assert.equal(mine.find(j=>j.id===o2.id).status,'accepted');
});

test('a quote the customer never answers lasts 7 days from the latest quote',async()=>{
  const f=fixture();await withMechanic(f);
  const a=await f.call(USER,'/api/tech/jobs',req()),b=await f.call(USER,'/api/tech/jobs',req({car:'Nissan Almera 2021'}));
  assert.equal((await quote(f,a.id)).status,200);assert.equal((await quote(f,b.id)).status,200);
  const setQ=(id,ms)=>{const q=JSON.parse(f.sqlite.prepare('SELECT quote FROM tech_jobs WHERE id=?').get(id).quote);q.at=Date.now()-ms;
    f.sqlite.prepare('UPDATE tech_jobs SET quote=?, created_at=?, updated_at=? WHERE id=?').run(JSON.stringify(q),Date.now()-ms-H,Date.now()-ms,id)};
  setQ(a.id,6*D);setQ(b.id,7*D+H);
  const mine=(await f.call(MECH,'/api/tech/jobs')).jobs;
  assert.equal(mine.find(j=>j.id===a.id).status,'quoted');assert.equal(mine.find(j=>j.id===b.id).status,'cancelled');
  assert.match(row(f,b.id).resolution,/7 วัน/);
});

test('the scheduled sweep expires stale jobs even if nobody opens the app, and never touches agreed work',async()=>{
  const f=fixture();await withMechanic(f);
  const stale=await f.call(USER,'/api/tech/jobs',req()),agreed=await f.call(USER,'/api/tech/jobs',req({car:'Isuzu D-Max 2020'}));
  await quote(f,agreed.id);const rv=(await f.call(USER,'/api/tech/jobs/'+agreed.id)).job.revision;
  assert.equal((await f.call(USER,'/api/tech/jobs/'+agreed.id,{action:'accept',revision:rv,consent:true})).status,200);
  age(f,stale.id,3*D);age(f,agreed.id,30*D);
  assert.deepEqual(await expireOpenJobs(f.env),{expired:1});
  assert.equal(row(f,stale.id).status,'cancelled');assert.equal(row(f,agreed.id).status,'accepted');
  assert.deepEqual(await expireOpenJobs(f.env),{expired:0},'second run finds nothing');
});

test('urgent post tells the real expiry (3 hours), normal post 48 hours',async()=>{
  const f=fixture();await withMechanic(f);
  const u=post({urgent:true,symptom:'ยางแตก'}),n=post({car:'Mazda 3 2020'});
  await f.call(USER,'/api/tech/posts',u);await f.call(USER,'/api/tech/posts',n);
  const near=(await f.call(MECH,'/api/tech/posts/near')).posts;
  const pu=near.find(p=>p.id===u.id),pn=near.find(p=>p.id===n.id);
  assert.ok(Math.abs(pu.expiresAt-pu.createdAt-3*H)<1000);assert.ok(Math.abs(pn.expiresAt-pn.createdAt-48*H)<1000);
});
