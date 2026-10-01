/* ══ AI ช่วยคัดกรองใบสมัครช่าง ══
   ไม่ได้อนุมัติแทนคน — ให้คะแนนความเสี่ยงพร้อมเหตุผล คนกดอนุมัติดูแค่จุดที่ AI สงสัย
   ด่านเรียงจากถูกสุดไปแพงสุด:
   1) ตรวจในระบบเอง (ไม่ใช้ AI): เลขบัตรซ้ำบัญชีอื่น · รูปซ้ำบัญชีอื่น/ซ้ำในใบเดียวกัน · อายุกับวันเกิดไม่ตรง
   2) Gemini ดูรูป: รูปอู่/ผลงานเป็นงานซ่อมรถจริงไหม (ส่งเสมอ)
      รูปบัตร + เซลฟี่ส่งให้ Gemini เฉพาะเมื่อตั้ง TECH_AI_IDS=1 — เป็นข้อมูลอ่อนไหวตาม PDPA
      ควรเปิดหลังเปิด billing ของ Gemini แล้วเท่านั้น (Free Tier อาจนำข้อมูลไปปรับปรุงโมเดล) */

const W = { high: 40, medium: 15, low: 5 };

export async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/* ชื่อเทียบแบบหยาบ: ตัดคำนำหน้า ช่องว่าง จุด แล้วดูว่าชื่อจริงกับนามสกุลอยู่ในอีกฝั่งไหม */
export function nameMatch(form, card) {
  const n = s => String(s || '').toLowerCase().replace(/^(นาย|นางสาว|นาง|น\.ส\.|mr\.?|mrs\.?|ms\.?|miss)\s*/i, '').replace(/[\s.]/g, '');
  const a = n(form), b = n(card);
  if (!a || !b) return null;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const parts = String(form || '').trim().split(/\s+/).filter(p => p.length > 1).map(n);
  return parts.length >= 2 && parts.every(p => b.includes(p));
}

export function ageFromBirth(birth, at = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birth || ''));
  if (!m) return null;
  let y = +m[1]; if (y > 2400) y -= 543;               /* กรอกเป็น พ.ศ. */
  const d = new Date(at), b = new Date(Date.UTC(y, +m[2] - 1, +m[3]));
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

const PROMPT_IDS = `คุณช่วยคัดกรองใบสมัครช่างซ่อมรถของแอป Cendon ประเทศไทย ดูรูปที่แนบแล้วตอบเป็น JSON เท่านั้น
รูปแต่ละรูปมีป้ายนำหน้า [id] [selfie] [shop] [work] บอกชนิด
{
 "id_card": {"is_thai_id_card": bool, "photo_of_screen_or_printout": bool, "edited_or_fake_suspected": bool, "readable": bool,
             "name_on_card": "ชื่อ-นามสกุลตามบัตร (ไทยหรืออังกฤษ)", "id_on_card": "เลข 13 หลัก", "birth_on_card": "YYYY-MM-DD ค.ศ. ถ้าอ่านได้"},
 "selfie": {"person_holding_id_card": bool, "same_person_as_card": "yes|no|unsure"},
 "work": [{"label": "shop|work", "real_car_repair_or_tools": bool, "stock_or_internet_photo_suspected": bool, "note": "สั้น ๆ"}],
 "summary": "สรุปสั้น ๆ ภาษาไทย 1-2 ประโยคว่าน่าสงสัยตรงไหน"
}
ถ้าไม่มีรูปบัตรหรือเซลฟี่ ให้ตอบ id_card/selfie เป็น null · ห้ามเดา ถ้าไม่แน่ใจให้ตอบ unsure หรือ false`;

const PROMPT_WORK = `คุณช่วยคัดกรองใบสมัครช่างซ่อมรถของแอป Cendon ประเทศไทย ดูรูปอู่/เครื่องมือ/ผลงานที่แนบแล้วตอบเป็น JSON เท่านั้น
รูปแต่ละรูปมีป้ายนำหน้า [shop] หรือ [work]
{"work": [{"label": "shop|work", "real_car_repair_or_tools": bool, "stock_or_internet_photo_suspected": bool, "note": "สั้น ๆ"}],
 "summary": "สรุปสั้น ๆ ภาษาไทย 1-2 ประโยค"}
ห้ามเดา ถ้าไม่แน่ใจให้ตอบ false`;

async function askGemini(env, parts, prompt) {
  const base = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const model = env.TECH_AI_MODEL || env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 25000);
  try {
    const res = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }, ...parts] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const d = await res.json();
    const txt = ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || []).map(p => p.text || '').join('');
    const m = txt.match(/\{[\s\S]*\}/);
    return { model, out: m ? JSON.parse(m[0]) : null };
  } finally { clearTimeout(tm); }
}

