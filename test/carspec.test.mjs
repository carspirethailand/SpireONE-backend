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
  const ai=[],web=[];
  globalThis.fetch=async(url,init={})=>{const u=String(url);
    if(u.includes('generativelanguage')){const body=JSON.parse(init.body);ai.push({u,body});
      if(fail)return new Response('quota',{status:429});
      const second=/ตรวจสอบข้อมูลจำเพาะ/.test(body.contents[0].parts[0].text);
      return Response.json({candidates:[{content:{parts:[{text:'```json\n'+JSON.stringify(second?passB:passA)+'\n```'}]},
        groundingMetadata:{groundingChunks:[{web:{uri:'https://grounding.example/'+(second?'b':'a'),title:second?'headlightmag.com':'mitsubishi-motors.co.th'}}]}}]});}
    if(u.startsWith('https://vpic.nhtsa.dot.gov/')){web.push(u);return Response.json({Results:[{Make:'TOYOTA',Manufacturer:'TOYOTA MOTOR THAILAND',Model:'Hilux',ModelYear:'2019',DisplacementL:'2.4',FuelTypePrimary:'Diesel',DriveType:'0'}]});}
    throw Error('unexpected fetch '+u);};
  const call=async(method,path,body,token)=>{const r=await worker.fetch(new Request('https://api.unit.test'+path,{method,
    headers:{'Content-Type':'application/json','CF-Connecting-IP':'203.0.113.9',...(token?{Authorization:'Bearer '+token}:{})},body:body&&JSON.stringify(body)}),f.env,{waitUntil(){}});
    return {status:r.status,json:await r.json()}};
  return {f,ai,web,call};
}
const CUST='dev:cust:cust@unit.test',BOSS='dev:boss:boss@unit.test';
const pajero={make:'Mitsubishi',model:'Pajero Sport',year:'2020'};

test('car spec: only real-looking car names and years are researched',()=>{
  assert.deepEqual(validQuery({make:' Mitsubishi ',model:'Pajero  Sport',year:'2020'}),{make:'Mitsubishi',model:'Pajero Sport',year:'2020'});
  for(const q of [{make:'x'.repeat(41),model:'a',year:'2020'},{make:'BMW',model:'<script>',year:'2020'},{make:'BMW',model:'X5',year:'1899'},{make:'BMW',model:'X5',year:'20200'}])
    assert.equal(validQuery(q),null,JSON.stringify(q));
});

test('car spec: two independent lookups are compared field by field',()=>{
  assert.deepEqual(field(181,180),{v:181,ok:true},'within 4% is the same number');
  assert.deepEqual(field(181,150),{v:181,ok:false,alt:150},'different numbers keep both');
  assert.deepEqual(field(null,68),{v:68,ok:null},'one source only');
  const m=merge(PAJERO,{...PAJERO,body:'suv',kerb_kg:1990,variants:[{...PAJERO.variants[1],hp:178},{...PAJERO.variants[0]}]});
  assert.equal(m.body,'suv');assert.equal(m.body_ok,true);
  assert.equal(m.variants.length,2);assert.equal(m.variants[1].drive.v,'4WD','variants are matched by engine and drive, not by order');
  assert.equal(m.variants[1].hp.ok,true);assert.equal(m.facts.kerb_kg.ok,true,'1990 vs 2045 is within 3%');
  const bad=merge(PAJERO,{...PAJERO,body:'mpv',tank_l:80});
  assert.equal(bad.body,null,'body types that disagree are not trusted');assert.equal(bad.facts.tank_l.ok,false);assert.equal(bad.facts.tank_l.alt,80);
  assert.ok(m.score.confirmed>10&&m.score.conflicts===0);
});

