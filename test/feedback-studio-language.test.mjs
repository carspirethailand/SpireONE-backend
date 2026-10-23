import {test} from 'node:test';
import assert from 'node:assert/strict';
import {languageRule,aiLocale} from '../src/ai-language.mjs';
import {jobActor,cancellationActor} from '../src/job-actor.mjs';
import {liveToken} from '../src/live-setup.mjs';
import {buildFeatureRequest} from '../src/features-ai.mjs';
import {fixture,USER} from './tech-fixtures.mjs';
test('chat and voice language policy supports all 12 settings and latest user language, not car brands',()=>{
  for(const lang of ['th','en','zh','ja','ko','id','vi','ms','de','fr','es','pt']){
    assert.equal(aiLocale(lang),lang);const rule=languageRule(lang);assert.match(rule,/latest substantive message/);assert.match(rule,/Do not infer a language from car brands/);
    const prompt=liveToken({model:'fixture',system:'legacy Thai-first prompt',lang}).bidiGenerateContentSetup.systemInstruction.parts[0].text;
    assert.ok(prompt.endsWith(languageRule(lang,{voice:true})));
    const feature=buildFeatureRequest({tool:'quote',lang,context:{car:{make:'Honda',model:'Civic'}},attachments:[{mime:'image/jpeg',b64:'aGVsbG8='}]});assert.ok(feature.system.endsWith(rule));
  }
  assert.equal(aiLocale('<script>'),'th');assert.ok(!languageRule('<script>').includes('<script>'));
});
test('actors cannot forge another side; a dual-role account must explicitly choose its operating side',()=>{
  assert.equal(jobActor({isTech:true,isCustomer:false},'either','customer'),'technician');
  assert.equal(jobActor({isTech:false,isCustomer:true},'either','technician'),'customer');
  for(const as of ['customer','technician'])assert.equal(jobActor({isTech:true,isCustomer:true},'either',as),as);
  assert.throws(()=>jobActor({isTech:true,isCustomer:true},'either'),/เลือก/);
  assert.equal(jobActor({staff:true},'admin'),'admin');
  for(const by of ['customer','technician','admin','system'])assert.equal(cancellationActor(JSON.stringify([{status:'cancelled',by} ])),by);
  assert.equal(cancellationActor('broken'),'unknown');assert.equal(cancellationActor([]),'unknown');
});
test('authenticated cancellation records the actual actor and exposes the same fact in list and details',async()=>{
  for(const side of ['customer','technician','both']){
    const f=fixture();await f.call('','/api/tech/ping');const stamp=Date.now(),owner=side==='both'?'applicant':'mechanic';
    f.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at) VALUES (?,?,?,?,1,0,0,?,?)').run('t_fix',owner,'0899999999',JSON.stringify({name:'ช่างทดสอบ',shop:'ร้านทดสอบ',cats:['eng']}),stamp,stamp);
    const id=crypto.randomUUID();f.sqlite.prepare('INSERT INTO tech_jobs (id,tech_id,customer_uid,status,car,symptom,area,address,phone,requested_time,mode,history,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'t_fix','applicant','requested','Fixture car','Fixture symptom','Fixture area','Fixture address','0812345678','Today','shop',JSON.stringify([{status:'requested',by:'customer',at:stamp}]),1,stamp,stamp);
    const token=side==='technician'?'mechanic|mechanic@unit.test':USER;
    if(side==='both')assert.equal((await f.call(token,'/api/tech/jobs/'+id,{action:'cancel',revision:1,note:'Fixture cancel reason'})).status,400);
    const expected=side==='customer'?'customer':'technician';assert.equal((await f.call(token,'/api/tech/jobs/'+id,{action:'cancel',revision:1,note:'Fixture cancel reason',as:side==='both'?'technician':side==='customer'?'technician':'customer'})).status,200);
    const detail=(await f.call(token,'/api/tech/jobs/'+id)).job;assert.equal(detail.cancelledBy,expected);assert.equal(detail.history.at(-1).by,expected);
    const jobs=(await f.call(token,'/api/tech/jobs')).jobs;assert.equal(jobs.find(j=>j.id===id).cancelledBy,expected);
  }
});
