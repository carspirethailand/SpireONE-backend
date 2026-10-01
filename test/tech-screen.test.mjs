import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenApplication, nameMatch, ageFromBirth } from '../src/tech-screen.js';

const AT = Date.UTC(2026, 9, 1);
const app = (over = {}) => ({ data: JSON.stringify({ name: 'นายสมชาย ใจดี', idNo: '1101700203450', age: 30, birth: '1996-05-01', hasCert: true, ...over }) });
const img = (kind, hash) => ({ kind, mime: 'image/jpeg', data: 'AAAA', hash });
const docs = [img('id', 'h1'), img('selfie', 'h2'), img('shop', 'h3'), img('work', 'h4'), img('work', 'h5'), img('work', 'h6')];

/* Gemini ปลอม: คืน JSON ที่กำหนด และจดว่ามีรูปบัตรถูกส่งไปไหม */
function fakeGemini(out) {
  const seen = { calls: 0, kinds: [] };
  globalThis.fetch = async (_url, init) => {
    seen.calls++;
    const body = JSON.parse(init.body);
    seen.kinds = body.contents[0].parts.filter(p => p.text && /^\[\w+\]$/.test(p.text)).map(p => p.text.slice(1, -1));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }), { status: 200 });
  };
  return seen;
}
const goodWork = { work: [{ label: 'shop', real_car_repair_or_tools: true }, { label: 'work', real_car_repair_or_tools: true }], summary: 'ดูปกติ' };

test('helpers: name match ignores titles/spaces; Buddhist-era birth years', () => {
  assert.equal(nameMatch('นายสมชาย ใจดี', 'สมชาย ใจดี'), true);
  assert.equal(nameMatch('สมชาย ใจดี', 'นาย สมศักดิ์ รักดี'), false);
  assert.equal(ageFromBirth('2539-05-01', AT), 30);
  assert.equal(ageFromBirth('1996-05-01', AT), 30);
});

test('clean application with good work photos passes', async () => {
  const seen = fakeGemini(goodWork);
  const r = await screenApplication({ GEMINI_KEY: 'k' }, { app: app(), docs }, { at: AT });
  assert.equal(r.verdict, 'pass'); assert.equal(r.score, 100);
  assert.deepEqual(seen.kinds.filter(k => k === 'id' || k === 'selfie'), [], 'ID/selfie must NOT be sent without TECH_AI_IDS=1');
});

test('duplicate ID across accounts + reused image → fail', async () => {
  fakeGemini(goodWork);
  const r = await screenApplication({ GEMINI_KEY: 'k' }, { app: app(), docs: [...docs.slice(0, 5), img('work', 'h4')], dupIdCount: 1 }, { at: AT });
  assert.equal(r.verdict, 'fail');
  assert.ok(r.flags.some(f => /บัญชีอื่น/.test(f.msg)));
  assert.ok(r.flags.some(f => /ใช้รูปเดียวกันซ้ำ/.test(f.msg)));
});

test('age that does not match birth date → needs review', async () => {
  fakeGemini(goodWork);
  const r = await screenApplication({ GEMINI_KEY: 'k' }, { app: app({ age: 45 }), docs }, { at: AT });
  assert.equal(r.verdict, 'review');
});

test('with TECH_AI_IDS=1: card name/number mismatch and fake card are flagged', async () => {
  const seen = fakeGemini({ id_card: { is_thai_id_card: true, photo_of_screen_or_printout: true, readable: true, name_on_card: 'นายสมศักดิ์ รักดี', id_on_card: '3100500123456' },
    selfie: { person_holding_id_card: true, same_person_as_card: 'no' }, ...goodWork });
  const r = await screenApplication({ GEMINI_KEY: 'k', TECH_AI_IDS: '1' }, { app: app(), docs }, { at: AT });
  assert.ok(seen.kinds.includes('id') && seen.kinds.includes('selfie'));
  assert.equal(r.verdict, 'fail');
  for (const re of [/ถ่ายจากจอ/, /เลขบนบัตรไม่ตรง/, /ชื่อบนบัตร/, /ไม่น่าจะเป็นคนเดียวกับ/]) assert.ok(r.flags.some(f => re.test(f.msg)), String(re));
});

test('stock / non-repair work photos are flagged', async () => {
  fakeGemini({ work: [{ real_car_repair_or_tools: false, stock_or_internet_photo_suspected: true }, { real_car_repair_or_tools: false, stock_or_internet_photo_suspected: true }, { real_car_repair_or_tools: true }] });
  const r = await screenApplication({ GEMINI_KEY: 'k' }, { app: app(), docs }, { at: AT });
  assert.equal(r.verdict, 'fail');
});

test('Gemini down → still returns local checks, marked for human review', async () => {
  globalThis.fetch = async () => new Response('quota', { status: 429 });
  const r = await screenApplication({ GEMINI_KEY: 'k' }, { app: app(), docs }, { at: AT });
  assert.equal(r.verdict, 'review'); assert.match(r.error, /429/);
});
