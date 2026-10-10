/* ══════════════════════════════════════════════════════════════════
   คลังสเปกรถของ Cendon — หาข้อมูลจริงครั้งเดียว ทุกคนใช้ร่วมกัน

   คนแรกที่เลือก "Mitsubishi Pajero Sport ปี 2020" → Gemini ค้นเว็บหาสเปกจริงของรุ่นนั้น
   แล้วเก็บไว้ในตาราง car_specs คนต่อไปที่เลือกรุ่นเดียวกันได้ข้อมูลชุดเดิมทันที ไม่ต้องเรียก AI อีก

   AI ผิดได้ จึงมีด่านกันพลาดหลายชั้น:
   1) ค้นสองรอบแยกกัน คนละรุ่นโมเดล คำสั่งคนละแบบ (ให้รอบสองหาจากแหล่งอื่น) แล้วเทียบกันทีละช่อง
      ตรงกัน = "ยืนยันจาก 2 แหล่ง" · มีรอบเดียว = "แหล่งเดียว" · ไม่ตรงกัน = เก็บทั้งสองค่า ขึ้นว่า "ข้อมูลไม่ตรงกัน"
   2) ห้ามเดา — หาไม่เจอให้เป็น null หน้าแอปไม่แสดงตัวเลขที่ไม่มีที่มา
   3) เก็บลิงก์แหล่งข้อมูลจริงที่ Google ส่งกลับมา (grounding) ไม่ใช่ลิงก์ที่ AI พิมพ์เอง
   4) แยกรุ่นย่อย (เครื่อง/เกียร์/ขับเคลื่อน) เพราะรุ่นเดียวกันคนละเครื่องสเปกต่างกันมาก
   5) ผู้ใช้กด "แจ้งข้อมูลผิด" ได้ → แอดมินดูรายงาน สั่งค้นใหม่ หรือกด "ยืนยันแล้ว" (ล็อก ไม่ให้ AI ทับ)

   โควตา AI: ค้นใหม่ได้วันละ 10 รุ่นต่อบัญชี · 3 รุ่นต่อ IP ที่ไม่ล็อกอิน · ทั้งระบบ 150 รุ่นต่อวัน
   (รุ่นที่มีในคลังแล้วดึงได้ไม่จำกัด) — ใช้รุ่น Gemini ที่แชตไม่ได้ใช้ตอบเป็นหลัก แบบเดียวกับนิตยสาร
   ══════════════════════════════════════════════════════════════════ */
import { chatModels } from './fastai.js';

export const BODIES = ['sedan', 'hatchback', 'suv', 'pickup', 'mpv', 'van', 'coupe', 'ev'];
const DAY = 86400000;
const LIMIT = { user: 10, guest: 3, all: 150 };

const norm = (s) => String(s == null ? '' : s).normalize('NFC').trim().replace(/\s+/g, ' ');
export const specKey = (make, model, year) => [make, model, year].map((s) => norm(s).toLowerCase()).join('|');

