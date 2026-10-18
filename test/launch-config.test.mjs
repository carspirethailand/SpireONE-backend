/* นับถอยหลังเปิดตัว: เจ้าของระบบตั้งได้คนเดียว · ทุกคน (แม้ไม่ล็อกอิน) อ่านได้จาก /api/config */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
let seq=0;
async function fixture(){
  const worker=(await import('../src/worker.js?launch='+(++seq))).default;
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);INSERT INTO config VALUES('schema_version','19');
    CREATE TABLE users(uid TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,photo TEXT,role TEXT DEFAULT 'user',last_login INTEGER NOT NULL,created_at INTEGER,banned INTEGER DEFAULT 0);`);
  const env={DEV_AUTH:'1',FIREBASE_PROJECT_ID:'unit-test',ALLOWED_ORIGINS:'*',OWNERS:'boss@unit.test',DB:{prepare(sql){let args=[];return{
    bind(...v){args=v;return this},async first(){return db.prepare(sql).get(...args)||null},async all(){return {results:db.prepare(sql).all(...args)}},
    async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}}},_run(){return db.prepare(sql).run(...args)}
  }},async batch(list){db.exec('BEGIN');try{const r=list.map(x=>x._run());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}}};
  const call=async(method,path,body,uid)=>{
    const r=await worker.fetch(new Request('https://unit.test'+path,{method,headers:{'Content-Type':'application/json',...(uid?{Authorization:`Bearer dev:${uid}:${uid}@unit.test`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{waitUntil(){}});
    return {status:r.status,json:await r.json()};
  };
  await call('GET','/api/config');
  const t=Date.now();db.prepare('INSERT INTO users(uid,name,email,role,last_login,created_at) VALUES(?,?,?,?,?,?)').run('admin','admin','admin@unit.test','admin',t,t);
  return {db,call};
}

test('launch countdown: off by default, public to read, only owners can set it, time must be sane',async()=>{
  const f=await fixture();
  const c0=await f.call('GET','/api/config');assert.equal(c0.status,200);assert.deepEqual(c0.json.launch,{enabled:false,at:0,title:'',message:'',join:true});
  assert.ok(Math.abs(c0.json.now-Date.now())<5000,'server time so the countdown is not fooled by a wrong phone clock');
  const at=Date.now()+3*86400000;
  assert.equal((await f.call('POST','/api/admin/config',{launch:{enabled:true,at}},'admin')).status,403,'admin is not enough');
  assert.equal((await f.call('POST','/api/admin/config',{launch:{enabled:true,at}})).status,401);
  assert.equal((await f.call('POST','/api/admin/config',{launch:{enabled:true,at:Date.now()-3600000}},'boss')).status,400,'past time');
  assert.equal((await f.call('POST','/api/admin/config',{launch:{enabled:true,at:'soon'}},'boss')).status,400);
  const ok=await f.call('POST','/api/admin/config',{launch:{enabled:true,at,title:'Cendon มาแล้ว'.repeat(20),message:'เตรียมพบกัน',join:false}},'boss');
  assert.equal(ok.status,200);
  const l=(await f.call('GET','/api/config')).json.launch;
  assert.equal(l.enabled,true);assert.equal(l.at,at);assert.equal(l.title.length,80);assert.equal(l.message,'เตรียมพบกัน');assert.equal(l.join,false);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='config.launch'").get().n,1);
  /* ปิดได้โดยไม่ต้องใส่เวลา */
  assert.equal((await f.call('POST','/api/admin/config',{launch:{enabled:false}},'boss')).status,200);
  assert.equal((await f.call('GET','/api/config')).json.launch.enabled,false);
});
