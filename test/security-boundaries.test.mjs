import test from 'node:test';
import assert from 'node:assert/strict';
import {localTestIdentity} from '../src/auth.js';
import {requestJson,RequestBodyError} from '../src/request-json.mjs';
import {readFileSync} from 'node:fs';

test('synthetic auth stays local even when DEV_AUTH is accidentally set on production',()=>{
  const env={DEV_AUTH:'1',FIREBASE_PROJECT_ID:'cendon-unit-test'},token='dev:fixture:fixture@unit.test';
  assert.equal(localTestIdentity(new Request('https://unit.test/api'),env,token).sub,'fixture');
  for(const url of ['https://spireonebackend.carspirethailand.workers.dev/api','https://cendon-beta.pages.dev/api','https://evil.example/api'])assert.equal(localTestIdentity(new Request(url),env,token),null);
  assert.equal(localTestIdentity(new Request('http://localhost/api'),{...env,FIREBASE_PROJECT_ID:'cendon-1'},token),null);
  assert.throws(()=>localTestIdentity(new Request('https://unit.test/api'),env,'dev::bad'),/Invalid test/);
});

test('JSON limits apply to streamed bytes, not only client Content-Length',async()=>{
  const request=(body,headers={})=>new Request('https://unit.test',{method:'POST',body,headers,duplex:'half'});
  assert.deepEqual(await requestJson(request('{"ok":true}'),20),{ok:true});
  assert.equal(await requestJson(request('{bad'),20),null);
  await assert.rejects(requestJson(request('{}',{'Content-Length':'100'}),20),e=>e instanceof RequestBodyError&&e.status===413);
  let cancelled=false;
  const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(64))},cancel(){cancelled=true}});
  await assert.rejects(requestJson(request(stream),20),e=>e.status===413);assert.ok(cancelled);
});

test('AI web search never opens arbitrary pages itself; only the keyed search APIs are called, with redirects refused',async()=>{
  const fa=await import('../src/fastai.js');assert.equal(fa.readPages,undefined);assert.equal(fa.publicPageUrl,undefined);assert.equal(fa.fetchDuckDuckGoSearch,undefined);
  const original=globalThis.fetch,seen=[];
  try{
    globalThis.fetch=async(url,init)=>{seen.push({url:String(url),redirect:init.redirect});return Response.json({results:[]})};
    const {searchWeb,resetSearchBreakers}=await import('../src/web-search.mjs');resetSearchBreakers();
    await searchWeb({TAVILY_API_KEY:'tvly-test-only-fixture'},'Toyota Yaris engine noise',{mode:'fast'});
    assert.deepEqual(seen.map(x=>x.url),['https://api.tavily.com/search']);assert.equal(seen[0].redirect,'error');
    seen.length=0;assert.equal(await fa.executeSearchInternal({},'Toyota Yaris recall'),'','no key = nothing leaves the Worker');assert.equal(seen.length,0);
  }finally{globalThis.fetch=original}
});

test('unhandled errors and AI diagnostics do not return or persist raw provider details',()=>{
  const src=readFileSync(new URL('../src/worker.js',import.meta.url),'utf8');
  const guarded=src.slice(src.indexOf('const guarded ='),src.indexOf('const readBody ='));
  assert.doesNotMatch(guarded,/deny\(e\.message \|\|/);
  const audit=src.slice(src.indexOf('async function logAiEvent('),src.indexOf('let aiErrAt'));
  assert.doesNotMatch(audit,/String\(ev\.(?:err|q)/);assert.match(audit,/provider_unavailable/);
});
