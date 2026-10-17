import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parseKm, parseConfirm, checkKm, thDay, thDayStart, toAsk, askLine, pushText, KM_CRON} from '../src/km-remind.mjs';
import {TABLES, RESET_TABLES} from '../src/account-data.js';

/* เตือนจดเลขไมล์ 18:00: เปิดเองที่กระดิ่ง · LINE ถามทีละคันแล้วพิมพ์เลขตอบได้ · เลขที่ผิดไม่ถูกบันทึก · การาจในแอปได้เลขใหม่
   LINE ในเทสต์เป็นของปลอมทั้งหมด */
const DAY = 86400000;

test('reads a mileage reply, ignores anything that is not just a number', () => {
  for (const [t, v] of [['52300', 52300], ['52,300', 52300], ['52 300 กม.', 52300], ['ไมล์ 52300', 52300], ['เลขไมล์: 128,450 km', 128450], ['7', 7]])
    assert.equal(parseKm(t), v, t);
  for (const t of ['ร้านเปิด 8 โมงไหม', 'แอร์ไม่เย็น', '52300 บาท', '', '0', '9999999', '1.5'])
    assert.equal(parseKm(t), null, t);
  assert.equal(parseConfirm('ยืนยัน 60,000'), 60000);
  assert.equal(parseConfirm('60000'), null);
});

test('odometer never goes backwards; an unusual jump needs a confirmation', () => {
  const now = Date.parse('2026-10-17T11:00:00Z'), last = {km: 50000, at: now - 2 * DAY};
  assert.deepEqual(checkKm(50100, last, now), {ok: true});
  assert.equal(checkKm(49000, last, now).why, 'lower');
  assert.equal(checkKm(53500, last, now).why, 'jump', '3,500 km in 2 days');
  assert.equal(checkKm(52900, last, now).ok, true, 'up to 1,500 km/day');
  assert.deepEqual(checkKm(12345, null, now), {ok: true}, 'first reading');
});

test('Thai day boundaries and who gets asked', () => {
  assert.equal(KM_CRON, '0 11 * * *', '18:00 Bangkok');
  assert.equal(thDay(Date.parse('2026-10-17T17:30:00Z')), '2026-10-18', 'after midnight in Bangkok');
  assert.equal(thDayStart(Date.parse('2026-10-17T11:00:00Z')), Date.parse('2026-10-16T17:00:00Z'));
  assert.deepEqual(toAsk([{id: 'a'}, {id: 'b'}, {id: 'c'}], new Set(['b'])).map(c => c.id), ['a', 'c']);
  const q = askLine({make: 'Toyota', model: 'Vios'}, {km: 52340}, 0, 2);
  assert.match(q.text, /^\(1\/2\) จดเลขไมล์วันนี้ — Toyota Vios/);
  assert.match(q.text, /ราว 52,340 กม\./);
  assert.deepEqual(q.quickReply.items.map(i => i.action.text), ['ข้ามคันนี้', 'หยุดเตือนไมล์']);
  const p = pushText([{id: 'c 1', make: 'Honda', model: 'City'}, {id: 'c2'}], null);
  assert.equal(p.url, '/garage?car=c%201&km=1');
  assert.match(p.body, /Honda City — แตะเพื่อใส่เลขจริง \(และอีก 1 คัน\)/);
});

test('km_remind is part of the account data (export · reset · delete)', () => {
  assert.ok(TABLES.some(([t]) => t === 'km_remind'));
  assert.ok(RESET_TABLES.includes('km_remind'));
  const w = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(w, /"0 11 \* \* \*"/);
});

