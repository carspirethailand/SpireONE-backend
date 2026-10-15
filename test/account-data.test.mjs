import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {TABLES,SHARED_TABLES} from '../src/account-data.js';

/* PDPA: ดาวน์โหลดข้อมูลของฉัน / ลบบัญชีถาวร ผ่าน Worker จริง (ฐานข้อมูล SQLite ในหน่วยความจำ) */
let seq=0;
async function fixture(){
  const worker=(await import(`../src/worker.js?accountData=${++seq}`)).default;
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);INSERT INTO config VALUES ('schema_version','19');
    CREATE TABLE users(uid TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,photo TEXT,role TEXT DEFAULT 'user',last_login INTEGER NOT NULL,created_at INTEGER,banned INTEGER DEFAULT 0);
    CREATE TABLE user_state(uid TEXT NOT NULL,k TEXT NOT NULL,v TEXT NOT NULL,t INTEGER NOT NULL,PRIMARY KEY(uid,k));`);
  let queue=Promise.resolve();
  const op=fn=>{const p=queue.then(fn);queue=p.catch(()=>{});return p;};
  const DB={prepare(sql){let args=[];const s={bind(...v){args=v;return this;},first:()=>op(()=>sqlite.prepare(sql).get(...args)||null),all:()=>op(()=>({results:sqlite.prepare(sql).all(...args)})),run:()=>op(()=>s._run()),_run(){const o=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(o.changes)}};}};return s;},
    batch(list){return op(()=>{sqlite.exec('BEGIN');try{const r=list.map(s=>s._run());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}});}};
  const env={DB,DEV_AUTH:'1',FIREBASE_PROJECT_ID:'cendon-unit-test',OWNERS:'owner@unit.test',ALLOWED_ORIGINS:'*'};
  const call=async(method,path,body,uid='me')=>{
    const headers={'Content-Type':'application/json',...(uid?{Authorization:`Bearer dev:${uid}:${uid}@unit.test`}:{})};
    const r=await worker.fetch(new Request('https://w.unit.test'+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{waitUntil(){}});
    const text=await r.text();let json;try{json=JSON.parse(text)}catch{json=null}
    return {status:r.status,json,headers:r.headers};
  };
  await call('GET','/api/config',undefined,null);   // สร้างตารางหลัก
  await call('GET','/api/tech',undefined,null);     // สร้างตารางระบบช่าง + ไฟล์แนบ
  return {sqlite,env,call};
}

function seed(db,uid,{shop=false,suspended=0}={}){
  const t=Date.now(),q=(sql,...a)=>db.prepare(sql).run(...a);
  q('INSERT INTO users (uid,name,email,role,last_login,created_at,banned) VALUES (?,?,?,?,?,?,0)',uid,'Name '+uid,uid+'@unit.test','user',t,t);
  q('INSERT INTO user_state VALUES (?,?,?,?)',uid,'chat','{"m":["hi"]}',t);
  q("INSERT INTO cars (id,uid,make,model,created_at) VALUES (?,?,'Honda','Civic',?)",'car-'+uid,uid,t);
  q("INSERT INTO odo_anchor (id,uid,car_id,km,source,observed_at,t) VALUES (?,?,?,1000,'manual',?,?)",'a-'+uid,uid,'car-'+uid,t,t);
  q("INSERT INTO maint_item (id,uid,car_id,part,t) VALUES (?,?,?,'oil',?)",'mi-'+uid,uid,'car-'+uid,t);
  q("INSERT INTO notify_state (car_id,uid) VALUES (?,?)",'car-'+uid,uid);
  q("INSERT INTO obd_device (device_id,uid,car_id,secret,t) VALUES (?,?,?,'top-secret',?)",'obd-'+uid,uid,'car-'+uid,t);
  q("INSERT INTO push_subs (endpoint,uid,p256dh,auth,t) VALUES (?,?,'pk','ak',?)",'https://push/'+uid,uid,t);
  q("INSERT INTO feedback (id,uid,message,created_at) VALUES (?,?,'great',?)",'fb-'+uid,uid,t);
  q("INSERT INTO line_link (line_uid,uid,linked_at) VALUES (?,?,?)",'U-'+uid,uid,t);
  q("INSERT INTO line_chat (line_uid,history,updated_at) VALUES (?,'[\"hello\"]',?)",'U-'+uid,t);
  q("INSERT INTO line_link_token (hash,line_uid,expires_at) VALUES (?,?,?)",'h-'+uid,'U-'+uid,t+1e6);
  q("INSERT INTO media (id,uid,scope,kind,mime,size,parts,store,created_at) VALUES (?,?,'ai','image','image/png',3,1,'d1',?)",'m_ai_'+uid+'xxxx',uid,t);
  q("INSERT INTO media_parts (id,n,data) VALUES (?,0,'AAAA')",'m_ai_'+uid+'xxxx');
  q("INSERT INTO media (id,uid,scope,kind,mime,size,parts,store,created_at) VALUES (?,?,'thread:x','image','image/png',3,1,'d1',?)",'m_th_'+uid+'xxxx',uid,t);
  q("INSERT INTO skills (id,uid,name,slug,body,created_at,updated_at) VALUES (?,?,'s','s',?, ?,?)",'sk-'+uid,uid,'b',t,t);
  q("INSERT INTO car_spec_reports (k,note,who,at) VALUES ('honda|civic|2020','x',?,?)",'u:'+uid,t);
  q("INSERT INTO tech_posts (id,customer_uid,car,symptom,lat,lng,area,address,phone,requested_time,mode,created_at,updated_at) VALUES (?,?,'c','s',13,100,'a','addr','0811111111','now','home',?,?)",'post-'+uid,uid,t,t);
  if(shop){
    q("INSERT INTO tech_profiles (id,uid,phone,data,verified,suspended,created_at,updated_at) VALUES (?,?,'0899999999','{\"name\":\"Real Name\",\"shop\":\"My Shop\"}',1,?,?,?)",'tp-'+uid,uid,suspended,t,t);
    q("INSERT INTO tech_applications (uid,email,data,created_at,updated_at,id_hash) VALUES (?,?,'{}',?,?,'h2:abc')",uid,uid+'@unit.test',t,t);
    q("INSERT INTO tech_identity_claims (id_hash,uid) VALUES (?,?)",'h2:claim-'+uid,uid);
    q("INSERT INTO tech_docs (uid,kind,mime,data,created_at) VALUES (?,'shop','image/png','BASE64',?)",uid,t);
    q("INSERT INTO tech_gigs (uid,tech_id,kind,title,created_at,updated_at) VALUES (?,?,'package','Oil',?,?)",uid,'tp-'+uid,t,t);
  }
}
/* ตารางที่สร้างตอนใช้งานครั้งแรก (เช่น ai_events) อาจยังไม่มี = ไม่มีข้อมูล */
const count=(db,sql,...a)=>{try{return db.prepare(sql).get(...a).n}catch(e){if(/no such table/.test(e.message))return 0;throw e}};

test('PDPA: ทุกตารางในโค้ดต้องถูกจัดกลุ่ม (ข้อมูลรายคน หรือ ใช้ร่วมกัน) — เพิ่มตารางใหม่แล้วลืมใส่ = ฟ้อง',()=>{
  const names=new Set();
  for(const f of readdirSync(new URL('../src/',import.meta.url))){
    if(!/\.(m?js)$/.test(f))continue;
    for(const m of readFileSync(new URL('../src/'+f,import.meta.url),'utf8').matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g))names.add(m[1]);
  }
  const known=new Set([...TABLES.map(t=>t[0]),...SHARED_TABLES]);
  const missing=[...names].filter(n=>!known.has(n));
  assert.deepEqual(missing,[],'ตารางที่ยังไม่ได้บอกว่าเป็นข้อมูลของใคร: '+missing.join(', '));
  assert.ok(names.size>40);
});

test('PDPA: ดาวน์โหลดข้อมูลของฉันได้เฉพาะของตัวเอง และไม่มีความลับของระบบ',async()=>{
  const f=await fixture();seed(f.sqlite,'me',{shop:true});seed(f.sqlite,'other');
  assert.equal((await f.call('GET','/api/account/export',undefined,null)).status,401);
  const r=await f.call('GET','/api/account/export');
  assert.equal(r.status,200);
  assert.match(r.headers.get('Content-Disposition')||'',/attachment; filename="cendon-data-/);
  assert.equal(r.headers.get('Cache-Control'),'private, no-store');
  const d=r.json.data,raw=JSON.stringify(r.json);
  assert.equal(r.json.format,'cendon-account-export');
  for(const t of ['users','user_state','cars','odo_anchor','maint_item','notify_state','obd_device','push_subs','feedback','line_link','line_chat','media','skills','tech_profiles','tech_applications','tech_docs','tech_gigs','tech_posts','car_spec_reports'])
    assert.ok(d[t]&&d[t].length,'ต้องมีตาราง '+t);
  assert.deepEqual(d.user_state[0].v,{m:['hi']},'ค่า JSON แปลงกลับให้อ่านง่าย');
  assert.ok(!raw.includes('other@unit.test')&&!raw.includes('U-other'),'ไม่มีข้อมูลของคนอื่น');
  for(const secret of ['top-secret','"pk"','"ak"','h2:abc','h2:claim-me','BASE64','https://push/me','h-me'])assert.ok(!raw.includes(secret),'ห้ามส่งออก '+secret);
});

test('PDPA: ลบบัญชีถาวรต้องพิมพ์ยืนยัน และลบครบทุกตาราง โดยไม่แตะบัญชีอื่น',async()=>{
  const f=await fixture();seed(f.sqlite,'me',{shop:true});seed(f.sqlite,'other');
  assert.equal((await f.call('POST','/api/account/delete',{})).status,400);
  assert.equal((await f.call('POST','/api/account/delete',{confirm:'delete'})).status,400);
  assert.equal(count(f.sqlite,"SELECT COUNT(*) n FROM users WHERE uid='me'"),1,'ยังไม่ลบถ้าไม่ยืนยัน');
  const r=await f.call('POST','/api/account/delete',{confirm:'DELETE'});
  assert.equal(r.status,200);assert.equal(r.json.ok,true);assert.equal(r.json.firebaseDeleted,false,'ไม่ได้ตั้งบัญชีบริการ = หน้าเว็บต้องลบ Firebase เอง');
  for(const [table,where] of TABLES){
    if(['tech_profiles','tech_jobs','tech_threads'].includes(table))continue;
    const n=count(f.sqlite,`SELECT COUNT(*) n FROM ${table} WHERE ${where.replace(/\?1/g,"'me'").replace(/\?/g,"'me'")}`);
    assert.equal(n,0,'ยังเหลือข้อมูลใน '+table);
  }
  assert.equal(count(f.sqlite,"SELECT COUNT(*) n FROM media_parts WHERE id LIKE '%me%'"),0,'ไฟล์จริงต้องหายด้วย');
  assert.equal(count(f.sqlite,"SELECT COUNT(*) n FROM tech_profiles WHERE uid='me' OR phone='0899999999' OR data LIKE '%Real Name%'"),0,'โปรไฟล์ร้านไม่เหลือตัวตน');
  assert.equal(count(f.sqlite,"SELECT COUNT(*) n FROM tech_profiles WHERE id='tp-me' AND suspended=1"),1,'ใบงานเก่ายังอ้างถึงร้านได้');
  for(const t of ['users','user_state','cars','line_link','line_chat','media','feedback','tech_posts'])
    assert.ok(count(f.sqlite,`SELECT COUNT(*) n FROM ${t} WHERE ${t==='line_chat'?"line_uid='U-other'":t==='tech_posts'?"customer_uid='other'":"uid='other'"}`)>0,'บัญชีอื่นต้องไม่ถูกลบ: '+t);
  const audit=f.sqlite.prepare("SELECT actor,detail FROM audit WHERE action='account.delete'").get();
  assert.equal(audit.actor,'self');assert.ok(!audit.detail.includes('@'));
  assert.equal(count(f.sqlite,"SELECT COUNT(*) n FROM audit WHERE actor='me@unit.test'"),0,'บันทึกไม่เหลืออีเมลของคนที่ลบ');
});

test('PDPA: งานซ่อมที่ยังค้างต้องจบก่อนลบ · ใบงานที่จบแล้วเก็บให้อีกฝ่ายแต่ตัดตัวตน',async()=>{
  const f=await fixture();seed(f.sqlite,'me');seed(f.sqlite,'tech',{shop:true});
  const t=Date.now(),job=(id,status)=>f.sqlite.prepare(`INSERT INTO tech_jobs (id,tech_id,customer_uid,status,car,symptom,area,address,phone,requested_time,mode,review,history,created_at,updated_at,note)
    VALUES (?,'tp-tech','me',?,'Civic','noise','Bangkok','99 Secret Rd','0812345678','now','home','{"rating":5,"text":"my private words"}','[]',?,?,'gate code 1234')`).run(id,status,t,t);
  job('j-busy','working');job('j-done','completed');job('j-new','requested');
  f.sqlite.prepare("INSERT INTO tech_messages (job_id,uid,role,text,at) VALUES ('j-done','me','customer','call me at 0812345678',?)").run(t);
  f.sqlite.prepare("INSERT INTO tech_messages (job_id,uid,role,text,at) VALUES ('j-done','tech-uid','technician','ok',?)").run(t);
  const blocked=await f.call('POST','/api/account/delete',{confirm:'DELETE'});
  assert.equal(blocked.status,409);assert.equal(blocked.json.error,'active_jobs');assert.deepEqual(blocked.json.jobs,[{id:'j-busy',status:'working'}]);
  assert.equal(count(f.sqlite,"SELECT COUNT(*) n FROM users WHERE uid='me'"),1);
  f.sqlite.prepare("UPDATE tech_jobs SET status='completed' WHERE id='j-busy'").run();
  assert.equal((await f.call('POST','/api/account/delete',{confirm:'DELETE'})).status,200);
  const done=f.sqlite.prepare("SELECT * FROM tech_jobs WHERE id='j-done'").get();
  assert.equal(done.customer_uid,'deleted');assert.equal(done.phone,'');assert.equal(done.address,'');assert.equal(done.note,null);
  assert.deepEqual(JSON.parse(done.review),{rating:5},'คะแนนคงไว้ให้ร้าน ข้อความรีวิวลบ');
  assert.equal(f.sqlite.prepare("SELECT status FROM tech_jobs WHERE id='j-new'").get().status,'cancelled','งานที่ยังไม่มีใครรับ ยกเลิกให้');
  const msgs=f.sqlite.prepare("SELECT uid,text FROM tech_messages WHERE job_id='j-done' ORDER BY id").all();
  assert.deepEqual(msgs.map(m=>({...m})),[{uid:'deleted',text:''},{uid:'tech-uid',text:'ok'}],'ข้อความของเราหาย ข้อความของช่างอยู่');
  assert.equal(count(f.sqlite,"SELECT COUNT(*) n FROM tech_jobs WHERE phone='0812345678' OR address LIKE '%Secret%'"),0);
});

test('PDPA: ร้านที่ทีมงานระงับ — เก็บแฮชเลขบัตรไว้กันสมัครซ้ำ แต่ไม่ผูกกับบัญชีแล้ว',async()=>{
  const f=await fixture();seed(f.sqlite,'me',{shop:true,suspended:1});
  assert.equal((await f.call('POST','/api/account/delete',{confirm:'DELETE'})).status,200);
  const claim=f.sqlite.prepare("SELECT uid FROM tech_identity_claims WHERE id_hash='h2:claim-me'").get();
  assert.ok(claim&&claim.uid!=='me'&&claim.uid.startsWith('deleted:'));
});

test('PDPA: เจ้าของระบบลบบัญชีตัวเองไม่ได้ · รีเซ็ตล้างข้อมูลรถ/ระยะ/ไฟล์แชต AI แต่คงบัญชีและร้าน',async()=>{
  const f=await fixture();
  assert.equal((await f.call('POST','/api/account/delete',{confirm:'DELETE'},'owner')).status,400);
  seed(f.sqlite,'me',{shop:true});
  const r=await f.call('POST','/api/account/reset',{});
  assert.equal(r.status,200);
  assert.ok(Object.values(r.json.removed).every(v=>typeof v==='number'),JSON.stringify(r.json.removed));
  for(const t of ['cars','odo_anchor','maint_item','notify_state','obd_device','user_state','push_subs'])assert.equal(count(f.sqlite,`SELECT COUNT(*) n FROM ${t} WHERE uid='me'`),0,t);
  assert.equal(count(f.sqlite,"SELECT COUNT(*) n FROM line_chat WHERE line_uid='U-me'"),0);
  assert.equal(count(f.sqlite,"SELECT COUNT(*) n FROM media WHERE uid='me' AND scope='ai'"),0);
  assert.equal(count(f.sqlite,"SELECT COUNT(*) n FROM media WHERE uid='me' AND scope='thread:x'"),1,'ไฟล์ที่ส่งให้ช่างแล้วไม่ลบตอนรีเซ็ต');
  for(const t of ['users','line_link','tech_profiles'])assert.equal(count(f.sqlite,`SELECT COUNT(*) n FROM ${t} WHERE uid='me'`),1,t);
});