/* รับเฉพาะชื่อที่ดูเป็นชื่อรถจริง — กันคนยิงข้อความยาว ๆ มาเปลืองโควตา AI */
export function validQuery(q) {
  const make = norm(q && q.make), model = norm(q && q.model), year = norm(q && q.year);
  const ok = (s) => s.length >= 1 && s.length <= 40 && /^[\p{L}\p{N} .+\-/()&']+$/u.test(s);
  const y = parseInt(year, 10), now = new Date().getUTCFullYear();
  if (!ok(make) || !ok(model) || !/^\d{4}$/.test(year) || y < 1950 || y > now + 1) return null;
  return { make, model, year };
}

/* ─────────── Gemini (ค้นเว็บ) ─────────── */
const SPEC_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-3.5-flash-lite'];
export function specAI(env) {
  const key = env.GEMINI_SPEC_KEY || env.GEMINI_NEWS_KEY || env.GEMINI_KEY || '';
  const own = !!(env.GEMINI_SPEC_KEY || env.GEMINI_NEWS_KEY);
  const chatMain = own ? [] : chatModels(env).slice(0, 2);
  /* รุ่นที่แชตไม่ได้ใช้ตอบเป็นหลักก่อน → แล้วค่อยถอยไปรุ่นของแชตเป็นทางสุดท้าย
     สเปกรถค้นครั้งเดียวต่อรุ่นรถตลอดไป การค้นสำเร็จสำคัญกว่าการหลบโควตาแชตทุกครั้ง */
  const models = [env.GEMINI_SPEC_MODEL, ...SPEC_MODELS.filter((m) => !chatMain.includes(m)), ...chatMain]
    .map((m) => norm(m)).filter(Boolean);
  const repair = ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', ...chatMain];
  return { key, own, models: [...new Set(models)], repair };
}

/* โมเดลที่คิดนานกินโทเคนคำตอบไปกับการคิด (นับรวมใน maxOutputTokens) จน JSON โดนตัดกลางทาง
   และใช้เวลานานเกิน — ตั้งให้คิดน้อยพอให้ค้นเว็บแล้วสรุปได้ */
const thinking = (model, json) => /gemini-3|gemini-[4-9]/.test(model) ? { thinkingLevel: 'low' }
  : /2\.5/.test(model) ? { thinkingBudget: json ? 0 : 512 } : undefined;
export const CALL_MS = 40000;
async function searchCall(env, ai, model, prompt) {
  const base = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), CALL_MS);
  try {
    const send = (think) => fetch(`${base}/v1beta/models/${model}:generateContent`, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ai.key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],                 /* ค้นเว็บใช้คู่กับบังคับ JSON ไม่ได้ — ให้ตอบ JSON ในข้อความ */
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192, ...(think ? { thinkingConfig: think } : {}) },
      }),
    });
    let r = await send(thinking(model, false)), retried = false;
    /* บางรุ่นไม่รับค่าการคิดที่ตั้งไป (ตอบ 400) — ลองอีกครั้งแบบไม่ตั้ง */
    if (r.status === 400 && thinking(model, false)) { retried = true; r = await send(undefined); }
    if (!r.ok) throw Object.assign(new Error(`${model} ตอบ ${r.status}: ${await errText(r)}`), { http: r.status, retried });
    const j = await r.json();
    const c = (j.candidates && j.candidates[0]) || {};
    if (!j.candidates || !j.candidates.length) {
      const why = j.promptFeedback && (j.promptFeedback.blockReason || JSON.stringify(j.promptFeedback).slice(0, 120));
      throw Object.assign(new Error(`${model} ไม่ส่งคำตอบกลับ${why ? ' (' + why + ')' : ''}`), { http: 200, retried });
    }
    if (c.finishReason && !/STOP|MAX_TOKENS/.test(c.finishReason)) throw Object.assign(new Error(`${model} หยุดเพราะ ${c.finishReason}`), { http: 200, retried });
    const text = ((c.content && c.content.parts) || []).map((p) => p.text || '').join('');
    const chunks = (c.groundingMetadata && c.groundingMetadata.groundingChunks) || [];
    const sources = chunks.map((x) => x && x.web).filter((w) => w && w.uri)
      .map((w) => ({ title: norm(w.title).slice(0, 120), url: String(w.uri).slice(0, 1000) }));
    return { text, sources, model, finish: c.finishReason || '', retried };
  } catch (e) {
    throw e && e.name === 'AbortError' ? new Error(model + ' ค้นนานเกิน ' + CALL_MS / 1000 + ' วินาที') : e;
  } finally { clearTimeout(t); }
}

/* ข้อความผิดพลาดจริงจาก Gemini (เช่น คีย์ผิด · ไม่มีรุ่นนี้ · โควตาหมด) — เดิมเหลือแค่เลขสถานะ ไล่หาสาเหตุไม่ได้ */
async function errText(r) {
  const t = await r.text().catch(() => '');
  let m = '';
  try { const e = JSON.parse(t).error || {}; m = [e.status, e.message].filter(Boolean).join(' · '); } catch (e) { m = t; }
  return String(m || 'ไม่มีรายละเอียด').replace(/\s+/g, ' ').slice(0, 240);
}

