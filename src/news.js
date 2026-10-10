import { chatModels } from './fastai.js';

/* ══════════════════════════════════════════════════════════════════
   นิตยสาร Cendon — รวมข่าวรถจากแหล่งข่าวจริง แบบ Google News

   1) ดึง RSS ของเว็บข่าวรถไทยและต่างประเทศพร้อมกัน → ได้หัวข่าว ลิงก์ รูป และเวลาของจริง
   2) ให้ Gemini คัดเฉพาะข่าวรถ เขียนพาดหัว สรุป และเล่าข่าวเป็นภาษาไทย จัดหมวด ให้คะแนนความสำคัญ
      AI เขียนจากเนื้อข่าวที่ดึงมาเท่านั้น ห้ามแต่งข้อเท็จจริงเพิ่ม และทุกข่าวมีลิงก์ไปต้นฉบับ
   3) ถ้าดึงฟีดได้น้อยเกินไป ถอยไปให้ AI ค้นเว็บเอง (แบบเดิม) — นิตยสารต้องไม่ว่าง

   ช่องข่าวแบบเลื่อน (20 ช่อง) — อัปเดตทุก 5 ชั่วโมง
   - แต่ละรอบเพิ่มเฉพาะข่าวที่ยังไม่มี (เทียบลิงก์และพาดหัวต้นฉบับ) ข่าวเดิมอยู่ต่อ
   - รอบละไม่เกิน 6 ข่าว (ข่าวเด่นสุดของรอบ) ยกเว้นตอนช่องยังว่าง จะเติมจนเต็ม
   - ข่าวเกิน 20 เมื่อไร ข่าวที่เก่าที่สุดหลุดออกไป (ข่าวใหม่เข้า ข่าวเก่าสุดออก)
   - ส่งให้ AI สรุปเฉพาะข่าวใหม่ จึงใช้โควตาน้อยลงมาก
   - บทความที่ทีมงานเขียนเอง (origin = manual) ไม่นับในช่อง และไม่ถูกลบ

   Gemini ของนิตยสารแยกจากแชต (โควตาไม่ชนกัน):
   - ตั้ง GEMINI_NEWS_KEY (คีย์จากอีกโปรเจกต์ Google) = แยกโควตาขาดจากแชตทั้งหมด
   - ยังไม่ตั้ง = ใช้คีย์เดิม แต่ไม่ใช้รุ่นที่แชตใช้ตอบเป็นหลัก (อ่านจากรายการของแชตเองทุกครั้ง
     แชตเปลี่ยนลำดับรุ่นเมื่อไร นิตยสารหลบตามเอง) — Gemini นับโควตาแยกตามรุ่น
   - GEMINI_NEWS_MODEL บังคับรุ่นเองได้

   ผลแต่ละรอบ (แหล่งไหนได้กี่ข่าว ใช้รุ่นไหน ผิดพลาดอะไร) เก็บใน config: news_status ให้หน้าแอดมินดู
   ══════════════════════════════════════════════════════════════════ */

/* แหล่งข่าว — แก้รายการได้โดยไม่ต้องแก้โค้ด: ตั้ง NEWS_FEEDS เป็น JSON [{name,url,lang}] */
export const FEEDS = [
  { name: 'Headlightmag', url: 'https://www.headlightmag.com/feed/', lang: 'th' },
  { name: 'Autolife Thailand', url: 'https://www.autolifethailand.tv/feed/', lang: 'th' },
  { name: 'Motortrivia', url: 'https://www.motortrivia.com/feed/', lang: 'th' },
  { name: 'Autospinn', url: 'https://www.autospinn.com/feed', lang: 'th' },
  { name: 'Carsideteam', url: 'https://www.carsideteam.com/feed/', lang: 'th' },
  { name: 'Google News', url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('ข่าวรถยนต์ when:2d') + '&hl=th&gl=TH&ceid=TH:th', lang: 'th', google: true },
  { name: 'Motor1', url: 'https://www.motor1.com/rss/news/all/', lang: 'en' },
  { name: 'InsideEVs', url: 'https://insideevs.com/rss/news/all/', lang: 'en' },
  { name: 'Electrek', url: 'https://electrek.co/feed/', lang: 'en' },
  { name: 'Car and Driver', url: 'https://www.caranddriver.com/rss/all.xml/', lang: 'en' },
];

