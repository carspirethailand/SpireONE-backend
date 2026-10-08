import {test} from 'node:test';
import assert from 'node:assert/strict';
import {screenApplication,ageFromBirth,screeningSnapshot,digits,thaiIdOk,cardExpired} from '../src/tech-screen.js';
import {applicantErrors,imageInfo,approvalError} from '../src/tech-vetting.js';
import {form,png,fakeGemini,fakeGeminiAll,evidence,idNotes} from './tech-fixtures.mjs';
const AT=Date.UTC(2026,9,1),data=form(),app={revision:1,test:0,data:JSON.stringify(data)},docs=data.docs.map((x,i)=>({kind:x.kind,mime:'image/png',data:x.data.split(',')[1],hash:'hash_'+i}));
const screen=(env={GEMINI_KEY:'mock'},a=app,images=docs)=>screenApplication(env,{app:a,docs:images},{at:AT});
test('names, impossible experience, malformed dates and mismatched age are caught',()=>{
  for(const d of [{name:'Hasdjjgiohwigrs'},{years:1000},{years:20},{years:2.5},{birth:'1996-02-31'},{birth:'2027-01-01'},{age:31},{phone:'0000000000'},{about:'random'}])assert.ok(applicantErrors({...data,...d},AT).length,JSON.stringify(d));
  assert.equal(applicantErrors(data,AT).length,0);assert.equal(ageFromBirth('2539-05-01',AT),30);
});
test('valid image headers/dimensions accepted; MIME spoof, tiny and truncated images rejected',()=>{
  const bytes=png();assert.deepEqual(imageInfo('image/png',bytes.toString('base64')),{width:400,height:300});
  assert.throws(()=>imageInfo('image/jpeg',bytes.toString('base64')));assert.throws(()=>imageInfo('image/png',png(1,50,50).toString('base64')));
  assert.throws(()=>imageInfo('image/png',bytes.subarray(0,40).toString('base64')));assert.throws(()=>imageInfo('image/jpeg',Buffer.from('random').toString('base64')));
});
test('shop/work request covers EVERY image and never includes identity; ID card goes in its own request only with TECH_AI_IDS=1 + consent',async()=>{
  const seen=fakeGeminiAll(),r=await screen({GEMINI_KEY:'mock',TECH_AI_IDS:'1'});assert.equal(r.status,'complete');assert.equal(r.verdict,'pass');assert.equal(r.score,null);
  assert.equal(r.identity.result,'match');assert.equal(seen.card.length,1);assert.equal(seen.card[0].contents[0].parts.filter(x=>x.inlineData).length,1,'ID request carries only the ID card');
  assert.equal(seen.face.length,0,'no face comparison without separate consent');
  assert.equal(r.images.length,4);const request=seen.work[0],text=JSON.stringify(request);
  assert.equal(request.contents[0].parts.filter(x=>x.inlineData).length,4);assert.ok(!text.includes(data.idNo));assert.ok(!text.includes(data.name));
  assert.ok(!request.contents[0].parts.some(x=>x.text&&/"kind":"(id|selfie)"/.test(x.text)));assert.ok(request.generationConfig.responseSchema);assert.match(request.systemInstruction.parts[0].text,/UNTRUSTED/);
});
test('all additional photos are covered instead of truncating to first seven',async()=>{fakeGemini();const more=[...docs,...Array.from({length:3},(_,i)=>({kind:'work',mime:'image/png',data:'AAAA',hash:'extra_'+i}))];const r=await screen(undefined,app,more);assert.equal(r.images.length,7);});
test('legacy incomplete evidence cannot pass after rescreening',async()=>{fakeGemini();const r=await screen(undefined,app,docs.filter(x=>x.kind!=='id'));assert.equal(r.verdict,'fail');assert.ok(r.flags.some(x=>x.code==='document_count_id'));});
for(const bad of [{images:[]},{images:[{imageId:'made-up',kind:'work',relevance:'relevant',concern:false,note:''}]},{descriptionRelevant:'yes',images:[]},{summary:'nothing checked'}])test('malformed/incomplete AI result cannot pass: '+JSON.stringify(bad),async()=>{fakeGemini(()=>bad);const r=await screen();assert.equal(r.status,'failed');assert.notEqual(r.verdict,'pass');});
test('quota, absent key and missing consent never create a successful AI check',async()=>{
  globalThis.fetch=async()=>new Response('private provider details',{status:429});let r=await screen();assert.equal(r.status,'failed');assert.ok(!r.error.includes('private'));
  r=await screen({});assert.equal(r.status,'unavailable');r=await screen({GEMINI_KEY:'mock'}, {...app,data:JSON.stringify({...data,aiConsent:false})});assert.equal(r.status,'unavailable');
});
test('non-repair or uncertain images require meaningful human review, not automatic rejection',async()=>{
  fakeGemini(out=>({...out,images:out.images.map(x=>({...x,relevance:'unrelated',concern:true,note:'Mock: unrelated screenshot'}))}));const r=await screen();assert.equal(r.status,'complete');assert.equal(r.verdict,'review');assert.equal(r.flags.filter(x=>x.source==='vision').length,8);
  assert.ok(approvalError({app,ai:r,snapshot:r.snapshot,evidence:evidence(),resolutions:{}}));
  const resolutions={...idNotes({ai:r}),...Object.fromEntries(r.flags.filter(x=>x.source==='vision').map(x=>[x.code,{outcome:'false_positive',note:'Human reviewer verified independent supporting work evidence; test only.'}]))};
  assert.equal(approvalError({app,ai:r,snapshot:r.snapshot,evidence:evidence(),resolutions}), '');
});
test('snapshot/revision/evidence fail closed and deterministic bad data cannot be overridden',async()=>{
  fakeGemini();const r=await screen(),args={app,ai:r,snapshot:r.snapshot,evidence:evidence(),resolutions:idNotes({ai:r})};assert.equal(approvalError(args),'');
  assert.ok(approvalError({...args,resolutions:{}}),'with AI ID check off, staff must record the manual ID-number comparison');
  assert.ok(approvalError({...args,snapshot:'changed'}));assert.ok(approvalError({...args,app:{...app,revision:2}}));assert.ok(approvalError({...args,evidence:{}}));
  const bad=await screen(undefined,{...app,data:JSON.stringify({...data,name:'Hasdjjgiohwigrs',years:1000})});assert.equal(bad.verdict,'fail');assert.ok(approvalError({...args,ai:bad,snapshot:bad.snapshot}));
  assert.notEqual(await screeningSnapshot(app,docs),await screeningSnapshot(app,[...docs].reverse()));
});

