/* หลักฐานการซ่อม · งานค้าง · ลูกค้าไม่ตอบ · ผลงานบนหน้าร้าน · แจ้งร้านน่าสงสัย · งบในประกาศ · สูตรซ่อมในแชต */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER,ADMIN,proveShots,proofVision,frame} from './tech-fixtures.mjs';
import {withMechanic,MECH,post} from './tech-safety.test.mjs';
import {partMatch,capOf,proofLevel,proofPlan,fixesBlock,symptomWords} from '../src/proof.js';
import {verifiedFixes} from '../src/techs.js';
import {buildFeatureRequest,cleanFeatureJson} from '../src/features-ai.mjs';
import {exportAccount,deleteAccount} from '../src/account-data.js';

const OTHER='other|other@unit.test';
const quote=(over={})=>({action:'quote',labor:800,parts:2400,travel:0,partsNote:'ผ้าเบรก Bendix DB1234 GCT',scope:'เปลี่ยนผ้าเบรกหน้าทั้งสองข้าง',appointment:'พรุ่งนี้ 9 โมง',warranty:30,...over});
async function job(f,{q={},data={},car='Honda City 2019'}={}){
  const tid=await withMechanic(f,data),id=crypto.randomUUID();
  assert.equal((await f.call(USER,'/api/tech/jobs',{id,techId:tid,car,symptom:'เบรกมีเสียงดังเวลาเหยียบ',area:'บางนา',address:'99/1 ซอยทดสอบ บางนา',phone:'0812345678',requestedTime:'พรุ่งนี้',mode:'mobile'})).status,200);
  const rev=async who=>(await f.call(who,'/api/tech/jobs/'+id)).job.revision;
  const r=await f.call(MECH,'/api/tech/jobs/'+id,{...quote(q),revision:await rev(MECH)});assert.equal(r.status,200,JSON.stringify(r));
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id,{action:'accept',revision:await rev(USER),consent:true})).status,200);
  const code=(await f.call(USER,'/api/tech/jobs/'+id)).job.startCode;
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'start',revision:await rev(MECH),code})).status,200);
  return {id,tid,rev};
}
const done=async(f,id,rev)=>f.call(MECH,'/api/tech/jobs/'+id,{action:'done',revision:await rev(MECH),note:'เปลี่ยนผ้าเบรกหน้าแล้ว ทดลองขับเบรกเงียบ'});

test('quotes with parts must say which parts; used parts are recorded honestly',async()=>{
  const f=fixture(),tid=await withMechanic(f),id=crypto.randomUUID();
  await f.call(USER,'/api/tech/jobs',{id,techId:tid,car:'Honda City 2019',symptom:'เบรกมีเสียงดังเวลาเหยียบ',area:'บางนา',address:'99/1 ซอยทดสอบ',phone:'0812345678',requestedTime:'พรุ่งนี้',mode:'mobile'});
  const rev=(await f.call(MECH,'/api/tech/jobs/'+id)).job.revision;
  const bad=await f.call(MECH,'/api/tech/jobs/'+id,{...quote({partsNote:''}),revision:rev});assert.equal(bad.status,400);assert.match(bad.error,/อะไหล่ที่ใช้/);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{...quote({partsUsed:true}),revision:rev})).status,200);
  const q=(await f.call(USER,'/api/tech/jobs/'+id)).job.quote;assert.equal(q.partsNote,'ผ้าเบรก Bendix DB1234 GCT');assert.equal(q.partsUsed,true);
  /* ไม่มีค่าอะไหล่ = ไม่ต้องกรอก */
  const r=await f.call(MECH,'/api/tech/jobs/'+id,{...quote({parts:0,partsNote:''}),revision:rev+1});assert.equal(r.status,200);
});

