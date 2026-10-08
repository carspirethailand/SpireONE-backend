import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {fixture} from './tech-fixtures.mjs';
import worker from '../src/worker.js';

/* เมนูในห้องแชต LINE + ข้อความทักทายของบอท (LINE ในเทสต์เป็นของปลอมทั้งหมด) */
const PNG=new Uint8Array([0x89,0x50,0x4e,0x47,1,2,3]);
function setup({failCreate=false}={}){
  const f=fixture({DEV_AUTH:'1',FIREBASE_PROJECT_ID:'unit-test',LINE_CHANNEL_TOKEN:'test-only-token',LINE_CHANNEL_SECRET:'test-only-secret',APP_URL:'https://app.unit.test'});
  f.sqlite.exec("CREATE TABLE IF NOT EXISTS line_link (line_uid TEXT PRIMARY KEY, uid TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'th', active INTEGER NOT NULL DEFAULT 1, linked_at INTEGER NOT NULL)");
  const seen=[];
  globalThis.fetch=async(url,init={})=>{const u=String(url),m=init.method||'GET';seen.push({u,m,init});
    if(u==='https://app.unit.test/img/line-richmenu.png')return new Response(PNG,{headers:{'Content-Type':'image/png'}});
    if(u==='https://api.line.me/v2/bot/richmenu/list')return Response.json({richmenus:[{richMenuId:'old1',name:'cendon-main'},{richMenuId:'mine',name:'made-in-oa-manager'}]});
    if(u==='https://api.line.me/v2/bot/richmenu'&&m==='POST')return failCreate?Response.json({message:'invalid area'},{status:400}):Response.json({richMenuId:'new1'});
    if(u.startsWith('https://api.line.me/')||u.startsWith('https://api-data.line.me/'))return Response.json({});
    throw Error('unexpected fetch '+u);};
  const call=async(token,path,body,headers={})=>{const waits=[];
    const r=await worker.fetch(new Request('https://api.unit.test'+path,{method:body!==undefined?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)}),f.env,{waitUntil:p=>waits.push(p)});
    await Promise.all(waits);return {status:r.status,...await r.json()};};
  return {f,call,seen};
}
const OWNER='dev:boss:boss@unit.test';

test('LINE menu: admin sets six tiles that open the app in the phone browser, then removes only our old menu',async()=>{
  const {call,seen}=setup();
  const r=await call(OWNER,'/api/admin/line/richmenu',{});
  assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.richMenuId,'new1');assert.equal(r.removed,1);
  const made=JSON.parse(seen.find(s=>s.u==='https://api.line.me/v2/bot/richmenu'&&s.m==='POST').init.body);
  assert.deepEqual(made.size,{width:2500,height:1686});assert.equal(made.areas.length,6);assert.ok(made.chatBarText.length<=14);
  for(const a of made.areas){assert.match(a.action.uri,/^https:\/\/app\.unit\.test\/.*openExternalBrowser=1$/);assert.ok(a.bounds.x+a.bounds.width<=2500&&a.bounds.y+a.bounds.height<=1686);}
  assert.equal(made.areas.reduce((n,a)=>n+a.bounds.width*a.bounds.height,0),2500*1686,'tiles cover the whole image with no gaps');
  const up=seen.find(s=>s.u==='https://api-data.line.me/v2/bot/richmenu/new1/content');assert.equal(up.init.headers['Content-Type'],'image/png');
  assert.ok(seen.some(s=>s.u==='https://api.line.me/v2/bot/user/all/richmenu/new1'&&s.m==='POST'),'set as everyone\'s menu');
  const del=seen.filter(s=>s.m==='DELETE').map(s=>s.u);assert.deepEqual(del,['https://api.line.me/v2/bot/richmenu/old1'],'never deletes a menu made elsewhere');
});

test('LINE menu: regular users cannot change it, and a LINE error sets nothing',async()=>{
  assert.equal((await setup().call('dev:u1:u1@unit.test','/api/admin/line/richmenu',{})).status,403);
  const {call,seen}=setup({failCreate:true});const r=await call(OWNER,'/api/admin/line/richmenu',{});
  assert.equal(r.status,502);assert.match(r.error,/invalid area/);assert.ok(!seen.some(s=>s.u.includes('/user/all/richmenu')));
});

test('LINE bot: a word like CENDON is not taken as a link code; newcomers learn both ways to connect',async()=>{
  const {call,seen}=setup();
  const body=JSON.stringify({events:[{type:'message',replyToken:'rt',source:{userId:'Unew'},message:{type:'text',text:'สวัสดี CENDON'}}]});
  const sig=createHmac('sha256','test-only-secret').update(body).digest('base64');
  assert.equal((await call('','/api/line/webhook',body,{'X-Line-Signature':sig})).status,200);
  const reply=JSON.parse(seen.find(s=>s.u==='https://api.line.me/v2/bot/message/reply').init.body).messages[0].text;
  assert.doesNotMatch(reply,/รหัสนี้ใช้ไม่ได้/);assert.match(reply,/เข้าสู่ระบบแอปด้วย LINE/);assert.match(reply,/บัญชี → เชื่อม LINE/);
});
