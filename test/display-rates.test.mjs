import test from 'node:test';
import assert from 'node:assert/strict';
import {displayRates} from '../src/display-rates.js';
test('reference rates use fixed public upstream and never forward user data',async()=>{
  const original=globalThis.fetch;let call;
  try{globalThis.fetch=async(url,options)=>{call={url,options};return Response.json([{date:new Date().toISOString().slice(0,10),base:'THB',quote:'USD',rate:.03}])};
    const r=await displayRates(new Request('https://test/api/display-rates?uid=private&amount=999',{headers:{Authorization:'Bearer private'}}),{'Access-Control-Allow-Origin':'https://test'});
    assert.equal(r.status,200);assert.equal((await r.json()).rates.USD,.03);assert.doesNotMatch(JSON.stringify(call),/private|amount|999/);assert.equal(call.options.headers.Authorization,undefined);
  }finally{globalThis.fetch=original}
});
test('bad, oversized, failed and stale rate data fail closed rather than fabricating exchange rates',async()=>{
  const original=globalThis.fetch;try{for(const payload of [{},[{date:'2001-01-01',base:'THB',quote:'USD',rate:1}],Array(99).fill({}),[{date:new Date().toISOString().slice(0,10),base:'THB',quote:'USD',rate:-2}]]){globalThis.fetch=async()=>Response.json(payload);const r=await displayRates(new Request('https://test/api/display-rates'));assert.equal(r.status,503);assert.equal(r.headers.get('Cache-Control'),'no-store')}}finally{globalThis.fetch=original}
});