/* คำตอบจากการค้นเว็บบางครั้งมีข้อความปน หรือ JSON ไม่ครบ — ให้โมเดลเบาแปลงเป็น JSON ตามรูปแบบอีกครั้ง (ไม่ค้นเว็บ ไม่แต่งเพิ่ม) */
async function repairJson(env, ai, text, log, pass) {
  const base = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  for (const model of ai.repair) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 12000), t0 = Date.now();
    const note = (o) => log && log.push({ p: pass, step: 'repair', m: model, ms: Date.now() - t0, ...o });
    try {
      const r = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
        method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ai.key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: `แปลงข้อมูลสเปกรถด้านล่างเป็น JSON object ตามรูปแบบนี้ ใช้เฉพาะข้อมูลที่มีในข้อความ ห้ามเพิ่มหรือเดาค่าใหม่ ค่าที่ไม่มีให้เป็น null
รูปแบบ: ${SHAPE}

ข้อมูล:
${String(text).slice(0, 12000)}` }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 8192, responseMimeType: 'application/json', ...(thinking(model, true) ? { thinkingConfig: thinking(model, true) } : {}) } }),
      });
      if (!r.ok) { note({ ok: false, st: r.status, err: await errText(r) }); continue; }
      const j = await r.json();
      const o = parseObj(((((j.candidates || [])[0] || {}).content || {}).parts || []).map((p) => p.text || '').join(''));
      note({ ok: !!o, st: 200, err: o ? '' : 'แปลงเป็น JSON ไม่ได้' });
      if (o) return o;
    } catch (e) { note({ ok: false, err: e && e.name === 'AbortError' ? 'เกิน 12 วินาที' : String((e && e.message) || e).slice(0, 200) }); } finally { clearTimeout(t); }
  }
  return null;
}

export function parseObj(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const o = JSON.parse(s.slice(a, b + 1)); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; }
}

const SHAPE = `{"found":true,
 "body":"เลือกหนึ่งค่า: sedan | hatchback | suv | pickup | mpv | van | coupe (รถสปอร์ต/คูเป้/เปิดประทุน) | ev (เฉพาะรถไฟฟ้าล้วน)",
 "generation":"เจเนอเรชัน/รหัสตัวถัง และช่วงปีที่ผลิต","market":"ตลาดที่ใช้ข้อมูล เช่น ไทย",
 "variants":[{"name":"ชื่อรุ่นย่อย/เกรด","engine":"เช่น 2.4L 4 สูบ ดีเซล เทอร์โบ","fuel":"petrol | diesel | hybrid | phev | ev | lpg",
   "cc":2442,"hp":181,"torque_nm":430,"gearbox":"เช่น อัตโนมัติ 8 สปีด","drive":"FWD | RWD | 4WD | AWD","l_per_100km":7.9,
   "battery_kwh":null,"range_km":null}],
 "seats":7,"doors":5,"length_mm":4825,"width_mm":1815,"height_mm":1835,"wheelbase_mm":2800,"kerb_kg":2045,"tank_l":68,
 "tire":"265/60 R18","safety":["อุปกรณ์ความปลอดภัยที่มีในรุ่นนี้"],"comfort":["อุปกรณ์อำนวยความสะดวกที่มี"],
 "notes":"ข้อควรรู้สั้น ๆ เช่น ปัญหาที่พบบ่อยของรุ่นนี้ (ถ้ามีแหล่งยืนยัน)"}`;

function promptA(q) {
  return `ค้นเว็บหาข้อมูลจำเพาะ (สเปก) จริงของรถ ${q.make} ${q.model} ปี ${q.year}
ใช้รุ่นที่ขายในประเทศไทยเป็นหลัก ถ้าไม่มีขายในไทยให้ใช้ตลาดหลักของรุ่นนั้น และบอกใน market
อ่านอย่างน้อย 5 แหล่งที่น่าเชื่อถือ เช่น เว็บผู้ผลิต/ตัวแทนจำหน่ายในไทย, Headlightmag, Autospinn, Grandprix, เว็บรีวิวและฐานข้อมูลสเปก
ใส่ทุกรุ่นย่อยที่ขายในปีนั้น (เครื่องยนต์/เกียร์/ระบบขับเคลื่อนต่างกัน) ใน variants
ห้ามเดาเด็ดขาด ค่าไหนไม่พบในแหล่งข้อมูลให้ใส่ null ตัวเลขใส่เป็นตัวเลขล้วน ไม่ใส่หน่วย
ถ้ารถรุ่นนี้ในปีนี้ไม่มีอยู่จริง ตอบ {"found":false}
ตอบเป็น JSON object เท่านั้น ไม่มีคำนำหรือ markdown รูปแบบ:
${SHAPE}`;
}
function promptB(q) {
  return `ตรวจสอบข้อมูลจำเพาะของ ${q.make} ${q.model} รุ่นปี ${q.year} อย่างเป็นอิสระ
ค้นจากหลายแหล่ง ให้ความสำคัญกับเอกสารสเปกของผู้ผลิตและตารางสเปกของเว็บข่าวรถ (ตลาดไทยก่อน ถ้าไม่มีใช้ตลาดหลัก)
รวบรวมรุ่นย่อยทั้งหมดของปีนั้น ค่าไหนไม่แน่ใจหรือหาไม่เจอให้เป็น null ห้ามประมาณเอง ตัวเลขไม่ใส่หน่วย
ถ้าไม่มีรุ่นนี้ในปีนี้จริง ตอบ {"found":false}
ตอบ JSON object อย่างเดียว ตามรูปแบบ:
${SHAPE}`;
}

