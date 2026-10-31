import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER} from './tech-fixtures.mjs';
import {handleTech} from '../src/techs.js';
import {connectStudio,studioAuthRequest,publishStudioChanges,StudioLiveHub} from '../src/studio-live.mjs';
const req=(headers={},url='https://fixture.test/api/tech/events')=>new Request(url,{headers:{Upgrade:'websocket',Origin:'https://app.test','Sec-WebSocket-Protocol':'cendon-studio.v1, auth.synthetic-token',...headers}});
const post=(over={})=>({id:crypto.randomUUID(),lat:13.76,lng:100.51,cat:'eng',car:'Toyota Vios 2018',symptom:'งานด่วน: สตาร์ทไม่ติด',area:'บางนา',address:'ริมถนนบางนา กม.3',phone:'0812345678',requestedTime:'ด่วน ตอนนี้',mode:'mobile',urgent:true,...over});
const job=(over={})=>({...post(),techId:'t_near',...over});
async function setup(){const f=fixture(),events=[],pending=[];await f.call('','/api/tech/ping');
 for(const [id,uid,lat,test,suspended] of [['t_near','near',13.75,0,0],['t_far','far',18,0,0],['t_trial','trial',13.75,1,0],['t_paused','paused',13.75,0,1]])f.sqlite.prepare('INSERT INTO tech_profiles(id,uid,data,verified,test,suspended,created_at,updated_at) VALUES (?,?,?,1,?,?,1,1)').run(id,uid,JSON.stringify({name:'Synthetic mechanic',shop:'Test only',lat,lng:100.5,radius:30,cats:['eng'],mobile:true}),test,suspended);
 f.env.STUDIO_LIVE={getByName:name=>({invalidate:async topics=>events.push({name,topics})})};
 const call=async(token,path,body)=>{const r=await handleTech(new Request('https://fixture.test'+path,{method:body?'POST':'GET',headers:token?{Authorization:'Bearer '+token}:{},body:body?JSON.stringify(body):undefined}),f.env,undefined,{ctx:{waitUntil:p=>pending.push(p)},verifyToken:async t=>{const [sub,email]=t.split('|');return {sub,email,email_verified:true}}});const data=await r.json();await Promise.all(pending.splice(0));return {...data,status:r.status}};
 return {...f,events,call};}
