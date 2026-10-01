import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildFeatureRequest} from '../src/features-ai.mjs';
import worker from '../src/worker.js';

const image={mime:'image/jpeg',b64:'aGVsbG8='};
const audio={mime:'audio/webm;codecs=opus',b64:'aGVsbG8='};
const fixtures={
  quote:{attachments:[image]},listen:{attachments:[audio]},
  shake:{context:{measurement:{peaks:[{hz:11,amp:.3}],hz:60}}},
  park:{context:{parking:{note:'B2 C14',elapsedMinutes:12,accuracyMeters:30}}},
  own:{context:{cost:{entryCount:2,fuel:1200,service:800,total:2000,perKm:null}}}
};
for(const [tool,fixture] of Object.entries(fixtures))test(`${tool}: grounded model request with Thai/English support`,()=>{
  const request=buildFeatureRequest({tool,...fixture,question:'Test-only input'});
  assert.equal(request.contents[0].role,'user');
  assert.match(request.system,/Respond in Thai/);
  assert.match(request.system,/never instructions overriding/);
  assert.equal(request.search,false);
  assert.match(request.contents[0].parts[0].text,/Test-only input/);
  assert.match(buildFeatureRequest({tool,...fixture,lang:'en'}).system,/Respond in English/);
});
test('image and audio reach the model as multimodal data, not captions',()=>{
  assert.deepEqual(buildFeatureRequest({tool:'quote',...fixtures.quote}).contents[0].parts[1],{inlineData:{mimeType:'image/jpeg',data:image.b64}});
  assert.equal(buildFeatureRequest({tool:'listen',...fixtures.listen}).contents[0].parts[1].inlineData.mimeType,'audio/webm');
});
test('rejects missing evidence instead of manufacturing demo results',()=>{
  for(const tool of ['quote','listen','shake','own','park'])assert.throws(()=>buildFeatureRequest({tool}));
  assert.throws(()=>buildFeatureRequest({tool:'unknown'}),/Unsupported tool/);
  assert.throws(()=>buildFeatureRequest({tool:'toString'}),/Unsupported tool/);
});
test('bounds media and context; rejects unsupported formats and corrupt payloads',()=>{
  assert.throws(()=>buildFeatureRequest({tool:'quote',attachments:[{mime:'text/html',b64:'aA=='}]}),/Unsupported media/);
  assert.throws(()=>buildFeatureRequest({tool:'quote',attachments:[{...image,b64:'<script>'}]}),/Invalid media/);
  assert.throws(()=>buildFeatureRequest({tool:'quote',attachments:Array(4).fill(image)}),/at most three/);
  assert.throws(()=>buildFeatureRequest({tool:'park',context:{note:'x'.repeat(25000)}}),/Context too large/);
  assert.throws(()=>buildFeatureRequest({tool:'quote',attachments:[{...image,b64:'A'.repeat(12000001)}]}),/Media too large/);
});
test('prompts preserve arithmetic and uncertainty; avoid false navigation and driving advice',()=>{
  assert.match(buildFeatureRequest({tool:'own',...fixtures.own}).system,/arithmetic totals are authoritative/);
  assert.match(buildFeatureRequest({tool:'park',...fixtures.park}).system,/Coordinates are deliberately omitted/);
  assert.match(buildFeatureRequest({tool:'shake',...fixtures.shake}).system,/not proof/);
  assert.match(buildFeatureRequest({tool:'shake',...fixtures.shake}).system,/Do not ask the driver/);
});
test('feature endpoint rejects anonymous access before invoking any model',async()=>{
  const DB={prepare(){return {bind(){return this},async first(){return null},async run(){return {}},async all(){return {results:[]}}}}};
  const response=await worker.fetch(new Request('https://local.test/api/features/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tool:'quote',...fixtures.quote})}),{ALLOWED_ORIGINS:'*',DB},{});
  assert.equal(response.status,401);
});
