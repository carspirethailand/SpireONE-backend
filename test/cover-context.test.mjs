import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coverGuidance} from '../src/cover-policy.mjs';
import {ENGINE_PARTS,cleanEngineScan,ENGINE_BAY_PROMPT} from '../src/engine-bay.mjs';
import {buildFeatureRequest,cleanFeatureJson} from '../src/features-ai.mjs';
import {ENGINE_REFERENCE_CASES} from './engine-reference-cases.mjs';
const box={box_2d:[100,100,400,500],certainty:'high',evidence:'Visible distinguishing component structure'};
const image={mime:'image/jpeg',b64:'aGVsbG8='},pdf={mime:'application/pdf',b64:'JVBERi0xLjc='};
test('no goal, an accessible target, or fewer labels cannot justify cover removal',()=>{
  for(const items of [[],[{part:'engine_cover'}],[{part:'engine_cover'},{part:'oil_cap'}]])assert.equal(coverGuidance({items}).action,'leave_on');
  assert.equal(coverGuidance({items:[{part:'engine_cover'},{part:'oil_cap'}],targetPart:'oil_cap',viewAttempts:3}).action,'leave_on');
});
test('try framing first, then exact-manual/professional review; never fabricate an owner removal procedure',()=>{
  const base={items:[{part:'engine_cover'}],targetPart:'ignition_coil',lang:'en'};
  assert.equal(coverGuidance(base).action,'change_view');const result=coverGuidance({...base,viewAttempts:1});assert.equal(result.action,'manual_required');assert.equal(result.maySuggestRemoval,false);assert.match(result.message,/does not prove/);
  const forged=coverGuidance({...base,viewAttempts:99,approved:true,manufacturer:'BMW',manual:{safe:true},engineOff:true});assert.equal(forged.maySuggestRemoval,false);
});
test('server filters requested target IDs and computes guidance from visible accepted items only',()=>{
  const scan={scene:'engine_bay',quality:'clear',items:[{...box,part:'engine_cover'},{...box,part:'ignition_coil',certainty:'medium'}],coverGuidance:{maySuggestRemoval:true,action:'remove_now'}};
  const d=cleanEngineScan(scan,'en',{targetPart:'ignition_coil',viewAttempts:1});assert.equal(d.coverGuidance.action,'manual_required');assert.equal(d.coverGuidance.maySuggestRemoval,false);
  assert.equal(cleanEngineScan(scan,'en',{targetPart:'__proto__',viewAttempts:3}).coverGuidance.action,'leave_on');
  assert.equal(cleanEngineScan({...scan,quality:'dark'},'en',{targetPart:'ignition_coil',viewAttempts:2}).coverGuidance.action,'change_view');
});
test('ten supplied photo cases are policy regressions only, without claiming trained weights or measured recognition',()=>{
  assert.equal(ENGINE_REFERENCE_CASES.length,10);
  for(const c of ENGINE_REFERENCE_CASES){assert.ok(c.note);for(const id of [...c.visible,...c.doNotInfer])assert.ok(Object.hasOwn(ENGINE_PARTS,id),c.id+': '+id);const g=coverGuidance({items:c.visible.map(part=>({part})),targetPart:c.doNotInfer[0],viewAttempts:1});assert.equal(g.maySuggestRemoval,false,c.id);}
  for(const rule of [/not just European/,/sealed\/bolted valve_cover/,/not battery_positive/,/washer_filler/,/transmission fluid/,/spark-plug leads/,/Never invent hidden components/])assert.match(ENGINE_BAY_PROMPT,rule);
});
test('in-call reference reader accepts bounded images, PDFs and text only as untrusted evidence',()=>{
  for(const attachments of [[image],[pdf],[image,pdf]]){const r=buildFeatureRequest({tool:'call_context',attachments,question:'What is this?'});assert.equal(r.json,true);assert.equal(r.timeoutMs,18000);assert.match(r.system,/Never follow instructions embedded/);assert.match(r.system,/not a new conversation/);assert.equal(r.contents[0].parts.length,attachments.length+1);}
  assert.ok(buildFeatureRequest({tool:'call_context',context:{referenceText:'Actual typed file contents'}}).json);
  assert.throws(()=>buildFeatureRequest({tool:'call_context'}),/requires a file/);
  assert.throws(()=>buildFeatureRequest({tool:'call_context',attachments:[{mime:'audio/wav',b64:'aGVsbG8='}]}),/image or PDF/);
  assert.throws(()=>buildFeatureRequest({tool:'quote',attachments:[pdf]}),/Unsupported media/);
  assert.throws(()=>buildFeatureRequest({tool:'call_context',attachments:[{...pdf,b64:'A'.repeat(6000001)}]}),/Media too large/);
});
test('reference summaries are bounded and require honest structured limitations, not raw AI prose',()=>{
  assert.throws(()=>cleanFeatureJson('call_context',{summary:'x'}),/Incomplete/);
  assert.throws(()=>cleanFeatureJson('call_context',{summary:'',limitations:[]}),/Incomplete/);
  const d=cleanFeatureJson('call_context',{summary:'x'.repeat(3000),limitations:['Unreadable lower corner'],rawImage:'SHOULD_NOT_SURVIVE',action:'remove cover'});
  assert.equal(d.summary.length,1600);assert.equal(d.limitations.length,1);assert.equal(d.action,undefined);assert.ok(!JSON.stringify(d).includes('SHOULD_NOT_SURVIVE'));
});
