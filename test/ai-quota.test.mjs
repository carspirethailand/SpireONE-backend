import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fastAnswer,unpark,badState,geminiScope} from '../src/fastai.js';
const env=key=>({GEMINI_KEY:key,GEMINI_CHAT_MODEL:'gemini-3.8-flash',GEMINI_SEARCH_MODEL:'gemini-3.8-flash',GEMINI_MODEL:'gemini-3.8-flash'});
const opts={contents:[{role:'user',parts:[{text:'Test-only question'}]}],level:'low',search:true};
const success=grounded=>new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text:'Fixture transport result'}]},...(grounded?{groundingMetadata:{webSearchQueries:['Test-only query']}}:{})}]})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
const limited=()=>new Response(JSON.stringify({error:{status:'RESOURCE_EXHAUSTED',message:'Test-only quota violation'}}),{status:429});

test('Gemini never gets a Google Search tool; a fresh question is searched once through the keyed web search and the result rides in the system prompt',async()=>{
  unpark();const original=globalThis.fetch,calls=[];let searched=0;
  globalThis.fetch=async(url,request)=>{const body=JSON.parse(request.body);calls.push({tools:body.tools,system:body.systemInstruction?.parts?.[0]?.text||''});return success(false);};
  try{
    const r=await fastAnswer(env('fixture-key'),{...opts,question:'Test-only fresh question',executeSearch:async()=>{searched++;return '[ผลค้นเว็บ fixture]'}});
    assert.equal(r.grounded,true);assert.equal(searched,1);
    assert.ok(calls.every(c=>!c.tools),'no google_search tool is ever attached');
    assert.match(calls[0].system,/ผลค้นเว็บ fixture/);
    unpark();calls.length=0;
    const none=await fastAnswer(env('fixture-key'),{...opts,question:'Test-only fresh question',executeSearch:async()=>''});
    assert.equal(none.grounded,false);assert.match(calls[0].system,/ยังยืนยันข้อมูลล่าสุดไม่ได้/,'no result = the model is told to say so, not to guess');
  }finally{globalThis.fetch=original;unpark();}
});
test('one model returning 429 does not park every model in the project',async()=>{
  unpark();const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,request)=>{calls.push(url);return url.includes('gemini-3.8-flash')?limited():success(false);};
  try{
    const result=await fastAnswer(env('quota-fixture'),{...opts,question:'Test-only fresh question',executeSearch:async()=>'[ผลค้นเว็บ fixture]'});
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
