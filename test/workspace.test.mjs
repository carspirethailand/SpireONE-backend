import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';

/* ที่ทำงานของทีมงาน (/api/ws) แยกจากคลังความรู้ AI (/api/kb) */
let seq=0;
async function fixture(){
  const worker=(await import(`../src/worker.js?workspace=${++seq}`)).default;
  const sqlite=new DatabaseSync(':memory:');
  const t=Date.now();
  sqlite.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);INSERT INTO config VALUES ('schema_version','22');
    CREATE TABLE users(uid TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,photo TEXT,role TEXT DEFAULT 'user',last_login INTEGER NOT NULL,created_at INTEGER,banned INTEGER DEFAULT 0);
    CREATE TABLE kb (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '', make TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
  const kb=(id,make,enabled=0)=>sqlite.prepare('INSERT INTO kb (id,title,body,make,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id,'t '+id,'body of '+id,make,enabled,t,t);
  kb('kb_real','honda',1);kb('pos_mod','__pos__');kb('msg_1','__chat__');kb('hb_01','__handbook__');kb('kb_stray','__handbook__');kb('nda_mod','__nda__');
  for(const [uid,role] of [['mod','moderator'],['ai','moderator'],['adm','admin'],['user','user']])
    sqlite.prepare('INSERT INTO users (uid,name,email,role,last_login,created_at) VALUES (?,?,?,?,?,?)').run(uid,uid,uid+'@unit.test',role,t,t);
  let queue=Promise.resolve();const op=fn=>{const p=queue.then(fn);queue=p.catch(()=>{});return p;};
  const DB={prepare(sql){let args=[];const s={bind(...v){args=v;return this;},first:()=>op(()=>sqlite.prepare(sql).get(...args)||null),all:()=>op(()=>({results:sqlite.prepare(sql).all(...args)})),run:()=>op(()=>s._run()),_run(){const o=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(o.changes)}};}};return s;},
    batch(list){return op(()=>{sqlite.exec('BEGIN');try{const r=list.map(s=>s._run());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}});}};
  const env={DB,DEV_AUTH:'1',FIREBASE_PROJECT_ID:'cendon-unit-test',OWNERS:'owner@unit.test',ALLOWED_ORIGINS:'*'};
  const call=async(method,path,body,uid)=>{
    const r=await worker.fetch(new Request('https://w.unit.test'+path,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer dev:${uid}:${uid}@unit.test`},...(body?{body:JSON.stringify(body)}:{})}),env,{waitUntil(){}});
    return {status:r.status,json:await r.json().catch(()=>null)};
  };
  return {sqlite,call};
}
const note=(id,extra={})=>({id,title:'note '+id,body:'workspace body text',make:'__chat__',...extra});

test('ws: ของที่ทำงานเดิมใน kb ย้ายออกครั้งเดียว ความรู้ AI จริงอยู่ที่เดิม',async()=>{
  const f=await fixture();
  const ws=await f.call('GET','/api/ws',null,'mod');
  assert.equal(ws.status,200);
  assert.deepEqual(ws.json.kb.map(r=>r.id).sort(),['hb_01','kb_stray','msg_1','nda_mod','pos_mod']);
  assert.ok(ws.json.kb.every(r=>r.enabled===0),'ของที่ทำงานต้องปิดไว้ AI ไม่หยิบไปตอบ');
  assert.deepEqual(f.sqlite.prepare('SELECT id FROM kb').all().map(r=>r.id),['kb_real']);
  assert.equal((await f.call('GET','/api/ws',null,'user')).status,403,'ผู้ใช้ทั่วไปเข้าไม่ได้');
  assert.deepEqual((await f.call('GET','/api/ws?prefix=hb_',null,'mod')).json.kb.map(r=>r.id),['hb_01']);
});

test('ws: ผู้ควบคุมคุย/ประชุมได้ แต่ตั้งตำแหน่ง แก้คู่มือ หรือลงชื่อแทนคนอื่นไม่ได้',async()=>{
  const f=await fixture();
  assert.equal((await f.call('POST','/api/ws',note('msg_2'),'mod')).status,200);
  assert.equal((await f.call('POST','/api/ws',note('sig_adm_mod_1',{keywords:JSON.stringify({k:'ice',r:'team',to:'adm'})}),'mod')).status,200);
  assert.equal((await f.call('POST','/api/ws',note('nda_mod'),'mod')).status,200,'ลงชื่อของตัวเองได้');
  assert.equal((await f.call('POST','/api/ws',note('nda_adm'),'mod')).status,403,'ลงชื่อแทนคนอื่นไม่ได้');
  assert.equal((await f.call('POST','/api/ws',note('vc_room__adm'),'mod')).status,403);
  assert.equal((await f.call('POST','/api/ws',note('vc_team__mod',{keywords:'{"r":"team","u":"mod"}'}),'mod')).status,200);
  assert.equal((await f.call('POST','/api/ws',note('pos_mod',{keywords:'{"p":"head_ai"}'}),'mod')).status,403,'ตั้งตำแหน่งตัวเองไม่ได้');
  assert.equal((await f.call('POST','/api/ws',note('hb_02'),'mod')).status,403);
  assert.equal((await f.call('POST','/api/ws',note('kb_x'),'adm')).status,403,'รหัสต้องเป็นชนิดของที่ทำงานเท่านั้น');
  assert.equal((await f.call('DELETE','/api/ws/pos_mod',null,'mod')).status,403);
  assert.equal((await f.call('DELETE','/api/ws/msg_2',null,'mod')).status,200);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM kb WHERE id LIKE 'msg_%' OR id LIKE 'sig_%'").get().n,0,'ไม่มีอะไรเข้าคลังความรู้ AI');
});

test('ws: server isolates private DMs, departments, invited rooms and signaling, not just the UI',async()=>{
  const f=await fixture(),save=(id,m,uid='adm')=>f.call('POST','/api/ws',note(id,{keywords:JSON.stringify(m)}),uid);
  assert.equal((await save('msg_secret',{r:'dm:adm|ai',u:'adm'})).status,200);
  assert.equal((await save('msg_department',{r:'dept:ops',u:'adm'})).status,200);
  assert.equal((await save('ch_private',{m:['adm','ai'],by:'adm'})).status,200);
  assert.equal((await save('msg_invited',{r:'ch:private',u:'adm'})).status,200);
  assert.equal((await save('sig_ai_adm_nonce',{r:'team',k:'offer',from:'adm',to:'ai'})).status,200);
  for(const uid of ['mod','ai','adm']){
    const r=await f.call('GET','/api/ws',null,uid),ids=r.json.kb.map(x=>x.id);
    for(const id of ['msg_secret','msg_invited','sig_ai_adm_nonce'])assert.equal(ids.includes(id),uid!=='mod',uid+' '+id);
    assert.equal(ids.includes('msg_department'),uid==='adm');
  }
  for(const id of ['msg_secret','msg_invited','msg_department']){
    assert.equal((await save(id,{r:'team',u:'mod'},'mod')).status,403);
    assert.equal((await f.call('DELETE','/api/ws/'+id,null,'mod')).status,403);
  }
  assert.equal((await save('msg_forged',{r:'team',u:'adm'},'mod')).status,403);
  assert.equal((await save('sig_ai_adm_forged',{k:'offer',r:'team',to:'ai'},'mod')).status,403);
  assert.equal((await save('msg_public',{r:'team',u:'mod',n:'Administrator'},'mod')).status,200);
  assert.equal(JSON.parse(f.sqlite.prepare("SELECT keywords FROM ws_store WHERE id='msg_public'").get().keywords).n,'mod');
  assert.equal((await save('msg_public',{r:'team',u:'ai'},'ai')).status,403,'another staff member cannot overwrite a message');
});

test('ws: meeting metadata cannot carry executable links and RSVP cannot impersonate someone else',async()=>{
  const f=await fixture(),m={r:'team',t:Date.now()+60000,len:30,by:'adm',lk:'https://meet.example/room',at:['adm']};
  const save=(meta,uid='adm')=>f.call('POST','/api/ws',note('mt_test',{keywords:JSON.stringify(meta)}),uid);
  assert.equal((await save({...m,lk:'javascript:alert(1)'})).status,400);
  assert.equal((await save(m)).status,200);
  assert.equal((await save({...m,at:['adm','ai']},'mod')).status,403);
  assert.equal((await save({...m,at:['adm','mod']},'mod')).status,200);
  assert.equal((await save({...m,r:'dept:exec'},'mod')).status,403);
  assert.equal((await f.call('POST','/api/ws',note('msg_broken',{keywords:'{"r":"dm:adm|ai"'}),'mod')).status,400,'invalid private metadata never falls back to public');
});

test('kb: แก้ความรู้ AI ได้เฉพาะแอดมิน หรือผู้ควบคุมที่แอดมินตั้งเป็นหัวหน้าฝ่าย AI',async()=>{
  const f=await fixture();
  const k={title:'Oil change Civic',body:'Use 0W-20 every 10,000 km for this engine.',make:'honda'};
  assert.equal((await f.call('POST','/api/kb',k,'mod')).status,403);
  assert.equal((await f.call('POST','/api/kb/bulk',{items:[k]},'mod')).status,403);
  assert.equal((await f.call('DELETE','/api/kb/kb_real',null,'mod')).status,403);
  assert.equal((await f.call('GET','/api/kb',null,'mod')).status,200,'ยังอ่านได้');
  assert.equal((await f.call('POST','/api/kb',k,'adm')).status,200);
  assert.equal((await f.call('POST','/api/ws',note('pos_ai',{keywords:'{"p":"head_ai","d":"ai"}'}),'adm')).status,200);
  assert.equal((await f.call('POST','/api/kb',k,'ai')).status,200,'หัวหน้าฝ่าย AI สอน AI ได้');
  assert.equal((await f.call('DELETE','/api/kb/kb_real',null,'ai')).status,200);
});
