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
    CREATE TABLE tech_limits (scope TEXT, uid TEXT, bucket INTEGER, n INTEGER NOT NULL, PRIMARY KEY(scope,uid,bucket));`);
  f.sqlite.prepare("INSERT INTO users (uid, role, banned, name) VALUES ('somchai','user',0,'สมชาย')").run();
  const replies=[],pushes=[];
  globalThis.fetch=async(url,init={})=>{const u=String(url),m=init.method||'GET';
    if(u.endsWith('/v2/bot/info'))return Response.json({basicId:line.basicId||'@cendon01',premiumId:line.premiumId,displayName:'Cendon',chatMode:line.chatMode||'bot'});
    if(u.includes('/v2/bot/profile/'))return (line.friends||['Uline1']).includes(decodeURIComponent(u.split('/').pop()))?Response.json({displayName:'x'}):Response.json({message:'Not found'},{status:404});
    if(u.endsWith('/message/reply')){replies.push(JSON.parse(init.body).messages);return Response.json({});}
    if(u.endsWith('/message/push')){pushes.push(JSON.parse(init.body));return line.push===429?Response.json({message:'You have reached your monthly limit.'},{status:429}):Response.json({});}
    if(u.endsWith('/message/quota'))return Response.json(line.quota||{type:'limited',value:300});
    if(u.endsWith('/message/quota/consumption'))return Response.json({totalUsage:line.used||12});
    if(u.endsWith('/channel/webhook/endpoint')&&m==='GET')return Response.json({endpoint:'https://api.unit.test/api/line/webhook',active:true});
    if(u.startsWith('https://api.line.me/'))return Response.json({});
    throw Error('unexpected fetch '+u);};
  const call=async(path,{method='GET',token=USER}={})=>{const waits=[];
    const r=await worker.fetch(new Request('https://api.unit.test'+path,{method,headers:token?{Authorization:'Bearer '+token}:{}}),f.env,{waitUntil:p=>waits.push(p)});
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
