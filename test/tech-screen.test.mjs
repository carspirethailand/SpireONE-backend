import {test} from 'node:test';
import assert from 'node:assert/strict';
import {screenApplication,ageFromBirth,screeningSnapshot,digits,thaiIdOk,nameMatch} from '../src/tech-screen.js';
import {applicantErrors,imageInfo,approvalError,VETTING_VERSION,CONSENT_VER} from '../src/tech-vetting.js';
import {diditFacts,diditStatus,identityFlags,verifyDidit,hmacHex,canonicalJson,idHashOf,upgradeHash} from '../src/tech-identity.js';
import {form,png,fakeVision,failVision,AI,evidence,idNotes} from './tech-fixtures.mjs';
const AT=Date.UTC(2026,9,1),data=form(),app={revision:1,test:0,data:JSON.stringify(data)},docs=data.docs.map((x,i)=>({kind:x.kind,mime:'image/png',data:x.data.split(',')[1],hash:'hash_'+i}));
const screen=(env={AI},a=app,images=docs)=>screenApplication(env,{app:a,docs:images},{at:AT});
const withData=over=>({...app,data:JSON.stringify({...data,...over})});
const notes=r=>({...idNotes({ai:r}),...Object.fromEntries(r.flags.filter(x=>x.source==='vision'&&x.level!=='low').map(x=>[x.code,{outcome:'false_positive',note:'Human reviewer verified independent supporting work evidence; test only.'}]))});
const imagesSent=seen=>seen.requests.flatMap(r=>r.messages.find(m=>m.role==='user').content.filter(c=>c.type==='image_url'));

