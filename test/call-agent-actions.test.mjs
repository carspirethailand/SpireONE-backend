import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {AGENT_SCHEMA,agentAction,AGENT_CAPABILITIES,expireAgentActions} from '../src/call-agent-actions.mjs';
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec(AGENT_SCHEMA+`;CREATE TABLE cars(id,uid,make,model,year,mileage,body,color,created_at,vin);CREATE TABLE tech_jobs(id,customer_uid,status,symptom,tech_id,updated_at);CREATE TABLE tech_threads(id,customer_uid,tech_id,updated_at);CREATE TABLE tech_messages(id,job_id,role,text,at,deleted_at);`);
 const DB={prepare(query){let args=[];return{bind(...a){args=a;return this},async first(){return sql.prepare(query).get(...args)||null},async all(){return{results:sql.prepare(query).all(...args)}},async run(){return sql.prepare(query).run(...args)}}}};
 const me={uid:'customer-A',staff:true,admin:true},shops={shop1:{id:'shop1',uid:'tech1',verified:true,shop:'Real approved test shop'}};let sent=0,rejectSend=false;
 const deps={now:1000,getTech:async id=>shops[id]||null,limit:async()=>{},send:async(body,actor)=>{sent++;assert.equal(actor.staff,false);assert.equal(actor.admin,false);if(rejectSend)throw Error('network unknown');return{thread:{id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'},message:{id:71}}}};
 const run=(b,options={})=>agentAction({DB},me,b,{...deps,...options});
 return{sql,DB,me,shops,run,deps,get sent(){return sent},set rejectSend(v){rejectSend=v}};
}
const draft=f=>f.run({action:'prepare_mechanic_message',args:{shop_id:'shop1',message:'ขอสอบถามคิวตรวจแอร์ครับ'}});
test('tool allowlist cannot execute URLs, SQL, admin actions or select another owner even for staff',async()=>{
 const f=fixture();for(const action of ['fetch','eval','delete_car','admin','send_mechanic_message','confirm'])await assert.rejects(f.run({action}),e=>e.status===403);
 for(const k of ['uid','role','admin','url','sql','endpoint'])await assert.rejects(f.run({action:'get_my_garage',[k]:'other'}),e=>e.status===403);
 assert.equal(AGENT_CAPABILITIES.length,5);assert.equal(f.sent,0);
});
test('customer projections bind actor UID and never return VIN, another customer car/request/thread or staff view',async()=>{
 const f=fixture();for(const uid of ['customer-A','customer-B']){f.sql.prepare('INSERT INTO cars VALUES(?,?,?,?,?,?,?,?,?,?)').run(uid,uid,'Make','Model',2020,100,'sedan','#fff',1,'PRIVATE VIN');f.sql.prepare('INSERT INTO tech_jobs VALUES(?,?,?,?,?,?)').run(uid,uid,'requested','Symptom','shop1',1);f.sql.prepare('INSERT INTO tech_threads VALUES(?,?,?,?)').run(uid,uid,'shop1',1)}
 for(const action of ['get_my_garage','get_my_requests','get_my_conversations']){const r=await f.run({action});assert.ok(!JSON.stringify(r).includes('customer-B'));assert.ok(!JSON.stringify(r).includes('PRIVATE VIN'));}
});
test('reading a conversation checks exact customer membership before messages; admin does not bypass',async()=>{
 const f=fixture(),tid='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';f.sql.prepare('INSERT INTO tech_threads VALUES(?,?,?,?)').run(tid,'customer-B','shop1',1);f.sql.prepare('INSERT INTO tech_messages VALUES(?,?,?,?,?,?)').run(1,tid,'customer','PRIVATE MESSAGE',1,null);
 await assert.rejects(f.run({action:'read_my_conversation',args:{thread_id:tid}}),e=>e.status===404);
 f.sql.prepare('UPDATE tech_threads SET customer_uid = ?').run('customer-A');assert.equal((await f.run({action:'read_my_conversation',args:{thread_id:tid}})).messages.length,1);
});
test('draft has a UI confirmation secret and exact preview, but never sends on prepare or model-supplied true',async()=>{
 const f=fixture(),d=await draft(f);assert.equal(d.status,'pending_confirmation');assert.match(d.confirmToken,/^[a-f0-9]{64}$/);assert.equal(d.preview.shopId,'shop1');assert.equal(f.sent,0);
 const row=f.sql.prepare('SELECT * FROM tech_agent_actions').get();assert.notEqual(row.secret_hash,d.confirmToken);
 await assert.rejects(f.run({id:d.id,confirmed:true},{mode:'confirm'}),e=>e.status===403);
 await assert.rejects(f.run({id:d.id,confirmToken:'0'.repeat(64)},{mode:'confirm'}),e=>e.status===403);assert.equal(f.sent,0);
});
test('confirmation requires the same owner, nonexpired draft and a still-approved real recipient',async()=>{
 const f=fixture(),d=await draft(f),b={id:d.id,confirmToken:d.confirmToken};f.me.uid='other';await assert.rejects(f.run(b,{mode:'confirm'}),e=>e.status===404);f.me.uid='customer-A';
 await assert.rejects(f.run(b,{mode:'confirm',now:601000}),e=>e.status===410);
 f.shops.shop1.suspended=true;await assert.rejects(f.run(b,{mode:'confirm'}),e=>e.status===409);assert.equal(f.sent,0);
});
test('parallel or retried confirmations cannot send twice; actual receipt is returned and draft text is removed',async()=>{
 const f=fixture(),d=await draft(f),b={id:d.id,confirmToken:d.confirmToken};const r=await Promise.all([f.run(b,{mode:'confirm'}),f.run(b,{mode:'confirm'})]);assert.equal(f.sent,1);assert.ok(r.some(x=>x.status==='sent'));
 const again=await f.run(b,{mode:'confirm'});assert.equal(again.messageId,71);assert.equal(again.duplicate,true);assert.equal(f.sent,1);assert.equal(f.sql.prepare('SELECT text FROM tech_agent_actions').get().text,'');
});
test('unknown delivery is quarantined without blind resend; cancelled drafts cannot send',async()=>{
 const f=fixture(),d=await draft(f),b={id:d.id,confirmToken:d.confirmToken};f.rejectSend=true;assert.equal((await f.run(b,{mode:'confirm'})).status,'delivery_uncertain');assert.equal((await f.run(b,{mode:'confirm'})).resendAllowed,false);assert.equal(f.sent,1);
 const g=fixture(),v=await draft(g),q={id:v.id,confirmToken:v.confirmToken};await g.run(q,{mode:'cancel'});assert.equal((await g.run(q,{mode:'confirm'})).status,'cancelled');assert.equal(g.sent,0);
});
test('unverified, suspended, demo or own shops cannot be contacted through agent',async()=>{
 const f=fixture();for(const patch of [{verified:false},{suspended:true},{test:true},{uid:'customer-A'}]){f.shops.shop1={id:'shop1',uid:'tech1',verified:true,...patch};await assert.rejects(draft(f),e=>e.status===404)}assert.equal(f.sent,0);
});
test('a cancellation racing confirmation never promises cancelled while a send is claimed',async()=>{
 const f=fixture(),d=await draft(f),b={id:d.id,confirmToken:d.confirmToken};const [cancelled]=await Promise.all([f.run(b,{mode:'cancel'}),f.run(b,{mode:'confirm'})]);if(cancelled.status==='cancelled')assert.equal(f.sent,0);else assert.equal(cancelled.resendAllowed,false);
});
test('expiry clears draft/uncertain text and retention removes only old receipts',async()=>{
 const f=fixture(),d=await draft(f);await expireAgentActions({DB:f.DB},602000);const row=f.sql.prepare('SELECT * FROM tech_agent_actions WHERE id = ?').get(d.id);assert.equal(row.state,'expired');assert.equal(row.text,'');await expireAgentActions({DB:f.DB},8*86400000);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM tech_agent_actions').get().n,0);
});
