/* Studio งานด่วน: ถึงมือช่างเร็ว — แจ้งเตือนแบบเร่งด่วน และด่านตรวจก่อนบันทึกไม่ต่อคิวกันทีละด่าน */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deflateSync} from 'node:zlib';
import {fixture,USER} from './tech-fixtures.mjs';
import {withMechanic,post} from './tech-safety.test.mjs';

const urgentJob=(over={})=>({id:crypto.randomUUID(),techId:'t_mech',car:'Toyota Vios 2018',symptom:'แบตหมด',area:'บางนา กรุงเทพ',
  address:'ริมถนนบางนา-ตราด กม.3',phone:'0812345678',requestedTime:'ด่วน — ตอนนี้',mode:'mobile',urgent:true,lat:13.76,lng:100.51,...over});
/* แผ่นแผนที่ทดสอบ: น้ำทั้งแผ่น (#aad3df) */
function waterTile(){
  const crc=b=>{let c=0xffffffff;for(const n of b){c^=n;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
  const chunk=(k,d)=>{const t=Buffer.from(k),b=Buffer.alloc(d.length+12);b.writeUInt32BE(d.length);t.copy(b,4);d.copy(b,8);b.writeUInt32BE(crc(Buffer.concat([t,d])),b.length-4);return b;};
  const head=Buffer.alloc(13);head.writeUInt32BE(256);head.writeUInt32BE(256,4);head[8]=8;head[9]=2;
  const raw=Buffer.alloc((256*3+1)*256);for(let y=0;y<256;y++)for(let x=0;x<256;x++)raw.set([170,211,223],y*769+1+x*3);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const settle=async(ok,n=40)=>{for(let i=0;i<n&&!ok();i++)await new Promise(z=>setTimeout(z,5));};

test('studio: job alerts ask the phone to deliver now (high urgency), so a sleeping phone does not hold them back',async()=>{
  const f=fixture();await withMechanic(f);const sent=[];
  f.env.pushTo=async(uid,p,o)=>{sent.push({uid,o})};delete f.env.LINE_CHANNEL_TOKEN;
  assert.equal((await f.call(USER,'/api/tech/jobs',urgentJob())).status,200);
  await settle(()=>sent.length);
  assert.deepEqual(sent,[{uid:'mech',o:{urgency:'high'}}]);
  /* ตัวส่งจริง: ตัวเลือกนี้กลายเป็นหัว Urgency ของ Web Push · การเตือนอื่น (ต่อภาษี) ยังเป็น normal */
  const src=readFileSync(new URL('../src/worker.js',import.meta.url),'utf8');
  assert.match(src,/'Urgency': urgency === 'high' \? 'high' : 'normal'/);
  assert.match(src,/env\.pushTo = \(uid, p, o\) => pushToUid\(env, uid, p, false, o && o\.urgency\)/);
  assert.match(src,/async function sendPush\(env, sub, payloadObj, ttl = 86400, urgency = 'normal'\)/);
});

test('studio: an urgent post alerts every shop taking jobs with high urgency',async()=>{
  const f=fixture();await withMechanic(f);f.sqlite.prepare('UPDATE tech_profiles SET online=1').run();const sent=[];
  f.env.pushTo=async(uid,p,o)=>{sent.push({uid,o})};delete f.env.LINE_CHANNEL_TOKEN;
  const r=await f.call(USER,'/api/tech/posts',post({urgent:true,symptom:'งานด่วน: แบตหมด'}));assert.equal(r.status,200,r.error);
  assert.equal(r.taking,1);await settle(()=>sent.length);
  assert.deepEqual(sent,[{uid:'mech',o:{urgency:'high'}}]);
});

test('studio: the slow map check (pin in water) runs alongside the database checks, not before them',async()=>{
  const f=fixture({PIN_WATER_OFF:''});await withMechanic(f);
  const order=[];let release;
  const real=f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare=sql=>{if(/FROM cust_strikes|FROM tech_jobs WHERE customer_uid = \? AND created_at|FROM tech_jobs WHERE group_id/.test(sql))order.push('db');return real(sql);};
  globalThis.fetch=async url=>{order.push('map');await new Promise(z=>{release=z;});return new Response('',{status:404});};
  const pending=f.call(USER,'/api/tech/jobs',urgentJob({group:crypto.randomUUID()}));
  await settle(()=>release&&order.filter(x=>x==='db').length===3);
  assert.equal(order.filter(x=>x==='db').length,3,'strike, daily limit and group checks start while the map is still loading');
  release();assert.equal((await pending).status,200);
});

test('studio: refusals keep the same order as before when several checks fail at once',async()=>{
  /* ร้านปิดชั่วคราว + ลูกค้าถูกจำกัดการเรียกช่าง → ข้อความจำกัดการเรียกช่างขึ้นก่อน เหมือนตอนตรวจทีละด่าน */
  const f=fixture();await withMechanic(f,{vacation:{on:true,note:''}});
  await f.call(USER,'/api/tech/posts');
  for(let i=0;i<3;i++)f.sqlite.prepare('INSERT INTO cust_strikes (uid,job_id,at) VALUES (?,?,?)').run('applicant','j'+i,Date.now());
  const a=await f.call(USER,'/api/tech/jobs',urgentJob());assert.equal(a.status,403);assert.match(a.error,/จำกัดการเรียกช่าง/);
  f.sqlite.prepare('DELETE FROM cust_strikes').run();
  const b=await f.call(USER,'/api/tech/jobs',urgentJob());assert.equal(b.status,409);assert.match(b.error,/ปิดชั่วคราว/);
  /* ประกาศ: หมุดในน้ำแจ้งก่อนจำนวนประกาศที่เปิดอยู่ครบ */
  const g=fixture({PIN_WATER_OFF:''});await withMechanic(g);const tile=waterTile();
  globalThis.fetch=async url=>String(url).includes('tile.openstreetmap.org')?new Response(tile,{headers:{'content-type':'image/png'}}):Response.json({});
  for(let i=0;i<3;i++)g.sqlite.prepare("INSERT INTO tech_posts (id,customer_uid,status,test,car,symptom,cat,lat,lng,area,address,phone,requested_time,mode,urgent,created_at,updated_at) VALUES (?,?,'open',0,'x','y','eng',13.7,100.5,'a','b','0812345678','c','mobile',0,?,?)").run('p'+i,'applicant',Date.now(),Date.now());
  const w=await g.call(USER,'/api/tech/posts',post());assert.equal(w.status,400);assert.match(w.error,/หมุดอยู่ในน้ำ/);
  globalThis.fetch=async()=>new Response('',{status:404});
  const full=await g.call(USER,'/api/tech/posts',post());assert.equal(full.status,429);
});

test('studio: "my posts" counts offers for every post in one query, with the same numbers as before',async()=>{
  const f=fixture();await withMechanic(f);
  const ids=[];for(let i=0;i<3;i++){const p=post({symptom:'สตาร์ทไม่ติด มีเสียงแก๊ก ๆ '+i});ids.push(p.id);assert.equal((await f.call(USER,'/api/tech/posts',p)).status,200);}
  const q=(id,s,total)=>f.sqlite.prepare("INSERT INTO tech_jobs (id,tech_id,customer_uid,status,test,car,symptom,area,address,phone,requested_time,mode,quote,history,revision,created_at,updated_at,group_id) VALUES (?,?,'applicant',?,0,'x','y','a','b','0812345678','c','shop',?,'[]',1,1,1,?)").run(crypto.randomUUID(),'t_mech',s,total==null?null:JSON.stringify({total}),id);
  q(ids[0],'quoted',1500);q(ids[0],'quoted',900);q(ids[0],'cancelled',100);q(ids[1],'requested',null);
  let n=0;const real=f.env.DB.prepare.bind(f.env.DB);f.env.DB.prepare=sql=>{if(/FROM tech_jobs/.test(sql))n++;return real(sql);};
  const by=Object.fromEntries((await f.call(USER,'/api/tech/posts')).posts.map(p=>[p.id,p]));
  assert.equal(n,1,'one query for all posts, not one per post');
  assert.deepEqual([by[ids[0]].offers,by[ids[0]].lowest],[2,900],'cancelled offers do not count');
  assert.deepEqual([by[ids[1]].offers,by[ids[1]].lowest],[1,null]);
  assert.deepEqual([by[ids[2]].offers,by[ids[2]].lowest],[0,null]);
});
