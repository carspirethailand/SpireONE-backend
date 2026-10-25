/* สถานะ "รับงาน / รับงานไม่แจ้งเตือน / พักร้าน" ต้องมีผลจริง และช่างเคลื่อนที่: ตำแหน่งตามมือถือช่าง (ลูกค้าเห็นแค่จุดโดยประมาณ) */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER,ADMIN} from './tech-fixtures.mjs';
import {handleTech} from '../src/techs.js';
import {post} from './tech-safety.test.mjs';
import {deleteAccount} from '../src/account-data.js';

const MECH='mech|mech@unit.test',MECH2='mech2|mech2@unit.test';
async function shop(f,id,uid,data={},online=0){
  await f.call('', '/api/tech/ping');
  const d={name:'ช่าง '+id,shop:'อู่ '+id,lat:13.75,lng:100.5,radius:30,cats:['eng'],mobile:true,warranty:30,...data};
  f.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,online,created_at,updated_at) VALUES (?,?,?,?,1,0,0,?,?,?)')
    .run(id,uid,'0899999999',JSON.stringify(d),online,Date.now(),Date.now());
  return id;
}
/* ดัก LINE ไว้ทั้งหมด แล้วดูว่าการ์ดงานด่วนไปถึงใคร */
function lineSetup(){
  const f=fixture({LINE_CHANNEL_TOKEN:'test-only-token',APP_URL:'https://app.unit.test'});
  f.sqlite.exec('CREATE TABLE line_link (line_uid TEXT PRIMARY KEY, uid TEXT NOT NULL, lang TEXT, active INTEGER NOT NULL DEFAULT 1, linked_at INTEGER)');
  for(const [l,u] of [['Uon','mech'],['Uquiet','mech2'],['Upause','mech3']])f.sqlite.prepare('INSERT INTO line_link VALUES (?,?,?,1,?)').run(l,u,'th',Date.now());
  const pushes=[];
  globalThis.fetch=async(url,init)=>{if(String(url).startsWith('https://api.line.me/')){pushes.push(JSON.parse(init.body));return Response.json({});}throw Error('unexpected fetch '+url);};
  const call=async(token,path,body)=>{const waits=[];
    const r=await handleTech(new Request('https://unit.test'+path,{method:body?'POST':'GET',headers:token?{Authorization:'Bearer '+token}:{},body:body?JSON.stringify(body):undefined}),
      f.env,undefined,{verifyToken:async t=>{const [uid,email]=t.split('|');return {sub:uid,email,email_verified:true};},ctx:{waitUntil:p=>waits.push(p)}});
    await Promise.all(waits);return {...await r.json(),status:r.status};};
  return {f,call,pushes};
}

test('urgent LINE alerts reach only shops set to "taking jobs" — quiet and paused shops are not woken, and the customer is told both numbers',async()=>{
  const {f,call,pushes}=lineSetup();
  await shop(f,'t_on','mech',{},1);
  await shop(f,'t_quiet','mech2',{},0);
  await shop(f,'t_pause','mech3',{vacation:{on:true,until:null,note:''}},1);
  const r=await call(USER,'/api/tech/posts',post({urgent:true,symptom:'แบตหมด'}));
  assert.equal(r.status,200,r.error);
  assert.equal(r.reach,3,'every shop in range can still see the post in "find work"');
  assert.equal(r.taking,1,'only one shop is taking jobs right now');
  assert.deepEqual(pushes.map(p=>p.to),['Uon'],'LINE goes to the shop that is taking jobs only');
  assert.match(JSON.stringify(pushes[0].messages),/ห่างร้านคุณประมาณ/);
  /* ประกาศปกติ (ไม่ด่วน) ไม่ส่ง LINE ใคร เหมือนเดิม */
  const n=await call(USER,'/api/tech/posts',post({symptom:'แอร์ไม่เย็น มีลมออกแต่ไม่เย็น'}));assert.equal(n.status,200);assert.equal(pushes.length,1);
});

