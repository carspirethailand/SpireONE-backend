import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
const frame={tool:'baylive',scanVersion:2,lang:'th',attachments:[{mime:'image/jpeg',b64:'aGVsbG8='}]};
const scan={scene:'engine_bay',quality:'clear',items:[{part:'battery',box_2d:[100,100,400,500],certainty:'high',evidence:'case and marked terminals'}]};
function env(){return {DEV_AUTH:'1',FIREBASE_PROJECT_ID:'scanner-unit-test',GEMINI_KEY:'unit-test-not-a-key',ALLOWED_ORIGINS:'*',DB:{
  prepare(sql){return {bind(){return this},async first(){return sql.includes('schema_version')?{value:'24'}:sql.includes('RETURNING count')?{count:1,in_tok:1,out_tok:1}:null},async run(){return {}},async all(){return {results:[]}}}}}};}
async function run(){return worker.fetch(new Request('https://unit.test/api/features/analyze',{method:'POST',headers:{Authorization:'Bearer dev:scanner:scanner@unit.test','Content-Type':'application/json'},body:JSON.stringify(frame)}),env(),{waitUntil(){}});}
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
