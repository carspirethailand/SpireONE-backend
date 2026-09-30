/* ══ เครื่องตอบเร็วของ Cendon ══
   ของเดิมต่อหนึ่งข้อความ: ค้นเว็บแยก (ไล่ลองได้ถึง 21 ครั้งกับโมเดลที่เลิกให้บริการแล้ว)
   → อ่านรูปแยกอีกหนึ่งครั้ง → ส่งให้โมเดลฟรีที่คิดนานแล้วค่อยตอบ → พลาดก็ถามซ้ำ
   ตอนนี้เหลือการเรียกครั้งเดียว: Gemini ค้นเว็บเอง เห็นรูปเอง คิด แล้วสตรีมคำตอบออกมาทันที

   โมเดลเลือกจาก GEMINI_SEARCH_MODEL (ค่าเริ่มต้น gemini-3.5-flash-lite) แล้วถอยไป GEMINI_MODEL
   ถ้าชื่อโมเดลไหนใช้ไม่ได้ (404/400) จะรู้ภายในเสี้ยววินาทีแล้วข้ามไปตัวถัดไปเอง */

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

/* โทเคนโดยประมาณของข้อความล่าสุดที่ผู้ใช้ส่ง (ตัวอักษร/3 + รูปละ 300) — ใช้คิดโควตา */
function userTokens(contents) {
  const u = [...(contents || [])].reverse().find(c => c && c.role === 'user');
  if (!u) return 0;
  let n = 0;
  for (const p of u.parts || []) n += p.text ? Math.ceil(p.text.length / 3) : 300;
  return n;
}

/* โมเดลที่ใช้ตอบ + ค้นเว็บ เรียงตามลำดับที่จะลอง
   - ตัวหลัก: gemini-3.5-flash-lite, gemini-3.1-flash-lite
   - ตัวรอง: gemini-3.6-flash, gemini-3.8-flash
   Gemma ใช้เครื่องมือค้นเว็บไม่ได้ จึงไม่เอามาใช้ในงานนี้ แม้จะตั้งไว้ในตัวแปร */
export function chatModels(env) {
  /* ท้ายรายการเป็นรุ่นที่ Google เปิดให้ใช้มานานและเสถียร — กันกรณีชื่อรุ่นที่ตั้งไว้ใช้ไม่ได้ทั้งหมด แชตจะไม่ล่มทั้งระบบ */
  const list = [
    env?.GEMINI_CHAT_MODEL,
    env?.GEMINI_SEARCH_MODEL || DEFAULT_MODEL,
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.8-flash',
    env?.GEMINI_MODEL,
    'gemini-2.5-flash'
  ]
    .map(m => String(m || '').trim())
    .filter(m => m && !/^gemma/i.test(m));
  return [...new Set(list)];
}

/* ระดับการคิด — คิดมากขึ้นเฉพาะเรื่องที่ต้องคิดจริง คำถามสั้นหรือคุยเล่นตอบไวกว่า */
export function thinkingFor(question, hasMedia, skillIds) {
  const q = String(question || '');
  const hard = hasMedia || (skillIds && skillIds.length) || q.length > 140
    || /อาการ|เสียง|สั่น|รั่ว|ไฟโชว์|ไฟเตือน|สตาร์ท|ดับ|กระตุก|ร้อน|ควัน|วินิจฉัย|สาเหตุ|ทำไม|เปรียบเทียบ|เทียบ|คุ้ม|แนะนำ|diagnos|why|compare|noise|leak|warning/i.test(q);
  if (hard) return 'medium';
  /* คำถามสั้นที่ตอบจากข้อมูลที่มีอยู่แล้ว เช่น "รถผมรุ่นอะไร" หรือคุยเล่น — แทบไม่ต้องคิด ตอบทันที */
  return q.length <= 60 ? 'minimal' : 'low';
}

/* thinkingConfig คนละแบบตามรุ่น — รุ่น 3 ใช้ระดับ รุ่น 2.5 ใช้งบโทเคน */
function thinkingConfig(model, level) {
  if (!level) return null;
  if (/gemini-3|gemini-[4-9]/.test(model)) return level === 'minimal' ? { thinkingLevel: 'minimal' } : { thinkingLevel: level, includeThoughts: true };
  if (/gemini-2\.5/.test(model)) return level === 'minimal' ? { thinkingBudget: 0 } : { thinkingBudget: level === 'medium' ? 2048 : 512, includeThoughts: true };
  return null;
}

/* แปลงประวัติแชตให้ Gemini รับได้แน่นอน
   - ตัดข้อความว่าง รวมข้อความฝั่งเดียวกันที่ติดกัน เริ่มด้วยผู้ใช้เสมอ
   - รูป/วิดีโอเก่าไม่ต้องส่งซ้ำทุกรอบ เก็บไฟล์จริงไว้แค่ 2 ข้อความล่าสุดของผู้ใช้ */
