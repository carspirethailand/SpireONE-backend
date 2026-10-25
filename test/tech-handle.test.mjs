import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './tech-fixtures.mjs';
import {handleProblem} from '../src/techs.js';

/* สองร้านจริงที่ผ่านการตรวจ + หนึ่งร้านทดลอง */
async function shops(){
  const f=fixture();await f.call('','/api/tech/ping');const at=Date.now();
  const add=(id,uid,o={})=>f.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id,uid,'0899999999',JSON.stringify({name:'ช่าง '+uid,shop:'ร้าน '+uid,cats:['air']}),o.verified??1,o.test??0,o.suspended??0,at,at);
  add('t_aaaaaaaaaaaaaaaa','one');add('t_bbbbbbbbbbbbbbbb','two');add('t_cccccccccccccccc','trial',{verified:0,test:1});
  return f;
}
const ONE='one|one@unit.test',TWO='two|two@unit.test',TRIAL='trial|trial@unit.test',BOSS='boss|boss@unit.test';

test('handle format and reserved names',()=>{
  for(const ok of ['nonair','nonair-bangna','a1b','x'.repeat(30)])assert.equal(handleProblem(ok),null,ok);
  for(const bad of ['ab','x'.repeat(31),'Non','-air','air-','a--b','non_air','นนท์แอร์','t_abc'])assert.equal(handleProblem(bad),'format',bad);
  for(const r of ['studio','admin','toyota','honda','cendon','cendon-official','official-shop','b-quik'])assert.equal(handleProblem(r),'reserved',r);
});

test('an approved shop claims a name; it shows on the public list and resolves; nobody else can take it',async()=>{
  const f=await shops();
  assert.deepEqual(await f.call(ONE,'/api/tech/handle?h=NonAir'),{handle:'nonair',ok:true,reason:null,status:200});
  const r=await f.call(ONE,'/api/tech/handle',{handle:' NonAir '});assert.equal(r.status,200);assert.equal(r.handle,'nonair');
  const list=await f.call('','/api/tech');assert.equal(list.techs.find(t=>t.id==='t_aaaaaaaaaaaaaaaa').handle,'nonair');
  assert.equal(list.techs.find(t=>t.id==='t_bbbbbbbbbbbbbbbb').handle,'');
  const res=await f.call('','/api/tech/handle/nonair');assert.deepEqual([res.status,res.techId,res.current],[200,'t_aaaaaaaaaaaaaaaa',true]);
  assert.equal((await f.call(TWO,'/api/tech/handle?h=nonair')).reason,'taken');
  const steal=await f.call(TWO,'/api/tech/handle',{handle:'nonair'});assert.equal(steal.status,409);assert.match(steal.error,/ร้านอื่นใช้แล้ว/);
  assert.equal((await f.call(ONE,'/api/tech/handle?h=nonair')).reason,'current');
});

test('trial, unapproved and paused shops cannot claim; reserved names and bad formats are refused',async()=>{
  const f=await shops();
  assert.equal((await f.call(TRIAL,'/api/tech/handle',{handle:'trialshop'})).status,403);
  assert.equal((await f.call(ONE,'/api/tech/handle',{handle:'toyota'})).status,409);
  assert.equal((await f.call(ONE,'/api/tech/handle',{handle:'ร้านแอร์'})).status,400);
  f.sqlite.prepare("UPDATE tech_profiles SET suspended=1 WHERE id='t_aaaaaaaaaaaaaaaa'").run();
  assert.equal((await f.call(ONE,'/api/tech/handle',{handle:'nonair'})).status,403);
  assert.equal((await f.call('','/api/tech/handle/whatever')).status,404);
});

test('changing a name: 30-day wait, the old name keeps leading to the shop and is held from others',async()=>{
  const f=await shops();
  await f.call(ONE,'/api/tech/handle',{handle:'nonair'});
  const soon=await f.call(ONE,'/api/tech/handle',{handle:'nonair-bangna'});assert.equal(soon.status,429);assert.match(soon.error,/เปลี่ยนชื่อลิงก์ได้อีกครั้ง/);
  f.sqlite.prepare("UPDATE tech_profiles SET handle_at=handle_at-31*86400000 WHERE id='t_aaaaaaaaaaaaaaaa'").run();
  assert.equal((await f.call(ONE,'/api/tech/handle',{handle:'nonair-bangna'})).status,200);
  const old=await f.call('','/api/tech/handle/nonair');assert.deepEqual([old.techId,old.handle,old.current],['t_aaaaaaaaaaaaaaaa','nonair-bangna',false]);
  assert.equal((await f.call(TWO,'/api/tech/handle',{handle:'nonair'})).status,409,'held for 90 days');
  f.sqlite.prepare("UPDATE tech_handle_history SET retired_at=retired_at-91*86400000").run();
  assert.equal((await f.call(TWO,'/api/tech/handle',{handle:'nonair'})).status,200,'free after the hold');
  assert.equal((await f.call('','/api/tech/handle/nonair')).techId,'t_bbbbbbbbbbbbbbbb');
});

test('the system owner can set or remove any shop name, with an audit entry',async()=>{
  const f=await shops();
  await f.call(TWO,'/api/tech/handle',{handle:'twoshop'});
  const r=await f.call(BOSS,'/api/tech/handle',{techId:'t_bbbbbbbbbbbbbbbb',handle:''});assert.equal(r.status,200);assert.equal(r.handle,'');
  assert.equal((await f.call('','/api/tech')).techs.find(t=>t.id==='t_bbbbbbbbbbbbbbbb').handle,'');
  assert.ok(f.sqlite.prepare("SELECT 1 FROM tech_audit WHERE action='handle.set' AND target='t_bbbbbbbbbbbbbbbb'").get());
  /* คนทั่วไปส่ง techId ของร้านอื่นมา = ใช้ร้านของตัวเองเสมอ */
  await f.call(ONE,'/api/tech/handle',{techId:'t_bbbbbbbbbbbbbbbb',handle:'mine-only'});
  assert.equal(f.sqlite.prepare("SELECT handle FROM tech_profiles WHERE id='t_aaaaaaaaaaaaaaaa'").get().handle,'mine-only');
  assert.equal(f.sqlite.prepare("SELECT handle FROM tech_profiles WHERE id='t_bbbbbbbbbbbbbbbb'").get().handle,null);
});

test('deleting the shop owner account frees the name and drops its old names',async()=>{
  const {deleteAccount}=await import('../src/account-data.js');
  const f=await shops();
  await f.call(ONE,'/api/tech/handle',{handle:'nonair'});
  f.sqlite.prepare("UPDATE tech_profiles SET handle_at=handle_at-31*86400000").run();
  await f.call(ONE,'/api/tech/handle',{handle:'nonair-two'});
  await deleteAccount(f.env,'one',{email:'one@unit.test'});
  assert.equal(f.sqlite.prepare("SELECT handle FROM tech_profiles WHERE id='t_aaaaaaaaaaaaaaaa'").get().handle,null);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tech_handle_history").get().n,0);
  assert.equal((await f.call(TWO,'/api/tech/handle',{handle:'nonair'})).status,200,'name is free again');
});