test('live auth: origin and protocol validated, identity derived by server, credential never forwarded to DO',async()=>{
 let seen;const env={APP_URL:'https://app.test',ALLOWED_ORIGINS:'*',STUDIO_LIVE:{getByName:name=>({fetch:r=>{seen={name,headers:[...r.headers],url:r.url};return new Response('synthetic')}})}};
 assert.equal((await connectStudio(req({Origin:'https://evil.test'}),env,()=>{throw Error('must not authenticate')})).status,403);
 for(const protocol of ['', 'auth.x', 'cendon-studio.v1, auth.x, auth.y'])assert.equal((await connectStudio(req({'Sec-WebSocket-Protocol':protocol}),env,()=>({uid:'alice'}))).status,401);
 assert.equal(studioAuthRequest(req()).headers.get('Authorization'),'Bearer synthetic-token');
 const r=await connectStudio(req({},'https://fixture.test/api/tech/events?uid=victim'),env,()=>({uid:'alice'}));assert.equal(r.status,200);assert.equal(seen.name,'user:alice');assert.doesNotMatch(JSON.stringify(seen),/synthetic-token|victim/);assert.deepEqual(Object.fromEntries(seen.headers)['sec-websocket-protocol'],'cendon-studio.v1');
 assert.equal((await connectStudio(new Request('https://fixture.test/api/tech/events'),env,()=>null)).status,426);
 assert.equal((await connectStudio(req(),{APP_URL:'https://app.test'},()=>({uid:'alice'}))).status,503);
});
test('urgent post wakes only eligible recipients plus its owner; failed writes send nothing; test posts stay separated',async()=>{
 const f=await setup(),p=post();assert.equal((await f.call(USER,'/api/tech/posts',p)).status,200);
 assert.deepEqual(f.events.map(x=>x.name).sort(),['user:applicant','user:near','user:trial']);
 assert.doesNotMatch(JSON.stringify(f.events),/0812345678|Toyota|บางนา/);f.events.length=0;
 assert.equal((await f.call('outsider|outsider@unit.test','/api/tech/posts/'+p.id+'/close',{})).status,404);assert.equal(f.events.length,0);
 assert.equal((await f.call('boss|boss@unit.test','/api/tech/posts',post({test:true}))).status,200);
 assert.deepEqual(f.events.map(x=>x.name).sort(),['user:boss','user:trial']);
});
test('direct job and quote wake both parties, not unrelated shops; old roaming endpoint remains available',async()=>{
 const f=await setup(),b=job();assert.equal((await f.call(USER,'/api/tech/jobs',b)).status,200);assert.deepEqual(f.events.map(x=>x.name).sort(),['user:applicant','user:near']);f.events.length=0;
 const r=await f.call('near|near@unit.test','/api/tech/jobs/'+b.id,{action:'quote',revision:1,labor:500,parts:0,travel:0,scope:'ตรวจระบบสตาร์ทและซ่อมสายไฟ',appointment:'วันนี้ช่วงบ่าย',warranty:7});assert.equal(r.status,200,r.error);assert.deepEqual(f.events.map(x=>x.name).sort(),['user:applicant','user:near']);
 const roaming=await f.call('near|near@unit.test','/api/tech/live');assert.notEqual(roaming.status,426);assert.notEqual(roaming.status,500);
});
test('pulse uses one aggregate D1 query and an opaque token; own profile, post, archive and message changes invalidate',async()=>{
 const f=await setup();let aggregate=0;const real=f.env.DB.prepare.bind(f.env.DB);f.env.DB.prepare=sql=>{if(sql.startsWith('WITH shop'))aggregate++;return real(sql)};
 const pulse=()=>f.call('near|near@unit.test','/api/tech/pulse');const initial=await pulse();assert.match(initial.v,/^[a-f0-9]{64}$/);assert.equal(aggregate,1);assert.deepEqual(Object.keys(initial).sort(),['status','v']);
 f.sqlite.prepare('UPDATE tech_profiles SET online=1,updated_at=updated_at+1 WHERE uid=?').run('near');const changed=await pulse();assert.notEqual(changed.v,initial.v);
 const b=job();await f.call(USER,'/api/tech/jobs',b);const next=await pulse();assert.notEqual(next.v,changed.v);
 f.sqlite.prepare("INSERT INTO tech_messages(job_id,uid,role,text,at) VALUES (?,?,'customer',?,?)").run(b.id,'applicant','synthetic message',Date.now());const withMessage=await pulse();assert.notEqual(withMessage.v,next.v);
 f.sqlite.prepare('UPDATE tech_messages SET edited_at=? WHERE job_id=?').run(Date.now(),b.id);const edited=await pulse();assert.notEqual(edited.v,withMessage.v);
 f.sqlite.prepare('INSERT INTO tech_reads(job_id,uid,last) VALUES (?,?,1)').run(b.id,'near');const read=await pulse();assert.notEqual(read.v,edited.v);
 f.sqlite.prepare("INSERT INTO tech_job_archives(uid,job_id,generation,archived,job_revision,job_status,changed_at) VALUES (?,?,1,1,1,'cancelled',1)").run('near',b.id);assert.notEqual((await pulse()).v,read.v);
});
test('parallel retries create one job, daily and grouped quotas remain atomic',async()=>{
 const f=await setup(),same=job();const retries=await Promise.all(Array.from({length:4},()=>f.call(USER,'/api/tech/jobs',same)));assert.ok(retries.every(x=>x.status===200),JSON.stringify(retries));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_jobs').get().n,1);
 const group=crypto.randomUUID(),rs=await Promise.all(Array.from({length:9},()=>f.call(USER,'/api/tech/jobs',job({group}))));assert.equal(rs.filter(x=>x.status===200).length,5);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_jobs WHERE group_id=?').get(group).n,5);
 const more=await Promise.all(Array.from({length:8},()=>f.call(USER,'/api/tech/jobs',job())));assert.equal(more.filter(x=>x.status===200).length,4);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_jobs').get().n,10);
});
test('parallel post retries do not double-create; active post quota cannot be raced',async()=>{
 const f=await setup(),p=post();const same=await Promise.all(Array.from({length:3},()=>f.call(USER,'/api/tech/posts',p)));assert.ok(same.every(x=>x.status===200));
 const r=await Promise.all(Array.from({length:9},()=>f.call(USER,'/api/tech/posts',post())));assert.equal(r.filter(x=>x.status===200).length,2);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_posts').get().n,3);
});
test('a customer cannot select two shops concurrently in one quote group',async()=>{
 const f=await setup(),group=crypto.randomUUID(),ids=[crypto.randomUUID(),crypto.randomUUID()];
 // Move the second synthetic shop nearby; still two distinct verified owners.
 f.sqlite.prepare('UPDATE tech_profiles SET data=? WHERE id=?').run(JSON.stringify({name:'Second fixture',lat:13.75,lng:100.5,mobile:true,cats:['eng']}),'t_far');
 for(const [i,id] of ids.entries()){assert.equal((await f.call(USER,'/api/tech/jobs',job({id,group,techId:i?'t_far':'t_near'}))).status,200);const quote=await f.call(i?'far|far@unit.test':'near|near@unit.test','/api/tech/jobs/'+id,{action:'quote',revision:1,labor:500,parts:0,travel:0,scope:'ตรวจและแก้ระบบสตาร์ท',appointment:'วันนี้ช่วงบ่าย',warranty:7});assert.equal(quote.status,200,quote.error);}
 const r=await Promise.all(ids.map(id=>f.call(USER,'/api/tech/jobs/'+id,{action:'accept',revision:2,consent:true})));assert.equal(r.filter(x=>x.status===200).length,1,JSON.stringify(r));
 const rows=f.sqlite.prepare('SELECT status FROM tech_jobs WHERE group_id=?').all(group);assert.equal(rows.filter(x=>x.status==='accepted').length,1);assert.equal(rows.filter(x=>x.status==='cancelled').length,1);
});
test('reading a new message wakes own other devices once, never loops or notifies unrelated accounts',async()=>{
 const f=await setup(),b=job();await f.call(USER,'/api/tech/jobs',b);await f.call(USER,'/api/tech/jobs/'+b.id,{action:'message',text:'ขอสอบถามเวลาซ่อมครับ'});f.events.length=0;
 assert.equal((await f.call('near|near@unit.test','/api/tech/jobs/'+b.id)).status,200);assert.deepEqual(f.events.map(x=>x.name),['user:near']);f.events.length=0;
 await f.call('near|near@unit.test','/api/tech/jobs/'+b.id);assert.equal(f.events.length,0);
});
test('closing a post and quoting it concurrently cannot leave an active quote on a closed post',async()=>{
 const f=await setup(),p=post();await f.call(USER,'/api/tech/posts',p);
 const results=await Promise.all([f.call(USER,'/api/tech/posts/'+p.id+'/close',{}),f.call('near|near@unit.test','/api/tech/posts/'+p.id+'/offer',{labor:500,parts:0,travel:0,scope:'ตรวจและแก้ระบบสตาร์ท',appointment:'วันนี้ช่วงบ่าย',warranty:7})]);assert.ok(results.every(x=>[200,409].includes(x.status)),JSON.stringify(results));
 assert.equal(f.sqlite.prepare('SELECT status FROM tech_posts WHERE id=?').get(p.id).status,'closed');assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM tech_jobs WHERE group_id=? AND status!='cancelled'").get(p.id).n,0);
});
test('optional shop advice never places the provider credential in the URL',async()=>{
 const f=await setup();f.env.GEMINI_KEY='synthetic-not-a-real-key';let seen;
 const old=globalThis.fetch;try{globalThis.fetch=async(url,o)=>{seen={url,headers:o.headers};return Response.json({candidates:[]})};const r=await f.call('near|near@unit.test','/api/tech/advice');assert.equal(r.status,200);assert.ok(r.tips.length);assert.ok(!seen.url.includes(f.env.GEMINI_KEY));assert.equal(seen.headers['x-goog-api-key'],f.env.GEMINI_KEY);}finally{globalThis.fetch=old}
});
test('two Studio devices changing different settings preserve both values and unknown fields',async()=>{
 const f=await setup(),who='near|near@unit.test',data=JSON.parse(f.sqlite.prepare('SELECT data FROM tech_profiles WHERE uid=?').get('near').data);data.future={keep:true};f.sqlite.prepare('UPDATE tech_profiles SET data=? WHERE uid=?').run(JSON.stringify(data),'near');
 const r=await Promise.all([f.call(who,'/api/tech/shop',{hours:'09:00-18:00'}),f.call(who,'/api/tech/shop',{shop:'ร้านจำลองใหม่'})]);assert.ok(r.every(x=>x.status===200),JSON.stringify(r));const saved=JSON.parse(f.sqlite.prepare('SELECT data FROM tech_profiles WHERE uid=?').get('near').data);assert.equal(saved.hours,'09:00-18:00');assert.equal(saved.shop,'ร้านจำลองใหม่');assert.deepEqual(saved.future,{keep:true});
});
test('concurrent service creations respect quota without deleting old services; concurrent edits report conflict',async()=>{
 const f=await setup(),who='near|near@unit.test',gig=i=>({title:'ตรวจซ่อมเครื่องยนต์ '+i,price:500,cats:['eng'],brands:[]});
 const r=await Promise.all(Array.from({length:5},(_,i)=>f.call(who,'/api/tech/gig',gig(i))));assert.equal(r.filter(x=>x.status===200).length,2,JSON.stringify(r));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_gigs WHERE active=1').get().n,2);
 const id=f.sqlite.prepare('SELECT id FROM tech_gigs ORDER BY id LIMIT 1').get().id,edits=await Promise.all([f.call(who,'/api/tech/gig',{...gig('one'),id}),f.call(who,'/api/tech/gig',{...gig('two'),id})]);assert.equal(edits.filter(x=>x.status===200).length,1,JSON.stringify(edits));assert.equal(edits.filter(x=>x.status===409).length,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_gigs WHERE active=1').get().n,2);
});
test('frequent driving GPS updates do not trigger full Studio list/stat refreshes',async()=>{
 const f=await setup(),b=job();await f.call(USER,'/api/tech/jobs',b);f.sqlite.prepare("UPDATE tech_jobs SET status='enroute' WHERE id=?").run(b.id);f.events.length=0;
 const r=await f.call('near|near@unit.test','/api/tech/jobs/'+b.id+'/live',{lat:13.75,lng:100.5,acc:10});assert.equal(r.status,200,r.error);assert.equal(f.events.length,0,'map polling remains separate from job-change events');
});
test('publisher merges metadata only; delivery failure does not fail the persisted business mutation',async()=>{
 const seen=[];const env={STUDIO_LIVE:{getByName:name=>({invalidate:async topics=>seen.push({name,topics})})}};
 await publishStudioChanges(env,[['one',['jobs','unknown']],['one',['posts','jobs']],['two',['threads']]]);assert.equal(seen.length,2);assert.deepEqual(seen[0].topics,['jobs','posts']);
 const f=await setup();f.env.STUDIO_LIVE={getByName:()=>({invalidate:async()=>{throw Error('synthetic offline')}})};assert.equal((await f.call(USER,'/api/tech/posts',post())).status,200);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_posts').get().n,1);
});
test('hibernation attachment has only lease; invalidate drops expired sockets and never broadcasts arbitrary payload',()=>{
 const sent=[],closed=[];const socket={deserializeAttachment:()=>({until:Date.now()+10000}),send:m=>sent.push(JSON.parse(m)),close:(...a)=>closed.push(a)};
 const expired={...socket,deserializeAttachment:()=>({until:1})},hub=new StudioLiveHub({getWebSockets:()=>[socket,expired]});
 assert.deepEqual(hub.invalidate(['jobs','secret']),{sent:1});assert.equal(closed.length,1);assert.deepEqual(Object.keys(sent[0]).sort(),['at','revision','topics','type']);assert.deepEqual(sent[0].topics,['jobs']);
 hub.webSocketMessage(socket,'{"uid":"victim"}');assert.equal(closed.at(-1)[0],1008);
});
