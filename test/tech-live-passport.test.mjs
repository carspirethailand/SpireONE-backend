/* ช่างกำลังมา (แผนที่แบบ Grab) + Car Passport + ปฏิทินค่าใช้จ่าย/เครื่องมือ AI ใหม่ */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER,ADMIN} from './tech-fixtures.mjs';
import {withMechanic,MECH} from './tech-safety.test.mjs';
import {buildFeatureRequest,cleanFeatureJson,featureCap} from '../src/features-ai.mjs';
import {deleteAccount} from '../src/account-data.js';

const ADDR='ซอยทดสอบ บางนา · แผนที่ https://maps.google.com/?q=13.7001,100.6002';
async function accepted(f){
  const tid=await withMechanic(f),id=crypto.randomUUID();
  assert.equal((await f.call(USER,'/api/tech/jobs',{id,techId:tid,car:'Honda City 2019 · 42,000 กม.',symptom:'แบตหมด สตาร์ทไม่ติดเลย',area:'บางนา',address:ADDR,phone:'0812345678',requestedTime:'วันนี้',mode:'mobile'})).status,200);
  const rev=async who=>(await f.call(who,'/api/tech/jobs/'+id)).job.revision;
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'quote',revision:await rev(MECH),labor:300,parts:2500,travel:100,scope:'เปลี่ยนแบตเตอรี่ใหม่ 60Ah',appointment:'วันนี้ 30 นาที',warranty:180})).status,200);
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id,{action:'accept',revision:await rev(USER),consent:true})).status,200);
  return {id,rev};
}

test('live map: the mechanic can share a position only while on the way; the customer sees it with an ETA; it is wiped when the trip ends',async()=>{
  const f=fixture(),{id,rev}=await accepted(f);
  const pt={lat:13.72,lng:100.58,acc:12,heading:90,speed:9};
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id+'/live',pt)).status,409,'not on the way yet');
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'enroute',revision:await rev(MECH)})).status,200);
  const before=f.sqlite.prepare('SELECT updated_at FROM tech_jobs WHERE id=?').get(id).updated_at;
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id+'/live',pt)).status,403,'customers cannot fake the mechanic position');
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id+'/live',{lat:999,lng:1})).status,400);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id+'/live',pt)).status,200);
  assert.equal(f.sqlite.prepare('SELECT updated_at FROM tech_jobs WHERE id=?').get(id).updated_at,before,'moving does not reload everyone\'s job list');
  const c=await f.call(USER,'/api/tech/jobs/'+id+'/live');
  assert.equal(c.live.lat,13.72);assert.deepEqual(c.dest,{lat:13.7001,lng:100.6002});
  assert.ok(c.km>2&&c.km<6,'road distance estimate');assert.ok(c.etaMin>=5&&c.etaMin<20,'ETA in minutes');
  /* คนนอกไม่เห็น */
  assert.equal((await f.call('stranger|x@unit.test','/api/tech/jobs/'+id+'/live')).status,404);
  /* คนที่ลูกค้าแชร์ลิงก์ให้ เห็นช่างกำลังมา แต่ไม่เห็นที่อยู่ลูกค้า */
  const tok=(await f.call(USER,'/api/tech/jobs/'+id,{action:'share'})).token;
  const trip=(await f.call('','/api/tech/share/'+tok)).trip;
  assert.equal(trip.live.lat,13.72);assert.ok(trip.live.etaMin>0);assert.ok(!JSON.stringify(trip).includes('100.6002'),'destination stays private');
  /* ตำแหน่งเก่าเกิน 3 นาที = ไม่แสดง (บอกว่าสัญญาณขาด) */
  f.sqlite.prepare('UPDATE tech_jobs SET live=? WHERE id=?').run(JSON.stringify({...pt,at:Date.now()-5*60000}),id);
  const st=await f.call(USER,'/api/tech/jobs/'+id+'/live');assert.equal(st.live,null);assert.equal(st.stale,true);
  /* เริ่มซ่อม → ลบตำแหน่งทิ้ง */
  await f.call(MECH,'/api/tech/jobs/'+id+'/live',pt);
  const code=(await f.call(USER,'/api/tech/jobs/'+id)).job.startCode;
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'start',revision:await rev(MECH),code})).status,200);
  assert.equal(f.sqlite.prepare('SELECT live FROM tech_jobs WHERE id=?').get(id).live,null);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id+'/live',pt)).status,409);
});

