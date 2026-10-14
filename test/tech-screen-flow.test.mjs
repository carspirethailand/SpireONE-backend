import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleTech} from '../src/techs.js';
import {fixture,form,pic,fakeVision,failVision,fakeDidit,diditHook,approvedDecision,DIDIT,pending,review,evidence,USER,ADMIN} from './tech-fixtures.mjs';
import {CONSENT_VER} from '../src/tech-vetting.js';
test('full onboarding requires fresh AI and human evidence, then appears publicly without identity docs',async()=>{
  fakeVision();const f=fixture(),a=await pending(f);assert.equal(a.ai.status,'complete');assert.equal((await f.call('', '/api/tech')).techs.length,0);
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a,{evidence:{}}))).status,400);
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,200);
  const list=(await f.call('','/api/tech')).techs;assert.equal(list.length,1);assert.equal(list[0].verified,true);assert.equal(list[0].phone,undefined);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM tech_docs WHERE kind IN ('id','selfie','cert')").get().n,0);
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,409);
});
test('direct API rejects nonsense and 1000 years before charging AI',async()=>{
  const seen=fakeVision(),f=fixture();for(const over of [{name:'Hasdjjgiohwigrs'},{years:1000},{years:29},{age:30.5},{consent:false},{idConsent:false},{idNo:'1101700203451'},{docs:[{kind:'id',data:'data:image/jpeg;base64,AAAA'}]}])assert.equal((await f.call(USER,'/api/tech/apply',form(over))).status,400);
  assert.equal(seen.calls,0);
});
test('duplicate identity across accounts and duplicate images are rejected',async()=>{
  fakeVision();const f=fixture();await pending(f);assert.equal((await f.call('other|other@unit.test','/api/tech/apply',form())).status,409);
  const g=fixture(),d=form();d.docs[5]=d.docs[4];assert.equal((await g.call(USER,'/api/tech/apply',d)).status,400);
});
test('concurrent same-account submission cannot replace the winning evidence',async()=>{
  const seen=fakeVision(),f=fixture();const results=await Promise.all([f.call(USER,'/api/tech/apply',form()),f.call(USER,'/api/tech/apply',form({about:'Different concurrent application with different claimed automotive skill details'}))]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(seen.calls,2,'only the winner is screened (4 photos = 2 AI batches)');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_docs').get().n,6);
});
test('failed AI cannot be approved merely by ticking every check',async()=>{
  failVision();const f=fixture(),a=await pending(f);assert.equal(a.ai.status,'failed');assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,400);assert.equal((await f.call('','/api/tech')).techs.length,0);
});
test('stale result cannot approve modified evidence; rescreen actually repairs the result',async()=>{
  fakeVision();const f=fixture(),a=await pending(f);f.sqlite.prepare("UPDATE tech_docs SET hash='changed' WHERE kind='work'").run();assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,400);
  assert.equal((await f.call(USER,'/api/tech/rescreen',{uid:a.uid})).status,403);
  assert.equal((await f.call(ADMIN,'/api/tech/rescreen',{uid:a.uid})).status,200);
});
test('admin cannot approve own real application or convert test store to verified',async()=>{
  fakeVision();const f=fixture();await f.call(ADMIN,'/api/tech/apply',form());const a=(await f.call(ADMIN,'/api/tech/applications')).applications[0];assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,403);
  assert.equal((await f.call(ADMIN,'/api/tech/apply',{test:true})).status,409);
});
test('only admin can bypass in explicitly isolated test mode',async()=>{
  const seen=fakeVision(),f=fixture();assert.equal((await f.call(USER,'/api/tech/apply',{test:true})).status,403);
  f.sqlite.prepare("INSERT INTO users VALUES('moderator','moderator',0)").run();assert.equal((await f.call('moderator|mod@unit.test','/api/tech/apply',{test:true})).status,403);
  assert.equal((await f.call(ADMIN,'/api/tech/apply',{test:true,name:'test'})).status,200);assert.equal(seen.calls,0);
  assert.equal((await f.call('','/api/tech')).techs.length,0);const t=(await f.call(ADMIN,'/api/tech?test=1')).techs[0];assert.equal(t.verified,false);
});
test('unverified owner email and DEV_AUTH tokens cannot gain admin privilege',async()=>{
  const f=fixture({DEV_AUTH:'1'});assert.equal((await f.call('other|boss@unit.test|unverified','/api/tech/apply',{test:true})).status,403);
  const r=await handleTech(new Request('https://unit.test/api/tech/me',{headers:{Authorization:'Bearer dev:boss:boss@unit.test'}}),f.env);assert.equal(r.status,401);
});
test('AI retry flooding is bounded without trusting frontend',async()=>{
  fakeVision();const f=fixture(),a=await pending(f);for(let i=0;i<5;i++)assert.equal((await f.call(ADMIN,'/api/tech/rescreen',{uid:a.uid})).status,200);assert.equal((await f.call(ADMIN,'/api/tech/rescreen',{uid:a.uid})).status,429);
});
test('moderator cannot approve and unauthorized users cannot read identity evidence',async()=>{
  fakeVision();const f=fixture(),a=await pending(f);f.sqlite.prepare("INSERT INTO users VALUES('moderator','moderator',0)").run();
  assert.equal((await f.call('moderator|mod@unit.test','/api/tech/review',review(a))).status,403);
  assert.equal((await f.call('','/api/tech/docs?uid='+a.uid)).status,401);
  assert.equal((await f.call('other|other@unit.test','/api/tech/docs?uid='+a.uid)).status,403);
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a,{checks:{identity:'true',phone:true,work:true,skills:true,shop:true,terms:true}}))).status,400);
});
test('concurrent approvals produce only one winning review and one public profile',async()=>{
  fakeVision();const f=fixture(),a=await pending(f),r=await Promise.all([f.call(ADMIN,'/api/tech/review',review(a)),f.call(ADMIN,'/api/tech/review',review(a))]);
  assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);assert.equal((await f.call('','/api/tech')).techs.length,1);
});
test('verified portfolio cannot be swapped to unreviewed pictures or warranty reduced below seven days',async()=>{
  fakeVision();const f=fixture(),a=await pending(f);await f.call(ADMIN,'/api/tech/review',review(a));
  assert.equal((await f.call(USER,'/api/tech/shop',{addPhotos:form().docs.slice(2,3)})).status,409);
  assert.equal((await f.call(USER,'/api/tech/shop',{warranty:0})).status,400);
  assert.equal((await f.call(USER,'/api/tech/shop',{from:600,hours:'09:00–18:00'})).status,200);
});

