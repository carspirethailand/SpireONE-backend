import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boxIoU,evaluateEngineDataset} from '../tools/engine-eval.mjs';
const box=[100,100,400,400],label=(part='battery',b=box)=>({part,box:b});
const fixture=(extra={})=>({id:'synthetic-test',vehicleGroup:'synthetic-car',split:'holdout',vehicle:{make:'Toyota',model:'Corolla'},review:{status:'approved',role:'mechanic'},labels:[label()],prediction:{status:'ok',items:[label()]},...extra});
const score=cases=>evaluateEngineDataset({schemaVersion:1,cases});
test('synthetic IoU checks reject invalid/inverted boxes and preserve exact normalized geometry',()=>{
  assert.equal(boxIoU(box,box),1);assert.equal(boxIoU(box,[500,500,600,600]),0);assert.equal(boxIoU(box,[400,400,100,100]),0);assert.equal(boxIoU(box,[0,0,Infinity,1000]),0);assert.equal(boxIoU(box,['100',100,400,400]),0);
  assert.ok(Math.abs(boxIoU([0,0,200,200],[100,100,300,300])-1/7)<1e-9);
});
test('unreviewed/development inputs cannot produce an independent accuracy score; empty metrics are null, not 100 percent',()=>{
  for(const cases of [[],[fixture({review:{status:'pending'}})],[fixture({split:'development'})]]){const r=score(cases);assert.equal(r.status,'no_independent_evaluation');assert.equal(r.eligibleCases,0);assert.equal(r.precision,null);assert.equal(r.recall,null);assert.equal(r.successfulRequestRate,null);assert.equal(r.releaseDecision,'human_review_required');}
});
test('one physical vehicle cannot leak from development into held-out evaluation',()=>{
  const r=score([fixture({id:'dev',split:'development'}),fixture({id:'heldout'})]);assert.equal(r.excludedDevelopment,1);assert.equal(r.excludedVehicleLeakage,1);assert.equal(r.eligibleCases,0);
});
test('class-correct one-to-one matching counts duplicate rectangles as false positives and missing objects as false negatives',()=>{
  const r=score([fixture({labels:[label(),label('air_box',[500,500,800,800])],prediction:{status:'ok',items:[label(),label()]}})]);
  assert.equal(r.truePositives,1);assert.equal(r.falsePositives,1);assert.equal(r.falseNegatives,1);assert.equal(r.precision,.5);assert.equal(r.recall,.5);assert.equal(r.meanMatchedIoU,1);
});
test('matching uses maximum cardinality instead of a greedy overlap that discards a second identifiable object',()=>{
  const a=[0,0,200,200],b=[0,100,200,300],p=[0,0,200,300];
  const r=evaluateEngineDataset({schemaVersion:1,cases:[fixture({labels:[label('battery',a),label('battery',b)],prediction:{status:'ok',items:[label('battery',p),label('battery',a)]}})]},{iouThreshold:.5});assert.equal(r.truePositives,2);assert.equal(r.falseNegatives,0);
});
test('wrong fluid/polarity identities remain errors even at perfect IoU; explicitly unknown reservoirs are not dangerous certainty',()=>{
  const r=score([fixture({labels:[label('brake_reservoir')],prediction:{status:'ok',items:[label('coolant_tank')]}})]);assert.equal(r.truePositives,0);assert.equal(r.falsePositives,1);assert.equal(r.falseNegatives,1);assert.equal(r.dangerousConfusions,1);
  assert.equal(score([fixture({labels:[label('brake_reservoir')],prediction:{status:'ok',items:[label('reservoir_unknown')]}})]).dangerousConfusions,0);
});
test('timeouts/invalid results are not dropped from recall or availability; negative images count separately',()=>{
  const r=score([fixture({id:'failed',prediction:{status:'timeout'}}),fixture({id:'empty',vehicleGroup:'other-car',labels:[],prediction:{status:'ok',items:[]}})]);assert.equal(r.failedRequests,1);assert.equal(r.falseNegatives,1);assert.equal(r.trueNegativeImages,1);assert.equal(r.successfulRequestRate,.5);assert.equal(r.precision,null);assert.equal(r.recall,0);
});
test('invalid predicted locations and unknown IDs cannot improve accuracy; report omits image data and arbitrary evidence',()=>{
  const r=score([fixture({prediction:{status:'ok',items:[{part:'invented',box},label('battery',[0,0,9000,100])],raw:'PRIVATE_RAW_AI',image:'PRIVATE_BASE64'}})]);assert.equal(r.invalidPredictions,2);assert.equal(r.falsePositives,2);assert.equal(r.falseNegatives,1);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('coverage counts actual independent representations, not all 82 inventory targets or all generations',()=>{
  const r=score([fixture()]);assert.equal(r.inventoriedModelsRepresented,1);assert.equal(r.coverage.Toyota.inventoriedModels,35);assert.equal(r.coverage.Toyota.representedModels,1);assert.equal(r.coverage.Ford.representedModels,0);assert.equal(r.status,'evaluated_not_certified');assert.equal(r.releaseDecision,'human_review_required');
});
test('evaluation manifests are bounded, explicit and cannot quietly reuse IDs or malformed ground truth',()=>{
  for(const m of [null,{schemaVersion:1,cases:[fixture(),fixture()]},{schemaVersion:1,cases:[fixture({labels:[label('invented')]})]},{schemaVersion:1,cases:[fixture({split:'train'})]},{schemaVersion:1,cases:new Array(5001).fill(fixture())}])assert.throws(()=>evaluateEngineDataset(m));
  for(const iouThreshold of [0,1.1,NaN,'0.5'])assert.throws(()=>evaluateEngineDataset({schemaVersion:1,cases:[]},{iouThreshold}));
});