test('parts jobs cannot be finished without the three guided clips; AI checks each shot, one retake when unclear',async()=>{
  const seen=proofVision((step,n)=>step==='new'&&n===2?{result:'unclear',part:'',note:'มืดเกินไป เปิดไฟฉาย'}:{result:'pass',part:step==='new'?'BENDIX DB1234 GCT':'',note:'เห็นชัด'});
  const f=fixture(),{id,rev}=await job(f);
  const no=await done(f,id,rev);assert.equal(no.status,400);assert.match(no.error,/ครบ 3 ช็อต/);
  /* เฉพาะช่างในใบงาน · เฉพาะช็อตของงานนี้ · ต้องเป็นวิดีโอที่อัปโหลดเอง */
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id+'/proof',{shot:'old',media:'m_xxxxxxxxxxxx',frames:[frame()]})).status,403);
  const mid='m_'+'a'.repeat(16);await f.put(MECH,mid,new Uint8Array([1,2,3]),'video/mp4');
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id+'/proof',{shot:'before',media:mid,frames:[frame()]})).status,400,'parts jobs use old/new/fit');
  const img='m_'+'b'.repeat(16);await f.put(MECH,img,new Uint8Array([1,2,3]),'image/png');
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id+'/proof',{shot:'old',media:img,frames:[frame()]})).status,400,'a photo is not a clip');
  const theirs='m_'+'c'.repeat(16);await f.put(USER,theirs,new Uint8Array([1,2,3]),'video/mp4');
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id+'/proof',{shot:'old',media:theirs,frames:[frame()]})).status,400,'someone else\'s clip');
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id+'/proof',{shot:'old',media:mid,frames:[]})).status,400,'needs still frames for the check');
  /* คลิปที่อัปโหลดก่อนเริ่มงาน ใช้ไม่ได้ */
  const old='m_'+'d'.repeat(16);await f.put(MECH,old,new Uint8Array([1,2,3]),'video/mp4');f.sqlite.prepare('UPDATE media SET created_at=? WHERE id=?').run(Date.now()-3*3600000,old);
  assert.match((await f.call(MECH,'/api/tech/jobs/'+id+'/proof',{shot:'old',media:old,frames:[frame(3)]})).error,/ก่อนเริ่มงาน/);
  const [a,b,c]=await proveShots(f,MECH,id);
  assert.equal(a.result,'pass');assert.equal(b.result,'unclear');assert.equal(b.retake,true);assert.equal(c.result,'pass');
  /* อัดใหม่ 1 ครั้ง → ผ่าน · ช็อตที่ผ่านแล้วอัดซ้ำไม่ได้ */
  const re='m_'+'e'.repeat(16);await f.put(MECH,re,new Uint8Array([9,9,9]),'video/mp4');
  const again=await f.call(MECH,'/api/tech/jobs/'+id+'/proof',{shot:'new',media:re,frames:[frame(77)]});assert.equal(again.result,'pass');assert.equal(again.tries,2);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id+'/proof',{shot:'old',media:re,frames:[frame(78)]})).status,409);
  assert.deepEqual(seen.steps,['old','new','fit','new']);
  assert.equal((await done(f,id,rev)).status,200);
  const j=(await f.call(USER,'/api/tech/jobs/'+id)).job;
  assert.equal(j.proof.level,'verified');assert.equal(j.proof.partMatch,'match');assert.equal(j.proof.shots.length,3);
  /* ลูกค้าเปิดคลิปได้ · คนนอกเปิดไม่ได้ · คลิปเก่าที่ถูกแทนไม่โผล่ */
  const clip=j.proof.shots.find(x=>x.shot==='new').media;assert.equal(clip,re);
  const get=async(tok,mid)=>(await f.env.DB.prepare('SELECT scope FROM media WHERE id=?').bind(mid).first()).scope;
  assert.equal(await get(USER,b.media),'proofx:'+id,'replaced clip is retired');
  const {handleTech}=await import('../src/techs.js');
  const open=async(tok,path)=>(await handleTech(new Request('https://unit.test'+path,{headers:tok?{Authorization:'Bearer '+tok}:{}}),f.env,undefined,{verifyToken:async t=>{const [uid,email]=t.split('|');return {sub:uid,email,email_verified:true};}})).status;
  assert.equal(await open(USER,'/api/tech/media/'+clip),200);
  assert.equal(await open(OTHER,'/api/tech/media/'+clip),404);
});

test('when AI cannot tell, the job still finishes but is labelled unclear, never verified',async()=>{
  proofVision(()=>({result:'unclear',part:'',note:'เบลอ'}));
  const f=fixture(),{id,rev}=await job(f);
  for(const shot of ['old','new','fit']){
    for(const n of [1,2]){const mid='m_'+shot+n+'x'.repeat(12);await f.put(MECH,mid,new Uint8Array([n]),'video/mp4');
      const r=await f.call(MECH,'/api/tech/jobs/'+id+'/proof',{shot,media:mid,frames:[frame(n*10+shot.length)]});assert.equal(r.retake,n===1);}
    const mid='m_'+shot+'3'+'x'.repeat(12);await f.put(MECH,mid,new Uint8Array([3]),'video/mp4');
    assert.equal((await f.call(MECH,'/api/tech/jobs/'+id+'/proof',{shot,media:mid,frames:[frame(99)]})).status,409,'only one retake');
  }
  assert.equal((await done(f,id,rev)).status,200);
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id)).job.proof.level,'unclear');
});

