import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedSource,robotsAllow,textOf,timebox,collectSpecDocuments,cleanDocumentExtraction,excerpt,documentRank,wikiPlain} from '../src/spec-web.js';
import {research,merge,specFailure} from '../src/carspec.js';
const q={make:'Mitsubishi',model:'Pajero Sport',year:'2020',market:'TH'};
// All documents and Gemini responses in this file are synthetic test data.
const paragraph='Mitsubishi Pajero Sport 2020 Thailand specification. 2.4 GT diesel engine. Seats: 7. Displacement: 2442 cc. Power: 181 hp. Torque: 430 Nm. Drive: RWD. '+ 'Public fixture descriptive text. '.repeat(10);
const docs=[{id:0,url:'https://www.mitsubishi-motors.co.th/test-pajero-sport-2020',title:'2020 Mitsubishi Pajero Sport',text:paragraph,primary:true}];
function extraction(){return {found:true,body:'suv',market:'Thailand',seats:7,
  scope:[{source:0,year_quote:'Mitsubishi Pajero Sport 2020 Thailand specification.'}],
  variants:[{name:'2.4 GT',engine:'diesel engine',fuel:'diesel',cc:2442,hp:181,torque_nm:430,drive:'RWD'}],
  evidence:{'facts.market':[{source:0,quote:'2020 Thailand specification.'}], 'facts.seats':[{source:0,quote:'Seats: 7.'}],
    'variants.0.name':[{source:0,quote:'2.4 GT diesel engine.'}], 'variants.0.engine':[{source:0,quote:'2.4 GT diesel engine.'}],
    'variants.0.fuel':[{source:0,quote:'2.4 GT diesel engine.'}], 'variants.0.cc':[{source:0,quote:'Displacement: 2442 cc.'}],
    'variants.0.hp':[{source:0,quote:'Power: 181 hp.'}], 'variants.0.torque_nm':[{source:0,quote:'Torque: 430 Nm.'}],
    'variants.0.drive':[{source:0,quote:'Drive: RWD.'}]}};}
