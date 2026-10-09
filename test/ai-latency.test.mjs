import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fastAnswer,unpark} from '../src/fastai.js';
function success(){return new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text:'คำตอบจริงจากสตรีม'}]}}]})+'\n\n');}
test('Gemini streams before the free multi-step agent, without exposed thought summaries',async()=>{
  const original=globalThis.fetch,calls=[],text=[];unpark();
  globalThis.fetch=async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return success();};
  try{
    const result=await fastAnswer({GEMINI_KEY:'fixture',GEMINI_MODEL:'gemini-2.5-flash',OPENROUTER_API_KEY:'fixture'},
      {contents:[{role:'user',parts:[{text:'hi'}]}],search:false,level:'minimal',onText:d=>text.push(d)});
    assert.equal(calls.length,1);assert.match(calls[0].url,/generativelanguage/);
    assert.equal(calls[0].body.generationConfig.thinkingConfig.includeThoughts,false);
    assert.equal(calls[0].body.generationConfig.thinkingConfig.thinkingBudget,0);
    assert.equal(result.text,text.join(''));assert.equal(result.thoughts,'');
  }finally{globalThis.fetch=original;unpark();}
});
test('grounding cooldown still fetches current evidence on later fresh questions',async()=>{
  const original=globalThis.fetch;let searches=0;unpark();
  globalThis.fetch=async(url,init)=>JSON.parse(init.body).tools?new Response('grounding quota',{status:429}):success();
  const opts={contents:[{role:'user',parts:[{text:'ราคาวันนี้'}]}],question:'ราคาวันนี้',search:true,executeSearch:async()=>{searches++;return 'official source';}};
  try{await fastAnswer({GEMINI_KEY:'fixture',GEMINI_MODEL:'gemini-2.5-flash'},opts);await fastAnswer({GEMINI_KEY:'fixture',GEMINI_MODEL:'gemini-2.5-flash'},opts);assert.equal(searches,2);}
  finally{globalThis.fetch=original;unpark();}
});
