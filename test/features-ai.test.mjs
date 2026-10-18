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

test('quote: reads every line, checks the sums itself, triages for this car and never states estimates as fact',()=>{
  const r=buildFeatureRequest({tool:'quote',...fixtures.quote,context:{car:{make:'Honda',model:'City',year:2019,mileage:42000}}});
  for(const re of [/every legible line/,/never guess a number/,/arithmetic yourself/,/VAT \(7% in Thailand\)/,/urgent/,/upsells/,/labour charged twice/,/not a reference price/,/questions to ask this garage/,/retake the photo/])
    assert.match(r.system,re);
  assert.equal(r.maxTokens,4096,'room for long quotes');
  assert.equal(buildFeatureRequest({tool:'listen',...fixtures.listen}).maxTokens,3000);
  assert.match(r.contents[0].parts[0].text,/"mileage":42000/,'car context reaches the model');
});

test('listen: describes the sound first, ranks causes for this car, judges urgency and never claims a definite diagnosis',()=>{
  const r=buildFeatureRequest({tool:'listen',attachments:[{mime:'audio/wav',b64:'UklGRg=='},{mime:'image/jpeg',b64:'aGVsbG8='}],
    question:'เสียงมาจาก: ห้องเครื่อง · ได้ยินตอน: เดินเบา',context:{car:{make:'Honda',model:'City',year:'2019',mileage:'42000'}}});
  for(const re of [/Never identify make, model/,/what you actually hear/,/possible causes supported by audible clues/,/not verified identity/,/Stop safely/,/safely parked/,/cannot certify roadworthiness/,/speech-filtered/,/never a percentage/])
    assert.match(r.system,re);
  assert.equal(r.contents[0].parts[1].inlineData.mimeType,'audio/wav','WAV from the app reaches the model');
  assert.equal(r.contents[0].parts[2].inlineData.mimeType,'image/jpeg','video frames go along with the sound');
  assert.match(r.contents[0].parts[0].text,/ห้องเครื่อง/);
});