test('the same frames reused from another job are flagged; AI outage never blocks the mechanic',async()=>{
  proofVision(()=>{throw Error('AI down');});
  const f=fixture(),{id}=await job(f);
  const mid='m_'+'f'.repeat(16);await f.put(MECH,mid,new Uint8Array([1]),'video/mp4');
  const r=await f.call(MECH,'/api/tech/jobs/'+id+'/proof',{shot:'old',media:mid,frames:[frame(5)]});assert.equal(r.status,200);assert.equal(r.result,'unchecked');
  f.sqlite.prepare("UPDATE tech_proofs SET job_id='another-job' WHERE job_id=?").run(id);
  const mid2='m_'+'g'.repeat(16);await f.put(MECH,mid2,new Uint8Array([2]),'video/mp4');
  const dup=await f.call(MECH,'/api/tech/jobs/'+id+'/proof',{shot:'old',media:mid2,frames:[frame(5)]});assert.equal(dup.result,'unclear');assert.match(dup.note,/ซ้ำ/);
});

test('jobs without parts can finish without clips; before/after clips earn the same proof label',async()=>{
  proofVision(()=>({result:'pass',part:'',note:'ok'}));
  const f=fixture(),{id,rev}=await job(f,{q:{parts:0,partsNote:''}});
  const j0=(await f.call(MECH,'/api/tech/jobs/'+id)).job;assert.equal(j0.proof.need,false);assert.deepEqual(j0.proof.plan,['before','after']);
  await proveShots(f,MECH,id,['before','after']);
  assert.equal((await done(f,id,rev)).status,200);
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id)).job.proof.level,'verified');
});

test('open-job cap: a mobile mechanic holds one unfinished job, a shop three (or what staff set); full shops are flagged',async()=>{
  const f=fixture(),{id,rev,tid}=await job(f);
  const second=crypto.randomUUID();
  await f.call(USER,'/api/tech/jobs',{id:second,techId:tid,car:'Toyota Yaris 2020',symptom:'แอร์ไม่เย็นตอนรถติด',area:'บางนา',address:'1 ถนนทดสอบ',phone:'0812345678',requestedTime:'พรุ่งนี้',mode:'mobile'});
  const r2=(await f.call(MECH,'/api/tech/jobs/'+second)).job.revision;
  const full=await f.call(MECH,'/api/tech/jobs/'+second,{...quote({parts:0,partsNote:''}),revision:r2});assert.equal(full.status,409);assert.match(full.error,/งานค้างเต็มแล้ว \(1\/1 งาน\)/);
  assert.equal((await f.call('','/api/tech')).techs[0].full,true);
  assert.equal((await f.call(MECH,'/api/tech/me')).technician.capacity.cap,1);
  /* ทีมงานตั้งช่องซ่อมจริง */
  assert.equal((await f.call(MECH,'/api/tech/bays',{id:tid,bays:4})).status,403);
  assert.equal((await f.call(ADMIN,'/api/tech/bays',{id:tid,bays:4})).status,200);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+second,{...quote({parts:0,partsNote:''}),revision:r2})).status,200);
  assert.equal(capOf({mobile:true}),1);assert.equal(capOf({mobile:true,address:'12 ถนน'}),3);assert.equal(capOf({bays:6}),6);
});