test('advice: the "go online" tip tells the truth about what quiet mode does, and is not shown to a paused shop',async()=>{
  const f=fixture();await shop(f,'t_mech','mech');
  const tip=(await f.call(MECH,'/api/tech/advice')).tips.find(x=>x.action==='online');
  assert.ok(tip);assert.match(tip.text,/ไม่ส่ง LINE/);assert.doesNotMatch(tip.text,/ออฟไลน์ ประกาศงานใหม่จะไม่แจ้งเตือน/);
  f.sqlite.prepare('UPDATE tech_profiles SET data=json_set(data,\'$.vacation\',json(\'{"on":true}\'))').run();
  assert.equal((await f.call(MECH,'/api/tech/advice')).tips.find(x=>x.action==='online'),undefined);
});

test('roaming mechanic: the phone position is accepted only in roaming mode while taking jobs',async()=>{
  const f=fixture();await shop(f,'t_mech','mech',{mobile:true});
  const here={lat:13.80123,lng:100.55456,acc:20};
  let r=await f.call(MECH,'/api/tech/here',here);assert.equal(r.status,409);assert.match(r.error,/ช่างเคลื่อนที่/);
  assert.equal((await f.call(MECH,'/api/tech/shop',{roam:true})).status,200);
  r=await f.call(MECH,'/api/tech/here',here);assert.equal(r.status,409,'not taking jobs yet');assert.match(r.error,/เปิดรับงาน/);
  assert.equal((await f.call(MECH,'/api/tech/online',{online:true})).status,200);
  assert.equal((await f.call(MECH,'/api/tech/here',{lat:0,lng:0})).status,400,'no 0,0 from a phone without a fix');
  assert.equal((await f.call(MECH,'/api/tech/here',{...here,acc:9000})).status,400,'a very rough fix is refused');
  r=await f.call(MECH,'/api/tech/here',here);assert.equal(r.status,200,r.error);assert.ok(r.at>0);
  assert.equal((await f.call(USER,'/api/tech/here',here)).status,403,'only a mechanic can send a position');
  /* ไม่ใช่ช่างรับงานนอกสถานที่ = เปิดโหมดเคลื่อนที่ไม่มีผล */
  const g=fixture();await shop(g,'t_mech','mech',{mobile:false,roam:true},1);
  assert.equal((await g.call(MECH,'/api/tech/here',here)).status,409);
});

test('roaming mechanic: customers see only a rounded point that follows the phone, never the exact one, and only while fresh',async()=>{
  const f=fixture();await shop(f,'t_mech','mech',{mobile:true,roam:true},1);
  const here={lat:13.80123,lng:100.55456};
  assert.equal((await f.call(MECH,'/api/tech/here',here)).status,200);
  const t=(await f.call(USER,'/api/tech')).techs[0];
  assert.equal(t.roam,true);assert.ok(t.live,'live point is shown');
  assert.notEqual(t.live.lat,here.lat);assert.notEqual(t.live.lng,here.lng);
  assert.ok(Math.abs(t.live.lat-here.lat)<0.0025&&Math.abs(t.live.lng-here.lng)<0.0025,'still the right neighbourhood (~280 m)');
  assert.equal(t.lat,13.75,'the registered base point is unchanged (shop editing never sees the phone point)');
  assert.ok(!JSON.stringify(t).includes('13.80123'),'exact point never leaves the server');
  const lv=(await f.call('', '/api/tech/live')).live;
  assert.deepEqual(lv,[{id:'t_mech',lat:t.live.lat,lng:t.live.lng,at:t.live.at}],'the light live feed is public but rounded the same way');
  /* เปิดดูซ้ำได้จุดเดิม (ไม่สุ่ม) */
  assert.deepEqual((await f.call(USER,'/api/tech')).techs[0].live,t.live);
  /* ไม่ได้อัปเดตเกิน 10 นาที = ไม่แสดง */
  f.sqlite.prepare('UPDATE tech_profiles SET live_at=?').run(Date.now()-11*60*1000);
  assert.equal((await f.call(USER,'/api/tech')).techs[0].live,null);
  assert.deepEqual((await f.call('', '/api/tech/live')).live,[]);
});

