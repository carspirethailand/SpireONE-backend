import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture,png} from './tech-fixtures.mjs';
import {handleTech} from '../src/techs.js';
import {seal,CTX} from '../src/vault.js';
const OWNER='shop-owner|shop@unit.test',OTHER='other|other@unit.test';
const service=(title='ล้างแอร์พร้อมตรวจระบบ')=>({title,price:1200,body:'บริการทดสอบในเครื่องเท่านั้น',cats:['air'],brands:['Toyota']});
async function seed(){
  const f=fixture();await f.call('','/api/tech/ping');
  const profile={name:'ช่าง ทดสอบ',shop:'อู่ข้อมูลคงอยู่',about:'ข้อมูลเดิมที่ห้ามเขียนทับ',cats:['air'],lat:13.75,lng:100.5,cover:1,avatar:1,hours:'09:00–18:00',custom:{retained:true}};
  f.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,jobs,rating_sum,review_count,id_hold,created_at,updated_at) VALUES (?,?,?,?,0,1,1,12,58,12,0,100,200)')
    .run('legacy-stable-shop-id','shop-owner','0811111111',JSON.stringify(profile));
  f.sqlite.prepare("INSERT INTO tech_applications(uid,email,data,status,test,revision,created_at,updated_at) VALUES (?,?,?,'approved',1,3,100,200)")
    .run('shop-owner','shop@unit.test',await seal(f.env,JSON.stringify({name:profile.name,shop:profile.shop}),CTX.app('shop-owner')));
  const photo=png().toString('base64');
  f.sqlite.prepare("INSERT INTO tech_docs(id,uid,kind,mime,data,created_at) VALUES (1,'shop-owner','shop','image/png',?,100)").run(photo);
  for(let i=1;i<=2;i++)f.sqlite.prepare("INSERT INTO tech_gigs(uid,tech_id,kind,title,body,price,cats,brands,photos,active,created_at,updated_at) VALUES ('shop-owner','legacy-stable-shop-id','package',?,'รายละเอียดเดิม',1200,'[\"air\"]','[\"Toyota\"]','[1]',1,?,?)")
    .run('บริการเดิม '+i,100+i,200+i);
  return f;
}
const verifyToken=async token=>{const [uid,email]=token.split('|');if(!uid)throw Error('invalid');return{sub:uid,email,email_verified:true}};
const raw=(f,path,token=OWNER,handler=handleTech)=>handler(new Request('https://unit.test'+path,{headers:token?{Authorization:'Bearer '+token}:{}}),f.env,undefined,{verifyToken});
const snapshot=f=>Object.fromEntries(['tech_profiles','tech_applications','tech_gigs','tech_docs'].map(table=>[table,f.sqlite.prepare('SELECT * FROM '+table+' ORDER BY rowid').all().map(x=>({...x}))]));

test('a suspended trial shop still sees both quota-counted services privately; nobody else inherits them',async()=>{
  const f=await seed(),before=snapshot(f),r=await raw(f,'/api/tech/gigs?mine=1'),d=await r.json();
  assert.equal(r.status,200);assert.match(r.headers.get('Cache-Control'),/no-store/);assert.match(r.headers.get('Vary'),/Authorization/);
  assert.equal(d.gigs.length,2);assert.deepEqual(d.quota,{used:2,limit:2,remaining:0});assert.equal(d.visibility,'suspended');
  assert.ok(d.gigs.every(g=>g.managed&&g.visibility==='suspended'&&g.tech.id==='legacy-stable-shop-id'&&g.photos[0]===1));
  assert.equal((await f.call('', '/api/tech/gigs')).gigs.length,0);assert.equal((await f.call(OTHER,'/api/tech/gigs?mine=1&uid=shop-owner')).gigs.length,0);
  assert.equal((await f.call('', '/api/tech/gigs?mine=1')).status,401);assert.deepEqual(snapshot(f),before);
});

test('full quota is an inventory conflict, not a malformed form; existing services remain editable',async()=>{
  const f=await seed(),before=snapshot(f),r=await f.call(OWNER,'/api/tech/gig',service());
  assert.equal(r.status,409);assert.equal(r.code,'SERVICE_LIMIT');assert.deepEqual(r.quota,{used:2,limit:2,remaining:0});assert.deepEqual(snapshot(f),before);
  assert.equal((await f.call(OWNER,'/api/tech/gig',{id:1,...service('บริการเดิมที่แก้ไขแล้ว'),keep:[1]})).status,200);
  assert.equal((await f.call(OTHER,'/api/tech/gig',{id:1,...service()})).status,404);
  const rows=(await f.call(OWNER,'/api/tech/gigs?mine=1')).gigs;assert.equal(rows.length,2);assert.ok(rows.some(g=>g.id===1&&g.title==='บริการเดิมที่แก้ไขแล้ว'));
  assert.equal(f.sqlite.prepare('SELECT suspended FROM tech_profiles').get().suspended,1,'editing does not unsuspend the shop');
  assert.equal((await f.call('', '/api/tech/gigs')).gigs.length,0,'editing is not public approval');
});

