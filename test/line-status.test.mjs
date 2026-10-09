import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {fixture} from './tech-fixtures.mjs';
import worker from '../src/worker.js';

/* หน้าแอดมินตรวจการเชื่อม LINE: บอกได้ว่าบอทเงียบเพราะอะไร และตั้ง Webhook ให้ได้ในกดเดียว */
const OWNER='dev:boss:boss@unit.test';
function setup(env={},line={}){
  const f=fixture({DEV_AUTH:'1',FIREBASE_PROJECT_ID:'unit-test',LINE_OA_ID:'@988omovg',...env});
  f.sqlite.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT); INSERT INTO config VALUES ('schema_version','999');
    CREATE TABLE line_link (line_uid TEXT PRIMARY KEY, uid TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'th', active INTEGER NOT NULL DEFAULT 1, linked_at INTEGER NOT NULL);
    CREATE TABLE line_chat (line_uid TEXT PRIMARY KEY, history TEXT NOT NULL DEFAULT '[]', day TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);`);
  const seen=[];
  globalThis.fetch=async(url,init={})=>{const u=String(url),m=init.method||'GET';seen.push({u,m,body:init.body});
    if(u.endsWith('/v2/bot/info'))return line.info===401?Response.json({message:'Authentication failed'},{status:401}):Response.json({basicId:line.basicId||'@988omovg',displayName:'Cendon',chatMode:'bot'});
    if(u.endsWith('/channel/webhook/endpoint')&&m==='GET')return Response.json({endpoint:line.endpoint||'',active:!!line.active});
    if(u.endsWith('/channel/webhook/endpoint')&&m==='PUT')return Response.json({});
    if(u.endsWith('/channel/webhook/test'))return Response.json(line.test||{success:true,statusCode:200,reason:'OK'});
    if(u.endsWith('/message/reply'))return line.reply===400?Response.json({message:'Invalid reply token'},{status:400}):Response.json({});
    if(u.startsWith('https://api.line.me/'))return Response.json({});
    throw Error('unexpected fetch '+u);};
  const call=async(path,{method='GET',body,headers={},token=OWNER}={})=>{const waits=[];
    const r=await worker.fetch(new Request('https://api.unit.test'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...headers},body}),f.env,{waitUntil:p=>waits.push(p)});
    await Promise.all(waits);return {status:r.status,...await r.json()};};
  const hook=(text,secret='test-only-secret')=>{const body=JSON.stringify({events:[{type:'message',replyToken:'rt',source:{userId:'U1'},message:{type:'text',text}}]});
    return call('/api/line/webhook',{method:'POST',body,token:'',headers:{'X-Line-Signature':createHmac('sha256',secret).update(body).digest('base64')}});};
  return {f,call,hook,seen};
}
const SECRETS={LINE_CHANNEL_SECRET:'test-only-secret',LINE_CHANNEL_TOKEN:'test-only-token'};

test('LINE status: says plainly which secret is missing',async()=>{
  const r=await setup().call('/api/admin/line/status');
  assert.equal(r.status,200);assert.equal(r.secret,false);assert.equal(r.token,false);
  assert.ok(r.problems.some(p=>/LINE_CHANNEL_SECRET/.test(p)));assert.ok(r.problems.some(p=>/LINE_CHANNEL_TOKEN/.test(p)));
  assert.equal((await setup().call('/api/admin/line/status',{token:'dev:u1:u1@unit.test'})).status,403,'staff only');
});

test('LINE status: a rejected token, a wrong OA name, and an unset or switched-off webhook are each called out',async()=>{
  let r=await setup(SECRETS,{info:401}).call('/api/admin/line/status');
  assert.ok(r.problems.some(p=>/ไม่รับ LINE_CHANNEL_TOKEN/.test(p)));
  r=await setup(SECRETS,{basicId:'@other'}).call('/api/admin/line/status');
  assert.equal(r.bot.basicId,'@other');assert.ok(r.problems.some(p=>/ไม่ตรงกับบัญชีจริง/.test(p)));
  assert.ok(r.problems.some(p=>/Webhook URL/.test(p)));assert.ok(r.problems.some(p=>/Use webhook/.test(p)));
  r=await setup(SECRETS,{endpoint:'https://api.unit.test/api/line/webhook',active:true}).call('/api/admin/line/status');
  assert.deepEqual(r.problems,[],'all good');
});

test('LINE status: one press points the webhook at this backend and has LINE test it',async()=>{
  const {call,seen}=setup(SECRETS);
  const r=await call('/api/admin/line/webhook',{method:'POST',body:'{}'});
  assert.equal(r.ok,true);assert.equal(r.endpoint,'https://api.unit.test/api/line/webhook');
  assert.deepEqual(JSON.parse(seen.find(s=>s.m==='PUT').body),{endpoint:'https://api.unit.test/api/line/webhook'});
  const bad=await setup(SECRETS,{test:{success:false,statusCode:401,reason:'Unauthorized'}}).call('/api/admin/line/webhook',{method:'POST',body:'{}'});
  assert.equal(bad.ok,false);assert.match(bad.why,/LINE_CHANNEL_SECRET ไม่ตรง/);
});

test('LINE status: a wrong secret and a failed reply are remembered and shown',async()=>{
  const {call,hook}=setup(SECRETS,{endpoint:'https://api.unit.test/api/line/webhook',active:true,reply:400});
  assert.equal((await hook('สวัสดี','wrong-secret')).status,401);
  let r=await call('/api/admin/line/status');
  assert.ok(r.problems.some(p=>/ลายเซ็นไม่ผ่าน/.test(p)),JSON.stringify(r.problems));
  await new Promise(res=>setTimeout(res,5));
  assert.equal((await hook('หยุด')).status,200);
  r=await call('/api/admin/line/status');
  assert.ok(r.notes.event,'the last message from LINE is recorded');
  assert.ok(!r.problems.some(p=>/ลายเซ็นไม่ผ่าน/.test(p)),'a newer good message clears the signature warning');
  assert.ok(r.problems.some(p=>/ตอบกลับไม่สำเร็จ.*400.*Invalid reply token/.test(p)),JSON.stringify(r.problems));
});
