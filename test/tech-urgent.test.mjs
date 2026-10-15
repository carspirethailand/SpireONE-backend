/* เรียกช่างด่วน: งานด่วนต้องถึงช่างจริง ขึ้นเป็นงานด่วนใน Studio และร้านที่อนุมัติแล้วต้องไม่ถูกพักเพราะ Didit ค้าง */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER,ADMIN,fakeVision,pending,review} from './tech-fixtures.mjs';
import {withMechanic,MECH,post} from './tech-safety.test.mjs';
import {releaseWrongHolds} from '../src/techs.js';

const urgentJob=(over={})=>({id:crypto.randomUUID(),techId:'t_mech',car:'Toyota Vios 2018',symptom:'แบตหมด',area:'บางนา กรุงเทพ',
  address:'ริมถนนบางนา-ตราด กม.3',phone:'0812345678',requestedTime:'ด่วน — ตอนนี้',mode:'mobile',urgent:true,...over});

test('urgent call: a short symptom chip is enough, and the mechanic sees it flagged urgent',async()=>{
  const f=fixture();await withMechanic(f);
  const r=await f.call(USER,'/api/tech/jobs',urgentJob());assert.equal(r.status,200,r.error);
  const mine=(await f.call(MECH,'/api/tech/jobs')).jobs;assert.equal(mine.length,1);assert.equal(mine[0].urgent,true);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+r.id)).job.urgent,true);
  /* งานปกติยังต้องเล่าอาการให้พอเข้าใจ */
  const n=await f.call(USER,'/api/tech/jobs',urgentJob({urgent:false}));assert.equal(n.status,400);assert.match(n.error,/อาการ/);
});

test('urgent post: a mobile mechanic in range sees it even outside their categories; normal posts stay category-matched',async()=>{
  const f=fixture();await withMechanic(f,{cats:['air'],mobile:true});
  assert.equal((await f.call(USER,'/api/tech/posts',post({cat:'eng',urgent:true}))).status,200);
  assert.equal((await f.call(USER,'/api/tech/posts',post({cat:'tyre',symptom:'ยางรั่ว ลมอ่อน ขับต่อไม่ได้'}))).status,200);
  const near=(await f.call(MECH,'/api/tech/posts/near')).posts;
  assert.equal(near.length,1);assert.equal(near[0].urgent,true);
});

test('a shop approved by staff (manual ID check) is never paused by a stale Didit session — and a wrong old hold is released',async()=>{
  fakeVision();const f=fixture();const a=await pending(f);
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,200);
  /* รอบเก่า: session Didit ค้าง + ร้านถูกพักเพราะตัวตน */
  f.sqlite.prepare("INSERT OR REPLACE INTO tech_identity(uid,session_id,status,id_hash,data,created_at,updated_at) VALUES ('applicant','sess-old','pending',NULL,NULL,1,1)").run();
  f.sqlite.prepare("UPDATE tech_profiles SET suspended=1,id_hold=1").run();
  assert.equal((await f.call(USER,'/api/tech/me')).technician.identityHold,true);
  assert.equal((await releaseWrongHolds(f.env)).released,1);
  const s=f.sqlite.prepare('SELECT suspended,id_hold FROM tech_profiles').get();assert.deepEqual({...s},{suspended:0,id_hold:0});
  assert.equal((await f.call(USER,'/api/tech/me')).technician.identityHold,false);
  /* การพักโดยทีมงาน (id_hold=0) ไม่ถูกปลด */
  f.sqlite.prepare("UPDATE tech_profiles SET suspended=1,id_hold=0").run();
  assert.equal((await releaseWrongHolds(f.env)).released,0);assert.equal(f.sqlite.prepare('SELECT suspended FROM tech_profiles').get().suspended,1);
});