test('explicitly deleting one service frees exactly one slot, without deleting its shop or the other service',async()=>{
  const f=await seed();assert.equal((await f.call(OWNER,'/api/tech/gig/delete',{id:1})).status,200);
  let d=await f.call(OWNER,'/api/tech/gigs?mine=1');assert.equal(d.gigs.length,1);assert.deepEqual(d.quota,{used:1,limit:2,remaining:1});
  assert.equal((await f.call(OWNER,'/api/tech/gig',service())).status,200);d=await f.call(OWNER,'/api/tech/gigs?mine=1');assert.equal(d.gigs.length,2);
  assert.ok(d.gigs.some(g=>g.id===2));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_profiles').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT active FROM tech_gigs WHERE id=1').get().active,0,'only the chosen record is soft-deleted');
});

test('a fresh deployed module preserves application, stable shop ID, profile fields, photos and services',async()=>{
  const f=await seed(),before=snapshot(f);
  for(const version of ['release-one','release-two']){
    const fresh=await import('../src/techs.js?persistence='+version);
    assert.equal((await raw(f,'/api/tech/ping','',fresh.handleTech)).status,200);
    const me=await raw(f,'/api/tech/me',OWNER,fresh.handleTech),d=await me.json();assert.equal(d.technician.id,'legacy-stable-shop-id');
    assert.equal(d.technician.shop,'อู่ข้อมูลคงอยู่');assert.equal(d.application.status,'approved');assert.match(me.headers.get('Cache-Control'),/no-store/);
    const gigs=await raw(f,'/api/tech/gigs?mine=1',OWNER,fresh.handleTech);assert.equal((await gigs.json()).gigs.length,2);
    assert.deepEqual(snapshot(f),before,'cold boot and idempotent schema setup must not erase or reset existing data');
  }
  assert.equal((await f.call(OWNER,'/api/tech/shop',{hours:'10:00–19:00'})).status,200);
  const profile=f.sqlite.prepare('SELECT id,data FROM tech_profiles').get();assert.equal(profile.id,'legacy-stable-shop-id');
  const changed=JSON.parse(profile.data);assert.equal(changed.about,'ข้อมูลเดิมที่ห้ามเขียนทับ');assert.equal(changed.custom.retained,true);assert.equal(changed.cover,1);
  assert.deepEqual(snapshot(f).tech_gigs,before.tech_gigs);assert.deepEqual(snapshot(f).tech_docs,before.tech_docs);
});

test('the release must still point at the existing production D1 database, never an empty replacement',()=>{
  const cfg=readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');
  assert.match(cfg,/"database_name"\s*:\s*"spireone"/);assert.match(cfg,/"database_id"\s*:\s*"bf9b1815-2ef6-4463-8b35-6b97717b5d9a"/);
});

test('hidden shop photos load only for their owner through an authenticated no-store request; ID/selfie/certificate never use this route',async()=>{
  const f=await seed();
  assert.equal((await raw(f,'/api/tech/img/1','')).status,404,'public suspension filter remains in place');
  const r=await raw(f,'/api/tech/img/1?owner=1');assert.equal(r.status,200);assert.match(r.headers.get('Cache-Control'),/private.*no-store/);
  assert.equal(r.headers.get('Content-Type'),'image/png');assert.deepEqual(new Uint8Array(await r.arrayBuffer()),new Uint8Array(png()));
  assert.equal((await raw(f,'/api/tech/img/1?owner=1',OTHER)).status,404);assert.equal((await raw(f,'/api/tech/img/1?owner=1','')).status,401);
  for(const [i,kind] of ['id','selfie','cert'].entries()){
    f.sqlite.prepare('INSERT INTO tech_docs(id,uid,kind,mime,data,created_at) VALUES (?,?,?,?,?,100)').run(i+10,'shop-owner',kind,'image/png',png().toString('base64'));
    assert.equal((await raw(f,'/api/tech/img/'+(i+10)+'?owner=1')).status,404);
  }
});
