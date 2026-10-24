import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER,ADMIN} from './tech-fixtures.mjs';
import {handleTech} from '../src/techs.js';
const MECH='mech|mechanic@unit.test',OTHER='other|other@unit.test';
async function seed(){
  const f=fixture();await f.call('','/api/tech/ping');
  f.sqlite.prepare("INSERT INTO tech_profiles(id,uid,data,verified,test,suspended,created_at,updated_at) VALUES ('t_archive','mech',?,1,0,0,1,1)").run(JSON.stringify({shop:'Archive fixture shop',cats:['eng']}));
  const ids=[];for(const status of ['completed','cancelled','done','working','disputed','requested','quoted','accepted','enroute']){
    const id=crypto.randomUUID();ids.push(id);f.sqlite.prepare('INSERT INTO tech_jobs(id,tech_id,customer_uid,status,car,symptom,area,address,phone,requested_time,mode,history,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,'t_archive','applicant',status,'Toyota fixture car','Engine inspection','Test area','Private address','0811111111','Tomorrow','shop',JSON.stringify([{status,by:'fixture',at:Date.now()}]),Date.now(),Date.now());
  }
  f.sqlite.prepare("INSERT INTO tech_messages(job_id,uid,role,text,at) VALUES (?,'applicant','customer','Private evidence fixture',1)").run(ids[0]);
  return {...f,ids};
}
const snapshot=f=>Object.fromEntries(['tech_jobs','tech_messages','tech_profiles','tech_gigs','tech_docs','tech_applications'].map(t=>[t,f.sqlite.prepare('SELECT * FROM '+t+' ORDER BY rowid').all().map(x=>({...x}))]));
const update=(f,ids,archived=true,token=MECH)=>f.call(token,'/api/tech/jobs/archive',{ids,archived});
test('a mechanic can clear finished/cancelled jobs without changing jobs, chats, evidence or customer history',async()=>{
  const f=await seed(),before=snapshot(f),r=await update(f,f.ids.slice(0,2));assert.equal(r.status,200);assert.ok(r.jobs.every(j=>j.archived));
  const mine=(await f.call(MECH,'/api/tech/jobs')).jobs;assert.equal(mine.filter(j=>j.archived).length,2);assert.equal(mine.length,9);
  const customer=(await f.call(USER,'/api/tech/jobs')).jobs;assert.ok(customer.every(j=>!j.archived));assert.equal(customer.length,9);
  const detail=await f.call(MECH,'/api/tech/jobs/'+f.ids[0]);assert.equal(detail.status,200);assert.equal(detail.job.messages[0].text,'Private evidence fixture');
  assert.deepEqual(snapshot(f),before);
});
test('pending sign-off, active work and disputed jobs cannot be cleared, including mixed batches',async()=>{
  const f=await seed();for(const id of f.ids.slice(2)){const r=await update(f,[f.ids[0],id]);assert.equal(r.status,409);assert.match(r.error,/รอตรวจรับ/)}
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_job_archives').get().n,0);
});
test('customers, other mechanics and administrators cannot clear another mechanic\'s list',async()=>{
  const f=await seed(),before=snapshot(f);
  for(const token of [USER,OTHER,ADMIN])assert.equal((await update(f,[f.ids[0]],true,token)).status,404);
  assert.equal((await update(f,[f.ids[0]],true,'')).status,401);
  assert.equal((await update(f,[f.ids[0],crypto.randomUUID()])).status,404);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_job_archives').get().n,0);assert.deepEqual(snapshot(f),before);
});
test('invalid payloads fail before writing archive state',async()=>{
  const f=await seed();for(const body of [{},{ids:[],archived:true},{ids:[f.ids[0]],archived:'true'},{ids:['bad'],archived:true},{ids:Array(201).fill(f.ids[0]),archived:true}])assert.equal((await f.call(MECH,'/api/tech/jobs/archive',body)).status,400);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_job_archives').get().n,0);
});
test('clear/restore are idempotent and change only the mechanic\'s cross-device pulse',async()=>{
  const f=await seed(),before=(await f.call(MECH,'/api/tech/pulse')).v,customer=(await f.call(USER,'/api/tech/pulse')).v;
  await update(f,[f.ids[0],f.ids[0]]);const cleared=(await f.call(MECH,'/api/tech/pulse')).v;assert.notEqual(cleared,before);assert.equal((await f.call(USER,'/api/tech/pulse')).v,customer);
  await update(f,[f.ids[0]]);assert.equal((await f.call(MECH,'/api/tech/pulse')).v,cleared);assert.equal(f.sqlite.prepare('SELECT generation FROM tech_job_archives').get().generation,1);
  const r=await update(f,[f.ids[0]],false);assert.equal(r.jobs[0].archived,false);assert.notEqual((await f.call(MECH,'/api/tech/pulse')).v,cleared);
  const restored=(await f.call(MECH,'/api/tech/pulse')).v;await update(f,[f.ids[0]],false);assert.equal((await f.call(MECH,'/api/tech/pulse')).v,restored);
});
test('a reopened dispute or a new terminal revision reappears instead of inheriting an old clear',async()=>{
  const f=await seed();await update(f,[f.ids[0]]);
  for(const status of ['disputed','completed']){f.sqlite.prepare('UPDATE tech_jobs SET status=?,revision=revision+1 WHERE id=?').run(status,f.ids[0]);const row=(await f.call(MECH,'/api/tech/jobs')).jobs.find(j=>j.id===f.ids[0]);assert.equal(row.archived,false)}
  assert.equal((await update(f,[f.ids[0]])).jobs[0].archived,true);
});
test('a status change between validation and the transaction is not hidden',async()=>{
  const f=await seed(),original=f.env.DB.batch;let changed=false;
  f.env.DB.batch=list=>{if(!changed){changed=true;f.sqlite.prepare("UPDATE tech_jobs SET status='disputed',revision=revision+1 WHERE id=?").run(f.ids[0])}return original(list)};
  const r=await update(f,[f.ids[0],f.ids[1]]);assert.equal(r.status,200);assert.equal(r.jobs.find(j=>j.id===f.ids[0]).archived,false);assert.equal(r.jobs.find(j=>j.id===f.ids[1]).archived,true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_job_archives WHERE job_id=?').get(f.ids[0]).n,0);
});
test('up to 200 closed jobs fit bounded D1 statements and are all preserved',async()=>{
  const f=await seed(),row=f.sqlite.prepare('SELECT * FROM tech_jobs WHERE id=?').get(f.ids[0]),columns=Object.keys(row),sql='INSERT INTO tech_jobs('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')',ids=[f.ids[0]];
  for(let i=1;i<200;i++){const r={...row,id:crypto.randomUUID()};ids.push(r.id);f.sqlite.prepare(sql).run(...columns.map(k=>r[k]))}
  const original=f.env.DB.prepare;let max=0;f.env.DB.prepare=sql=>{const s=original(sql),bind=s.bind;s.bind=(...v)=>{max=Math.max(max,v.length);return bind.apply(s,v)};return s};
  const r=await update(f,ids);assert.equal(r.status,200);assert.equal(r.jobs.length,200);assert.ok(r.jobs.every(j=>j.archived));assert.ok(max<=100,'D1 variable limit: '+max);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_jobs').get().n,208);
});
test('cold-start schema initialization preserves clear state and private response headers',async()=>{
  const f=await seed();await update(f,[f.ids[0]]);const before=snapshot(f),archive=f.sqlite.prepare('SELECT * FROM tech_job_archives').all();
  const fresh=await import('../src/techs.js?job-archive-cold-start');
  const r=await fresh.handleTech(new Request('https://unit.test/api/tech/jobs',{headers:{Authorization:'Bearer '+MECH}}),f.env,undefined,{verifyToken:async()=>({sub:'mech',email:'mechanic@unit.test',email_verified:true})});
  assert.equal(r.status,200);assert.match(r.headers.get('Cache-Control'),/no-store/);assert.equal((await r.json()).jobs.find(j=>j.id===f.ids[0]).archived,true);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM tech_job_archives').all(),archive);assert.deepEqual(snapshot(f),before);
  assert.equal((await f.call(ADMIN,'/api/tech/jobs?all=1')).jobs.find(j=>j.id===f.ids[0]).archived,false,'admin history is never hidden');
});
test('a database failure rolls back the whole archive transaction and exposes no internal error',async()=>{
  const f=await seed(),before=snapshot(f),batch=f.env.DB.batch;
  f.env.DB.batch=list=>batch([...list,f.env.DB.prepare('INSERT INTO missing_archive_fixture VALUES (1)')]);
  const log=console.error;let r;try{console.error=()=>{};r=await update(f,f.ids.slice(0,2))}finally{console.error=log}
  assert.equal(r.status,500);assert.doesNotMatch(r.error,/SQL|missing_archive_fixture/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_job_archives').get().n,0);assert.deepEqual(snapshot(f),before);
});
