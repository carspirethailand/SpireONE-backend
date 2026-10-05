import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleTech} from '../src/techs.js';
import {fixture,form,fakeGemini,pending,review,USER,ADMIN} from './tech-fixtures.mjs';
test('full onboarding requires fresh AI and human evidence, then appears publicly without identity docs',async()=>{
  fakeGemini();const f=fixture(),a=await pending(f);assert.equal(a.ai.status,'complete');assert.equal((await f.call('', '/api/tech')).techs.length,0);
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a,{evidence:{}}))).status,400);
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,200);
  const list=(await f.call('','/api/tech')).techs;assert.equal(list.length,1);assert.equal(list[0].verified,true);assert.equal(list[0].phone,undefined);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM tech_docs WHERE kind IN ('id','selfie','cert')").get().n,0);
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,409);
});
test('direct API rejects nonsense and 1000 years before charging AI',async()=>{
  const seen=fakeGemini(),f=fixture();for(const over of [{name:'Hasdjjgiohwigrs'},{years:1000},{years:29},{age:30.5},{aiConsent:false},{docs:[{kind:'id',data:'data:image/jpeg;base64,AAAA'}]}])assert.equal((await f.call(USER,'/api/tech/apply',form(over))).status,400);
  assert.equal(seen.calls,0);
});
test('duplicate identity across accounts and duplicate images are rejected',async()=>{
  fakeGemini();const f=fixture();await pending(f);assert.equal((await f.call('other|other@unit.test','/api/tech/apply',form())).status,409);
  const g=fixture(),d=form();d.docs[5]=d.docs[4];assert.equal((await g.call(USER,'/api/tech/apply',d)).status,400);
});
test('concurrent same-account submission cannot replace the winning evidence',async()=>{
  const seen=fakeGemini(),f=fixture();const results=await Promise.all([f.call(USER,'/api/tech/apply',form()),f.call(USER,'/api/tech/apply',form({about:'Different concurrent application with different claimed automotive skill details'}))]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(seen.calls,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_docs').get().n,6);
});
test('failed AI cannot be approved merely by ticking every check',async()=>{
  globalThis.fetch=async()=>new Response('quota',{status:429});const f=fixture(),a=await pending(f);assert.equal(a.ai.status,'failed');assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,400);assert.equal((await f.call('','/api/tech')).techs.length,0);
});
test('stale result cannot approve modified evidence; rescreen actually repairs the result',async()=>{
  fakeGemini();const f=fixture(),a=await pending(f);f.sqlite.prepare("UPDATE tech_docs SET hash='changed' WHERE kind='work'").run();assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,400);
  assert.equal((await f.call(USER,'/api/tech/rescreen',{uid:a.uid})).status,403);
  assert.equal((await f.call(ADMIN,'/api/tech/rescreen',{uid:a.uid})).status,200);
});
test('admin cannot approve own real application or convert test store to verified',async()=>{
  fakeGemini();const f=fixture();await f.call(ADMIN,'/api/tech/apply',form());const a=(await f.call(ADMIN,'/api/tech/applications')).applications[0];assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,403);
  assert.equal((await f.call(ADMIN,'/api/tech/apply',{test:true})).status,409);
});
test('only admin can bypass in explicitly isolated test mode',async()=>{
  const seen=fakeGemini(),f=fixture();assert.equal((await f.call(USER,'/api/tech/apply',{test:true})).status,403);
  f.sqlite.prepare("INSERT INTO users VALUES('moderator','moderator',0)").run();assert.equal((await f.call('moderator|mod@unit.test','/api/tech/apply',{test:true})).status,403);
  assert.equal((await f.call(ADMIN,'/api/tech/apply',{test:true,name:'test'})).status,200);assert.equal(seen.calls,0);
  assert.equal((await f.call('','/api/tech')).techs.length,0);const t=(await f.call(ADMIN,'/api/tech?test=1')).techs[0];assert.equal(t.verified,false);
});
test('unverified owner email and DEV_AUTH tokens cannot gain admin privilege',async()=>{
  const f=fixture({DEV_AUTH:'1'});assert.equal((await f.call('other|boss@unit.test|unverified','/api/tech/apply',{test:true})).status,403);
  const r=await handleTech(new Request('https://unit.test/api/tech/me',{headers:{Authorization:'Bearer dev:boss:boss@unit.test'}}),f.env);assert.equal(r.status,401);
});
test('AI retry flooding is bounded without trusting frontend',async()=>{
  fakeGemini();const f=fixture(),a=await pending(f);for(let i=0;i<5;i++)assert.equal((await f.call(ADMIN,'/api/tech/rescreen',{uid:a.uid})).status,200);assert.equal((await f.call(ADMIN,'/api/tech/rescreen',{uid:a.uid})).status,429);
});
test('moderator cannot approve and unauthorized users cannot read identity evidence',async()=>{
  fakeGemini();const f=fixture(),a=await pending(f);f.sqlite.prepare("INSERT INTO users VALUES('moderator','moderator',0)").run();
  assert.equal((await f.call('moderator|mod@unit.test','/api/tech/review',review(a))).status,403);
  assert.equal((await f.call('','/api/tech/docs?uid='+a.uid)).status,401);
  assert.equal((await f.call('other|other@unit.test','/api/tech/docs?uid='+a.uid)).status,403);
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a,{checks:{identity:'true',phone:true,work:true,skills:true,shop:true,terms:true}}))).status,400);
});
test('concurrent approvals produce only one winning review and one public profile',async()=>{
  fakeGemini();const f=fixture(),a=await pending(f),r=await Promise.all([f.call(ADMIN,'/api/tech/review',review(a)),f.call(ADMIN,'/api/tech/review',review(a))]);
  assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);assert.equal((await f.call('','/api/tech')).techs.length,1);
});
test('verified portfolio cannot be swapped to unreviewed pictures or warranty reduced below seven days',async()=>{
  fakeGemini();const f=fixture(),a=await pending(f);await f.call(ADMIN,'/api/tech/review',review(a));
  assert.equal((await f.call(USER,'/api/tech/shop',{addPhotos:form().docs.slice(2,3)})).status,409);
  assert.equal((await f.call(USER,'/api/tech/shop',{warranty:0})).status,400);
  assert.equal((await f.call(USER,'/api/tech/shop',{from:600,hours:'09:00–18:00'})).status,200);
});
