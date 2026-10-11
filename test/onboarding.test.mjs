import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleOnboarding,ONBOARDING_SQL,ONBOARDING_VERSIONS,onboardingName,sanitizeSetupState} from '../src/onboarding.js';

function fixture({legacy=[]}={}) {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE users(uid TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,created_at INTEGER);
    CREATE TABLE user_state(uid TEXT NOT NULL,k TEXT NOT NULL,v TEXT NOT NULL,t INTEGER NOT NULL,PRIMARY KEY(uid,k));`);
  for(const u of legacy) {
    sqlite.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(u.uid,'Original',`${u.uid}@unit.test`,'user',Object.hasOwn(u,'createdAt')?u.createdAt:1);
    if(u.setup!==undefined) sqlite.prepare('INSERT INTO user_state VALUES (?,?,?,?)').run(u.uid,'setup',typeof u.setup==='string'?u.setup:JSON.stringify(u.setup),u.at??2);
  }
  let queue=Promise.resolve();
  const DB={prepare(sql){let args=[];return {bind(...v){args=v;return this;},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){const r=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}};},batch(list){const task=queue.then(async()=>{sqlite.exec('BEGIN');try{const out=[];for(const statement of list)out.push(await statement.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}});queue=task.catch(()=>{});return task;}};
  const env={DB,ONBOARDING_PRIVACY_URL:'https://cendon.unit.test/privacy'};
  const migrate=()=>DB.batch(ONBOARDING_SQL.map(sql=>DB.prepare(sql)));
  const add=(uid='fresh',createdAt=Date.now()+1000)=>sqlite.prepare('INSERT OR IGNORE INTO users VALUES (?,?,?,?,?)').run(uid,'Original',`${uid}@unit.test`,'user',createdAt);
  const put=(uid,value,t=Date.now())=>sqlite.prepare("INSERT INTO user_state VALUES (?,'setup',?,?) ON CONFLICT(uid,k) DO UPDATE SET v=excluded.v,t=excluded.t").run(uid,JSON.stringify(value),t);
  const call=async(method='GET',path='/api/onboarding',data,uid='fresh')=>{
    const res=await handleOnboarding(new Request('https://unit.test'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:typeof data==='string'?data:JSON.stringify(data)}),env,uid?{payload:{sub:uid}}:null);
    return res?{status:res.status,json:await res.json(),cache:res.headers.get('Cache-Control')}:null;
  };
  return {sqlite,env,add,put,migrate,call};
}
const form=(over={})=>({consent:true,name:'พอร์ช',birthDate:'1996-02-29',lang:'th',distance:'km',currency:'THB',termsVersion:ONBOARDING_VERSIONS.terms,privacyVersion:ONBOARDING_VERSIONS.privacy,...over});
async function fresh(){const f=fixture();await f.migrate();f.add();return f;}
const stored=f=>JSON.parse(f.sqlite.prepare("SELECT v FROM user_state WHERE uid='fresh' AND k='setup'").get().v);

test('onboarding: per-account completion survives repeated logins, refreshes and a new browser',async()=>{
  const f=await fresh();f.add('other');
  assert.equal((await f.call()).json.status,'required');
  const done=await f.call('POST','/api/onboarding',form());
  assert.equal(done.status,200);assert.equal(done.json.ready,true);assert.equal(done.json.profile.name,'พอร์ช');
  assert.equal(done.json.profile.level,'enthusiast');assert.equal(done.json.tutorial.status,'pending');
  assert.equal(done.cache,'private, no-store');
  for(let i=0;i<6;i++) assert.deepEqual((await f.call()).json,done.json);
  assert.equal((await f.call('GET','/api/onboarding',undefined,'other')).json.completed,false);
  assert.equal(await onboardingName(f.env,'fresh'),'พอร์ช');
  assert.equal(f.sqlite.prepare("SELECT name FROM users WHERE uid='fresh'").get().name,'พอร์ช');
  assert.equal(stored(f).uid,'fresh');assert.equal(stored(f).v,3);
  assert.equal(stored(f).birthDate,undefined,'DOB never enters the generic cloud-state/AI projection');
  assert.equal(JSON.parse(f.sqlite.prepare("SELECT v FROM user_state WHERE uid='fresh' AND k='lang'").get().v),'th');
});

test('onboarding: completion replay cannot change the first profile or reset a finished tutorial',async()=>{
  const f=await fresh();const first=await f.call('POST','/api/onboarding',form());
  await f.call('POST','/api/onboarding/tutorial',{status:'skipped'});
  const replay=await f.call('POST','/api/onboarding',form({name:'Replacement',birthDate:'2000-01-01',lang:'en',distance:'mi',currency:'USD'}));
  assert.equal(replay.json.profile.name,first.json.profile.name);assert.equal(replay.json.completedAt,first.json.completedAt);
  assert.equal(replay.json.consentedAt,first.json.consentedAt);assert.equal(replay.json.tutorial.status,'skipped');
  assert.equal((await f.call('POST','/api/onboarding',{})).status,200,'a stale completion retry safely returns the existing result');
});

test('onboarding: consent and current document versions are mandatory and never inferred from login',async()=>{
  const f=await fresh();
  for(const consent of [false,null,undefined,'true',1]) assert.equal((await f.call('POST','/api/onboarding',form({consent}))).json.error,'consent_required');
  assert.equal((await f.call('POST','/api/onboarding',form({termsVersion:'stale'}))).status,409);
  assert.equal((await f.call('POST','/api/onboarding',form({privacyVersion:undefined}))).status,409);
  assert.equal((await f.call()).json.ready,false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_onboarding').get().n,0);
});

test('onboarding: exact Gregorian birthdays reject impossible dates before applying the approved 18+ policy',async()=>{
  const f=await fresh();
  for(const birthDate of ['1899-12-31','1995-02-29','2020-04-31','2026-13-01','2026-00-01','2020-01-00','2026-1-1','9999-12-31',123,null]) {
    assert.equal((await f.call('POST','/api/onboarding',form({birthDate}))).json.error,'invalid_birth_date',String(birthDate));
  }
  const today=new Date().toISOString().slice(0,10);
  assert.equal((await f.call('POST','/api/onboarding',form({birthDate:today}))).json.error,'minimum_age_18','the supplied policy, not an arbitrary default, requires 18+');
  assert.equal((await f.call('POST','/api/onboarding',form({birthDate:'1996-02-29'}))).status,200,'real adult leap-day birthdays remain valid');
});

test('onboarding: names, enums, ownership and malformed bodies are validated',async()=>{
  const f=await fresh();
  for(const name of ['', '   ','<img src=x>','A\nB','A\u0000B','A\u202eB','a'.repeat(61),'🚗']) assert.equal((await f.call('POST','/api/onboarding',form({name}))).json.error,'invalid_name');
  for(const [key,value,error] of [['lang','xx','invalid_language'],['distance','furlong','invalid_distance'],['currency','XXX','invalid_currency']]) assert.equal((await f.call('POST','/api/onboarding',form({[key]:value}))).json.error,error);
  assert.equal((await f.call('POST','/api/onboarding','{bad')).status,400);
  assert.equal((await f.call('POST','/api/onboarding',' '.repeat(17000))).status,413);
  assert.equal((await f.call('GET','/api/onboarding',undefined,null)).status,401);
  assert.equal((await f.call('DELETE')).status,405);
  assert.equal(await f.call('GET','/unrelated'),null);
  const r=await f.call('POST','/api/onboarding',form({name:'  Marie   O’Connor  ',uid:'other',completed:true,level:'basic'}));
  assert.equal(r.json.profile.name,'Marie O’Connor');assert.equal(r.json.profile.uid,'fresh');assert.equal(r.json.profile.level,'enthusiast');
});

test('onboarding: tutorial completes or skips once, never before setup, and remains independent between accounts',async()=>{
  const f=await fresh();f.add('other');
  assert.equal((await f.call('POST','/api/onboarding/tutorial',{status:'completed'})).status,409);
  await f.call('POST','/api/onboarding',form());
  assert.equal((await f.call('POST','/api/onboarding/tutorial',{status:'pending'})).status,400);
  const r=await f.call('POST','/api/onboarding/tutorial',{status:'completed'});
  assert.equal(r.json.tutorial.status,'completed');assert.ok(r.json.tutorial.finishedAt);
  assert.deepEqual((await f.call('POST','/api/onboarding/tutorial',{status:'skipped'})).json.tutorial,r.json.tutorial);
  assert.equal((await f.call('GET','/api/onboarding',undefined,'other')).json.tutorial.status,'pending');
});

test('onboarding: valid existing preferences survive completion and birthday is kept private',async()=>{
  const f=await fresh();
  f.put('fresh',{v:3,uid:'fresh',level:'advance',theme:'ocean',plan:'exclusive',photo:'https://images.unit.test/avatar.png',notify:true,lang:'ja',currency:'JPY'});
  const r=await f.call('POST','/api/onboarding',form({distance:'mi',currency:'USD'}));
  assert.equal(r.json.profile.level,'advance');assert.equal(r.json.profile.theme,'ocean');assert.equal(r.json.profile.plan,'exclusive');
  assert.equal(r.json.profile.notify,true);assert.equal(r.json.profile.photo,'https://images.unit.test/avatar.png');
  assert.equal(r.json.profile.units,'imperial');assert.equal(stored(f).currency,'USD');assert.equal(stored(f).birthDate,undefined);
  assert.equal(JSON.parse(f.sqlite.prepare("SELECT profile FROM user_onboarding WHERE uid='fresh'").get().profile).birthDate,'1996-02-29');
});

test('onboarding: cross-account old setup injection never grants completion or imports another account preferences',async()=>{
  const f=await fresh();
  f.put('fresh',{uid:'other',v:3,level:'basic',theme:'dark',plan:'exclusive',name:'Victim',birthDate:'1990-01-01'},1);
  await f.migrate();assert.equal((await f.call()).json.completed,false);
  const r=await f.call('POST','/api/onboarding',form());
  assert.equal(r.json.profile.level,'enthusiast');assert.equal(r.json.profile.theme,'light');assert.equal(r.json.profile.plan,'free');
});

test('onboarding: rollout grandfathers only previously completed valid server profiles, once',async()=>{
  const f=fixture({legacy:[
    {uid:'old',setup:{v:3,level:'basic',theme:'plant',name:'Old driver',lang:'de',units:'imperial',currency:'EUR'}},
    {uid:'incomplete',setup:{v:3,name:'No level'}},
    {uid:'invalid',setup:'not-json'},
    {uid:'cross',setup:{v:3,level:'basic',uid:'old'}},
    {uid:'nullcreated',createdAt:null,setup:{v:3,level:'enthusiast'}},
    {uid:'future',createdAt:Date.now()+60000,setup:{v:3,level:'enthusiast'}},
  ]});
  await f.migrate();
  const old=(await f.call('GET','/api/onboarding',undefined,'old')).json;
  assert.equal(old.completed,true);assert.equal(old.legacy,true);assert.equal(old.consentedAt,null);
  assert.equal(old.termsVersion,'legacy-pre-onboarding');assert.equal(old.tutorial.status,'skipped');assert.equal(old.profile.birthDate,null);
  assert.equal(old.profile.level,'basic');assert.equal(old.profile.distance,'mi');
  for(const uid of ['incomplete','invalid','cross','nullcreated','future']) assert.equal((await f.call('GET','/api/onboarding',undefined,uid)).json.completed,false,uid);
  f.put('incomplete',{v:3,level:'enthusiast'},1);f.add('new-with-stale-browser',1);f.put('new-with-stale-browser',{v:3,level:'enthusiast'},1);
  await f.migrate();
  assert.equal((await f.call('GET','/api/onboarding',undefined,'incomplete')).json.completed,false,'backdated later writes are never migrated');
  assert.equal((await f.call('GET','/api/onboarding',undefined,'new-with-stale-browser')).json.completed,false,'a new UID cannot import a global browser done flag');
});

test('onboarding: a mid-completion DB failure rolls back authority, profile projection and users.name',async()=>{
  const f=await fresh();const prepare=f.env.DB.prepare;
  f.env.DB.prepare=sql=>{const s=prepare(sql);if(/INSERT INTO user_state/.test(sql))s.run=async()=>{throw Error('test-only outage')};return s;};
  assert.equal((await f.call('POST','/api/onboarding',form())).status,503);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_onboarding').get().n,0);
  assert.equal(f.sqlite.prepare("SELECT name FROM users WHERE uid='fresh'").get().name,'Original');
  f.env.DB.prepare=prepare;assert.equal((await f.call()).json.ready,false);
  assert.equal((await f.call('POST','/api/onboarding',form())).status,200);
});

test('onboarding: an offline/unavailable DB never reports setup or tutorial success',async()=>{
  const f=await fresh();f.env.DB.prepare=()=>{throw Error('test-only unavailable')};
  assert.equal((await f.call()).status,503);assert.equal((await f.call('POST','/api/onboarding',form())).status,503);
  assert.equal(await onboardingName(f.env,'fresh'),'');
});

test('onboarding: concurrent completion uses the first committed canonical values everywhere',async()=>{
  const f=await fresh();
  const results=await Promise.all([f.call('POST','/api/onboarding',form({name:'First'})),f.call('POST','/api/onboarding',form({name:'Second'}))]);
  assert.equal(results[0].json.profile.name,results[1].json.profile.name);
  assert.equal(stored(f).name,results[0].json.profile.name);assert.equal(await onboardingName(f.env,'fresh'),results[0].json.profile.name);
});

test('onboarding: preference edits update name and units without modifying immutable completion, consent, DOB or tutorial',async()=>{
  const f=await fresh();await f.call('POST','/api/onboarding',form());
  const first=(await f.call('POST','/api/onboarding/tutorial',{status:'skipped'})).json;
  f.put('fresh',{...stored(f),level:'basic',theme:'dark',plan:'light',notify:true});
  assert.equal((await f.call()).json.profile.theme,'dark','allowed legacy preference changes are reflected without trusting completion flags');
  const r=await f.call('PATCH','/api/onboarding/preferences',{name:'Alex',lang:'ja',distance:'m',currency:'JPY'});
  assert.equal(r.status,200);assert.equal(r.json.profile.name,'Alex');assert.equal(r.json.profile.lang,'ja');assert.equal(r.json.profile.distance,'m');
  assert.equal(r.json.profile.units,'metric');assert.equal(r.json.profile.currency,'JPY');assert.equal(r.json.profile.level,'basic');assert.equal(r.json.profile.theme,'dark');
  assert.equal(r.json.profile.plan,'light');assert.equal(r.json.profile.notify,true);
  assert.equal(r.json.completedAt,first.completedAt);assert.equal(r.json.consentedAt,first.consentedAt);assert.equal(r.json.profile.birthDate,first.profile.birthDate);assert.deepEqual(r.json.tutorial,first.tutorial);
  assert.equal(await onboardingName(f.env,'fresh'),'Alex');assert.equal(stored(f).birthDate,undefined);assert.equal(stored(f).notify,true);
  assert.equal(f.sqlite.prepare("SELECT name FROM users WHERE uid='fresh'").get().name,'Alex');
  for(const payload of [{birthDate:'2000-01-01'},{uid:'other'},{completed:false},{tutorial:'pending'},{plan:'exclusive'},{}]) assert.equal((await f.call('PATCH','/api/onboarding/preferences',payload)).status,400);
});

test('onboarding: concurrent partial preference updates compose instead of overwriting unrelated changes',async()=>{
  const f=await fresh();await f.call('POST','/api/onboarding',form());
  await Promise.all([f.call('PATCH','/api/onboarding/preferences',{name:'Updated name'}),f.call('PATCH','/api/onboarding/preferences',{currency:'EUR'})]);
  const result=(await f.call()).json;assert.equal(result.profile.name,'Updated name');assert.equal(result.profile.currency,'EUR');assert.equal(stored(f).name,'Updated name');assert.equal(stored(f).currency,'EUR');
});

test('onboarding: migration file and exported SQL produce the same idempotent schema and legacy snapshot',async()=>{
  const sql=readFileSync(new URL('../migrations/0021_onboarding.sql',import.meta.url),'utf8');
  const f=fixture({legacy:[{uid:'old',setup:{v:3,level:'advance'}}]});
  f.sqlite.exec(sql);f.sqlite.exec(sql);await f.migrate();
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_onboarding').get().n,1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM config WHERE key IN ('onboarding_rollout_at','onboarding_seed_done')").get().n,2);
  assert.equal((await f.call('GET','/api/onboarding',undefined,'old')).json.legacy,true);
});

test('onboarding: declared oversized bodies are rejected before reading their stream',async()=>{
  const f=await fresh();let cancelled=false,reads=0;
  const stream=new ReadableStream({pull(){reads++;},cancel(){cancelled=true;}},{highWaterMark:0});
  const request=new Request('https://unit.test/api/onboarding',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':'16385'},body:stream,duplex:'half'});
  const response=await handleOnboarding(request,f.env,{payload:{sub:'fresh'}});
  assert.equal(response.status,413);assert.equal((await response.json()).error,'request_too_large');
  assert.equal(reads,0);assert.equal(cancelled,true);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_onboarding').get().n,0);
});

test('onboarding: actual streaming bytes are bounded despite missing or false content lengths',async()=>{
  for(const declared of [null,'4']) {
    const f=await fresh();let cancelled=false,reads=0;
    const stream=new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(8193));},cancel(){cancelled=true;}},{highWaterMark:0});
    const request=new Request('https://unit.test/api/onboarding',{method:'POST',headers:{'Content-Type':'application/json',...(declared?{'Content-Length':declared}:{})},body:stream,duplex:'half'});
    const response=await handleOnboarding(request,f.env,{payload:{sub:'fresh'}});
    assert.equal(response.status,413);assert.equal(reads,2);assert.equal(cancelled,true);
  }
});

test('onboarding: slow bodies time out after five seconds and cancellation cannot stall the response',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fresh();let cancelled=false,readStarted;
  const started=new Promise(resolve=>readStarted=resolve);
  const stream=new ReadableStream({pull(){readStarted();return new Promise(()=>{});},cancel(){cancelled=true;return new Promise(()=>{});}},{highWaterMark:0});
  const request=new Request('https://unit.test/api/onboarding',{method:'POST',body:stream,duplex:'half'});
  const pending=handleOnboarding(request,f.env,{payload:{sub:'fresh'}});
  await started;t.mock.timers.tick(4999);await Promise.resolve();
  t.mock.timers.tick(1);
  const response=await pending;
  assert.equal(response.status,408);assert.equal((await response.json()).error,'request_timeout');assert.equal(cancelled,true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_onboarding').get().n,0);
});

test('onboarding: malformed UTF-8 and non-object JSON do not mutate account data',async()=>{
  const f=await fresh();
  for(const body of [new Uint8Array([0xc3,0x28]),'null','[]','123','"hello"']) {
    const request=new Request('https://unit.test/api/onboarding',{method:'POST',body});
    const response=await handleOnboarding(request,f.env,{payload:{sub:'fresh'}});
    assert.equal(response.status,400);assert.equal((await response.json()).error,'invalid_json');
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM user_onboarding').get().n,0);
});

test('onboarding: generic setup sanitizer strips DOB and cannot accept client completion authority',async()=>{
  const f=await fresh();
  const value=await sanitizeSetupState(f.env,'fresh',{v:999,uid:'fresh',name:'My preference',lang:'ja',distance:'mi',currency:'JPY',level:'basic',theme:'dark',plan:'light',notify:true,birthDate:'1990-01-01',birth:'1990-01-01',dob:'1990-01-01',completed:true,onboardingComplete:true,at:999999999999999,unknown:'do not preserve'});
  assert.equal(value.uid,'fresh');assert.equal(value.v,3);assert.equal(value.completed,false);assert.equal(value.onboardingComplete,false);assert.equal(value.at,0);
  assert.equal(value.name,'My preference');assert.equal(value.lang,'ja');assert.equal(value.units,'imperial');assert.equal(value.distance,'mi');assert.equal(value.currency,'JPY');
  assert.equal(value.level,'basic');assert.equal(value.theme,'dark');assert.equal(value.plan,'light');assert.equal(value.notify,true);
  for(const key of ['birthDate','birth','dob','unknown']) assert.equal(Object.hasOwn(value,key),false);
  assert.equal((await f.call()).json.completed,false,'a sanitized v3 format is not proof of completion');
});

test('onboarding: foreign-account or primitive setup inputs yield safe defaults before completion',async()=>{
  const f=await fresh();
  for(const value of [null,[],true,'bad',{uid:'other',name:'Victim',lang:'de',theme:'dark',level:'basic',plan:'exclusive',completed:true},{uid:null,name:'Wrong owner'}]) {
    const safe=await sanitizeSetupState(f.env,'fresh',value);
    assert.equal(safe.uid,'fresh');assert.equal(safe.name,'');assert.equal(safe.lang,'en');assert.equal(safe.theme,'light');assert.equal(safe.level,'enthusiast');assert.equal(safe.plan,'free');assert.equal(safe.completed,false);
  }
});

test('onboarding: canonical authority survives generic setup null, foreign UID and newer stale snapshots',async()=>{
  const f=await fresh();const done=(await f.call('POST','/api/onboarding',form({name:'Canonical',lang:'th',distance:'mi',currency:'USD'}))).json;
  f.put('fresh',{...stored(f),level:'basic',theme:'plant',plan:'light',notify:true});
  for(const value of [null,{uid:'other',level:'advance',theme:'dark',name:'Foreign',lang:'de',distance:'km',currency:'EUR',completed:false},{uid:'fresh',name:'Stale',lang:'ja',distance:'m',units:'metric',currency:'JPY',completed:false,onboardingComplete:false,birthDate:'2000-01-01',at:Date.now()+999999}]) {
    const safe=await sanitizeSetupState(f.env,'fresh',value);
    assert.equal(safe.uid,'fresh');assert.equal(safe.name,'Canonical');assert.equal(safe.lang,'th');assert.equal(safe.distance,'mi');assert.equal(safe.units,'imperial');assert.equal(safe.currency,'USD');
    assert.equal(safe.completed,true);assert.equal(safe.onboardingComplete,true);assert.equal(safe.at,done.completedAt);
    assert.equal(safe.level,'basic');assert.equal(safe.theme,'plant');assert.equal(safe.plan,'light');assert.equal(safe.notify,true);
    assert.equal(safe.birthDate,undefined);
  }
  const edited=await sanitizeSetupState(f.env,'fresh',{uid:'fresh',level:'advance',theme:'dark',notify:false});
  assert.equal(edited.level,'advance');assert.equal(edited.theme,'dark');assert.equal(edited.notify,false);assert.equal(edited.name,'Canonical');
});

test('onboarding: generic sanitizer propagates database failure rather than returning unknown raw state',async()=>{
  const f=await fresh();f.env.DB.prepare=()=>{throw Error('test-only database unavailable')};
  await assert.rejects(()=>sanitizeSetupState(f.env,'fresh',{birthDate:'1990-01-01',completed:true}),/database unavailable/);
});

test('onboarding: an unavailable or non-HTTPS policy never records new consent',async()=>{
  for(const url of [undefined,'','http://example.test/privacy','https://user:password@example.test/privacy','javascript:alert(1)']){
    const f=await fresh();f.env.ONBOARDING_PRIVACY_URL=url;
    const status=(await f.call()).json;assert.equal(status.completed,false);assert.equal(status.policy.enabled,false);
    const sent=await f.call('POST','/api/onboarding',form());assert.equal(sent.status,503);assert.equal(sent.json.error,'onboarding_policy_unavailable');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM user_onboarding').get().n,0);
  }
});

test('onboarding: supplied policy is returned and under-18 birthdays cannot be stored',async()=>{
  const f=await fresh();const status=(await f.call()).json;assert.equal(status.policy.privacyUrl,f.env.ONBOARDING_PRIVACY_URL);
  for(const birthDate of ['2010-01-01','2020-01-01']){
    const sent=await f.call('POST','/api/onboarding',form({birthDate}));assert.equal(sent.status,400);assert.equal(sent.json.error,'minimum_age_18');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM user_onboarding').get().n,0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM user_state WHERE k='setup'").get().n,0);
  }
});
