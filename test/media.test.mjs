import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER,png} from './tech-fixtures.mjs';
import {handleTech} from '../src/techs.js';

/* ไฟล์แนบในแชต: เก็บไฟล์จริงบนเซิร์ฟเวอร์ ปิดแอป/เปลี่ยนเครื่องแล้วยังเปิดได้ · เปิดได้เฉพาะคนที่ควรเห็น */
const MECH='mech|mech@unit.test',OTHER='other|other@unit.test',ADMIN_T='boss|boss@unit.test';
const verifyToken=async t=>{const [uid,email]=t.split('|');return {sub:uid,email,email_verified:true};};
function setup(extra={}){
  const f=fixture(extra);
  globalThis.fetch=async()=>Response.json({});
  const call=async(token,path,body)=>{const r=await handleTech(new Request('https://unit.test'+path,{method:body?'POST':'GET',headers:token?{Authorization:'Bearer '+token}:{},body:body?JSON.stringify(body):undefined}),
    f.env,undefined,{verifyToken,ctx:{waitUntil(){}}});return {...await r.json(),status:r.status};};
  const put=async(token,id,bytes,mime,scope)=>{const r=await handleTech(new Request(`https://unit.test/api/tech/media/${id}${scope?'?scope='+scope:''}`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':mime},body:bytes}),
    f.env,undefined,{verifyToken});return {...await r.json(),status:r.status};};
  const get=async(token,id)=>{const r=await handleTech(new Request('https://unit.test/api/tech/media/'+id,{headers:{Authorization:'Bearer '+token}}),f.env,undefined,{verifyToken});
    return {status:r.status,type:r.headers.get('Content-Type'),headers:r.headers,bytes:r.status===200?new Uint8Array(await r.arrayBuffer()):null};};
  const del=async(token,id)=>{const r=await handleTech(new Request('https://unit.test/api/tech/media/'+id,{method:'DELETE',headers:{Authorization:'Bearer '+token}}),f.env,undefined,{verifyToken});return {...await r.json(),status:r.status};};
  return {f,call,put,get,del};
}
async function mechanic(f,call){
  await call('','/api/tech/ping');
  f.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at) VALUES (?,?,?,?,1,0,0,?,?)')
    .run('t_mech','mech','0899999999',JSON.stringify({name:'ช่าง ทดสอบ',shop:'อู่ทดสอบ',lat:13.75,lng:100.5,radius:30,cats:['air'],mobile:true}),Date.now(),Date.now());
  return 't_mech';
}
const same=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);

test('media: AI chat files are stored for good and only the owner can open them',async()=>{
  const {put,get,del}=setup();const img=new Uint8Array(png(3));
  const r=await put(USER,'m_ai_photo_001',img,'image/png','ai');
  assert.equal(r.status,200);assert.equal(r.kind,'image');assert.equal(r.size,img.length);
  const back=await get(USER,'m_ai_photo_001');
  assert.equal(back.status,200);assert.equal(back.type,'image/png');assert.ok(same(back.bytes,img),'same bytes come back');
  assert.match(back.headers.get('Cache-Control'),/no-store/);assert.match(back.headers.get('Vary'),/Authorization/);
  assert.equal((await get(ADMIN_T,'m_ai_photo_001')).status,404,'staff cannot read owner-only AI files');
  assert.equal((await get(OTHER,'m_ai_photo_001')).status,404,'nobody else can open an AI chat file');
  assert.equal((await put(USER,'m_ai_photo_001',img,'image/png','ai')).existed,true,'retrying an upload does not duplicate it');
  assert.equal((await put(OTHER,'m_ai_photo_001',img,'image/png','ai')).status,409,'another account cannot overwrite it');
  assert.equal((await put(USER,'m_ai_page_0001',new TextEncoder().encode('<script>'),'text/html','ai')).status,415,'only image, video and audio');
  assert.equal((await put(USER,'bad id',img,'image/png','ai')).status,400);
  assert.equal((await del(USER,'m_ai_photo_001')).status,200);
  assert.equal((await get(USER,'m_ai_photo_001')).status,404,'deleted for real');
});

test('media: simultaneous uploads cannot replace bytes across accounts, including R2 in-flight files',async()=>{
  const store=new Map();let release,entered;
  const started=new Promise(r=>entered=r);
  const MEDIA={async put(k,v){entered();await new Promise(r=>release=r);store.set(k,new Uint8Array(v))},async get(k){return store.has(k)?{body:store.get(k)}:null},async delete(k){store.delete(k)}};
  const {put,get,del}=setup({MEDIA}),id='m_race_private_01',a=new Uint8Array([1,2,3]);
  const first=put(USER,id,a,'audio/webm','ai');await started;
  assert.equal((await get(USER,id)).status,404,'partial files are never served');
  assert.equal((await del(USER,id)).status,409,'reservation cannot be transferred mid-upload');
  assert.equal((await put(OTHER,id,new Uint8Array([8,8]),'audio/webm','ai')).status,409);
  release();assert.equal((await first).status,200);assert.deepEqual((await get(USER,id)).bytes,a);
  assert.equal((await get(OTHER,id)).status,404);
});

