/* ความเร็วฝั่งเซิร์ฟเวอร์: ทุกคำสั่งที่ไปฐานข้อมูล D1 คือการเดินทางไปกลับหนึ่งรอบ
   วัดจริง: worker ที่สหรัฐฯ → D1 ฝั่งเอเชีย คำสั่งละ ~0.3 วิ — หน้าแอปช้าทุกหน้า */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

test('worker runs near the D1 database (Asia), never smart placement or the US',()=>{
  const cfg=readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8').replace(/^\s*\/\/.*$/mg,'');
  const placement=JSON.parse(cfg).placement;
  assert.deepEqual(placement,{region:'gcp:asia-southeast1'},'Singapore: next to D1 and Thai users, Gemini supported there');
});

test('/api/config reads every setting in one query, then serves from memory',async()=>{
  const worker=(await import('../src/worker.js?rt=1')).default;
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);INSERT INTO config VALUES('schema_version','9999');
    INSERT INTO config VALUES('announcement','{"enabled":true,"text":"hi","type":"info"}');INSERT INTO config VALUES('launch','not json');`);
  const seen=[];
  const env={ALLOWED_ORIGINS:'*',FIREBASE_PROJECT_ID:'unit-test',DB:{prepare(sql){seen.push(sql);let args=[];return{bind(...v){args=v;return this},
    async first(){return db.prepare(sql).get(...args)||null},async all(){return {results:db.prepare(sql).all(...args)}},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}}}}}}};
  const get=async()=>(await worker.fetch(new Request('https://unit.test/api/config'),env,{waitUntil(){}})).json();
  const a=await get();
  assert.equal(seen.filter(s=>/FROM config WHERE key IN/.test(s)).length,1);
  assert.equal(seen.filter(s=>/FROM config WHERE key = \?/.test(s)).length,0,'no per-key round trips');
  assert.deepEqual(a.announcement,{enabled:true,text:'hi',type:'info'});
  assert.deepEqual(a.maintenance,{enabled:false,message:''});
  assert.deepEqual(a.launch,{enabled:false,at:0,title:'',message:'',join:true},'unreadable value falls back to the default');
  assert.equal(a.limits.aiDaily,60);
  const before=seen.length;await get();
  assert.equal(seen.length,before,'second read within 15 s needs no database trip');
});