/* ลองรุ่นโมเดลตามลำดับจนได้ JSON ที่อ่านได้ (เริ่มคนละตัวในสองรอบ = สองความเห็นที่ไม่ลอกกัน) */
/* log: ทุกครั้งที่เรียกโมเดล บันทึก รอบ · รุ่น · เวลา · สถานะ HTTP · ความยาวคำตอบ · จำนวนแหล่ง · อ่าน JSON ได้ไหม · ข้อผิดพลาดจริง */
async function lookup(env, ai, prompt, start, log = [], pass = 'A') {
  /* ไม่เกิน 3 รุ่นต่อรอบ — รุ่นที่ใช้ไม่ได้ (404/400/429) ตอบกลับเร็ว ส่วนที่ช้าคือการค้นเว็บจริง */
  const order = [...ai.models.slice(start), ...ai.models.slice(0, start)].slice(0, 3);
  let last = null;
  for (const m of order) {
    const t0 = Date.now();
    try {
      const r = await searchCall(env, ai, m, prompt);
      const direct = parseObj(r.text);
      const step = { p: pass, step: 'search', m, ms: 0, st: 200, len: r.text.length, src: r.sources.length, fin: r.finish, retried: r.retried || undefined };
      log.push(step);
      const o = direct || (r.text.trim() ? await repairJson(env, ai, r.text, log, pass) : null);
      step.ms = Date.now() - t0; step.ok = !!o; step.json = direct ? 'ok' : o ? 'ซ่อมแล้ว' : r.text.trim() ? 'อ่านไม่ได้' : 'ว่าง';
      if (!o) step.head = r.text.slice(0, 160);
      if (o) return { ...r, data: o };
      last = new Error(m + (r.text.trim() ? ' ตอบไม่เป็น JSON' : ' ตอบว่าง'));
      step.err = last.message;
    } catch (e) {
      log.push({ p: pass, step: 'search', m, ms: Date.now() - t0, ok: false, st: e.http, retried: e.retried || undefined, err: String((e && e.message) || e).slice(0, 300) });
      last = e;
    }
  }
  throw last || new Error('ไม่มีรุ่น Gemini ให้ใช้');
}

