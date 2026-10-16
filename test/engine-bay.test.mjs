import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {ENGINE_PARTS,ENGINE_SCAN_MAX,ENGINE_BAY_PROMPT,ENGINE_BAY_SCHEMA,partInfo,cleanEngineScan} from '../src/engine-bay.mjs';
import {buildFeatureRequest,cleanFeatureJson} from '../src/features-ai.mjs';
const image={mime:'image/jpeg',b64:'aGVsbG8='};
const item=(extra={})=>({part:'battery',certainty:'high',evidence:'Visible case and two terminals',box_2d:[100,100,350,400],...extra});
const scan=(items=[item()],extra={})=>({scene:'engine_bay',quality:'clear',items,...extra});
const request=(extra={})=>buildFeatureRequest({tool:'baylive',scanVersion:2,attachments:[image],...extra});

test('42 distinct component types with owned bilingual labels and safety; prototype IDs cannot resolve',()=>{
  assert.equal(Object.keys(ENGINE_PARTS).length,42);
  for(const id of Object.keys(ENGINE_PARTS))for(const lang of ['th','en']){
    const p=partInfo(id,lang);assert.ok(p.name&&p.what&&p.check);assert.equal(p.part,id);
    assert.match(p.check,lang==='en'?/do not|Do not/:/ห้าม|ไม่เปิด/);
  }
  assert.equal(partInfo('__proto__'),null);assert.equal(partInfo('constructor'),null);
  assert.equal(partInfo('hv_cable','en').hazard,'high_voltage');
  assert.match(partInfo('coolant_cap','en').check,/do not open caps/);
});
test('versioned multimodal request has all recognition rules, fixed schema and bounded latency; fits actual 8K system limit',()=>{
  const r=request();assert.equal(r.schema,ENGINE_BAY_SCHEMA);assert.equal(r.search,false);assert.equal(r.timeoutMs,18000);
  assert.equal(r.maxTokens,3600);assert.ok(r.system.length<8000);assert.equal(r.contents[0].parts[1].inlineData.data,image.b64);
  for(const word of ['hose_unknown','42','not a trained'])if(word!=='hose_unknown')assert.ok(!ENGINE_BAY_PROMPT.includes(word));
  for(const rule of [/never evidence that a hidden component exists/,/visible polarity marking/,/colour alone/,/NOT measured accuracy/,/untrusted data/,/never copy them/,/0-1000/])assert.match(r.system,rule);
  assert.equal(r.schema.properties.items.maxItems,24);assert.deepEqual(r.schema.properties.items.items.properties.part.enum,Object.keys(ENGINE_PARTS));
});
test('v2 accepts exactly one bounded image; no ambiguous multi-photo boxes or audio',()=>{
  assert.throws(()=>request({attachments:[]}),/exactly one image/);
  assert.throws(()=>request({attachments:[image,image]}),/exactly one image/);
  assert.throws(()=>request({attachments:[{mime:'audio/wav',b64:image.b64}]}),/exactly one image/);
  assert.throws(()=>request({attachments:[{...image,b64:'A'.repeat(2000004)}]}),/Media too large/);
});
test('only identified, evidenced high-certainty locations are published; no invented model repair instructions',()=>{
  const d=cleanEngineScan(scan([item({name:'Fake label',check:'Open the hot coolant cap',look:'damaged'}),item({part:'dipstick',certainty:'medium'}),item({part:'ecu',certainty:'low'}),item({part:'turbo',evidence:''}),item({part:'made_up_part'}),item({part:'__proto__'})]),'en');
  assert.equal(d.items.length,1);assert.equal(d.items[0].name,'12V battery');assert.equal(d.uncertain,3);
  assert.equal(d.scanVersion,2);assert.equal(d.items[0].look,undefined);assert.ok(!JSON.stringify(d).includes('Fake label'));
  assert.match(d.limitation,/not damage/);assert.deepEqual(d.notes,[]);assert.equal(d.speak,'');
});
test('bad, inverted, string, giant, out-of-frame or zero-area boxes are rejected rather than relocated',()=>{
  for(const b of [[-2,100,350,400],[500,0,200,300],[0,0,1000,1000],[1,1,2,2],[0,0,1001,10],[NaN,0,30,50],['100',0,300,500],[1,2,3]]){
    assert.equal(cleanEngineScan(scan([item({box_2d:b})])).items.length,0,String(b));
  }
});
test('deduplication removes the same object, preserves different same-type hoses and caps inside covers',()=>{
  const d=cleanEngineScan(scan([item(),item(),item({part:'engine_cover',box_2d:[300,400,900,950]}),item({part:'oil_cap',box_2d:[400,450,500,550]}),item({part:'radiator_hose',box_2d:[350,100,450,350]}),item({part:'radiator_hose',box_2d:[700,100,800,350]})]));
  assert.equal(d.items.length,5);assert.equal(d.items.filter(x=>x.part==='radiator_hose').length,2);
});
test('covers up to 24 real visible parts, not the legacy 12; unknown hose keeps its uncertainty in its name',()=>{
  const d=cleanEngineScan(scan(Object.keys(ENGINE_PARTS).map(part=>item({part}))), 'en');
  assert.equal(d.items.length,ENGINE_SCAN_MAX);assert.equal(partInfo('hose_unknown','en').name,'Unidentified hose');
});
test('dark, blurred, blocked and non-engine frames can never retain boxes, even with confident model output',()=>{
  for(const quality of ['dark','blurred','blocked'])assert.equal(cleanEngineScan(scan([item()],{quality})).items.length,0);
  for(const scene of ['car_other','not_car'])assert.equal(cleanEngineScan(scan([item()],{scene})).items.length,0);
  for(const d of [null,[],{},scan([], {quality:'unknown'}),scan(null)])assert.throws(()=>cleanEngineScan(d),/Incomplete/);
});
test('cleaner routes v2 explicitly and does not break legacy photo clients',()=>{
  const d=cleanFeatureJson('baylive',JSON.stringify(scan()),{scanVersion:2,lang:'en'});assert.equal(d.items[0].name,'12V battery');
  assert.throws(()=>cleanFeatureJson('baylive',{scene:'engine_bay',items:[{name:'Battery',box_2d:[10,10,100,100]}]},{scanVersion:2}),/Incomplete/);
  assert.equal(cleanFeatureJson('bay',{scene:'engine_bay',items:[{name:'Battery',box_2d:[10,10,100,100]}]}).items.length,1);
  assert.equal(buildFeatureRequest({tool:'baylive',attachments:[image]}).maxTokens,1800);
});
test('actual Gemini caller carries server schema on fallback, protects key in headers and passes a timeout signal',async()=>{
  const source=await readFile(new URL('../src/worker.js',import.meta.url),'utf8');
  const fragment=source.slice(source.indexOf('async function callGemini('),source.indexOf('/* Pulls the first JSON array'));
  const calls=[];
  const call=vm.runInNewContext(fragment+';callGemini',{AbortSignal,Date,Error,readUsage(){},fetch:async(url,init)=>{
    calls.push({url,init,body:JSON.parse(init.body)});
    return calls.length===1?new Response('{}',{status:400}):Response.json({candidates:[{content:{parts:[{text:JSON.stringify(scan())}]}}]});
  }});
  const r=await call({GEMINI_KEY:'unit-test-only-not-a-secret'},request());assert.ok(r.includes('engine_bay'));assert.equal(calls.length,2);
  for(const c of calls){assert.deepEqual(c.body.generationConfig.responseSchema,ENGINE_BAY_SCHEMA);assert.equal(c.init.headers['x-goog-api-key'],'unit-test-only-not-a-secret');assert.ok(!c.url.includes('key='));assert.ok(c.init.signal);}
  assert.ok(!calls.some(c=>c.body.tools));
});
