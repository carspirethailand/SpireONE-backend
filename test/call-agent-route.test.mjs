import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER,ADMIN} from './tech-fixtures.mjs';
const MECH='mech|mech@unit.test';
async function setup(){const f=fixture();await f.call('','/api/tech/ping');const t=Date.now();f.sqlite.prepare('INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at) VALUES (?,?,?,?,1,0,0,?,?)').run('t_mech','mech','0899999999',JSON.stringify({name:'Test mechanic',shop:'TEST ONLY shop',cats:['air']}),t,t);return f;}
test('authenticated agent flow writes one real thread message through normal messaging and mechanic can read it',async()=>{
 const f=await setup();const draft=await f.call(USER,'/api/tech/agent',{action:'prepare_mechanic_message',args:{shop_id:'t_mech',message:'ขอสอบถามคิวตรวจแอร์ครับ'}});assert.equal(draft.status,200);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_messages').get().n,0);
 const consent={id:draft.id,confirmToken:draft.confirmToken};const r=await f.call(USER,'/api/tech/agent/confirm',consent);assert.equal(r.status,200);assert.ok(r.messageId);assert.ok(r.threadId);
 const room=await f.call(MECH,'/api/tech/threads/'+r.threadId);assert.equal(room.status,200);assert.equal(room.messages.length,1);assert.equal(room.messages[0].text,'ขอสอบถามคิวตรวจแอร์ครับ');
 await f.call(USER,'/api/tech/agent/confirm',consent);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_messages').get().n,1);
});
test('agent route denies unauthenticated, banned and cross-customer/admin reads and confirmations',async()=>{
 const f=await setup();assert.equal((await f.call('','/api/tech/agent',{action:'get_my_conversations'})).status,401);
 const d=await f.call(USER,'/api/tech/agent',{action:'prepare_mechanic_message',args:{shop_id:'t_mech',message:'Test draft'}});
 assert.equal((await f.call(ADMIN,'/api/tech/agent/confirm',{id:d.id,confirmToken:d.confirmToken})).status,404);
 assert.equal((await f.call(ADMIN,'/api/tech/agent',{action:'get_my_conversations',uid:'applicant'})).status,403);
 const sent=await f.call(USER,'/api/tech/agent/confirm',{id:d.id,confirmToken:d.confirmToken});
 assert.equal((await f.call(ADMIN,'/api/tech/agent',{action:'read_my_conversation',args:{thread_id:sent.threadId}})).status,404);
 f.sqlite.prepare("INSERT INTO users(uid,role,banned) VALUES('applicant','user',1)").run();assert.equal((await f.call(USER,'/api/tech/agent',{action:'get_my_conversations'})).status,403);
});