export const CATS = ['ข่าวเด่น', 'รถใหม่', 'EV', 'รีวิว', 'เทคโนโลยี', 'ราคา', 'ตลาดรถ', 'มอเตอร์สปอร์ต', 'เคล็ดลับ', 'นโยบาย'];

const DAY = 86400000;
export const NEWS_SLOTS = 20;                 // ช่องข่าวทั้งหมด (ไม่นับบทความทีมงาน)
export const NEWS_PER_ROUND = 6;              // ข่าวใหม่ต่อรอบ (ช่องยังว่างจะเติมจนเต็ม)
export const NEWS_EVERY = 5 * 3600000;        // อัปเดตทุก 5 ชั่วโมง
const slotsOf = (env) => Math.max(1, Math.min(60, Number(env.NEWS_SLOTS) || NEWS_SLOTS));
const perRoundOf = (env) => Math.max(1, Math.min(30, Number(env.NEWS_PER_ROUND) || NEWS_PER_ROUND));

/* ─────────── อ่าน RSS / Atom (Workers ไม่มี DOMParser — แยกด้วย regex ให้เบา CPU) ─────────── */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·' };
export function decode(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const cdata = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
/* HTML → ข้อความล้วน (บางฟีดเข้ารหัส HTML มาสองชั้น จึงถอดก่อนแล้วตัดแท็กอีกรอบ) */
export function plain(html) {
  let s = cdata(html);
  if (/&lt;\/?[a-z]/i.test(s)) s = decode(s);
  return decode(s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/h\d>|<\/li>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function tag(block, name) {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(block);
  return m ? cdata(m[1]).trim() : '';
}
function attr(block, name, at) {
  const m = new RegExp('<' + name + '\\b[^>]*\\b' + at + '\\s*=\\s*["\']([^"\']+)["\']', 'i').exec(block);
  return m ? decode(m[1]) : '';
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* รูปประจำข่าว: media:content / media:thumbnail → enclosure รูป → <img> แรกในเนื้อข่าว · รับเฉพาะ https */
function imageOf(block) {
  const cands = [];
  const re = /<media:(?:content|thumbnail)\b[^>]*>/gi;
  let m;
  while ((m = re.exec(block))) {
    const u = /\burl=["']([^"']+)["']/i.exec(m[0]);
    if (u && !/\b(?:medium|type)=["'](?:video|audio)/i.test(m[0])) cands.push(u[1]);
  }
  const enc = /<enclosure\b[^>]*>/i.exec(block);
  if (enc) {
    const u = /\burl=["']([^"']+)["']/i.exec(enc[0]);
    if (u && (/type=["']image/i.test(enc[0]) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u[1]))) cands.push(u[1]);
  }
  const html = decode(cdata(tag(block, 'content:encoded') + ' ' + tag(block, 'description') + ' ' + tag(block, 'content')));
  const img = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(html);
  if (img) cands.push(img[1]);
  for (const c of cands) {
    const u = decode(c).trim().replace(/^http:\/\//i, 'https://');
    if (/^https:\/\/[^\s"'<>]+$/i.test(u) && !/(pixel|spacer|feedburner|gravatar|emoji|1x1|blank\.gif)/i.test(u)) return u.slice(0, 1000);
  }
  return '';
}

export function parseFeed(xml, feed, now = Date.now()) {
  const out = [];
  const body = String(xml || '').slice(0, 600000);
  const re = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = re.exec(body)) && out.length < 25) {
    const b = m[0];
    let title = plain(tag(b, 'title')).replace(/\s+/g, ' ');
    let link = decode(tag(b, 'link')).trim();
    if (!/^https?:\/\//i.test(link)) link = attr(b, 'link', 'href').trim();
    const at = Date.parse(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')) || 0;
    let source = feed.name;
    if (feed.google) {
      const s = plain(tag(b, 'source'));
      if (s) { source = s; title = title.replace(new RegExp('\\s+[-–—]\\s+' + escRe(s) + '\\s*$'), ''); }
    }
    if (!title || !/^https?:\/\//i.test(link)) continue;
    out.push({
      title: title.slice(0, 240), url: link.slice(0, 1000), source: source.slice(0, 80), lang: feed.lang || 'th',
      at: at && at <= now + 3600000 ? at : 0,
      /* Google News ให้แค่หัวข่าว — เนื้อข่าวว่าง AI จะเขียนสั้นตามจริง */
      text: feed.google ? '' : plain(tag(b, 'content:encoded') || tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 1500),
      image: imageOf(b),
    });
  }
  return out;
}

/* ─────────── ดึงข้อมูลจากเว็บ (มีเวลาจำกัด และอ่านไม่เกิน max ไบต์) ─────────── */
const UA = 'Mozilla/5.0 (compatible; CendonNews/1.0; +https://cendon-beta.pages.dev)';
async function fetchText(url, ms, max) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!r.body) return '';
    const reader = r.body.getReader(), chunks = [];
    let got = 0;
    while (got < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
    }
    try { await reader.cancel(); } catch (e) {}
    const all = new Uint8Array(Math.min(got, max));
    let off = 0;
    for (const c of chunks) { if (off >= all.length) break; all.set(c.subarray(0, all.length - off), off); off += c.length; }
    return new TextDecoder().decode(all);
  } finally { clearTimeout(timer); }
}

function feedsOf(env) {
  try { const v = JSON.parse(env.NEWS_FEEDS || 'null'); if (Array.isArray(v) && v.length) return v.filter((f) => f && /^https:\/\//.test(f.url)); } catch (e) {}
  return FEEDS;
}

/* ─────────── คัดข่าว: สดไม่เกิน 4 วัน · ตัดซ้ำ · แหล่งละไม่เกิน 6 · ข่าวไทยก่อน ข่าวต่างประเทศไม่เกินราว 1/3 ─────────── */
const keyOf = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 48);
export function pick(items, now = Date.now()) {
  const fresh = items.filter((x) => !x.at || now - x.at < 4 * DAY).sort((a, b) => (b.at || 0) - (a.at || 0));
  const seen = new Set(), per = {}, out = [];
  for (const x of fresh) {
    const k = keyOf(x.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    per[x.source] = (per[x.source] || 0) + 1;
    if (per[x.source] > 6) continue;
    out.push(x);
  }
  const th = out.filter((x) => x.lang === 'th'), en = out.filter((x) => x.lang !== 'th');
  return [...th.slice(0, 20), ...en.slice(0, 10)].slice(0, 28);
}

/* ─────────── Gemini ของนิตยสาร ─────────── */
const NEWS_MODELS = ['gemini-2.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
export function newsAI(env) {
  const own = !!env.GEMINI_NEWS_KEY;
  /* คีย์เดียวกับแชต: ตัดรุ่นที่แชตใช้ตอบเป็นหลัก (สองตัวแรกในรายการของแชต) ออก */
  const chatMain = own ? [] : chatModels(env).slice(0, 2);
  const models = [env.GEMINI_NEWS_MODEL, ...(own
    ? ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash']
    : NEWS_MODELS.filter((m) => !chatMain.includes(m)))]
    .map((m) => String(m || '').trim()).filter(Boolean);
  return { key: env.GEMINI_NEWS_KEY || env.GEMINI_KEY || '', own, models: [...new Set(models)], chatMain };
}

async function gemini(env, ai, { prompt, json = true, search = false, maxTokens = 8192 }) {
  if (!ai.key) throw new Error('ยังไม่ได้ตั้งคีย์ Gemini');
  const base = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  let last = null;
  for (const model of ai.models) {
    const gen = { temperature: 0.3, maxOutputTokens: maxTokens };
    if (json) {
      gen.responseMimeType = 'application/json';
      if (/gemini-3|gemini-[4-9]/.test(model)) gen.thinkingConfig = { thinkingLevel: 'minimal' };
      else if (/2\.5/.test(model)) gen.thinkingConfig = { thinkingBudget: 0 };
    }
    const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: gen };
    /* ค้นเว็บใช้คู่กับบังคับ JSON ไม่ได้ */
    if (search && !json) body.tools = [{ google_search: {} }];
    try {
      const send = () => fetch(`${base}/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ai.key }, body: JSON.stringify(body) });
      let r = await send();
      /* บางรุ่นไม่รับค่าการคิดที่ตั้งไป (ตอบ 400) — ลองอีกครั้งแบบไม่ตั้ง */
      if (r.status === 400 && gen.thinkingConfig) { delete gen.thinkingConfig; r = await send(); }
      if (!r.ok) { last = new Error(`${model} ตอบ ${r.status}`); continue; }
      const j = await r.json();
      const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      const text = parts.map((p) => p.text || '').join('');
      if (!text.trim()) { last = new Error(model + ' ตอบว่าง'); continue; }
      return { text, model };
    } catch (e) { last = e; }
  }
  throw last || new Error('ไม่มีรุ่น Gemini ให้ใช้');
}

export function parseArr(text) {
  let s = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const m = s.match(/\[[\s\S]*\]/);
  if (m) s = m[0];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch (e) { return null; }
}

const EDITOR = `คุณคือบรรณาธิการนิตยสารรถยนต์ภาษาไทยของ Cendon เขียนให้คนใช้รถในไทยอ่าน กระชับ น่าเชื่อถือ ไม่เว่อร์`;
function enrichPrompt(batch) {
  return `${EDITOR}

ด้านล่างคือข่าวที่ดึงมาจากแหล่งข่าวจริง (JSON) สำหรับแต่ละข่าว ให้ตอบ:
- keep: true เฉพาะข่าวที่เกี่ยวกับรถยนต์ มอเตอร์ไซค์ การขับขี่ อุตสาหกรรมรถ EV ประกันหรือภาษีรถ กฎจราจร ที่คนใช้รถในไทยน่าจะสนใจ · ข่าวที่ไม่เกี่ยวกับรถ อาชญากรรมทั่วไป โฆษณาขายของ หรือซ้ำกับข่าวอื่นในชุด → false
- title: พาดหัวภาษาไทย กระชับ น่าอ่าน ไม่เกิน 80 ตัวอักษร ชื่อยี่ห้อ/รุ่นคงเป็นภาษาอังกฤษ ห้ามคลิกเบต
- summary: สรุปภาษาไทย 1–2 ประโยค ไม่เกิน 200 ตัวอักษร
- points: ข้อเท็จจริงสำคัญ 2–4 ข้อ ภาษาไทยสั้น ๆ (ราคา สเปก วันที่ ตัวเลข) — ถ้าเนื้อข่าวไม่มี ให้ใส่น้อยข้อตามจริง
- body: เล่าข่าวภาษาไทย 2–4 ย่อหน้าสั้น ไม่เกิน 700 ตัวอักษร แยกย่อหน้าด้วย \\n\\n · ถ้าเนื้อข่าวน้อยให้สั้นตามจริง
- category: เลือก 1 จาก ${JSON.stringify(CATS)}
- score: 1–5 ความสำคัญต่อคนใช้รถในไทย (5 = ข่าวใหญ่ที่ทุกคนควรรู้)
ห้ามแต่งข้อเท็จจริง ตัวเลข ราคา หรือคำพูดที่ไม่มีในข่าว ข่าวภาษาอังกฤษให้เรียบเรียงเป็นไทย
ตอบเป็น JSON array เท่านั้น เช่น [{"i":0,"keep":true,"title":"","summary":"","points":[""],"body":"","category":"ข่าวเด่น","score":3}]

ข่าว:
${JSON.stringify(batch.map((x) => ({ i: x.i, source: x.source, title: x.title, text: x.text.slice(0, 900) })))}`;
}

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+\n/g, '\n').trim().slice(0, n);
async function enrich(env, ai, items) {
  const batches = [];
  for (let k = 0; k < items.length; k += 10) batches.push(items.slice(k, k + 10).map((x, j) => ({ ...x, i: k + j })));
  let model = '';
  const res = await Promise.allSettled(batches.map((b) => gemini(env, ai, { prompt: enrichPrompt(b) }).then((r) => { model = r.model; return parseArr(r.text) || []; })));
  const by = new Map();
  for (const r of res) if (r.status === 'fulfilled') for (const o of r.value) if (o && Number.isInteger(o.i)) by.set(o.i, o);
  if (!by.size) {
    const err = res.find((r) => r.status === 'rejected');
    throw new Error('AI สรุปข่าวไม่สำเร็จ' + (err ? ': ' + err.reason.message : ''));
  }
  const out = [];
  items.forEach((x, i) => {
    const o = by.get(i);
    if (!o || o.keep === false || !o.title) return;
    out.push({ ...x, title: clip(o.title, 140), summary: clip(o.summary, 300), body: clip(o.body, 1600),
      points: (Array.isArray(o.points) ? o.points : []).map((p) => clip(p, 160)).filter(Boolean).slice(0, 4),
      category: CATS.includes(o.category) ? o.category : 'ข่าวเด่น',
      score: Math.max(1, Math.min(5, Math.round(Number(o.score) || 2))) });
  });
  return { items: out, model };
}

/* ข่าวที่ฟีดไม่มีรูป: ดูรูปปกจากหน้าเว็บ (og:image) — ไม่เกิน 8 หน้า ต่อรอบ */
const OG = /<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)(?::src)?["'][^>]*>/i;
async function ogImage(url) {
  try {
    const html = await fetchText(url, 5000, 90000);
    const m = OG.exec(html);
    const c = m && /\bcontent=["']([^"']+)["']/i.exec(m[0]);
    const u = c ? decode(c[1]).trim().replace(/^http:\/\//i, 'https://') : '';
    return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u.slice(0, 1000) : '';
  } catch (e) { return ''; }
}

/* ทางสำรอง: ดึงฟีดไม่ได้เลย ให้ AI ค้นเว็บสรุปข่าวเอง (ไม่มีรูป/ลิงก์ แต่หน้านิตยสารไม่ว่าง) */
async function aiSearchNews(env, ai) {
  const r = await gemini(env, ai, { json: false, search: true, prompt: `${EDITOR}

ค้นเว็บหาข่าวรถยนต์ล่าสุดที่คนใช้รถในไทยควรรู้ (ไม่เกิน 3 วัน) ทั้งข่าวไทยและต่างประเทศ เลือก 12–16 ข่าว
ตอบเป็น JSON array เท่านั้น ห้ามมีคำนำหรือ markdown:
[{"title":"พาดหัวไทย ไม่เกิน 80 ตัวอักษร","summary":"สรุป 1–2 ประโยค","points":["ข้อเท็จจริงสั้น ๆ"],"body":"เล่าข่าว 2–4 ย่อหน้าสั้น","category":"เลือกจาก ${CATS.join(' / ')}","score":3,"source":"ชื่อสำนักข่าวต้นทาง"}]
ห้ามแต่งตัวเลขหรือราคาที่ไม่แน่ใจ` });
  const arr = parseArr(r.text) || [];
  const now = Date.now();
  return { model: r.model, items: arr.filter((o) => o && o.title).slice(0, 16).map((o) => ({
    title: clip(o.title, 140), summary: clip(o.summary, 300), body: clip(o.body, 1600),
    points: (Array.isArray(o.points) ? o.points : []).map((p) => clip(p, 160)).filter(Boolean).slice(0, 4),
    category: CATS.includes(o.category) ? o.category : 'ข่าวเด่น', score: Math.max(1, Math.min(5, Math.round(Number(o.score) || 2))),
    source: clip(o.source, 80), url: '', image: '', at: now, lang: 'th' })) };
}

/* ข่าวเด่นสุดขึ้นก่อน (ให้น้ำหนักข่าวที่มีรูป เพราะขึ้นเป็นภาพใหญ่หัวหน้า) แล้วตามความสด */
export function rank(items, now = Date.now()) {
  const v = (x) => x.score * 10 + (x.image ? 6 : 0) - Math.min(10, (now - (x.at || now)) / (6 * 3600000));
  return [...items].sort((a, b) => v(b) - v(a));
}

/* ─────────── รอบอัปเดต ─────────── */
async function note(env, key, value) {
  try {
    await env.DB.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(key, JSON.stringify(value)).run();
  } catch (e) {}
}

export async function refreshNews(env, { force = false } = {}) {
  const now = Date.now();
  const SLOTS = slotsOf(env), PER = perRoundOf(env);
  if (!force) {
    /* cron เรียกทุกชั่วโมง แต่ทำงานจริงเมื่อครบ 5 ชั่วโมงจากรอบล่าสุด
       (รอบล่าสุดพลาด ลองใหม่ในชั่วโมงถัดไป ไม่ต้องรอ 5 ชั่วโมง) */
    const last = await newsStatus(env);
    if (last && last.at && now - last.at < (last.error ? 50 * 60000 : NEWS_EVERY - 15 * 60000)) return { skipped: true, next_at: last.next_at || 0 };
    /* กันรันซ้อน (cron กับปุ่มในหน้าแอดมินพร้อมกัน) — ล็อกไว้ 10 นาที */
    try {
      const l = await env.DB.prepare("SELECT value FROM config WHERE key = 'news_lock'").first();
      if (l && now - JSON.parse(l.value) < 600000) return { skipped: true };
    } catch (e) {}
  }
  await note(env, 'news_lock', now);
  const ai = newsAI(env);
  const status = { at: now, next_at: now + NEWS_EVERY, mode: 'feeds', own: ai.own, model: '', feeds: [], picked: 0,
    fresh: 0, added: 0, removed: 0, total: 0, slots: SLOTS, error: '' };
  try {
    /* ข่าวที่มีอยู่แล้ว — ใช้กันข่าวซ้ำ และดูว่าช่องยังว่างกี่ช่อง */
    const { results: have = [] } = await env.DB.prepare(
      "SELECT url, src_key, title FROM magazine WHERE origin IS NULL OR origin <> 'manual'").all();
    const seenUrl = new Set(have.map((r) => r.url).filter(Boolean));
    const seenKey = new Set(have.flatMap((r) => [r.src_key, keyOf(r.title)]).filter(Boolean));
    /* ข่าวที่ AI เคยคัดทิ้ง (ไม่ใช่ข่าวรถ) จำไว้ จะได้ไม่ส่งให้ AI ดูซ้ำทุกรอบ */
    let skip = [];
    try { const r = await env.DB.prepare("SELECT value FROM config WHERE key = 'news_skip'").first(); skip = r ? JSON.parse(r.value) : []; } catch (e) {}
    const skipSet = new Set(Array.isArray(skip) ? skip : []);
    const isNew = (x) => !(x.url && seenUrl.has(x.url)) && !seenKey.has(keyOf(x.title)) && !skipSet.has(x.url || keyOf(x.title));
    const want = Math.max(PER, SLOTS - have.length);

    const feeds = feedsOf(env);
    const got = await Promise.all(feeds.map(async (f) => {
      try {
        const items = parseFeed(await fetchText(f.url, 8000, 400000), f, now);
        status.feeds.push({ name: f.name, n: items.length, err: items.length ? '' : 'ไม่พบข่าวในฟีด' });
        return items;
      } catch (e) {
        status.feeds.push({ name: f.name, n: 0, err: String((e && e.message) || e).slice(0, 80) });
        return [];
      }
    }));
    const picked = pick(got.flat(), now);
    status.picked = picked.length;

    let result = { items: [], model: '' };
    if (picked.length >= 6) {
      /* ส่งให้ AI เฉพาะข่าวใหม่ (เผื่อ AI คัดข่าวที่ไม่ใช่ข่าวรถทิ้งบ้าง) */
      const fresh = picked.filter(isNew).map((x) => ({ ...x, srcKey: keyOf(x.title) }));
      status.fresh = fresh.length;
      if (fresh.length) {
        const sent = fresh.slice(0, Math.min(28, want * 2 + 4));
        result = await enrich(env, ai, sent);
        const kept = new Set(result.items.map((x) => x.srcKey));
        const dropped = sent.filter((x) => !kept.has(x.srcKey)).map((x) => x.url || x.srcKey);
        if (dropped.length) await note(env, 'news_skip', [...skipSet, ...dropped].slice(-400));
        /* รูปปกที่ฟีดไม่ได้ให้มา — ดูจากหน้าเว็บต้นฉบับ (ข้ามลิงก์ของ Google News ที่เป็นหน้าพาไปต่อ) */
        const need = rank(result.items, now).slice(0, want).filter((x) => !x.image && x.url && !/news\.google\./.test(x.url)).slice(0, 8);
        await Promise.all(need.map(async (x) => { x.image = await ogImage(x.url); }));
      }
    } else {
      status.mode = 'ai';
      result = await aiSearchNews(env, ai);
      result.items = result.items.filter(isNew).map((x) => ({ ...x, srcKey: keyOf(x.title) }));
      status.fresh = result.items.length;
    }
    status.model = result.model;
    const rows = rank(result.items, now).slice(0, want);
    status.added = rows.length;

    const INS = `INSERT INTO magazine (title, short_description, full_description, type, created_at,
      source, url, image, published_at, origin, points, sort, src_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    /* ข่าวใหม่เข้า → เกิน 20 ช่องเมื่อไร ข่าวที่เก่าที่สุดหลุดออก (รอบเก่าสุดก่อน ในรอบเดียวกันข่าวอันดับท้ายก่อน)
       บทความที่ทีมงานเขียนเอง (origin = manual) ไม่นับและไม่ถูกลบ */
    const out = await env.DB.batch([
      ...rows.map((x, k) => env.DB.prepare(INS).bind(x.title, x.summary, x.body, x.category, now, x.source || '', x.url || '', x.image || '',
        x.at || now, status.mode === 'ai' ? 'ai' : 'feed', JSON.stringify(x.points || []), k + 1, x.srcKey || keyOf(x.title))),
      env.DB.prepare(`DELETE FROM magazine WHERE id IN (SELECT id FROM magazine WHERE origin IS NULL OR origin <> 'manual'
        ORDER BY created_at DESC, COALESCE(sort, 9999) ASC, id DESC LIMIT -1 OFFSET ?)`).bind(SLOTS),
    ]);
    const del = out[out.length - 1];
    status.removed = (del && del.meta && Number(del.meta.changes)) || 0;
    status.total = Math.min(SLOTS, have.length + rows.length);
  } catch (e) {
    status.error = String((e && e.message) || e).slice(0, 300);
    status.next_at = now + 3600000;
  }
  await note(env, 'news_status', status);
  await note(env, 'news_lock', 0);
  return status;
}

export async function newsStatus(env) {
  try {
    const r = await env.DB.prepare("SELECT value FROM config WHERE key = 'news_status'").first();
    return r ? JSON.parse(r.value) : null;
  } catch (e) { return null; }
}
