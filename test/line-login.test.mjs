import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import * as jose from 'jose';
import {fixture} from './tech-fixtures.mjs';
import worker from '../src/worker.js';

/* เข้าสู่ระบบด้วย LINE: แลก code → ตรวจกับ LINE → ได้ custom token ของ Firebase ที่เซ็นด้วย service account
   (LINE และ Google ในเทสต์เป็นของปลอมทั้งหมด ไม่มีการเรียกจริง) */
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const PEM=privateKey.export({type:'pkcs8',format:'pem'});
function setup(over={}){
  const f=fixture({LINE_LOGIN_CHANNEL_ID:'1650000000',LINE_LOGIN_CHANNEL_SECRET:'test-only-secret',FIREBASE_SA_EMAIL:'sa@unit-test.iam.gserviceaccount.com',
    FIREBASE_SA_KEY:PEM.replace(/\n/g,'\\n'),FIREBASE_PROJECT_ID:'unit-test',...over});
  /* ตาราง line_link ของระบบหลัก (ในเทสต์ไม่มี ensureSchema ของจริง) */
  f.sqlite.exec("CREATE TABLE IF NOT EXISTS line_link (line_uid TEXT PRIMARY KEY, uid TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'th', active INTEGER NOT NULL DEFAULT 1, linked_at INTEGER NOT NULL)");
  const seen=[];
  globalThis.fetch=async(url,init)=>{const u=String(url),body=init&&init.body?Object.fromEntries(new URLSearchParams(String(init.body))):{};seen.push({u,body});
    if(u==='https://api.line.me/oauth2/v2.1/token')return body.code==='good-code'?Response.json({id_token:'idtok',access_token:'at'}):Response.json({error:'invalid_grant'},{status:400});
    if(u==='https://api.line.me/oauth2/v2.1/verify')return body.id_token==='idtok'&&body.nonce==='n123'?Response.json({sub:'U1234abcd',name:'สมชาย LINE',picture:'https://profile.line-scdn.net/x'}):Response.json({error:'invalid nonce'},{status:400});
    throw Error('unexpected fetch '+u);};
  const call=async(path,body)=>{const r=await worker.fetch(new Request('https://api.unit.test'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body&&JSON.stringify(body)}),f.env,{waitUntil(){}});return {status:r.status,...await r.json()};};
  return {f,call,seen};
}

test('LINE login: config tells the page it is ready, and hides it when not configured',async()=>{
  assert.equal((await setup().call('/api/auth/line/config')).clientId,'1650000000');
  assert.equal((await setup({FIREBASE_SA_KEY:''}).call('/api/auth/line/config')).clientId,'');
});

test('LINE login: a good code becomes a Firebase custom token for line:<id> and links LINE notifications',async()=>{
  const {f,call,seen}=setup();
  const r=await call('/api/auth/line',{code:'good-code',redirectUri:'https://cendon-beta.pages.dev/login',nonce:'n123'});
  assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.name,'สมชาย LINE');
  const {payload,protectedHeader}=await jose.jwtVerify(r.token,publicKey,{audience:'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit'});
  assert.equal(protectedHeader.alg,'RS256');assert.equal(payload.uid,'line:U1234abcd');assert.equal(payload.iss,'sa@unit-test.iam.gserviceaccount.com');
  assert.equal(seen[0].body.client_secret,'test-only-secret','secret only goes to LINE');assert.equal(seen[0].body.redirect_uri,'https://cendon-beta.pages.dev/login');
  const link=f.sqlite.prepare('SELECT uid, active FROM line_link WHERE line_uid=?').get('U1234abcd');assert.equal(link.uid,'line:U1234abcd');assert.equal(link.active,1);
});

test('LINE login: bad code, wrong nonce or a foreign redirect are refused',async()=>{
  const {call}=setup();
  assert.equal((await call('/api/auth/line',{code:'bad',redirectUri:'https://cendon-beta.pages.dev/login',nonce:'n123'})).status,401);
  assert.equal((await call('/api/auth/line',{code:'good-code',redirectUri:'https://cendon-beta.pages.dev/login',nonce:'other'})).status,401);
  assert.equal((await call('/api/auth/line',{code:'good-code',redirectUri:'https://evil.example/steal',nonce:'n123'})).status,400);
  assert.equal((await call('/api/auth/line',{code:'good-code',redirectUri:'https://cendon-beta.pages.dev/login'})).status,400,'nonce is required');
});

test('LINE login: a LINE account already linked to another Cendon account keeps that link',async()=>{
  const {f,call}=setup();await call('/api/auth/line/config');
  f.sqlite.prepare("INSERT INTO line_link (line_uid, uid, lang, active, linked_at) VALUES ('U1234abcd','google-user','th',1,1)").run();
  assert.equal((await call('/api/auth/line',{code:'good-code',redirectUri:'https://cendon-beta.pages.dev/login',nonce:'n123'})).status,200);
  assert.equal(f.sqlite.prepare('SELECT uid FROM line_link WHERE line_uid=?').get('U1234abcd').uid,'google-user');
});
