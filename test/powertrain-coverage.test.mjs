import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ENGINE_PARTS,ENGINE_BAY_SCHEMA,ENGINE_BAY_PROMPT,ENGINE_CATALOGUE_VERSION,POWERTRAIN_FAMILIES,partInfo,cleanEngineScan} from '../src/engine-bay.mjs';
import {POWERTRAIN_EXTRA_ROWS,POWERTRAIN_RULES} from '../src/powertrain-catalog.mjs';
import {buildFeatureRequest} from '../src/features-ai.mjs';
const item=(part,extra={})=>({part,box_2d:[100,100,300,400],certainty:'high',visibility:'visible',evidence:'Clearly visible identifying structure',...extra});
const frame=(items,extra={})=>({scene:'engine_bay',quality:'clear',vehicleKind:'motorcycle',powertrain:'combustion',view:'motorcycle_side',items,...extra});
test('catalogue is unique, bounded and bilingual; every new ID is accepted by the existing client ID grammar',()=>{
  assert.equal(ENGINE_CATALOGUE_VERSION,3);assert.equal(POWERTRAIN_FAMILIES.length,8);
  assert.equal(new Set(POWERTRAIN_EXTRA_ROWS.map(x=>x[0])).size,POWERTRAIN_EXTRA_ROWS.length);
  for(const [id,p]of Object.entries(ENGINE_PARTS)){
    assert.match(id,/^[a-z_]{2,30}$/);assert.ok(p.cue&&p.whatTh&&p.whatEn);
    assert.ok(p.th.length<=50&&p.en.length<=50);
    assert.match(partInfo(id,'th').check,/ห้าม|ไม่เปิด/);
    assert.match(partInfo(id,'en').check,/do not|Do not/);
  }
});
test('larger coverage retains the proven portable provider schema and fits the actual caller system budget',()=>{
  const r=buildFeatureRequest({tool:'baylive',scanVersion:2,attachments:[{mime:'image/jpeg',b64:'aA=='}]});
  assert.ok(r.system.length<8000);assert.equal(r.timeoutMs,18000);assert.equal(r.maxTokens,3600);
  assert.ok(!JSON.stringify(ENGINE_BAY_SCHEMA).includes('minItems'));assert.ok(!JSON.stringify(ENGINE_BAY_SCHEMA).includes('maxItems'));
  assert.equal(ENGINE_BAY_SCHEMA.properties.items.items.properties.part.enum.length,129);
  for(const key of ['vehicleKind','powertrain','view'])assert.ok(ENGINE_BAY_SCHEMA.required.includes(key));
  for(const phrase of ['motorcycle','CVT','washer_filler','battery_cover','valve_cover','dipstick_unknown','already exposed','cutaway illustration','never evidence that a hidden component exists','NOT measured accuracy'])assert.ok(ENGINE_BAY_PROMPT.includes(phrase),phrase);
});
test('motorcycle exterior parts can be identified but never relabelled onto cars or unknown vehicles',()=>{
  const ids=[...POWERTRAIN_RULES.motorcycleOnly].filter(x=>!POWERTRAIN_RULES.exposedOnly.has(x)&&!POWERTRAIN_RULES.reviewOnly.has(x));
  const accepted=cleanEngineScan(frame(ids.map(x=>item(x))),'en');assert.equal(accepted.items.length,ids.length);assert.equal(accepted.vehicleKind,'motorcycle');
  for(const vehicleKind of ['car','unknown','<script>']){
    const d=cleanEngineScan(frame(ids.map(x=>item(x)),{vehicleKind}));assert.equal(d.items.length,0);assert.equal(d.uncertain,ids.length);
  }
});
test('internal parts require an already exposed real view and explicit visibility; no high-certainty see-through boxes',()=>{
  for(const id of POWERTRAIN_RULES.exposedOnly){
    assert.equal(cleanEngineScan(frame([item(id)])).items.length,0,id);
    assert.equal(cleanEngineScan(frame([item(id)],{view:'exposed_internal'})).items.length,1,id);
    for(const visibility of ['partial','hidden',undefined])assert.equal(cleanEngineScan(frame([item(id,{visibility})],{view:'exposed_internal'})).items.length,0,id);
  }
});
test('known failures in real Wave references cannot become confirmed foot-control boxes even if the provider insists',()=>{
  for(const id of POWERTRAIN_RULES.reviewOnly){
    assert.ok(!ENGINE_BAY_SCHEMA.properties.items.items.properties.part.enum.includes(id));
    const d=cleanEngineScan(frame([item(id)]));assert.equal(d.items.length,0);assert.equal(d.uncertain,1);
  }
});
test('hidden and non-engine observations cannot gain boxes; EV electronics retain independent HV safety',()=>{
  assert.equal(cleanEngineScan(frame([item('battery',{visibility:'hidden'})])).items.length,0);
  for(const scene of ['not_car','car_other'])assert.equal(cleanEngineScan(frame([item('cvt_cover')],{scene})).items.length,0);
  for(const id of POWERTRAIN_RULES.highVoltage){const p=partInfo(id,'en');assert.equal(p.hazard,'high_voltage');assert.match(p.check,/EV-qualified/);}
});
test('covers, fairings and battery lids never authorise disassembly, even when no inner part is found',()=>{
  for(const id of ['engine_cover','valve_cover','battery_cover','service_panel','cvt_cover','clutch_cover']){
    const d=cleanEngineScan(frame([item(id)]));assert.equal(d.items.length,1);assert.equal(d.coverGuidance.maySuggestRemoval,false);assert.equal(d.coverGuidance.coverVisible,true);assert.match(d.coverGuidance.message,/ไม่แตะหรือถอด/);
  }
  assert.equal(cleanEngineScan(frame([])).coverGuidance.maySuggestRemoval,false);
});
test('tank versus filler, coil versus plug cap and closed CVT versus variator remain distinct concepts',()=>{
  assert.notEqual(partInfo('washer_tank').name,partInfo('washer_filler').name);
  assert.notEqual(partInfo('cvt_cover').name,partInfo('cvt_variator').name);
  assert.notEqual(partInfo('spark_plug_cap').name,partInfo('spark_plug').name);
  assert.match(partInfo('battery_cover','en').what,/does not expose/);
  assert.match(partInfo('valve_cover','en').what,/not a decorative cover/);
});
test('Thai motorcycle coverage separates underbones, closed CVT, classic Vespa and electric bikes without model-based boxes',()=>{
  for(const name of ['Wave 110i/125i','Scoopy i','Click','PCX','Vespa Primavera/Sprint/GTS','Vespa PX','Fazzio','NMAX','Finn','MSX','Kawasaki'])assert.ok(ENGINE_BAY_PROMPT.includes(name),name);
  for(const rule of ['automatic variants exist','chain guard is NOT a visible chain','not proof of a high-voltage EV system','names differ by market and year','no battery chemistry, voltage or hidden location'])assert.ok(ENGINE_BAY_PROMPT.includes(rule),rule);
  const r=buildFeatureRequest({tool:'baylive',scanVersion:2,context:{car:{make:'Porsche',model:'Cayenne'}},attachments:[{mime:'image/jpeg',b64:'aA=='}]});
  assert.ok(r.system.length<8000);assert.match(r.system,/photographed vehicle may differ/);
});
