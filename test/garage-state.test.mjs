import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import rules from '../src/garage-rules.mjs';
import {garageRulesFor,validateGarageWrite,appendGarageLog} from '../src/garage-state.mjs';
import {liveToken} from '../src/live-setup.mjs';
const now=Date.parse('2026-10-17T12:00:00Z'),car={id:'car-1',uid:'me',make:'Toyota',model:'Vios',year:'2020'};
function fixture(){
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE cars(id TEXT PRIMARY KEY,uid TEXT,make TEXT,model TEXT,year TEXT,mileage TEXT);CREATE TABLE user_state(uid TEXT,k TEXT,v TEXT,t INTEGER,PRIMARY KEY(uid,k));');
  db.prepare('INSERT INTO cars VALUES(?,?,?,?,?,?)').run(car.id,'me',car.make,car.model,car.year,'50000');
  db.prepare('INSERT INTO cars VALUES(?,?,?,?,?,?)').run('other-car','other','Porsche','911','2020','70000');
  const env={DB:{prepare(sql){
    let args=[];
    return {
      bind(...v){args=v;return this},
      async first(){return db.prepare(sql).get(...args)||null},
      async all(){return {results:db.prepare(sql).all(...args)}},
      async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}}}
    };
  }}};
  return{env,db};
}
const service=(extra={})=>({k:'oil',amount:1800,km:50000,date:'2026-10-17',...extra});
test('same record rules reject unbounded values, gibberish, impossible dates and arbitrary fields',()=>{
  for(const amount of [Infinity,NaN,-5,'-5','1e10',1e12])assert.throws(()=>rules.record('services',service({amount}),car,null,now));
  for(const title of ['asdfgh','ฟหกดฟหกด','ก'.repeat(100),'sdkfjsdlkfj'])assert.throws(()=>rules.record('trips',{title,km:100,date:'2026-10-17'},car,null,now));
  for(const date of ['2026-02-30','2026-10-19','0001-01-01'])assert.throws(()=>rules.record('services',service({date}),car,null,now));
  assert.doesNotThrow(()=>rules.record('trips',{title:'กรุงเทพ–หัวหิน',km:195,date:'2026-10-17'},car,null,now));
  assert.throws(()=>rules.infoPatch({trim:'x'.repeat(61)}));assert.throws(()=>rules.infoPatch({vin:'bad'}));
  assert.deepEqual(rules.infoPatch({gear:'CVT',tire:'185/60 R15',admin:true}),{gear:'CVT',tire:'185/60 R15'});
});
test('only one exact model/year staff reference with fresh provenance can replace the preliminary cap',()=>{
  const ref={make:'Toyota',model:'Vios',year:'2020',valueThb:400000,maxByJob:{oil:9000},asOf:'2026-10-01',source:'https://manufacturer.example/reference'};
  assert.equal(rules.reference(car,[ref],now),ref);assert.equal(rules.reference({...car,year:'2021'},[ref],now),null);
  assert.equal(rules.reference(car,[ref,ref],now),null);assert.equal(rules.reference(car,[{...ref,asOf:'2020-01-01'}],now),null);
  assert.equal(rules.costPolicy(car,null).basis,'heuristic');
  assert.equal(rules.money(9000,car,'oil',ref),9000);assert.throws(()=>rules.money(9001,car,'oil',ref));
});
test('state validation covers every real key and preserves unchanged historical records',async()=>{
  const f=fixture(),bad={services:[service({amount:1e10})],fuel:[],trips:[]};
  f.db.prepare('INSERT INTO user_state VALUES(?,?,?,?)').run('me','carlab_log_car-1',JSON.stringify(bad),1);
  assert.deepEqual(await validateGarageWrite(f.env,'me','carlab_log_car-1',bad),bad);
  await assert.rejects(()=>validateGarageWrite(f.env,'me','carlab_log_car-1',{...bad,services:[...bad.services,service({note:'asdfgh'})]}));
  for(const [key,value] of [['carlab_todo_car-1',[{title:'aaaaaaa',dueKm:0,done:false}]],['carlab_iv_car-1',{oil:{km:Infinity}}],['carlab_sym_car-1',[{t:'x'.repeat(201)}]],['cal_price_car-1',{oil:1e10}]])await assert.rejects(()=>validateGarageWrite(f.env,'me',key,value));
});
test('foreign, deleted and forged local car IDs cannot authorize private Garage writes',async()=>{
  const f=fixture();
  assert.equal(await garageRulesFor(f.env,'me','other-car',[{id:'other-car'}]),null);
  await assert.rejects(()=>validateGarageWrite(f.env,'me','carlab_log_other-car',{services:[service()]}));
  f.db.prepare('INSERT INTO user_state VALUES(?,?,?,?)').run('me','_car_deleted:car-1','true',1);
  assert.equal(await garageRulesFor(f.env,'me','car-1'),null);
  assert.equal(await garageRulesFor(f.env,'me','../car-1'),null);
});
test('log append is durable, idempotent and race-safe across devices; legacy content is not deleted',async()=>{
  const f=fixture();
  const body={carId:'car-1',kind:'services',entry:service(),requestId:'request-0001'};
  const results=await Promise.all([appendGarageLog(f.env,'me',body,now),appendGarageLog(f.env,'me',body,now)]);
  assert.equal(results.filter(x=>x.duplicate).length,1);
  await Promise.all(['request-0002','request-0003'].map(requestId=>appendGarageLog(f.env,'me',{...body,requestId},now)));
  const saved=JSON.parse(f.db.prepare('SELECT v FROM user_state WHERE uid=? AND k=?').get('me','carlab_log_car-1').v);
  assert.equal(saved.services.length,3);assert.equal(new Set(saved.services.map(x=>x.id)).size,3);
  await assert.rejects(()=>appendGarageLog(f.env,'other',body,now));
  await assert.rejects(()=>appendGarageLog(f.env,'me',{...body,requestId:'request-0004',entry:service({km:1e15})},now));
  assert.equal(JSON.parse(f.db.prepare('SELECT v FROM user_state WHERE uid=? AND k=?').get('me','carlab_log_car-1').v).services.length,3);
});
test('voice capabilities keep old clients compatible; new clients get read-only parking and confirmed car details',()=>{
  const base={model:'unit-live',agent:true,garageCare:true};
  const old=liveToken(base).bidiGenerateContentSetup.tools[0].functionDeclarations,newer=liveToken({...base,garageAssist:true}).bidiGenerateContentSetup.tools[0].functionDeclarations;
  assert.ok(!old.some(t=>t.name==='get_parking'));assert.ok(newer.some(t=>t.name==='get_parking'));
  assert.ok(!old.find(t=>t.name==='valet').parameters.properties.do.enum.includes('car_info'));
  assert.ok(newer.find(t=>t.name==='valet').parameters.properties.do.enum.includes('car_info'));
  for(const field of ['uid','lat','lng','admin','vin','plate'])assert.ok(!(field in newer.find(t=>t.name==='valet').parameters.properties));
});
