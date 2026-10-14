import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {fixture} from './tech-fixtures.mjs';
import worker from '../src/worker.js';
import {notify} from '../src/line-notify.js';

/* เชื่อม LINE ให้ติดจริง: ปุ่มในแอปเปิดห้องของ OA ที่ token นี้เป็นเจ้าของเสมอ · เชื่อมแล้วต้องเป็นเพื่อนถึงจะรับแจ้งเตือนได้
   บล็อกแล้วกลับมาเพิ่มเพื่อน ใช้ต่อได้ไม่ต้องขอรหัสใหม่ · ส่งไม่ผ่านต้องบอกหน้าแอดมิน · LINE ในเทสต์เป็นของปลอมทั้งหมด */
const USER='dev:somchai:somchai@unit.test',OWNER='dev:boss:boss@unit.test';
function setup({env={},line={}}={}){
  const f=fixture({DEV_AUTH:'1',FIREBASE_PROJECT_ID:'unit-test',LINE_CHANNEL_TOKEN:'test-only-token',LINE_CHANNEL_SECRET:'test-only-secret',LINE_OA_ID:'@oldoa',APP_URL:'https://app.unit.test',...env});
  f.sqlite.exec(`ALTER TABLE users ADD COLUMN name TEXT;
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT); INSERT INTO config VALUES ('schema_version','999');
    CREATE TABLE line_link (line_uid TEXT PRIMARY KEY, uid TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'th', active INTEGER NOT NULL DEFAULT 1, linked_at INTEGER NOT NULL);
    CREATE TABLE line_code (code TEXT PRIMARY KEY, uid TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE line_chat (line_uid TEXT PRIMARY KEY, history TEXT NOT NULL DEFAULT '[]', day TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE tech_limits (scope TEXT, uid TEXT, bucket INTEGER, n INTEGER NOT NULL, PRIMARY KEY(scope,uid,bucket));
    CREATE TABLE line_link_token (hash TEXT PRIMARY KEY, line_uid TEXT NOT NULL, name TEXT, picture TEXT, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE audit (t INTEGER, actor TEXT, action TEXT, target TEXT, detail TEXT);`);
  f.sqlite.prepare("INSERT INTO users (uid, role, banned, name) VALUES ('somchai','user',0,'สมชาย'),('suda','user',0,'สุดา')").run();
  const replies=[],pushes=[];
  globalThis.fetch=async(url,init={})=>{const u=String(url),m=init.method||'GET';
    if(u.endsWith('/v2/bot/info'))return Response.json({basicId:line.basicId||'@cendon01',premiumId:line.premiumId,displayName:'Cendon',chatMode:line.chatMode||'bot'});
    if(u.includes('/v2/bot/profile/'))return (line.friends||['Uline1']).includes(decodeURIComponent(u.split('/').pop()))?Response.json({displayName:'สมชาย LINE',pictureUrl:'https://profile.line-scdn.net/abc'}):Response.json({message:'Not found'},{status:404});
    if(u.endsWith('/message/reply')){replies.push(JSON.parse(init.body).messages);return Response.json({});}
    if(u.endsWith('/message/push')){pushes.push(JSON.parse(init.body));return line.push===429?Response.json({message:'You have reached your monthly limit.'},{status:429}):Response.json({});}
    if(u.endsWith('/message/quota'))return Response.json(line.quota||{type:'limited',value:300});
    if(u.endsWith('/message/quota/consumption'))return Response.json({totalUsage:line.used||12});
    if(u.endsWith('/channel/webhook/endpoint')&&m==='GET')return Response.json({endpoint:'https://api.unit.test/api/line/webhook',active:true});
    if(u.startsWith('https://api.line.me/'))return Response.json({});
    throw Error('unexpected fetch '+u);};
  const call=async(path,{method='GET',token=USER,body}={})=>{const waits=[];
    const r=await worker.fetch(new Request('https://api.unit.test'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),f.env,{waitUntil:p=>waits.push(p)});
    await Promise.all(waits);return {status:r.status,...await r.json()};};
  const event=async(ev,user='Uline1')=>{const n=replies.length,waits=[];
    const body=JSON.stringify({events:[{replyToken:'rt',source:{type:'user',userId:user},...ev}]});
    const r=await worker.fetch(new Request('https://api.unit.test/api/line/webhook',{method:'POST',headers:{'X-Line-Signature':createHmac('sha256','test-only-secret').update(body).digest('base64')},body}),f.env,{waitUntil:p=>waits.push(p)});
    assert.equal(r.status,200);await Promise.all(waits);return replies.slice(n).flat();};
  const say=(text,user)=>event({type:'message',message:{type:'text',id:'1',text}},user);
  const words=ms=>ms.map(m=>m.type==='flex'?m.altText+' '+JSON.stringify(m.contents):m.text).join(' ');
  return {f,call,event,say,words,pushes};
}

