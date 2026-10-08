import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER} from './tech-fixtures.mjs';
import {handleTech} from '../src/techs.js';

const MECH='mech|mech@unit.test';
async function withMechanic(f){
  await f.call('', '/api/tech/ping');
  f.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at) VALUES (?,?,?,?,1,0,0,?,?)')
    .run('t_mech','mech','0899999999',JSON.stringify({name:'ช่าง ทดสอบ',shop:'อู่ทดสอบ',lat:13.75,lng:100.5,radius:30,cats:['air'],mobile:true}),Date.now(),Date.now());
  return 't_mech';
}
/* หลังบ้านจริงคุยกับ LINE — ในเทสต์ดักไว้ทั้งหมด แล้วดูว่าส่งอะไรไปหาใคร */
function lineSetup({token='test-only-token',link=true}={}){
  const f=fixture({LINE_CHANNEL_TOKEN:token,APP_URL:'https://app.unit.test'});
  f.sqlite.exec('CREATE TABLE line_link (line_uid TEXT PRIMARY KEY, uid TEXT NOT NULL, lang TEXT, active INTEGER NOT NULL DEFAULT 1, linked_at INTEGER)');
  if(link){f.sqlite.prepare('INSERT INTO line_link VALUES (?,?,?,1,?)').run('Ucustomer','applicant','th',Date.now());
    f.sqlite.prepare('INSERT INTO line_link VALUES (?,?,?,1,?)').run('Umechanic','mech','th',Date.now());}
  const pushes=[];
  globalThis.fetch=async(url,init)=>{if(String(url).startsWith('https://api.line.me/')){pushes.push({url:String(url),auth:init.headers.Authorization,body:JSON.parse(init.body)});return Response.json({});}
    throw Error('unexpected fetch '+url);};
  /* เหมือน f.call แต่ส่ง ctx ให้ เพื่อรอแจ้งเตือนที่ทำเบื้องหลังให้เสร็จก่อนตรวจ */
  const call=async(token,path,body)=>{const waits=[];
    const r=await handleTech(new Request('https://unit.test'+path,{method:body?'POST':'GET',headers:token?{Authorization:'Bearer '+token}:{},body:body?JSON.stringify(body):undefined}),
      f.env,undefined,{verifyToken:async t=>{const [uid,email]=t.split('|');return {sub:uid,email,email_verified:true};},ctx:{waitUntil:p=>waits.push(p)}});
    await Promise.all(waits);return {...await r.json(),status:r.status};};
  return {f,call,pushes};
}
const words=p=>JSON.stringify(p.body.messages);
const job=(tid,id)=>({id,techId:tid,car:'Honda City 2019',symptom:'แอร์ไม่เย็น มีลมออกแต่ไม่เย็น',area:'บางนา',address:'99/1 ซอยลับเฉพาะ',phone:'0812345678',requestedTime:'พรุ่งนี้เช้า',mode:'mobile'});

test('LINE: the mechanic hears about a new request, the customer about the quote — no address or phone in LINE',async()=>{
  const {f,call,pushes}=lineSetup();const tid=await withMechanic(f),id=crypto.randomUUID();
  assert.equal((await call(USER,'/api/tech/jobs',job(tid,id))).status,200);
  assert.equal(pushes.length,1);assert.equal(pushes[0].body.to,'Umechanic');assert.equal(pushes[0].auth,'Bearer test-only-token');
  assert.match(words(pushes[0]),/คำขอราคาใหม่/);assert.match(words(pushes[0]),/Honda City 2019/);
  assert.ok(!/0812345678|ซอยลับเฉพาะ/.test(words(pushes[0])),'never the phone or the address');
  assert.match(words(pushes[0]),new RegExp('https://app\\.unit\\.test/\\?job='+id+'&openExternalBrowser=1'),'button opens the job in the phone browser');
  const rev=async w=>(await call(w,'/api/tech/jobs/'+id)).job.revision;
  assert.equal((await call(MECH,'/api/tech/jobs/'+id,{action:'quote',revision:await rev(MECH),labor:800,parts:400,travel:100,scope:'ล้างระบบแอร์และเติมน้ำยา',appointment:'พรุ่งนี้ 9 โมง',warranty:30})).status,200);
  assert.equal(pushes.at(-1).body.to,'Ucustomer');assert.match(words(pushes.at(-1)),/เสนอราคา ฿1,300/);
  assert.equal((await call(USER,'/api/tech/jobs/'+id,{action:'accept',revision:await rev(USER),consent:true})).status,200);
  assert.equal(pushes.at(-1).body.to,'Umechanic');assert.match(words(pushes.at(-1)),/ลูกค้ายืนยันราคา/);
});

test('LINE: chat messages notify the other side at most once per 30 minutes per job',async()=>{
  const {f,call,pushes}=lineSetup();const tid=await withMechanic(f),id=crypto.randomUUID();
  await call(USER,'/api/tech/jobs',job(tid,id));const before=pushes.length;
  for(const text of ['สวัสดีครับ','รถอยู่ที่บ้านทั้งวัน','มาได้กี่โมงครับ'])assert.equal((await call(USER,'/api/tech/jobs/'+id,{action:'message',text})).status,200);
  const msgs=pushes.slice(before);assert.equal(msgs.length,1,'three messages, one LINE');
  assert.equal(msgs[0].body.to,'Umechanic');assert.match(words(msgs[0]),/ข้อความใหม่/);assert.match(words(msgs[0]),/สวัสดีครับ/);
  assert.equal((await call(MECH,'/api/tech/jobs/'+id,{action:'message',text:'บ่ายสองได้ไหมครับ'})).status,200);
  assert.equal(pushes.at(-1).body.to,'Ucustomer','the reply notifies the customer separately');
});

test('LINE: nobody linked, or LINE not configured → the job still works and nothing is sent',async()=>{
  for(const opt of [{link:false},{token:''}]){
    const {f,call,pushes}=lineSetup(opt);const tid=await withMechanic(f),id=crypto.randomUUID();
    assert.equal((await call(USER,'/api/tech/jobs',job(tid,id))).status,200);
    assert.equal((await call(USER,'/api/tech/jobs/'+id,{action:'message',text:'สวัสดีครับ'})).status,200);
    assert.equal(pushes.length,0,JSON.stringify(opt));
  }
});

test('LINE: a failing LINE API never breaks the job',async()=>{
  const {f,call}=lineSetup();const tid=await withMechanic(f),id=crypto.randomUUID();
  globalThis.fetch=async()=>{throw Error('LINE down');};
  assert.equal((await call(USER,'/api/tech/jobs',job(tid,id))).status,200);
});