/* ── ด่านบัตรประชาชน: เลขบนรูปบัตรต้องตรงกับที่กรอก ── */
const IDS={GEMINI_KEY:'mock',TECH_AI_IDS:'1'},TYPED='1101700203450',OTHER='3100500123458';
const blocked=r=>r.flags.filter(f=>f.block).map(f=>f.code).sort();
test('helpers: Thai numerals, checksum, expiry incl. Buddhist era and lifelong',()=>{
  assert.equal(digits('๑-๑๐๑๗-๐๐๒๐๓-๔๕-๐'),TYPED);assert.equal(thaiIdOk(TYPED),true);assert.equal(thaiIdOk('1101700203451'),false);
  assert.equal(cardExpired('2020-01-01',AT),true);assert.equal(cardExpired('2575-01-01',AT),false);assert.equal(cardExpired('lifelong',AT),false);assert.equal(cardExpired('',AT),false);
});
test('card number matches on first read → no extra AI call, pass',async()=>{
  const seen=fakeGeminiAll();const r=await screen(IDS);assert.equal(r.identity.result,'match');assert.equal(seen.ocr.length,0);assert.deepEqual(blocked(r),[]);assert.equal(r.verdict,'pass');
});
test('first read wrong, focused re-read matches → no false rejection',async()=>{
  const seen=fakeGeminiAll({card:{idNumber:'1101700203460'},ocr:{idNumber:TYPED,clear:true}});const r=await screen(IDS);
  assert.equal(seen.ocr.length,1);assert.equal(r.identity.result,'match');assert.deepEqual(blocked(r),[]);
});
test('Thai numerals from AI still match',async()=>{fakeGeminiAll({card:{idNumber:'๑๑๐๑๗๐๐๒๐๓๔๕๐'}});assert.equal((await screen(IDS)).identity.result,'match');});
test('card shows a different valid number → hard block id_mismatch, only last 4 digits kept',async()=>{
  fakeGeminiAll({card:{idNumber:OTHER},ocr:{idNumber:OTHER,clear:true}});const r=await screen(IDS);
  assert.deepEqual(blocked(r),['id_mismatch']);assert.equal(r.verdict,'fail');assert.equal(r.identity.last4,'3458');assert.ok(!JSON.stringify(r).includes(OTHER));
  assert.match(approvalError({app,ai:r,snapshot:r.snapshot,evidence:evidence(),resolutions:{}}),/อนุมัติไม่ได้/);
});
test('number unreadable on both reads → block id_unreadable (retake photo)',async()=>{
  fakeGeminiAll({card:{idNumber:''}});assert.deepEqual(blocked(await screen(IDS)),['id_unreadable']);
});
test('expired card, photo of a screen, not an ID card → hard blocks',async()=>{
  fakeGeminiAll({card:{expiry:'2024-03-01'}});assert.deepEqual(blocked(await screen(IDS)),['id_expired']);
  fakeGeminiAll({card:{photoOfScreenOrCopy:true}});assert.deepEqual(blocked(await screen(IDS)),['id_not_original']);
  fakeGeminiAll({card:{isThaiIdCard:false}});assert.deepEqual(blocked(await screen(IDS)),['id_not_card']);
});
test('face comparison runs only with separate consent; mismatch is flagged for humans, never auto-blocked',async()=>{
  const withFace={revision:1,test:0,data:JSON.stringify({...data,faceConsent:true})};
  let seen=fakeGeminiAll({face:{personHoldingCard:true,samePerson:'no',cardNumberInSelfie:''}});let r=await screen(IDS,withFace);
  assert.equal(seen.face.length,1);assert.equal(seen.face[0].contents[0].parts.filter(x=>x.inlineData).length,2);
  assert.ok(r.flags.some(f=>f.code==='face_mismatch'&&f.level==='high'&&!f.block));assert.deepEqual(blocked(r),[]);
  seen=fakeGeminiAll({face:{personHoldingCard:true,samePerson:'yes',cardNumberInSelfie:OTHER}});r=await screen(IDS,withFace);
  assert.ok(r.flags.some(f=>f.code==='selfie_other_card'));
});
test('AI ID check off or AI down → no auto-block; ID AI failure cannot be approved until rescreen',async()=>{
  fakeGemini();let r=await screen();assert.equal(r.identity.status,'off');assert.ok(r.flags.some(f=>f.code==='id_manual'));assert.deepEqual(blocked(r),[]);
  globalThis.fetch=async()=>new Response('quota',{status:429});r=await screen(IDS);assert.deepEqual(blocked(r),[]);assert.notEqual(r.status,'complete');
});