export function toGeminiContents(msgs, keepMediaTurns = 2) {
  const out = [];
  const userIdx = [];
  /* นับเฉพาะข้อความของผู้ใช้ที่มีไฟล์จริง — ข้อความว่างหรือข้อความล้วนไม่ควรดันรูปล่าสุดตกหน้าต่าง */
  (msgs || []).forEach((m, i) => { if (m && m.role === 'user' && Array.isArray(m.parts) && m.parts.some(p => p && (p.inline_data || p.inlineData))) userIdx.push(i) });
  const keepFrom = userIdx.length > keepMediaTurns ? userIdx[userIdx.length - keepMediaTurns] : 0;
  (msgs || []).forEach((m, i) => {
    if (!m || !Array.isArray(m.parts)) return;
    const role = m.role === 'user' ? 'user' : 'model';
    const parts = [];
    for (const p of m.parts) {
      if (typeof p.text === 'string') { if (p.text.trim()) parts.push({ text: p.text }); continue; }
      const d = p.inline_data || p.inlineData;
      if (!d || !d.data) continue;
      if (role !== 'user' || i < keepFrom) { parts.push({ text: '[ผู้ใช้เคยแนบไฟล์ไว้ในข้อความนี้]' }); continue; }
      let data = String(d.data).trim();
      if (data.includes(',')) data = data.split(',')[1];
      const mime = String(d.mime_type || d.mimeType || 'image/jpeg').split(';')[0].trim().toLowerCase() || 'image/jpeg';
      parts.push({ inline_data: { mime_type: mime, data: data.replace(/\s/g, '') } });
    }
    if (!parts.length) return;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else out.push({ role, parts });
  });
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/* ── เรียก Gemini แบบสตรีมหนึ่งครั้ง ──
   คืน { text, thoughts, grounded, queries } · เรียก onText/onThought ทันทีที่ได้แต่ละก้อน
   โยน error พร้อม e.retryable เพื่อบอกผู้เรียกว่าควรลองโมเดลถัดไปไหม (ยังไม่มีข้อความออกไปเลย) */
async function streamOnce(env, model, { system, contents, search, level, onText, onThought, onSearch, meter, maxTokens, headerMs }) {
  const base = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  /* เพดานนี้นับรวมโทเคนที่ใช้คิดด้วย ตั้งให้พอ ไม่งั้นคิดเยอะแล้วคำตอบถูกตัดกลางประโยค */
  const gen = { maxOutputTokens: maxTokens || 8192 };
  const tc = thinkingConfig(model, level);
  if (tc) gen.thinkingConfig = tc;
  const body = { contents, generationConfig: gen };
  if (system) body.systemInstruction = { parts: [{ text: String(system).slice(0, 24000) }] };
  if (search) body.tools = [{ google_search: {} }];

  /* รอหัวคำตอบไม่เกิน 12 วินาที (ช้ากว่านั้นไปทางสำรองดีกว่าให้ผู้ใช้รอ) และระหว่างสตรีมเงียบนานเกิน 30 วินาทีถือว่าค้าง */
  const ac = new AbortController();
  let idle = setTimeout(() => ac.abort('timeout'), headerMs || 9000);
  let res;
  try {
    res = await fetch(`${base}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${env.GEMINI_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(idle);
    const err = new Error(`${model}: ${e.message || e}`); err.retryable = true; throw err;
  }
  if (!res.ok || !res.body) {
    clearTimeout(idle);
    const t = await res.text().catch(() => '');
    const err = new Error(`${model} ${res.status}: ${t.slice(0, 240)}`);
    err.status = res.status; err.retryable = true;
    /* รุ่นนี้ไม่รับค่าการคิดแบบนี้ — ลองใหม่โดยลดระดับ/ไม่ส่ง แทนที่จะทิ้งทั้งรุ่น */
    err.thinking = res.status === 400 && /thinking/i.test(t);
    /* รุ่นนี้ไม่รับเครื่องมือค้นเว็บ หรือโควตาค้นเว็บเต็ม — ลองรุ่นเดิมแบบไม่ค้นก่อนข้ามรุ่น */
    err.tool = (res.status === 400 && /tool|search|grounding/i.test(t)) || res.status === 429;
    err.dead = res.status === 404 || (res.status === 400 && /not (be )?found|not supported for|unknown model|invalid model/i.test(t) && !err.thinking && !err.tool);
    err.quota = res.status === 429;
    err.busy = res.status >= 500;
    throw err;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', thoughts = '', grounded = false, usage = null;
  const queries = new Set();
  try {
    while (true) {
      clearTimeout(idle); idle = setTimeout(() => ac.abort('idle'), 30000);
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        let d; try { d = JSON.parse(t.slice(5).trim()) } catch { continue }
        if (d.usageMetadata) usage = d.usageMetadata;
        const c = (d.candidates && d.candidates[0]) || {};
        const gm = c.groundingMetadata || c.grounding_metadata;
        if (gm) {
          grounded = true;
          for (const q of (gm.webSearchQueries || gm.web_search_queries || [])) {
            if (!queries.has(q)) { queries.add(q); if (onSearch) await onSearch(q); }
          }
        }
        for (const p of ((c.content && c.content.parts) || [])) {
          if (!p.text) continue;
          if (p.thought) { thoughts += p.text; if (onThought) await onThought(p.text); }
          else { text += p.text; if (onText) await onText(p.text); }
        }
      }
    }
  } catch (e) {
    clearTimeout(idle);
    const err = new Error(`${model} stream: ${e.message || e}`);
    err.retryable = !text; err.partial = text; throw err;
  }
  clearTimeout(idle);
  if (usage && meter) {
    /* ส่วนที่ Gemini จำไว้แล้ว (คำสั่งระบบที่ซ้ำทุกข้อความ) Google คิดราคาราวหนึ่งในสี่
       คิดโควตาผู้ใช้ตามต้นทุนจริงแบบเดียวกัน คุยต่อเนื่องจะไม่เผาโควตาเร็วเกินจริง */
    /* คิดโควตาผู้ใช้เฉพาะสิ่งที่เขาพิมพ์ + คำตอบที่เขาได้อ่าน
       ของเดิมนับคำสั่งระบบ ข้อมูลรถ ความจำ ผลค้นเว็บ และความคิดของโมเดลด้วย ทักว่า "hi" ครั้งเดียวก็กินไปหลายพันโทเคน
       โควตาจึงหมดใน 1–2 ข้อความ — ต้นทุนเบื้องหลังเป็นเรื่องของระบบ ไม่ใช่ของผู้ใช้ */
    meter.in += userTokens(contents);
    meter.out += usage.candidatesTokenCount || Math.ceil(text.length / 3);
    meter.calls += 1; meter.src.push(model + (grounded ? '+search' : ''));
  }
  if (!text.trim()) { const err = new Error(`${model}: empty answer`); err.retryable = true; throw err; }
  return { text, thoughts, grounded, queries: [...queries], model };
}

/* ── ตอบหนึ่งข้อความ ──
   ลองโมเดลตามลำดับ ถ้ารุ่นไหนไม่รับระดับการคิด ลด low → ไม่ส่ง ก่อนข้ามรุ่น
   ถ้ามีข้อความออกไปแล้วบางส่วนแล้วสะดุด จะไม่เริ่มใหม่ (ผู้ใช้จะเห็นซ้ำ) แต่คืนเท่าที่ได้ */
/* จำสิ่งที่ใช้ไม่ได้ไว้ 10 นาทีในเครื่องที่รัน — ไม่ต้องเสียเวลายิงของที่รู้แล้วว่าพังทุกข้อความ */
const BAD = new Map();
/* จำของเสียพร้อมอายุ: รุ่นที่ไม่มีอยู่จริงจำ 10 นาที · โควตาเต็ม/เซิร์ฟเวอร์ล่มชั่วคราวจำแค่ 1 นาที
   ข้อความถัดไปจึงไม่ต้องเสียเวลายิงของที่เพิ่งพัง แต่ก็กลับมาลองใหม่เร็วเมื่อหายแล้ว */
const bad = k => { const v = BAD.get(k); return v && Date.now() < v };
const markBad = (k, ms = 600000) => BAD.set(k, Date.now() + ms);

/* ══ ตรวจสอบคำถามที่ต้องการข้อมูลสด ══ */
const FRESH_WORDS = [
  'ล่าสุด','ใหม่ล่าสุด','รุ่นใหม่','เพิ่งเปิดตัว','เปิดตัว','ปีนี้','ตอนนี้','ปัจจุบัน',
  'ข่าว','ราคา','กี่บาท','เท่าไหร่','เท่าไร','โปรโมชั่น','ส่วนลด','สเปก','สเป็ค',
  'latest','newest','new model','just launched','launch','price','how much','news','spec','2025','2026','2027',
  'ค้นหา','ค้นเว็บ','ค้นข้อมูล','หาข้อมูล','อินเทอร์เน็ต','อินเตอร์เน็ต','กูเกิล','วันนี้','สถานการณ์','น้ำท่วม','อากาศ',
  'internet','google','search','today','weather',
];
export function needsFresh(q) {
  const t = String(q || '').toLowerCase();
  if (!t) return false;
  if (FRESH_WORDS.some(w => t.includes(w))) return true;
  if (/\b(20[2-9]\d|25[6-9]\d)\b/.test(t)) return true;
  return false;
}

/* ── เครื่องมือค้นหาเว็บความเร็วสูงผ่าน DuckDuckGo (ทำงานได้จาก Edge ทุกที่ ไม่ติดโควตา Google) ── */
export async function fetchDuckDuckGoSearch(query) {
  try {
    const qClean = String(query || '')
      .replace(/^(ช่วย|ให้คุณ|ให้|รบกวน|อยากให้)?\s*(ค้นหา|หาข้อมูล|ค้นเน็ต|เสิร์ช|search)?\s*(ข้อมูล|ให้หน่อย|ตอนนี้เลย|ทีครับ|ทีค่ะ|หน่อย)?/gi, '')
      .trim() || String(query || '');
    const q = encodeURIComponent(qClean.slice(0, 150));
    const url = `https://html.duckduckgo.com/html/?q=${q}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8'
      }
    });
    if (!res.ok) return '';
    const html = await res.text();
    const blocks = html.split(/<div class="result results_links/);
    const items = [];
    for (let i = 1; i < blocks.length && items.length < 6; i++) {
      const b = blocks[i];
      if (b.includes('result--ad') || b.includes('badge--ad')) continue;
      const aM = b.match(/<a class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
      const snipM = b.match(/<a class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
      const title = aM ? aM[1].replace(/<[^>]+>/g, '').trim() : '';
      const snippet = snipM ? snipM[1].replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim() : '';
      if (snippet) {
        items.push(`${items.length + 1}. ${title ? `[${title}] ` : ''}${snippet}`);
      }
    }
    return items.join('\n');
  } catch (e) {
    console.warn('[ddg search error]', e.message || e);
    return '';
  }
}

/* ── ค้นหาข้อมูลฉุกเฉิน (กรณีไม่มีฟังก์ชันค้นหาภายนอกส่งเข้ามา) ── */
export async function defaultSearch(env, q) {
  const geminiKey = env.GEMINI_KEY;
  const baseUrl = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  if (geminiKey && !bad('gemini|quota') && !bad('gemini|region')) {
    for (const m of chatModels(env)) {
      if (bad(m)) continue;
      try {
        const res = await fetch(`${baseUrl}/v1beta/models/${m}:generateContent?key=${geminiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: `ค้นหาข้อเท็จจริงล่าสุดในอินเทอร์เน็ตสั้น ๆ เกี่ยวกับ: ${q}` }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.2 }
          })
        });
        if (res.ok) {
          const data = await res.json();
          const cand = (data.candidates && data.candidates[0]) || {};
          const txt = (((cand.content && cand.content.parts) || []).map(x => x.text || '').join('').trim());
          if (txt && !/^ไม่พบข้อมูลยืนยัน/i.test(txt)) return txt;
        } else if (res.status === 429) {
          markBad('gemini|quota', 60000);
        } else if (res.status === 400) {
          const errTxt = await res.text().catch(() => '');
          if (/User location is not supported/i.test(errTxt)) markBad('gemini|region', 600000);
        }
      } catch (e) {}
    }
  }
  // ค้นด้วย DuckDuckGo เป็นหลักหาก Gemini ติดโควตาหรือบล็อกพื้นที่ — ได้ผลจริง ทันที ไม่ติดโควตา
  const ddg = await fetchDuckDuckGoSearch(q);
  if (ddg) return ddg;
  return '';
}

/* ══ OpenRouter Tool-Calling Thinking Agent (โมเดลหลักตามคำสั่งผู้ใช้) ══
   - ใช้ openrouter/free (หรือ env.OPENROUTER_MODEL) เป็นสมองหลักในการคิด
   - เชื่อมต่อการค้นหาเว็บสด (DuckDuckGo + Google Search Grounding)
   - สตรีมความคิด (reasoning) และคำตอบสด ๆ แบบเรียลไทม์ */
async function openrouterAgent(env, opts) {
  if (!env.OPENROUTER_API_KEY) return null;
  const model = env.OPENROUTER_MODEL || 'openrouter/free';
  const baseUrl = env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const url = `${baseUrl}/chat/completions`;
  const t0 = Date.now();

  const history = opts.history || (opts.messages ? toChatHistory(opts.messages) : (opts.contents ? toChatHistory(opts.contents) : []));
  const question = opts.question || (history.length ? String(history[history.length - 1].content || '') : '');
  const isSearchQuery = /ค้นหา|หาข้อมูล|ค้นเน็ต|เสิร์ช|search|เช็คราคา|เช็กราคา|ล่าสุด|ปัจจุบัน|เปิดตัว|ปีนี้|ปีหน้า|202[4-9]|256[7-9]|โปรโมชั่น|แคมเปญ|ดอกเบี้ย|ผ่อน|ตารางผ่อน|มีขายไหม|เข้าไทย|มาไทย|ขายยัง|วางขาย|รุ่นใหม่|facelift|all new|all-new/i.test(question);
  const fresh = (opts.search !== false) && (needsFresh(question) || (opts.carInfo && needsFresh(question)) || isSearchQuery);

  const searchFn = opts.executeSearch || (q => defaultSearch(env, q));
  let observation = '';
  let searchTopic = '';

  // 1. Pre-search Grounding: ถ้าคำถามต้องการข้อมูลสด ค้นหาเว็บล่วงหน้าทันที (< 1 วินาที)
  // เพื่อให้โมเดลตอบรอบเดียวจบแบบ Single-turn Streaming เร็ว ไม่ติด timeout
  if (fresh) {
    const carPrefix = (opts.carInfo && (opts.carInfo.make || opts.carInfo.model)) ? `${opts.carInfo.make || ''} ${opts.carInfo.model || ''} ` : '';
    const qClean = question.replace(/^(ช่วย|ให้คุณ|ให้|รบกวน|อยากให้)?\s*(ค้นหา|หาข้อมูล|เสิร์ช|search)?\s*(ข้อมูล|ให้หน่อย|ตอนนี้เลย|ทีครับ|ทีค่ะ|หน่อย)?/gi, '').trim() || question;
    searchTopic = `${carPrefix}${qClean}`.trim();
    if (opts.onSearch) await opts.onSearch(searchTopic);
    try {
      observation = await searchFn(searchTopic);
    } catch (e) {
      console.warn('[openrouter pre-search failed]', e.message || e);
    }
  } else if (opts.hasMedia && opts.executeMedia) {
    try {
      observation = await opts.executeMedia("ดูและอธิบายรายละเอียดภาพหรือสื่อที่แนบมา");
    } catch (e) {}
  }

  // 2. ป้อนข้อมูลที่ค้นพบเข้าไปใน System Prompt
  let searchPrompt = '';
  if (observation) {
    searchPrompt = `\n\n[ข้อมูลล่าสุดที่ค้นพบจากอินเทอร์เน็ตแบบเรียลไทม์]:\nหัวข้อค้นหา: ${searchTopic || question}\n${observation}\n\nคำสั่งสำคัญ:
- นำข้อเท็จจริงล่าสุดข้างต้นมาตอบคำถามของผู้ใช้ให้ครบถ้วน ชัดเจน ตรงประเด็น และเป็นมิตร
- อ้างอิงข้อมูลจริงจากผลการค้นหา เช่น ชื่อรุ่น สเปก ราคา ปีเปิดตัว
- ห้ามตอบว่าไม่มีข้อมูลล่าสุดหรือไม่มีเครื่องมือค้นหา เพราะระบบได้ค้นหาข้อมูลล่าสุดจากอินเทอร์เน็ตมาให้คุณเรียบร้อยแล้ว
- ตอบเนื้อหาออกมาตรง ๆ ไม่ต้องเกริ่นว่า "จากข้อมูลการค้นหา"`;
  } else {
    searchPrompt = `\n\n[เครื่องมือค้นหา]:
ถ้าจำเป็นต้องค้นหาข้อมูลเพิ่มเติม สามารถเรียกใช้ได้โดยพิมพ์:
Action: google_search("คำค้นหา")`;
  }

  const sys = `${opts.system || ''}${searchPrompt}`;
  let messages = [
    { role: 'system', content: sys },
    ...history
  ];

  let thoughts = '';
  let responseText = '';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('timeout'), 45000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://carspirethailand.com',
        'X-Title': 'Cendon',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        stream: true
      }),
      signal: ac.signal
    });

    if (!res.ok) {
      const errTxt = await res.text().catch(() => '');
      throw new Error(`OpenRouter ${res.status}: ${errTxt.slice(0, 150)}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        let d;
        try { d = JSON.parse(payload); } catch { continue; }
        const delta = (d.choices && d.choices[0] && d.choices[0].delta) || {};
        const r = delta.reasoning || delta.reasoning_content;
        if (r) {
          thoughts += r;
          if (opts.onThought) await opts.onThought(r);
        }
        if (delta.content) {
          responseText += delta.content;
          if (opts.onText) await opts.onText(delta.content);
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  // 3. Dynamic Tool Calling Fallback (กรณีรอบแรกไม่ได้ pre-search แต่โมเดลเขียน Action ออกมา)
  const combined = `${responseText}\n${thoughts}`;
  let actionMatch = combined.match(/(?:Action|Tool):\s*(\w+)\s*[:\(]\s*(?:query\s*=\s*)?(["'`\u201c\u2018])([\s\S]*?)\2\s*\)?/i);
  if (!actionMatch) {
    const loose = combined.match(/(?:Action|Tool):\s*(\w+)\s*\(([^)]+)\)/i);
    if (loose) {
      actionMatch = [loose[0], loose[1], '"', loose[2].replace(/^["'`\u201c\u2018]|["'`\u201d\u2019]$/g, '').trim()];
    }
  }

  if (actionMatch && !observation) {
    const tName = actionMatch[1].toLowerCase();
    const tInput = actionMatch[3];
    if (tName === 'google_search' || tName === 'search' || tName === 'web_search') {
      if (opts.onSearch) await opts.onSearch(tInput);
      const postObs = await searchFn(tInput);
      if (postObs) {
        observation = postObs;
        searchTopic = tInput;
        try {
          const step2Res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
              'HTTP-Referer': 'https://carspirethailand.com',
              'X-Title': 'Cendon',
            },
            body: JSON.stringify({
              model,
              messages: [
                ...messages,
                { role: 'assistant', content: responseText },
                { role: 'user', content: `[ผลการค้นหาเว็บ]:\n${postObs}\n\nคำสั่ง: นำผลการค้นหาข้างต้นมาสรุปตอบผู้ใช้ให้ครบถ้วน ชัดเจน เป็นมิตร` }
              ],
              temperature: 0.3
            })
          });
          if (step2Res.ok) {
            const s2Data = await step2Res.json();
            const s2Text = (s2Data.choices && s2Data.choices[0] && s2Data.choices[0].message && s2Data.choices[0].message.content) || '';
            if (s2Text) {
              responseText = s2Text;
            }
          }
        } catch (e) {}
      }
    }
  }

  let clean = stripToolCalls(responseText).trim();
  const faMatch = clean.match(/Final Answer:\s*([\s\S]+)$/i);
  if (faMatch) clean = faMatch[1].trim();

  trail(opts.meter, { model, level: null, search: !!observation, ok: true, ms: Date.now() - t0, grounded: !!observation });
  return {
    text: clean,
    thoughts,
    grounded: !!observation,
    queries: searchTopic ? [searchTopic] : [],
    model
  };
}

export async function fastAnswer(env, opts) {
  // 1. โมเดลหลัก: OpenRouter Tool-Calling Thinking Agent ตามคำสั่งผู้ใช้
  if (env.OPENROUTER_API_KEY && !bad('or:primary')) {
    try {
      const orResult = await openrouterAgent(env, opts);
      if (orResult && orResult.text && orResult.text.trim()) {
        return orResult;
      }
    } catch (e) {
      console.warn('[fastAnswer openrouter primary failed]', e.message || e);
      if (/429|rate/i.test(e.message || '')) markBad('or:primary', 15000);
    }
  }

  // 2. โมเดลรอง: Gemini พร้อม Search Grounding
  if (!env.GEMINI_KEY) throw new Error('AI is not configured');
  let last = null;
  const want = opts.level || 'low';
  const ladder = want === 'medium' ? ['medium', 'low', null] : want === 'minimal' ? ['minimal', 'low', null] : ['low', null];
  /* งบเวลารวมก่อนได้คำแรก 14 วินาที — เกินนั้นไปทางสำรองเลย ผู้ใช้ไม่ต้องนั่งรอไล่ลองทีละรุ่น */
  const until = Date.now() + 14000;
  for (const model of chatModels(env)) {
    if (bad(model)) continue;
    let search = !!opts.search && !bad(model + '|search');
    for (let i = 0; i < ladder.length; i++) {
      const level = ladder[i];
      if (level && bad(model + '|' + level)) continue;
      const left = until - Date.now();
      if (left < 1500) throw last || new Error('gemini: time budget used');
      const t0 = Date.now();
      try {
        const r = await streamOnce(env, model, { ...opts, level, search, headerMs: Math.min(9000, left) });
        trail(opts.meter, { model, level, search, ok: true, ms: Date.now() - t0, grounded: r.grounded });
        return r;
      } catch (e) {
        trail(opts.meter, { model, level, search, ok: false, ms: Date.now() - t0, err: String(e.message || e).slice(0, 160) });
        last = e;
        if (e.partial) return { text: e.partial, thoughts: '', grounded: false, queries: [], model, cut: true };
        if (e.thinking && level) { markBad(model + '|' + level); continue; }     /* ลดระดับการคิด รุ่นเดิม */
        /* ค้นเว็บใช้ไม่ได้ในรุ่นนี้ หรือโควตาค้นเว็บเต็ม — ลองรุ่นเดิมแบบไม่ค้น */
        if (e.tool && search) { markBad(model + '|search', e.quota ? 60000 : 600000); search = false; i--; continue; }
        if (e.dead) markBad(model);
        else if (e.quota || e.busy) markBad(model, 60000);                     /* ล่ม/เต็มชั่วคราว ข้ามรุ่นนี้ 1 นาที แล้วลองรุ่นถัดไป */
        break;                                                                 /* ข้ามไปลองรุ่นถัดไปใน chatModels */
      }
    }
  }
  throw last || new Error('no model available');
}

/* ══ ทางสำรองเมื่อ Gemini ใช้ไม่ได้ ══
   ของเดิมตกไปที่ openrouter/free ซึ่งสุ่มโมเดลฟรีมาให้ — ช้า ต้องต่อคิว คิดนาน
   และบางตัวพิมพ์คำสั่งเรียกเครื่องมือดิบ ๆ ออกมาเป็นคำตอบ (<|tool_call_start|>[google(query=…)])
   ตอนนี้เรียงจากเร็วสุด: Cerebras → Groq → Workers AI → OpenRouter (ตัวไหนไม่มีคีย์ก็ข้าม)
   และมีตัวกันไม่ให้คำสั่งเรียกเครื่องมือหลุดถึงผู้ใช้ */
const TOOL_RE = /<\|tool_call|<\|python_tag\|>|<tool_call>|<\/?function[=\s>]|\[TOOL_CALLS\]|^\s*\[?\s*\{\s*"(name|tool|function)"\s*:|\b(google|google_search|web_search|search|browser\.search)\s*\(\s*(query\s*=|["'])|^\s*(action|tool|call|tool_code)\s*:\s*[a-z_.]+\s*\(/im;
const MAYBE_TOOL = /^\s*(<|\[|\{|google|search|web_|browser|user|response|prompt|safe|unsafe|s\d|action|tool|call|thought)/i;

export function stripToolCalls(t) {
  return String(t || '')
    .replace(/<\|tool_call_start\|>[\s\S]*?(<\|tool_call_end\|>|$)/g, '')
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '')
    .replace(/<function[=\s][\s\S]*?(<\/function>|$)/g, '')
    .replace(/\[TOOL_CALLS\][\s\S]*$/g, '')
    .replace(/<\|[a-z_]+\|>/g, '')
    .replace(/^\s*(?:(?:action|tool|call|thought|tool_code)\s*:\s*)?\[?\s*(google|google_search|web_search|search|browser\.search)\s*\([^)]*\)[\s,\]]*$/gim, '')
    .trim();
}

/* ตัวกลั่นกรองระหว่างสตรีม: ข้อความปกติ (ขึ้นต้นด้วยภาษาคน) ปล่อยผ่านทันที ไม่หน่วง
   ถ้าต้นข้อความดูเหมือนคำสั่งเรียกเครื่องมือ พักไว้ก่อนจนแน่ใจ ถ้าใช่ก็ไม่ส่งออกไปเลย */
function toolGuard(onText) {
  let head = '', open = false, text = '', toolCall = false;
  return {
    async push(d) {
      if (toolCall) return;
      if (!open) {
        head += d;
        if (TOOL_RE.test(head) || JUNK_RE.test(head)) { toolCall = true; return; }   /* คำสั่งเครื่องมือ/ผลตรวจความปลอดภัย ห้ามถึงผู้ใช้ */
        if (MAYBE_TOOL.test(head) && head.length < 80) return;
        open = true; d = head;
      } else if (TOOL_RE.test(text.slice(-80) + d)) { toolCall = true; return; }
      text += d; if (onText) await onText(d);
    },
    async end() {
      if (!open && !toolCall && head && !TOOL_RE.test(head)) { text += head; if (onText) await onText(head); }
      return { text, toolCall };
    },
  };
}

/* สตรีมจากผู้ให้บริการแบบ OpenAI (Cerebras / Groq / OpenRouter) หรือ Workers AI */
async function streamProvider(env, p, messages, { onText, onThought, meter }) {
  const guard = toolGuard(onText);
  let thoughts = '', usage = null, stream;
  const ac = new AbortController();
  let idle = setTimeout(() => ac.abort('timeout'), 8000);
  try {
    if (p.ai) {
      stream = await Promise.race([
        env.AI.run(p.model, { messages, stream: true, max_tokens: 2048 }),
        new Promise((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('timeout')))),
      ]);
    } else {
      const res = await fetch(p.url, { method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key, ...(p.headers || {}) },
        body: JSON.stringify({ model: p.model, messages, stream: true, temperature: 0.4, max_tokens: 2048, ...(p.extra || {}) }) });
      if (!res.ok || !res.body) throw new Error(`${p.src} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
      stream = res.body;
    }
    const reader = stream.getReader(), dec = new TextDecoder();
    let buf = '';
    while (true) {
      clearTimeout(idle); idle = setTimeout(() => ac.abort('idle'), 25000);
      const { done, value } = await reader.read();
      if (done) break;
      buf += typeof value === 'string' ? value : dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        let d; try { d = JSON.parse(payload) } catch { continue }
        if (d.usage) usage = d.usage;
        const delta = (d.choices && d.choices[0] && d.choices[0].delta) || {};
        const r = delta.reasoning || delta.reasoning_content;
        if (r) { thoughts += r; if (onThought) await onThought(r); }
        const c = delta.content != null ? delta.content : d.response;
        if (c) await guard.push(String(c));
      }
    }
  } finally { clearTimeout(idle); }
  const g = await guard.end();
  if (meter) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    meter.in += lastUser ? Math.ceil(String(Array.isArray(lastUser.content) ? lastUser.content.map(c => c.text || '').join('') : lastUser.content).length / 3) + (Array.isArray(lastUser.content) ? lastUser.content.filter(c => c.type === 'image_url').length * 300 : 0) : 0;
    meter.out += Math.ceil(g.text.length / 3);
    meter.calls += 1; meter.src.push(p.src);
  }
  return { text: g.text, thoughts, toolCall: g.toolCall };
}

export function fallbackProviders(env, media) {
  const L = [];
  /* มีรูปแนบ: ใช้เฉพาะรุ่นที่ดูรูปได้จริง — ของเดิมส่งให้รุ่นที่อ่านได้แต่ข้อความ มันจึงตอบมั่วว่าดูรูปไม่ได้ */
  if (media) {
    if (env.GROQ_API_KEY) L.push({ src: 'groq-vision', vision: true, url: `${env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'}/chat/completions`,
      key: env.GROQ_API_KEY, model: env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct' });
    if (env.AI) L.push({ src: 'workers-ai-vision', vision: true, ai: true, model: env.CF_AI_VISION_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct' });
    if (env.OPENROUTER_API_KEY) L.push({ src: 'openrouter-vision', vision: true, url: `${env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`,
      key: env.OPENROUTER_API_KEY, model: env.OPENROUTER_VISION_MODEL || 'google/gemma-3-27b-it:free',
      headers: { 'HTTP-Referer': 'https://carspirethailand.com', 'X-Title': 'Cendon' } });
    return L.filter(p => !bad('fb|' + p.src));
  }
  /* Groq ก่อน (ฟรี เร็ว) — ถ้าชื่อรุ่นหลักใช้ไม่ได้กับคีย์นี้ มีรุ่นสำรอง (ตัวเดียวกับที่ใช้ดูรูป) */
  if (env.GROQ_API_KEY) {
    const gu = `${env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'}/chat/completions`;
    L.push({ src: 'groq', url: gu, key: env.GROQ_API_KEY, model: env.GROQ_MODEL || 'llama-3.1-8b-instant' });
    L.push({ src: 'groq-alt', url: gu, key: env.GROQ_API_KEY, model: 'llama-3.1-8b-instant' });
  }
  if (env.CEREBRAS_API_KEY) L.push({ src: 'cerebras', url: `${env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1'}/chat/completions`,
    key: env.CEREBRAS_API_KEY, model: env.CEREBRAS_MODEL || 'gpt-oss-120b', extra: { reasoning_effort: 'low' } });
  if (env.AI) L.push({ src: 'workers-ai', ai: true, model: env.CF_AI_FALLBACK_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast' });
  if (env.OPENROUTER_API_KEY) L.push({ src: 'openrouter', url: `${env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`,
    key: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || 'openrouter/free',   /* รุ่นฟรีเฉพาะชื่อถูกถอดบ่อย ใช้ตัวเลือกฟรีอัตโนมัติ แล้วกรองคำตอบขยะด้วย isJunk */
    headers: { 'HTTP-Referer': 'https://carspirethailand.com', 'X-Title': 'Cendon' } });
  return L.filter(p => !bad('fb|' + p.src));
}

/* คำสั่งเสริมของทางสำรอง: ป้องกันไม่ให้โมเดลพ่นคำสั่งเรียกเครื่องมือดิบออกมา */
const NO_TOOLS = `

<<<<<<< HEAD
[สำคัญ] รอบนี้ไม่มีเครื่องมือใด ๆ ให้เรียกใช้ ห้ามเขียนคำสั่งเรียกฟังก์ชัน ห้ามเขียน google(...) / Action: google_search(...) หรือ <|tool_call|>
ตอบเป็นภาษาคนออกมาเลย จากความรู้ที่มี เรื่องที่ต้องใช้ข้อมูลล่าสุดให้บอกตรง ๆ ว่ายังยืนยันข้อมูลล่าสุดไม่ได้ แล้วแนะนำแหล่งที่ตรวจเองได้`;
=======
[สำคัญ] ตอบเป็นข้อความภาษาคนธรรมดา ห้ามเขียนคำสั่งเรียกฟังก์ชัน ห้ามเขียน google(...) หรือ <|tool_call|>`;
>>>>>>> 03497a92d6fb61f0356e1e403669b28e71ec0eb7

/* คำตอบขยะที่ต้องทิ้งแล้วไปรุ่นถัดไป: ผลตรวจความปลอดภัย หรือข้อความสั้นกุดไม่มีเนื้อ */
const JUNK_RE = /^\s*(user|response|prompt)\s*safety\s*:|^\s*(safe|unsafe)\s*(\n|$)|^\s*S\d+\s*$/im;
export function isJunk(t) { return JUNK_RE.test(String(t || '')) }

/* ประวัติแชตแบบ OpenAI: ข้อความล้วน ยกเว้นข้อความล่าสุดของผู้ใช้ที่มีรูป — ส่งรูปจริงไปด้วย (สำหรับรุ่นที่ดูรูปได้) */
export function toChatHistory(msgs) {
  const list = (msgs || []).filter(m => m && Array.isArray(m.parts));
  let lastMedia = -1;
  list.forEach((m, i) => { if (m.role === 'user' && m.parts.some(p => p && (p.inline_data || p.inlineData))) lastMedia = i });
  return list.map((m, i) => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = m.parts.map(x => x.text || ((x.inline_data || x.inlineData) && i !== lastMedia ? ' [ผู้ใช้เคยแนบไฟล์ไว้]' : '')).join('').trim();
    if (i !== lastMedia) return { role, content: text };
    const imgs = m.parts.map(x => x.inline_data || x.inlineData).filter(d => d && d.data && /^image\//i.test(d.mime_type || d.mimeType || 'image/jpeg'))
      .slice(0, 3).map(d => ({ type: 'image_url', image_url: { url: `data:${(d.mime_type || d.mimeType || 'image/jpeg').split(';')[0]};base64,${String(d.data).split(',').pop().replace(/\s/g, '')}` } }));
    return { role, content: imgs.length ? [{ type: 'text', text: text || 'ดูรูปนี้ให้หน่อย' }, ...imgs] : text, media: imgs.length > 0 };
  }).filter(m => (Array.isArray(m.content) ? m.content.length : String(m.content).trim()));
}
const flat = h => h.map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.map(c => c.text || ' [ผู้ใช้แนบรูปมา]').join('') : m.content }));

export async function fallbackAnswer(env, system, history, opts) {
  opts = opts || {};
  let last = null;
  const media = history.some(m => m.media);
  const clean = history.map(({ media, ...m }) => m);
  /* ย้ำให้ตอบคำถามล่าสุดตรง ๆ — รุ่นสำรองชอบหยิบข้อมูลรถในคำสั่งระบบมาตอบแทนสิ่งที่ถูกถาม */
  const FOCUS = '\n\n[สำคัญที่สุด] ตอบ "ข้อความล่าสุดของผู้ใช้" ให้ตรงประเด็น ข้อมูลรถของผู้ใช้ใช้ประกอบเท่านั้น ห้ามตอบแค่ข้อมูลรถถ้าเขาไม่ได้ถาม';
  
  // เสริมข้อมูลค้นหาเว็บสดให้ทางสำรองด้วย หากคำถามเป็นเรื่องที่ต้องใช้ข้อมูลล่าสุด
  let extraWeb = '';
  const lastUser = [...clean].reverse().find(m => m.role === 'user');
  const userText = lastUser ? (Array.isArray(lastUser.content) ? lastUser.content.map(c => c.text || '').join('') : String(lastUser.content)) : '';
  if (userText && (needsFresh(userText) || /ค้นหา|หาข้อมูล|ล่าสุด|202[4-9]|256[7-9]/i.test(userText))) {
    try {
      const ddg = await fetchDuckDuckGoSearch(userText);
      if (ddg) {
        extraWeb = `\n\n[ข้อมูลล่าสุดที่ค้นพบจากอินเทอร์เน็ต]:\n${ddg}\nให้นำข้อเท็จจริงนี้มาตอบคำถามผู้ใช้ ห้ามบอกว่าไม่มีข้อมูลหรือไม่มีการเข้าถึงอินเทอร์เน็ต`;
      }
    } catch (e) {}
  }

  let list = media ? fallbackProviders(env, true).concat(fallbackProviders(env)) : fallbackProviders(env);
  /* ทุกเจ้าถูกพักไว้หมด — ดีกว่าตอบว่าไม่มีทางสำรอง ให้ลองทุกเจ้าอีกรอบ (อาจหายแล้ว) */
  if (!list.length) { BAD.forEach((_, k) => { if (k.startsWith('fb|')) BAD.delete(k) }); list = fallbackProviders(env, media).concat(media ? fallbackProviders(env) : []) }
  for (const p of list) {
    let sys = system + extraWeb + NO_TOOLS + FOCUS;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = Date.now();
      try {
        const r = await streamProvider(env, p, [{ role: 'system', content: sys }, ...(p.vision ? clean : flat(clean))], opts);
        trail(opts.meter, { model: p.src + ':' + p.model, ok: !!r.text.trim() && !isJunk(r.text), ms: Date.now() - t0, err: isJunk(r.text) ? 'junk answer' : (r.text.trim() ? '' : 'empty') });
        if (isJunk(r.text)) break;
        if (r.text.trim()) return { ...r, src: p.src };
        if (r.toolCall && attempt === 0) {
          /* มันยังพยายามเรียกเครื่องมือ — ย้ำอีกรอบ ถ้ายังดื้อก็ไปตัวถัดไป */
          sys += '\n\nย้ำ: ตอบเป็นข้อความธรรมดาเท่านั้น'; continue;
        }
        break;
      } catch (e) {
        trail(opts.meter, { model: p.src + ':' + p.model, ok: false, ms: Date.now() - t0, err: String(e.message || e).slice(0, 160) });
        last = e;
        if (/ 40[134]:/.test(e.message || '')) markBad('fb|' + p.src);   /* คีย์ผิด/ไม่มีสิทธิ์/ไม่มีรุ่นนี้ */
        /* โควตารายวันหมด (Workers AI 4006 / 429) — พักเจ้านี้ 6 ชั่วโมง ไม่ต้องลองทุกข้อความ */
        if (/4006|neurons| 402:|payment required/i.test(e.message || '')) markBad('fb|' + p.src, 6 * 3600000);   /* โควตารายวันหมด / ต้องจ่ายเงิน */
        else if (/ 429:|rate.?limit/i.test(e.message || '')) markBad('fb|' + p.src, 60000);      /* แค่ถี่ไป พักนาทีเดียว */
        break;
      }
    }
  }
  const g = opts && opts.geminiError;
  const msg = (g ? 'Gemini: ' + String(g.message || g).slice(0, 180) + ' | ' : '') + 'สำรอง: ' + String((last && last.message) || 'no fallback provider').slice(0, 160);
  const err = new Error(msg); err.status = last && last.status; throw err;
}

/* ส่วนของคำสั่งระบบที่ทำให้ "คิดฉลาด" — ใส่ไว้ท้ายตัวตน ก่อนข้อมูลของผู้ใช้ */
export function smartBlock(now) {
  const d = new Date(now || Date.now());
  const th = d.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', year: 'numeric', month: 'long', day: 'numeric' });
  return `
[วันนี้] ${th} (${d.toISOString().slice(0, 10)}) — ใช้ตัดสินว่าอะไร "ล่าสุด" หรือ "ปีนี้"

[วิธีคิดก่อนตอบ]
- เรื่องอาการรถ: ไล่จากสาเหตุที่พบบ่อยที่สุดของรุ่น อายุ และเลขไมล์ของคันนี้ก่อน แล้วค่อยไล่ที่พบน้อย
- ใช้ข้อมูลรถ ประวัติบำรุงรักษา และสิ่งที่เคยคุยกันที่ให้มา ตอบให้เฉพาะคันของเขา ไม่ใช่คำตอบกลาง ๆ
- ถ้ามีรูปหรือคลิปแนบมา ดูของจริงในไฟล์ก่อน บอกสิ่งที่เห็นแยกจากสิ่งที่อนุมาน
- เรื่องที่เปลี่ยนตามเวลา (ราคา ค่าอะไหล่ ค่าแรง สเปกรุ่นใหม่ ข่าว การเรียกคืน กฎหมาย ภาษี) ให้ค้นเว็บก่อนตอบเสมอ
- ราคาในไทยให้ค้นจากแหล่งไทย และตอบเป็นช่วงราคาเงินบาท
- แหล่งที่เชื่อได้: เว็บผู้ผลิต ศูนย์บริการ สื่อรถยนต์ที่มีกองบรรณาธิการ ร้านอะไหล่ที่มีราคาชัดเจน · เลี่ยงฟอรัมและข่าวลือ
- ถ้าค้นแล้วยังไม่พบข้อมูลที่ยืนยันได้ ให้บอกตรง ๆ แล้วเสนอสิ่งที่ช่วยได้จริง ห้ามแต่งตัวเลข

[ตารางเทียบ]
- เมื่อผู้ใช้เทียบของตั้งแต่ 2 อย่างขึ้นไป (รุ่นรถ อะไหล่ ยาง น้ำมันเครื่อง ประกัน ศูนย์บริการ ฯลฯ) ให้สรุปเป็นตาราง markdown เสมอ
- แถวแรกเป็นหัวตาราง: ช่องแรกว่างหรือ "หัวข้อ" แล้วตามด้วยชื่อสิ่งที่เทียบ แต่ละแถวคือหนึ่งหัวข้อ (ราคา เครื่องยนต์ อัตราสิ้นเปลือง ขนาด ความปลอดภัย ค่าบำรุงรักษา)
- เซลล์สั้น กระชับ มีหน่วยชัด ใส่ **ตัวหนา** ที่ค่าที่ดีกว่าในแถวนั้น
- ก่อนตารางเกริ่นหนึ่งบรรทัด หลังตารางสรุปสั้น ๆ ว่าแบบไหนเหมาะกับใคร
- ห้ามใช้ตารางกับคำตอบที่ไม่ได้เทียบอะไร`;
}

/* บังคับค้นเมื่อคำถามเป็นเรื่องข้อมูลล่าสุด — โมเดลบางครั้งคิดว่ารู้อยู่แล้วแล้วตอบจากความจำ */
export const FORCE_SEARCH = `

[คำถามนี้ต้องใช้ข้อมูลล่าสุด]
ต้องค้นเว็บก่อนตอบ ห้ามตอบจากความจำอย่างเดียว เรียบเรียงด้วยคำของคุณเอง ไม่ใส่ลิงก์หรือเลขเชิงอรรถ
- ค้นอย่างน้อย 2 แบบ: ภาษาไทย และภาษาอังกฤษ ใส่ปีปัจจุบันลงในคำค้นด้วย (เช่น "… 2026" และ "… 2569")
- "รุ่นใหม่/ล่าสุด" = รุ่นที่เปิดตัวล่าสุดเมื่อเทียบกับวันนี้ ถ้าผลค้นเจอหลายเจเนอเรชัน ให้เลือกอันที่วันที่ใหม่ที่สุด และบอกปีเปิดตัวให้ถูก
- ระวังบทความเก่าที่ถูกค้นเจอก่อน ดูวันที่ของแหล่งข่าวทุกครั้ง ข่าวที่เก่ากว่า 1 ปีใช้เป็นข้อมูลรุ่นก่อนหน้าเท่านั้น
- ปีไทย = ปีสากล + 543 (2026 = 2569) ตอบปีให้ตรงกับที่ผู้ใช้ใช้
- ถ้าข้อมูลที่ค้นเจอขัดกับที่ผู้ใช้บอก ให้ค้นซ้ำเจาะจงขึ้นก่อนสรุป`;

/* ── ตรวจระบบ (หน้าแอดมิน) ──
   ยิงทางเดียวกับที่แชตใช้จริง ทีละรุ่น และทางสำรองทีละเจ้า แล้วรายงานผลจริงของแต่ละตัว */
export async function probeAll(env, q) {
  const rows = [];
  let best = null;
  for (const model of chatModels(env)) {
    const t = Date.now();
    try {
      const r = await streamOnce(env, model, { system: 'ตอบสั้น ๆ เป็นภาษาไทย 2-3 บรรทัด', search: true, level: null,
        contents: [{ role: 'user', parts: [{ text: 'ค้นข้อมูลล่าสุดแล้วสรุปสั้น ๆ: ' + q }] }] });
      const row = { name: model, ok: true, grounded: r.grounded, ms: Date.now() - t, sample: r.text.slice(0, 400) };
      rows.push(row); if (!best) best = row;
    } catch (e) {
      rows.push({ name: model, ok: false, ms: Date.now() - t, error: String(e.message || e).slice(0, 300) });
    }
  }
  for (const p of fallbackProviders(env)) {
    const t = Date.now();
    try {
      const r = await streamProvider(env, p, [{ role: 'user', content: 'ตอบคำว่า "พร้อม" คำเดียว' }], {});
      rows.push({ name: 'สำรอง ' + p.src + ' (' + p.model + ')', ok: !!r.text.trim(), ms: Date.now() - t, sample: r.text.slice(0, 80) });
    } catch (e) {
      rows.push({ name: 'สำรอง ' + p.src + ' (' + p.model + ')', ok: false, ms: Date.now() - t, error: String(e.message || e).slice(0, 200) });
    }
  }
  return { rows, best };
}



/* ══ ระดับความละเอียดที่ผู้ใช้เลือกจากแถบเลื่อนในช่องพิมพ์ ══
   0 = เร็ว (คิดน้อย ตอบสั้น) · 1 = สมดุล (ให้ระบบเลือกเอง) · 2 = ละเอียดสุด (คิดลึก ค้นหลายแหล่ง) */
export function levelFor(depth, question, hasMedia, skillIds) {
  const d = Number(depth);
  if (d === 0) return hasMedia ? 'low' : 'minimal';
  if (d === 2) return 'medium';
  return thinkingFor(question, hasMedia, skillIds);
}
export function depthNote(depth) {
  const d = Number(depth);
  if (d === 0) return `\n\n[โหมดเร็ว] ตอบสั้น ตรงประเด็น ไม่เกิน 5 บรรทัด ไม่ต้องเกริ่น`;
  if (d === 2) return `\n\n[โหมดละเอียดสุด] ค้นอย่างน้อย 3 แหล่งที่เชื่อถือได้ ตรวจตัวเลขไขว้กัน อธิบายเหตุผลครบ มีหัวข้อ และสรุปท้าย`;
  return '';
}

/* ══ ฟีเจอร์ของคำตอบ: ถามแบบมีตัวเลือก · คำถามต่อ · การ์ดตัดสินใจซื้อรถ · ประเมินค่าซ่อมจากรูป ══ */
export function featuresBlock() {
  return `

[ถามผู้ใช้แบบมีตัวเลือก — ใช้เมื่อข้อมูลที่ขาดมีผลกับคำตอบจริง]
ปิดท้ายคำตอบด้วยบล็อกนี้ (ห้ามมีข้อความต่อจากมัน):
[[ASK]]{"title":"หัวข้อสั้น ๆ","fields":[{"k":"budget","label":"งบประมาณเท่าไหร่","type":"choice","options":[{"label":"ไม่เกิน 1 ล้าน","desc":"รถเก๋ง/อีโคคาร์"},{"label":"1–1.5 ล้าน","desc":"SUV ขนาดกลาง"}]},{"k":"use","label":"ใช้งานแบบไหนบ้าง","type":"multi","options":[{"label":"ในเมือง"},{"label":"เดินทางไกล"},{"label":"ออฟโรด"}]}]}[[/ASK]]
กติกา: 1–4 คำถาม · type: choice (เลือกหนึ่ง), multi (เลือกได้หลายข้อ), number, text, yesno · ตัวเลือก 2–4 ข้อ แต่ละข้อมี label สั้น และ desc อธิบายสั้น ๆ ได้ · ผู้ใช้พิมพ์คำตอบเองได้เสมอ ไม่ต้องใส่ตัวเลือก "อื่น ๆ"
ต้องเขียนสิ่งที่พอตอบได้ไปก่อนเสมอ · คุยเล่นห้ามใช้

[คำถามต่อ]
ถ้าไม่ได้ใช้ [[ASK]] ให้ปิดท้ายด้วยคำถามที่ผู้ใช้น่าจะถามต่อ 2–3 ข้อ (สั้น ไม่เกิน 40 ตัวอักษร เขียนแบบที่ผู้ใช้พิมพ์เอง):
[[NEXT]]["ค่าบำรุงรักษาต่อปีเท่าไหร่","ผ่อนเดือนละเท่าไหร่"][[/NEXT]]

[ผู้ใช้อยากซื้อรถ / ลังเลว่าจะซื้อรุ่นไหน]
ถ้ายังไม่รู้ งบ · การใช้งาน · จำนวนคน · เชื้อเพลิงที่ชอบ ให้ถามด้วย [[ASK]] ก่อน
เมื่อรู้แล้ว: แนะนำ 3 รุ่นเป็นตาราง (ราคา · ค่างวดโดยประมาณดาวน์ 25% 60 งวด · อัตราสิ้นเปลือง · ค่าบำรุงรักษาต่อปี · จุดเด่น · จุดที่ต้องรู้) แล้วฟันธงว่ารุ่นไหนเหมาะที่สุดเพราะอะไร

[มีรูปความเสียหาย หรือรูปใบเสนอราคา]
ประเมินเป็นตาราง: รายการ · ช่วงราคาที่เหมาะสมในไทย · ราคาที่อู่เสนอ (ถ้ามี) · ความเห็น (สมเหตุสมผล/แพงไป/ไม่จำเป็น)
แยกสิ่งที่เห็นในรูปกับสิ่งที่อนุมาน บอกว่าอะไรควรถามอู่เพิ่ม และค้นราคาอะไหล่ล่าสุดก่อนประเมิน`;
}


/* ══ ข้อมูลสดสำหรับแผงผู้ดูแล ══ */
function trail(meter, step) { if (meter) (meter.trail = meter.trail || []).push({ at: Date.now(), ...step }) }
/* รุ่น/ผู้ให้บริการที่ถูกพักไว้ตอนนี้ และจะกลับมาเมื่อไร */
export function badState() {
  const now = Date.now(), out = [];
  BAD.forEach((until, k) => { if (until > now) out.push({ key: k, backInSec: Math.round((until - now) / 1000) }) });
  return out;
}
export function unpark(key) { if (key) BAD.delete(key); else BAD.clear() }
