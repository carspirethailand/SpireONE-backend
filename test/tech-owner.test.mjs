/* เจ้าของระบบ (อีเมลยืนยันแล้วในรายการเจ้าของ) = สิทธิ์สูงสุดในระบบช่าง
   อนุมัติทดสอบได้ทุกใบ (ได้ร้านทดสอบเสมอ) · แก้/ลบร้านและบริการของทุกร้าน · ซ่อนรีวิว · ปิดประกาศ — ทุกอย่างมีบันทึก
   และคำตัดสิน 3 แบบ: อนุมัติ · ให้แก้ (ส่งใหม่ได้) · ไม่ผ่าน (ปิดใบสมัคร) */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER,ADMIN,fakeVision,pending,form} from './tech-fixtures.mjs';

/* ช่างที่ผ่านการตรวจแล้ว (ใส่ตรงในฐานข้อมูล) — ลอกจาก tech-safety แทนการ import (import ไฟล์เทสต์ = รันเทสต์นั้นซ้ำ) */
const MECH='mech|mech@unit.test';
async function withMechanic(f){await f.call('', '/api/tech/ping');
  f.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at) VALUES (?,?,?,?,1,0,0,?,?)')
    .run('t_mech','mech','0899999999',JSON.stringify({name:'ช่าง ทดสอบ',shop:'อู่ทดสอบ',lat:13.75,lng:100.5,radius:30,cats:['eng','air'],mobile:true,warranty:30}),Date.now(),Date.now());}
const post=(over={})=>({id:crypto.randomUUID(),lat:13.76123,lng:100.51235,cat:'eng',car:'Toyota Vios 2018',symptom:'สตาร์ทไม่ติด มีเสียงแก๊ก ๆ',area:'บางนา',
  address:'99/1 ซอยทดสอบ บางนา',phone:'0812345678',requestedTime:'วันนี้ช่วงบ่าย',mode:'mobile',...over});
/* ตัวจำลองฐานข้อมูลไม่คืน last_row_id — อ่านรหัสบริการล่าสุดจากตารางแทน */
const lastGig=f=>f.sqlite.prepare('SELECT id FROM tech_gigs ORDER BY id DESC LIMIT 1').get().id;

const ADMIN2='adm2|adm2@unit.test',MOD='mod|mod@unit.test';
function team(f){f.sqlite.prepare("INSERT INTO users(uid,role,banned) VALUES ('adm2','admin',0),('mod','moderator',0)").run();}
const audits=(f,action)=>f.sqlite.prepare('SELECT * FROM tech_audit WHERE action=?').all(action);

test('owner: test-approve skips every check but only ever creates a staff-only test shop',async()=>{
  const f=fixture();fakeVision();await f.call('', '/api/tech/ping');team(f);
  const a=await pending(f,{},{idcheck:false});
  /* admin ที่ไม่ใช่เจ้าของ และทีมงาน ใช้ไม่ได้ */
  assert.equal((await f.call(ADMIN2,'/api/tech/review',{uid:a.uid,revision:a.revision,decision:'approve_test'})).status,403);
  assert.equal((await f.call(MOD,'/api/tech/review',{uid:a.uid,revision:a.revision,decision:'approve_test'})).status,403);
  /* เจ้าของ: ไม่ติ๊ก ไม่เทียบเลขบัตร ไม่มีหลักฐาน ก็อนุมัติทดสอบได้ */
  const r=await f.call(ADMIN,'/api/tech/review',{uid:a.uid,revision:a.revision,decision:'approve_test'});
  assert.equal(r.status,200);assert.equal(r.testOnly,true);
  const app=f.sqlite.prepare('SELECT status,test FROM tech_applications WHERE uid=?').get(a.uid);
  assert.equal(app.status,'approved');assert.equal(app.test,1,'marked as test so a real application can follow later');
  const p=f.sqlite.prepare('SELECT verified,test,suspended FROM tech_profiles WHERE uid=?').get(a.uid);
  assert.deepEqual({...p},{verified:0,test:1,suspended:0},'never a verified public shop');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM tech_docs WHERE uid=? AND kind IN ('id','selfie','cert')").get(a.uid).n,0,'ID images deleted once decided');
  /* ลูกค้าทั่วไปไม่เห็น ทีมงานเห็น */
  assert.equal((await f.call(USER,'/api/tech')).techs.filter(t=>t.uid===a.uid||t.test).length,0);
  assert.ok((await f.call(MOD,'/api/tech')).techs.some(t=>t.test));
  const me=await f.call(USER,'/api/tech/me');assert.equal(me.technician.test,true);assert.equal(me.owner,false);
  assert.equal(audits(f,'approve_test').length,1);
  /* ทำซ้ำไม่ได้ (ตัดสินไปแล้ว) */
  assert.equal((await f.call(ADMIN,'/api/tech/review',{uid:a.uid,decision:'approve_test'})).status,409);
});

