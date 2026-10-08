/* ความปลอดภัยของลูกค้าเมื่อพาช่าง (คนแปลกหน้า) ไปพบลูกค้าและรถ */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER,ADMIN,fakeGemini,pending,review} from './tech-fixtures.mjs';

export const MECH='mech|mech@unit.test';
/* ช่างที่ผ่านการตรวจแล้ว (ใส่ตรงในฐานข้อมูล — การอนุมัติจริงมีเทสต์ของมันเองแล้ว) */
export async function withMechanic(f,data={}){
  await f.call('', '/api/tech/ping');
  const d={name:'ช่าง ทดสอบ',shop:'อู่ทดสอบ',lat:13.75,lng:100.5,radius:30,cats:['eng','air'],mobile:true,warranty:30,...data};
  f.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at) VALUES (?,?,?,?,1,0,0,?,?)')
    .run('t_mech','mech','0899999999',JSON.stringify(d),Date.now(),Date.now());
  return 't_mech';
}
export const post=(over={})=>({id:crypto.randomUUID(),lat:13.76123,lng:100.51235,cat:'eng',car:'Toyota Vios 2018',symptom:'สตาร์ทไม่ติด มีเสียงแก๊ก ๆ',area:'บางนา',
  address:'99/1 ซอยทดสอบ บางนา',phone:'0812345678',requestedTime:'วันนี้ช่วงบ่าย',mode:'mobile',...over});

test('mechanics who were not chosen see only an approximate area, never the exact pin',async()=>{
  const f=fixture();await withMechanic(f);const p=post();
  assert.equal((await f.call(USER,'/api/tech/posts',p)).status,200);
  const near=(await f.call(MECH,'/api/tech/posts/near')).posts;assert.equal(near.length,1);
  const n=near[0];assert.notEqual(n.lat,p.lat);assert.notEqual(n.lng,p.lng);assert.ok(n.approxKm>0);assert.ok(Number.isInteger(n.dist));
  assert.ok(Math.abs(n.lat-p.lat)<0.02&&Math.abs(n.lng-p.lng)<0.02,'still roughly the right area');
  assert.equal(n.address,undefined);assert.equal(n.phone,undefined);
  const det=(await f.call(MECH,'/api/tech/posts/'+p.id)).post;assert.notEqual(det.lat,p.lat);assert.equal(det.address,undefined);
  /* เปิดซ้ำหลายรอบได้จุดเดิม (ไม่สุ่ม) — เฉลี่ยหาจุดจริงไม่ได้ */
  assert.equal((await f.call(MECH,'/api/tech/posts/near')).posts[0].lat,n.lat);
  /* เจ้าของประกาศเห็นจุดจริงของตัวเอง */
  const own=(await f.call(USER,'/api/tech/posts/'+p.id)).post;assert.equal(own.lat,p.lat);assert.equal(own.lng,p.lng);
});

test('a mechanic can only post services in categories that were skill-checked',async()=>{
  const f=fixture();await withMechanic(f,{cats:['air'],mobile:false});
  const g=(cat)=>({title:'ล้างแอร์ครบชุด',price:1200,cats:[cat],brands:[]});
  assert.equal((await f.call(MECH,'/api/tech/gig',g('air-clean'))).status,200);
  const brake=await f.call(MECH,'/api/tech/gig',g('brake'));assert.equal(brake.status,403);assert.match(brake.error,/ผ่านการตรวจทักษะ/);
  assert.equal((await f.call(MECH,'/api/tech/gig',g('tow'))).status,403,'no mobile service without vetting');
  assert.equal((await f.call(MECH,'/api/tech/gig',g('made-up'))).status,400);
});

test('approval publishes separate, dated vetting facts — not a blanket "safe" badge, and no reviewer notes',async()=>{
  fakeGemini();const f=fixture(),a=await pending(f);assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,200);
  const t=(await f.call('','/api/tech')).techs[0];
  assert.deepEqual({identity:t.vetting.identity,phone:t.vetting.phone,shop:t.vetting.shop,skills:t.vetting.skills,cats:t.vetting.cats},{identity:true,phone:true,shop:'video_call',skills:'interview',cats:['eng']});
  assert.ok(t.vetting.at>0);assert.ok(!JSON.stringify(t).includes('Test-only human review'),'reviewer evidence notes stay private');
});