/* ─────────── เทียบสองรอบ ─────────── */
const numOr = (v) => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));
const txt = (v, n = 80) => (v == null ? null : norm(v).slice(0, n) || null);
function same(a, b, tol) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= Math.max(1, Math.abs(a) * tol);
  const k = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return k(a) === k(b) || k(a).includes(k(b)) || k(b).includes(k(a));
}
/* ช่องหนึ่งช่อง: { v, ok } — ok: true ยืนยัน 2 แหล่ง · null แหล่งเดียว · false ไม่ตรงกัน (alt = ค่าจากอีกรอบ) */
export function field(a, b, tol = 0.04) {
  if (a == null && b == null) return null;
  if (a == null) return { v: b, ok: null };
  if (b == null) return { v: a, ok: null };
  return same(a, b, tol) ? { v: a, ok: true } : { v: a, ok: false, alt: b };
}
const FUEL = ['petrol', 'diesel', 'hybrid', 'phev', 'ev', 'lpg'];
const DRIVE = ['FWD', 'RWD', '4WD', 'AWD'];
function cleanVariant(v) {
  if (!v || typeof v !== 'object') return null;
  const fuel = String(v.fuel || '').toLowerCase(), drive = String(v.drive || '').toUpperCase();
  return { name: txt(v.name, 80), engine: txt(v.engine, 80), fuel: FUEL.includes(fuel) ? fuel : null,
    cc: numOr(v.cc), hp: numOr(v.hp), torque_nm: numOr(v.torque_nm), gearbox: txt(v.gearbox, 60),
    drive: DRIVE.includes(drive) ? drive : null, l_per_100km: numOr(v.l_per_100km),
    battery_kwh: numOr(v.battery_kwh), range_km: numOr(v.range_km) };
}
/* จับคู่รุ่นย่อยของสองรอบ: เชื้อเพลิงเดียวกัน ความจุเครื่องใกล้กัน (±5%) แล้วค่อยดูชื่อ */
function matchVariant(v, list, used) {
  let best = -1, score = 0;
  list.forEach((w, i) => {
    if (used.has(i)) return;
    let s = 0;
    if (v.fuel && w.fuel && v.fuel === w.fuel) s += 2;
    if (v.cc && w.cc && same(v.cc, w.cc, 0.05)) s += 3;
    if (v.drive && w.drive && v.drive === w.drive) s += 1;
    if (v.name && w.name && same(v.name, w.name, 0)) s += 2;
    if (s > score) { score = s; best = i; }
  });
  return score >= 3 ? best : -1;
}
const FACTS = ['seats', 'doors', 'length_mm', 'width_mm', 'height_mm', 'wheelbase_mm', 'kerb_kg', 'tank_l'];
const VNUM = ['cc', 'hp', 'torque_nm', 'l_per_100km', 'battery_kwh', 'range_km'];
export function merge(A, B) {
  B = B || {};
  const list = (o) => (Array.isArray(o.variants) ? o.variants : []).map(cleanVariant).filter((v) => v && (v.engine || v.name || v.cc || v.hp)).slice(0, 12);
  const va = list(A), vb = list(B), used = new Set();
  const variants = va.map((v) => {
    const j = matchVariant(v, vb, used); if (j >= 0) used.add(j);
    const w = j >= 0 ? vb[j] : {};
    const out = { name: v.name || w.name || null, engine: field(v.engine, w.engine), fuel: v.fuel || w.fuel || null,
      gearbox: field(v.gearbox, w.gearbox), drive: field(v.drive, w.drive) };
    for (const k of VNUM) out[k] = field(v[k], numOr(w[k]), k === 'l_per_100km' ? 0.08 : 0.04);
    return out;
  });
  /* รุ่นย่อยที่มีแต่ในรอบสอง ยังเก็บไว้ (แหล่งเดียว) */
  vb.forEach((w, i) => { if (!used.has(i) && variants.length < 12) {
    const out = { name: w.name, engine: field(null, w.engine), fuel: w.fuel, gearbox: field(null, w.gearbox), drive: field(null, w.drive) };
    for (const k of VNUM) out[k] = field(null, w[k]);
    variants.push(out);
  } });
  const facts = {};
  for (const k of FACTS) facts[k] = field(numOr(A[k]), numOr(B[k]), 0.03);
  facts.tire = field(txt(A.tire, 40), txt(B.tire, 40));
  const bodyA = BODIES.includes(A.body) ? A.body : null, bodyB = BODIES.includes(B.body) ? B.body : null;
  const lst = (x) => (Array.isArray(x) ? x : []).map((s) => txt(s, 60)).filter(Boolean).slice(0, 24);
  /* นับว่ายืนยันได้กี่ช่อง จากที่มีค่า — ใช้บอกความมั่นใจรวม */
  const cells = [...Object.values(facts), ...variants.flatMap((v) => VNUM.map((k) => v[k]))].filter(Boolean);
  const confirmed = cells.filter((c) => c.ok === true).length, conflicts = cells.filter((c) => c.ok === false).length;
  return {
    body: bodyA && bodyB && bodyA !== bodyB ? null : bodyA || bodyB, body_ok: !!(bodyA && bodyA === bodyB),
    generation: txt(A.generation || B.generation, 80), market: txt(A.market || B.market, 40),
    variants, facts, safety: lst(A.safety).length ? lst(A.safety) : lst(B.safety),
    comfort: lst(A.comfort).length ? lst(A.comfort) : lst(B.comfort), notes: txt(A.notes, 300),
    score: { cells: cells.length, confirmed, conflicts },
  };
}