/* ── AI ดูรูปเป็นทางเลือกของผู้สมัคร ── */
test('no AI consent → application still goes in, nothing sent to AI, staff must review the photos themselves',async()=>{
  const seen=fakeVision(),f=fixture(),a=await pending(f,{aiConsent:false});assert.equal(seen.calls,0);
  assert.equal(a.ai.status,'skipped');assert.equal(a.aiConsent,false);assert.ok(a.ai.flags.some(x=>x.code==='ai_skipped'));
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,400,'photo review note required');
  const note={outcome:'false_positive',note:'Staff looked at every shop and work photo; test-only record.'};
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a,{resolutions:{ai_skipped:note}}))).status,200);
});
test('a consent ticked on the old Gemini wording is not reused for Cloudflare',async()=>{
  const seen=fakeVision(),f=fixture(),a=await pending(f,{consentVer:undefined,aiConsent:true});
  assert.equal(seen.calls,0);assert.equal(a.aiConsent,false);assert.equal(a.ai.status,'skipped');
});
test('ping tells the form which identity check and consent wording to show',async()=>{
  let r=await fixture().call('','/api/tech/ping');assert.equal(r.identity,'manual');assert.equal(r.consentVer,CONSENT_VER);assert.equal(r.photoAI,true);
  r=await fixture({...DIDIT,AI:undefined}).call('','/api/tech/ping');assert.equal(r.identity,'didit');assert.equal(r.photoAI,false);
});

