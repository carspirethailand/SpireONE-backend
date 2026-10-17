import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './tech-fixtures.mjs';
import worker from '../src/worker.js';
import {garageCheckin,planGarageCheckin,GARAGE_CARE_POLICY,GARAGE_CARE_KEY} from '../src/garage-care.mjs';
import {liveToken} from '../src/live-setup.mjs';
const DAY=86400000,NOW=Date.parse('2026-10-17T08:00:00Z');
const complete={mileage:'50000',ins:'2027-12-01',act:'2027-12-01',tax:'2027-12-01',chk:'2027-12-01'};
function rig(){
  const f=fixture({DEV_AUTH:'1',FIREBASE_PROJECT_ID:'unit-test'});
  f.sqlite.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);INSERT INTO config VALUES('schema_version','999');
    CREATE TABLE user_state(uid TEXT,k TEXT,v TEXT,t INTEGER,PRIMARY KEY(uid,k));
    CREATE TABLE cars(id TEXT PRIMARY KEY,uid TEXT,mileage TEXT);
    INSERT INTO cars VALUES('c1','owner',''),('c2','other','1234');`);
  const state=(uid,key,value,t=1)=>f.sqlite.prepare('INSERT OR REPLACE INTO user_state VALUES(?,?,?,?)').run(uid,key,JSON.stringify(value),t);
  const call=async(body,time=NOW,uid='owner')=>garageCheckin(f.env,uid,{carId:'c1',...body},time);
  const route=async(path,method,body,uid='owner')=>{
    const response=await worker.fetch(new Request('https://unit.test'+path,{method,headers:{'Content-Type':'application/json',...(uid?{Authorization:`Bearer dev:${uid}:${uid}@unit.test`}:{})},...(body?{body:JSON.stringify(body)}:{})}),f.env,{waitUntil(){}});
    return{status:response.status,body:await response.json()};
  };
  return{...f,state,call,route};
}
test('planner asks one missing field, but existing fresh mileage and far-future dates need no question',()=>{
  assert.equal(planGarageCheckin(null,'c1',{},NOW).field,'mileage');
  assert.equal(planGarageCheckin(null,'c1',complete,NOW).field,null);
  const p=planGarageCheckin(null,'c1',complete,NOW);
  assert.equal(planGarageCheckin(p.state,'c1',complete,NOW+29*DAY).field,null);
  assert.equal(planGarageCheckin(p.state,'c1',complete,NOW+30*DAY).field,'mileage');
});
test('changed saved mileage restarts freshness; no guessed service/replacement intervals',()=>{
  const p=planGarageCheckin(null,'c1',complete,NOW);
  const next=planGarageCheckin(p.state,'c1',{...complete,mileage:'55000'},NOW+31*DAY);
  assert.equal(next.field,null);assert.equal(next.state.cars.c1.mileage.observedAt,NOW+31*DAY);
  assert.deepEqual(Object.keys(next.state.cars.c1),['mileage','ins','act','tax','chk']);
});
test('valid dates near/past their actual saved expiry qualify; invalid dates never become invented dates',()=>{
  assert.equal(planGarageCheckin(null,'c1',{...complete,ins:'2026-10-25'},NOW).field,'ins');
  const p=planGarageCheckin(null,'c1',{...complete,ins:'2026-02-30'},NOW);
  assert.equal(p.state.cars.c1.ins.value,'');assert.equal(p.field,'ins');
});
test('weekly account gate and per-field intervals persist across calls, cars and devices',async()=>{
  const f=rig(),first=await f.call({});assert.equal(first.question.field,'mileage');
  for(const delta of [1,1000,DAY,6*DAY])assert.equal((await f.call({},NOW+delta)).question,null);
  const second=await f.call({},NOW+7*DAY);assert.equal(second.question.field,'ins');
  assert.equal((await f.call({},NOW+8*DAY)).question,null);
  assert.equal(GARAGE_CARE_POLICY.accountGap,7*DAY);
});
test('concurrent device claims return at most one question',async()=>{
  const f=rig();const results=await Promise.all([f.call({}),f.call({}),f.call({})]);
  assert.equal(results.filter(x=>x.question).length,1);
});
test('unknown/deleted/other-owned cars never expose values or receive a prompt',async()=>{
  const f=rig();for(const carId of ['c2','missing','../admin','__proto__'])assert.equal((await f.call({carId})).question,null);
  f.state('owner','_car_deleted:c1',true);assert.equal((await f.call({})).question,null);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM user_state WHERE k=?').get(GARAGE_CARE_KEY).n,0);
});
test('cloud-only own garage is supported; only allowed saved renewal fields are read',async()=>{
  const f=rig();f.state('owner','garage',[{id:'local1',mileage:'12345',vin:'PRIVATE',plate:'PRIVATE'}]);
  f.state('owner','reg_local1',{ins:'2026-10-20',...{phone:'PRIVATE'}});
  const r=await f.call({carId:'local1'});assert.equal(r.question.field,'ins');assert.match(r.question.text,/รอบใหม่/);
  assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.ok(!JSON.stringify(r).includes('12345'));
});
test('skip needs the current private ticket; disable persists and can be explicitly re-enabled',async()=>{
  const f=rig(),r=await f.call({});
  assert.equal((await f.call({action:'skip',ticket:'forged'})).status,409);
  assert.equal((await f.call({action:'skip',ticket:r.question.ticket})).ok,true);
  assert.equal((await f.call({action:'disable'})).enabled,false);
  assert.equal((await f.call({},NOW+300*DAY)).question,null);
  assert.equal((await f.call({action:'enable'},NOW+301*DAY)).enabled,true);
  assert.ok((await f.call({},NOW+302*DAY)).question);
});
test('claim/preferences never change mileage or registration dates; policy stores no transcript',async()=>{
  const f=rig();f.state('owner','reg_c1',{tax:'2027-05-01'});
  await f.call({mileage:'999999',uid:'other',transcript:'DO NOT STORE',question:'injected'});
  assert.equal(f.sqlite.prepare('SELECT mileage FROM cars WHERE id=?').get('c1').mileage,'');
  assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT v FROM user_state WHERE uid=? AND k=?').get('owner','reg_c1').v),{tax:'2027-05-01'});
  assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM user_state WHERE k=?').all(GARAGE_CARE_KEY)).includes('DO NOT STORE'));
});
test('route requires login and isolates uid from request body; internal scheduling cannot be forged using state sync',async()=>{
  const f=rig();assert.equal((await f.route('/api/garage/check-in','POST',{carId:'c1'},null)).status,401);
  const r=await f.route('/api/garage/check-in','POST',{carId:'c1',uid:'other'});assert.equal(r.status,200);assert.ok(r.body.question);
  const forged=await f.route('/api/state','PUT',{state:{[GARAGE_CARE_KEY]:{v:{version:1,enabled:true},t:9999999999999}}});
  assert.ok(forged.body.skipped.includes(GARAGE_CARE_KEY));
  const state=await f.route('/api/state','GET');assert.equal(state.body.state[GARAGE_CARE_KEY],undefined);
  assert.equal((await f.route('/api/garage/check-in','POST',{carId:'c1'})).body.question,null);
});
test('malformed internal policy fails closed instead of resetting reminders',async()=>{
  const f=rig();f.state('owner',GARAGE_CARE_KEY,{broken:true});
  const r=await f.route('/api/garage/check-in','POST',{carId:'c1'});assert.equal(r.status,503);assert.equal(r.body.question,null);
});
test('server-owned Live rules prohibit nagging, guessing, personal questions or silent saves; control is allowlisted',()=>{
  const token=liveToken({model:'test-model',agent:true,tools:true,garageCare:true,system:'client text',now:NOW}),setup=token.bidiGenerateContentSetup;
  assert.match(setup.systemInstruction.parts[0].text,/Silence alone does not prove confusion or consent/);
  assert.match(setup.systemInstruction.parts[0].text,/never save just because the user was silent/);
  const tool=setup.tools[0].functionDeclarations.find(t=>t.name==='garage_checkin_control');
  assert.deepEqual(tool.parameters.properties.action.enum,['skip','disable','enable']);
});