test('customer silence: after 24h the mechanic flags it, the slot frees, staff decide; repeat silence limits the customer',async()=>{
  proofVision(()=>({result:'pass',part:'DB1234',note:'ok'}));
  const f=fixture(),{id,rev}=await job(f);
  await proveShots(f,MECH,id);assert.equal((await done(f,id,rev)).status,200);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'noreply',revision:await rev(MECH)})).status,409,'too early');
  const h=JSON.parse(f.sqlite.prepare('SELECT history FROM tech_jobs WHERE id=?').get(id).history);h.at(-1).at-=25*3600000;
  f.sqlite.prepare('UPDATE tech_jobs SET history=? WHERE id=?').run(JSON.stringify(h),id);
  assert.ok((await f.call(MECH,'/api/tech/jobs/'+id)).job.noreplyFrom<Date.now());
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id,{action:'noreply',revision:await rev(USER)})).status,403);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'noreply',revision:await rev(MECH)})).status,200);
  let j=(await f.call(USER,'/api/tech/jobs/'+id)).job;assert.equal(j.status,'disputed');assert.ok(j.noreplyAt);
  assert.equal((await f.call(MECH,'/api/tech/me')).technician.capacity.open,0,'slot freed');
  /* ลูกค้ากลับมากดยืนยันเองได้ */
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id,{action:'complete',revision:await rev(USER)})).status,200);
  /* ทีมงานปิดงานที่ลูกค้าเงียบจริง 3 ครั้ง → ลูกค้าเรียกช่างใหม่ไม่ได้ชั่วคราว */
  for(let i=0;i<3;i++)f.sqlite.prepare('INSERT INTO cust_strikes (uid,job_id,at) VALUES (?,?,?)').run('applicant','j'+i,Date.now());
  const blocked=await f.call(USER,'/api/tech/posts',post());assert.equal(blocked.status,403);assert.match(blocked.error,/ถูกจำกัดการเรียกช่าง/);
});

test('staff resolving a silent-customer job records a strike; a real dispute still needs staff',async()=>{
  proofVision(()=>({result:'pass',part:'',note:'ok'}));
  const f=fixture(),{id,rev}=await job(f);
  await proveShots(f,MECH,id);await done(f,id,rev);
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id,{action:'dispute',revision:await rev(USER),note:'ผ้าเบรกยังมีเสียงดังเหมือนเดิม'})).status,200);
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id,{action:'complete',revision:await rev(USER)})).status,409,'a real dispute is closed by staff');
  const f2=fixture(),b=await job(f2);
  await proveShots(f2,MECH,b.id);await done(f2,b.id,b.rev);
  const h=JSON.parse(f2.sqlite.prepare('SELECT history FROM tech_jobs WHERE id=?').get(b.id).history);h.at(-1).at-=25*3600000;f2.sqlite.prepare('UPDATE tech_jobs SET history=? WHERE id=?').run(JSON.stringify(h),b.id);
  await f2.call(MECH,'/api/tech/jobs/'+b.id,{action:'noreply',revision:await b.rev(MECH)});
  assert.equal((await f2.call(ADMIN,'/api/tech/jobs/'+b.id,{action:'resolve',revision:await b.rev(ADMIN),note:'ตรวจคลิปแล้ว งานเรียบร้อย ลูกค้าไม่ตอบ',outcome:'completed'})).status,200);
  assert.equal(f2.sqlite.prepare('SELECT COUNT(*) AS n FROM cust_strikes WHERE uid=?').get('applicant').n,1);
});

test('portfolio: the mechanic asks per clip, the owner decides and can withdraw; only approved clips are public',async()=>{
  proofVision(()=>({result:'pass',part:'',note:'ok'}));
  const f=fixture(),{id,rev,tid}=await job(f);
  const [old]=await proveShots(f,MECH,id);await done(f,id,rev);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'showcase_ask',media:old.media})).status,409,'only after the customer confirms');
  await f.call(USER,'/api/tech/jobs/'+id,{action:'complete',revision:await rev(USER)});
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id,{action:'showcase_ask',media:old.media})).status,403);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'showcase_ask',media:old.media})).status,200);
  assert.equal((await f.call(MECH,'/api/tech/jobs/'+id,{action:'showcase_ok',media:old.media})).status,403,'the mechanic cannot approve');
  assert.equal((await f.call('','/api/tech/showcase?tech='+tid)).items.length,0,'not public until the owner agrees');
  const {handleTech}=await import('../src/techs.js');
  const pub=async mid=>(await handleTech(new Request('https://unit.test/api/tech/showcase/media/'+mid),f.env,undefined,{})).status;
  assert.equal(await pub(old.media),404);
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id,{action:'showcase_ok',media:old.media})).status,200);
  const items=(await f.call('','/api/tech/showcase?tech='+tid)).items;assert.equal(items.length,1);assert.equal(items[0].car,'Honda City 2019');
  assert.ok(!JSON.stringify(items).includes('0812345678')&&!JSON.stringify(items).includes('99/1'));
  assert.equal(await pub(old.media),200);
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id,{action:'showcase_no',media:old.media})).status,200,'withdraw anytime');
  assert.equal(await pub(old.media),404);
  assert.equal((await f.call(USER,'/api/tech/jobs/'+id)).job.proof.shots.find(x=>x.media===old.media).showcase,'no');
});

