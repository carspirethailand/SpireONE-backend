import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fastAnswer,unpark,badState,geminiScope} from '../src/fastai.js';
const env=key=>({GEMINI_KEY:key,GEMINI_CHAT_MODEL:'gemini-3.8-flash',GEMINI_SEARCH_MODEL:'gemini-3.8-flash',GEMINI_MODEL:'gemini-3.8-flash',GEMINI_GROUNDING:'1'});
const opts={contents:[{role:'user',parts:[{text:'Test-only question'}]}],level:'low',search:true};
const success=grounded=>new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text:'Fixture transport result'}]},...(grounded?{groundingMetadata:{webSearchQueries:['Test-only query']}}:{})}]})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
const limited=()=>new Response(JSON.stringify({error:{status:'RESOURCE_EXHAUSTED',message:'Test-only quota violation'}}),{status:429});

test('new credentials with the same suffix do not inherit old grounding cooldowns',async()=>{
  unpark();const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,request)=>{const body=JSON.parse(request.body);const key=request.headers['x-goog-api-key'];calls.push({key,search:!!body.tools});return key==='old-fixture-123456'&&body.tools?limited():success(!!body.tools);};
  try{
    const old=await fastAnswer(env('old-fixture-123456'),opts);assert.equal(old.grounded,false);
    const fresh=await fastAnswer(env('new-fixture-123456'),opts);assert.equal(fresh.grounded,true);
    assert.equal(calls.at(-1).search,true);
    const current=badState(await geminiScope(env('new-fixture-123456')));assert.equal(current.length,0);
    assert.doesNotMatch(JSON.stringify(badState()),/old-fixture|123456/);
  }finally{globalThis.fetch=original;unpark();}
});
test('one model returning 429 does not park every model in the project',async()=>{
  unpark();const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,request)=>{calls.push(url);return url.includes('gemini-3.8-flash')?limited():success(!!JSON.parse(request.body).tools);};
  try{
    const result=await fastAnswer(env('quota-fixture'),opts);
    assert.equal(result.model,'gemini-2.5-flash');assert.equal(result.grounded,true);
    assert.ok(calls.some(url=>url.includes('gemini-2.5-flash')));
  }finally{globalThis.fetch=original;unpark();}
});
test('model availability cooldowns are also scoped to credentials',async()=>{
  unpark();const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,request)=>{const key=request.headers['x-goog-api-key'];calls.push({key,url});return key==='restricted-fixture'&&url.includes('gemini-3.8-flash')?new Response('Model not found',{status:404}):success(true);};
  try{
    assert.equal((await fastAnswer(env('restricted-fixture'),opts)).model,'gemini-2.5-flash');
    assert.equal((await fastAnswer(env('enabled-fixture'),opts)).model,'gemini-3.8-flash');
  }finally{globalThis.fetch=original;unpark();}
});