/* ── Didit ── */
const D=(over={})=>form({idNo:undefined,idConsent:undefined,diditConsent:true,docs:form().docs.filter(x=>!['id','selfie'].includes(x.kind)),...over});
async function diditApp(f,over){const r=await f.call(USER,'/api/tech/apply',D(over));assert.equal(r.status,200,JSON.stringify(r));return r;}
const staffView=async f=>(await f.call(ADMIN,'/api/tech/applications')).applications[0];
const didEv=()=>({...evidence(),identity:{method:'didit',note:'Didit approved the ID card and face; test-only record.'}});
test('Didit mode: no ID photos or number stored; consent to Didit required; approval waits for Didit',async()=>{
  fakeVision();const f=fixture(DIDIT);
  assert.equal((await f.call(USER,'/api/tech/apply',D({diditConsent:false}))).status,400);
  fakeVision();const r=await diditApp(f,{docs:form().docs,idNo:'1101700203450'});
  assert.deepEqual(r.identity,{mode:'didit',status:'not_started'});
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM tech_docs WHERE kind IN ('id','selfie')").get().n,0,'old clients sending ID photos: dropped, never stored');
  assert.ok(!f.sqlite.prepare('SELECT data FROM tech_applications').get().data.includes('1101700203450'),'ID number not kept');
  const a=await staffView(f);assert.equal(a.ai.verdict,'pass');assert.equal(a.identity.status,'not_started');
  const ap=await f.call(ADMIN,'/api/tech/review',review(a,{evidence:didEv()}));assert.equal(ap.status,400);assert.match(ap.error,/Didit/);
});
test('Didit session → signed webhook → decision re-fetched → approval works; personal card data trimmed after approval',async()=>{
  fakeVision();const f=fixture(DIDIT);await diditApp(f);
  const seen=fakeDidit();
  const s=await f.call(USER,'/api/tech/apply/identity',{});assert.equal(s.status,200,JSON.stringify(s));assert.match(s.url,/^https:\/\/verify\.didit\.me\//);
  const sent=seen.sessions[0];assert.equal(sent.headers['x-api-key'],DIDIT.DIDIT_API_KEY);assert.equal(sent.body.workflow_id,'wf-test');assert.match(sent.body.callback,/\/join$/);
  assert.ok(!JSON.stringify(sent.body).includes('applicant'),'Didit gets an opaque tag, not our user id');
  assert.equal((await f.call(USER,'/api/tech/apply/identity',{})).url,s.url,'reopening reuses the same session');assert.equal(seen.sessions.length,1);
  const sid=s.url.split('/').pop();
  assert.equal((await diditHook(f,sid,{secret:'wrong'})).status,401);assert.equal(seen.decisions,0,'unsigned calls never trigger anything');
  assert.equal((await diditHook(f,sid,{ts:Math.floor(Date.now()/1000)-900})).status,401,'stale replay refused');
  assert.equal((await diditHook(f,'sess-unknown-test')).status,200);assert.equal(seen.decisions,0,'unknown sessions are ignored quietly');
  assert.equal((await diditHook(f,sid)).status,200);assert.equal(seen.decisions,1,'the real result is fetched from Didit');
  const me=(await f.call(USER,'/api/tech/me')).application;assert.deepEqual(me.identity,{mode:'didit',status:'approved',updatedAt:me.identity.updatedAt});
  const a=await staffView(f);assert.equal(a.identity.status,'approved');assert.equal(a.identity.name,'สมชาย ใจดี');assert.equal(a.identity.last3,'450');assert.deepEqual(a.identity.flags,[]);
  assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM tech_identity').get()).includes('private.jpg'),'Didit image links are not stored');
  assert.match(f.sqlite.prepare('SELECT id_hash FROM tech_applications').get().id_hash,/^[0-9a-f]{64}$/);
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a,{evidence:didEv()}))).status,200);
  const left=JSON.parse(f.sqlite.prepare('SELECT data FROM tech_identity').get().data);assert.equal(left.name,undefined);assert.equal(left.birth,undefined);assert.equal(left.last3,'450');
  assert.equal((await f.call('','/api/tech')).techs[0].vetting.identity,true);
});
test('Didit: declined → applicant can try again; name mismatch needs a staff note; under-18 cannot be approved',async()=>{
  fakeVision();const f=fixture(DIDIT);await diditApp(f);const seen=fakeDidit({status:'Declined'});
  const s=await f.call(USER,'/api/tech/apply/identity',{});await diditHook(f,s.url.split('/').pop());
  assert.equal((await f.call(USER,'/api/tech/me')).application.identity.status,'declined');
  seen.decision=approvedDecision({first_name:'สมศรี'});
  const s2=await f.call(USER,'/api/tech/apply/identity',{});assert.notEqual(s2.url,s.url,'a fresh session after a decline');
  assert.equal((await f.call(USER,'/api/tech/apply/identity/refresh',{})).identity.status,'approved','return from Didit can pull the result without waiting for the webhook');
  let a=await staffView(f);assert.deepEqual(a.identity.flags.map(x=>x.code),['id_name']);
  assert.equal((await f.call(ADMIN,'/api/tech/review',review({...a,identity:{flags:[]}},{evidence:didEv()}))).status,400,'name mismatch needs a note');
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a,{evidence:didEv()}))).status,200);
  const g=fixture(DIDIT);fakeVision();await diditApp(g);fakeDidit(approvedDecision({date_of_birth:'2012-01-01'}));
  await g.call(USER,'/api/tech/apply/identity',{});await g.call(USER,'/api/tech/apply/identity/refresh',{});
  a=await staffView(g);const r=await g.call(ADMIN,'/api/tech/review',review(a,{evidence:didEv()}));assert.equal(r.status,400);assert.match(r.error,/18/);
});
test('Didit: one ID card cannot verify two accounts',async()=>{
  fakeVision();const f=fixture(DIDIT);await diditApp(f);fakeDidit();
  await f.call(USER,'/api/tech/apply/identity',{});await f.call(USER,'/api/tech/apply/identity/refresh',{});
  const OTHER='other|other@unit.test';fakeVision();assert.equal((await f.call(OTHER,'/api/tech/apply',D({docs:[pic('shop',13),pic('work',14),pic('work',15),pic('work',16)]}))).status,200);fakeDidit();
  await f.call(OTHER,'/api/tech/apply/identity',{});await f.call(OTHER,'/api/tech/apply/identity/refresh',{});
  const b=(await f.call(ADMIN,'/api/tech/applications')).applications.find(x=>x.uid==='other');
  assert.ok(b.identity.flags.some(x=>x.code==='duplicate_id'&&x.block));
  const r=await f.call(ADMIN,'/api/tech/review',review(b,{evidence:didEv()}));assert.equal(r.status,400);assert.match(r.error,/บัญชีอื่น/);
});
test('Didit endpoints refuse when Didit is not configured or there is no application',async()=>{
  fakeVision();let f=fixture();assert.equal((await f.call(USER,'/api/tech/apply/identity',{})).status,409);
  assert.equal((await f.call('','/api/tech/didit/webhook',{session_id:'x'})).status,404);
  f=fixture(DIDIT);fakeDidit();assert.equal((await f.call(USER,'/api/tech/apply/identity',{})).status,409);
});