test('passport: proof level and clips travel with the shared link only; mechanics get counted for proven work',async()=>{
  proofVision(()=>({result:'pass',part:'',note:'ok'}));
  const f=fixture(),{id,rev,tid}=await job(f,{q:{partsUsed:true}});
  const [old]=await proveShots(f,MECH,id);await done(f,id,rev);
  await f.call(USER,'/api/tech/jobs/'+id,{action:'complete',revision:await rev(USER)});
  const pp=await f.call(USER,'/api/tech/passport',{carKey:'car-1',car:{make:'Honda',model:'City',year:2019},jobs:[id]});
  const v=(await f.call('','/api/tech/passport/'+pp.token)).passport.verified[0];
  assert.equal(v.proof.level,'verified');assert.equal(v.proof.clips.length,3);assert.deepEqual(v.parts,{note:'ผ้าเบรก Bendix DB1234 GCT',used:true});
  const {handleTech}=await import('../src/techs.js');
  const get=async(token,mid)=>(await handleTech(new Request(`https://unit.test/api/tech/passport/${token}/media/${mid}`),f.env,undefined,{})).status;
  assert.equal(await get(pp.token,old.media),200);
  assert.equal(await get('x'.repeat(30),old.media),404);
  await f.call(USER,'/api/tech/passport/revoke',{carKey:'car-1'});
  assert.equal(await get(pp.token,old.media),404,'revoked link stops serving clips');
  const t=(await f.call('','/api/tech')).techs.find(x=>x.id===tid);assert.equal(t.proven,1);
});

test('reports go to staff without naming the reporter; repeated false reports are limited',async()=>{
  const f=fixture(),tid=await withMechanic(f);
  assert.equal((await f.call(MECH,'/api/tech/report',{techId:tid,reason:'ร้านนี้ใช้คลิปของร้านอื่นมาอ้าง'})).status,400,'not your own shop');
  assert.equal((await f.call(USER,'/api/tech/report',{techId:tid,reason:'สั้น'})).status,400);
  assert.equal((await f.call(USER,'/api/tech/report',{techId:tid,reason:'คลิปหลักฐานดูเหมือนถ่ายจากรถคันอื่น'})).status,200);
  assert.equal((await f.call(USER,'/api/tech/report',{techId:tid,reason:'แจ้งซ้ำเรื่องเดิมอีกรอบหนึ่ง'})).status,409);
  assert.equal((await f.call(USER,'/api/tech/reports')).status,403);
  const list=(await f.call(ADMIN,'/api/tech/reports')).reports;assert.equal(list.length,1);assert.equal(list[0].shop,'อู่ทดสอบ');
  assert.ok(!('uid' in list[0]));
  assert.equal((await f.call(ADMIN,'/api/tech/reports/decide',{id:list[0].id,outcome:'rejected',note:'ตรวจแล้วคลิปถูกต้อง'})).status,200);
  for(let i=0;i<2;i++)f.sqlite.prepare("INSERT INTO tech_reports (uid,tech_id,reason,status,at,decided_at) VALUES ('applicant',?,'x','rejected',?,?)").run(tid,Date.now(),Date.now());
  assert.equal((await f.call(USER,'/api/tech/report',{techId:tid,reason:'ลองแจ้งอีกครั้งหลังถูกปฏิเสธ'})).status,429);
});

test('posts carry an optional budget and a used-parts preference that mechanics see before quoting',async()=>{
  const f=fixture();await withMechanic(f);
  assert.equal((await f.call(USER,'/api/tech/posts',post({budget:50}))).status,400,'too small to be a real budget');
  const p=post({budget:1500,usedOk:true});assert.equal((await f.call(USER,'/api/tech/posts',p)).status,200);
  const n=(await f.call(MECH,'/api/tech/posts/near')).posts[0];assert.equal(n.budget,1500);assert.equal(n.usedOk,true);
  const q=post();await f.call(USER,'/api/tech/posts',q);assert.equal((await f.call(USER,'/api/tech/posts/'+q.id)).post.budget,null);
});

