import test from 'node:test';
import assert from 'node:assert/strict';
import {localTestIdentity} from '../src/auth.js';
import {requestJson,RequestBodyError} from '../src/request-json.mjs';
import {readPages,publicPageUrl} from '../src/fastai.js';
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

test('AI page readers reject private URLs, credentials, lookalike domains and unsafe redirects',async()=>{
  for(const url of ['http://toyota.com/x','https://127.0.0.1/','https://[::1]/','https://169.254.169.254/','https://toyota.com.evil.example/','https://name:secret@toyota.com/','https://toyota.com:8443/'])assert.equal(publicPageUrl(url),null,url);
  assert.ok(publicPageUrl('https://www.toyota.com/cars'));
  const original=globalThis.fetch,seen=[];
  try{
    globalThis.fetch=async(url,init)=>{seen.push(url);assert.equal(init.redirect,'manual');return new Response(null,{status:302,headers:{Location:'https://169.254.169.254/private'}})};
    const r=await readPages([{url:'https://toyota.com/engine',title:'Public vehicle page'}],'engine',1,1000);
    assert.equal(r.ok,0);assert.deepEqual(seen,['https://toyota.com/engine']);
    let cancelled=false;
    globalThis.fetch=async()=>new Response(new ReadableStream({pull(c){c.enqueue(new TextEncoder().encode('engine '.repeat(10000)))},cancel(){cancelled=true}}),{headers:{'content-type':'text/html'}});
    const result=await readPages([{url:'https://toyota.com/engine',title:'Public page'}],'engine',1,1000);
    assert.equal(result.ok,1);assert.ok(cancelled,'huge pages are cancelled at the byte cap');
  }finally{globalThis.fetch=original}
});

test('unhandled errors and AI diagnostics do not return or persist raw provider details',()=>{
  const src=readFileSync(new URL('../src/worker.js',import.meta.url),'utf8');
  const guarded=src.slice(src.indexOf('const guarded ='),src.indexOf('const readBody ='));
  assert.doesNotMatch(guarded,/deny\(e\.message \|\|/);
  const audit=src.slice(src.indexOf('async function logAiEvent('),src.indexOf('let aiErrAt'));
  assert.doesNotMatch(audit,/String\(ev\.(?:err|q)/);assert.match(audit,/provider_unavailable/);
});