/* ── ทั้งวงจรผ่าน Worker จริง (SQLite ในหน่วยความจำ) ── */
let seq = 0;
async function setup() {
  const worker = (await import(`../src/worker.js?km=${++seq}`)).default;
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);INSERT INTO config VALUES ('schema_version','19');
    CREATE TABLE users(uid TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,photo TEXT,role TEXT DEFAULT 'user',last_login INTEGER NOT NULL,created_at INTEGER,banned INTEGER DEFAULT 0);
    CREATE TABLE user_state(uid TEXT NOT NULL,k TEXT NOT NULL,v TEXT NOT NULL,t INTEGER NOT NULL,PRIMARY KEY(uid,k));`);
  const DB = {prepare(sql) {let a = []; return {bind(...v) {a = v; return this;}, first: async () => sqlite.prepare(sql).get(...a) || null,
    all: async () => ({results: sqlite.prepare(sql).all(...a)}), run: async () => ({meta: {changes: Number(sqlite.prepare(sql).run(...a).changes)}}), _run() {return sqlite.prepare(sql).run(...a);}};},
    batch: async list => {sqlite.exec('BEGIN'); try {const r = list.map(s => s._run()); sqlite.exec('COMMIT'); return r;} catch (e) {sqlite.exec('ROLLBACK'); throw e;}}};
  const env = {DB, DEV_AUTH: '1', FIREBASE_PROJECT_ID: 'cendon-unit-test', ALLOWED_ORIGINS: '*', LINE_CHANNEL_TOKEN: 'test-only-token', LINE_CHANNEL_SECRET: 'test-only-secret', APP_URL: 'https://app.unit.test'};
  const pushes = [], replies = [];
  globalThis.fetch = async (url, init = {}) => {const u = String(url);
    if (u === 'https://api.line.me/v2/bot/message/push') {pushes.push(JSON.parse(init.body)); return Response.json({});}
    if (u === 'https://api.line.me/v2/bot/message/reply') {replies.push(JSON.parse(init.body).messages); return Response.json({});}
    if (u.startsWith('https://api.line.me/')) return Response.json({});
    throw Error('unexpected fetch ' + u);};
  const call = async (method, path, body, uid = 'me') => {
    const r = await worker.fetch(new Request('https://w.unit.test' + path, {method, headers: {'Content-Type': 'application/json', Authorization: `Bearer dev:${uid}:${uid}@unit.test`}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}), env, {waitUntil() {}});
    return {status: r.status, json: await r.json().catch(() => null)};
  };
  const say = async text => {const n = replies.length, waits = [];
    const body = JSON.stringify({events: [{type: 'message', replyToken: 'rt', source: {type: 'user', userId: 'Ume'}, message: {type: 'text', id: '1', text}}]});
    await worker.fetch(new Request('https://w.unit.test/api/line/webhook', {method: 'POST', headers: {'X-Line-Signature': createHmac('sha256', 'test-only-secret').update(body).digest('base64')}, body}), env, {waitUntil: p => waits.push(p)});
    await Promise.all(waits); return replies.slice(n).flat();};
  const cron = async () => {const waits = []; await worker.scheduled({cron: KM_CRON}, env, {waitUntil: p => waits.push(p)}); await Promise.allSettled(waits);};
  await call('GET', '/api/config');
  const t = Date.now(), q = (sql, ...a) => sqlite.prepare(sql).run(...a);
  q('INSERT INTO users (uid,name,email,role,last_login,created_at) VALUES (?,?,?,?,?,?)', 'me', 'Me', 'me@unit.test', 'user', t, t);
  q("INSERT INTO cars (id,uid,make,model,created_at) VALUES ('v1','me','Toyota','Vios',1),('c2','me','Honda','City',2)");
  q("INSERT INTO odo_anchor (id,uid,car_id,km,source,observed_at,t) VALUES ('a1','me','v1',50000,'manual',?,?)", t - 3 * DAY, t);
  q("INSERT INTO line_link (line_uid,uid,lang,active,linked_at) VALUES ('Ume','me','th',1,?)", t);
  q('INSERT INTO user_state VALUES (?,?,?,?)', 'me', 'garage', JSON.stringify([{id: 'v1', name: 'Vios', mileage: '50000'}, {id: 'c2', name: 'City', mileage: 30000}]), t - 1000);
  return {sqlite, call, say, cron, pushes};
}

test('off by default; turning it on says which channel will be used', async () => {
  const {call, cron, pushes} = await setup();
  assert.deepEqual((await call('GET', '/api/km/remind')).json, {on: false, line: true, push: false, at: '18:00'});
  await cron(); assert.equal(pushes.length, 0, 'nobody is asked unless they turned it on');
  assert.equal((await call('POST', '/api/km/remind', {on: 'yes'})).status, 400);
  assert.equal((await call('POST', '/api/km/remind', {on: true})).json.on, true);
  assert.equal((await call('GET', '/api/km/remind')).json.on, true);
});

test('18:00 on LINE: one car at a time, typed numbers are saved, wrong numbers are not, the app garage follows', async () => {
  const {sqlite, call, say, cron, pushes} = await setup();
  await call('POST', '/api/km/remind', {on: true});
  await cron();
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].messages[0].text, /^\(1\/2\) จดเลขไมล์วันนี้ — Toyota Vios/);
  await cron(); assert.equal(pushes.length, 1, 'once a day');

  assert.match((await say('49000'))[0].text, /น้อยกว่าที่บันทึกไว้ล่าสุด \(50,000 กม\.\)/, 'never backwards');
  assert.match((await say('60000'))[0].text, /สูงผิดปกติ.*ยืนยัน 60000/, '10,000 km in 3 days asks first');
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM odo_anchor WHERE car_id='v1'").get().n, 1, 'nothing saved yet');

  const r = await say('523,456');   // ตัวเลข 6 หลักแบบนี้หน้าตาเหมือนรหัสเชื่อมบัญชี — ต้องถูกอ่านเป็นเลขไมล์
  assert.match(r[0].text, /สูงผิดปกติ/);
  const ok = await say('50,420 กม.');
  assert.match(ok[0].text, /^บันทึกแล้ว ✓ Toyota Vios 50,420 กม\./);
  assert.match(ok[1].text, /^\(2\/2\) จดเลขไมล์วันนี้ — Honda City/, 'then the next car');
  assert.equal(sqlite.prepare("SELECT km FROM odo_anchor WHERE car_id='v1' ORDER BY observed_at DESC").get().km, 50420);
  const g = JSON.parse(sqlite.prepare("SELECT v FROM user_state WHERE uid='me' AND k='garage'").get().v);
  assert.equal(g[0].mileage, '50420', 'the app garage shows the new reading (same type as before)');
  assert.equal(g[1].mileage, 30000);

  assert.equal((await say('ข้ามคันนี้'))[0].text, 'ข้ามคันนี้ครับ\nครบทุกคันแล้ว ขอบคุณครับ');
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM odo_anchor WHERE car_id='c2'").get().n, 0);
  assert.equal(sqlite.prepare("SELECT pending FROM km_remind WHERE uid='me'").get().pending, null);
});

test('cars already logged today are skipped; other chat still reaches the AI; stop from LINE', async () => {
  const {sqlite, call, say, cron, pushes} = await setup();
  sqlite.prepare("INSERT INTO odo_anchor (id,uid,car_id,km,source,observed_at,t) VALUES ('a2','me','v1',50100,'fuel',?,?)").run(Date.now(), Date.now());
  await call('POST', '/api/km/remind', {on: true});
  await cron();
  assert.match(pushes[0].messages[0].text, /^จดเลขไมล์วันนี้ — Honda City/, 'only the car without a reading today');
  const {LINE_AI} = await import('../src/line-chat.js');
  LINE_AI.ask = async () => ({text: 'ลองเช็กน้ำยาแอร์ครับ'});
  const ai = await say('แอร์ไม่เย็น');
  assert.match(ai[0].text, /น้ำยาแอร์/, 'a normal question is not swallowed by the reminder');
  assert.match((await say('หยุดเตือนไมล์'))[0].text, /ปิดการเตือนจดเลขไมล์แล้ว/);
  assert.equal((await call('GET', '/api/km/remind')).json.on, false);
});

test('worker wiring: LINE checks the pending reading before link codes; 18:00 cron returns early', () => {
  const w = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const h = w.slice(w.indexOf('async function lineHandleText('), w.indexOf('async function lineHandleText(') + 600);
  assert.ok(h.indexOf('kmLineReply(') < h.indexOf('lineCodeIn('));
  assert.match(w, /if \(event\.cron === KM_CRON\) \{ ctx\.waitUntil\(runKmRound\(env\)\); return; \}/);
  assert.doesNotMatch(w.slice(w.indexOf('async function runKmRound('), w.indexOf('/* ถามเลขไมล์ — ตอบด้วยค่าที่ระบบใช้จริง')), /addAnchor\(/, 'the cron never writes a reading by itself');
});
