import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleTech } from '../src/techs.js';

/* D1 ปลอมบน SQLite — ตารางสร้างเองจาก ensureTech ของ techs.js */
function D1() {
  const s = new DatabaseSync(':memory:');
  const st = sql => { let v = []; return { bind(...a) { v = a; return this }, async first() { return s.prepare(sql).get(...v) || null },
    async all() { return { results: s.prepare(sql).all(...v) } }, async run() { const r = s.prepare(sql).run(...v); return { meta: { changes: Number(r.changes) } } } } };
  return { prepare: st, async batch(list) { for (const x of list) await x.run() } , exec: q => s.exec(q) };
}
const JPG = 'data:image/jpeg;base64,' + Buffer.from('x'.repeat(30)).toString('base64');
const pic = (kind, n) => ({ kind, data: 'data:image/jpeg;base64,' + Buffer.from(kind + n).toString('base64') });
const form = (over = {}) => ({ name: 'นายสมชาย ใจดี', phone: '0812345678', area: 'บางนา กรุงเทพ', age: 30, years: 5, from: 500, warranty: 30, radius: 10,
  lat: 13.7, lng: 100.6, cats: [], consent: true, idNo: '1101700203450', birth: '1996-05-01',
  docs: [pic('id', 1), pic('selfie', 1), pic('shop', 1), pic('work', 1), pic('work', 2), pic('work', 3)], ...over });

test('apply stores AI screening for staff; duplicate ID on 2nd account is caught; rescreen works', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ work: [{ real_car_repair_or_tools: true }], summary: 'ok' }) }] } }] }));
  const env = { DB: D1(), DEV_AUTH: '1', GEMINI_KEY: 'k', OWNERS: 'boss@x.com' };
  const call = async (tok, path, body) => {
    const r = await handleTech(new Request('https://t' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env);
    return { status: r.status, ...(await r.json()) };
  };
  /* หมวดงานต้องมีจริงในระบบ — ดึงจาก ping ไม่ได้ จึงลองหมวดยอดนิยม */
  let res;
  for (const c of ['eng']) { res = await call('dev:u1:a@x.com', '/api/tech/apply', form({ cats: [c] })); if (res.status !== 400 || !/งานที่รับ/.test(res.error || res.message || '')) break; }
  assert.equal(res.status, 200, JSON.stringify(res));
  const cat = (await call('dev:boss:boss@x.com', '/api/tech/applications')).applications[0].cats[0];
  let apps = (await call('dev:boss:boss@x.com', '/api/tech/applications')).applications;
  assert.equal(apps.length, 1); assert.ok(apps[0].ai, 'AI result stored'); assert.ok(['pass', 'review'].includes(apps[0].ai.verdict));
  /* บัญชีที่สองใช้เลขบัตรเดิม + รูปบัตรเดิม */
  assert.equal((await call('dev:u2:b@x.com', '/api/tech/apply', form({ cats: [cat], name: 'นายสมศักดิ์ รักดี' }))).status, 200);
  apps = (await call('dev:boss:boss@x.com', '/api/tech/applications')).applications;
  const second = apps.find(a => a.uid === 'u2');
  assert.equal(second.ai.verdict, 'fail');
  assert.ok(second.ai.flags.some(f => /บัญชีอื่น/.test(f.msg)));
  /* ผู้สมัครทั่วไปเรียกตรวจซ้ำไม่ได้ ทีมงานได้ */
  assert.equal((await call('dev:u2:b@x.com', '/api/tech/rescreen', { uid: 'u2' })).status, 403);
  const rs = await call('dev:boss:boss@x.com', '/api/tech/rescreen', { uid: 'u2' });
  assert.equal(rs.status, 200); assert.equal(rs.ai.verdict, 'fail');
});
