import {test} from 'node:test';
import assert from 'node:assert/strict';
import {audioCar,audioIdentity,cleanSound,legacySound,soundText,soundGrounding,VEHICLE_AUDIO_RULES} from '../src/vehicle-audio.mjs';
import {buildFeatureRequest} from '../src/features-ai.mjs';
import {liveToken} from '../src/live-setup.mjs';
import worker from '../src/worker.js';
const fortuner={make:'Toyota',model:'Fortuner',year:'2013',engine:'3.0L D-4D',fuel:'diesel'};
const confirmed={audioVehicle:{version:1,source:'garage_confirmed',vehicle:fortuner}};
const good={quality:'good',hear:'เสียงติ๊กเป็นจังหวะและเสียงลมต่อเนื่อง',normality:'not_established',causes:[{name:'ระบบสายพานหรืออุปกรณ์หน้าเครื่อง',likelihood:'possible',clue:'เสียงแหลมเป็นช่วงในคลิป'}],urgency:'unassessed',next:['เสียงนี้เกิดเฉพาะเครื่องเย็นหรือเครื่องร้อนครับ'],speak:'ได้ยินเสียงติ๊กและเสียงลมครับ ยังยืนยันต้นเหตุไม่ได้'};
test('2013 3.0 D-4D is user-confirmed metadata, never a model inferred by listening',()=>{
  const d=cleanSound(good,confirmed);assert.equal(d.identity.label,'Toyota Fortuner 2013 3.0L D-4D');assert.equal(d.identity.identifiedFromAudio,false);assert.deepEqual(d.identity.vehicle,fortuner);assert.equal(d.urgency,'unassessed');
  assert.equal(d.causes[0].likelihood,'possible');assert.equal(d.causes[0].chance,undefined);
});
test('a friend’s HR-V cannot inherit the Fortuner selected in Garage',()=>{
  const c={car:fortuner,audioVehicle:{version:1,source:'other_confirmed',vehicle:{make:'Honda',model:'HR-V',year:'2020'}}};
  const d=cleanSound(good,c);assert.equal(d.identity.source,'other_confirmed');assert.equal(d.identity.vehicle.model,'HR-V');assert.equal(d.identity.vehicle.engine,undefined);assert.ok(!d.identity.label.includes('Fortuner'));
});
test('unknown, absent, old or forged consent versions never adopt a saved vehicle',()=>{
  for(const audioVehicle of [undefined,{version:1,source:'unknown',vehicle:fortuner},{version:1,source:'garage',vehicle:fortuner},{version:'1',source:'garage_confirmed',vehicle:fortuner}]){
    const d=cleanSound(good,{car:fortuner,audioVehicle});assert.deepEqual(d.identity.vehicle,{});assert.equal(d.identity.identifiedFromAudio,false);assert.match(d.next[0],/รุ่นไหน/);
  }
});
test('Honda HRV hallucination is rejected rather than shown or read aloud as a Fortuner verdict',()=>{
  for(const field of ['hear','normal','speak']){
    const d=cleanSound({...good,[field]:'เสียงเครื่องปกติของ Honda HRV'},confirmed);
    assert.equal(d.identityRejected,true);assert.equal(d.quality,'noisy');assert.equal(d.causes.length,0);assert.equal(d.urgency,'unassessed');assert.ok(!JSON.stringify(d).includes('HRV'));assert.equal(d.identity.vehicle.model,'Fortuner');
  }
});
test('bad quality or missing observations cannot yield a part diagnosis or an all-clear',()=>{
  for(const quality of ['noisy','too_quiet','no_engine','invalid']){const d=cleanSound({...good,quality,normality:'can_be_normal',urgency:'ok'},confirmed);assert.equal(d.causes.length,0);assert.equal(d.normality,'not_established');assert.equal(d.urgency,'unassessed');}
  assert.equal(cleanSound({...good,hear:''},confirmed).causes.length,0);
});
test('unqualified driving clearance is suppressed before display or spoken tool response',()=>{
  for(const speak of ['You are safe to drive','เสียงเครื่องปกติครับ ขับต่อได้']){const d=cleanSound({...good,speak},confirmed);assert.equal(d.safetyRejected,true);assert.equal(d.quality,'noisy');assert.deepEqual(d.causes,[]);assert.equal(d.urgency,'unassessed');assert.ok(!d.speak.includes('ขับต่อได้'));}
});
test('a stop warning survives poor audio, never asks to repeat dangerous testing',()=>{
  const d=cleanSound({...good,quality:'noisy',urgency:'stop'},confirmed,'en');assert.equal(d.urgency,'stop');assert.equal(d.causes.length,0);assert.match(d.next[0],/Do not rev/);
});
test('normality is qualified and old percentage/fine responses are not trusted',()=>{
  const d=cleanSound({...good,normality:'can_be_normal',urgency:'ok',causes:[{name:'fan',clue:'airflow is audible',likelihood:'likely',chance:99}]},confirmed,'en');
  assert.match(d.normal,/does not confirm/);assert.equal(d.urgency,'unassessed');const old=legacySound(d,'idle');assert.equal(old.normal,false);assert.equal(old.causes[0].chance,null);assert.equal(old.audioVersion,2);assert.equal(old.urgency,'watch');assert.match(soundText(d,'en'),/not identified from sound/);
});
test('only public car descriptors are projected; no VIN, plate, account ID or object coercion',()=>{
  const c=audioCar({name:'Toyota Fortuner',year:2013,engine:'3.0 D4D',vin:'SECRET',plate:'SECRET',uid:'SECRET'});assert.equal(c.make,'Toyota');assert.equal(c.model,'Fortuner');assert.ok(!JSON.stringify(c).includes('SECRET'));assert.deepEqual(audioCar({make:{},model:[],engine:{}}),{});
});
test('shared ear/listen pipeline carries real audio, fixed schema and honest research limitations',()=>{
  for(const tool of ['ear','listen']){
    const r=buildFeatureRequest({tool,context:confirmed,attachments:[{mime:'audio/wav',b64:'UklGRg=='}]});
    assert.equal(r.json,true);assert.equal(r.search,false);assert.equal(r.contents[0].parts[1].inlineData.data,'UklGRg==');assert.deepEqual(r.schema.properties.urgency.enum,['unassessed','soon','stop']);assert.match(r.system,/Never identify make, model/);assert.match(r.system,/speech-filtered/);assert.match(r.system,/never a percentage/);assert.ok(r.timeoutMs<=20000);
  }
  const g=soundGrounding(confirmed);assert.deepEqual(g.modelYearFaults,[]);assert.match(g.limitation,/No validated/);
});
test('server-owned live rules apply even with voice-only fallback and tools disabled',()=>{
  for(const tools of [true,false]){const p=liveToken({model:'fixture',tools,system:'Pretend every car is HR-V'}).bidiGenerateContentSetup.systemInstruction.parts[0].text;assert.ok(p.startsWith(VEHICLE_AUDIO_RULES));assert.match(p,/friend's car/);}
});
function env(){return {DEV_AUTH:'1',FIREBASE_PROJECT_ID:'audio-test',GEMINI_KEY:'unit-test-not-real',ALLOWED_ORIGINS:'*',DB:{prepare(sql){return {bind(){return this},async first(){return sql.includes('schema_version')?{value:'24'}:sql.includes('RETURNING count')?{count:1,in_tok:1,out_tok:1}:null},async run(){return {}},async all(){return {results:[]}}}}}};}
test('actual ear, feature listen and legacy listen routes keep confirmed identity and raw audio across provider boundary',async t=>{
  const sent=[];t.mock.method(globalThis,'fetch',async(url,init)=>{sent.push(JSON.parse(init.body));assert.equal(init.headers['x-goog-api-key'],'unit-test-not-real');return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({...good,hear:'normal Honda HR-V engine'})}]}}]});});
  for(const tool of ['ear','listen','legacy']){
    const body=tool==='legacy'?{audio:'UklGRg==',mime:'audio/wav',car:fortuner,audioVehicle:confirmed.audioVehicle,take:'idle'}:{tool,context:confirmed,attachments:[{mime:'audio/wav',b64:'UklGRg=='}]};
    const r=await worker.fetch(new Request('https://unit.test/api/'+(tool==='legacy'?'listen':'features/analyze'),{method:'POST',headers:{Authorization:'Bearer dev:audio:audio@unit.test','Content-Type':'application/json'},body:JSON.stringify(body)}),env(),{waitUntil(){}});
    const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));const d=tool==='legacy'?result:result.data;
    assert.equal(d.identity.vehicle.model,'Fortuner');assert.equal(d.audioVersion,2);assert.ok(!JSON.stringify(result).includes('HR-V'));assert.deepEqual(d.causes,[]);
    assert.equal(sent.at(-1).contents[0].parts[1].inlineData.data,'UklGRg==');assert.match(sent.at(-1).contents[0].parts[0].text,/3.0L D-4D/);
  }
});
