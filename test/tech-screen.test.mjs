import {test} from 'node:test';
import assert from 'node:assert/strict';
import {screenApplication,ageFromBirth,screeningSnapshot} from '../src/tech-screen.js';
import {applicantErrors,imageInfo,approvalError} from '../src/tech-vetting.js';
import {form,png,fakeGemini,evidence} from './tech-fixtures.mjs';
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
test('real multimodal request covers EVERY shop/work image and excludes identities even with legacy flag',async()=>{
  const seen=fakeGemini(),r=await screen({GEMINI_KEY:'mock',TECH_AI_IDS:'1'});assert.equal(r.status,'complete');assert.equal(r.verdict,'pass');assert.equal(r.score,null);
  assert.equal(r.images.length,4);const request=seen.requests[0],text=JSON.stringify(request);
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
  const resolutions=Object.fromEntries(r.flags.filter(x=>x.source==='vision').map(x=>[x.code,{outcome:'false_positive',note:'Human reviewer verified independent supporting work evidence; test only.'}]));
  assert.equal(approvalError({app,ai:r,snapshot:r.snapshot,evidence:evidence(),resolutions}), '');
});
test('snapshot/revision/evidence fail closed and deterministic bad data cannot be overridden',async()=>{
  fakeGemini();const r=await screen(),args={app,ai:r,snapshot:r.snapshot,evidence:evidence(),resolutions:{}};assert.equal(approvalError(args),'');
  assert.ok(approvalError({...args,snapshot:'changed'}));assert.ok(approvalError({...args,app:{...app,revision:2}}));assert.ok(approvalError({...args,evidence:{}}));
  const bad=await screen(undefined,{...app,data:JSON.stringify({...data,name:'Hasdjjgiohwigrs',years:1000})});assert.equal(bad.verdict,'fail');assert.ok(approvalError({...args,ai:bad,snapshot:bad.snapshot}));
  assert.notEqual(await screeningSnapshot(app,docs),await screeningSnapshot(app,[...docs].reverse()));
});