function installWeb({badDiscovery=false,redirect=false,blocked=false,aiResponse=extraction()}={}){
  const calls=[];globalThis.fetch=async(raw,init={})=>{const url=String(raw);calls.push({url,init});
    if(url.includes('generativelanguage.googleapis.com'))return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'Do not publish this internal text'},{text:JSON.stringify(aiResponse)}]}}]});
    if(url.includes('/w/api.php')){if(badDiscovery)return new Response('Forbidden',{status:403});const p=new URL(url).searchParams;
      if(p.get('action')==='query')return Response.json({query:{search:[{pageid:123,title:'Mitsubishi Pajero Sport',snippet:'Mitsubishi Pajero Sport'}]}});
      return Response.json({parse:{text:{'*':'<p>'+paragraph+'</p>'},externallinks:[docs[0].url,'https://www.caranddriver.com/test-pajero-sport-2019','http://127.0.0.1/private','https://evil.example/private','https://www.porsche.com/spec.pdf']}});
    }
    if(url.endsWith('/robots.txt'))return new Response(blocked?'User-agent: *\nDisallow: /':'User-agent: *\nAllow: /');
    if(url===docs[0].url){if(redirect)return new Response('',{status:302,headers:{location:'http://127.0.0.1/private'}});return new Response('<title>2020 Mitsubishi Pajero Sport</title><p>'+paragraph+'</p>',{headers:{'content-type':'text/html'}});}
    if(url.includes('caranddriver.com'))return new Response('<title>2019 Mitsubishi Pajero Sport</title><p>'+paragraph+'</p>',{headers:{'content-type':'text/html'}});
    throw Error('Unexpected fetch '+url);
  };return calls;
}
test('reader: only allowlisted HTTPS publishers, no private addresses, credentials, custom ports or lookalike domains',()=>{
  for(const u of ['https://porsche.com/a','https://newsroom.porsche.com/a','https://www.mitsubishi-motors.co.th/a'])assert.equal(allowedSource(u),true);
  for(const u of ['http://porsche.com/a','https://127.0.0.1/a','https://localhost/a','https://porsche.com.evil.test/a','https://porsche.com:8443/a','https://user:pass@porsche.com/a','file:///x'])assert.equal(allowedSource(u),false,u);
});
test('reader: publisher bot restrictions cannot be undone by a wildcard allow',()=>{
  assert.equal(robotsAllow('User-agent: *\nAllow: /test\nUser-agent: Google-Extended\nDisallow: /','/test'),false);
  assert.equal(robotsAllow('User-agent: *\nAllow: /\nUser-agent: CendonSpecs\nDisallow: /private','/private'),false);
  assert.equal(robotsAllow('User-agent: *\nDisallow: /\nAllow: /public','/public/a'),true);
  assert.equal(robotsAllow('User-agent: *\nDisallow: /x$','/xyz'),true);
  assert.equal(robotsAllow('User-agent: *\nAllow: /\nContent-Signal: search=yes,ai-input=no','/public'),false);
  assert.equal(robotsAllow('User-agent: *\nAllow: /\nContent-Signal: search=yes,ai-train=no','/public'),false);
});
test('reader: scripts and hidden layout are not sent to the extraction model',()=>{
  const s=textOf('<script>secret</script><nav>menu</nav><p>Seats: 7 &amp; 5 doors.</p>');assert.equal(s,'Seats: 7 & 5 doors.');
});
test('reader: archive URL digits cannot select the wrong generation for a model year',()=>{
  const text='web/20131202035457 archive\nproduction = 1996–present\nOLD GENERATION\n'+'Old information. '.repeat(700)+'\nproduction = 2015–present\nCURRENT GENERATION\n2020 market';
  const s=excerpt(text,q);assert.match(s,/production = 2015–present/);assert.doesNotMatch(s,/OLD GENERATION/);
});
test('reader: official Thai specification articles rank above spyshots before per-site candidate limits',()=>{
  const query={make:'Porsche',model:'Cayenne',year:'2018'};
  const official=documentRank('https://www.headlightmag.com/official-price-porsche-cayenne-e-hybrid-2018/',query,{title:'ราคาอย่างเป็นทางการ Porsche Cayenne E-Hybrid',published:'2018-09-18'});
  const spy=documentRank('https://www.headlightmag.com/news-spyshot-2018-porsche-cayenne/',query,{title:'Spyshot: 2018 Porsche Cayenne',published:'2017-02-11'});
  assert.ok(official>spy);assert.ok(official>documentRank('https://newsroom.porsche.com/en/2022/products/porsche-cayenne-anniversary.html',query));
});
test('reader: actual readable documents count, wrong-year title and unreadable links do not',async()=>{
  const calls=installWeb(),trail=[],result=await collectSpecDocuments(q,trail);assert.equal(result.length,2);
  assert.equal(result[0].license,'CC BY-SA');assert.equal(result[1].primary,true);assert.equal(result[1].url,docs[0].url);
  assert.ok(calls.every(c=>!c.url.includes('evil.example')&&!c.url.includes('127.0.0.1')&&!c.url.endsWith('spec.pdf')));
});
test('reader: redirect into private address is rejected before fetch; discovery 403 is not Gemini auth failure',async()=>{
  const calls=installWeb({redirect:true}),result=await collectSpecDocuments(q);assert.equal(result.length,1);assert.ok(!calls.some(c=>c.url.includes('127.0.0.1')));
  installWeb({badDiscovery:true});await assert.rejects(collectSpecDocuments(q),/source_unavailable/);assert.equal(specFailure('source_unavailable: discovery_http_403').code,'source_unavailable');
});
test('reader: deadline bounds stalled network and response bodies and cancels downstream work',async()=>{
  let signal;await assert.rejects(timebox(s=>{signal=s;return new Promise(()=>{})},15),e=>e.name==='AbortError');assert.equal(signal.aborted,true);
  const ac=new AbortController();ac.abort();let started=false;await assert.rejects(timebox(()=>{started=true},20,ac.signal));assert.equal(started,false);
  globalThis.fetch=async()=>new Response(new ReadableStream({start(){}}));let downstream=0;
  await assert.rejects(timebox(s=>collectSpecDocuments(q,[],s).then(()=>downstream++),20),e=>e.name==='AbortError');assert.equal(downstream,0);
});