test('chat AI hears about proven fixes for the same model and symptom — anonymised',async()=>{
  proofVision(()=>({result:'pass',part:'',note:'ok'}));
  const f=fixture(),{id,rev}=await job(f);
  await proveShots(f,MECH,id);await done(f,id,rev);await f.call(USER,'/api/tech/jobs/'+id,{action:'complete',revision:await rev(USER)});
  const block=await verifiedFixes(f.env,{make:'Honda',model:'City'},'เบรกมีเสียงดังครับ');
  assert.match(block,/งานซ่อมจริงใน Cendon/);assert.match(block,/ผ้าเบรก Bendix DB1234/);assert.match(block,/รหัส t_mech/);
  for(const secret of ['99/1','0812345678','บางนา'])assert.ok(!block.includes(secret),'leaked '+secret);
  assert.equal(await verifiedFixes(f.env,{make:'Honda',model:'City'},'ราคารถมือสองเท่าไหร่'),'','not a symptom question');
  assert.equal(await verifiedFixes(f.env,{make:'Toyota',model:'Vios'},'เบรกมีเสียง'),'','other model');
  assert.equal(fixesBlock([], 'x'),'');assert.deepEqual(symptomWords('แอร์ไม่เย็น เบรกดัง'),['แอร์','เบรก']);
});

test('proof rules: part numbers, levels and plans',()=>{
  assert.equal(partMatch('ผ้าเบรก Bendix DB1234','BENDIX DB1234 GCT'),'match');
  assert.equal(partMatch('ผ้าเบรก Bendix DB1234','TRW GDB3456'),'differ');
  assert.equal(partMatch('ผ้าเบรกหน้า','TRW GDB3456'),'unknown','no part number written in the quote');
  assert.equal(partMatch('DB1234','BENDIX'),'unknown','label without a number');
  const plan=proofPlan({parts:100},[]);assert.equal(plan.need,true);
  assert.equal(proofPlan({parts:0},[{status:'accepted',parts:500}]).need,true,'accepted add-on parts count');
  assert.equal(proofPlan({parts:0},[{status:'declined',parts:500}]).need,false);
  assert.equal(proofLevel(plan,[{shot:'old',result:'pass'},{shot:'new',result:'pass'}]),'none');
  assert.equal(proofLevel(plan,['old','new','fit'].map(shot=>({shot,result:shot==='fit'?'unchecked':'pass'}))),'unclear');
});

test('AI helpers: budget realism and plain-language summaries stay structured and honest',()=>{
  assert.throws(()=>buildFeatureRequest({tool:'budget',context:{symptom:'เบรกดัง'}}),/budget/);
  assert.throws(()=>buildFeatureRequest({tool:'plain',context:{}}),/quote/);
  assert.equal(buildFeatureRequest({tool:'plain',context:{quote:{scope:'เปลี่ยนผ้าเบรก'}}}).json,true);
  assert.deepEqual(cleanFeatureJson('budget',{verdict:'ok',range:{min:3000,max:1000},note:'x'}).verdict,'unknown','broken range → unknown');
  const pl=cleanFeatureJson('plain',{what:'ผ้าเบรกหมด',fix:'เปลี่ยนผ้าเบรก',terms:[{term:'จานเบรก',plain:'แผ่นเหล็กที่ผ้าเบรกจับ'},{term:'',plain:'x'}],ask:['รับประกันกี่เดือน']});
  assert.equal(pl.terms.length,1);assert.equal(pl.time,'');
});

test('PDPA: proof rows export to the owner; the mechanic\'s export has no customer location; deletion withdraws portfolio consent',async()=>{
  proofVision(()=>({result:'pass',part:'',note:'ok'}));
  const f=fixture(),{id,rev}=await job(f);
  const [old]=await proveShots(f,MECH,id);f.sqlite.prepare('UPDATE tech_proofs SET lat=13.7,lng=100.5 WHERE job_id=?').run(id);
  await done(f,id,rev);await f.call(USER,'/api/tech/jobs/'+id,{action:'complete',revision:await rev(USER)});
  await f.call(MECH,'/api/tech/jobs/'+id,{action:'showcase_ask',media:old.media});await f.call(USER,'/api/tech/jobs/'+id,{action:'showcase_ok',media:old.media});
  const mine=await exportAccount(f.env,'applicant');assert.equal(mine.data.tech_proofs.length,3);assert.equal(mine.data.tech_proofs[0].lat,13.7);
  const shop=await exportAccount(f.env,'mech');assert.equal(shop.data.tech_proofs_as_mechanic.length,3);assert.equal(shop.data.tech_proofs_as_mechanic[0].lat,undefined);
  await deleteAccount(f.env,'applicant');
  assert.equal(f.sqlite.prepare('SELECT status FROM tech_showcase WHERE media_id=?').get(old.media).status,'no');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM tech_proofs WHERE lat IS NOT NULL').get().n,0);
});