test('media: big files are split across rows and come back whole; oversize is refused',async()=>{
  const {f,put,get}=setup();
  const voice=new Uint8Array(2.5*1024*1024).map((_,i)=>(i*31+7)&255);
  const r=await put(USER,'m_voice_note_01',voice,'audio/webm;codecs=opus','ai');
  assert.equal(r.status,200);assert.equal(r.mime,'audio/webm');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM media_parts WHERE id='m_voice_note_01'").get().n,3,'D1 rows stay under the 2MB row limit');
  const back=await get(USER,'m_voice_note_01');assert.ok(same(back.bytes,voice));
  assert.equal((await put(USER,'m_too_big_0001',new Uint8Array(10*1024*1024+1),'image/jpeg','ai')).status,413);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM media WHERE id='m_too_big_0001'").get().n,0);
});

test('media: uses the R2 bucket when one is bound',async()=>{
  const store=new Map();
  const MEDIA={async put(k,v){store.set(k,new Uint8Array(v))},async get(k){const v=store.get(k);return v?{body:v}:null},async delete(k){store.delete(k)}};
  const {f,put,get}=setup({MEDIA});const clip=new Uint8Array(3*1024*1024).fill(9);
  assert.equal((await put(USER,'m_clip_r2_0001',clip,'video/mp4','ai')).status,200);
  assert.ok(store.has('m/m_clip_r2_0001'));assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM media_parts').get().n,0);
  assert.ok(same((await get(USER,'m_clip_r2_0001')).bytes,clip));
});

test('media: files sent in an inquiry room open for both sides only, and a message can be just a photo',async()=>{
  const {f,call,put,get,del}=setup();const tid=await mechanic(f,call);const img=new Uint8Array(png(5));
  const room=(await call(USER,'/api/tech/threads',{techId:tid,text:'สวัสดีครับ'})).thread.id;
  assert.equal((await put(USER,'m_room_photo_01',img,'image/jpeg')).status,200);
  assert.equal((await get(MECH,'m_room_photo_01')).status,404,'a draft is private until it is sent');
  const sent=await call(USER,'/api/tech/threads/'+room,{text:'',media:['m_room_photo_01']});
  assert.equal(sent.status,200);assert.equal(sent.message.media[0].kind,'image');assert.equal(sent.message.text,'');
  assert.equal((await get(MECH,'m_room_photo_01')).status,200,'the mechanic in the room can open it');
  assert.equal((await get(ADMIN_T,'m_room_photo_01')).status,200,'staff can review it');
  assert.equal((await get(OTHER,'m_room_photo_01')).status,404,'outsiders cannot');
  const seen=await call(MECH,'/api/tech/threads/'+room);
  assert.deepEqual(seen.messages.at(-1).media.map(m=>m.id),['m_room_photo_01']);
  assert.match((await call(MECH,'/api/tech/threads')).threads[0].last.text,/รูปภาพ/,'room list shows a label instead of an empty line');
  assert.equal((await del(USER,'m_room_photo_01')).status,409,'sent evidence stays');
  /* แนบไฟล์ของคนอื่น หรือไม่มีทั้งข้อความและไฟล์ = ไม่ได้ */
  assert.equal((await put(OTHER,'m_someone_else',img,'image/png')).status,200);
  assert.equal((await call(USER,'/api/tech/threads/'+room,{text:'ดูนี่',media:['m_someone_else']})).status,400);
  assert.equal((await call(USER,'/api/tech/threads/'+room,{text:'',media:[]})).status,400);
  /* ไฟล์ที่ส่งในห้องหนึ่งแล้ว เอาไปแนบห้องอื่นไม่ได้ */
  await call(OTHER,'/api/tech/threads',{techId:tid,text:'ร้านนี้รับไหม'});
  assert.equal((await call(USER,'/api/tech/threads/'+room,{text:'ซ้ำ',media:['m_room_photo_01']})).status,200,'resending in the same room is fine');
});

test('media: job chat messages carry files for the customer and the shop',async()=>{
  const {f,call,put,get}=setup();const tid=await mechanic(f,call);
  const id='11111111-2222-4333-8444-555555555555';
  const made=await call(USER,'/api/tech/jobs',{id,techId:tid,car:'Honda City 2019',symptom:'แอร์ไม่เย็น มีลมออกแต่ไม่เย็น',area:'บางนา',address:'99/1 ซอย 5',phone:'0812345678',requestedTime:'พรุ่งนี้เช้า',mode:'mobile'});
  assert.equal(made.status,200,JSON.stringify(made));
  const sound=new Uint8Array(4000).fill(3);
  assert.equal((await put(USER,'m_job_sound_01',sound,'audio/mp4')).status,200);
  const r=await call(USER,'/api/tech/jobs/'+id,{action:'message',message:'',media:['m_job_sound_01']});
  assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.message.media[0].kind,'audio');
  assert.equal((await get(MECH,'m_job_sound_01')).status,200);
  assert.equal((await get(OTHER,'m_job_sound_01')).status,404);
  const msgs=(await call(MECH,`/api/tech/jobs/${id}/messages?after=0`)).messages;
  assert.equal(msgs.at(-1).media[0].id,'m_job_sound_01');
});
