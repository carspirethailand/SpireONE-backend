import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {ONBOARDING_VERSIONS} from '../src/onboarding.js';

// Exercise the actual Worker dispatcher, CORS, guards and automatic schema
// migration. No network/email/real Firebase credentials are used.
let sequence=0;
async function fixture({legacy=[],failSnapshot=false}={}) {
  const worker=(await import(`../src/worker.js?accountIntegration=${++sequence}`)).default;
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);INSERT INTO config VALUES ('schema_version','19');
    CREATE TABLE users(uid TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,photo TEXT,role TEXT DEFAULT 'user',last_login INTEGER NOT NULL,created_at INTEGER,banned INTEGER DEFAULT 0);
    CREATE TABLE user_state(uid TEXT NOT NULL,k TEXT NOT NULL,v TEXT NOT NULL,t INTEGER NOT NULL,PRIMARY KEY(uid,k));`);
  const add=(uid,createdAt=Date.now()+60000,email=`${uid}@unit.test`,role='user')=>sqlite.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)').run(uid,'Provider name',email,'',role,1,createdAt,0);
  for(const old of legacy) {
    add(old.uid,old.createdAt??1);
    if(old.setup) sqlite.prepare("INSERT INTO user_state VALUES (?,'setup',?,?)").run(old.uid,JSON.stringify(old.setup),old.at??2);
  }
  let queue=Promise.resolve(),batchCalls=0,snapshotFailure=failSnapshot;
  const statements=[];
  const operation=fn=>{const p=queue.then(fn);queue=p.catch(()=>{});return p;};
  const DB={prepare(sql){statements.push(sql);let args=[];const s={bind(...values){args=values;return this;},first:()=>operation(()=>sqlite.prepare(sql).get(...args)||null),all:()=>operation(()=>({results:sqlite.prepare(sql).all(...args)})),run:()=>operation(()=>s._run()),_run(){if(snapshotFailure && /INSERT INTO user_onboarding/.test(sql))throw new Error('test-only snapshot failure');const out=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(out.changes)}};}};return s;},batch(list){batchCalls++;return operation(()=>{sqlite.exec('BEGIN');try{const results=list.map(s=>s._run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}});}};
  const env={DB,DEV_AUTH:'1',FIREBASE_PROJECT_ID:'cendon-integration-test',OWNERS:'owner@unit.test',ALLOWED_ORIGINS:'https://cendon.unit.test',ONBOARDING_PRIVACY_URL:'https://cendon.unit.test/privacy'};
  const call=async(method='GET',path='/api/onboarding',body,uid='fresh',extra={})=>{
    const headers={Origin:'https://cendon.unit.test','Content-Type':'application/json',...(uid?{Authorization:`Bearer dev:${uid}:${uid==='owner'?'owner':uid}@unit.test`}:{}),...extra};
    const request=new Request('https://worker.unit.test'+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
    const response=await worker.fetch(request,env,{waitUntil(){}});
    return {status:response.status,json:await response.json(),headers:response.headers};
  };
  return {worker,sqlite,env,add,call,statements,clearFailure(){snapshotFailure=false;},get batchCalls(){return batchCalls;}};
}
const form=(over={})=>({consent:true,name:'Chosen nickname',birthDate:'1990-05-16',lang:'th',distance:'km',currency:'THB',termsVersion:ONBOARDING_VERSIONS.terms,privacyVersion:ONBOARDING_VERSIONS.privacy,...over});

test('account integration: anonymous onboarding requests are denied before database access',async()=>{
  const f=await fixture();let accessed=0;
  f.env.DB={prepare(){accessed++;throw Error('DB must not be touched')},batch(){accessed++;throw Error('DB must not be touched')}};
  for(const [method,path] of [['GET','/api/onboarding'],['POST','/api/onboarding'],['POST','/api/onboarding/tutorial'],['PATCH','/api/onboarding/preferences']]) {
    const r=await f.call(method,path,method==='GET'?undefined:{},null);assert.equal(r.status,401);
  }
  assert.equal(accessed,0);
});

test('account integration: canonical setup and preference PATCH operate through the Worker with CORS',async()=>{
  const f=await fixture();f.add('fresh');f.add('second');
  const initial=await f.call();assert.equal(initial.status,200);assert.equal(initial.json.status,'required');
  assert.equal(f.sqlite.prepare("SELECT value FROM config WHERE key='schema_version'").get().value,'21');
  const done=await f.call('POST','/api/onboarding',form());assert.equal(done.status,200);assert.equal(done.json.completed,true);
  assert.equal(done.headers.get('Access-Control-Allow-Origin'),'https://cendon.unit.test');
  assert.match(done.headers.get('Access-Control-Allow-Methods'),/PATCH/);assert.equal(done.headers.get('Cache-Control'),'private, no-store');
  const preference=await f.call('PATCH','/api/onboarding/preferences',{name:'New nickname',distance:'mi',currency:'USD'});
  assert.equal(preference.status,200);assert.equal(preference.json.profile.name,'New nickname');assert.equal(preference.json.profile.units,'imperial');
  for(let i=0;i<6;i++) assert.equal((await f.call()).json.completedAt,done.json.completedAt);
  assert.equal((await f.call('GET','/api/onboarding',undefined,'second')).json.ready,false);
  assert.equal(f.batchCalls,3,'one schema batch, one completion batch, one preference batch');
});

test('account integration: subsequent Google-style login cannot overwrite the canonical nickname',async()=>{
  const f=await fixture();f.add('fresh');await f.call('POST','/api/onboarding',form());
  const login=await f.call('POST','/api/login',{name:'Google display name',photo:'https://image.unit.test/avatar.png'});
  assert.equal(login.status,200);assert.equal(login.json.name,'Chosen nickname');
  assert.equal(f.sqlite.prepare("SELECT name FROM users WHERE uid='fresh'").get().name,'Chosen nickname');
  assert.equal((await f.call()).json.ready,true);
});

test('account integration: explicit account reset clears only that account canonical onboarding',async()=>{
  const f=await fixture();f.add('fresh');f.add('second');
  await f.call('POST','/api/onboarding',form());await f.call('POST','/api/onboarding',form({name:'Other'}),'second');
  const denied=await f.call('POST','/api/account/reset',{},null);assert.equal(denied.status,401);
  assert.equal((await f.call()).json.ready,true);
  const reset=await f.call('POST','/api/account/reset',{});assert.equal(reset.status,200);assert.equal(reset.json.removed.user_onboarding,1);
  assert.equal((await f.call()).json.ready,false);assert.equal((await f.call('GET','/api/onboarding',undefined,'second')).json.ready,true);
  assert.ok(f.sqlite.prepare("SELECT uid FROM users WHERE uid='fresh'").get(),'reset keeps the account identity');
});

test('account integration: generic state uploads cannot forge completion or alter canonical name/DOB/consent',async()=>{
  const f=await fixture();f.add('fresh');
  const forged={v:3,uid:'fresh',level:'enthusiast',name:'Forged',birthDate:'2000-01-01',onboardingComplete:true};
  const before=await f.call('PUT','/api/state',{state:{setup:{v:forged,t:Date.now()+9999},_onboarding:{v:{completed:true},t:Date.now()}}});
  assert.equal(before.status,200);assert.equal((await f.call()).json.ready,false);
  const done=(await f.call('POST','/api/onboarding',form())).json;
  await f.call('PUT','/api/state',{state:{setup:{v:forged,t:Date.now()+99999},onboarding:{v:{completed:false},t:Date.now()},theme:{v:'dark',t:Date.now()}}});
  const after=(await f.call()).json;
  assert.equal(after.profile.name,done.profile.name);assert.equal(after.profile.birthDate,done.profile.birthDate);assert.equal(after.completedAt,done.completedAt);assert.equal(after.consentedAt,done.consentedAt);
  const state=(await f.call('GET','/api/state')).json.state;
  assert.equal(state.setup.v.birthDate,undefined,'DOB is not distributed to general cloud-state consumers');
  assert.equal(state.setup.v.name,done.profile.name);assert.equal(state.theme.v,'dark');
});

test('account integration: rollout snapshots existing completion once before processing state uploads',async()=>{
  const f=await fixture({legacy:[{uid:'old',setup:{v:3,level:'advance',name:'Existing driver'}},{uid:'incomplete',setup:{v:3,name:'Incomplete'}}]});
  f.add('fresh');
  const old=await f.call('GET','/api/onboarding',undefined,'old');assert.equal(old.json.ready,true);assert.equal(old.json.legacy,true);assert.equal(old.json.tutorial.status,'skipped');
  assert.equal((await f.call('GET','/api/onboarding',undefined,'incomplete')).json.ready,false);
  await f.call('PUT','/api/state',{state:{setup:{v:{v:3,level:'enthusiast'},t:1}}},'incomplete');
  assert.equal((await f.call('GET','/api/onboarding',undefined,'incomplete')).json.ready,false);
  assert.equal(f.batchCalls,1,'schema snapshot does not rerun during later requests');
});

test('account integration: failed rollout is unavailable, rolls back the snapshot and does not mark schema 21',async()=>{
  const f=await fixture({legacy:[{uid:'old',setup:{v:3,level:'basic'}}],failSnapshot:true});f.add('fresh');
  const failed=await f.call();assert.equal(failed.status,503);assert.equal(failed.json.error,'Account services are temporarily unavailable');
  assert.equal(f.sqlite.prepare("SELECT value FROM config WHERE key='schema_version'").get().value,'19');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='user_onboarding'").get().n,0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM config WHERE key='onboarding_seed_done'").get().n,0);
  f.clearFailure();assert.equal((await f.call()).status,200);assert.equal((await f.call('GET','/api/onboarding',undefined,'old')).json.ready,true);
  assert.equal(f.sqlite.prepare("SELECT value FROM config WHERE key='schema_version'").get().value,'21');
});

test('account integration: verified local-test owners and banned ordinary users follow the Worker guards',async()=>{
  const f=await fixture();f.add('owner',Date.now()+60000,'owner@unit.test');f.add('fresh');
  const ownerLogin=await f.call('POST','/api/login',{name:'Owner'},'owner');assert.equal(ownerLogin.json.role,'owner');
  const regularLogin=await f.call('POST','/api/login',{name:'Regular'});assert.equal(regularLogin.json.role,'user');
  f.sqlite.prepare("UPDATE users SET banned=1 WHERE uid='fresh'").run();assert.equal((await f.call()).status,403);
});

test('account integration: real signed JWTs never grant owner privileges to unverified owner-email claims',async t=>{
  const f=await fixture();delete f.env.DEV_AUTH;
  f.add('unverified-owner',Date.now()+60000,'owner@unit.test','owner');f.add('verified-owner',Date.now()+60000,'owner@unit.test');
  const {privateKey,publicKey}=await generateKeyPair('RS256',{modulusLength:2048});
  const key={...await exportJWK(publicKey),kid:'unit-only-onboarding-key',alg:'RS256',use:'sig'};
  let jwksCalls=0;
  t.mock.method(https,'get',(url)=>{
    assert.equal(url,'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    jwksCalls++;
    const request=new EventEmitter();request.destroy=()=>{};
    const response=Readable.from([Buffer.from(JSON.stringify({keys:[key]}))]);response.statusCode=200;
    queueMicrotask(()=>request.emit('response',response));return request;
  });
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const token=(uid,verified)=>new SignJWT({email:'owner@unit.test',email_verified:verified,name:'Provider name'})
    .setProtectedHeader({alg:'RS256',kid:key.kid}).setIssuedAt().setExpirationTime('5m')
    .setIssuer('https://securetoken.google.com/cendon-integration-test').setAudience('cendon-integration-test').setSubject(uid).sign(privateKey);
  const unverified=await token('unverified-owner',false),verified=await token('verified-owner',true);
  const denied=await f.call('GET','/api/admin/users',undefined,'unverified-owner',{Authorization:'Bearer '+unverified});
  assert.equal(denied.status,403,'a stale stored owner role cannot rescue an unverified owner claim');
  const login=await f.call('POST','/api/login',{name:'Unverified'},'unverified-owner',{Authorization:'Bearer '+unverified});
  assert.equal(login.status,200);assert.equal(login.json.role,'user');
  assert.equal(f.sqlite.prepare("SELECT role FROM users WHERE uid='unverified-owner'").get().role,'user');
  const actualOwner=await f.call('POST','/api/login',{name:'Verified'},'verified-owner',{Authorization:'Bearer '+verified});
  assert.equal(actualOwner.status,200);assert.equal(actualOwner.json.role,'owner');
  assert.equal((await f.call('GET','/api/admin/users',undefined,'verified-owner',{Authorization:'Bearer '+verified})).status,200);
  assert.equal(jwksCalls,1,'actual signature checks reuse the mocked official JWKS, never the network');
});