export async function research(env, q, log = []) {
  const ai = specAI(env);
  log.push({ step: 'setup', ok: !!ai.key, keyFrom: env.GEMINI_SPEC_KEY ? 'GEMINI_SPEC_KEY' : env.GEMINI_NEWS_KEY ? 'GEMINI_NEWS_KEY' : env.GEMINI_KEY ? 'GEMINI_KEY' : 'ไม่มี', models: ai.models });
  if (!ai.key) throw new Error('ยังไม่ได้ตั้งคีย์ Gemini');
  /* สองรอบพร้อมกัน เริ่มจากรุ่นโมเดลคนละตัว */
  const cap = (p, pass) => { let t; return Promise.race([p.finally(() => clearTimeout(t)), new Promise((_, no) => { t = setTimeout(() => { log.push({ p: pass, step: 'cap', ok: false, err: 'รอบนี้ค้นนานเกิน 80 วินาที ตัดทิ้ง' }); no(new Error('ค้นนานเกินกำหนด')); }, 80000); })]); };
  const [a, b] = await Promise.allSettled([cap(lookup(env, ai, promptA(q), 0, log, 'A'), 'A'), cap(lookup(env, ai, promptB(q), Math.min(1, ai.models.length - 1), log, 'B'), 'B')]);
  const A = a.status === 'fulfilled' ? a.value : null, B = b.status === 'fulfilled' ? b.value : null;
  if (!A && !B) throw (a.reason || b.reason || new Error('ค้นข้อมูลไม่สำเร็จ'));
  const first = A || B, second = A ? B : null;
  if (first.data.found === false && (!second || second.data.found === false)) {
    return { status: 'notfound', data: null, sources: [], models: [first.model, second && second.model].filter(Boolean) };
  }
  const data = merge(first.data.found === false ? second.data : first.data, second && second.data.found !== false ? second.data : null);
  const seen = new Set(), sources = [];
  for (const s of [...first.sources, ...((second && second.sources) || [])]) {
    const k = s.title || s.url; if (seen.has(k)) continue; seen.add(k); sources.push(s);
  }
  return { status: 'ready', data, sources: sources.slice(0, 16), models: [first.model, second && second.model].filter(Boolean), passes: second ? 2 : 1 };
}

/* ─────────── คลัง (D1) ─────────── */
const row2out = (r) => r && ({
  status: r.status, key: r.k, make: r.make, model: r.model, year: r.year, body: r.body || null,
  data: r.data ? JSON.parse(r.data) : null, sources: r.sources ? JSON.parse(r.sources) : [],
  verified: r.status === 'verified', reports: r.reports || 0, updated_at: r.updated_at, error: r.status === 'failed' ? (r.error || '') : undefined,
});
export async function getSpec(env, k) {
  const r = await env.DB.prepare('SELECT * FROM car_specs WHERE k = ?').bind(k).first();
  return r ? row2out(r) : null;
}

async function spend(env, who, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare(`INSERT INTO spec_quota (who, day, n) VALUES (?, ?, 1)
    ON CONFLICT(who, day) DO UPDATE SET n = n + 1 RETURNING n`).bind(who, day).first();
  return !r || r.n <= limit;
}

/* ─────────── บันทึกการค้นสเปก (แผงผู้ดูแลแบบลอย แสดงทุกหน้า) ───────────
   ทุกคำขอที่มาถึงหลังบ้าน: ใคร (ย่อ) · รุ่นอะไร · ผลเป็นอะไร (ได้จากคลัง / ติดโควตา / ค้นใหม่ …)
   ถ้าค้นใหม่ เก็บทุกขั้นที่เรียก Gemini พร้อมข้อผิดพลาดจริง · เก็บแค่ 300 แถวล่าสุด */
const LOG_TABLE = `CREATE TABLE IF NOT EXISTS spec_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, k TEXT, who TEXT,
  kind TEXT, ok INTEGER, ms INTEGER, status TEXT, trail TEXT, err TEXT)`;
