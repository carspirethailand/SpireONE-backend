import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
const frame={tool:'baylive',scanVersion:2,lang:'th',attachments:[{mime:'image/jpeg',b64:'aGVsbG8='}]};
const scan={scene:'engine_bay',quality:'clear',items:[{part:'battery',box_2d:[100,100,400,500],certainty:'high',evidence:'case and marked terminals'}]};
function env(writes=[]){return {DEV_AUTH:'1',FIREBASE_PROJECT_ID:'scanner-unit-test',GEMINI_KEY:'unit-test-not-a-key',ALLOWED_ORIGINS:'*',DB:{
  prepare(sql){return {bind(...values){if(sql.includes('INSERT INTO usage '))writes.push(values);return this},async first(){return sql.includes('schema_version')?{value:'24'}:sql.includes('RETURNING count')?{count:1,in_tok:1,out_tok:1}:null},async run(){return {}},async all(){return {results:[]}}}}}};}
async function run(overrides={},extra={},writes=[]){return worker.fetch(new Request('https://unit.test/api/features/analyze',{method:'POST',headers:{Authorization:'Bearer dev:scanner:scanner@unit.test','Content-Type':'application/json'},body:JSON.stringify({...frame,...extra})}),{...env(writes),...overrides},{waitUntil(){}});}
test('actual authenticated scanner route returns validated red-box data using the portable provider schema',async t=>{
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.match(String(url),/^https:\/\/generativelanguage.googleapis.com\//);
    const input=JSON.parse(init.body),schema=JSON.stringify(input.generationConfig.responseSchema);
    assert.ok(!schema.includes('minItems')&&!schema.includes('maxItems'));
    assert.ok(schema.includes('enum'));assert.equal(init.headers['x-goog-api-key'],'unit-test-not-a-key');
    return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(scan)}]}}]});
  });
  const r=await run(),d=await r.json();assert.equal(r.status,200);assert.equal(d.data.scanVersion,2);assert.equal(d.data.items.length,1);assert.deepEqual(d.data.items[0].box,[100,100,400,500]);
});
for(const [name,status,payload,expected] of [
  ['provider error',400,{error:{message:'raw-private-provider-response'}},'scan_upstream'],
  ['provider capacity',429,{error:{message:'capacity'}},'scan_provider_busy'],
  ['incomplete JSON',200,{candidates:[{content:{parts:[{text:'{"items":[]}' }]}}]},'scan_invalid_result']
])test('actual scanner route: '+name+' is safe, explicit and cannot produce boxes',async t=>{
  const logs=[];t.mock.method(console,'warn',s=>logs.push(s));
  t.mock.method(globalThis,'fetch',async()=>Response.json(payload,{status}));
  const r=await run(),d=await r.json();assert.equal(d.error,expected);assert.ok(r.status>=500);assert.equal(d.data,undefined);
  assert.match(d.requestId,/^[a-f0-9-]{36}$/);assert.equal(logs.length,1);
  assert.deepEqual(Object.keys(JSON.parse(logs[0])).sort(),['code','event','requestId']);
  assert.ok(!JSON.stringify(d).includes('raw-private-provider-response'));
});

const reviewedItem={part:'battery',candidate:0,box_2d:[100,100,400,500],certainty:'high',visibility:'visible',identityCue:'distinct_structure',identityMarking:'',evidence:'case and visible terminals'};
function provider(data,inTokens=11,outTokens=5){return Response.json({candidates:[{content:{parts:[{text:typeof data==='string'?data:JSON.stringify(data)}]}}],usageMetadata:{promptTokenCount:inTokens,candidatesTokenCount:outTokens}});}

