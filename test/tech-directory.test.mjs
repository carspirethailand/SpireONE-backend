import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ADMIN,USER} from './tech-fixtures.mjs';
async function seed(){const f=fixture();await f.call('','/api/tech/ping');return f}
function shop(f,id,{test=0,verified=1,suspended=0}={}){
  f.sqlite.prepare('INSERT INTO tech_profiles(id,uid,phone,data,test,verified,suspended,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id,id,'',JSON.stringify({name:'Fixture',shop:id,cats:['air','eng']}),test,verified,suspended,100,100);
}
function gig(f,id,at=100,uid=id){f.sqlite.prepare("INSERT INTO tech_gigs(uid,tech_id,kind,title,price,cats,active,created_at,updated_at) VALUES (?,?,'package','บริการทดสอบ',800,'[\"air\",\"oil\"]',1,?,?)").run(uid,id,at,at)}
const rows=async(f,path,token='')=>(await f.call(token,path))[path.includes('gigs')?'gigs':'techs'];

test('shop and service publication use the same rule; trial, suspension and membership stay separate',async()=>{
  const f=await seed();
  for(let t=0;t<=1;t++)for(let v=0;v<=1;v++)for(let s=0;s<=1;s++){
    const id=`shop-${t}${v}${s}`;shop(f,id,{test:t,verified:v,suspended:s});gig(f,id);
    const me=await f.call(id+'|fixture@unit.test','/api/tech/me'),mine=await f.call(id+'|fixture@unit.test','/api/tech/gigs?mine=1');
    assert.equal(me.technician.id,id);assert.equal(mine.gigs.length,1);assert.equal(me.technician.listing.public,!t&&!!v&&!s);
    assert.deepEqual(me.technician.listing,mine.listing);
    assert.equal(mine.listing.blockers.includes('suspended'),!!s);assert.equal(mine.listing.blockers.includes('trial'),!!t);
  }
  for(const token of ['',USER,ADMIN]){
    const techs=await rows(f,'/api/tech',token),gigs=await rows(f,'/api/tech/gigs',token);
    assert.deepEqual(gigs.map(g=>g.tech.id).sort(),techs.map(t=>t.id).sort());
    assert.ok(techs.every(t=>!t.test||token===ADMIN));assert.equal(techs.length,token===ADMIN?3:1);
  }
});

test('hidden services and oversized legacy inventories cannot starve eligible shops before the feed limit',async()=>{
  const f=await seed();shop(f,'eligible');gig(f,'eligible',1);shop(f,'legacy');
  for(let i=0;i<650;i++)gig(f,'legacy',1000+i);
  for(let i=0;i<310;i++){const id='hidden-'+i;shop(f,id,{suspended:1});gig(f,id,9000+i)}
  const gigs=await rows(f,'/api/tech/gigs');assert.equal(gigs.length,3);
  assert.equal(gigs.filter(g=>g.tech.id==='legacy').length,2);assert.ok(gigs.some(g=>g.tech.id==='eligible'));
  const legacy=gigs.filter(g=>g.tech.id==='legacy');assert.ok(legacy[0].id>legacy[1].id,'stable newest-first ordering');
});

test('mismatched ownership, inactive and non-service records do not enter the public directory',async()=>{
  const f=await seed();shop(f,'eligible');gig(f,'eligible',1,'someone-else');gig(f,'missing',2);gig(f,'eligible',3);gig(f,'eligible',4);
  f.sqlite.prepare("UPDATE tech_gigs SET active=0 WHERE created_at=3").run();f.sqlite.prepare("UPDATE tech_gigs SET kind='work' WHERE created_at=4").run();
  assert.deepEqual(await rows(f,'/api/tech/gigs'),[]);
});

test('only an explicit owner decision makes an existing trial shop public; services and vetting are not fabricated',async()=>{
  const f=await seed();shop(f,'legacy',{test:1,verified:0,suspended:1});gig(f,'legacy');
  const before=f.sqlite.prepare('SELECT * FROM tech_gigs').all();assert.deepEqual(await rows(f,'/api/tech/gigs'),[]);
  assert.equal((await f.call(USER,'/api/tech/shop-mode',{id:'legacy',test:false})).status,403);
  assert.equal((await f.call(ADMIN,'/api/tech/shop-mode',{id:'legacy',test:false,note:'Fixture explicit owner certification'})).status,200);
  const [t]=await rows(f,'/api/tech'),[g]=await rows(f,'/api/tech/gigs');assert.equal(t.id,'legacy');assert.equal(g.tech.id,'legacy');assert.equal(t.vetting,null);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM tech_gigs').all(),before);
});

test('incomplete moderation requests cannot silently suspend; successful decisions and state changes are audited',async()=>{
  const f=await seed();shop(f,'eligible');
  for(const suspend of [undefined,null,1,'false'])assert.equal((await f.call(ADMIN,'/api/tech/moderate',{id:'eligible',suspend})).status,400);
  assert.equal(f.sqlite.prepare('SELECT suspended FROM tech_profiles').get().suspended,0);
  assert.equal((await f.call(ADMIN,'/api/tech/moderate',{id:'eligible',suspend:true})).status,200);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM tech_audit WHERE action='suspend'").get().n,1);
  const [event]=f.sqlite.prepare("SELECT actor,detail FROM tech_audit WHERE action='profile_state_change'").all();
  assert.equal(event.actor,'system:profile-state');assert.deepEqual(JSON.parse(event.detail),{from:{test:0,verified:1,suspended:0,identityHold:0},to:{test:0,verified:1,suspended:1,identityHold:0}});
  f.sqlite.prepare("UPDATE tech_profiles SET updated_at=999,data=json_set(data,'$.hours','09:00')").run();
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM tech_audit WHERE action='profile_state_change'").get().n,1,'ordinary UI edits do not invent moderation events');
});

test('test signup cannot downgrade, unsuspend, rename or recreate an existing shop or application',async()=>{
  const f=await seed();shop(f,'boss',{suspended:1});gig(f,'boss');
  f.sqlite.prepare("INSERT INTO tech_applications(uid,email,data,status,test,created_at,updated_at) VALUES ('boss','boss@unit.test','{}','approved',0,1,1)").run();
  const snapshot=()=>['tech_profiles','tech_applications','tech_gigs'].map(t=>f.sqlite.prepare('SELECT * FROM '+t).all()),before=snapshot();
  assert.equal((await f.call(ADMIN,'/api/tech/apply',{test:true,shop:'Replacement'})).status,409);assert.deepEqual(snapshot(),before);
});

test('moderation rolls back if its actor audit cannot be stored',async()=>{
  const f=await seed();shop(f,'eligible');
  f.sqlite.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON tech_audit WHEN NEW.action='suspend' BEGIN SELECT RAISE(ABORT,'fixture audit unavailable'); END");
  const r=await f.call(ADMIN,'/api/tech/moderate',{id:'eligible',suspend:true});assert.equal(r.status,500);
  assert.equal(f.sqlite.prepare('SELECT suspended FROM tech_profiles').get().suspended,0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM tech_audit WHERE action='profile_state_change'").get().n,0);
});