export async function logSpec(env, ev) {
  const ins = () => env.DB.prepare('INSERT INTO spec_log (at, k, who, kind, ok, ms, status, trail, err) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(Date.now(), String(ev.k || '').slice(0, 120), String(ev.who || '').replace(/^ip:(.+)$/, (m, ip) => 'ip:' + ip.split(/[.:]/).slice(0, 2).join('.') + '…').slice(0, 14),
      String(ev.kind || ''), ev.ok ? 1 : 0, ev.ms | 0, String(ev.status || ''), JSON.stringify(ev.trail || []).slice(0, 8000), String(ev.err || '').slice(0, 400)).run();
  try {
    /* ตารางสร้างเองครั้งแรกที่ต้องใช้ ไม่ต้องรอเลื่อนรุ่นฐานข้อมูล */
    try { await ins(); } catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; await env.DB.prepare(LOG_TABLE).run(); await ins(); }
    if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM spec_log WHERE id <= (SELECT MAX(id) - 300 FROM spec_log)').run();
  } catch (e) { console.error('[spec_log]', e); }
}
export async function specLogList(env, limit = 40) {
  try {
    const { results = [] } = await env.DB.prepare('SELECT at, k, who, kind, ok, ms, status, trail, err FROM spec_log ORDER BY id DESC LIMIT ?').bind(limit).all();
    return results.map((r) => ({ ...r, trail: (() => { try { return JSON.parse(r.trail || '[]'); } catch (e) { return []; } })() }));
  } catch (e) { return []; }
}

/* ขอข้อมูลรุ่นนี้: มีในคลัง → ส่งเลย · ยังไม่มี → ค้นครั้งเดียวแล้วเก็บ
   who: 'u:<uid>' หรือ 'ip:<ip>' · staff: ข้ามโควตา · force: ค้นใหม่ทับ (แอดมิน) */
export async function ensureSpec(env, q, { who = 'ip:unknown', user = false, staff = false, force = false, retry = false, defer = null, waitMs = 85000 } = {}) {
  const v = validQuery(q);
  if (!v) throw Object.assign(new Error('ชื่อรถหรือปีไม่ถูกต้อง'), { status: 400 });
  const k = specKey(v.make, v.model, v.year), now = Date.now();
  const note = (kind, ok, status, err) => logSpec(env, { k, who, kind, ok, status, err, ms: Date.now() - now });
  const have = await env.DB.prepare('SELECT * FROM car_specs WHERE k = ?').bind(k).first();
  if (have && !force) {
    if (['ready', 'verified', 'notfound'].includes(have.status)) {
      await env.DB.prepare('UPDATE car_specs SET hits = hits + 1 WHERE k = ?').bind(k).run();
      await note('cache', true, have.status);
      return row2out(have);
    }
    if (have.status === 'pending' && now - have.updated_at < 180000) { await note('wait', true, 'pending', 'มีคนกำลังค้นรุ่นนี้อยู่ (เริ่ม ' + Math.round((now - have.updated_at) / 1000) + ' วิที่แล้ว)'); return row2out(have); }
    /* ค้นไม่สำเร็จ: ผู้ใช้กด "ลองใหม่" = ค้นใหม่ทันที (นับโควตา) · เปิดเฉย ๆ = รอ 2 นาทีก่อนลองเอง */
    if (have.status === 'failed' && !retry && now - have.updated_at < 2 * 60000) { await note('failed-recent', false, 'failed', 'ยังไม่ครบ 2 นาทีหลังค้นไม่สำเร็จ: ' + (have.error || '')); return row2out(have); }
  }
  if (have && have.status === 'verified' && force && !staff) return row2out(have);
  if (!staff) {
    if (!(await spend(env, who, user ? LIMIT.user : LIMIT.guest)) || !(await spend(env, '*', LIMIT.all))) {
      await note('limited', false, 'limited', user ? `ผู้ใช้คนนี้ค้นครบ ${LIMIT.user} รุ่นวันนี้ หรือทั้งระบบครบ ${LIMIT.all}` : `ไม่ได้ล็อกอิน (นับตาม IP) ค้นครบ ${LIMIT.guest} รุ่นวันนี้ หรือทั้งระบบครบ ${LIMIT.all}`);
      return { status: 'limited', key: k, make: v.make, model: v.model, year: v.year };
    }
  }
  await env.DB.prepare(`INSERT INTO car_specs (k, make, model, year, status, created_at, updated_at, by_uid)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(k) DO UPDATE SET status = 'pending', updated_at = excluded.updated_at, error = NULL`)
    .bind(k, v.make, v.model, v.year, now, now, who).run();
  const trail = [];
  const job = (async () => {
    let res;
    try { res = await research(env, v, trail); }
    catch (e) {
      const msg = String((e && e.message) || e).slice(0, 300);
      await env.DB.prepare("UPDATE car_specs SET status = 'failed', error = ?, updated_at = ? WHERE k = ?")
        .bind(msg, Date.now(), k).run();
      await logSpec(env, { k, who, kind: force ? 'redo' : retry ? 'retry' : 'research', ok: false, status: 'failed', err: msg, trail, ms: Date.now() - now });
      return { ...(await getSpec(env, k)), ...(staff ? { trace: trail } : {}) };
    }
    await env.DB.prepare(`UPDATE car_specs SET status = ?, body = ?, data = ?, sources = ?, models = ?, error = NULL, updated_at = ?
        WHERE k = ?`).bind(res.status, res.data && res.data.body, res.data ? JSON.stringify(res.data) : null,
      JSON.stringify(res.sources || []), JSON.stringify(res.models || []), Date.now(), k).run();
    await logSpec(env, { k, who, kind: force ? 'redo' : retry ? 'retry' : 'research', ok: true, status: res.status,
      err: res.passes === 1 ? 'ได้ผลรอบเดียว (อีกรอบไม่สำเร็จ) — ค่าทุกช่องยังไม่ได้ยืนยันซ้ำ' : '', trail, ms: Date.now() - now });
    return { ...(await getSpec(env, k)), ...(staff ? { trace: trail } : {}) };
  })();
  if (!defer) return job;
  /* ค้นนานกว่าที่ควรรอในคำขอเดียว → ตอบ "กำลังค้น" ไปก่อน งานทำต่อเบื้องหลัง หน้าเว็บถามซ้ำเอง */
  const done = await Promise.race([job, new Promise((z) => setTimeout(() => z(null), waitMs))]);
  if (done) return done;
  defer(job);
  return { status: 'pending', key: k, make: v.make, model: v.model, year: v.year, ...(staff ? { trace: trail } : {}) };
}

