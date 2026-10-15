import test from 'node:test';
import assert from 'node:assert/strict';
import {seal,open,isSealed,needsReseal,vaultReady,CTX} from '../src/vault.js';

/* กุญแจทดสอบเท่านั้น (สุ่มคงที่) — ของจริงตั้งด้วย wrangler secret put APP_DATA_KEY */
export const KEY_A=Buffer.alloc(32,7).toString('base64'),KEY_B=Buffer.alloc(32,9).toString('base64');

test('vault: เข้ารหัสแล้วถอดกลับได้ตรง และไม่เหลือข้อความเดิมให้อ่าน',async()=>{
  const env={APP_DATA_KEY:KEY_A},msg=JSON.stringify({name:'สมชาย ใจดี',phone:'0812345678',idLast3:'123'});
  const s=await seal(env,msg,CTX.app('u1'));
  assert.ok(isSealed(s));assert.doesNotMatch(s,/สมชาย|0812345678|idLast3/);
  assert.notEqual(s,await seal(env,msg,CTX.app('u1')),'เข้ารหัสซ้ำต้องได้ผลไม่เหมือนเดิม (iv สุ่ม)');
  assert.equal(await open(env,s,CTX.app('u1')),msg);
});

test('vault: ข้อมูลถูกแก้ / ถูกย้ายไปแถวของคนอื่น / กุญแจผิด = ถอดไม่ได้ (ไม่คืนค่าเงียบ ๆ)',async()=>{
  const env={APP_DATA_KEY:KEY_A},s=await seal(env,'ลับ',CTX.doc('u1','id'));
  const parts=s.split(':'),ct=Buffer.from(parts[4],'base64');ct[0]^=1;parts[4]=ct.toString('base64');
  await assert.rejects(open(env,parts.join(':'),CTX.doc('u1','id')),/vault_tampered/);
  await assert.rejects(open(env,s,CTX.doc('u2','id')),/vault_tampered/,'ย้ายไปแถวคนอื่น');
  await assert.rejects(open(env,s,CTX.doc('u1','selfie')),/vault_tampered/,'ย้ายไปช่องอื่น');
  await assert.rejects(open({APP_DATA_KEY:KEY_B},s,CTX.doc('u1','id')),/vault_key_missing/);
});

test('vault: ไม่มีกุญแจ = ไม่พร้อม และปฏิเสธการเข้ารหัส · แถวเก่าที่ยังไม่เข้ารหัสอ่านได้ระหว่างย้าย',async()=>{
  assert.equal(await vaultReady({}),false);assert.equal(await vaultReady({APP_DATA_KEY:'short'}),false);
  await assert.rejects(seal({},'x','c'),/vault_not_ready/);
  assert.equal(await open({},'{"legacy":true}','c'),'{"legacy":true}');
});

test('vault: เปลี่ยนกุญแจได้ — ของเก่าอ่านด้วยกุญแจสำรอง และรู้ว่าต้องเข้ารหัสใหม่',async()=>{
  const old=await seal({APP_DATA_KEY:KEY_A},'ข้อมูลเดิม','c');
  const rotated={APP_DATA_KEY:KEY_B,APP_DATA_KEY_PREV:KEY_A};
  assert.equal(await open(rotated,old,'c'),'ข้อมูลเดิม');
  assert.equal(await needsReseal(rotated,old),true);
  assert.equal(await needsReseal(rotated,await seal(rotated,'ใหม่','c')),false);
  assert.equal(await needsReseal(rotated,'{"plain":1}'),true);
});