test('owner: a real verified shop is never downgraded by a test approval',async()=>{
  const f=fixture();fakeVision();await f.call('', '/api/tech/ping');
  const a=await pending(f,{},{idcheck:false});
  f.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at) VALUES (?,?,?,?,1,0,0,1,1)').run('t_real',a.uid,'0811111111','{"shop":"จริง"}');
  assert.equal((await f.call(ADMIN,'/api/tech/review',{uid:a.uid,decision:'approve_test'})).status,200);
  const p=f.sqlite.prepare('SELECT verified,test FROM tech_profiles WHERE uid=?').get(a.uid);assert.equal(p.verified,1);assert.equal(p.test,0);
});

test('decisions: ให้แก้ lets the applicant resubmit, ไม่ผ่าน closes the application for good',async()=>{
  const f=fixture();fakeVision();await f.call('', '/api/tech/ping');
  let a=await pending(f,{},{idcheck:false});
  assert.equal((await f.call(ADMIN,'/api/tech/review',{uid:a.uid,revision:a.revision,decision:'decline',note:'รูปผลงานไม่ใช่งานของผู้สมัครเอง'})).status,200);
  assert.equal(f.sqlite.prepare('SELECT status FROM tech_applications WHERE uid=?').get(a.uid).status,'declined');
  const again=await f.call(USER,'/api/tech/apply',form());assert.equal(again.status,409);assert.match(again.error,/ไม่ผ่านการคัดเลือก/);
  assert.equal((await f.call(USER,'/api/tech/me')).application.status,'declined');
  /* ให้แก้ ยังส่งใหม่ได้เหมือนเดิม */
  const g=fixture();fakeVision();await g.call('', '/api/tech/ping');
  a=await pending(g,{},{idcheck:false});
  assert.equal((await g.call(ADMIN,'/api/tech/review',{uid:a.uid,revision:a.revision,decision:'reject',note:'รูปบัตรไม่ชัด ถ่ายใหม่'})).status,200);
  assert.equal((await g.call(USER,'/api/tech/apply',form())).status,200);
  const cur=(await g.call(ADMIN,'/api/tech/applications')).applications[0];
  assert.equal((await g.call(ADMIN,'/api/tech/review',{uid:cur.uid,revision:cur.revision,decision:'nope',note:'xxxxxxxxxxxx'})).status,400);
});