test('roaming mechanic: going offline, pausing the shop or leaving roaming mode deletes the phone position at once',async()=>{
  const f=fixture();await shop(f,'t_mech','mech',{mobile:true,roam:true},1);
  const live=()=>f.sqlite.prepare('SELECT live_lat,live_lng,live_at FROM tech_profiles').get();
  const send=async()=>{f.sqlite.prepare('UPDATE tech_profiles SET live_at=NULL').run();assert.equal((await f.call(MECH,'/api/tech/here',{lat:13.8,lng:100.55})).status,200);assert.ok(live().live_lat);};
  await send();
  assert.equal((await f.call(MECH,'/api/tech/online',{online:false})).status,200);
  assert.deepEqual({...live()},{live_lat:null,live_lng:null,live_at:null},'offline');
  await f.call(MECH,'/api/tech/online',{online:true});await send();
  assert.equal((await f.call(MECH,'/api/tech/shop',{vacation:{on:true}})).status,200);
  assert.deepEqual({...live()},{live_lat:null,live_lng:null,live_at:null},'paused');
  assert.equal((await f.call(MECH,'/api/tech/here',{lat:13.8,lng:100.55})).status,409,'a paused shop cannot share');
  await f.call(MECH,'/api/tech/shop',{vacation:{on:false}});await send();
  assert.equal((await f.call(MECH,'/api/tech/shop',{roam:false})).status,200);
  assert.deepEqual({...live()},{live_lat:null,live_lng:null,live_at:null},'roaming off');
});

test('roaming mechanic: urgent posts and "find work" measure from where the mechanic is now, not the registered base',async()=>{
  const {f,call,pushes}=lineSetup();
  /* จุดลงทะเบียนอยู่เชียงใหม่ แต่ตอนนี้ช่างขับอยู่กรุงเทพ */
  await shop(f,'t_mech','mech',{lat:18.79,lng:98.98,mobile:true,roam:true},1);
  assert.equal((await call(USER,'/api/tech/posts',post({urgent:true}))).reach,0,'far from the base, no live point yet');
  assert.equal((await call(MECH,'/api/tech/here',{lat:13.77,lng:100.52})).status,200);
  const r=await call(USER,'/api/tech/posts',post({urgent:true,symptom:'ยางแตก'}));
  assert.equal(r.reach,1);assert.equal(r.taking,1);
  assert.match(JSON.stringify(pushes.at(-1).messages),/ห่างจากคุณตอนนี้ประมาณ 2 กม\./);
  const near=await call(MECH,'/api/tech/posts/near');
  assert.equal(near.posts.length,2,'both Bangkok posts are near the mechanic now');assert.equal(near.live,true);
  assert.deepEqual(near.center,{lat:13.77,lng:100.52},'own position comes back to the mechanic only');
});

test('closing the account deletes the roaming phone position together with the shop identity',async()=>{
  const f=fixture();await shop(f,'t_mech','mech',{mobile:true,roam:true},1);
  assert.equal((await f.call(MECH,'/api/tech/here',{lat:13.8,lng:100.55})).status,200);
  f.sqlite.exec("INSERT OR IGNORE INTO users(uid,role,banned) VALUES ('mech','user',0)");
  await deleteAccount(f.env,'mech');
  const row=f.sqlite.prepare('SELECT live_lat,live_lng,live_at,online FROM tech_profiles WHERE id=?').get('t_mech');
  assert.deepEqual({...row},{live_lat:null,live_lng:null,live_at:null,online:0});
  assert.equal((await f.call(ADMIN,'/api/tech/live')).live.length,0);
});