test('connect button opens the OA that the token really belongs to, not a stale LINE_OA_ID',async()=>{
  const {call}=setup();
  const s=await call('/api/line/link');assert.equal(s.status,200);assert.equal(s.oa,'@cendon01');assert.equal(s.linked,false);
  assert.equal((await call('/api/line/code',{method:'POST'})).oa,'@cendon01');
  assert.equal((await setup({env:{LINE_CHANNEL_TOKEN:'another-test-token'},line:{premiumId:'cendon'}}).call('/api/line/link')).oa,'@cendon','a premium ID is preferred; a new token is asked again');
  assert.equal((await setup({env:{LINE_CHANNEL_TOKEN:''}}).call('/api/line/link')).oa,'','no LINE set up → the app hides the button');
});

test('linking from a LINE account that is not a friend yet: told to add the friend; adding it turns notifications on by itself',async()=>{
  const {call,say,event,words}=setup({line:{friends:[]}});
  const {code}=await call('/api/line/code',{method:'POST'});
  const r=words(await say('รหัสเชื่อมบัญชี '+code));
  assert.match(r,/เพิ่ม Cendon เป็นเพื่อน/);assert.match(r,/line\.me\/R\/ti\/p\/%40cendon01/);
  let s=await call('/api/line/link');assert.equal(s.linked,false);assert.equal(s.paused,true,'linked but LINE cannot deliver yet');
  assert.match(words(await event({type:'follow'})),/เชื่อมเสร็จสมบูรณ์/);
  s=await call('/api/line/link');assert.equal(s.linked,true);assert.equal(s.paused,false);
});

test('block then unblock keeps the link; disconnecting in the app is final',async()=>{
  const {f,call,say,event}=setup();
  const {code}=await call('/api/line/code',{method:'POST'});await say(code);
  assert.equal((await call('/api/line/link')).linked,true);
  await event({type:'unfollow'});
  assert.deepEqual({...(await call('/api/line/link'))}.paused,true,'blocked → paused, not forgotten');
  assert.equal(await notify(f.env,'somchai',{type:'text',text:'x'}),false,'nothing is pushed to someone who blocked us');
  await event({type:'follow'});assert.equal((await call('/api/line/link')).linked,true,'back without a new code');
  assert.equal((await call('/api/line/link',{method:'DELETE'})).ok,true);
  await event({type:'follow'});assert.equal((await call('/api/line/link')).linked,false,'an explicit disconnect does not come back on its own');
});

test('admin check shows linked people, monthly message quota and the last failed notification',async()=>{
  const {f,call,say}=setup({line:{push:429,used:300,quota:{type:'limited',value:300}}});
  const {code}=await call('/api/line/code',{method:'POST'});await say(code);
  assert.equal(await notify(f.env,'somchai',{type:'text',text:'งานใหม่'}),false);
  const r=await call('/api/admin/line/status',{token:OWNER});
  assert.equal(r.status,200);assert.deepEqual(r.notes.linked,{on:1,paused:0});assert.deepEqual(r.quota,{limit:300,used:300});
  assert.ok(r.problems.some(p=>/หมดโควตา/.test(p)));assert.ok(r.problems.some(p=>/ส่งแจ้งเตือนครั้งล่าสุดไม่สำเร็จ.*โควตา/.test(p)));
  assert.ok(r.problems.some(p=>/LINE_OA_ID.*@oldoa/.test(p)),'a stale LINE_OA_ID is pointed out');
});

test('admin check: an OA left in human chat mode is called out',async()=>{
  const r=await setup({line:{chatMode:'chat'}}).call('/api/admin/line/status',{token:OWNER});
  assert.ok(r.problems.some(p=>/โหมดแชต/.test(p)));
});

