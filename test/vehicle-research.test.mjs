import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {VEHICLE_RESEARCH_COVERAGE,canonicalMake,publicQuery,researchURL,discoveredLinks,publicResearch,soundResearchQuery} from '../src/vehicle-research.mjs';
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
  const links=discoveredLinks('<a href="https://evil.test/a">bad</a><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.thaihonda.co.th%2Fmanual">Honda manual</a>');
  assert.equal(links.length,1);assert.equal(links[0].url,'https://www.thaihonda.co.th/manual');
});
test('research reads bounded allowed pages with robots permission; PDFs/blocked pages remain unread',async t=>{
  const seen=[];t.mock.method(globalThis,'fetch',async url=>{seen.push(String(url));return new Response(String(url).endsWith('robots.txt')?'User-agent: *\nAllow: /':'<p>Honda Wave 110i 2023 owner manual maintenance information.</p>',{headers:{'Content-Type':'text/html'}})});
  const r=await publicResearch('Honda Wave 110i 2023 manual',{fetchSearch:async()=>'<a href="https://www.thaihonda.co.th/manual">Wave manual</a><a href="https://www.thaihonda.co.th/manual.pdf">PDF</a>'});
  assert.equal(r.status,'found');assert.equal(r.sources[0].status,'read');assert.match(r.sources[0].excerpt,/110i/);assert.equal(r.sources[1].status,'link_only');assert.deepEqual(r.verifiedModelFaults,[]);assert.ok(!seen.some(x=>x.endsWith('.pdf')));
});
test('publisher restrictions, oversized bodies, provider outage and cancellation fail closed without invented faults',async t=>{
  t.mock.method(globalThis,'fetch',async url=>new Response(String(url).endsWith('robots.txt')?'User-agent: Google-Extended\nDisallow: /':'secret page',{headers:{'Content-Type':'text/html'}}));
  const r=await publicResearch('Yamaha NMAX manual',{fetchSearch:async()=>'<a href="https://yamaha-motor.co.th/manual">Manual</a>'});assert.equal(r.sources[0].status,'restricted');assert.equal(r.status,'links_only');assert.equal(r.sources[0].excerpt,'');
  const ac=new AbortController();ac.abort();const cancelled=await publicResearch('Honda Wave manual',{signal:ac.signal});assert.equal(cancelled.status,'unavailable');
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
  const r=await worker.fetch(req('Honda Wave 110i 2023 manual',true),env(),{});assert.equal(r.status,200);assert.equal((await r.json()).status,'unavailable');assert.ok(seen.length);assert.ok(!seen.some(x=>/generativelanguage|openrouter|tavily|brave/.test(x)));
});
test('typed chat and live paths use separate free research, not just navigation to the app map',async()=>{
  const source=await readFile(new URL('../src/worker.js',import.meta.url),'utf8');assert.equal((source.match(/search: fresh, externalSearch: true/g)||[]).length,2);assert.match(source,/body.tool==='ear'\|\|body.tool==='listen'/);
});