/* ใบงานหนึ่งใบ: ลูกค้าขอราคา → ช่างเสนอ → ลูกค้ายืนยัน */
async function acceptedJob(f){
  const tid=await withMechanic(f),id=crypto.randomUUID();
  assert.equal((await f.call(USER,'/api/tech/jobs',{id,techId:tid,car:'Honda City 2019',symptom:'แอร์ไม่เย็น มีลมออกแต่ไม่เย็น',area:'บางนา',address:'99/1 ซอยทดสอบ บางนา',phone:'0812345678',requestedTime:'พรุ่งนี้เช้า',mode:'mobile'})).status,200);
  const rev=async who=>(await f.call(who,'/api/tech/jobs/'+id)).job.revision;
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'quote',revision:await rev(MECH),labor:800,parts:400,travel:100,scope:'ล้างระบบแอร์และเติมน้ำยา',appointment:'พรุ่งนี้ 9 โมง',warranty:30})).status,200);
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id,{action:'accept',revision:await rev(USER),consent:true})).status,200);
  return {id,rev};
}
test('start code: only the customer sees it, the mechanic must enter it, wrong guesses are limited, it is single-use',async()=>{
  const f=fixture(),{id,rev}=await acceptedJob(f);
  const cj=(await f.call(USER,'/api/tech/jobs/'+id)).job,tj=(await f.call(MECH,'/api/tech/jobs/'+id)).job;
  assert.match(cj.startCode,/^\d{4}$/);assert.equal(tj.startCode,undefined);assert.equal(tj.startCodeRequired,true);
  const wrong=cj.startCode==='0000'?'1111':'0000';
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'start',revision:await rev(MECH)})).status,400,'no code → cannot start');
  const bad=await f.call(MECH,'/api/tech/jobs/'+id,{action:'start',revision:await rev(MECH),code:wrong});assert.equal(bad.status,400);assert.match(bad.error,/ลองได้อีก 3 ครั้ง/);
  for(let i=0;i<3;i++)await f.call(MECH,'/api/tech/jobs/'+id,{action:'start',revision:await rev(MECH),code:wrong});
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'start',revision:await rev(MECH),code:cj.startCode})).status,429,'locked after 5 wrong tries, even with the right code');
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'newcode'})).status,403,'mechanic cannot reset the code');
  const fresh=(await f.call(USER,'/api/tech/jobs/'+id,{action:'newcode'})).startCode;assert.match(fresh,/^\d{4}$/);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'start',revision:await rev(MECH),code:fresh})).status,200);
  const after=(await f.call(USER,'/api/tech/jobs/'+id)).job;assert.equal(after.status,'working');assert.equal(after.startCode,undefined,'code is single-use');
  assert.equal(after.history.at(-1).code,true);
});
test('add-on work changes the price only after the customer accepts; confirmed price cannot be re-quoted',async()=>{
  const f=fixture(),{id,rev}=await acceptedJob(f);
  const code=(await f.call(USER,'/api/tech/jobs/'+id)).job.startCode;
  await f.call(MECH,'/api/tech/jobs/'+id,{action:'start',revision:await rev(MECH),code});
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'quote',revision:await rev(MECH),labor:5000,parts:0,travel:0,scope:'ขึ้นราคาย้อนหลัง',appointment:'ตอนนี้',warranty:0})).status,409);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'extra',revision:await rev(MECH),desc:'เปลี่ยนวาล์วแอร์ที่รั่ว',labor:300,parts:900})).status,200);
  let j=(await f.call(USER,'/api/tech/jobs/'+id)).job;assert.equal(j.agreedTotal,1300,'pending add-on not counted yet');
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'extra',revision:await rev(MECH),desc:'อีกรายการ',labor:100,parts:0})).status,409,'one pending at a time');
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'done',revision:await rev(MECH),note:'ซ่อมเสร็จเรียบร้อยแล้ว'})).status,409,'cannot finish with an unanswered add-on');
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'extra_ok',revision:await rev(MECH),extraId:j.extras[0].id})).status,403,'mechanic cannot approve own add-on');
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id,{action:'extra_ok',revision:await rev(USER),extraId:j.extras[0].id})).status,200);
  j=(await f.call(USER,'/api/tech/jobs/'+id)).job;assert.equal(j.agreedTotal,2500);
  const photo='data:image/jpeg;base64,'+Buffer.from([255,216,255,217]).toString('base64');
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'done',revision:await rev(MECH),note:'ซ่อมเสร็จเรียบร้อยแล้ว',photos:[photo]})).status,200);
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id)).job.photosAfter.length,1);
});

