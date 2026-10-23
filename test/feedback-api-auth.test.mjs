import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/worker.js';
async function fixture(){
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);INSERT INTO config VALUES('schema_version','19');CREATE TABLE users(uid TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,photo TEXT,role TEXT DEFAULT 'user',last_login INTEGER NOT NULL,created_at INTEGER,banned INTEGER DEFAULT 0)");
  const DB={prepare(sql){let args=[];return {
    bind(...a){args=a;return this},
    async first(){return db.prepare(sql).get(...args)||null},
    async all(){return {results:db.prepare(sql).all(...args)}},
    async run(){return this._run()},
    _run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}}}
  }},async batch(list){db.exec('BEGIN');try{const r=list.map(s=>s._run());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
  const calls=[],env={DB,DEV_AUTH:'1',FIREBASE_PROJECT_ID:'cendon-unit-test',ALLOWED_ORIGINS:'*',CHAT_JOBS:{
    getByName(name){return {
      async list(uid){calls.push({name,uid,op:'list'});return {jobs:[]}},
      async create(uid,actor,body){calls.push({name,uid,op:'create'});return {job:{id:body.jobId,status:'queued'}}},
      async read(uid,id){calls.push({name,uid,op:'read'});return {job:{id,status:'complete'}}},
      async cancel(uid,id){calls.push({name,uid,op:'cancel'});return {job:{id,status:'cancelled'}}}
    }}
  }};
  const call=async(method,path,body,uid='one')=>{const r=await worker.fetch(new Request('https://fixture.test'+path,{method,headers:{'Content-Type':'application/json',...(uid?{Authorization:'Bearer dev:'+uid+':'+uid+'@unit.test'}:{})},...(body&&method==='POST'?{body:JSON.stringify(body)}:{})}),env,{waitUntil(){}});return {status:r.status,headers:r.headers,body:await r.json()}};
  await call('GET','/api/config',null,null);return {db,call,calls};
}
test('new job and shop routes require authentication, preserve no-store, and never trust body UID',async()=>{
  const f=await fixture();try{
    for(const path of ['/api/ai/jobs','/api/shop/status','/api/shop/search'])assert.equal((await f.call(path.endsWith('search')?'POST':'GET',path,{query:'pads'},null)).status,401,path);
    const id=crypto.randomUUID(),b={jobId:id,sessionId:'s1792720000000',carId:'car-1',uid:'someone-else',contents:[{role:'user',parts:[{text:'Synthetic'}]}]};
    for(const [method,path,body]of [['POST','/api/ai/jobs',b],['GET','/api/ai/jobs'],['GET','/api/ai/jobs/'+id],['POST','/api/ai/jobs/'+id+'/cancel',{}]]){const r=await f.call(method,path,body);assert.equal(r.status,200);assert.equal(r.headers.get('Cache-Control'),'private, no-store')}
    assert.ok(f.calls.length===4&&f.calls.every(c=>c.name==='user:one'&&c.uid==='one'));
    const shop=await f.call('POST','/api/shop/search',{query:'brake pads',providers:['ebay']});assert.equal(shop.status,200);assert.equal(shop.body.providers[0].state,'setup_required');assert.deepEqual(shop.body.items,[]);assert.equal(shop.headers.get('Cache-Control'),'private, no-store');
  }finally{f.db.close()}
});