test('owner: edits any shop (even verified fields) and its services; others cannot; every change is logged',async()=>{
  const f=fixture();await withMechanic(f);team(f);
  assert.equal((await f.call(USER,'/api/tech/shop',{tech:'t_mech',shop:'ยึดร้าน'})).status,403);
  assert.equal((await f.call(ADMIN2,'/api/tech/shop',{tech:'t_mech',shop:'ยึดร้าน'})).status,403,'admins who are not the owner cannot');
  /* ช่างเองแก้ข้อมูลที่ตรวจแล้วไม่ได้ · เจ้าของแก้ได้ */
  assert.equal((await f.call(MECH,'/api/tech/shop',{about:'เปลี่ยนเอง'})).status,409);
  const r=await f.call(ADMIN,'/api/tech/shop',{tech:'t_mech',shop:'อู่ที่เจ้าของแก้',about:'แก้โดยเจ้าของ',cats:['ev']});assert.equal(r.status,200);
  const d=JSON.parse(f.sqlite.prepare('SELECT data FROM tech_profiles WHERE id=?').get('t_mech').data);
  assert.equal(d.shop,'อู่ที่เจ้าของแก้');assert.deepEqual(d.cats,['ev']);assert.equal(audits(f,'owner_edit_shop').length,1);
  /* บริการ: ช่างลง → เจ้าของแก้ (หมวดไหนก็ได้) → คนอื่นแก้ไม่ได้ → เจ้าของลบ */
  const g0=await f.call(MECH,'/api/tech/gig',{title:'ล้างแอร์',price:800,cats:['ev'],body:'x'});assert.equal(g0.status,200);const g={id:lastGig(f)};
  assert.equal((await f.call(USER,'/api/tech/gig',{id:g.id,title:'แก้ของคนอื่น',price:1,cats:['ev']})).status,404);
  const e=await f.call(ADMIN,'/api/tech/gig',{id:g.id,title:'เจ้าของแก้',price:999,cats:['body']});assert.equal(e.status,200);
  const row=f.sqlite.prepare('SELECT uid,title,price FROM tech_gigs WHERE id=?').get(g.id);assert.equal(row.uid,'mech','stays the mechanic’s service');assert.equal(row.title,'เจ้าของแก้');
  const add=await f.call(ADMIN,'/api/tech/gig',{tech:'t_mech',title:'บริการที่เจ้าของลงให้',price:500,cats:['eng']});assert.equal(add.status,200);
  assert.equal(f.sqlite.prepare('SELECT uid FROM tech_gigs WHERE id=?').get(lastGig(f)).uid,'mech');
  assert.equal((await f.call(ADMIN,'/api/tech/gig/delete',{id:g.id})).status,200);
  assert.equal(f.sqlite.prepare('SELECT active FROM tech_gigs WHERE id=?').get(g.id).active,0);
  assert.equal(audits(f,'owner_edit_gig').length,1);assert.equal(audits(f,'owner_add_gig').length,1);assert.equal(audits(f,'delete_gig').length,1);
});