test('names, impossible experience, malformed dates and mismatched age are caught',()=>{
  for(const d of [{name:'Hasdjjgiohwigrs'},{years:1000},{years:20},{years:2.5},{birth:'1996-02-31'},{birth:'2027-01-01'},{age:31},{phone:'0000000000'},{about:'random'}])assert.ok(applicantErrors({...data,...d},AT).length,JSON.stringify(d));
  assert.equal(applicantErrors(data,AT).length,0);assert.equal(ageFromBirth('2539-05-01',AT),30);
});
test('valid image headers/dimensions accepted; MIME spoof, tiny and truncated images rejected',()=>{
  const bytes=png();assert.deepEqual(imageInfo('image/png',bytes.toString('base64')),{width:400,height:300});
  assert.throws(()=>imageInfo('image/jpeg',bytes.toString('base64')));assert.throws(()=>imageInfo('image/png',png(1,50,50).toString('base64')));
  assert.throws(()=>imageInfo('image/png',bytes.subarray(0,40).toString('base64')));assert.throws(()=>imageInfo('image/jpeg',Buffer.from('random').toString('base64')));
});
test('Workers AI sees EVERY shop/work photo and never the ID card, selfie, ID number or name',async()=>{
  const seen=fakeVision(),r=await screen();assert.equal(r.status,'complete');assert.equal(r.score,null);assert.equal(r.images.length,4);
  assert.equal(seen.calls,2,'4 photos → batches of at most 3');assert.equal(imagesSent(seen).length,4);
  assert.match(seen.models[0],/^@cf\//);const text=JSON.stringify(seen.requests);
  assert.ok(!text.includes(data.idNo));assert.ok(!text.includes(data.name));assert.ok(!/"kind":"(id|selfie)"/.test(text),'identity documents never go to the AI');
  assert.ok(!text.includes(docs[0].data)&&!text.includes(docs[1].data),'ID card and selfie bytes are not sent');
  assert.match(seen.requests[0].messages[0].content,/UNTRUSTED/);
  assert.equal(r.identity.mode,'manual');assert.ok(r.flags.some(f=>f.code==='id_manual'&&f.source==='identity'),'without Didit staff must compare the card themselves');
});
test('all additional photos are covered instead of truncating',async()=>{
  const seen=fakeVision();const more=[...docs,...Array.from({length:3},(_,i)=>({kind:'work',mime:'image/png',data:'AAAA',hash:'extra_'+i}))];
  const r=await screen(undefined,app,more);assert.equal(r.images.length,7);assert.equal(seen.calls,3);
});
test('legacy incomplete evidence cannot pass after rescreening',async()=>{fakeVision();const r=await screen(undefined,app,docs.filter(x=>x.kind!=='id'));assert.equal(r.verdict,'fail');assert.ok(r.flags.some(x=>x.code==='document_count_id'));});
for(const [label,bad] of [['no images',()=>({images:[]})],['made-up id',out=>({...out,images:[{...out.images[0],imageId:'made-up'}]})],['second batch drops a photo',(out,n)=>n===1?{...out,images:[]}:out],['no summary',out=>({images:out.images,descriptionRelevant:'yes'})],['wrong kind',out=>({...out,images:out.images.map(x=>({...x,kind:'selfie'}))})],['not JSON',()=>'I cannot help with that']])
  test('malformed/incomplete AI result cannot pass: '+label,async()=>{fakeVision(bad);const r=await screen();assert.equal(r.status,'failed');assert.notEqual(r.verdict,'pass');
    assert.match(approvalError({app,ai:r,snapshot:r.snapshot,evidence:evidence(),resolutions:notes(r)}),/ตรวจ AI สำเร็จ/);});
test('AI is optional: no consent, old Gemini-era consent, no binding or switched off → nothing sent, staff review every photo',async()=>{
  for(const [env,a,why] of [[{AI},withData({aiConsent:false}),/ไม่ให้ AI/],[{AI},withData({consentVer:''}),/ไม่ให้ AI/],[{AI},withData({consentVer:'2026-08-gemini'}),/ไม่ให้ AI/],[{},app,/ยังไม่ได้เปิด/],[{AI,TECH_VISION_OFF:'1'},app,/ยังไม่ได้เปิด/]]){
    const seen=fakeVision(),r=await screen(env,a);assert.equal(seen.calls,0);assert.equal(r.status,'skipped');assert.match(r.error,why);
    const f=r.flags.find(x=>x.code==='ai_skipped');assert.ok(f&&f.level==='medium','staff must record their own photo review');
    assert.ok(approvalError({app:a,ai:r,snapshot:r.snapshot,evidence:evidence(),resolutions:idNotes({ai:r})}),'no silent approval');
    assert.equal(approvalError({app:a,ai:r,snapshot:r.snapshot,evidence:evidence(),resolutions:notes(r)}),'','approvable once staff record the photo review');
  }
});
test('AI outage fails closed and never leaks provider details',async()=>{
  const seen=failVision();const r=await screen();assert.equal(seen.calls,2);assert.equal(r.status,'failed');assert.ok(!r.error.includes('private'));assert.notEqual(r.verdict,'pass');
});
test('non-repair or uncertain images require meaningful human review, not automatic rejection',async()=>{
  fakeVision(out=>({...out,images:out.images.map(x=>({...x,relevance:'unrelated',concern:true,note:'Mock: unrelated screenshot'}))}));const r=await screen();assert.equal(r.status,'complete');assert.equal(r.verdict,'review');assert.equal(r.flags.filter(x=>x.source==='vision').length,8);
  assert.ok(approvalError({app,ai:r,snapshot:r.snapshot,evidence:evidence(),resolutions:{}}));
  assert.equal(approvalError({app,ai:r,snapshot:r.snapshot,evidence:evidence(),resolutions:notes(r)}),'');
});
test('snapshot/revision/version/evidence fail closed and deterministic bad data cannot be overridden',async()=>{
  fakeVision();const r=await screen(),args={app,ai:r,snapshot:r.snapshot,evidence:evidence(),resolutions:idNotes({ai:r})};assert.equal(approvalError(args),'');
  assert.ok(approvalError({...args,resolutions:{}}),'staff must record the manual ID comparison');
  assert.ok(approvalError({...args,snapshot:'changed'}));assert.ok(approvalError({...args,app:{...app,revision:2}}));assert.ok(approvalError({...args,evidence:{}}));
  assert.ok(approvalError({...args,ai:{...r,policyVersion:VETTING_VERSION-1}}),'results from the Gemini-era policy must be rescreened');
  assert.match(approvalError({...args,evidence:{...evidence(),identity:{method:'didit',note:'Didit said ok for this test only.'}}}),/ไม่ได้ยืนยันตัวตนผ่าน Didit/);
  const bad=await screen(undefined,withData({name:'Hasdjjgiohwigrs',years:1000}));assert.equal(bad.verdict,'fail');assert.ok(approvalError({...args,ai:bad,snapshot:bad.snapshot}));
  assert.notEqual(await screeningSnapshot(app,docs),await screeningSnapshot(app,[...docs].reverse()));
});

/* ── Didit: บัตร/หน้า/ชื่อ/อายุตรวจที่ Didit · ใบสมัครอนุมัติได้เมื่อ Didit ผ่านเท่านั้น ── */
const dApp=withData({idMode:'didit',idNo:undefined,idConsent:undefined,diditConsent:true}),dDocs=docs.filter(x=>!['id','selfie'].includes(x.kind));
const ok={status:'approved',name:'สมชาย ใจดี',birth:'1996-05-01',idKey:'1101700203450'};
test('Didit mode: no ID photos kept, no manual-ID flag, approval waits for Didit',async()=>{
  fakeVision();const r=await screen(undefined,dApp,dDocs);assert.equal(r.identity.mode,'didit');assert.equal(r.verdict,'pass');assert.ok(!r.flags.some(f=>f.source==='identity'));
  const args={app:dApp,ai:r,snapshot:r.snapshot,evidence:{...evidence(),identity:{method:'didit',note:'Didit approved; test-only record.'}},resolutions:{}};
  for(const status of ['none','pending','review','declined','expired'])assert.match(approvalError({...args,identity:{status,flags:[]}}),/Didit/,status);
  assert.equal(approvalError({...args,identity:{status:'approved',flags:identityFlags(ok,JSON.parse(dApp.data),AT)}}),'');
  const old=await screen(undefined,dApp,docs);assert.ok(old.flags.some(f=>f.code==='document_count_id'),'Didit-mode applications must not carry ID photos');
});
test('Didit facts: under 18 blocks; name/birth differences need a staff note; other-script names only inform',()=>{
  const d=JSON.parse(dApp.data),codes=f=>identityFlags(f,d,AT).map(x=>x.code+':'+x.level+(x.block?':block':''));
  assert.deepEqual(codes(ok),[]);
  assert.deepEqual(codes({...ok,birth:'2010-01-01'}),['id_underage:high:block','id_birth:medium']);
  assert.deepEqual(codes({...ok,name:'สมศรี ใจดี'}),['id_name:medium']);
  assert.deepEqual(codes({...ok,name:'Somchai Jaidee'}),['id_name_script:low']);
  assert.deepEqual(codes({...ok,name:'นาย สมชาย  ใจดี'}),[],'titles and spacing are ignored');
  assert.deepEqual(codes({...ok,idKey:''}),['id_number_missing:medium']);
  assert.deepEqual(codes({...ok,status:'declined'}),[],'not approved → handled by the status gate');
});
test('Didit decision parsing is tolerant and keeps only what we need',()=>{
  const f=diditFacts({status:'Approved',id_verification:{first_name:'สมชาย',last_name:'ใจดี',date_of_birth:'2539-05-01',personal_number:'1-1017-00203-45-0',portrait_image:'https://x/y.jpg',address:'secret'}});
  assert.deepEqual(f,{status:'approved',name:'สมชาย ใจดี',birth:'1996-05-01',idKey:'1101700203450',last3:'450'});
  assert.equal(diditFacts({status:'Approved',id_verifications:[{full_name:'A B',document_number:'AB 123456'}]}).idKey,'::AB123456');
  assert.equal(diditFacts({}).status,'pending');
  for(const [s,v] of [['Approved','approved'],['Declined','declined'],['In Review','review'],['Not Started','pending'],['In Progress','pending'],['Abandoned','expired'],['Expired','expired'],['Kyc Expired','expired'],['Resubmitted','pending'],['Awaiting User','pending'],['weird','pending']])assert.equal(diditStatus(s),v,s);
});
test('webhook signature: raw-body or sorted-key signature, fresh timestamp, constant secret',async()=>{
  const secret='whsec',body={b:1,a:{z:'ไทย',y:[2,1]},session_id:'s1'},raw=JSON.stringify(body),now=Date.UTC(2026,9,1),ts=String(now/1000);
  const h=o=>new Headers(o);
  assert.equal(await verifyDidit(secret,raw,h({'X-Timestamp':ts,'X-Signature':await hmacHex(secret,raw)}),now),true);
  assert.equal(canonicalJson(body),'{"a":{"y":[2,1],"z":"ไทย"},"b":1,"session_id":"s1"}');
  assert.equal(await verifyDidit(secret,raw,h({'X-Timestamp':ts,'X-Signature-V2':await hmacHex(secret,canonicalJson(body))}),now),true);
  assert.equal(await verifyDidit(secret,raw,h({'X-Timestamp':ts,'X-Signature':await hmacHex('wrong',raw)}),now),false);
  assert.equal(await verifyDidit(secret,raw+' ',h({'X-Timestamp':ts,'X-Signature':await hmacHex(secret,raw)}),now),false,'tampered body');
  assert.equal(await verifyDidit(secret,raw,h({'X-Timestamp':String(now/1000-301),'X-Signature':await hmacHex(secret,raw)}),now),false,'replayed after 5 minutes');
  assert.equal(await verifyDidit(secret,raw,h({'X-Signature':await hmacHex(secret,raw)}),now),false,'no timestamp');
  assert.equal(await verifyDidit('',raw,h({'X-Timestamp':ts,'X-Signature':'00'}),now),false,'no secret configured');
});
test('ID hash: keyed HMAC when ID_HASH_KEY is set, and legacy hashes upgrade to the same value',async()=>{
  const legacy=await idHashOf({},'1101700203450'),keyed=await idHashOf({ID_HASH_KEY:'k1'},'1101700203450');
  assert.match(legacy,/^[0-9a-f]{64}$/);assert.match(keyed,/^h2:[0-9a-f]{64}$/);
  assert.equal(await upgradeHash({ID_HASH_KEY:'k1'},legacy),keyed,'migrated rows still match new applications');
  assert.notEqual(await idHashOf({ID_HASH_KEY:'k2'},'1101700203450'),keyed);
});
test('helpers: Thai numerals, checksum, name matching',()=>{
  assert.equal(digits('๑-๑๐๑๗-๐๐๒๐๓-๔๕-๐'),'1101700203450');assert.equal(thaiIdOk('1101700203450'),true);assert.equal(thaiIdOk('1101700203451'),false);
  assert.equal(nameMatch('นายสมชาย ใจดี','สมชาย ใจดี'),true);assert.equal(nameMatch('สมชาย ใจดี','สมศรี ใจดี'),false);assert.equal(nameMatch('','x'),null);
  assert.equal(CONSENT_VER.length>0,true);
});