/* ผู้ใช้แจ้งว่าข้อมูลผิด — วันละไม่เกิน 5 ครั้งต่อคน */
export async function reportSpec(env, k, note, who) {
  const r = await env.DB.prepare('SELECT k FROM car_specs WHERE k = ?').bind(String(k || '')).first();
  if (!r) throw Object.assign(new Error('ไม่พบรุ่นนี้ในคลัง'), { status: 404 });
  if (!(await spend(env, 'rep:' + who, 5))) throw Object.assign(new Error('แจ้งได้วันละ 5 ครั้ง'), { status: 429 });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO car_spec_reports (k, note, who, at) VALUES (?, ?, ?, ?)').bind(r.k, norm(note).slice(0, 500), who, Date.now()),
    env.DB.prepare('UPDATE car_specs SET reports = reports + 1 WHERE k = ?').bind(r.k),
  ]);
  return { ok: true };
}

/* หน้าแอดมิน: รุ่นที่มีคนแจ้งผิดขึ้นก่อน */
export async function listSpecs(env) {
  const { results = [] } = await env.DB.prepare(`SELECT k, make, model, year, status, body, hits, reports, updated_at, sources, data, error
    FROM car_specs ORDER BY reports DESC, updated_at DESC LIMIT 300`).all();
  const { results: reps = [] } = await env.DB.prepare('SELECT k, note, at FROM car_spec_reports ORDER BY at DESC LIMIT 300').all();
  return results.map((r) => {
    let score = null; try { score = r.data ? JSON.parse(r.data).score : null; } catch (e) {}
    let n = 0; try { n = r.sources ? JSON.parse(r.sources).length : 0; } catch (e) {}
    return { key: r.k, make: r.make, model: r.model, year: r.year, status: r.status, body: r.body, hits: r.hits, reports: r.reports, error: r.error || '',
      updated_at: r.updated_at, sources: n, score, notes: reps.filter((x) => x.k === r.k).slice(0, 5).map((x) => ({ note: x.note, at: x.at })) };
  });
}
export async function verifySpec(env, k, on) {
  const r = await env.DB.prepare("UPDATE car_specs SET status = ?, updated_at = ? WHERE k = ? AND status IN ('ready', 'verified')")
    .bind(on ? 'verified' : 'ready', Date.now(), String(k || '')).run();
  if (!r.meta || !r.meta.changes) throw Object.assign(new Error('ยืนยันได้เฉพาะรุ่นที่ค้นข้อมูลสำเร็จแล้ว'), { status: 400 });
  return getSpec(env, k);
}
