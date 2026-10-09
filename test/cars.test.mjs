import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './tech-fixtures.mjs';
import worker from '../src/worker.js';

/* รถในการาจ: สีและประเภทตัวถังเก็บข้ามเครื่องได้ และส่งรถคันเดิมซ้ำเพื่อเปลี่ยนสีได้ */
function setup(){
  const f=fixture({DEV_AUTH:'1',FIREBASE_PROJECT_ID:'unit-test'});
  f.sqlite.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT); INSERT INTO config VALUES ('schema_version','999');
    CREATE TABLE cars (id TEXT PRIMARY KEY, uid TEXT NOT NULL, make TEXT NOT NULL, model TEXT NOT NULL, year TEXT, mileage TEXT, created_at INTEGER NOT NULL, color TEXT, body TEXT);
    CREATE TABLE user_state (uid TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, t INTEGER NOT NULL, PRIMARY KEY(uid,k));`);
  const call=async(method,path,body,uid='cust')=>{const r=await worker.fetch(new Request('https://api.unit.test'+path,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer dev:${uid}:${uid}@unit.test`},body:body&&JSON.stringify(body)}),f.env,{waitUntil(){}});return {status:r.status,json:await r.json()}};
  return {f,call};
}

test('cars: color and body type are saved, and re-sending the same car changes only what is sent',async()=>{
  const {call}=setup();
  let r=await call('POST','/api/cars',{id:'c1',make:'Honda',model:'Civic',year:'2021',mileage:'61200',color:'#d64545',body:'sedan'});
  assert.equal(r.status,200);assert.equal(r.json.color,'#D64545');
  r=await call('POST','/api/cars',{id:'c1',make:'Honda',model:'Civic',year:'2021',mileage:'62000'});
  let [c]=(await call('GET','/api/cars')).json;
  assert.equal(c.color,'#D64545','no color sent = keep the old one');assert.equal(c.body,'sedan');assert.equal(c.mileage,'62000');
  await call('POST','/api/cars',{id:'c1',make:'Honda',model:'Civic',color:'#4F8FD9'});
  [c]=(await call('GET','/api/cars')).json;assert.equal(c.color,'#4F8FD9');
  await call('POST','/api/cars',{id:'c2',make:'X',model:'Y',color:'red;drop',body:'tank'});
  const c2=(await call('GET','/api/cars')).json.find(x=>x.id==='c2');assert.equal(c2.color,null);assert.equal(c2.body,null,'unknown values are ignored');
});

test('cars: deleting survives six refreshes and stale snapshots without losing the other car',async()=>{
  const {f,call}=setup();
  const removed={id:'c1',make:'Test',model:'Removed',color:'#FFFFFF',body:'sedan'};
  const kept={id:'c2',make:'Test',model:'Kept',color:'#4F8FD9',body:'suv',history:[{part:'oil',cost:1700}]};
  await call('POST','/api/cars',removed);await call('POST','/api/cars',kept);
  await call('PUT','/api/state',{state:{garage:{v:[removed,kept],t:1},selCar:{v:'c1',t:1},theme:{v:'light',t:2}}});
  const deleted=await call('DELETE','/api/cars/c1');assert.equal(deleted.status,200);
  const marker=f.sqlite.prepare('SELECT t FROM user_state WHERE uid=? AND k=?').get('cust','_car_deleted:c1');
  assert.ok(marker.t>1);
  for(let i=0;i<6;i++){
    const legacy=await call('GET','/api/cars');assert.equal(legacy.status,200);assert.ok(Array.isArray(legacy.json));
    assert.deepEqual(legacy.json.map(c=>c.id),['c2']);
    assert.equal(legacy.json[0].color,kept.color);assert.equal(legacy.json[0].body,kept.body);
    const sync=(await call('GET','/api/cars?sync=1')).json;
    assert.deepEqual(sync.cars.map(c=>c.id),['c2']);assert.deepEqual(sync.deleted,['c1']);
    const state=(await call('GET','/api/state')).json.state;
    assert.deepEqual(state.garage.v,[kept]);assert.equal(state.selCar.v,'');
    assert.ok(state.garage.t>=marker.t);assert.ok(state.selCar.t>=marker.t);
    assert.deepEqual(state.theme,{v:'light',t:2});
    assert.ok(!Object.keys(state).some(k=>k.startsWith('_car_deleted:')));
    assert.equal((await call('POST','/api/cars',removed)).status,410,'stale migration cannot recreate the ID');
    await call('PUT','/api/state',{state:{garage:{v:[removed,kept],t:Date.now()+i+100},selCar:{v:'c1',t:Date.now()+i+100}}});
  }
  const stored=JSON.parse(f.sqlite.prepare("SELECT v FROM user_state WHERE uid='cust' AND k='garage'").get().v);
  assert.deepEqual(stored,[kept],'even a newer stale state write is pruned');
  assert.equal((await call('DELETE','/api/cars/c1')).status,200,'repeated deletion is safe');
});