async function completed(f){
  const {id,rev}=await accepted(f);
  const code=(await f.call(USER,'/api/tech/jobs/'+id)).job.startCode;
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'start',revision:await rev(MECH),code})).status,200);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'done',revision:await rev(MECH),note:'เปลี่ยนแบตเตอรี่ 60Ah ใหม่ ทดสอบระบบไฟชาร์จปกติ'})).status,200);
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id,{action:'complete',revision:await rev(USER)})).status,200);
  return id;
}
const passport=(over={})=>({carKey:'car-1',car:{make:'Honda',model:'City',year:2019,fuel:'เบนซิน'},km:42000,
  odo:[{date:'2025-01-10',km:30000},{date:'2026-02-01',km:41000}],services:[{date:'2026-02-01',km:41000,item:'เปลี่ยนน้ำมันเครื่อง',amount:1500}],...over});

test('car passport: owner-recorded vs shop-verified entries, no personal data, only own completed jobs count, revocable',async()=>{
  const f=fixture(),done=await completed(f);
  /* ใบงานของคนอื่น / ที่ยังไม่เสร็จ ใส่มาก็ถูกตัด */
  const r=await f.call(USER,'/api/tech/passport',passport({jobs:[done,crypto.randomUUID()]}));
  assert.equal(r.status,200,r.error);assert.equal(r.jobs,1);assert.match(r.token,/^[A-Za-z0-9_-]{20,}$/);
  const v=(await f.call('','/api/tech/passport/'+r.token)).passport;
  assert.equal(v.car.model,'City');assert.equal(v.services.length,1);assert.equal(v.services[0].amount,undefined,'costs hidden unless the owner opts in');
  assert.equal(v.verified.length,1);assert.equal(v.verified[0].shop,'อู่ทดสอบ');assert.equal(v.verified[0].shopVerified,true);
  assert.match(v.verified[0].work,/แบตเตอรี่/);assert.equal(v.verified[0].km,42000);
  const all=JSON.stringify(v);
  for(const secret of ['0812345678','ซอยทดสอบ','applicant','person@unit.test','13.7001'])assert.ok(!all.includes(secret),'leaks '+secret);
  /* อัปเดตใช้ลิงก์เดิม · เปิดราคาเอง */
  const r2=await f.call(USER,'/api/tech/passport',passport({showCost:true,jobs:[done]}));assert.equal(r2.token,r.token);
  const v2=(await f.call('','/api/tech/passport/'+r.token)).passport;assert.equal(v2.services[0].amount,1500);assert.equal(v2.verified[0].amount,2900);
  assert.equal((await f.call(USER,'/api/tech/passport?car=car-1')).passport.token,r.token);
  /* คนอื่นใส่ใบงานของเราไม่ได้ */
  assert.equal((await f.call(ADMIN,'/api/tech/passport',passport({jobs:[done]}))).jobs,0);
  /* ข้อมูลเพี้ยนถูกตัด: วันที่ในอนาคต / ไมล์ติดลบ / สคริปต์ */
  const r3=await f.call(USER,'/api/tech/passport',passport({carKey:'car-2',odo:[{date:'2900-01-01',km:5},{date:'2025-01-01',km:-5}],services:[{date:'2025-03-01',item:'<script>x</script>'}]}));
  const v3=(await f.call('','/api/tech/passport/'+r3.token)).passport;assert.equal(v3.odo.length,0);assert.ok(!JSON.stringify(v3).includes('<script>'));
  /* ยกเลิกแล้วเปิดไม่ได้ */
  assert.equal((await f.call(USER,'/api/tech/passport/revoke',{carKey:'car-1'})).status,200);
  assert.equal((await f.call('','/api/tech/passport/'+r.token)).status,404);
  /* ลบบัญชี = ลบ passport */
  await deleteAccount(f.env,'applicant');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM car_passports WHERE uid='applicant'").get().n,0);
});

