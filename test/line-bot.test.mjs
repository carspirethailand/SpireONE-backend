import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {fixture} from './tech-fixtures.mjs';
import worker from '../src/worker.js';
import {LINE_AI, lineCodeIn, linePlain} from '../src/line-chat.js';

/* บอท LINE: ผลการเชื่อมบัญชีต้องบอกชัดทุกกรณี และพิมพ์คุยกับ AI ได้
   LINE และ AI ในเทสต์เป็นของปลอมทั้งหมด */
function setup(env={}){
  const f=fixture({LINE_CHANNEL_TOKEN:'test-only-token',LINE_CHANNEL_SECRET:'test-only-secret',APP_URL:'https://app.unit.test',...env});
  f.sqlite.exec(`ALTER TABLE users ADD COLUMN name TEXT;
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO config VALUES ('schema_version','999');
    CREATE TABLE line_link (line_uid TEXT PRIMARY KEY, uid TEXT NOT NULL, lang TEXT NOT NULL DEFAULT 'th', active INTEGER NOT NULL DEFAULT 1, linked_at INTEGER NOT NULL);
    CREATE TABLE line_code (code TEXT PRIMARY KEY, uid TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE line_chat (line_uid TEXT PRIMARY KEY, history TEXT NOT NULL DEFAULT '[]', day TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE cars (id TEXT PRIMARY KEY, uid TEXT, make TEXT, model TEXT, year INTEGER, mileage INTEGER, created_at INTEGER);
    CREATE TABLE notify_state (car_id TEXT PRIMARY KEY, uid TEXT, muted_until INTEGER);`);
  f.sqlite.prepare("INSERT INTO users (uid, role, banned, name) VALUES ('somchai','admin',0,'สมชาย'),('suda','user',0,'สุดา')").run();
  const replies=[],calls=[];
  globalThis.fetch=async(url,init={})=>{const u=String(url);calls.push(u);
    if(u==='https://api.line.me/v2/bot/message/reply'){replies.push(JSON.parse(init.body).messages);return Response.json({});}
    if(u.startsWith('https://api.line.me/'))return Response.json({});
    throw Error('unexpected fetch '+u);};
  const say=async(text,user='Uline1')=>{const n=replies.length,waits=[];
    const body=JSON.stringify({events:[{type:'message',replyToken:'rt',source:{type:'user',userId:user},message:{type:'text',id:'1',text}}]});
    const r=await worker.fetch(new Request('https://api.unit.test/api/line/webhook',{method:'POST',headers:{'X-Line-Signature':createHmac('sha256','test-only-secret').update(body).digest('base64')},body}),f.env,{waitUntil:p=>waits.push(p)});
    assert.equal(r.status,200);await Promise.all(waits);return replies.slice(n).flat();};
  const code=(c,uid,{used=0,ago=0}={})=>f.sqlite.prepare('INSERT INTO line_code VALUES (?,?,?,?)').run(c,uid,Date.now()+1200000-ago,used);
  return {f,say,code,calls};
}
const words=m=>m.type==='flex'?m.altText+' '+JSON.stringify(m.contents):m.text;

test('LINE bot: link codes are recognised only when someone means to send one',()=>{
  assert.equal(lineCodeIn('รหัสเชื่อมบัญชี K7Q2MX'),'K7Q2MX');
  assert.equal(lineCodeIn('K7Q2MX'),'K7Q2MX');
  assert.equal(lineCodeIn('k7q2mx'),'K7Q2MX','lower case with a digit, typed by hand');
  for(const t of ['please','brakes squeal','thanks','แอร์ไม่เย็น CHANGE ไหม','ลืมรหัสผ่าน'])assert.equal(lineCodeIn(t),null,t);
});

test('LINE bot: a good code says clearly that linking worked, with the account name',async()=>{
  const {f,say,code}=setup();code('K7Q2MX','suda');
  const [m]=await say('รหัสเชื่อมบัญชี K7Q2MX');
  assert.equal(m.type,'flex');assert.match(m.altText,/เชื่อม LINE กับบัญชี สุดา แล้ว ✓/);
  assert.deepEqual({...f.sqlite.prepare('SELECT uid, active FROM line_link WHERE line_uid=?').get('Uline1')},{uid:'suda',active:1});
  assert.match(words((await say('รหัสเชื่อมบัญชี K7Q2MX'))[0]),/เชื่อมกับบัญชี สุดา อยู่แล้ว/,'sending the same code again is not an error');
});