test('cars: deleting the last car keeps an empty garage; adding it anew needs a new ID',async()=>{
  const {call}=setup();const car={id:'last',make:'Test',model:'Last'};
  await call('POST','/api/cars',car);
  await call('PUT','/api/state',{state:{garage:{v:[car],t:1},selCar:{v:car.id,t:1}}});
  assert.equal((await call('DELETE','/api/cars/last')).status,200);
  await call('PUT','/api/state',{state:{garage:{v:[car],t:Date.now()+100},selCar:{v:car.id,t:Date.now()+100}}});
  const state=(await call('GET','/api/state?keys=garage,selCar')).json.state;
  assert.deepEqual(state.garage.v,[]);assert.equal(state.selCar.v,'');
  assert.deepEqual((await call('GET','/api/cars')).json,[]);
  assert.equal((await call('POST','/api/cars',car)).status,410);
  assert.equal((await call('POST','/api/cars',{...car,id:'new-last'})).status,200);
});

test('cars: a local-only deletion is durable, encoded IDs work, and another selection is unchanged',async()=>{
  const {call}=setup();
  const car={id:'local /only',make:'Test',model:'Offline'};
  await call('PUT','/api/state',{state:{garage:{v:[car],t:1},selCar:{v:'other-car',t:1}}});
  assert.equal((await call('DELETE','/api/cars/'+encodeURIComponent(car.id))).status,200);
  assert.equal((await call('POST','/api/cars',car)).status,410);
  const state=(await call('GET','/api/state')).json.state;
  assert.deepEqual(state.garage.v,[]);assert.equal(state.selCar.v,'other-car');
});

test('cars: another account cannot delete or overwrite a car; deletion markers are user scoped',async()=>{
  const {f,call}=setup();const car={id:'shared-id',make:'Test',model:'Owner',color:'#D64545',body:'sedan'};
  await call('POST','/api/cars',car);
  assert.equal((await call('DELETE','/api/cars/shared-id',undefined,'other')).status,404);
  assert.equal((await call('POST','/api/cars',{...car,model:'Intruder'},'other')).status,409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM user_state WHERE uid='other' AND k='_car_deleted:shared-id'").get().n,0);
  const own=(await call('GET','/api/cars')).json[0];assert.equal(own.model,'Owner');assert.equal(own.color,car.color);
  await call('DELETE','/api/cars/shared-id');
  assert.deepEqual((await call('GET','/api/cars?sync=1',undefined,'other')).json.deleted,[]);
  assert.equal((await call('POST','/api/cars',{...car,model:'Other account'},'other')).status,200);
  assert.equal((await call('DELETE','/api/cars/shared-id')).status,404,'own old marker does not grant access to a different owner');
  assert.equal((await call('POST','/api/cars',car)).status,410);
});

test('cars: client state cannot remove or forge server-only deletion markers',async()=>{
  const {call}=setup();
  await call('DELETE','/api/cars/gone');
  const update=await call('PUT','/api/state',{state:{'_car_deleted:gone':{v:null,t:Date.now()+100},'_car_deleted:forged':{v:true,t:Date.now()+100},theme:{v:'dark',t:5}}});
  assert.deepEqual(update.json.saved,['theme']);assert.deepEqual(update.json.skipped,['_car_deleted:gone','_car_deleted:forged']);
  assert.deepEqual((await call('GET','/api/state?keys=_car_deleted:gone')).json.state,{});
  assert.deepEqual((await call('GET','/api/cars?sync=1')).json.deleted,['gone']);
  assert.equal((await call('POST','/api/cars',{id:'gone',make:'Test',model:'Gone'})).status,410);
  assert.equal((await call('POST','/api/cars',{id:'forged',make:'Test',model:'New'})).status,200);
});

test('cars: a POST already in flight cannot insert after deletion commits',async()=>{
  const {f,call}=setup();const car={id:'racing',make:'Test',model:'Race'};
  await call('POST','/api/cars',car);
  let enter,release;const entered=new Promise(r=>enter=r),resume=new Promise(r=>release=r);
  const prepare=f.env.DB.prepare.bind(f.env.DB);let pause=true;
  f.env.DB.prepare=sql=>{const st=prepare(sql);if(/INSERT INTO cars/.test(sql)){
    const run=st.run.bind(st);st.run=async()=>{if(pause){pause=false;enter();await resume;}return run();};
  }return st;};
  const pending=call('POST','/api/cars',{...car,model:'Delayed stale edit'});
  await entered;assert.equal((await call('DELETE','/api/cars/racing')).status,200);release();
  assert.equal((await pending).status,410);
  assert.deepEqual((await call('GET','/api/cars')).json,[]);
});

test('cars: failure during deletion rolls back both the marker and the car deletion',async()=>{
  const {f,call}=setup();await call('POST','/api/cars',{id:'atomic',make:'Test',model:'Keep on failure'});
  const prepare=f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare=sql=>{const st=prepare(sql);if(/^DELETE FROM cars/.test(sql))st.run=async()=>{throw Error('test-only transaction failure')};return st;};
  assert.equal((await call('DELETE','/api/cars/atomic')).status,500);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM user_state WHERE k='_car_deleted:atomic'").get().n,0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM cars WHERE id='atomic'").get().n,1);
});