test('opt-in route automatically makes a blind second request and meters both replies once',async t=>{
  let calls=0;const writes=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const input=JSON.parse(init.body);calls++;
    assert.ok(init.signal);assert.equal(init.headers['x-goog-api-key'],'unit-test-not-a-key');
    if(calls===1)return provider(scan);
    const contents=JSON.stringify(input.contents);
    assert.ok(contents.includes('candidate'));assert.ok(!contents.includes('case and marked terminals'));
    assert.ok(!/"part"|"certainty"|"evidence"/.test(contents));
    return provider({...scan,items:[reviewedItem]},7,3);
  });
  const r=await run({ENGINE_SCAN_BLIND_REVIEW:'1'},{},writes),d=await r.json();
  assert.equal(r.status,200);assert.equal(calls,2);assert.equal(d.data.items.length,1);
  assert.equal(d.data.review.mode,'blind_second_pass');assert.equal(d.data.review.independentlyValidated,false);
  const meterWrites=writes.filter(v=>v.length===6);
  assert.equal(meterWrites.length,1);assert.deepEqual(meterWrites[0].slice(2),[18,8,18,8]);
});

test('client cannot turn on draft review or disable server-required review',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return provider(calls%2===0?{...scan,items:[reviewedItem]}:scan);});
  let r=await run({}, {blindReview:true,ENGINE_SCAN_BLIND_REVIEW:'1'}),d=await r.json();
  assert.equal(calls,1);assert.equal(d.data.review,undefined);
  calls=0;r=await run({ENGINE_SCAN_BLIND_REVIEW:'true'},{blindReview:true});await r.json();assert.equal(calls,1);
  calls=0;r=await run({ENGINE_SCAN_BLIND_REVIEW:'1'},{blindReview:false});d=await r.json();assert.equal(calls,2);assert.equal(d.data.review.retained,1);
});

test('opt-in route withholds conflicting identities instead of returning or relabelling them',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>provider(++calls===1?scan:{...scan,items:[{...reviewedItem,part:'air_box'}]}));
  const r=await run({ENGINE_SCAN_BLIND_REVIEW:'1'}),d=await r.json();
  assert.equal(r.status,200);assert.deepEqual(d.data.items,[]);assert.equal(d.data.review.withheld,1);
});

for(const mode of ['quota','timeout','malformed'])test('opt-in review '+mode+' fails closed and meters completed inference without leaking response',async t=>{
  let calls=0;const logs=[],writes=[];
  t.mock.method(console,'warn',s=>logs.push(s));
  t.mock.method(globalThis,'fetch',async()=>{
    if(++calls===1)return provider(scan);
    if(mode==='quota')return Response.json({error:{message:'raw-private-review-response'}},{status:429});
    if(mode==='timeout')throw new DOMException('raw-private-review-response','TimeoutError');
    return provider('raw-private-review-response',7,3);
  });
  const r=await run({ENGINE_SCAN_BLIND_REVIEW:'1'},{},writes),d=await r.json();
  assert.ok(r.status>=500);assert.equal(d.stage,'review');assert.equal(d.data,undefined);assert.ok(!JSON.stringify(d).includes('raw-private'));
  assert.match(d.requestId,/^[a-f0-9-]{36}$/);assert.equal(logs.length,1);
  assert.deepEqual(Object.keys(JSON.parse(logs[0])).sort(),['code','event','requestId']);
  assert.deepEqual(writes.find(v=>v.length===6).slice(2),mode==='malformed'?[18,8,18,8]:[11,5,11,5]);
});

test('no candidates means no second model call and is not misrepresented as completed review',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return provider({...scan,items:[]});});
  const r=await run({ENGINE_SCAN_BLIND_REVIEW:'1'}),d=await r.json();
  assert.equal(r.status,200);assert.equal(calls,1);assert.equal(d.data.review.status,'not_required');assert.deepEqual(d.data.items,[]);
});

test('second pass cannot reset the shared deadline or return first-pass boxes when budget is exhausted',async t=>{
  let clock=Date.now(),calls=0;const writes=[];
  t.mock.method(Date,'now',()=>clock);
  t.mock.method(console,'warn',()=>{});
  t.mock.method(globalThis,'fetch',async()=>{calls++;clock+=17500;return provider(scan);});
  const r=await run({ENGINE_SCAN_BLIND_REVIEW:'1'},{},writes),d=await r.json();
  assert.equal(r.status,504);assert.equal(d.error,'scan_timeout');assert.equal(d.stage,'review');assert.equal(d.data,undefined);
  assert.equal(calls,1);assert.deepEqual(writes.find(v=>v.length===6).slice(2),[11,5,11,5]);
});
