/* Synthetic map responses only. No billable requests or real user coordinates. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {searchShop,shopStatus} from '../src/shop-search.mjs';
import {routingRequest,routeFor,routeOrder} from '../src/shop-routing.mjs';
const base={GOOGLE_MAPS_API_KEY:'fixture-key',SHOP_GOOGLE_MAPS_ENABLED:'1'},enabled={...base,SHOP_GOOGLE_ROUTES_ENABLED:'1'};
const query={query:'brake pads',providers:['maps'],lat:13.75043,lng:100.5004,locationConsent:true,routeLocationConsent:true};
const place=(id,lat)=>({id,displayName:{text:id},location:{latitude:lat,longitude:100.5004},googleMapsUri:'https://maps.google.com/?cid='+id});
const places=[place('across-river',13.75743),place('road-near',13.77043),place('route-unknown',13.76043)];
const reply=()=>({places,routingSummaries:[{legs:[{distanceMeters:14000,duration:'1800s'}]},{legs:[{distanceMeters:3300,duration:'480s'}]},{}]});
function fetcher(value=reply()){const calls=[];return {calls,fetch:async(url,o)=>{calls.push({url,headers:o.headers,body:JSON.parse(o.body)});return Response.json(value)}}}
test('production billing gate is OFF; a forged client opt-in cannot request the higher routing SKU',async()=>{
  assert.match(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'),/"SHOP_GOOGLE_ROUTES_ENABLED":\s*"0"/);
  const f=fetcher(),r=await searchShop(base,{...query,SHOP_GOOGLE_ROUTES_ENABLED:'1',routing:true},{fetcher:f.fetch});
  assert.equal(shopStatus(base).providers.find(x=>x.id==='maps').routingEnabled,false);
  for(const c of f.calls){assert.ok(!c.headers['X-Goog-FieldMask'].includes('routingSummaries'));assert.equal(c.body.routingParameters,undefined);assert.deepEqual(c.body.locationBias.circle.center,{latitude:13.75,longitude:100.5});}
  assert.ok(r.places.every(p=>p.driving===null),'even unsolicited upstream route data is ignored while disabled');assert.equal(r.providers[0].routing.status,'disabled');
});
test('routing additionally requires a real location consent and separate routing opt-in',async()=>{
  for(const body of [{...query,routeLocationConsent:false},{...query,locationConsent:false}]){
    const f=fetcher();await searchShop(enabled,body,{fetcher:f.fetch});assert.ok(f.calls.every(c=>!c.body.routingParameters));
  }
  assert.equal(routingRequest({SHOP_GOOGLE_ROUTES_ENABLED:true},{location:{lat:13,lng:100},routeLocationConsent:true}),null);
});
test('river detour fixture: farther in a straight line but quicker by road sorts first; a missing summary never shifts the associations',async()=>{
  const f=fetcher(),r=await searchShop(enabled,query,{fetcher:f.fetch});
  assert.deepEqual(r.places.map(p=>p.id),['road-near','across-river','route-unknown']);
  assert.equal(r.places[0].driving.durationS,480);assert.equal(r.places[1].driving.distanceM,14000);assert.equal(r.places[1].driving.detour,true);assert.equal(r.places[0].driving.detour,false);assert.equal(r.places[2].driving,null);
  assert.equal(r.providers[0].routing.status,'partial');assert.equal(r.providers[0].routing.ranking,'driving_time');
  const first=f.calls[0];assert.equal(first.body.routingParameters.travelMode,'DRIVE');assert.equal(first.body.routingParameters.routingPreference,'TRAFFIC_UNAWARE');assert.deepEqual(first.body.routingParameters.origin,{latitude:query.lat,longitude:query.lng});assert.equal(first.body.routingParameters.routeModifiers.avoidFerries,true);
  assert.ok(first.headers['X-Goog-FieldMask'].endsWith(',routingSummaries'));assert.equal(first.headers['X-Goog-Api-Key'],'fixture-key');assert.ok(!JSON.stringify(r).includes('13.75043'),'private origin is not returned');
});
test('missing, malformed or misaligned route arrays fall back to explicitly straight-line ranking, never invented driving distances',async()=>{
  for(const routingSummaries of [undefined,[],[reply().routingSummaries[0]],{},[{}, {}, {}]]){
    const f=fetcher({places,routingSummaries}),r=await searchShop(enabled,query,{fetcher:f.fetch});assert.ok(r.places.every(p=>p.driving===null));assert.equal(r.providers[0].routing.ranking,'straight_line');assert.equal(r.providers[0].routing.status,'unavailable');
  }
});
test('route parsing rejects impossible data and does not multiply straight-line distance into an ETA',()=>{
  for(const summary of [{legs:[]},{legs:[{},{}]},{legs:[{distanceMeters:100,duration:'4 minutes'}]},{legs:[{distanceMeters:-1,duration:'1s'}]},{legs:[{distanceMeters:99999999,duration:'1s'}]},{legs:[{distanceMeters:100,duration:'99999999s'}]},{legs:[{distanceMeters:0,duration:'10s'}]}])assert.equal(routeFor(summary,1000),null);
  assert.equal(routeFor({legs:[{distanceMeters:1200,duration:'120.5s'}]},1000).durationS,121);
  assert.equal(routeFor({legs:[{distanceMeters:0,duration:'0s'}]},0).detour,false);
  const input=[{id:'one',distanceM:1000},{id:'two',distanceM:500}];assert.deepEqual(routeOrder(input).map(x=>x.id),['two','one']);assert.equal(input[0].id,'one');
});
test('route provider failures log status only, not an upstream response containing a coordinate or key',async()=>{
  const logs=[],orig=console.error;console.error=(...a)=>logs.push(a.join(' '));
  try{const r=await searchShop(enabled,query,{fetcher:async()=>new Response(JSON.stringify({error:{message:'private '+query.lat+' fixture-key'}}),{status:403})});assert.equal(r.providers[0].state,'unavailable');}
  finally{console.error=orig}
  assert.match(logs.join(' '),/HTTP 403/);assert.ok(!logs.join(' ').includes(String(query.lat)));assert.ok(!logs.join(' ').includes('fixture-key'));
});
