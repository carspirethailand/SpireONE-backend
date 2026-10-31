/* หน้าร้านแบบจัดเอง: ช่างเรียงการ์ด/เลือกรูปแบบได้ แต่ข้อมูลจริงยังมาจากระบบ และหน้าร้านเดิมไม่เปลี่ยนเองจนกว่าช่างจะแต่ง */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER} from './tech-fixtures.mjs';
import {withMechanic,MECH} from './tech-safety.test.mjs';

const page=(blocks)=>({v:1,blocks});
const mine=async f=>(await f.call(MECH,'/api/tech/me')).technician;
const listed=async f=>(await f.call('', '/api/tech')).techs.find(t=>t.id==='t_mech');

test('storefront: existing shops keep the classic page until the mechanic designs one',async()=>{
  const f=fixture();await withMechanic(f);
  assert.equal((await mine(f)).page,null);
  assert.equal((await listed(f)).page,null,'customers see the classic storefront');
});

test('storefront: a verified mechanic arranges cards freely; customers get the same layout',async()=>{
  const f=fixture();await withMechanic(f);
  const blocks=[{id:'s1',type:'scene',style:'full',props:{sign:'อู่ช่างเอก',signColor:'#2F6FB5',wallColor:'#ffffff',accentColor:'#2f9e6e',size:'short'}},
    {id:'b1',type:'banner',style:'gradient',props:{title:'ลด 10% ล้างแอร์',text:'ถึงสิ้นเดือนนี้',grad:'ocean'}},
    {id:'r1',type:'reviews',style:'card'},{id:'v1',type:'services',style:'full'},
    {id:'t1',type:'text',style:'card',props:{title:'ทำไมต้องเรา',body:'บรรทัดแรก\nบรรทัดสอง'}},{id:'p1',type:'photos',style:'card',props:{layout:'row'}}];
  const r=await f.call(MECH,'/api/tech/shop',{page:page(blocks)});
  assert.equal(r.status,200,r.error);
  assert.deepEqual(r.page.blocks.map(b=>b.type),['scene','banner','reviews','services','text','photos'],'order is kept');
  assert.deepEqual(r.page.blocks[0].props,{sign:'อู่ช่างเอก',signColor:'#2f6fb5',wallColor:'#ffffff',accentColor:'#2f9e6e',size:'short'});
  assert.equal(r.page.blocks[4].props.body,'บรรทัดแรก\nบรรทัดสอง','text cards keep line breaks');
  assert.deepEqual((await mine(f)).page,r.page);
  assert.deepEqual((await listed(f)).page,r.page,'the public storefront uses the saved layout');
  /* แก้ข้อมูลร้านอื่น ๆ ไม่ทำให้หน้าร้านที่จัดไว้หาย */
  assert.equal((await f.call(MECH,'/api/tech/shop',{greet:'สวัสดีครับ'})).status,200);
  assert.deepEqual((await mine(f)).page,r.page);
  /* กลับไปหน้าร้านแบบเดิมได้ */
  const back=await f.call(MECH,'/api/tech/shop',{page:null});assert.equal(back.status,200);assert.equal(back.page,null);
  assert.equal((await mine(f)).page,null);assert.equal((await listed(f)).page,null);
});

test('storefront: unsafe or broken layouts are refused or cleaned, never stored as-is',async()=>{
  const f=fixture();await withMechanic(f);
  const bad=async(p,re)=>{const r=await f.call(MECH,'/api/tech/shop',{page:p});assert.equal(r.status,400,JSON.stringify(r));assert.match(r.error,re);};
  await bad({blocks:'x'},/รูปแบบ/);
  await bad(page([{type:'script'}]),/ชนิด/);
  await bad(page([{type:'reviews'},{type:'reviews'}]),/ใบเดียว/);
  await bad(page(Array.from({length:25},(_,i)=>({type:'text',id:'t'+i}))),/24/);
  await bad(page(Array.from({length:7},(_,i)=>({type:'banner',id:'b'+i}))),/6 ใบ/);
  const r=await f.call(MECH,'/api/tech/shop',{page:page([
    {id:'<img>',type:'scene',style:'fixed',props:{sign:'a'.repeat(80)+'\u0007',signColor:'red',wallColor:'url(x)',size:'huge'}},
    {id:'same',type:'text',props:{title:'<b>หัวข้อ</b>',body:'x'.repeat(900)}},{id:'same',type:'text'},{type:'stats',style:'gradient',props:{jobs:9999}}])});
  assert.equal(r.status,200,r.error);const [s,t1,t2,st]=r.page.blocks;
  assert.equal(s.id,'b0');assert.equal(s.style,'card');assert.equal(s.props.sign.length,28);assert.doesNotMatch(s.props.sign,/\u0007/);
  assert.deepEqual([s.props.signColor,s.props.wallColor,s.props.size],['#e8843c','#f4e7d4','tall'],'colours must be plain hex, size is a fixed choice');
  assert.equal(t1.props.title,'<b>หัวข้อ</b>','text is stored as text; the page escapes it when drawing');assert.equal(t1.props.body.length,600);
  assert.notEqual(t1.id,t2.id,'duplicate ids are made unique');
  assert.equal(st.props,undefined,'stats come from real data only — a typed number is dropped');
});

test('storefront: only the shop owner (or the system owner) can change it',async()=>{
  const f=fixture();await withMechanic(f);
  const r=await f.call(USER,'/api/tech/shop',{page:page([{type:'reviews'}])});
  assert.notEqual(r.status,200);
  assert.equal((await mine(f)).page,null);
});

test('storefront: a mobile mechanic picks the vehicle shown in the 3D scene; anything else is dropped',async()=>{
  const f=fixture();await withMechanic(f);
  assert.equal((await mine(f)).vehicle,'');
  const r=await f.call(MECH,'/api/tech/shop',{vehicle:'van'});assert.equal(r.status,200,r.error);assert.equal(r.vehicle,'van');
  assert.equal((await mine(f)).vehicle,'van');assert.equal((await listed(f)).vehicle,'van');
  assert.equal((await f.call(MECH,'/api/tech/shop',{vehicle:'<script>'})).vehicle,'','unknown values clear it');
  assert.equal((await f.call(MECH,'/api/tech/shop',{vehicle:'moto'})).vehicle,'moto');
  assert.equal((await f.call(MECH,'/api/tech/shop',{greet:'สวัสดี'})).vehicle,undefined,'other edits do not touch it');assert.equal((await mine(f)).vehicle,'moto');
  assert.notEqual((await f.call(USER,'/api/tech/shop',{vehicle:'van'})).status,200);
});