/* ── แฮชเลขบัตรด้วยกุญแจลับ ── */
test('ID_HASH_KEY: new hashes are keyed, old rows are upgraded on first request, duplicates still caught',async()=>{
  fakeVision();const f=fixture();await pending(f);
  const legacy=f.sqlite.prepare('SELECT id_hash FROM tech_applications').get().id_hash;assert.match(legacy,/^[0-9a-f]{64}$/);
  const g={...f,env:{...f.env,ID_HASH_KEY:'test-key-only'}};
  const {handleTech:h}=await import('../src/techs.js');const call=async(token,path,body)=>{const r=await h(new Request('https://unit.test'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined}),{...f.env,ID_HASH_KEY:'test-key-only',DB:{...f.env.DB,prepare:f.env.DB.prepare,batch:f.env.DB.batch}},undefined,{verifyToken:async t=>{const [uid,email]=t.split('|');return {sub:uid,email,email_verified:true};}});return {...await r.json(),status:r.status};};
  fakeVision();const dup=await call('other|other@unit.test','/api/tech/apply',form());assert.equal(dup.status,409,'the same card on another account is still caught after the upgrade');
  for(const t of ['tech_applications','tech_identity_claims'])assert.match(f.sqlite.prepare(`SELECT id_hash FROM ${t}`).get().id_hash,/^h2:[0-9a-f]{64}$/,t);
  assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM tech_applications').all()).includes(legacy),'no unkeyed hash left behind');
});
test('staff rescreen also pulls the latest Didit result when the webhook never arrived',async()=>{
  fakeVision();const f=fixture(DIDIT);await diditApp(f);const seen=fakeDidit({status:'In Progress'});
  await f.call(USER,'/api/tech/apply/identity',{});seen.decision=approvedDecision();fakeVision();
  const ds=fakeDidit(approvedDecision());const r=await f.call(ADMIN,'/api/tech/rescreen',{uid:'applicant'});
  assert.equal(r.status,200);assert.equal(r.identity.status,'approved');assert.equal(r.identity.name,'สมชาย ใจดี');assert.equal(ds.decisions,1);
});
test('Didit hold: a later non-approved result pauses the shop and a later approval restores it — a staff suspension is never lifted by Didit',async()=>{
  fakeVision();const f=fixture(DIDIT);await diditApp(f);const seen=fakeDidit();
  const sid=(await f.call(USER,'/api/tech/apply/identity',{})).url.split('/').pop();
  assert.equal((await diditHook(f,sid)).status,200);
  const a=await staffView(f);assert.equal((await f.call(ADMIN,'/api/tech/review',review(a,{evidence:didEv()}))).status,200);
  const shop=()=>f.sqlite.prepare('SELECT id,suspended,id_hold FROM tech_profiles').get();
  assert.deepEqual({s:shop().suspended,h:shop().id_hold},{s:0,h:0});
  seen.decision=({...approvedDecision(),status:'In Review'});await diditHook(f,sid,{status:'In Review'});
  assert.deepEqual({s:shop().suspended,h:shop().id_hold},{s:1,h:1},'held because of identity');
  assert.equal((await f.call(USER,'/api/tech/me')).technician.identityHold,true);
  seen.decision=approvedDecision();assert.equal((await f.call(USER,'/api/tech/apply/identity/refresh',{})).identity.status,'approved');
  assert.deepEqual({s:shop().suspended,h:shop().id_hold},{s:0,h:0},'identity approved again → restored');
  assert.equal((await f.call(USER,'/api/tech/me')).technician.identityHold,false);
  assert.equal((await f.call(ADMIN,'/api/tech/moderate',{id:shop().id,suspend:true})).status,200);
  assert.deepEqual({s:shop().suspended,h:shop().id_hold},{s:1,h:0},'staff suspension');
  assert.equal((await f.call(USER,'/api/tech/apply/identity/refresh',{})).identity.status,'approved');
  assert.equal(shop().suspended,1,'Didit approval does not lift a staff suspension');
  seen.decision=({...approvedDecision(),status:'In Review'});await f.call(USER,'/api/tech/apply/identity/refresh',{});
  assert.deepEqual({s:shop().suspended,h:shop().id_hold},{s:1,h:0},'a staff suspension stays staff-owned when Didit also pauses');
  seen.decision=approvedDecision();await f.call(USER,'/api/tech/apply/identity/refresh',{});
  assert.equal(shop().suspended,1,'still suspended until staff lift it');
  assert.equal((await f.call(ADMIN,'/api/tech/moderate',{id:shop().id,suspend:false})).status,200);assert.equal(shop().suspended,0);
});
test('Didit unreachable on "check result": answers service_unavailable and changes nothing',async()=>{
  fakeVision();const f=fixture(DIDIT);await diditApp(f);fakeDidit({status:'In Progress'});
  await f.call(USER,'/api/tech/apply/identity',{});
  const before=JSON.stringify(f.sqlite.prepare('SELECT * FROM tech_identity').get());
  globalThis.fetch=async()=>{throw Error('network down');};
  const r=await f.call(USER,'/api/tech/apply/identity/refresh',{});
  assert.equal(r.status,200);assert.deepEqual(r.identity,{mode:'didit',status:'service_unavailable'});
  assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM tech_identity').get()),before);
  assert.equal((await f.call('','/api/tech/ping')).identityRequired,undefined);
});