/* ── เชื่อมบัญชีโดยเริ่มจากในแชต LINE: กดเมนู → บอทส่งลิงก์ → ล็อกอินแล้วกดเชื่อมต่อ → push แจ้งสำเร็จ ── */
const linkFrom=ms=>{const m=JSON.stringify(ms).match(/https:\/\/app\.unit\.test\/line\?t=([A-Za-z0-9_-]+)&openExternalBrowser=1/);return m&&m[1];};
test('menu "เชื่อมต่อบัญชี" → one-time link → log in and connect → linked, and a success message is pushed to that LINE',async()=>{
  const {f,call,say,words,pushes}=setup();
  const reply=await say('เชื่อมต่อบัญชี');const t=linkFrom(reply);
  assert.ok(t&&t.length>=40,'the bot replies with a link carrying a long random token');assert.match(words(reply),/15 นาที/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM line_link_token WHERE hash = ?').get(t).n,0,'only a hash of the token is stored');
  assert.equal((await call('/api/line/connect?t='+t,{token:''})).status,401,'must be signed in to Cendon');
  const info=await call('/api/line/connect?t='+t);
  assert.deepEqual({state:info.state,name:info.name,linked:info.linked},{state:'ok',name:'สมชาย LINE',linked:false},'the page shows which LINE account will be linked');
  const r=await call('/api/line/connect',{method:'POST',body:{t}});
  assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.paused,false);
  assert.deepEqual({...f.sqlite.prepare("SELECT uid, active FROM line_link WHERE line_uid='Uline1'").get()},{uid:'somchai',active:1});
  assert.equal(pushes.length,1);assert.equal(pushes[0].to,'Uline1');assert.match(JSON.stringify(pushes[0].messages),/เชื่อมบัญชีสำเร็จ/);
  assert.equal((await call('/api/line/link')).linked,true);
  const again=await call('/api/line/connect',{method:'POST',body:{t}});assert.equal(again.status,410);assert.equal(again.state,'used');assert.match(again.error,/ถูกใช้ไปแล้ว/);
});
test('connect links: expire after 15 minutes, a newer link replaces the older one, nonsense tokens are refused',async()=>{
  const {f,call,say}=setup();
  const old=linkFrom(await say('เชื่อมบัญชี')),t=linkFrom(await say('เชื่อมต่อบัญชี'));
  assert.equal((await call('/api/line/connect?t='+old)).state,'notfound','asking again cancels the previous link');
  f.sqlite.prepare('UPDATE line_link_token SET expires_at = ?').run(Date.now()-1);
  const r=await call('/api/line/connect',{method:'POST',body:{t}});assert.equal(r.status,410);assert.match(r.error,/หมดอายุ/);
  assert.equal((await call('/api/line/connect',{method:'POST',body:{t:'x'}})).status,410);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM line_link').get().n,0);
});
test('connect from a LINE that is not a friend: linked but paused, no push; already-linked LINE gets a "switch account" link that moves it',async()=>{
  let {f,call,say,pushes}=setup({line:{friends:[]}});
  let r=await call('/api/line/connect',{method:'POST',body:{t:linkFrom(await say('เชื่อมต่อบัญชี'))}});
  assert.equal(r.paused,true);assert.equal(pushes.length,0);assert.equal((await call('/api/line/link')).paused,true);
  ({f,call,say,pushes}=setup());
  await call('/api/line/connect',{method:'POST',body:{t:linkFrom(await say('เชื่อมต่อบัญชี'))}});
  const sw=await say('เชื่อมต่อบัญชี');assert.match(JSON.stringify(sw),/เปลี่ยนบัญชี/);assert.match(JSON.stringify(sw),/สมชาย/);
  r=await call('/api/line/connect',{method:'POST',token:'dev:suda:suda@unit.test',body:{t:linkFrom(sw)}});
  assert.equal(r.status,200);assert.equal(f.sqlite.prepare("SELECT uid FROM line_link WHERE line_uid='Uline1'").get().uid,'suda');
  assert.match(JSON.stringify(pushes.at(-1).messages),/ย้ายการแจ้งเตือนจากบัญชีเดิม/);
  assert.equal((await call('/api/line/link')).linked,false,'the first account no longer gets this LINE');
});