test('LINE bot: a code that cannot be used says why, and how to get a new one',async()=>{
  const {f,say,code}=setup();code('EXP234','suda',{ago:3600000});code('USD234','suda',{used:1});
  for(const [c,why] of [['EXP234',/หมดอายุ/],['USD234',/ถูกใช้ไปแล้ว/],['NXPE23',/ไม่พบรหัส/]]){
    const t=words((await say('รหัสเชื่อมบัญชี '+c))[0]);
    assert.match(t,/^เชื่อมบัญชีไม่สำเร็จ/);assert.match(t,why);assert.match(t,/ขอรหัสใหม่/);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM line_link').get().n,0);
});

test('LINE bot: an already linked LINE can move to another account, and that account keeps one LINE',async()=>{
  const {f,say,code}=setup();
  f.sqlite.prepare("INSERT INTO line_link VALUES ('Uline1','somchai','th',1,1),('Uold','suda','th',1,1)").run();
  code('MV2345','suda');
  const [m]=await say('รหัสเชื่อมบัญชี MV2345');
  assert.match(words(m),/ย้ายการแจ้งเตือนจากบัญชีเดิม/);
  assert.equal(f.sqlite.prepare('SELECT uid FROM line_link WHERE line_uid=?').get('Uline1').uid,'suda');
  assert.equal(f.sqlite.prepare('SELECT active FROM line_link WHERE line_uid=?').get('Uold').active,0);
});

test('LINE bot: typed questions get an AI answer in plain text, with memory and a Cendon mechanics button',async()=>{
  const {f,say,calls}=setup();f.sqlite.prepare("INSERT INTO line_link VALUES ('Uline1','somchai','th',1,1)").run();
  f.sqlite.prepare("INSERT INTO cars VALUES ('c1','somchai','Honda','City',2019,85000,1)").run();
  const asked=[];LINE_AI.ask=async(env,o)=>{asked.push(o);return {text:asked.length===1
    ?'## สาเหตุ\n**น้ำยาแอร์รั่ว** เป็นไปได้มากสุด\n- เช็กแรงดัน\n- ดูคราบน้ำมัน\n[[ค้นหา: ล้างแอร์]]':'ประมาณ 1,500–2,500 บาทครับ'};};
  const a=await say('แอร์ไม่เย็นเลย ต้องทำไง');
  assert.ok(calls.some(u=>u.endsWith('/chat/loading/start')),'shows typing dots while waiting');
  assert.match(asked[0].system,/คุยผ่าน LINE/);assert.match(asked[0].system,/Honda City/,'knows the linked user\'s car');
  assert.match(asked[0].system,/แนะนำได้เฉพาะช่างใน Cendon/);
  assert.equal(a[0].type,'text');assert.doesNotMatch(a[0].text,/\*\*|##|\[\[/);assert.match(a[0].text,/• เช็กแรงดัน/);
  assert.equal(a[1].type,'flex');assert.match(JSON.stringify(a[1]),/https:\/\/app\.unit\.test\/\?q=%E0%B8%A5%E0%B9%89%E0%B8%B2%E0%B8%87%E0%B9%81%E0%B8%AD%E0%B8%A3%E0%B9%8C&openExternalBrowser=1/);
  await say('ค่าซ่อมประมาณเท่าไร');
  assert.equal(asked[1].messages.length,3,'remembers the previous question and answer');
  assert.match(asked[1].messages[0].parts[0].text,/แอร์ไม่เย็น/);
  assert.equal((await say('เปิดแอร์แล้วมีกลิ่นเหม็น')).length>0&&asked.length,3,'a car question starting with "เปิด" is not the unmute command');
});

test('LINE bot: people who have not linked get a daily limit; slow AI gets a polite reply',async()=>{
  const {say}=setup({AI_ANON_DAILY_LIMIT:'2'});let n=0;LINE_AI.ask=async()=>{n++;return {text:'ตอบแล้วครับ'};};
  await say('ยางรั่วทำไงดี','Uguest');await say('แล้วปะยางได้ไหม','Uguest');
  assert.match(words((await say('อีกข้อครับ','Uguest'))[0]),/ถามครบ 2 ข้อความแล้ว/);assert.equal(n,2);
  LINE_AI.ask=()=>new Promise(()=>{});LINE_AI.timeoutMs=30;
  assert.match(words((await say('ทดสอบช้า','Uslow'))[0]),/AI มีคนใช้เยอะ/);
  LINE_AI.timeoutMs=25000;
});

test('LINE reply text: markdown left by the model becomes readable plain text',()=>{
  assert.equal(linePlain('| อะไหล่ | ราคา |\n|---|---|\n| ผ้าเบรก | 900 |'),'อะไหล่ · ราคา\n\nผ้าเบรก · 900'.replace('\n\n','\n\n'));
});
