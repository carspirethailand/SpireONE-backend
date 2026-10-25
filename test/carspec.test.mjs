import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './tech-fixtures.mjs';
import worker from '../src/worker.js';
import {validQuery, merge, field, specAI} from '../src/carspec.js';
import {decodeVin, cleanInfo} from '../src/vin.js';
import {chatModels} from '../src/fastai.js';

/* คลังสเปกรถ: ค้นจริงครั้งเดียว ทุกคนใช้ร่วมกัน · Gemini และเว็บในเทสต์เป็นของปลอมทั้งหมด */
const PAJERO={found:true,body:'suv',generation:'Gen 3 (2015–2024)',market:'ไทย',
  variants:[{name:'2.4 GT Premium 2WD',engine:'2.4L 4 สูบ ดีเซล เทอร์โบ',fuel:'diesel',cc:2442,hp:181,torque_nm:430,gearbox:'อัตโนมัติ 8 สปีด',drive:'RWD',l_per_100km:7.9},
            {name:'2.4 GT Premium 4WD',engine:'2.4L ดีเซล',fuel:'diesel',cc:2442,hp:181,torque_nm:430,gearbox:'อัตโนมัติ 8 สปีด',drive:'4WD',l_per_100km:8.3}],
  seats:7,doors:5,length_mm:4825,width_mm:1815,height_mm:1835,wheelbase_mm:2800,kerb_kg:2045,tank_l:68,tire:'265/60 R18',
  safety:['ถุงลมนิรภัย 7 ตำแหน่ง','ABS','ASC'],comfort:['กุญแจอัจฉริยะ'],notes:null};

/* เอกสารสาธารณะจำลอง (ไม่มีการค้น Google อีกแล้ว): ทุกค่าของสองรอบเขียนเป็นประโยคพร้อมคำกำกับ/หน่วยในหน้า Wikipedia จำลอง
   แล้ว "Gemini" ตอบด้วยหลักฐานที่คัดตรงตัวจากเอกสาร — ผ่านตัวตรวจหลักฐานจริง (cleanDocumentExtraction) เหมือนของจริง */
const ORD=['first','second','third','fourth','fifth','sixth'];
const FACT={seats:v=>v+' seats',doors:v=>v+' doors',length_mm:v=>'length '+v+' mm',width_mm:v=>'width '+v+' mm',height_mm:v=>'height '+v+' mm',wheelbase_mm:v=>'wheelbase '+v+' mm',
  kerb_kg:v=>'kerb weight '+v+' kg',tank_l:v=>'fuel tank '+v+' litres',tire:v=>'tyres '+v,body:v=>'body '+v,generation:v=>'generation '+v,market:v=>'market '+v};