test('new AI tools: engine-bay boxes are clamped to the photo, labels need a real part, and junk is dropped',()=>{
  const img={mime:'image/jpeg',b64:'aGVsbG8='},wav={mime:'audio/wav',b64:'aGVsbG8='};
  assert.equal(buildFeatureRequest({tool:'bay',attachments:[img]}).json,true);
  assert.throws(()=>buildFeatureRequest({tool:'bay'}),/photo/);
  assert.throws(()=>buildFeatureRequest({tool:'ear',attachments:[img]}),/audio/);
  assert.equal(buildFeatureRequest({tool:'ear',attachments:[wav]}).json,true);
  assert.throws(()=>buildFeatureRequest({tool:'wrapped',context:{stats:{km:1}},attachments:[img]}),/stats only/);
  assert.match(buildFeatureRequest({tool:'bay',attachments:[img]}).system,/Only label parts you can actually see/);
  assert.match(buildFeatureRequest({tool:'incident',question:'ชนท้ายที่แยก'}).system,/Never decide who is at fault/);
  const b=cleanFeatureJson('bay','```json\n'+JSON.stringify({scene:'engine_bay',items:[
    {name:'แบตเตอรี่',box_2d:[100,600,300,900],what:'จ่ายไฟ',check:'ดูขั้ว',look:'คราบขาว'},
    {name:'ก้านวัดน้ำมัน',box_2d:[1200,-50,400,300]},
    {name:'',box_2d:[1,1,500,500]},{name:'จุดเล็กเกิน',box_2d:[10,10,12,12]},{name:'ไม่มีกรอบ'}],notes:['ขั้วแบตมีคราบ'],speak:'เห็นแบตเตอรี่ครับ'})+'\n```');
  assert.equal(b.items.length,2);assert.deepEqual(b.items[1].box,[400,0,1000,300],'flipped and clamped into the photo');
  assert.equal(cleanFeatureJson('bay',{scene:'not_car',items:[{name:'x',box_2d:[0,0,500,500]}]}).items.length,0,'no labels on a non-engine photo');
  const e=cleanFeatureJson('ear',{quality:'wat',urgency:'panic',causes:[{name:'สายพาน',likelihood:'likely'}],speak:'ได้ยินเสียงเอี๊ยด'});
  assert.equal(e.quality,'noisy');assert.equal(e.urgency,'unassessed');assert.deepEqual(e.causes,[],'invalid/noisy input cannot diagnose a part');
  assert.throws(()=>cleanFeatureJson('wrapped','no json here'),/JSON/);
});

test('per-tool daily caps: defaults, staff overrides from config, and tools without a cap',()=>{
  assert.equal(featureCap({},'bay'),8);assert.equal(featureCap({featureDaily:{bay:20}},'bay'),20);
  assert.equal(featureCap({featureDaily:{bay:-1}},'bay'),8,'bad config falls back to the default');
  assert.equal(featureCap({},'quote'),0);assert.equal(featureCap({},'toString'),0);
});

test('live call setup: echo/noise-tolerant turn detection, resumable sessions, optional tools', async()=>{
  const {liveToken,cleanHandle}=await import('../src/live-setup.mjs');
  const t=liveToken({model:'gemini-live-x',system:'sys',tools:true,handle:'abc_DEF-123/xyz=',now:0}).bidiGenerateContentSetup;
  assert.equal(t.realtimeInputConfig.automaticActivityDetection.startOfSpeechSensitivity,'START_SENSITIVITY_LOW');
  assert.ok(t.realtimeInputConfig.automaticActivityDetection.silenceDurationMs>=500,'Thai speakers can pause without being cut off');
  assert.deepEqual(t.sessionResumption,{handle:'abc_DEF-123/xyz='});
  assert.deepEqual(t.tools[0].functionDeclarations.map(f=>f.name),['listen_engine','scan_engine_bay']);
  const fresh=liveToken({model:'m',system:'s',tools:false,handle:'',now:0}).bidiGenerateContentSetup;
  assert.deepEqual(fresh.sessionResumption,{});assert.equal(fresh.tools,undefined);
  assert.equal(liveToken({model:'m',resume:false,now:0}).bidiGenerateContentSetup.sessionResumption,undefined,'fallback without resumption');
  assert.equal(cleanHandle('x"><script>'),'');assert.equal(cleanHandle(42),'');
});
test('live scan frames: up to 12 boxes and a separate, larger daily cap',()=>{
  const img={mime:'image/jpeg',b64:'aGVsbG8='};
  const r=buildFeatureRequest({tool:'baylive',attachments:[img]});assert.equal(r.json,true);assert.equal(r.maxTokens,1800);
  assert.match(r.system,/air intake duct or pipe/);
  const many=Array.from({length:15},(_,i)=>({name:'part'+i,box_2d:[i*10,i*10,i*10+200,i*10+200]}));
  assert.equal(cleanFeatureJson('baylive',{scene:'engine_bay',items:many}).items.length,12);
  assert.equal(featureCap({},'baylive'),80);
});
