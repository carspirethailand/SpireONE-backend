import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './tech-fixtures.mjs';
import {handleTech} from '../src/techs.js';

/* สปอนเซอร์บริการ: เจ้าของร้านดันบริการของตัวเองได้ (ช่วงทดลองฟรี) · ลูกค้าเห็นแค่ว่าเป็นสปอนเซอร์ · คนอื่นแตะไม่ได้ */
const MECH='mech|mech@unit.test',OTHER='other|other@unit.test',CUST='cust|cust@unit.test';
const DAY=86400000;
function setup(){
  const f=fixture();
  const call=async(token,path,body)=>{const r=await handleTech(new Request('https://unit.test'+path,{method:body?'POST':'GET',headers:token?{Authorization:'Bearer '+token}:{},body:body?JSON.stringify(body):undefined}),
    f.env,undefined,{verifyToken:async t=>{const [uid,email]=t.split('|');return {sub:uid,email,email_verified:true};},ctx:{waitUntil(){}}});
    return {...await r.json(),status:r.status};};
  return {f,call};
}
async function shop(f,call,{uid='mech',id='t_mech',verified=1}={}){
  await call('','/api/tech/ping');
  f.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at) VALUES (?,?,?,?,?,0,0,?,?)')
    .run(id,uid,'0899999999',JSON.stringify({name:'ช่าง ทดสอบ',shop:'อู่ทดสอบ',lat:13.75,lng:100.5,radius:30,cats:['air']}),verified,Date.now(),Date.now());
  const r=f.sqlite.prepare("INSERT INTO tech_gigs (uid,tech_id,kind,title,price,cats,active,created_at,updated_at) VALUES (?,?,'package','ล้างแอร์ครบชุด',1800,'[\"air-clean\"]',1,?,?)").run(uid,id,Date.now(),Date.now());
  return Number(r.lastInsertRowid);
}
const pub=async(call,token)=>(await call(token||'','/api/tech/gigs')).gigs;

test('sponsor: the owner sponsors a service for free; customers see a sponsored flag but not the dates',async()=>{
  const {f,call}=setup();const gid=await shop(f,call);
  assert.equal((await pub(call))[0].sponsored,undefined,'not sponsored yet');
  const r=await call(MECH,'/api/tech/gig/sponsor',{id:gid,days:7});
  assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.free,true);
  assert.ok(Math.abs(r.sponsor.until-(Date.now()+7*DAY))<5000,'ends in 7 days');
  const row=f.sqlite.prepare('SELECT price,paid,days FROM tech_sponsors').get();
  assert.deepEqual({...row},{price:0,paid:1,days:7},'free trial is recorded as a paid-zero purchase');
  const seen=(await pub(call,CUST))[0];
  assert.equal(seen.sponsored,true,'customers must be told it is sponsored');assert.equal(seen.sponsor,undefined,'customers do not see the end date');
  const mine=(await call(MECH,'/api/tech/gigs?mine=1')).gigs[0];
  assert.equal(mine.sponsored,true);assert.ok(mine.sponsor.until>Date.now(),'the owner sees when it ends');
});

test('sponsor: extending stacks onto the current end, capped at 30 days ahead',async()=>{
  const {f,call}=setup();const gid=await shop(f,call);
  const a=await call(MECH,'/api/tech/gig/sponsor',{id:gid,days:14});
  const b=await call(MECH,'/api/tech/gig/sponsor',{id:gid,days:14});
  assert.equal(b.status,200);assert.equal(b.sponsor.until-a.sponsor.until,14*DAY,'starts where the last one ends');
  assert.equal(b.sponsor.since,a.sponsor.since,'still one continuous run');
  const c=await call(MECH,'/api/tech/gig/sponsor',{id:gid,days:3});
  assert.equal(c.status,400,'28 + 3 days goes past the 30-day cap');assert.match(c.error,/30 วัน/);
  assert.equal((await call(MECH,'/api/tech/gig/sponsor',{id:gid,days:5})).status,400,'only 3, 7 or 14 days');
});

test('sponsor: only the owner, only a live verified shop',async()=>{
  const {f,call}=setup();const gid=await shop(f,call);
  assert.equal((await call(OTHER,'/api/tech/gig/sponsor',{id:gid,days:7})).status,404,'another account cannot sponsor my service');
  assert.equal((await call('','/api/tech/gig/sponsor',{id:gid,days:7})).status,401);
  const g2=await shop(f,call,{uid:'other',id:'t_other',verified:0});
  const r=await call(OTHER,'/api/tech/gig/sponsor',{id:g2,days:7});
  assert.equal(r.status,403,'an unverified shop is invisible to customers anyway');
  f.sqlite.prepare("UPDATE tech_profiles SET suspended=1 WHERE id='t_mech'").run();
  assert.equal((await call(MECH,'/api/tech/gig/sponsor',{id:gid,days:7})).status,403,'a suspended shop cannot sponsor');
});

test('sponsor: stopping or deleting the service ends it right away',async()=>{
  const {f,call}=setup();const gid=await shop(f,call);
  await call(MECH,'/api/tech/gig/sponsor',{id:gid,days:7});
  assert.equal((await call(OTHER,'/api/tech/gig/unsponsor',{id:gid})).status,404);
  assert.equal((await call(MECH,'/api/tech/gig/unsponsor',{id:gid})).status,200);
  assert.equal((await pub(call))[0].sponsored,undefined,'stopped');
  await call(MECH,'/api/tech/gig/sponsor',{id:gid,days:3});
  assert.equal((await pub(call))[0].sponsored,true,'can start again after stopping');
  assert.equal((await call(MECH,'/api/tech/gig/delete',{id:gid})).status,200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM tech_sponsors WHERE cancelled_at IS NULL').get().n,0,'deleted service stops its sponsorship');
});