test('reader: an encyclopedia outage does not block a readable publisher document',async()=>{
  const url='https://www.autodeft.com/fixture-pajero-sport-2020';
  globalThis.fetch=async raw=>{const u=String(raw);
    if(u.includes('/w/api.php'))return new Response('Unavailable',{status:503});
    if(u.endsWith('/robots.txt'))return new Response('User-agent: *\nAllow: /');
    if(u.includes('/wp-json/'))return Response.json(u.includes('autodeft.com')?[{link:url,title:{rendered:'2020 Mitsubishi Pajero Sport'},date:'2020-01-01'}]:[]);
    if(u===url)return new Response('<title>2020 Mitsubishi Pajero Sport</title><p>'+paragraph+'</p>',{headers:{'content-type':'text/html'}});
    throw Error('Unexpected fixture request');
  };
  const result=await collectSpecDocuments(q);assert.equal(result.length,1);assert.equal(result[0].url,url);
});
test('extraction: every value needs an exact verified quotation; invented quotes, numbers and sources vanish',()=>{
  const raw=extraction();raw.length_mm=4825;raw.evidence['facts.length_mm']=[{source:0,quote:'Length: 4825 mm.'}];raw.tank_l=68;raw.evidence['facts.tank_l']=[{source:99,quote:'Tank: 68 litres.'}];raw.variants[0].hp=999;
  const out=cleanDocumentExtraction(raw,docs,q);assert.equal(out.seats,7);assert.equal(out.length_mm,null);assert.equal(out.tank_l,null);assert.equal(out.variants[0].hp,null);assert.equal(out.variants[0].cc,2442);assert.equal(out.body,null);
  assert.deepEqual(out.evidence['facts.seats'],[0]);assert.ok(!JSON.stringify(out).includes('Power:'));
});
test('extraction: evidence maps, single objects, nested properties and flat arrays retain the same exact-quote validation',()=>{
  for(const shape of ['object','nested','array']){const raw=extraction();
    if(shape==='object')raw.evidence=Object.fromEntries(Object.entries(raw.evidence).map(([k,v])=>[k.replace(/^facts\./,''),v[0]]));
    if(shape==='nested'){const original=raw.evidence;raw.evidence={facts:{seats:original['facts.seats'][0]},variants:[{}]};for(const [k,v] of Object.entries(original))if(k.startsWith('variants.0.'))raw.evidence.variants[0][k.split('.').pop()]=v[0]}
    if(shape==='array')raw.evidence=Object.entries(raw.evidence).flatMap(([path,a])=>a.map(e=>({...e,path:path.replace('variants.0.','variants[0].')})));
    raw.variants[0].cc={value:'2,442'};const out=cleanDocumentExtraction(raw,docs,q);assert.equal(out.seats,7,shape);assert.equal(out.variants[0].cc,2442,shape);assert.deepEqual(out.evidence['facts.seats'],[0]);
  }
});
test('extraction: omitted optional market permits basic references, explicit market still requires matching country evidence',()=>{
  const raw=extraction(),source={...docs[0],url:'https://porsche.com/test-2020',text:paragraph.replace('Thailand','Germany')};raw.scope[0].year_quote='Mitsubishi Pajero Sport 2020 Germany specification.';
  assert.equal(cleanDocumentExtraction(raw,[source],{make:q.make,model:q.model,year:q.year}).seats,7);
  assert.equal(cleanDocumentExtraction(raw,[source],{...q,market:'TH'}).seats,null);
});
test('extraction: missing, boolean or fabricated source IDs never implicitly mean source zero',()=>{
  for(const source of [null,false,'','unknown',99]){const raw=extraction();raw.evidence['facts.seats']={source,quote:'Seats: 7.'};assert.equal(cleanDocumentExtraction(raw,docs,q).seats,null,String(source));}
});
test('reader: wiki formatting becomes readable without inventing conversions, and archived references do not replace production dates',()=>{
  const s=wikiPlain("| production = 2017–2023\n| length = {{convert|4918|mm|in|abbr=on}}\n| engine = [[Example engine|V6 engine]]<ref>web/20181231</ref>");assert.match(s,/4918 mm/);assert.match(s,/V6 engine/);assert.doesNotMatch(s,/convert|20181231|\[\[/);
  assert.match(wikiPlain('{{convert|4918|-|4930|mm}}'),/4918\|-\|4930/,'ranges must not silently become one number');
});
test('free pipeline: sourced body-only basic information is useful, without manufacturing missing numerical specs',async()=>{
  const raw={found:true,body:'suv',variants:[],scope:[{source:1,year_quote:'Mitsubishi Pajero Sport 2020 Thailand specification.'}],evidence:{body:{source:1,quote:'Pajero Sport'}}};
  const calls=installWeb({aiResponse:raw}),base=globalThis.fetch;
  globalThis.fetch=async(url,opt)=>{const r=await base(url,opt);if(String(url)===docs[0].url){const s=await r.text();return new Response(s+'<p>Body: SUV.</p>',{headers:{'content-type':'text/html'}})}return r};
  raw.evidence.body.quote='Body: SUV.';const r=await research({GEMINI_KEY:'test-only-key'},{make:q.make,model:q.model,year:q.year});assert.equal(r.status,'ready');assert.equal(r.data.body,'suv');assert.ok(r.data.score.cells>0);assert.equal(r.data.facts.seats,null);assert.equal(r.sources.length,1);assert.equal(calls.filter(c=>c.url.includes('generativelanguage')).length,2);
});
test('extraction: wrong year, missing year scope and wrong market cannot become Thailand specifications',()=>{
  const raw=extraction();for(const query of [{...q,year:'2021'},{...q,market:'JP'}]){const out=cleanDocumentExtraction(raw,docs,query);assert.equal(out.seats,null);assert.equal(out.variants.length,0);}
  raw.scope=[];assert.equal(cleanDocumentExtraction(raw,docs,q).seats,null);
  const usDocs=docs.map(d=>({...d,url:'https://www.caranddriver.com/test-pajero-sport'}));assert.equal(cleanDocumentExtraction(extraction(),usDocs,q).seats,null,'a US publisher needs explicit Thai market evidence');
  raw.scope=[{source:0,year_quote:'Mitsubishi Pajero Sport 2020 Thailand specification.',market_quote:'2020 Thailand specification.'}];assert.equal(cleanDocumentExtraction(raw,usDocs,q).seats,7);
});
test('extraction: nested facts keep their proof requirement and manufacturing country is not a sales-market proof',()=>{
  const raw=extraction();raw.facts={seats:raw.seats};delete raw.seats;assert.equal(cleanDocumentExtraction(raw,docs,q).seats,7);
  const d={...docs[0],url:'https://porsche.com/a',text:paragraph+' Assembly: Thailand.'};raw.scope[0].market_quote='Assembly: Thailand.';assert.equal(cleanDocumentExtraction(raw,[d],q).seats,null);
});
test('extraction: an unrelated generation far from the year context is rejected',()=>{
  const d={...docs[0],url:'https://www.mitsubishi-motors.co.th/pajero-sport-history',title:'Mitsubishi Pajero Sport',text:'2020 Thailand specification. '+ 'Other unrelated section. '.repeat(110)+ 'Seats: 7.'};
  const raw=extraction();raw.scope=[{source:0,year_quote:'2020 Thailand specification.'}];assert.equal(cleanDocumentExtraction(raw,[d],q).seats,null);
});
test('extraction: source IDs follow their variant when an unsupported variant is removed',()=>{
  const raw=extraction(),v=raw.variants[0];raw.variants=[{name:'invented'},v];const evidence={};for(const [k,a] of Object.entries(raw.evidence))evidence[k.replace('variants.0.','variants.1.')]=a;raw.evidence=evidence;
  const out=cleanDocumentExtraction(raw,docs,q),m=merge(out,out);assert.equal(m.variants.length,1);assert.deepEqual(m.variants[0].hp.sourceIds,[0]);assert.equal(m.variants[0].hp.v,181);
});
test('extraction: PS or kW cannot be silently relabeled hp',()=>{
  for(const unit of ['PS','kW']){const d={...docs[0],text:paragraph.replace('181 hp','181 '+unit)},raw=extraction();raw.evidence['variants.0.hp']=[{source:0,quote:'Power: 181 '+unit+'.'}];assert.equal(cleanDocumentExtraction(raw,[d],q).variants[0].hp,null);}
});
test('free pipeline: real document input, no Google Search tool, only validated cited sources, two passes not two independent sites',async()=>{
  const raw=extraction();raw.scope[0].source=1;for(const entries of Object.values(raw.evidence))for(const e of entries)e.source=1;
  const calls=installWeb({aiResponse:raw}),r=await research({GEMINI_KEY:'test-only-key'},q);
  assert.equal(r.status,'ready');assert.equal(r.data.review,'document_extraction');assert.equal(r.data.facts.seats.v,7);assert.equal(r.sources.length,1);
  assert.equal(r.sources[0].url,docs[0].url);assert.equal(r.data.coverage.readCount,2);assert.equal(r.data.coverage.sourceCount,1);
  const ai=calls.filter(c=>c.url.includes('generativelanguage'));assert.equal(ai.length,2);
  for(const c of ai){const b=JSON.parse(c.init.body);assert.equal(b.tools,undefined);assert.equal(b.generationConfig.responseMimeType,'application/json');assert.match(b.contents[0].parts[0].text,/scope/);assert.doesNotMatch(b.contents[0].parts[0].text,/ค้นเว็บหาข้อมูล|VIN|PRIVATE/);}
  assert.ok(!JSON.stringify(r).includes('Do not publish'));
});
test('free pipeline: total budget includes discovery and forbids late Gemini calls after cancellation',async()=>{
  const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Promise(()=>{})};
  await assert.rejects(research({GEMINI_KEY:'test-only-key'},q,[],{budgetMs:20}),e=>e.name==='AbortError');
  const n=calls.length;await new Promise(r=>setTimeout(r,30));assert.equal(calls.length,n);assert.ok(!calls.some(c=>String(c.url).includes('generativelanguage')));assert.ok(calls.every(c=>c.init.signal.aborted));
});
test('free pipeline: two honest negative extractions stop after two calls and are not proof that the model never existed',async()=>{
  const calls=installWeb({aiResponse:{found:false}});await assert.rejects(research({GEMINI_KEY:'test-only-key'},q),/ยืนยัน/);assert.equal(calls.filter(c=>c.url.includes('generativelanguage')).length,2);
});
const equipmentText=' Standard equipment: Adaptive Cruise Control. Optional equipment: Heated seats. Body equipment includes PASM. ';
function equipmentExtraction(){return {found:true,scope:[{source:1,year_quote:'Mitsubishi Pajero Sport 2020 Thailand specification.'}],equipment:[
  {name:'Adaptive Cruise Control',category:'safety',availability:'standard',variant:null},
  {name:'Heated seats',category:'comfort',availability:'optional',variant:null},
  {name:'PASM',category:'comfort',availability:'standard',variant:null}],evidence:[
  {path:'equipment.0.name',source:1,quote:'Standard equipment: Adaptive Cruise Control.'},
  {path:'equipment.1.name',source:1,quote:'Optional equipment: Heated seats.'},
  {path:'equipment.2.name',source:1,quote:'Body equipment includes PASM.'}]};}
test('equipment: exact quotations are required and standard/optional labels cannot be invented',()=>{
  const raw=equipmentExtraction(),d={...docs[0],id:1,text:paragraph+equipmentText};
  raw.equipment.push({name:'Invented autopilot',category:'safety',availability:'standard'});raw.evidence.push({path:'equipment.3.name',source:1,quote:'Standard equipment: Invented autopilot.'});
  const out=cleanDocumentExtraction(raw,[d],{...q,market:'GLOBAL'});assert.equal(out.equipment.length,3);assert.deepEqual(out.equipment.map(x=>x.availability),['standard','optional','listed']);assert.deepEqual(out.equipment[0].sourceIds,[1]);
});
test('equipment: explicitly absent features are not advertised as present or standard',()=>{
  const raw=equipmentExtraction(),d={...docs[0],id:1,text:paragraph+' This trim is not equipped with Adaptive Cruise Control. Heated seats are not standard. PASM is unavailable.'};
  raw.evidence[0].quote='This trim is not equipped with Adaptive Cruise Control.';raw.evidence[1].quote='Heated seats are not standard.';raw.equipment[1].availability='standard';raw.evidence[2].quote='PASM is unavailable.';
  const out=cleanDocumentExtraction(raw,[d],{...q,market:'GLOBAL'});assert.ok(!out.equipment.some(x=>x.name==='Adaptive Cruise Control'));assert.ok(!out.equipment.some(x=>x.name==='PASM'));assert.equal(out.equipment.find(x=>x.name==='Heated seats').availability,'listed');
});
test('equipment: a fabricated extra quotation from the same cited document cannot upgrade availability',()=>{
  const raw=equipmentExtraction(),d={...docs[0],id:1,text:paragraph+equipmentText};
  raw.evidence.push({path:'equipment.2.name',source:1,quote:'PASM is standard equipment.'});
  assert.equal(cleanDocumentExtraction(raw,[d],{...q,market:'GLOBAL'}).equipment.find(x=>x.name==='PASM').availability,'listed');
});
test('equipment: exact-year model specification article supplies reference context without fabricated year quotes; numerical specs remain strict',()=>{
  const raw=equipmentExtraction();raw.scope=[];raw.seats=7;raw.evidence.push({path:'facts.seats',source:1,quote:'Seats: 7.'});
  const d={...docs[0],id:1,url:'https://www.headlightmag.com/official-price-mitsubishi-pajero-sport-2020/',title:'ราคาอย่างเป็นทางการ Mitsubishi Pajero Sport',text:paragraph+equipmentText};
  const out=cleanDocumentExtraction(raw,[d],{...q,market:'GLOBAL'},{kind:'equipment'});assert.equal(out.equipment.length,3);assert.equal(out.seats,null);assert.deepEqual(out.equipment[0].sourceIds,[1]);
  for(const bad of [{...d,url:d.url.replace('2020','2021')},{...d,title:'Spyshot Mitsubishi Pajero Sport 2020'},{...d,title:'Toyota Hilux 2020 specification'},{...d,url:'https://en.wikipedia.org/wiki/Mitsubishi_Pajero_Sport',title:'Mitsubishi Pajero Sport'}])assert.equal(cleanDocumentExtraction(raw,[bad],{...q,market:'GLOBAL'},{kind:'equipment'}).equipment.length,0);
  assert.equal(cleanDocumentExtraction(raw,[d],{...q,market:'JP'},{kind:'equipment'}).equipment.length,0,'an exact-year Thai article is not evidence of Japanese equipment');
});
test('equipment: real document mode has no search tools and returns only cited items, separate from numerical specs',async()=>{
  const raw=equipmentExtraction(),calls=installWeb({aiResponse:raw}),base=globalThis.fetch;
  globalThis.fetch=async(url,opt)=>{const r=await base(url,opt);if(String(url)===docs[0].url)return new Response((await r.text())+'<p>'+equipmentText+'</p>',{headers:{'content-type':'text/html'}});return r};
  const r=await research({GEMINI_KEY:'test-only-key'},q,[],{kind:'equipment'});assert.equal(r.status,'ready');assert.equal(r.data.kind,'equipment');assert.equal(r.data.equipment.length,3);assert.equal(r.data.equipmentSchema,1);assert.ok(r.data.equipment.every(x=>x.ok===true));assert.equal(r.sources.length,1);assert.deepEqual(r.data.facts,{});
  for(const c of calls.filter(c=>c.url.includes('generativelanguage'))){const b=JSON.parse(c.init.body);assert.equal(b.tools,undefined);assert.match(b.contents[0].parts[0].text,/รายการอุปกรณ์/);}
});
test('equipment: one stalled extraction cannot discard a successful sourced pass, and its requests are cancelled',async()=>{
  const raw=equipmentExtraction(),calls=installWeb({aiResponse:raw}),base=globalThis.fetch,stalled=[];
  globalThis.fetch=async(url,opt)=>{
    if(String(url).includes('generativelanguage')&&!JSON.parse(opt.body).contents[0].parts[0].text.startsWith('ตรวจอย่างระมัดระวัง')){stalled.push(opt.signal);return new Promise(()=>{})}
    const r=await base(url,opt);if(String(url)===docs[0].url)return new Response((await r.text())+'<p>'+equipmentText+'</p>',{headers:{'content-type':'text/html'}});return r;
  };
  const log=[],r=await research({GEMINI_KEY:'test-only-key'},q,log,{kind:'equipment',budgetMs:200});
  assert.equal(r.status,'ready');assert.equal(r.passes,1);assert.equal(r.data.equipment.length,3);assert.ok(r.data.equipment.every(x=>x.ok===null));assert.equal(r.data.score.confirmed,0);assert.equal(r.sources.length,1);assert.equal(stalled.length,1);assert.ok(stalled.every(s=>s.aborted));assert.ok(log.some(s=>s.step==='extraction-deadline'));assert.equal(calls.filter(c=>c.url.includes('generativelanguage')).length,1);
});