test('trusted-person link: customer only, no address/phone, single active link, revocable',async()=>{
  const f=fixture(),{id}=await acceptedJob(f);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'share'})).status,403);
  const a=await f.call(USER,'/api/tech/jobs/'+id,{action:'share'});assert.equal(a.status,200);assert.ok(a.token.length>=30);
  const v=await f.call('','/api/tech/share/'+a.token);assert.equal(v.status,200);assert.equal(v.trip.tech.name,'อู่ทดสอบ');assert.equal(v.trip.status,'accepted');
  const txt=JSON.stringify(v);for(const secret of ['99/1 ซอยทดสอบ','0812345678','0899999999'])assert.ok(!txt.includes(secret),'leaked '+secret);
  const b=await f.call(USER,'/api/tech/jobs/'+id,{action:'share'});
  assert.equal((await f.call('','/api/tech/share/'+a.token)).status,404,'old link dies when a new one is made');
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id)).job.share.token,b.token);
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id,{action:'unshare'})).status,200);
  assert.equal((await f.call('','/api/tech/share/'+b.token)).status,404);
  assert.equal((await f.call('','/api/tech/share/'+'x'.repeat(32))).status,404);
});

import {stripMeta} from '../src/techs.js';
import {png} from './tech-fixtures.mjs';
test('uploads lose embedded GPS/EXIF and text metadata; plain images pass unchanged',()=>{
  /* JPEG: SOI · APP1 "Exif..GPS" · DQT (เก็บไว้) · SOS + ข้อมูล · EOI */
  const app1=[0xFF,0xE1,0x00,0x0C,...Buffer.from('Exif\0\0GPS!')];
  const dqt=[0xFF,0xDB,0x00,0x04,0x01,0x02];
  const jpg=Buffer.from([0xFF,0xD8,...app1,...dqt,0xFF,0xDA,0x00,0x04,0x09,0x09,0x55,0x66,0xFF,0xD9]);
  const out=Buffer.from(stripMeta('image/jpeg',jpg.toString('base64')),'base64');
  assert.ok(!out.includes(Buffer.from('GPS!')));assert.ok(out.includes(Buffer.from([0xFF,0xDB])),'quantisation table kept');assert.deepEqual([...out.subarray(-2)],[0xFF,0xD9]);
  /* PNG: แทรก tEXt ที่มีพิกัด */
  const clean=png(3),crc=Buffer.alloc(4),txt=Buffer.concat([Buffer.from([0,0,0,8]),Buffer.from('tEXtGPS:13.7'),crc]);
  const dirty=Buffer.concat([clean.subarray(0,33),txt,clean.subarray(33)]);
  assert.equal(stripMeta('image/png',dirty.toString('base64')),clean.toString('base64'));
  assert.equal(stripMeta('image/png',clean.toString('base64')),clean.toString('base64'));
  assert.equal(stripMeta('image/jpeg','bm90IGFuIGltYWdl'),'bm90IGFuIGltYWdl','unparseable input returned as-is for the validator');
});
test('staff actions are written to an audit log without full ID numbers; only admins can read it',async()=>{
  const {fakeGemini,pending,review,ADMIN}=await import('./tech-fixtures.mjs');fakeGemini();
  const f=fixture(),a=await pending(f);await f.call(ADMIN,'/api/tech/docs?uid='+a.uid);await f.call(ADMIN,'/api/tech/review',review(a));
  const log=(await f.call(ADMIN,'/api/tech/audit')).log;assert.deepEqual(log.map(x=>x.action).sort(),['approve','view_docs']);
  assert.ok(!JSON.stringify(log).includes('1101700203450'));assert.equal((await f.call(USER,'/api/tech/audit')).status,403);
});