/* app = แถว tech_applications · docs = [{kind,mime,data,hash}] ของใบนี้ · others = ข้อมูลซ้ำจากบัญชีอื่น */
export async function screenApplication(env, { app, docs, dupIdCount = 0, dupImageKinds = [] }, { at = Date.now() } = {}) {
  const d = typeof app.data === 'string' ? JSON.parse(app.data) : (app.data || {});
  const flags = [];
  const add = (level, msg) => flags.push({ level, msg });

  /* ── ด่าน 1: ตรวจในระบบ ── */
  if (dupIdCount > 0) add('high', `เลขบัตรนี้ถูกใช้สมัครในบัญชีอื่นแล้ว ${dupIdCount} บัญชี`);
  for (const k of [...new Set(dupImageKinds)]) add('high', `รูป${KIND[k] || k}ซ้ำกับรูปในบัญชีอื่น`);
  const seen = new Map();
  for (const x of docs) {
    if (!x.hash) continue;
    if (seen.has(x.hash)) add('high', `ใช้รูปเดียวกันซ้ำ (${KIND[seen.get(x.hash)] || seen.get(x.hash)} กับ ${KIND[x.kind] || x.kind})`);
    else seen.set(x.hash, x.kind);
  }
  const ba = ageFromBirth(d.birth, at);
  if (ba != null && d.age != null && Math.abs(ba - Number(d.age)) > 1) add('medium', `อายุที่กรอก (${d.age}) ไม่ตรงกับวันเกิด (${ba} ปี)`);
  if (ba != null && ba < 18) add('high', 'อายุตามวันเกิดต่ำกว่า 18 ปี');
  if (!d.hasCert) add('low', 'ไม่มีใบรับรอง — ต้องสัมภาษณ์ทักษะ');

  /* ── ด่าน 2: Gemini ดูรูป ── */
  let ai = null, aiErr = '';
  const withIds = env.TECH_AI_IDS === '1';
  const pick = docs.filter(x => withIds ? ['id', 'selfie', 'shop', 'work'].includes(x.kind) : ['shop', 'work'].includes(x.kind))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)).slice(0, 7);
  if (env.GEMINI_KEY && pick.length) {
    try {
      const parts = pick.flatMap(x => [{ text: `[${x.kind}]` }, { inline_data: { mime_type: x.mime, data: x.data } }]);
      const r = await askGemini(env, parts, withIds ? PROMPT_IDS : PROMPT_WORK);
      ai = r.out; ai && (ai.model = r.model);
    } catch (e) { aiErr = String(e.message || e).slice(0, 160); }
  }
  if (ai) {
    const c = withIds ? ai.id_card : null;
    if (c) {
      if (c.is_thai_id_card === false) add('high', 'AI: รูปบัตรไม่ใช่บัตรประชาชนไทย');
      if (c.photo_of_screen_or_printout) add('high', 'AI: รูปบัตรถ่ายจากจอหรือสำเนา ไม่ใช่บัตรจริง');
      if (c.edited_or_fake_suspected) add('high', 'AI: สงสัยว่ารูปบัตรถูกแต่ง');
      if (c.readable === false) add('medium', 'AI: อ่านข้อมูลบนบัตรไม่ได้ ภาพไม่ชัด');
      const cid = String(c.id_on_card || '').replace(/\D/g, '');
      if (cid.length === 13 && d.idNo && cid !== String(d.idNo).replace(/\D/g, '')) add('high', 'AI: เลขบนบัตรไม่ตรงกับเลขที่กรอก');
      const nm = nameMatch(d.name, c.name_on_card);
      if (nm === false) add('high', `AI: ชื่อบนบัตร "${String(c.name_on_card).slice(0, 60)}" ไม่ตรงกับที่กรอก`);
      const cb = ageFromBirth(c.birth_on_card, at);
      if (cb != null && ba != null && Math.abs(cb - ba) > 1) add('medium', 'AI: วันเกิดบนบัตรไม่ตรงกับที่กรอก');
    }
    const s = withIds ? ai.selfie : null;
    if (s) {
      if (s.person_holding_id_card === false) add('medium', 'AI: รูปคู่บัตรไม่เห็นคนถือบัตร');
      if (s.same_person_as_card === 'no') add('high', 'AI: หน้าในเซลฟี่ไม่น่าจะเป็นคนเดียวกับในบัตร');
      if (s.same_person_as_card === 'unsure') add('low', 'AI: ยืนยันไม่ได้ว่าหน้าในเซลฟี่ตรงกับบัตร');
    }
    const w = Array.isArray(ai.work) ? ai.work : [];
    const notReal = w.filter(x => x && x.real_car_repair_or_tools === false).length;
    const stock = w.filter(x => x && x.stock_or_internet_photo_suspected).length;
    if (w.length && notReal >= Math.ceil(w.length / 2)) add('high', `AI: รูปอู่/ผลงาน ${notReal}/${w.length} รูปไม่ใช่งานซ่อมรถ`);
    else if (notReal) add('medium', `AI: รูปอู่/ผลงาน ${notReal} รูปไม่ใช่งานซ่อมรถ`);
    if (stock) add(stock >= 2 ? 'high' : 'medium', `AI: สงสัยว่าเป็นรูปจากอินเทอร์เน็ต ${stock} รูป`);
  }

  const score = Math.max(0, 100 - flags.reduce((n, f) => n + W[f.level], 0));
  const highs = flags.filter(f => f.level === 'high').length;
  const meds = flags.filter(f => f.level === 'medium').length;
  const verdict = highs >= 2 || score < 40 ? 'fail' : highs || meds || score < 80 || !ai ? 'review' : 'pass';
  return {
    verdict, score, flags, at,
    vision: ai ? (withIds ? 'บัตร+เซลฟี่+ผลงาน' : 'ผลงานเท่านั้น (ยังไม่เปิด TECH_AI_IDS)') : (aiErr ? 'AI ดูรูปไม่สำเร็จ' : 'ไม่ได้ใช้ AI ดูรูป'),
    summary: ai && ai.summary ? String(ai.summary).slice(0, 400) : '',
    model: ai && ai.model || '', error: aiErr,
  };
}

const KIND = { id: 'บัตรประชาชน', selfie: 'คู่บัตร', shop: 'อู่', work: 'ผลงาน', cert: 'ใบรับรอง' };
const ORDER = ['id', 'selfie', 'shop', 'work', 'cert'];