const VAR={name:v=>'variant '+v,engine:v=>'engine '+v,fuel:v=>'fuel '+v,cc:v=>v+' cc',hp:v=>v+' hp',torque_nm:v=>'torque '+v+' Nm',gearbox:v=>'gearbox '+v,drive:v=>'drive '+v,l_per_100km:v=>v+' L/100 km'};
function specDoc(pass,tag){
  if(!pass||pass.found!==true)return {lines:[],evidence:[],scope:null};
  const lines=['Lookup '+tag+' model years 1950-2030.','Lookup '+tag+' sold in Japan and Thailand.'],evidence=[];
  for(const [k,f] of Object.entries(FACT))if(pass[k]!=null){const q='Lookup '+tag+' '+f(pass[k]);lines.push(q+'.');evidence.push({path:'facts.'+k,source:0,quote:q})}
  (pass.variants||[]).forEach((v,i)=>{for(const [k,f] of Object.entries(VAR))if(v[k]!=null){const q='Lookup '+tag+' '+ORD[i]+' '+f(v[k]);lines.push(q+'.');evidence.push({path:'variants.'+i+'.'+k,source:0,quote:q})}});
  return {lines,evidence,scope:{source:0,year_quote:'Lookup '+tag+' model years 1950-2030.',market_quote:'Lookup '+tag+' sold in Japan and Thailand.'}};
}
/* คำตอบแบบสกัดจากเอกสาร (รอบ B ขึ้นต้นด้วย "ตรวจอย่างระมัดระวัง") — ใช้ในเทสต์ที่จำลอง Gemini เอง */
const isSecond=body=>/ตรวจอย่างระมัดระวัง/.test(body.contents[0].parts[0].text);
function docAnswer(pass,second){const d=specDoc(pass,second?'B':'A');return pass&&pass.found===true?{...pass,scope:[d.scope],evidence:d.evidence}:pass}
function setup({passA=PAJERO,passB=PAJERO,fail=false}={}){
  const f=fixture({DEV_AUTH:'1',FIREBASE_PROJECT_ID:'unit-test',GEMINI_KEY:'test-only-key'});
  f.sqlite.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT); INSERT INTO config VALUES ('schema_version','999');
    CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, actor TEXT, action TEXT, target TEXT, detail TEXT);
    CREATE TABLE car_specs (k TEXT PRIMARY KEY, make TEXT NOT NULL, model TEXT NOT NULL, year TEXT NOT NULL, status TEXT NOT NULL, body TEXT, data TEXT,
      sources TEXT, models TEXT, error TEXT, hits INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, by_uid TEXT);
    CREATE TABLE car_spec_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL, note TEXT, who TEXT, at INTEGER NOT NULL);
    CREATE TABLE spec_quota (who TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (who, day));
    CREATE TABLE user_state (uid TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (uid, k));
    CREATE TABLE cars (id TEXT PRIMARY KEY, uid TEXT NOT NULL, make TEXT NOT NULL, model TEXT NOT NULL, year TEXT, mileage TEXT, created_at INTEGER NOT NULL, color TEXT, body TEXT, info TEXT);`);
  f.sqlite.prepare("INSERT INTO users (uid, role, banned) VALUES ('boss','admin',0),('cust','user',0)").run();
  const ai=[],web=[],A=specDoc(passA,'A'),B=specDoc(passB,'B');let title='';
  globalThis.fetch=async(url,init={})=>{const u=String(url);
    if(u.includes('generativelanguage')){const body=JSON.parse(init.body);ai.push({u,body});
      if(fail)return new Response('quota',{status:429});
      const second=isSecond(body),out=docAnswer(second?passB:passA,second);
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'```json\n'+JSON.stringify(out)+'\n```'}]}}]});}
    if(u.includes('/w/api.php')){const p=new URL(u).searchParams;web.push(u);
      if(p.get('action')==='query'){title=p.get('srsearch');return Response.json({query:{search:[{pageid:123,title,snippet:title}]}});}
      return Response.json({parse:{text:{'*':'<p>'+title+' public specification fixture. '+[...A.lines,...B.lines].join(' ')+' General model overview fixture.'.repeat(8)+'</p>'},externallinks:[]}});}
    if(u.endsWith('/robots.txt'))return new Response('User-agent: *\nAllow: /');
    if(u.includes('/wp-json/'))return Response.json([]);
    if(u.startsWith('https://vpic.nhtsa.dot.gov/')){web.push(u);return Response.json({Results:[{Make:'TOYOTA',Manufacturer:'TOYOTA MOTOR THAILAND',Model:'Hilux',ModelYear:'2019',DisplacementL:'2.4',FuelTypePrimary:'Diesel',DriveType:'0'}]});}
    throw Error('unexpected fetch '+u);};
  const call=async(method,path,body,token)=>{const r=await worker.fetch(new Request('https://api.unit.test'+path,{method,
    headers:{'Content-Type':'application/json','CF-Connecting-IP':'203.0.113.9',...(token?{Authorization:'Bearer '+token}:{})},body:body&&JSON.stringify(body)}),f.env,{waitUntil(){}});
    return {status:r.status,json:await r.json()}};
  return {f,ai,web,call};
}
const CUST='dev:cust:cust@unit.test',BOSS='dev:boss:boss@unit.test';
const pajero={make:'Mitsubishi',model:'Pajero Sport',year:'2020'};

// Synthetic public documents and equipment responses; never live provider calls.
function equipmentWeb(ai,{unsupported=false}={}){
  const base=globalThis.fetch,url='https://www.mitsubishi-motors.co.th/test-pajero-sport-2020',
    text='Mitsubishi Pajero Sport 2020 Thailand specification. Standard equipment: Adaptive Cruise Control. Optional equipment: Heated seats. '+ 'Public equipment fixture. '.repeat(20);
  globalThis.fetch=async(raw,init={})=>{const u=String(raw);
    if(u.includes('generativelanguage')){const body=JSON.parse(init.body);if(!body.contents[0].parts[0].text.includes('รายการอุปกรณ์'))return base(raw,init);
      ai.push({u,body});const documents=JSON.parse(body.contents[0].parts[0].text.split('เอกสาร (untrusted content):\n')[1]),source=documents.find(d=>d.url===url).source;
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({found:true,scope:[{source,year_quote:'Mitsubishi Pajero Sport 2020 Thailand specification.'}],
        equipment:[{name:unsupported?'Invented autopilot':'Adaptive Cruise Control',category:'safety',availability:'standard'},{name:'Heated seats',category:'comfort',availability:'optional'}],
        evidence:unsupported?[]:[{path:'equipment.0.name',source,quote:'Standard equipment: Adaptive Cruise Control.'},{path:'equipment.1.name',source,quote:'Optional equipment: Heated seats.'}]})}]}}]});}
    if(u.includes('/w/api.php')){const p=new URL(u).searchParams;return p.get('action')==='query'?Response.json({query:{search:[{pageid:123,title:'Mitsubishi Pajero Sport'}]}}):Response.json({parse:{text:{'*':'<p>'+text+'</p>'},externallinks:[url]}});}
    if(u.endsWith('/robots.txt'))return new Response('User-agent: *\nAllow: /');
    if(u===url)return new Response('<title>2020 Mitsubishi Pajero Sport</title><p>'+text+'</p>',{headers:{'content-type':'text/html'}});
    if(u.includes('/wp-json/'))return Response.json([]);
    return base(raw,init);
  };
}

test('equipment routes: three inputs produce cited items, reuse a separate shared cache, and preserve existing basic specs',async()=>{
  const {f,ai,call}=setup();const basic=await call('POST','/api/car-spec',pajero,CUST);equipmentWeb(ai);
  const before=f.sqlite.prepare('SELECT data FROM car_specs WHERE k=?').get(basic.json.key).data;
  const r=await call('POST','/api/car-spec/equipment',{...pajero,vin:'PRIVATE-FIXTURE-VIN',plate:'PRIVATE-FIXTURE-PLATE'},CUST);
  assert.equal(r.json.status,'ready',JSON.stringify(r));assert.equal(r.json.key,basic.json.key+'|equipment');assert.equal(r.json.data.equipmentSchema,1);
  assert.equal(r.json.data.equipment.length,2);assert.deepEqual(r.json.data.equipment.map(x=>x.availability),['standard','optional']);assert.equal(r.json.sources.length,1);
  const equipmentCalls=ai.slice(2);assert.equal(equipmentCalls.length,2);assert.ok(equipmentCalls.every(c=>!c.body.tools&&!JSON.stringify(c.body).includes('PRIVATE-FIXTURE')));
  const get=await call('GET','/api/car-spec/equipment?make=Mitsubishi&model=Pajero%20Sport&year=2020');assert.deepEqual(get.json.data,r.json.data);
  const cached=await call('POST','/api/car-spec/equipment',pajero);assert.deepEqual(cached.json.data,r.json.data);assert.equal(ai.length,4);
  assert.equal(f.sqlite.prepare('SELECT data FROM car_specs WHERE k=?').get(basic.json.key).data,before);
  assert.deepEqual((await call('GET','/api/car-spec?make=Mitsubishi&model=Pajero%20Sport&year=2020')).json.data,basic.json.data);
  assert.equal(f.sqlite.prepare("SELECT n FROM spec_quota WHERE who='u:cust'").get().n,2,'basic and equipment research share the existing allowance; cached requests are free');
});
test('equipment routes: unsupported claims fail honestly and refund lookup budget without deleting basic specs',async()=>{
  const {f,ai,call}=setup();const basic=await call('POST','/api/car-spec',pajero,CUST);equipmentWeb(ai,{unsupported:true});
  const r=await call('POST','/api/car-spec/equipment',pajero,CUST);assert.equal(r.json.status,'failed');assert.equal(r.json.code,'unconfirmed');
  assert.equal(f.sqlite.prepare("SELECT n FROM spec_quota WHERE who='u:cust'").get().n,1);assert.equal((await call('GET','/api/car-spec?make=Mitsubishi&model=Pajero%20Sport&year=2020')).json.status,'ready');
  assert.equal(basic.json.status,'ready');
});
test('equipment routes: invalid bearer never becomes a guest or spends lookup allowance',async()=>{
  const {f,ai,call}=setup();for(const method of ['GET','POST']){const r=await call(method,'/api/car-spec/equipment'+(method==='GET'?'?make=Mitsubishi&model=Pajero%20Sport&year=2020':''),method==='POST'?pajero:null,'invalid-fixture-token');assert.equal(r.status,401);assert.equal(r.json.code,'auth_required');}
  assert.equal(ai.length,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM spec_quota').get().n,0);
});
test('equipment administration: redo retains the equipment kind and Thailand market without touching basic records',async()=>{
  const {f,ai,call}=setup();equipmentWeb(ai);const r=await call('POST','/api/car-spec/equipment',{...pajero,market:'TH'},CUST);assert.equal(r.json.status,'ready',JSON.stringify(r));assert.equal(r.json.key,'mitsubishi|pajero sport|2020|equipment');
  const redo=await call('POST','/api/admin/car-specs/redo',{key:r.json.key},BOSS);assert.equal(redo.json.status,'ready');assert.equal(redo.json.key,r.json.key);assert.equal(redo.json.data.query.market,'TH');assert.equal(ai.length,4);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM car_specs').get().n,1);
});

test('car spec: only real-looking car names and years are researched',()=>{
  assert.deepEqual(validQuery({make:' Mitsubishi ',model:'Pajero  Sport',year:'2020'}),{make:'Mitsubishi',model:'Pajero Sport',year:'2020',market:'GLOBAL'});
  for(const q of [{make:'x'.repeat(41),model:'a',year:'2020'},{make:'BMW',model:'<script>',year:'2020'},{make:'BMW',model:'X5',year:'1899'},{make:'BMW',model:'X5',year:'20200'}])
    assert.equal(validQuery(q),null,JSON.stringify(q));
});

test('car spec: two independent lookups are compared field by field',()=>{
  assert.deepEqual(field(181,180),{v:181,ok:true},'one-unit rounding is tolerated, not a generic four-percent difference');
  assert.deepEqual(field(181,150),{v:181,ok:false,alt:150},'different numbers keep both');
  assert.deepEqual(field(null,68),{v:68,ok:null},'one source only');
  const m=merge(PAJERO,{...PAJERO,body:'suv',kerb_kg:1990,variants:[{...PAJERO.variants[1],hp:178},{...PAJERO.variants[0]}]});
  assert.equal(m.body,'suv');assert.equal(m.body_ok,true);
  assert.equal(m.variants.length,2);assert.equal(m.variants[1].drive.v,'4WD','variants are matched by engine and drive, not by order');
  assert.equal(m.variants[1].hp.ok,false);assert.equal(m.facts.kerb_kg.ok,false,'different actual specifications must not be collapsed into a 3% tolerance');
  const bad=merge(PAJERO,{...PAJERO,body:'mpv',tank_l:80});
  assert.equal(bad.body,null,'body types that disagree are not trusted');assert.equal(bad.facts.tank_l.ok,false);assert.equal(bad.facts.tank_l.alt,80);
  assert.ok(m.score.confirmed>10&&m.score.conflicts===2);
});

test('car spec: the first person to pick a model triggers AI once; everyone after gets the same data instantly',async()=>{
  const {f,ai,call}=setup();
  const r=await call('POST','/api/car-spec',pajero,CUST);
  assert.equal(r.status,200);assert.equal(r.json.status,'ready');assert.equal(r.json.body,'suv');
  assert.equal(ai.length,2,'two independent lookups');assert.ok(ai.every(c=>!c.body.tools&&c.body.contents[0].parts[0].text.includes('เอกสาร (untrusted content)')),'both extract from the documents actually read — no Google Search tool');
  assert.notEqual(ai[0].u.split('/models/')[1].split(':')[0],ai[1].u.split('/models/')[1].split(':')[0],'the two lookups use different models');
  assert.deepEqual(r.json.sources.map(s=>s.url),['https://en.wikipedia.org/wiki/Mitsubishi_Pajero_Sport'],'source links are the documents the server read, not typed by the AI');
  assert.equal(r.json.data.variants[0].hp.ok,true);
  /* คนอื่น · ไม่ล็อกอิน · ตัวพิมพ์ต่างกัน → ข้อมูลชุดเดิม ไม่เรียก AI */
  const again=await call('POST','/api/car-spec',{make:'MITSUBISHI',model:'pajero sport',year:'2020'});
  assert.equal(again.json.status,'ready');assert.equal(ai.length,2,'no new AI call');
  assert.deepEqual(again.json.data,r.json.data);
  assert.equal((await call('GET','/api/car-spec?make=Mitsubishi&model=Pajero%20Sport&year=2020')).json.status,'ready');
  assert.equal((await call('GET','/api/car-spec?make=Mitsubishi&model=Triton&year=2020')).json.status,'none');
  assert.equal(f.sqlite.prepare('SELECT hits FROM car_specs').get().hits,1);
});

test('car spec: documents that do not confirm a model are reported as unconfirmed (never a permanent notfound); AI failure is retried later, not cached forever',async()=>{
  let {ai,call}=setup({passA:{found:false},passB:{found:false}});
  const none=(await call('POST','/api/car-spec',{make:'Toyota',model:'Supra',year:'1950'},CUST)).json;
  assert.equal(none.status,'failed');assert.equal(none.code,'unconfirmed');assert.notEqual(none.status,'notfound');
  await call('POST','/api/car-spec',{make:'Toyota',model:'Supra',year:'1950'},CUST);assert.equal(ai.length,2,'opening again right away reuses the result');
  ({call}=setup({fail:true}));
  const r=await call('POST','/api/car-spec',pajero,CUST);
  assert.equal(r.json.status,'failed');assert.ok(r.json.error);
});

test('car spec: new research is limited per person per day (cached models are unlimited)',async()=>{
  const {ai,call}=setup();
  for(const m of ['A1','A2','A3'])assert.equal((await call('POST','/api/car-spec',{make:'Honda',model:m,year:'2020'})).json.status,'ready');
  assert.equal((await call('POST','/api/car-spec',{make:'Honda',model:'A4',year:'2020'})).json.status,'limited','a guest IP can research 3 new models a day');
  const n=ai.length;
  assert.equal((await call('POST','/api/car-spec',{make:'Honda',model:'A1',year:'2020'})).json.status,'ready','models already in the library still load');
  assert.equal(ai.length,n);
  assert.equal((await call('POST','/api/car-spec',{make:'Honda',model:'A4',year:'2020'},CUST)).json.status,'ready','a signed-in user has their own allowance');
});

test('car spec: users report wrong data; admin sees reports, re-researches (reports cleared) or verifies (locked)',async()=>{
  const {f,ai,call}=setup();
  const {json:s}=await call('POST','/api/car-spec',pajero,CUST);
  assert.equal((await call('POST','/api/car-spec/report',{key:s.key,note:'ถังน้ำมันจริง 68 ลิตร แต่รุ่นปี 2020 มี 2 แบบ'},CUST)).status,200);
  assert.equal((await call('GET','/api/admin/car-specs',null,CUST)).status,403,'not for regular users');
  const list=(await call('GET','/api/admin/car-specs',null,BOSS)).json;
  assert.equal(list[0].reports,1);assert.match(list[0].notes[0].note,/ถังน้ำมัน/);
  const redo=await call('POST','/api/admin/car-specs/redo',{key:s.key},BOSS);
  assert.equal(redo.json.status,'ready');assert.equal(redo.json.reports,0);assert.equal(ai.length,4);
  const v=await call('POST','/api/admin/car-specs/verify',{key:s.key},BOSS);
  assert.equal(v.json.status,'verified');assert.equal(v.json.verified,true);
  await call('POST','/api/car-spec',pajero,CUST);assert.equal(ai.length,4,'verified data is never re-researched by users');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit WHERE action IN ('spec_redo','spec_verify')").get().n,2);
});

test('VIN: country, maker and model-year hint decoded locally; details from vPIC when available',async()=>{
  const d=decodeVin('mr0ex3cb3k0123456',new Date('2026-10-09'));
  assert.equal(d.valid,true);assert.equal(d.vin,'MR0EX3CB3K0123456');assert.equal(d.country,'ไทย');assert.equal(d.maker,'Toyota (ไทย)');assert.equal(d.year_hint,2019);
  assert.equal(decodeVin('MR0EX3CB3K012345O').valid,false,'O is not allowed in a VIN');assert.equal(decodeVin('ABC').valid,false);
  const {call,web}=setup();
  const r=await call('GET','/api/vin/MR0EX3CB3K0123456');
  assert.equal(r.json.vpic.model,'Hilux');assert.equal(r.json.vpic.drive,null,'"0" from vPIC means unknown');assert.equal(web.length,1);
  assert.equal((await call('GET','/api/vin/NOTAVIN')).json.valid,false);assert.equal(web.length,1,'invalid VINs are not sent anywhere');
});

test('car info: optional fields are cleaned, saved with the car, and kept when not sent',async()=>{
  assert.deepEqual(cleanInfo({vin:'mr0ex3cb3k0123456',plate:'กข 1234',tax_due:'2027-01-31',ins_due:'31/01/2027',hack:'x',trim:'  2.4 GT  '}),
    {vin:'MR0EX3CB3K0123456',trim:'2.4 GT',plate:'กข 1234',tax_due:'2027-01-31'});
  assert.equal(cleanInfo({vin:'BAD'}),null);
  const {f,call}=setup();
  await call('POST','/api/cars',{id:'c1',make:'Toyota',model:'Hilux',year:'2019',info:{vin:'MR0EX3CB3K0123456',plate:'กข 1234'}},CUST);
  await call('POST','/api/cars',{id:'c1',make:'Toyota',model:'Hilux',year:'2019',mileage:'90000'},CUST);
  assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT info FROM cars').get().info),{vin:'MR0EX3CB3K0123456',plate:'กข 1234'},'not sent = kept');
  await call('POST','/api/cars',{id:'c1',make:'Toyota',model:'Hilux',year:'2019',info:{plate:'กข 1234'}},CUST);
  assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT info FROM cars').get().info),{plate:'กข 1234'},'sent = replaced, removed fields are gone');
});

test('car spec: extraction asks for JSON straight from the read documents (no Google Search tool); a prose answer is never published',async()=>{
  const {f,ai}=setup();
  const real=globalThis.fetch;
  globalThis.fetch=async(url,init={})=>{const u=String(url);
    if(u.includes('generativelanguage')){const body=JSON.parse(init.body);ai.push({u,body});
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'จากการค้นพบว่า Pajero Sport 2020 มีที่นั่ง 7 ที่นั่ง ตัวถัง suv'}]}}]});}
    return real(url,init);};
  const {ensureSpec}=await import('../src/carspec.js');
  const r=await ensureSpec(f.env,pajero,{who:'u:cust',user:true});
  assert.equal(r.status,'failed');assert.equal(r.data,null,'prose is not turned into facts');
  assert.ok(ai.length>0&&ai.every(c=>!c.body.tools&&c.body.generationConfig.responseMimeType==='application/json'),'JSON is requested directly and no web-search tool is attached');
  assert.ok(ai.every(c=>c.body.generationConfig.thinkingConfig||!/gemini-3|gemini-2\.5/.test(c.u)),'thinking is capped so the answer is not cut off');
});

test('car spec: a slow lookup answers "pending" quickly and finishes in the background; admins see why a lookup failed',async()=>{
  const {f}=setup();
  const real=globalThis.fetch;let release;const gate=new Promise(z=>release=z);
  globalThis.fetch=async(url,init)=>{if(String(url).includes('generativelanguage'))await gate;return real(url,init)};
  const {ensureSpec,getSpec}=await import('../src/carspec.js');
  let bg=null;
  const r=await ensureSpec(f.env,pajero,{who:'u:cust',user:true,waitMs:30,defer:p=>{bg=p}});
  assert.equal(r.status,'pending');assert.ok(bg,'work continues after the response');
  release();await bg;
  assert.equal((await getSpec(f.env,r.key)).status,'ready');
  globalThis.fetch=async(url)=>String(url).includes('generativelanguage')?new Response('nope',{status:404}):real(url);
  await ensureSpec(f.env,{make:'Honda',model:'Zzz',year:'2020'},{who:'u:cust',user:true});
  const {listSpecs}=await import('../src/carspec.js');
  assert.match((await listSpecs(f.env)).find(x=>x.model==='Zzz').error,/ตอบ 404/);
});

test('car spec: "try again" really searches again; unavailable models fall back; a model that rejects the thinking setting is retried without it',async()=>{
  const {f,ai,call}=setup({fail:true});
  assert.equal((await call('POST','/api/car-spec',pajero,CUST)).json.status,'failed');
  const n=ai.length;
  assert.equal((await call('POST','/api/car-spec',pajero,CUST)).json.status,'failed');assert.equal(ai.length,n,'just opening again within 2 minutes reuses the result');
  /* ตอนนี้ AI กลับมาใช้ได้ แต่รุ่นที่ไม่ใช่ของแชตใช้ไม่ได้ทั้งหมด และบางรุ่นไม่รับค่าการคิด */
  const real=globalThis.fetch,main=chatModels(f.env).slice(0,2),seen=[];
  globalThis.fetch=async(url,init={})=>{const u=String(url);
    if(u.includes('generativelanguage')){const m=u.split('/models/')[1].split(':')[0],body=JSON.parse(init.body);seen.push({m,think:!!body.generationConfig.thinkingConfig});
      if(!main.includes(m))return new Response('model not found',{status:404});
      if(body.generationConfig.thinkingConfig)return new Response('thinking not supported',{status:400});
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(docAnswer(PAJERO,isSecond(body)))}]}}]});}
    return real(url,init);};
  const r=await call('POST','/api/car-spec',{...pajero,retry:true},CUST);
  assert.equal(r.json.status,'ready','pressing try again searches again right away');
  assert.ok(seen.some(x=>main.includes(x.m)&&!x.think),'fell back to a model that works, without the thinking setting');
  assert.ok(seen.some(x=>!main.includes(x.m)),'unavailable models were tried and skipped');
  globalThis.fetch=real;
});

test('car spec log: real Gemini error text and every attempt reach the floating admin panel',async()=>{
  const {f,call}=setup();const real=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{const u=String(url);
    if(u.includes('generativelanguage'))return Response.json({error:{code:403,status:'PERMISSION_DENIED',message:'API key not valid for this project'}},{status:403});
    return real(url,init);};
  const r=await call('POST','/api/car-spec',pajero,CUST);
  assert.equal(r.json.status,'failed');
  assert.match(r.json.error,/403: PERMISSION_DENIED · API key not valid/,'the stored reason is the real one, not just a status code');
  assert.equal(r.json.trace,undefined,'customers never see the internal trail');
  const live=await call('GET','/api/admin/live',null,BOSS);
  const ev=live.json.specLog[0];
  assert.equal(ev.kind,'research');assert.equal(ev.ok,0);assert.match(ev.who,/^u:cust/);
  const tries=ev.trail.filter(x=>x.step==='search');
  assert.ok(tries.length>=2&&tries.every(x=>x.st===403&&/API key not valid/.test(x.err)),'each model attempt is listed with its error');
  assert.equal(ev.trail[0].step,'setup');assert.equal(ev.trail[0].keyFrom,'GEMINI_KEY');
  assert.ok(Array.isArray(live.json.spec.models)&&live.json.spec.models.length);
  /* เปิดซ้ำภายใน 2 นาที = บอกเหตุผลว่าทำไมไม่ค้นใหม่ */
  await call('POST','/api/car-spec',pajero,CUST);
  const again=(await call('GET','/api/admin/live',null,BOSS)).json.specLog[0];
  assert.equal(again.kind,'failed-recent');assert.match(again.err,/API key not valid/);
  assert.equal((await call('GET','/api/admin/live',null,CUST)).status,403,'the log is staff-only');
  void f;
});

test('car spec log: cache hits, guest limits and admin test runs are recorded; admin gets the trail back',async()=>{
  const {call}=setup();
  assert.equal((await call('POST','/api/car-spec',{...pajero,force:true},CUST)).json.trace,undefined,'force is ignored for customers');
  const out=await call('POST','/api/car-spec',{...pajero,force:true},BOSS);
  assert.equal(out.json.status,'ready');assert.ok(out.json.trace.some(x=>x.step==='search'&&x.ok&&x.json==='ok'&&x.src===1));
  await call('POST','/api/car-spec',pajero);
  for(const y of ['2001','2002','2003','2004'])await call('POST','/api/car-spec',{...pajero,year:y});
  const log=(await call('GET','/api/admin/live',null,BOSS)).json.specLog;
  assert.equal(log[0].kind,'limited');assert.match(log[0].err,/ไม่ได้ล็อกอิน/);assert.match(log[0].who,/^ip:203\.0…/,'guest IPs are shortened');
  assert.ok(log.some(x=>x.kind==='cache'&&x.ok));assert.ok(log.some(x=>x.kind==='redo'&&x.ok));
});

test('car spec: notfound in one lookup cannot compare the other positive lookup with itself',async()=>{
  const {call}=setup({passA:{found:false},passB:PAJERO});
  const r=await call('POST','/api/car-spec',pajero,CUST);assert.equal(r.json.status,'ready');assert.equal(r.json.data.score.confirmed,0);
  assert.equal(r.json.data.body_ok,false);assert.equal(r.json.data.variants[0].hp.ok,null);assert.equal(r.json.data.coverage.passes,1);
});
test('car spec: source-free or empty model output is never published as a real ready specification',async()=>{
  for(const empty of [false,true]){const {call}=setup();const real=globalThis.fetch;globalThis.fetch=async(url,init)=>String(url).includes('generativelanguage')?Response.json({candidates:[{content:{parts:[{text:JSON.stringify(empty?{found:true}:PAJERO)}]}}]}):real(url,init);
    const r=await call('POST','/api/car-spec',pajero,CUST);assert.equal(r.json.status,'failed');assert.equal(r.json.data,null);assert.equal(r.json.code,'unconfirmed');}
});
test('car spec: an unsuccessful negative lookup is not remembered as permanent notfound',async()=>{
  const {f}=setup();let count=0;const real=globalThis.fetch;globalThis.fetch=async(url,init)=>{if(!String(url).includes('generativelanguage'))return real(url,init);count++;if(isSecond(JSON.parse(init.body)))return new Response('quota',{status:429});return Response.json({candidates:[{content:{parts:[{text:'{"found":false}'}]}}]})};
  const {ensureSpec}=await import('../src/carspec.js');const r=await ensureSpec(f.env,pajero,{who:'u:cust',user:true});assert.equal(r.status,'failed');assert.ok(count>1);assert.notEqual(r.status,'notfound');
});
test('car spec: same model/year in different markets uses different shared cache records and never sends a VIN',async()=>{
  const {f,call,ai}=setup();const a=await call('POST','/api/car-spec',pajero,CUST),b=await call('POST','/api/car-spec',{...pajero,market:'JP',vin:'PRIVATE-FIXTURE-VIN'},CUST);
  assert.notEqual(a.json.key,b.json.key);assert.equal(b.json.data.query.market,'JP');assert.equal(f.sqlite.prepare('SELECT count(*) n FROM car_specs').get().n,2);
  assert.ok(ai.slice(2).every(x=>x.body.contents[0].parts[0].text.includes('ญี่ปุ่น')&&!JSON.stringify(x.body).includes('PRIVATE-FIXTURE-VIN')));
  assert.equal((await call('GET','/api/car-spec?make=Mitsubishi&model=Pajero%20Sport&year=2020&market=JP')).json.key,b.json.key);
});
test('car spec: simultaneous first requests reserve one lookup and refund the duplicate reservation',async()=>{
  const {f,ai}=setup(),base=globalThis.fetch;let release;const gate=new Promise(resolve=>{release=resolve});globalThis.fetch=async(...args)=>{await gate;return base(...args)};
  const {ensureSpec,getSpec}=await import('../src/carspec.js');const jobs=[];
  const results=await Promise.all([ensureSpec(f.env,pajero,{who:'u:cust',user:true,waitMs:10,defer:p=>jobs.push(p)}),ensureSpec(f.env,pajero,{who:'u:other',user:true,waitMs:10,defer:p=>jobs.push(p)})]);
  assert.ok(results.every(x=>x.status==='pending'));assert.equal(jobs.length,1);release();await Promise.all(jobs);assert.equal(ai.length,2);
  assert.equal((await getSpec(f.env,results[0].key)).status,'ready');assert.equal(f.sqlite.prepare("SELECT n FROM spec_quota WHERE who='*'").get().n,1);
});
test('car spec: provider quota failure is explicit and does not consume the user lookup allowance',async()=>{
  const {f,call}=setup({fail:true});const r=await call('POST','/api/car-spec',pajero,CUST);
  assert.equal(r.json.code,'provider_quota');assert.equal(r.json.retryable,false);assert.equal(f.sqlite.prepare("SELECT n FROM spec_quota WHERE who='u:cust'").get().n,0);
});
test('car spec: different numeric specs, drivetrains and impossible values cannot be called matching facts',()=>{
  const x=merge({...PAJERO,seats:1000,tank_l:-1},{...PAJERO,variants:[{...PAJERO.variants[0],drive:'AWD'}]});
  assert.equal(x.facts.seats.ok,null);assert.equal(x.facts.tank_l.ok,null);assert.equal(x.variants[0].drive.ok,null);
  assert.deepEqual(field(7.9,8.3),{v:7.9,ok:false,alt:8.3});assert.equal(merge({...PAJERO,seats:1000},{...PAJERO,seats:1000}).facts.seats,null);
});
test('car info: extra optional model context is private and invalid model years are discarded',()=>{
  assert.deepEqual(cleanInfo({engine_code:'4N15',model_year:'2020',market:'JP',drive:'4WD',unexpected:'x'}),{engine_code:'4N15',model_year:'2020',market:'JP',drive:'4WD'});
  assert.equal(cleanInfo({model_year:'9999'}),null);
});
test('car spec: admin verification cannot make a legacy unsourced record look trustworthy',async()=>{
  const {f,call}=setup();f.sqlite.prepare("INSERT INTO car_specs(k,make,model,year,status,data,sources,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run('fake|model|2020','Fake','Model','2020','ready','{"facts":{"seats":{"v":5}}}','[]',1,1);
  const r=await call('POST','/api/admin/car-specs/verify',{key:'fake|model|2020'},BOSS);assert.equal(r.status,400);
  assert.equal((await call('GET','/api/car-spec?make=Fake&model=Model&year=2020&market=TH')).json.status,'unconfirmed');
});
test('car spec: provider refunds cannot enable unlimited lookup attempts by rotating car models',async()=>{
  const {call,ai}=setup({fail:true});for(let i=0;i<9;i++)assert.equal((await call('POST','/api/car-spec',{make:'Honda',model:'Fixture '+i,year:'2020'})).json.code,'provider_quota');
  const n=ai.length,r=await call('POST','/api/car-spec',{make:'Honda',model:'Fixture blocked',year:'2020'});assert.equal(r.json.status,'limited');assert.equal(r.json.code,'attempt_limit');assert.equal(ai.length,n);
});
test('car spec: seats/doors are exact and equal engines cannot merge different trims or gearboxes',()=>{
  const m=merge(PAJERO,{...PAJERO,seats:8,doors:4,variants:[{...PAJERO.variants[0],name:'2.4 Basic 2WD'},{...PAJERO.variants[1],gearbox:'ธรรมดา 6 สปีด'}]});
  assert.equal(m.facts.seats.ok,false);assert.equal(m.facts.doors.ok,false);assert.equal(m.variants.length,4);
});
test('car spec: unusable specifications refund lookup allowance but retain non-refundable safety attempts',async()=>{
  const {f,call,ai}=setup();const real=globalThis.fetch;globalThis.fetch=async(url,init)=>{if(!String(url).includes('generativelanguage'))return real(url,init);ai.push({});return Response.json({candidates:[{content:{parts:[{text:'{"found":true}'}]}}]})};
  for(let i=0;i<9;i++)assert.equal((await call('POST','/api/car-spec',{make:'Fixture',model:'Empty '+i,year:'2020'})).json.code,'unconfirmed');
  assert.equal(f.sqlite.prepare("SELECT n FROM spec_quota WHERE who='ip:203.0.113.9'").get().n,0);assert.equal(f.sqlite.prepare("SELECT n FROM spec_quota WHERE who='*'").get().n,0);
  assert.equal(f.sqlite.prepare("SELECT n FROM spec_quota WHERE who='attempt:ip:203.0.113.9'").get().n,9);
  const n=ai.length;assert.equal((await call('POST','/api/car-spec',{make:'Fixture',model:'Extra',year:'2020'})).json.code,'attempt_limit');assert.equal(ai.length,n);
});
test('car spec: daily limit responses identify account scope rather than an ambiguous Gemini quota',async()=>{
  let {f,call}=setup();for(const m of ['G1','G2','G3'])await call('POST','/api/car-spec',{make:'Fixture',model:m,year:'2020'});
  let r=await call('POST','/api/car-spec',{make:'Fixture',model:'G4',year:'2020'});assert.equal(r.json.code,'guest_limit');assert.equal(r.json.scope,'guest');assert.equal(r.json.signedIn,false);
  ({f,call}=setup());const day=new Date().toISOString().slice(0,10);f.sqlite.prepare('INSERT INTO spec_quota(who,day,n) VALUES(?,?,?)').run('u:cust',day,10);
  r=await call('POST','/api/car-spec',pajero,CUST);assert.equal(r.json.code,'user_limit');assert.equal(r.json.signedIn,true);
  ({f,call}=setup());f.sqlite.prepare('INSERT INTO spec_quota(who,day,n) VALUES(?,?,?)').run('*',day,150);
  r=await call('POST','/api/car-spec',pajero,CUST);assert.equal(r.json.code,'system_limit');assert.equal(f.sqlite.prepare("SELECT n FROM spec_quota WHERE who='u:cust'").get().n,0);
});
test('car spec: invalid bearer tokens cannot silently downgrade to guest or consume any lookup budget',async()=>{
  const {f,call,ai}=setup();const r=await call('POST','/api/car-spec',pajero,'invalid-fixture-token');assert.equal(r.status,401);assert.equal(r.json.code,'auth_required');assert.equal(ai.length,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM spec_quota').get().n,0);
});
test('car spec: three required fields are sufficient and explicit Thai requests keep their legacy library key separate',async()=>{
  const {call}=setup();const general=await call('POST','/api/car-spec',pajero,CUST),thai=await call('POST','/api/car-spec',{...pajero,market:'TH'},CUST);
  assert.equal(general.json.status,'ready');assert.equal(general.json.key,'mitsubishi|pajero sport|2020|global');assert.equal(general.json.data.query.market,'GLOBAL');assert.equal(thai.json.key,'mitsubishi|pajero sport|2020');assert.notEqual(thai.json.key,general.json.key);
});

test('car spec: a model saved before the deeper fields shows at once, is topped up once in the background, and a failed top-up keeps the old data',async()=>{
  const k='mitsubishi|pajero sport|2020|global',old={schema:2,body:'suv',facts:{seats:{v:7,ok:true}},variants:[],score:{cells:1,confirmed:1,conflicts:0}};
  const run=async({fail=false,status='ready'}={})=>{
    const s=setup({fail});
    s.f.sqlite.prepare('INSERT INTO car_specs (k,make,model,year,status,body,data,sources,models,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(k,'Mitsubishi','Pajero Sport','2020',status,'suv',JSON.stringify(old),JSON.stringify([{url:'https://www.mitsubishi-motors.co.th/x',title:'x'}]),'[]',1,1);
    const bg=[],post=async()=>{const r=await worker.fetch(new Request('https://api.unit.test/api/car-spec',{method:'POST',
      headers:{'Content-Type':'application/json','CF-Connecting-IP':'203.0.113.9',Authorization:'Bearer '+CUST},body:JSON.stringify(pajero)}),s.f.env,{waitUntil(p){bg.push(p)}});
      const j=await r.json();await Promise.all(bg.splice(0));return j};
    return {...s,post,row:()=>{const r=s.f.sqlite.prepare('SELECT status,data FROM car_specs WHERE k=?').get(k);return {...r,data:JSON.parse(r.data)}}};
  };
  {const {ai,post,row,f}=await run();
    const r=await post();assert.equal(r.status,'ready');assert.equal(r.data.score.cells,1,'the saved data answers immediately');
    assert.equal(ai.length,2,'one background top-up (two passes)');
    const now=row();assert.equal(now.status,'ready');assert.equal(now.data.depth,2);assert.ok(now.data.score.cells>1);
    assert.equal(f.sqlite.prepare("SELECT n FROM spec_quota WHERE who='u:cust'").get(),undefined,'the user\'s own lookup allowance is not used');
    await post();assert.equal(ai.length,2,'never topped up twice');}
  {const {post,row,f}=await run({fail:true});
    await post();const now=row();assert.equal(now.status,'ready');assert.deepEqual(now.data,old,'a failed top-up never replaces or hides the old data');
    assert.equal(f.sqlite.prepare("SELECT n FROM spec_quota WHERE who='*'").get().n,0,'system allowance refunded');}
  {const {ai,post,row}=await run({status:'verified'});
    await post();assert.equal(ai.length,0,'team-verified records are locked');assert.deepEqual(row().data,old);}
});
