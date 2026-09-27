import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {marketplace} from '../src/techs-api.mjs';

function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0014_marketplace.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){let values=[];return {bind(...v){values=v;return this},async first(){return sqlite.prepare(sql).get(...values)||null},async all(){return {results:sqlite.prepare(sql).all(...values)}},async run(){const r=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(r.changes)}}}}},async batch(statements){sqlite.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());sqlite.exec('COMMIT');return result}catch(e){sqlite.exec('ROLLBACK');throw e}}};
  const call=async(actor,path,body)=>{
    const req=new Request('https://local.test'+path,{method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});
    const res=await marketplace(req,{DB},async()=>{if(!actor)throw Object.assign(new Error('login'),{status:401});return actor});
    return {...await res.json(),status:res.status};
  };
  return {call,sqlite};
}
const admin={uid:'admin',admin:true,name:'Test admin'},tech={uid:'tech',admin:false,name:'Test tech'},customer={uid:'customer',admin:false,name:'Test customer'},stranger={uid:'stranger',admin:false};
const app={name:'Test applicant',shop:'Test only',phone:'0800000000',area:'Test district',age:25,years:3,from:400,warranty:7,radius:20,about:'Test application with sufficient detail about tools and repairs.',experience:'Test reference for professional experience',cats:['eng'],portfolio:['https://example.org/one','https://example.org/two','https://example.org/three'],mobile:true,consent:true};
const checks={identity:true,phone:true,portfolio:true,skills:true,equipment:true,terms:true};
async function approved(f){assert.equal((await f.call(tech,'/api/tech/apply',app)).status,201);const a=(await f.call(admin,'/api/tech/applications')).applications[0];assert.equal((await f.call(admin,'/api/tech/review',{uid:a.uid,revision:a.revision,decision:'approve',checks,note:'All six checks verified in this unit test.'})).status,200);return (await f.call(null,'/api/tech')).techs[0];}
const request=(t)=>({id:crypto.randomUUID(),techId:t.id,car:'Test car',symptom:'Engine makes a test-only noise',area:'Test district',address:'Test address (not a real appointment)',requestedTime:'Tomorrow afternoon',phone:'0900000000',mode:'mobile'});

