import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {VEHICLE_ISSUES,modelIssueKnowledge,issueKnowledgeForQuery} from '../src/vehicle-issues.mjs';
import {soundGrounding} from '../src/vehicle-audio.mjs';
import {publicResearch,researchBlock,VEHICLE_RESEARCH_COVERAGE} from '../src/vehicle-research.mjs';
import {buildFeatureRequest} from '../src/features-ai.mjs';
const car=(patch={})=>({make:'Ford',model:'F-150',year:2018,engine:'3.5L EcoBoost',market:'US',...patch});
test('admission ledger never counts papers, event labels or curated documents as trained audio',async()=>{
  const r=JSON.parse(await readFile(new URL('../research/vehicle-audio-corpus-register-2026-10-18.json',import.meta.url),'utf8'));
  assert.equal(r.weightsTrained,false);assert.equal(r.audioDownloaded,false);assert.equal(r.admittedAudioFiles,0);
  assert.equal(r.requestedCars.length,10);assert.equal(r.requestedMotorcycles.length,9);
  assert.equal(r.manufacturerKnowledge.documents,VEHICLE_ISSUES.length);assert.equal(r.manufacturerKnowledge.audioTrainingLabels,0);
  assert.ok(r.sources.every(s=>s.reason&&s.url&&['not_admitted','excluded'].includes(s.status)));
});
test('every curated record has primary provenance and is explicitly not acoustic training, prevalence or diagnosis',()=>{
  assert.equal(VEHICLE_ISSUES.length,11);
  assert.equal(new Set(VEHICLE_ISSUES.map(r=>r.id)).size,11);
  for(const r of VEHICLE_ISSUES){
    assert.equal(new URL(r.url).hostname,'static.nhtsa.gov');assert.ok(r.document&&r.date&&r.checks.length);
    assert.equal(r.evidence,'manufacturer_document');assert.equal(r.audioTrainingLabel,false);assert.equal(r.prevalence,'not_established');
    assert.deepEqual(r.markets,['US']);assert.equal(Object.isFrozen(r.models),true);
  }
  assert.throws(()=>VEHICLE_ISSUES[0].markets.push('TH'));
  assert.equal(VEHICLE_RESEARCH_COVERAGE.find(x=>x.make==='Honda').curatedManufacturerDocuments,2);
  assert.equal(VEHICLE_RESEARCH_COVERAGE.find(x=>x.make==='Isuzu').curatedManufacturerDocuments,0);
});
test('confirmed public descriptors find documented candidates but never establish a fault',()=>{
  const r=modelIssueKnowledge(car());assert.equal(r.records.length,1);assert.equal(r.records[0].id,'ford-tsb-22-2200');
  assert.equal(r.records[0].status,'documented_candidate');assert.equal(r.records[0].diagnosis,false);
  assert.equal(r.records[0].applicability,'not_confirmed_for_this_vehicle');assert.match(r.records[0].checks[0],/2019-10-31/);
  assert.equal(modelIssueKnowledge(car({engine:'3.5 EcoBoost'})).records.length,1);
});
test('wrong market, year, model, engine or vehicle kind excludes the record rather than silently broadening it',()=>{
  for(const patch of [{market:'TH'},{market:'Thailand'},{market:'CA'},{year:2023},{model:'Ranger'},{model:'F-150 Raptor'},{engine:'2.0L diesel'},{engine:'3.0L EcoBoost'},{engine:'13.5L EcoBoost'},{kind:'motorcycle'}])assert.equal(modelIssueKnowledge(car(patch)).records.length,0,JSON.stringify(patch));
  for(const v of [{make:'Honda',model:'Wave 110i',year:2023},{make:'Honda',model:'HR-V',year:2011},{make:'Toyota',model:'Fortuner',year:2013,engine:'3.0L D-4D'},{make:'Porsche',model:'Cayenne',year:2018}])assert.equal(modelIssueKnowledge(v).records.length,0,JSON.stringify(v));
});
test('optional unknown engine and market do not block sound analysis; candidates identify missing scope',()=>{
  const r=modelIssueKnowledge(car({engine:'',market:''}));assert.deepEqual(r.records[0].missing,['engine','market']);assert.equal(r.records[0].status,'scope_check_required');
  const context={audioVehicle:{version:1,source:'other_confirmed',vehicle:car({engine:'',market:''})}};
  const req=buildFeatureRequest({tool:'listen',context,attachments:[{mime:'audio/wav',b64:'UklGRg=='}]});assert.equal(req.json,true);assert.match(req.contents[0].parts[0].text,/scope_check_required/);
});
test('engine-family-only normal-sound document never covers every Mercedes or bypasses explicit engine conflicts',()=>{
  const v={make:'Mercedes-Benz',model:'E 350',year:2013,engine_code:'M276',market:'US'};
  assert.equal(modelIssueKnowledge(v).records[0].id,'mercedes-li07-02-p-054717');
  for(const patch of [{engine_code:'OM642'},{engine_code:'M2760'},{engine_code:''},{engine_code:'M276',market:'TH'}])assert.equal(modelIssueKnowledge({...v,...patch}).records.length,0);
  assert.equal(modelIssueKnowledge({...v,engine_code:'',engine:'M276'}).records.length,1);
});
test('BMW engine code and year are bounded; Toyota gasoline bulletin cannot become a diesel fault',()=>{
  const b={make:'BMW',model:'328i',year:2014,engine_code:'N20',market:'US'};assert.equal(modelIssueKnowledge(b).records.length,1);
  assert.equal(modelIssueKnowledge({...b,engine_code:'N200'}).records.length,0);
  assert.equal(modelIssueKnowledge({...b,engine_code:'N55'}).records.length,0);
  assert.equal(modelIssueKnowledge({...b,model:'320i',engine_code:'N26'}).records.length,0);
  assert.equal(modelIssueKnowledge({...b,model:'228i',year:2014,engine_code:'N26'}).records.length,0);
  assert.equal(modelIssueKnowledge({...b,engine_code:'',engine:'N200'}).records.length,0);
  assert.equal(modelIssueKnowledge({make:'Toyota',model:'Camry',year:2011,engine:'2GR-FE'}).records.length,0);
  assert.equal(modelIssueKnowledge({make:'Toyota',model:'Camry',year:2011,engine:'12AR-FE'}).records.length,0);
  assert.equal(modelIssueKnowledge({make:'Toyota',model:'Camry',year:2011,engine:'2AR-FE'}).records.length,1);
});
test('motorcycle recalls are contextual safety information, not diagnostic sound examples',()=>{
  const h=modelIssueKnowledge({make:'Honda',model:'CBR300R',year:2016,market:'US'}).records[0];assert.equal(h.kind,'motorcycle');assert.equal(h.soundEvidence,false);
  assert.equal(modelIssueKnowledge({make:'Yamaha',model:'FJ-09',year:2015,market:'US'}).records[0].soundEvidence,false);
  assert.equal(modelIssueKnowledge({make:'Honda',model:'CBR300R',year:2016,market:'TH'}).records.length,0);
});
test('saved Garage vehicle and old client data never become the recording identity used for curated retrieval',()=>{
  assert.equal(soundGrounding({car:car()}).manufacturerEvidence.records.length,0);
  assert.equal(soundGrounding({audioVehicle:{version:1,source:'unknown',vehicle:car()}}).manufacturerEvidence.records.length,0);
  assert.equal(soundGrounding({audioVehicle:{version:1,source:'other_confirmed',vehicle:car()}}).manufacturerEvidence.records.length,1);
});
test('public query matching rejects ambiguity, market/engine conflicts and partial model tokens',()=>{
  assert.equal(issueKnowledgeForQuery('Ford F-150 2018 cold start rattle').records.length,1);
  assert.equal(issueKnowledgeForQuery('Ford F-150 2018 3.5L EcoBoost USA noise').records[0].status,'documented_candidate');
  for(const q of ['Ford F-150 2018 Thailand rattle','Ford F-150 2018 2.0L diesel noise','Ford F-150 2018 Toyota Camry 2011','Honda CR-V 2011 2020 rattle','Toyota RAV400 2011','Honda Wave 110i 2023','BMW 328i and 320i 2014'])assert.equal(issueKnowledgeForQuery(q).records.length,0,q);
  assert.equal(issueKnowledgeForQuery('Audi A5 Cabriolet 2012 rattle').records[0].models.some(m=>m.model==='A5 Cabriolet'),true);
});
test('curated knowledge survives search outage but is never mislabeled as a live read',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:503}));
  const r=await publicResearch('Ford F-150 2018 engine noise',{vehicle:car(),fetchSearch:async()=>''});
  assert.equal(r.status,'unavailable');assert.deepEqual(r.sources,[]);assert.equal(r.manufacturerEvidence.records.length,1);assert.equal(r.manufacturerEvidence.acousticModelsTrained,0);
  assert.match(researchBlock(r),/not a live page read/);assert.match(researchBlock(r),/US documents to Thai/);
});
