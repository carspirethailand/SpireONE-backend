import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {VEHICLE_RESEARCH_COVERAGE,canonicalMake,publicQuery,researchURL,publicResearch,soundResearchQuery} from '../src/vehicle-research.mjs';
import {resetSearchBreakers} from '../src/web-search.mjs';
import {cleanSound,captureInfo,soundGrounding} from '../src/vehicle-audio.mjs';
import {liveToken} from '../src/live-setup.mjs';
import worker from '../src/worker.js';
const context={audioVehicle:{version:1,source:'other_confirmed',vehicle:{make:'Honda',model:'Wave 110i',year:'2023'}},recording:{source:'dedicated_microphone',processing:{noiseSuppression:false,echoCancellation:false,autoGainControl:false}}};
const observed={quality:'noisy',evidence:'distinct',hear:'ได้ยินเสียงติ๊กโลหะเป็นจังหวะ แม้มีเสียงพื้นหลัง',normality:'unusual',causes:[{name:'ชุดวาล์วหรือชิ้นส่วนคลอน',likelihood:'possible',clue:'เสียงติ๊กโลหะซ้ำตามจังหวะ'}],urgency:'soon',next:['เกิดตอนเครื่องเย็นหรือร้อนครับ'],speak:'ได้ยินเสียงติ๊กผิดปกติ ควรให้ช่างตรวจต้นเสียงครับ'};
test('all 18 distinct requested makes have honest discovery status, never fictional all-model training',()=>{
  assert.equal(VEHICLE_RESEARCH_COVERAGE.length,18);
  for(const x of VEHICLE_RESEARCH_COVERAGE){assert.equal(x.validatedAudioModels,0);assert.equal(x.verifiedModelFaults,0);assert.match(x.models,/not_an_exhaustive/);assert.ok(x.hosts.length)}
  assert.equal(canonicalMake('Mitsubish'),'Mitsubishi');assert.equal(canonicalMake('mercedes-benz'),'Mercedes');
});
test('Wave 110i 2023 has fresh, explicit context and retains distinctive audible clues despite masking',()=>{
  const d=cleanSound(observed,context);assert.equal(d.identity.label,'Honda Wave 110i 2023');assert.equal(d.quality,'noisy');assert.equal(d.assessment,'possible_abnormality');assert.equal(d.causes.length,1);assert.equal(d.urgency,'soon');
  for(const quality of ['too_quiet','no_engine'])assert.equal(cleanSound({...observed,quality},context).causes.length,0);
  assert.equal(cleanSound({...observed,evidence:'limited'},context).causes.length,0);
});
test('dedicated recording is not falsely reported as telephone filtering; settings unknown stay unknown',()=>{
  const d=cleanSound({...observed,hear:'เสียงเครื่องร่วมกับโทรศัพท์ที่มีการกรองเสียง',speak:'กรุณาใช้โหมดบันทึกโดยตรงเพื่อเลี่ยงกรองเสียงจากการโทร'},context);
  assert.equal(d.falseProcessingClaim,true);assert.ok(!JSON.stringify([d.hear,d.speak,d.next]).includes('โทรศัพท์ที่มีการกรอง'));
  assert.deepEqual(captureInfo({recording:{source:'invented',processing:{noiseSuppression:'false',secret:'no'}}}),{source:'unknown',processing:{}});
  assert.equal(soundGrounding(context).recording.processing.noiseSuppression,false);
});
test('correct selected name is not rejected, but another make is',()=>{
  assert.equal(cleanSound({...observed,hear:'Honda Wave 110i มีเสียงติ๊กเป็นจังหวะ'},context).identityRejected,false);
  assert.equal(cleanSound({...observed,hear:'เสียงเครื่อง Toyota Fortuner'},context).identityRejected,true);
});
test('query projection does not export recording, notes, private Garage fields or mileage',()=>{
  const q=soundResearchQuery({vehicle:{...context.audioVehicle.vehicle,vin:'SECRET',phone:'SECRET',mileage:'99999'},transcript:'SECRET'});
  assert.match(q,/Honda Wave 110i 2023/);assert.ok(!q.includes('SECRET')&&!q.includes('99999'));
  for(const query of ['VIN JH4KA8260MC000000','call 0812345678','person@example.com','https://localhost/private','api_key SECRET'])assert.throws(()=>publicQuery(query));
  assert.equal(soundResearchQuery({vehicle:{make:'Honda',model:'secret@example.com'}}),'');
});
test('SSRF, lookalike domains, embedded credentials and arbitrary URLs never become fetched sources',()=>{
  for(const u of ['http://honda.com/a','https://honda.com.evil.test','https://127.0.0.1','https://honda.com:8443','https://key@honda.com/a','https://evil.test/a'])assert.equal(researchURL(u),null);
});
/* ค้นเอกสารผ่านตัวค้นของ AI (Exa ในเทสต์) เท่านั้น — ไม่ค้น DuckDuckGo/Bing และไม่เปิดหน้าเว็บเอง */
const EXA={EXA_API_KEY:'exa-test-only-fixture-key'};
test('research asks the keyed search for manufacturer documents only; provider page text counts as read, snippets stay link-only, other sites are dropped',async t=>{
  resetSearchBreakers();const seen=[];t.mock.method(globalThis,'fetch',async(url,init)=>{seen.push({url:String(url),body:JSON.parse(init.body)});return Response.json({results:[
    {title:'Wave manual',url:'https://www.thaihonda.co.th/manual',text:'Honda Wave 110i 2023 owner manual maintenance information. '.repeat(8)},
    {title:'Wave brochure',url:'https://www.thaihonda.co.th/brochure',highlights:['Wave 110i brochure']},
    {title:'Random blog',url:'https://evil.test/wave',text:'x'.repeat(400)}]})});
  const r=await publicResearch('Honda Wave 110i 2023 manual',{env:EXA});
  assert.deepEqual(seen.map(x=>x.url),['https://api.exa.ai/search'],'only the search API is called');
  assert.ok(seen[0].body.includeDomains.includes('thaihonda.co.th'),'limited to the maker\'s own sites');
  assert.equal(r.status,'found');assert.equal(r.sources.length,2);assert.equal(r.sources[0].status,'read');assert.match(r.sources[0].excerpt,/110i/);
  assert.equal(r.sources[1].status,'link_only');assert.equal(r.sources[1].excerpt,'');assert.ok(!r.sources.some(x=>x.url.includes('evil.test')));assert.deepEqual(r.verifiedModelFaults,[]);
});
test('no search key, provider outage and cancellation fail closed without invented sources or faults',async t=>{
  resetSearchBreakers();const seen=[];t.mock.method(globalThis,'fetch',async url=>{seen.push(String(url));return new Response('down',{status:503})});
  const none=await publicResearch('Yamaha NMAX manual');assert.equal(none.status,'unavailable');assert.equal(seen.length,0,'no key = nothing leaves the Worker');
  const down=await publicResearch('Yamaha NMAX manual',{env:EXA});assert.equal(down.status,'unavailable');assert.deepEqual(down.sources,[]);
  const ac=new AbortController();ac.abort();const cancelled=await publicResearch('Honda Wave manual',{env:EXA,signal:ac.signal});assert.equal(cancelled.status,'unavailable');
});
test('only new capable call clients get web_search; legacy schemas stay compatible',()=>{
  const names=o=>liveToken({model:'fixture',agent:true,...o}).bidiGenerateContentSetup.tools[0].functionDeclarations.map(x=>x.name);
  assert.ok(!names({}).includes('web_search'));assert.ok(names({webResearch:true}).includes('web_search'));assert.ok(!names({webResearch:'true'}).includes('web_search'));
});
function env(){return {DEV_AUTH:'1',FIREBASE_PROJECT_ID:'audio-test',DB:{prepare(sql){return {bind(){return this},async first(){return sql.includes('schema_version')?{value:'24'}:sql.includes('RETURNING count')?{count:1}:null},async run(){return {}},async all(){return {results:[]}}}}}};}
test('research endpoint requires login, rejects private queries and never calls a paid AI provider',async t=>{
  const seen=[];t.mock.method(globalThis,'fetch',async url=>{seen.push(String(url));return new Response('',{status:503})});
  const req=(query,auth)=>new Request('https://unit.test/api/ai/research',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer dev:reader:reader@unit.test'}:{})},body:JSON.stringify({query})});
  assert.equal((await worker.fetch(req('Honda Wave manual',false),env(),{})).status,401);
  assert.equal((await worker.fetch(req('person@example.com',true),env(),{})).status,400);
  const r=await worker.fetch(req('Honda Wave 110i 2023 manual',true),env(),{});assert.equal(r.status,200);assert.equal((await r.json()).status,'unavailable');assert.equal(seen.length,0,'no search key = no outbound request');
});
test('typed chat, LINE and live paths search through the keyed web search, never a Gemini Google Search tool',async()=>{
  const source=await readFile(new URL('../src/worker.js',import.meta.url),'utf8');
  assert.equal((source.match(/executeSearch: async \(q\) => await executeWebSearchTool\(/g)||[]).length,3);assert.doesNotMatch(source,/google_search: \{\}|externalSearch/);
  assert.match(source,/body.tool==='ear'\|\|body.tool==='listen'/);assert.match(source,/publicResearch\(query,\{env,/);
});
