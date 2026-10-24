import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
let seq=0;
async function fixture(){
  const worker=(await import('../src/worker.js?garageEndpoints='+(++seq))).default;
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);INSERT INTO config VALUES('schema_version','19');
    CREATE TABLE users(uid TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,photo TEXT,role TEXT DEFAULT 'user',last_login INTEGER NOT NULL,created_at INTEGER,banned INTEGER DEFAULT 0);
    CREATE TABLE user_state(uid TEXT,k TEXT,v TEXT,t INTEGER,PRIMARY KEY(uid,k));`);
  const env={DEV_AUTH:'1',FIREBASE_PROJECT_ID:'unit-test',ALLOWED_ORIGINS:'*',DB:{prepare(sql){let args=[];return{
    bind(...v){args=v;return this},async first(){return db.prepare(sql).get(...args)||null},async all(){return {results:db.prepare(sql).all(...args)}},
    async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}}},_run(){return db.prepare(sql).run(...args)}
  }},async batch(list){db.exec('BEGIN');try{const r=list.map(x=>x._run());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}}};
  const call=async(method,path,body,uid='me')=>{
    const r=await worker.fetch(new Request('https://unit.test'+path,{method,headers:{'Content-Type':'application/json',...(uid?{Authorization:`Bearer dev:${uid}:${uid}@unit.test`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{waitUntil(){}});
    return {status:r.status,json:await r.json()};
  };
  await call('GET','/api/config');
  const t=Date.now();for(const uid of ['me','other','admin'])db.prepare('INSERT INTO users(uid,name,email,role,last_login,created_at) VALUES(?,?,?,?,?,?)').run(uid,uid,uid+'@unit.test',uid==='admin'?'admin':'user',t,t);
  await call('POST','/api/cars',{id:'car-1',make:'Honda',model:'Civic',year:'2020',mileage:'50000'});
  return {db,call};
}

test('car details are validated on direct car writes and Garage state sync; failures preserve existing account data',async()=>{
  const f=await fixture(),base={id:'car-1',make:'Honda',model:'Civic',year:'2020',mileage:'50000'};
  for(const info of [{model_year:'1234321'},{engine:'fsfastdsxz'},{engine_code:'qwdfwfwdsvew'},{plate:'wfweqqev'},{province:'svf'},{drive:'invalid'},{tire:'bad'}]){
    const r=await f.call('POST','/api/cars',{...base,info});assert.equal(r.status,400,JSON.stringify(info));
    const state=await f.call('PUT','/api/state',{state:{garage:{v:[{...base,info}]},theme:{v:'dark'}}});
    assert.ok(state.json.skipped.includes('garage'));assert.ok(state.json.saved.includes('theme'));assert.equal(f.db.prepare("SELECT info FROM cars WHERE id='car-1'").get().info,null);
  }
  const info={engine:'2.0L',engine_code:'R20A',gear:'CVT',plate:'กข 1234',province:'กรุงเทพมหานคร',tire:'215/55 R16'};
  assert.equal((await f.call('POST','/api/cars',{...base,info})).status,200);
  const saved=JSON.parse(f.db.prepare("SELECT info FROM cars WHERE id='car-1'").get().info);assert.deepEqual(saved,info);
  const old={engine:'legacy junk',model_year:'1234321'};f.db.prepare("UPDATE cars SET info=? WHERE id='car-1'").run(JSON.stringify(old));
  assert.equal((await f.call('POST','/api/cars',{...base,color:'#123456',info:old})).status,200,'unchanged legacy details are not erased by unrelated colour updates');
  assert.equal(f.db.prepare("SELECT info FROM cars WHERE id='car-1'").get().info,JSON.stringify(old));
});

test('Garage routes require auth and actual car ownership; generic state rejects bad records without corrupting preferences',async()=>{
  const f=await fixture();
  for(const [method,path,body] of [['GET','/api/garage/cost-policy?car=car-1'],['GET','/api/garage/context?car=car-1'],['POST','/api/garage/log',{}]])assert.equal((await f.call(method,path,body,null)).status,401);
  for(const path of ['/api/garage/cost-policy?car=car-1','/api/garage/context?car=car-1'])assert.equal((await f.call('GET',path,undefined,'other')).status,404);
  const res=await f.call('PUT','/api/state',{state:{theme:{v:'dark'},'carlab_sym_car-1':{v:[{t:'x'.repeat(201)}]},'cal_price_car-1':{v:{oil:1e15}}}});
  assert.deepEqual(res.json.saved,['theme']);assert.equal(res.json.skipped.length,2);assert.equal(Object.keys(res.json.errors).length,2);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM user_state WHERE uid='me' AND k LIKE 'cal%'").get().n,0);
});

test('acknowledged append persists once; invalid/foreign requests cannot add an entry',async()=>{
  const f=await fixture(),body={carId:'car-1',kind:'fuel',entry:{amount:1200,litres:30,km:50000},requestId:'endpoint-request-1'};
  const a=await f.call('POST','/api/garage/log',body),b=await f.call('POST','/api/garage/log',body);
  assert.equal(a.status,200);assert.equal(b.json.log.fuel.length,1);assert.equal(a.json.entry.id,body.requestId);
  assert.equal((await f.call('POST','/api/garage/log',body,'other')).status,404);
  assert.equal((await f.call('POST','/api/garage/log',{...body,requestId:'endpoint-request-2',entry:{amount:1e15}})).status,400);
});

test('unchanged legacy details survive an unrelated update but newly invalid details cannot enter',async()=>{
  const f=await fixture(),old={trim:'x'.repeat(61),gear:'CVT'};
  f.db.prepare('UPDATE cars SET info=? WHERE id=?').run(JSON.stringify(old),'car-1');
  const body={id:'car-1',make:'Honda',model:'Civic',year:'2020',color:'#AA1122',info:old};
  assert.equal((await f.call('POST','/api/cars',body)).status,200);
  assert.equal((await f.call('POST','/api/cars',{...body,info:{...old,trim:'y'.repeat(61)}})).status,400);
  assert.equal(JSON.parse(f.db.prepare('SELECT info FROM cars WHERE id=?').get('car-1').info).trim,old.trim);
});

test('model-year references are admin-only, source-bearing, exact-matching and audited',async()=>{
  const f=await fixture(),rows=[{make:'Honda',model:'Civic',year:'2020',valueThb:600000,maxByJob:{oil:8000},source:'https://example.com/reviewed',asOf:new Date().toISOString().slice(0,10)}];
  assert.equal((await f.call('POST','/api/admin/config',{garageCostReferences:rows})).status,403);
  assert.equal((await f.call('POST','/api/admin/config',{garageCostReferences:rows},'admin')).status,200);
  const policy=await f.call('GET','/api/garage/cost-policy?car=car-1');assert.equal(policy.json.policy.basis,'model-reference');assert.equal(policy.json.policy.maxByJob.oil,8000);
  assert.equal((await f.call('POST','/api/admin/config',{garageCostReferences:[...rows,...rows]},'admin')).status,400);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='config.garage_cost_reference'").get().n,1);
});

test('canonical mileage is anchored first, mirrored to the right car, and cannot be rolled back by stale car/color sync',async()=>{
  const f=await fixture();
  await f.call('PUT','/api/state',{state:{garage:{v:[{id:'car-1',make:'Honda',model:'Civic',mileage:'50000',color:'#123456'}],t:1}}});
  const first=await f.call('POST','/api/odo/anchor',{carId:'car-1',km:51000,source:'manual'});assert.equal(first.status,200);
  assert.equal(JSON.parse(f.db.prepare("SELECT v FROM user_state WHERE uid='me' AND k='garage'").get().v)[0].mileage,'51000');
  const lower=await f.call('POST','/api/odo/anchor',{carId:'car-1',km:50000,source:'manual'});assert.equal(lower.status,409);assert.equal(lower.json.code,'mileage_order');
  const jump=await f.call('POST','/api/odo/anchor',{carId:'car-1',km:100000,source:'manual'});assert.equal(jump.status,409);assert.equal(jump.json.code,'mileage_jump');
  assert.equal((await f.call('POST','/api/odo/anchor',{carId:'car-1',km:100000,confirmJump:true,source:'manual'})).status,200);
  const stale=await f.call('POST','/api/cars',{id:'car-1',make:'Honda',model:'Civic',mileage:'50000',color:'#AA1122'});assert.equal(stale.status,200);assert.equal(stale.json.mileage,'100000');
  assert.equal(f.db.prepare("SELECT mileage FROM cars WHERE id='car-1'").get().mileage,'100000');
  assert.equal((await f.call('POST','/api/odo/anchor',{carId:'car-1',km:100001},'other')).status,404);
});

test('simultaneous contradictory readings cannot create a reversed odometer history',async()=>{
  const f=await fixture(),at=Date.now()-1000;
  const results=await Promise.all([51000,50000].map(km=>f.call('POST','/api/odo/anchor',{carId:'car-1',km,observedAt:at,confirmJump:true})));
  assert.equal(results.filter(r=>r.status===200).length,1);
  assert.equal(results.filter(r=>r.status===409).length,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM odo_anchor WHERE observed_at=?').get(at).n,1);
});