test('car spec: the first person to pick a model triggers AI once; everyone after gets the same data instantly',async()=>{
  const {f,ai,call}=setup();
  const r=await call('POST','/api/car-spec',pajero,CUST);
  assert.equal(r.status,200);assert.equal(r.json.status,'ready');assert.equal(r.json.body,'suv');
  assert.equal(ai.length,2,'two independent lookups');assert.ok(ai.every(c=>c.body.tools&&c.body.tools[0].google_search),'both search the web');
  assert.notEqual(ai[0].u.split('/models/')[1].split(':')[0],ai[1].u.split('/models/')[1].split(':')[0],'the two lookups use different models');
  const main=chatModels(f.env).slice(0,2);assert.ok(ai.every(c=>!main.some(m=>c.u.includes('/models/'+m+':'))),'never the models chat answers with first');
  assert.deepEqual(r.json.sources.map(s=>s.title),['mitsubishi-motors.co.th','headlightmag.com'],'real source links from Google, not typed by the AI');
  assert.equal(r.json.data.variants[0].hp.ok,true);
  /* คนอื่น · ไม่ล็อกอิน · ตัวพิมพ์ต่างกัน → ข้อมูลชุดเดิม ไม่เรียก AI */
  const again=await call('POST','/api/car-spec',{make:'MITSUBISHI',model:'pajero sport',year:'2020'});
  assert.equal(again.json.status,'ready');assert.equal(ai.length,2,'no new AI call');
  assert.deepEqual(again.json.data,r.json.data);
  assert.equal((await call('GET','/api/car-spec?make=Mitsubishi&model=Pajero%20Sport&year=2020')).json.status,'ready');
  assert.equal((await call('GET','/api/car-spec?make=Mitsubishi&model=Triton&year=2020')).json.status,'none');
  assert.equal(f.sqlite.prepare('SELECT hits FROM car_specs').get().hits,1);
});

test('car spec: a model that does not exist is remembered as not found; AI failure is retried later, not cached forever',async()=>{
  let {ai,call}=setup({passA:{found:false},passB:{found:false}});
  assert.equal((await call('POST','/api/car-spec',{make:'Toyota',model:'Supra',year:'1950'},CUST)).json.status,'notfound');
  await call('POST','/api/car-spec',{make:'Toyota',model:'Supra',year:'1950'},CUST);assert.equal(ai.length,2,'not asked again');
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

test('car spec: a messy answer from web search is turned back into JSON by a light model (no new facts, no web)',async()=>{
  const {f,ai}=setup();
  const real=globalThis.fetch;
  globalThis.fetch=async(url,init={})=>{const u=String(url);
    if(u.includes('generativelanguage')){const body=JSON.parse(init.body);
      if(body.tools){ai.push({u,body});return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'จากการค้นพบว่า Pajero Sport 2020 มีที่นั่ง 7 ที่นั่ง {"found":true, "seats":7, ตัวถัง suv'}]},groundingMetadata:{groundingChunks:[{web:{uri:'https://g/x',title:'example.com'}}]}}]});}
      ai.push({u,body,repair:true});
      assert.equal(body.generationConfig.responseMimeType,'application/json');assert.ok(!body.tools,'repair does not search the web');
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({found:true,body:'suv',seats:7})}]}}]});}
    return real(url,init);};
  const {ensureSpec}=await import('../src/carspec.js');
  const r=await ensureSpec(f.env,pajero,{who:'u:cust',user:true});
  assert.equal(r.status,'ready');assert.equal(r.data.facts.seats.v,7);assert.ok(ai.some(c=>c.repair));
  assert.ok(ai.filter(c=>!c.repair).every(c=>c.body.generationConfig.thinkingConfig),'thinking is capped so the answer is not cut off');
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

test('car spec: "try again" really searches again; unavailable models fall back (chat models last); a model that rejects the thinking setting is retried without it',async()=>{
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
      const second=/ตรวจสอบข้อมูลจำเพาะ/.test(body.contents[0].parts[0].text);
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(PAJERO)}]},groundingMetadata:{groundingChunks:[{web:{uri:'https://g/'+(second?'b':'a'),title:second?'b.com':'a.com'}}]}}]});}
    return real(url,init);};
  const r=await call('POST','/api/car-spec',{...pajero,retry:true},CUST);
  assert.equal(r.json.status,'ready','pressing try again searches again right away');
  assert.ok(seen.some(x=>main.includes(x.m)&&!x.think),'fell back to a model that works, without the thinking setting');
  const firstChat=seen.findIndex(x=>main.includes(x.m));assert.ok(firstChat>0&&seen.slice(0,firstChat).every(x=>!main.includes(x.m)),'models chat answers with are tried last');
  globalThis.fetch=real;
});
