import test from 'node:test';import assert from 'node:assert/strict';
import {cleanDocumentExtraction} from '../src/spec-web.js';import {merge,detailsKey} from '../src/carspec.js';import {documentedPrice} from '../src/spec-details.mjs';import {anchorInput,anchorOrder} from '../src/odo-validation.mjs';
const now=Date.parse('2026-10-17T10:00:00Z'),q={make:'Honda',model:'Civic',year:'2024',market:'TH'};
// Synthetic evidence only. Values here are test fixtures, not a vehicle specification or valuation.
const text='Honda Civic 2024 Thailand. Sport engine. Sport: 4 cylinders, 16 valves, 8 speed. Engine code ABC-123. Price 1200000 THB. Front suspension double wishbone. Top speed 210 km/h. 0-100 km/h in 8.5 seconds. Ground clearance 140 mm.';
const docs=[{id:0,title:'Honda Civic 2024',url:'https://www.honda.co.th/test-only-2024',primary:true,text}];
function input(){return {found:true,scope:[{source:0,year_quote:'Honda Civic 2024 Thailand.'}],variants:[{name:'Sport',engine:'Sport engine',cylinders:4,valves:16,gears:8,engine_code:'ABC-123',price_thb:1200000,front_suspension:'double wishbone',top_speed_kmh:210,zero100_s:8.5}],ground_clearance_mm:140,evidence:[
  ...[['name','Sport engine.'],['engine','Sport engine.'],['cylinders','4 cylinders'],['valves','16 valves'],['gears','8 speed'],['engine_code','Engine code ABC-123.'],['price_thb','Price 1200000 THB.'],['front_suspension','Front suspension double wishbone.'],['top_speed_kmh','Top speed 210 km/h.'],['zero100_s','0-100 km/h in 8.5 seconds.']].map(([field,quote])=>({path:'variants.0.'+field,source:0,quote})),{path:'facts.ground_clearance_mm',source:0,quote:'Ground clearance 140 mm.'}]};}
test('deep fields survive exact document proofs, range checks, merging and per-field provenance',()=>{
  const a=cleanDocumentExtraction(input(),docs,q),data=merge(a,a);assert.equal(data.variants[0].engine_code.v,'ABC-123');assert.equal(data.variants[0].cylinders.v,4);assert.equal(data.variants[0].price_thb.v,1200000);assert.deepEqual(data.variants[0].front_suspension.sourceIds,[0]);assert.equal(data.facts.ground_clearance_mm.v,140);assert.ok(detailsKey('Honda','Civic','2024','TH').endsWith('|details'));
});
test('no inferred foreign currency, miles-per-hour conversion, fabricated quote or out-of-range detail can pass',()=>{
  const raw=input();raw.variants[0].price_thb=500000;raw.evidence.find(e=>e.path.endsWith('price_thb')).quote='Price 500000 USD.';
  raw.variants[0].cylinders=100;raw.evidence.find(e=>e.path.endsWith('cylinders')).quote='4 cylinders';
  const a=cleanDocumentExtraction(raw,docs,q),data=merge(a,a);assert.equal(data.variants[0].price_thb,null);assert.equal(data.variants[0].cylinders,null);
});
test('only exact-year primary Thai documented list prices can provide a labelled ceiling; never a used-market valuation',()=>{
  const data={...merge(cleanDocumentExtraction(input(),docs,q),null),schema:2,query:q},record={...q,status:'ready',data,sources:docs.map(({text,...s})=>({...s,docId:s.id})),updated_at:now};
  const price=documentedPrice(q,[record]);assert.equal(price.kind,'documented-new-price');assert.equal(price.valueThb,1200000);
  for(const bad of [{...record,year:'2025'},{...record,sources:[{...record.sources[0],primary:false}]},{...record,sources:[{...record.sources[0],url:'https://www.honda.com/us'}]}])assert.equal(documentedPrice(q,[bad]),null);
});
test('actual odometer inputs are strict and chronological; suspicious increases require explicit confirmation',()=>{
  for(const km of [null,'',-5,0.5,'1e5','1,,234',Infinity,3000001])assert.throws(()=>anchorInput({km},now));
  assert.equal(anchorInput({km:'50,000'},now).km,50000);assert.equal(anchorInput({km:0},now).km,0);
  assert.throws(()=>anchorInput({km:50000,observedAt:now+3600000},now));
  const before={km:50000,observed_at:now-86400000};assert.throws(()=>anchorOrder({km:49000,at:now},before,null,true),{code:'mileage_order'});
  assert.throws(()=>anchorOrder({km:60000,at:now},before,null),{code:'mileage_jump'});assert.equal(anchorOrder({km:60000,at:now},before,null,true),true);
  assert.throws(()=>anchorOrder({km:55000,at:now},null,{km:53000,observed_at:now+1000},true),{code:'mileage_order'});
});

test('PS and kW retain documented units rather than becoming horsepower',()=>{
  const raw=input(),d=[{...docs[0],text:text+' Power 180 PS. Output 132 kW.'}];raw.variants[0].power_ps=180;raw.variants[0].power_kw=132;
  raw.evidence.push({path:'variants.0.power_ps',source:0,quote:'Power 180 PS.'},{path:'variants.0.power_kw',source:0,quote:'Output 132 kW.'});
  const v=merge(cleanDocumentExtraction(raw,d,q),null).variants[0];assert.equal(v.power_ps.v,180);assert.equal(v.power_kw.v,132);assert.equal(v.hp,null);
});

test('an explicit Buddhist model year qualifies; a publication date alone does not',()=>{
  for(const [scope,expected] of [['Honda Civic รุ่นปี พ.ศ. 2567 Thailand.',4],['Honda Civic เผยแพร่ 2567 Thailand.',null]]){
    const raw=input(),d=[{...docs[0],text:scope+' '+text.replace('2024','')}];raw.scope[0].year_quote=scope;
    const result=cleanDocumentExtraction(raw,d,q);assert.equal(result.variants[0]?.cylinders??null,expected);
  }
});
