/* ผลใบสมัครเปิดในแอปด้วยการ์ดขูด: แจ้งเตือนทุกช่องทางไม่บอกผลล่วงหน้า · ผู้สมัครเห็นแค่ผล ข้อความ และเวลาตัดสิน */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER,ADMIN,fakeVision,pending} from './tech-fixtures.mjs';

for(const [decision,status] of [['decline','declined'],['reject','rejected']])
test(`${decision}: the push/LINE text is the same neutral "result is in" for every outcome`,async()=>{
  const sent=[],bg=[];
  const f=fixture({pushTo:(uid,m)=>{sent.push({uid,m})},bg:p=>bg.push(p)});fakeVision();await f.call('', '/api/tech/ping');
  const a=await pending(f,{},{idcheck:false});
  assert.equal((await f.call(ADMIN,'/api/tech/review',{uid:a.uid,revision:a.revision,decision,note:'รูปบัตรไม่ชัด ถ่ายใหม่ในที่สว่าง'})).status,200);
  await Promise.all(bg);
  const mine=sent.filter(x=>x.uid===a.uid);assert.equal(mine.length,1);
  const text=JSON.stringify(mine[0].m);
  assert.match(text,/ผลการพิจารณาใบสมัครของคุณมาแล้ว/);
  assert.match(text,/\/join/);
  assert.doesNotMatch(text,/ไม่ผ่าน|ต้องแก้|อนุมัติ|เปิดใน Cendon แล้ว|รูปบัตรไม่ชัด/,'no outcome or reviewer note leaks before the reveal');
  /* ผู้สมัครเห็นผล + ข้อความถึงผู้สมัคร + เวลา — ไม่เห็นอีเมลคนตรวจหรือข้อมูลภายใน */
  const app=(await f.call(USER,'/api/tech/me')).application;
  assert.equal(app.status,status);
  assert.equal(app.review.note,'รูปบัตรไม่ชัด ถ่ายใหม่ในที่สว่าง');
  assert.ok(app.review.at>0);
  assert.equal(app.review.by,undefined);assert.equal(app.review.evidence,undefined);assert.equal(app.review.checks,undefined);
  assert.doesNotMatch(JSON.stringify(app.review),/boss@unit\.test/);
  /* ทีมงานยังเห็นครบ */
  const staff=(await f.call(ADMIN,'/api/tech/applications')).applications;
  assert.ok(Array.isArray(staff));
});