test('public directory has no seed data; signed-in checks cannot be bypassed',async()=>{
  const f=fixture();assert.deepEqual((await f.call(null,'/api/tech')).techs,[]);
  assert.equal((await f.call(null,'/api/tech/me')).status,401);
  assert.equal((await f.call(tech,'/api/tech/apply',{name:'Fake bypass',test:true})).status,403);
  assert.equal((await f.call(tech,'/api/tech/apply',{...app,portfolio:[]})).status,400);
  assert.equal((await f.call(tech,'/api/tech/applications')).status,403);
  f.sqlite.close();
});
test('approval requires all checks, creates a real profile without fabricated reviews, excludes private contact',async()=>{
  const f=fixture();await f.call(tech,'/api/tech/apply',app);
  const a=(await f.call(admin,'/api/tech/applications')).applications[0];
  assert.equal((await f.call(admin,'/api/tech/review',{uid:a.uid,revision:0,decision:'approve',checks:{},note:'Attempt incomplete checks'})).status,400);
  assert.equal((await f.call(admin,'/api/tech/review',{uid:a.uid,revision:0,decision:'approve',checks,note:'All evidence reviewed'})).status,200);
  assert.equal((await f.call(admin,'/api/tech/review',{uid:a.uid,revision:0,decision:'approve',checks,note:'Second approval attempt'})).status,409);
  const t=(await f.call(null,'/api/tech')).techs[0];assert.equal(t.rating,0);assert.equal(t.jobs,0);assert.equal(t.phone,undefined);assert.equal(t.portfolio,undefined);
  assert.equal((await f.call(admin,'/api/tech/applications')).applications.length,0);f.sqlite.close();
});
test('admin can create with name only; test profiles and jobs stay out of public marketplace',async()=>{
  const f=fixture();assert.equal((await f.call(admin,'/api/tech/apply',{name:'Test admin',test:true,mobile:true})).status,201);
  assert.equal((await f.call(null,'/api/tech')).techs.length,0);
  assert.equal((await f.call(customer,'/api/tech?test=1')).status,403);
  const t=(await f.call(admin,'/api/tech?test=1')).techs[0];
  assert.equal((await f.call(customer,'/api/tech/jobs',request(t))).status,404);
  assert.equal((await f.call(admin,'/api/tech/jobs',request(t))).status,201);f.sqlite.close();
});
test('full quote → accepted → travelling → working → done → completed → review with ownership and revision guards',async()=>{
  const f=fixture(),t=await approved(f),r=request(t);
  assert.equal((await f.call(customer,'/api/tech/jobs',r)).status,201);
  assert.equal((await f.call(customer,'/api/tech/jobs',r)).status,200);
  assert.equal((await f.call(customer,'/api/tech/jobs')).jobs.length,1);
  const path='/api/tech/jobs/'+r.id;
  assert.equal((await f.call(stranger,path)).status,404);
  assert.equal((await f.call(tech,path)).job.customerPhone,undefined);
  assert.equal((await f.call(tech,path)).job.address,undefined);
  assert.equal((await f.call(customer,path)).job.technicianPhone,undefined);
  let revision=0;
  const mutate=(actor,action,extra={})=>f.call(actor,path,{revision,action,...extra});
  assert.equal((await mutate(customer,'quote',{labor:100,parts:0,travel:0})).status,409);
  assert.equal((await mutate(customer,'message',{message:'โทร ๐๘๐ ๐๐๐ ๐๐๐๐'})).status,400);
  let result=await mutate(tech,'quote',{labor:400,parts:500,travel:100,scope:'Replace the test part only',appointment:'Tomorrow afternoon',warranty:7});
  assert.equal(result.status,200);assert.equal(result.job.quote.total,1000);revision++;
  assert.equal((await f.call(customer,path,{action:'accept',revision:0,consent:true})).status,409);
  assert.equal((await mutate(customer,'accept',{consent:false})).status,400);
  assert.equal((await mutate(customer,'accept',{consent:true})).status,200);revision++;
  assert.equal((await f.call(tech,path)).job.customerPhone,'0900000000');
  assert.equal((await f.call(customer,path)).job.technicianPhone,'0800000000');
  assert.equal((await mutate(customer,'start')).status,409);
  for(const action of ['enroute','start','done']){result=await mutate(tech,action,{note:'Replaced part and verified operation.'});assert.equal(result.status,200);revision++;}
  assert.equal((await mutate(tech,'complete')).status,409);
  assert.equal((await mutate(customer,'complete')).status,200);revision++;
  assert.equal((await mutate(customer,'review',{rating:5,note:'Finished the agreed work.'})).status,200);revision++;
  assert.equal((await mutate(customer,'review',{rating:1,note:'Duplicate review attempt'})).status,409);
  const profile=(await f.call(null,'/api/tech')).techs[0];assert.equal(profile.rating,5);assert.equal(profile.jobs,1);assert.equal(profile.reviewCount,1);
  assert.equal((await mutate(customer,'dispute',{note:'New issue with the repaired part'})).status,200);revision++;
  assert.equal((await mutate(customer,'resolve',{note:'Cannot resolve own dispute',outcome:'completed'})).status,403);
  assert.equal((await mutate(admin,'resolve',{note:'Reviewed evidence from both parties',outcome:'completed'})).status,200);
  f.sqlite.close();
});
test('suspended technicians are hidden and cannot receive new bookings',async()=>{
  const f=fixture(),t=await approved(f);
  assert.equal((await f.call(customer,'/api/tech/moderate',{id:t.id,suspend:true})).status,403);
  assert.equal((await f.call(admin,'/api/tech/moderate',{id:t.id,suspend:true})).status,200);
  assert.equal((await f.call(null,'/api/tech')).techs.length,0);
  assert.equal((await f.call(customer,'/api/tech/jobs',request(t))).status,404);f.sqlite.close();
});