test('owner: hides a review (gone everywhere, rating recalculated) and closes anyone’s urgent post',async()=>{
  const f=fixture();await withMechanic(f);team(f);
  const job=(id,rating)=>f.sqlite.prepare("INSERT INTO tech_jobs (id,tech_id,customer_uid,status,car,symptom,area,address,phone,requested_time,mode,review,history,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id,'t_mech','applicant','completed','Vios','แอร์ไม่เย็น','บางนา','-','0812345678','วันนี้','shop',JSON.stringify({rating,text:'รีวิว '+rating,at:Date.now()-rating}),'[]',1,1);
  job('11111111-1111-4111-8111-111111111111',1);job('22222222-2222-4222-8222-222222222222',5);
  f.sqlite.prepare("UPDATE tech_profiles SET rating_sum=6, review_count=2 WHERE id='t_mech'").run();
  const pub=await f.call(USER,'/api/tech/reviews?id=t_mech');assert.equal(pub.reviews.length,2);assert.equal(pub.reviews[0].job,undefined,'only the owner gets a handle to hide');
  const own=await f.call(ADMIN,'/api/tech/reviews?id=t_mech');const bad=own.reviews.find(r=>r.rating===1);assert.ok(bad.job);
  assert.equal((await f.call(ADMIN2,'/api/tech/reviews/hide',{job:bad.job})).status,403);
  assert.equal((await f.call(ADMIN,'/api/tech/reviews/hide',{job:bad.job})).status,200);
  assert.equal((await f.call(USER,'/api/tech/reviews?id=t_mech')).reviews.length,1);
  const p=f.sqlite.prepare("SELECT rating_sum,review_count FROM tech_profiles WHERE id='t_mech'").get();assert.equal(p.rating_sum,5);assert.equal(p.review_count,1);
  assert.equal((await f.call(ADMIN,'/api/tech/reviews/hide',{job:bad.job})).status,200,'hiding twice is harmless');
  assert.equal(f.sqlite.prepare("SELECT review_count FROM tech_profiles WHERE id='t_mech'").get().review_count,1);
  /* ประกาศเรียกช่างของลูกค้า: คนอื่นปิดไม่ได้ เจ้าของปิดได้ */
  const pp=post();assert.equal((await f.call(USER,'/api/tech/posts',pp)).status,200);
  assert.equal((await f.call(ADMIN2,'/api/tech/posts/'+pp.id+'/close')).status,404);
  assert.equal((await f.call(ADMIN,'/api/tech/posts/'+pp.id+'/close',{})).status,200);
  assert.equal(f.sqlite.prepare('SELECT status FROM tech_posts WHERE id=?').get(pp.id).status,'closed');assert.equal(audits(f,'close_post').length,1);
});

test('founders stay owners even when OWNERS on Cloudflare leaves them out',async()=>{
  const f=fixture({OWNERS:'someone@unit.test'});await f.call('', '/api/tech/ping');
  assert.equal((await f.call('founder|anapatmaliwong@gmail.com','/api/tech/me')).owner,true);
  assert.equal((await f.call('founder|anapatmaliwong@gmail.com|unverified','/api/tech/me')).owner,false,'only with a verified email');
  assert.equal((await f.call('x|someone@unit.test','/api/tech/me')).owner,true);
});

test('applicant can cancel a pending, needs-fix or trial application — not a declined one or a verified shop',async()=>{
  const f=fixture();fakeVision();await f.call('', '/api/tech/ping');
  let a=await pending(f,{},{idcheck:false});
  assert.equal((await f.call(USER,'/api/tech/apply/withdraw',{})).status,200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_applications WHERE uid=?').get(a.uid).n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_docs WHERE uid=?').get(a.uid).n,0,'documents deleted');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_identity_claims WHERE uid=?').get(a.uid).n,0,'ID number released');
  assert.equal((await f.call(USER,'/api/tech/apply',form())).status,200,'can apply again later');
  /* ร้านทดลอง: ยกเลิกได้ ร้านหายไปด้วย */
  a=(await f.call(ADMIN,'/api/tech/applications')).applications[0];
  assert.equal((await f.call(ADMIN,'/api/tech/review',{uid:a.uid,decision:'approve_test'})).status,200);
  assert.equal((await f.call(USER,'/api/tech/apply/withdraw',{})).status,200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_profiles WHERE uid=?').get(a.uid).n,0);
  /* ไม่ผ่าน: ยกเลิกไม่ได้ */
  await f.call(USER,'/api/tech/apply',form());a=(await f.call(ADMIN,'/api/tech/applications')).applications[0];
  await f.call(ADMIN,'/api/tech/review',{uid:a.uid,revision:a.revision,decision:'decline',note:'ไม่ผ่านการคัดเลือก ทดสอบ'});
  assert.equal((await f.call(USER,'/api/tech/apply/withdraw',{})).status,409);
  /* ร้านจริง: ต้องติดต่อทีมงาน */
  const g=fixture();await g.call('', '/api/tech/ping');
  g.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at) VALUES (?,?,?,?,1,0,0,1,1)').run('t_real','applicant','0811111111','{}');
  assert.equal((await g.call(USER,'/api/tech/apply/withdraw',{})).status,409);
});
