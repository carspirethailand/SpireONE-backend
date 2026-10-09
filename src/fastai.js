/* ══ เครื่องตอบเร็วของ Cendon ══
   ของเดิมต่อหนึ่งข้อความ: ค้นเว็บแยก (ไล่ลองได้ถึง 21 ครั้งกับโมเดลที่เลิกให้บริการแล้ว)
   → อ่านรูปแยกอีกหนึ่งครั้ง → ส่งให้โมเดลฟรีที่คิดนานแล้วค่อยตอบ → พลาดก็ถามซ้ำ
   ตอนนี้เหลือการเรียกครั้งเดียว: Gemini ค้นเว็บเอง เห็นรูปเอง คิด แล้วสตรีมคำตอบออกมาทันที

   โมเดลเลือกจาก GEMINI_SEARCH_MODEL (ค่าเริ่มต้น gemini-3.8-flash) แล้วถอยไป GEMINI_MODEL
   ถ้าชื่อโมเดลไหนใช้ไม่ได้ (404/400) จะรู้ภายในเสี้ยววินาทีแล้วข้ามไปตัวถัดไปเอง */

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

/* โทเคนโดยประมาณของข้อความล่าสุดที่ผู้ใช้ส่ง (ตัวอักษร/3 + รูปละ 300) — ใช้คิดโควตา */
function userTokens(contents) {
  const u = [...(contents || [])].reverse().find(c => c && c.role === 'user');
  if (!u) return 0;
  let n = 0;
  for (const p of u.parts || []) n += p.text ? Math.ceil(p.text.length / 3) : 300;
  return n;
}

/* โมเดลที่ใช้ตอบ + ค้นเว็บ เรียงตามลำดับที่จะลอง (gemini 3.1 flash lite และ 3.5 flash lite เป็นหลัก) */
export function chatModels(env) {
  const list = [
    env?.GEMINI_CHAT_MODEL,
    env?.GEMINI_SEARCH_MODEL,
    env?.GEMINI_MODEL,
    'gemini-2.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
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
  if (/gemini-3|gemini-[4-9]/.test(model)) return { thinkingLevel: level, includeThoughts: false };
  if (/gemini-2\.5/.test(model)) return { thinkingBudget: level === 'minimal' ? 0 : level === 'medium' ? 1024 : 256, includeThoughts: false };
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
    res = await fetch(`${base}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY }, body: JSON.stringify(body), signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(idle);
    const err = new Error(`${model}: ${e.message || e}`); err.retryable = true; throw err;
  }
  if (!res.ok || !res.body) {
    clearTimeout(idle);
    const t = await res.text().catch(() => '');
    const err = new Error(`${model} ${res.status}: ${t.slice(0, 1500)}`);
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

/* Never carry per-project/model throttles across a credential change. The hash,
   not the secret or its suffix, is safe to display in admin diagnostics. */
export async function geminiScope(env) {
  const bytes = new TextEncoder().encode(String(env.GEMINI_BASE_URL || '') + '\n' + env.GEMINI_KEY);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'gemini|' + [...new Uint8Array(digest)].slice(0, 12).map(x => x.toString(16).padStart(2, '0')).join('');
}

/* คำค้นจากบริบท: ข้อความล่าสุด + ข้อความก่อนหน้าของผู้ใช้ (ไว้เข้าใจ "ไม่ครับ ผมขอข้อมูล pajero" ที่ต่อจากเรื่องเดิม) */
const lastQ = contents => searchQuery([...(contents || [])].filter(c => c.role === 'user').map(u => (u.parts || []).map(p => p.text || '').join(' ')));
export function searchQuery(userTexts) {
  const FILL = /^(please|search|research|me|the|info|about|find|for|of|a|an|and|or|to)$/i;
  const TH_FILL = /ไม่ครับ|ไม่ค่ะ|ครับ|ค่ะ|นะคะ|นะ|ช่วยค้นหา|ค้นหา|ช่วย|หน่อย|ผมขอ|ฉันขอ|ขอดู|ขอ|ข้อมูลทั้งหมด|ข้อมูล|ทั้งหมด|อยากรู้|เกี่ยวกับ|บอกหน่อย/g;
  const neg = new Set(), pos = [];
  const add = (w, n) => { w = w.toLowerCase(); if (!w || FILL.test(w)) return; if (n) neg.add(w); else if (!pos.includes(w)) pos.push(w) };
  const take = t => {
    /* "not pajero sport" / "ไม่ใช่ pajero sport" → คำในวลีนี้เป็นคำที่ไม่ต้องการ (เว้นคำที่เป็นคำหลักอยู่แล้ว) */
    const parts = String(t || '').replace(TH_FILL, ' ').split(/(?:\bnot\b|ไม่ใช่)/i);
    parts.forEach((ph, i) => { const seg = i === 0 ? ph : ph.split(/[,.;!?]/)[0], rest = i === 0 ? '' : ph.slice(seg.length);
      seg.replace(/[?!.,"'()]/g, ' ').split(/\s+/).forEach(w => add(w, i > 0));
      rest.replace(/[?!.,"'()]/g, ' ').split(/\s+/).forEach(w => add(w, false)); });
  };
  const list = (userTexts || []).filter(Boolean);
  if (!list.length) return '';
  take(list[list.length - 1]);
  /* ข้อความล่าสุดสั้น/คลุมเครือ ("ไม่ครับ ผมขอข้อมูล pajero") → เติมคำสำคัญจากข้อความก่อนหน้า */
  for (let i = list.length - 2; i >= 0 && pos.length < 5; i--) take(list[i]);
  const minus = [...neg].filter(w => !pos.includes(w)).map(w => '-' + w);
  return pos.concat(minus).join(' ').slice(0, 160);
}
/* ══ สถาปัตยกรรม ReAct (Reason + Act Loop Engine) ══
   - สมองหลัก: openrouter/free (ผ่าน OpenRouter API)
   - ตัวสำรอง ReAct: gpt-oss-120b, gpt-oss-20b ผ่าน Groq เท่านั้น */
export function reactProviders(env) {
  const L = [];
  // 1. ตัวหลัก: OpenRouter (openrouter/free)
  if (env.OPENROUTER_API_KEY && !bad('react|openrouter')) {
    L.push({
      src: 'openrouter',
      url: `${env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`,
      key: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || 'openrouter/free',
      headers: { 'HTTP-Referer': 'https://carspirethailand.com', 'X-Title': 'Cendon' },
      timeoutMs: 10000
    });
  }
  // 2. ตัวสำรอง ReAct: Groq เท่านั้น (openai/gpt-oss-120b, openai/gpt-oss-20b, llama-3.1-8b-instant)
  if (env.GROQ_API_KEY && !bad('react|groq')) {
    const gu = `${env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'}/chat/completions`;
    L.push({
      src: 'groq',
      url: gu,
      key: env.GROQ_API_KEY,
      model: env.GROQ_MODEL || 'openai/gpt-oss-120b',
      altModel: 'openai/gpt-oss-20b',
      emergencyModel: 'llama-3.1-8b-instant',
      timeoutMs: 10000
    });
  }
  return L.sort((a,b)=>(a.src==='groq'?0:1)-(b.src==='groq'?0:1));
}

const REACT_SYSTEM_PROMPT = `

[สถาปัตยกรรม ReAct: คุณมีความสามารถในการคิดและเรียกใช้เครื่องมือ]
เครื่องมือที่คุณสามารถเรียกใช้ได้:
1. search(query): ค้นหาข้อมูลล่าสุดในอินเทอร์เน็ต เช่น ราคากลาง, สเปกรถปี 2024-2026, โปรโมชั่น, ดอกเบี้ย, ข่าวเปิดตัว, ข้อมูลรถรุ่นใหม่
2. describe_media(prompt): ตรวจดูและอธิบายรายละเอียดภาพถ่าย วิดีโอ หรือเสียงที่ผู้ใช้แนบมา
3. query_kb(query): ค้นหาคู่มือรถและฐานความรู้เฉพาะของรถรุ่นนี้

รูปแบบการทำงานในแต่ละรอบ:
Thought: [อธิบายความคิดสั้น ๆ ว่าทำไมต้องใช้เครื่องมือ หรือพร้อมตอบแล้ว]
Action: [ชื่อเครื่องมือ]("คำค้นหาหรือคำสั่ง")

ตัวอย่าง:
Thought: ผู้ใช้ถามเรื่องราคารถ Honda HR-V ปี 2026 ฉันจำเป็นต้องค้นหาข้อมูลล่าสุด
Action: search("honda hr-v 2026 ราคา สเปก ล่าสุด")

เมื่อระบบค้นหาแล้วจะส่งผลลัพธ์กลับมาเป็น:
Observation: [ผลการค้นหาจากเครื่องมือ]

คุณสามารถคิดและเรียกเครื่องมือต่อได้ หรือหากมีข้อมูลเพียงพอแล้ว ให้สรุปคำตอบโดยเริ่มจาก Final Answer:
Thought: ฉันได้ข้อมูลที่จำเป็นครบถ้วนแล้ว พร้อมสรุปคำตอบให้ผู้ใช้
Final Answer: [คำตอบที่สมบูรณ์ เป็นมิตร ตรงประเด็น และอ้างอิงจาก Observation]

ข้อสำคัญ:
- ถ้าไม่ต้องเรียกเครื่องมือ ให้ตอบ Final Answer: ได้ทันที
- ข้อความหลัง Final Answer: คือสิ่งเดียวที่จะแสดงให้ผู้ใช้เห็น
- ห้ามตอบว่าไม่มีเครื่องมือค้นหา หรือเข้าถึงอินเทอร์เน็ตไม่ได้ เพราะคุณมีเครื่องมือ search ให้เรียกใช้ได้ตลอดเวลา`;

export async function reactAgent(env, opts) {
  const providers = reactProviders(env);
  if (!providers.length) return null;

  const history = opts.history || (opts.messages ? toChatHistory(opts.messages) : (opts.contents ? toChatHistory(opts.contents) : []));
  const sys = (opts.system || '') + REACT_SYSTEM_PROMPT;

  let lastErr = null;

  for (const p of providers) {
    const t0 = Date.now();
    let thoughts = '';
    let didSearch = false;
    let turn = 0;
    const maxTurns = 3;
    let messages = [
      { role: 'system', content: sys },
      ...history
    ];

    try {
      let finalAnswer = '';
      while (turn < maxTurns) {
        turn++;
        let turnOutput = '';
        let seenFinalAnswer = false;
        let finalStreamStarted = false;

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort('timeout'), p.timeoutMs || 30000);

        try {
          const bodyPayload = {
            model: p.model,
            messages,
            temperature: 0.3,
            stream: true,
            ...(p.extra || {})
          };

          let res = await fetch(p.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${p.key}`,
              ...(p.headers || {})
            },
            body: JSON.stringify(bodyPayload),
            signal: ac.signal
          });

          // Groq fallback if model 404/429/413 (e.g. gpt-oss-120b -> gpt-oss-20b -> llama-3.1-8b-instant)
          if (!res.ok && p.src === 'groq') {
            if (p.altModel && (res.status === 404 || res.status === 429 || res.status === 413)) {
              bodyPayload.model = p.altModel;
              res = await fetch(p.url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${p.key}`,
                  ...(p.headers || {})
                },
                body: JSON.stringify(bodyPayload),
                signal: ac.signal
              });
            }
            if (!res.ok && p.emergencyModel && (res.status === 404 || res.status === 429 || res.status === 413)) {
              bodyPayload.model = p.emergencyModel;
              res = await fetch(p.url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${p.key}`,
                  ...(p.headers || {})
                },
                body: JSON.stringify(bodyPayload),
                signal: ac.signal
              });
            }
          }

          if (!res.ok) {
            const errTxt = await res.text().catch(() => '');
            throw new Error(`${p.src} ${res.status}: ${errTxt.slice(0, 160)}`);
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
                turnOutput += delta.content;
                if (!seenFinalAnswer) {
                  if (/Final Answer:\s*/i.test(turnOutput)) {
                    seenFinalAnswer = true;
                    finalStreamStarted = true;
                    const parts = turnOutput.split(/Final Answer:\s*/i);
                    const toSend = parts.slice(1).join('Final Answer:');
                    if (toSend && opts.onText) await opts.onText(toSend);
                  }
                } else if (finalStreamStarted && opts.onText) {
                  await opts.onText(delta.content);
                }
              }
            }
          }
        } finally {
          clearTimeout(timer);
        }

        // ตรวจสอบว่าโมเดลเรียกใช้ Action หรือไม่
        const combined = `${turnOutput}\n${thoughts}`;
        let actionMatch = combined.match(/(?:Action|Tool):\s*(\w+)\s*[:\(]\s*(?:query\s*=\s*|prompt\s*=\s*)?(["'`\u201c\u2018])([\s\S]*?)\2\s*\)?/i);
        if (!actionMatch) {
          const loose = combined.match(/(?:Action|Tool):\s*(\w+)\s*\(([^)]+)\)/i);
          if (loose) {
            actionMatch = [loose[0], loose[1], '"', loose[2].replace(/^["'`\u201c\u2018]|["'`\u201d\u2019]$/g, '').trim()];
          }
        }
        if (!actionMatch) {
          const tcMatch = combined.match(/<tool_call>[\s\S]*?"name":\s*"(\w+)"[\s\S]*?"(?:query|prompt)":\s*"([^"]+)"[\s\S]*?<\/tool_call>/i);
          if (tcMatch) {
            actionMatch = [tcMatch[0], tcMatch[1], '"', tcMatch[2]];
          }
        }

        // ถ้าโมเดลสั่ง Action และยังไม่เกินโควตารอบ (maxTurns)
        if (actionMatch && turn < maxTurns && !seenFinalAnswer) {
          const toolName = actionMatch[1].toLowerCase();
          const toolArg = actionMatch[3];
          let observation = '';

          if (toolName === 'search' || toolName === 'google_search' || toolName === 'web_search') {
            if (opts.onSearch) await opts.onSearch(toolArg);
            const searchFn = opts.executeSearch || (q => executeSearchInternal(env, q));
            observation = await searchFn(toolArg);
            didSearch = true;
          } else if (toolName === 'describe_media' && opts.executeMedia) {
            observation = await opts.executeMedia(toolArg);
          } else if (toolName === 'query_kb' && opts.executeKb) {
            observation = await opts.executeKb(toolArg);
          } else {
            observation = 'เครื่องมือนี้ไม่รองรับ';
          }

          messages.push({
            role: 'assistant',
            content: turnOutput.trim() || `Action: ${toolName}("${toolArg}")`
          });
          messages.push({
            role: 'user',
            content: `Observation: ${observation || 'ไม่พบข้อมูล'}` + (turn === maxTurns - 1 ? '\n\nคำสั่ง: ข้อมูลครบถ้วนแล้ว ให้สรุปคำตอบสุดท้ายโดยขึ้นต้นด้วย Final Answer:' : '')
          });

          continue;
        }

        // กรณีตอบเสร็จสิ้นแล้ว หรือไม่มี Action
        let clean = turnOutput;
        const faMatch = clean.match(/Final Answer:\s*([\s\S]+)$/i);
        if (faMatch) clean = faMatch[1];
        clean = stripToolCalls(clean).trim();

        if (!finalStreamStarted && clean && opts.onText) {
          await opts.onText(clean);
        }

        finalAnswer = clean;
        break;
      }

      if (finalAnswer && finalAnswer.trim()) {
        trail(opts.meter, { model: p.src + ':' + p.model, level: null, search: didSearch, ok: true, ms: Date.now() - t0, grounded: didSearch });
        return {
          text: finalAnswer,
          thoughts,
          grounded: didSearch,
          model: p.src + ':' + p.model
        };
      }
    } catch (err) {
      lastErr = err;
      console.warn(`[reactAgent] Provider ${p.src} failed:`, err.message || err);
      if (/429|rate/i.test(err.message || '')) markBad('react|' + p.src, 30000);
      else if (/40[1234]:/i.test(err.message || '')) markBad('react|' + p.src, 3600000);
      else markBad('react|' + p.src, 15000);
    }
  }

  throw lastErr || new Error('reactAgent failed across all providers');
}

export async function fastAnswer(env, opts) {
  let webResult;
  const freshSystem=async()=>{
    if(webResult===undefined)webResult=opts.question&&opts.executeSearch?await opts.executeSearch(opts.question).catch(()=> ''):'';
    return (opts.system||'')+'\nผลค้นเว็บจริง:\n'+String(webResult||'ยังยืนยันข้อมูลล่าสุดไม่ได้ ต้องแจ้งผู้ใช้ตรง ๆ').slice(0,9000);
  };
  // Start the single-pass streaming route before the slower multi-turn free agent.
  if (env.GEMINI_KEY) {
    const scope = await geminiScope(env);
    const models = chatModels(env);
    for (const model of models) {
      const scoped = key => scope + '|' + key;
      if (bad(scoped(model))) continue;
      let search=opts.search===true&&!bad(scoped(model+'|grounding'));
      let system=opts.system,level=opts.level||'minimal';
      if(opts.search===true&&!search&&opts.question)system=await freshSystem();
      for (let attempt=0;attempt<3;attempt++) {
        try {
          const t0=Date.now();
          const r = await streamOnce(env, model, { ...opts, system, level, search, onThought:undefined, headerMs:6000 });
          trail(opts.meter, { model, level, search, ok: true, ms:Date.now()-t0, grounded: r.grounded });
          return {...r,thoughts:''};
        } catch (e) {
          if(e.partial)return {text:e.partial,thoughts:'',model,grounded:false,partial:true};
          if(e.thinking&&level){level=level==='minimal'?null:'minimal';continue;}
          if(e.tool&&search){
            search=false;markBad(scoped(model+'|grounding'),60000);
            // Keep fresh answers grounded even where Google's search quota is unavailable.
            if(opts.question&&opts.executeSearch){
              system=await freshSystem();
            }
            continue;
          }
          if(e.quota||e.dead)markBad(scoped(model),60000);
          break;
        }
      }
    }
  }
  const fallback=await reactAgent(env,{...opts,onThought:undefined});
  if(fallback&&fallback.text?.trim())return {...fallback,thoughts:'',reasoning:''};
  throw new Error('All configured AI providers failed');
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
  /* สำรองเฉพาะ Groq และ OpenRouter */
  if (env.GROQ_API_KEY) {
    const gu = `${env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'}/chat/completions`;
    L.push({ src: 'groq', url: gu, key: env.GROQ_API_KEY, model: env.GROQ_MODEL || 'openai/gpt-oss-120b' });
    L.push({ src: 'groq-alt', url: gu, key: env.GROQ_API_KEY, model: env.GROQ_ALT_MODEL || 'llama-3.1-8b-instant' });
  }
  if (env.OPENROUTER_API_KEY) L.push({ src: 'openrouter', url: `${env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`,
    key: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || 'openrouter/free',
    headers: { 'HTTP-Referer': 'https://carspirethailand.com', 'X-Title': 'Cendon' } });
  return L.filter(p => !bad('fb|' + p.src));
}

/* คำสั่งเสริมของทางสำรอง: โมเดลพวกนี้ค้นเว็บไม่ได้ ต้องบอกตรง ๆ ไม่งั้นมันพยายามเรียกเครื่องมือที่ไม่มีอยู่ */
const NO_TOOLS = `

[สำคัญ] รอบนี้ไม่มีเครื่องมือใด ๆ ให้เรียกใช้ ห้ามเขียนคำสั่งเรียกฟังก์ชัน ห้ามเขียน google(...) / Action: google_search(...) หรือ <|tool_call|>
ตอบเป็นภาษาคนออกมาเลย จากความรู้ที่มี เรื่องที่ต้องใช้ข้อมูลล่าสุดให้บอกตรง ๆ ว่ายังยืนยันข้อมูลล่าสุดไม่ได้ แล้วแนะนำแหล่งที่ตรวจเองได้`;

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
  let last = null;
  const media = history.some(m => m.media);
  const clean = history.map(({ media, ...m }) => m);
  /* ย้ำให้ตอบคำถามล่าสุดตรง ๆ — รุ่นสำรองชอบหยิบข้อมูลรถในคำสั่งระบบมาตอบแทนสิ่งที่ถูกถาม */
  const FOCUS = '\n\n[สำคัญที่สุด] ตอบ "ข้อความล่าสุดของผู้ใช้" ให้ตรงประเด็น ข้อมูลรถของผู้ใช้ใช้ประกอบเท่านั้น ห้ามตอบแค่ข้อมูลรถถ้าเขาไม่ได้ถาม';
  let list = media ? fallbackProviders(env, true).concat(fallbackProviders(env)) : fallbackProviders(env);
  /* ทุกเจ้าถูกพักไว้หมด — ดีกว่าตอบว่าไม่มีทางสำรอง ให้ลองทุกเจ้าอีกรอบ (อาจหายแล้ว) */
  if (!list.length) { BAD.forEach((_, k) => { if (k.startsWith('fb|')) BAD.delete(k) }); list = fallbackProviders(env, media).concat(media ? fallbackProviders(env) : []) }
  /* ตัวสำรองค้นเว็บเองไม่ได้ — ค้น DuckDuckGo ให้ก่อนแล้วแนบผลไปในคำสั่งระบบ (ข้ามคำทักทายสั้น ๆ) */
  let web = '';
  const lastUser = [...clean].reverse().find(m => m.role === 'user');
  const txt = m => typeof m.content === 'string' ? m.content : (m.content || []).filter(x => x.type === 'text').map(x => x.text).join(' ');
  const q = searchQuery(clean.filter(m => m.role === 'user').map(txt));
  /* DuckDuckGo บล็อกการเรียกจาก Cloudflare (ได้หน้า captcha) — ปิดไว้จนกว่าจะมีตัวค้นที่ใช้ได้ (TAVILY_API_KEY) */
  const needWeb = opts.search === true || /ค้น|ข่าว|ล่าสุด|ตอนนี้|วันนี้|ปีนี้|ราคา|เปิดตัว|รุ่นใหม่|อัปเดต|internet|อินเทอร์เน็ต|research|search|latest|news|price|launch|20[2-3]\d|25[6-9]\d/i.test(q);
  if (q.length >= 6 && opts.search !== false && needWeb) {
    const t0 = Date.now();
    const w = await webSearch(env, q, { depth: opts.depth == null ? 1 : +opts.depth }); web = w.text;
    trail(opts.meter, { model: 'ค้นเว็บ:' + (w.src || 'ไม่พบ'), ok: !!web, ms: Date.now() - t0, err: w.stat || (web ? '' : 'no results') });
    if (web && opts.onResearch) try { await opts.onResearch(q) } catch (e) {}
  }
  const WEB = web ? `\n\n[ผลค้นเว็บจริง ณ ตอนนี้ — ใช้ข้อมูลนี้ตอบ อ้างอิงแหล่ง ห้ามบอกว่าค้นไม่ได้]\n${web}` : '';
  /* รุ่นสำรองมักมองข้ามข้อมูลยาวในคำสั่งระบบ แล้วตอบว่า "ไม่มีข้อมูล" — แปะผลค้นไว้ในข้อความล่าสุดของผู้ใช้ด้วย ให้อยู่ใกล้คำถามที่สุด */
  const withWeb = msgs => {
    if (!web) return msgs;
    const i = msgs.map(m => m.role).lastIndexOf('user');
    if (i < 0 || typeof msgs[i].content !== 'string') return msgs;
    const out = msgs.slice();
    out[i] = { ...out[i], content: `ข้อมูลที่ค้นจากเว็บมาให้แล้ว (ใช้ตอบได้เลย):\n${web.slice(0, 9000)}\n\n---\nคำถามของฉัน: ${out[i].content}\n\n(สรุปจากข้อมูลข้างบนเท่าที่มี บอกแหล่งที่มา ถ้าข้อมูลมีแค่บางส่วนให้ตอบส่วนที่มีพร้อมบอกว่าส่วนไหนยังไม่ยืนยัน ห้ามตอบว่าไม่มีข้อมูลถ้าข้างบนมีเนื้อหาเกี่ยวข้อง)` };
    return out;
  };
  for (const p of list) {
    let sys = system + (web ? NO_TOOLS.replace(/เรื่องที่ต้องใช้ข้อมูลล่าสุด[^\n]*/, 'ข้อมูลล่าสุดให้ใช้ผลค้นเว็บด้านล่าง') : NO_TOOLS) + WEB + FOCUS;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = Date.now();
      try {
        const r = await streamProvider(env, p, [{ role: 'system', content: sys }, ...(p.vision ? clean : withWeb(flat(clean)))], opts);
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
export function badState(scope) {
  const now = Date.now(), out = [];
  BAD.forEach((until, k) => {
    if(scope&&k.startsWith('gemini|')&&!k.startsWith(scope+'|'))return;
    if (until > now) out.push({ key: k, model: k.startsWith('gemini|') ? k.split('|').slice(2).join('|') : k, backInSec: Math.round((until - now) / 1000) });
  });
  return out;
}
export function unpark(key) { if (key) BAD.delete(key); else BAD.clear() }

/* ค้นเว็บด้วย DuckDuckGo (หน้า HTML ไม่ต้องใช้คีย์)
   คืนเป็นข้อความสรุป: หัวข้อ + เนื้อหาย่อ + ลิงก์ ไม่เกิน 6 รายการ · ล้มเหลว/ไม่เจอ = '' */
export async function fetchDuckDuckGoSearch(query, { limit = 6, timeoutMs = 6000 } = {}) {
  const q = String(query || '').trim();
  if (!q) return '';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8'
      },
      signal: ac.signal
    });
    if (!res.ok) return '';
    const html = await res.text();
    const txt = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const link = h => { const m = /[?&]uddg=([^&]+)/.exec(h || ''); try { return m ? decodeURIComponent(m[1]) : h } catch (e) { return h } };
    const out = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/g;
    let m;
    while ((m = re.exec(html)) && out.length < limit) {
      if (/result--ad|badge--ad/i.test(m[0])) continue;
      const title = txt(m[2]), snip = txt(m[3]);
      if (title && snip) out.push(`- ${title}: ${snip} (${link(m[1])})`);
    }
    return out.length ? `ผลค้นเว็บล่าสุดสำหรับ "${q}":\n${out.join('\n')}` : '';
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/* ══ ฟังก์ชันค้นหาหลักของระบบ (ReAct & Tools) ══
   1. ตัวหลัก: DuckDuckGo (เร็ว <1s, ฟรี, ไม่มีโควตา, เลี่ยงปัญหา Cloudflare Region Block)
   2. ตัวสำรอง: Gemini Google Search (gemini-3.1-flash-lite -> gemini-3.5-flash-lite)
   3. ตัวสำรองฉุกเฉิน: webSearch (Tavily / Brave / Google News RSS / Bing / Wikipedia) */
export async function executeSearchInternal(env, query) {
  const q = String(query || '').trim();
  if (!q) return '';

  // 1. DuckDuckGo ค้นหาจริง
  try {
    const ddg = await fetchDuckDuckGoSearch(q);
    if (ddg && ddg.trim()) {
      console.log(`[search] สำเร็จด้วย DuckDuckGo: "${q.slice(0, 40)}"`);
      return ddg;
    }
  } catch (e) {
    console.warn('[search] DuckDuckGo error:', e.message || e);
  }

  // 2. Gemini Google Search (gemini-3.1-flash-lite -> gemini-3.5-flash-lite)
  if (env.GEMINI_KEY && !bad('gemini|quota') && !bad('gemini|region')) {
    const geminiKey = env.GEMINI_KEY;
    const baseUrl = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
    const models = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];
    const prompt = `ค้นข้อมูลล่าสุดในอินเทอร์เน็ตเรื่องนี้ แล้วสรุปเฉพาะข้อเท็จจริงที่ยืนยันได้: ${q}
แหล่งที่เชื่อได้: เว็บผู้ผลิต ศูนย์บริการ สื่อรถยนต์ที่มีกองบรรณาธิการ สำนักข่าวหลัก ร้านค้าที่มีราคาชัดเจน
รูปแบบการตอบ: ข้อเท็จจริงสั้น ๆ เป็นข้อ ๆ พร้อมระบุชื่อเว็บแหล่งที่มา ห้ามแต่งตัวเลข ถ้าไม่พบข้อมูลให้ตอบ "ไม่พบข้อมูลยืนยัน"`;

    for (const m of models) {
      try {
        const res = await fetch(`${baseUrl}/v1beta/models/${m}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.2 },
          }),
        });
        if (res.ok) {
          const data = await res.json();
          const cand = (data.candidates && data.candidates[0]) || {};
          const txt = stripToolCalls(((cand.content && cand.content.parts) || []).map(x => x.text || '').join('').trim());
          if (txt && !/^ไม่พบข้อมูลยืนยัน/.test(txt)) {
            console.log(`[search] สำเร็จด้วย Gemini (${m})`);
            return txt;
          }
        } else if (res.status === 429) {
          markBad('gemini|quota', 60000);
        } else if (res.status === 400) {
          const errBody = await res.text().catch(() => '');
          if (/location|region/i.test(errBody)) markBad('gemini|region', 300000);
        }
      } catch (e) {
        console.warn(`[search] Gemini ${m} error:`, e.message || e);
      }
    }
  }

  // 3. ตัวสำรองฉุกเฉิน (Tavily / Brave / Google News RSS / Bing / Wikipedia)
  try {
    const ws = await webSearch(env, q);
    if (ws && ws.text) {
      console.log(`[search] สำเร็จด้วย webSearch (${ws.src})`);
      return ws.text;
    }
  } catch (e) {}

  return '';
}



/* ══ ค้นเว็บแยกจาก Gemini ══
   Gemini Free Tier ใช้ Google Search ผ่าน API ไม่ได้ (429 ตั้งแต่ครั้งแรก) จึงค้นเองแล้วส่งผลให้โมเดลตอบ
   ลำดับ: Tavily (ถ้ามี TAVILY_API_KEY) → Brave (BRAVE_API_KEY) → Google News RSS + Wikipedia (ฟรี ไม่ต้องมีคีย์) */
const WEB_CACHE = new Map();
const unent = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
async function getT(url, init = {}, ms = 5000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }) } finally { clearTimeout(t) }
}
export async function webSearch(env, query, { max = 6, depth = 1 } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { text: '', src: '' };
  const ck = q + '|' + depth;
  const hit = WEB_CACHE.get(ck); if (hit && hit.exp > Date.now()) return hit.v;
  const keep = v => { WEB_CACHE.set(ck, { v, exp: Date.now() + 600000 }); if (WEB_CACHE.size > 200) WEB_CACHE.delete(WEB_CACHE.keys().next().value); return v };
  const fmt = rows => rows.slice(0, max + 4).map(r => `- ${r.title}${r.date ? ' (' + r.date + ')' : ''}: ${r.snip} [${r.url}]`).join('\n');
  try {
    if (env.TAVILY_API_KEY) {
      const r = await getT('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.TAVILY_API_KEY },
        body: JSON.stringify({ query: q, max_results: max, include_answer: true, search_depth: 'basic' }) }, 8000);
      if (r.ok) { const d = await r.json(); const rows = (d.results || []).map(x => ({ title: x.title, snip: String(x.content || '').slice(0, 300), url: x.url }));
        if (rows.length) return keep({ text: (d.answer ? 'สรุป: ' + d.answer + '\n' : '') + fmt(rows), src: 'tavily' }); }
    }
  } catch (e) {}
  try {
    if (env.BRAVE_API_KEY) {
      const r = await getT('https://api.search.brave.com/res/v1/web/search?count=' + max + '&q=' + encodeURIComponent(q), { headers: { Accept: 'application/json', 'X-Subscription-Token': env.BRAVE_API_KEY } });
      if (r.ok) { const d = await r.json(); const rows = ((d.web && d.web.results) || []).map(x => ({ title: unent(x.title), snip: unent(x.description), url: x.url, date: x.age }));
        if (rows.length) return keep({ text: fmt(rows), src: 'brave' }); }
    }
  } catch (e) {}
  /* ฟรีไม่ต้องมีคีย์ — ยิงหลายแหล่งพร้อมกัน แหล่งไหนช้า/ถูกบล็อกก็ไม่ลากทั้งหมด (แต่ละแหล่งรอไม่เกิน 4 วิ)
     Google News (ไทย+อังกฤษ) · Bing News · Bing เว็บทั่วไป · Wikipedia (ไทย+อังกฤษ) */
  const th = /[฀-๿]/.test(q);
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', 'Accept-Language': 'th,en;q=0.8' };
  const rss = async (url, tag) => {
    try {
      const r = await getT(url, { headers: UA }, 4000);
      if (!r.ok) return { tag, rows: [], err: String(r.status) };
      const x = await r.text(), out = [];
      for (const m of x.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const it = m[1], g = t => (it.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')) || [])[1];
        const d = g('pubDate'), ts = d ? Date.parse(d) : 0;
        const title = unent(g('title')); if (!title) continue;
        out.push({ title, snip: unent(g('description')).slice(0, 240), url: unent(g('link')), date: ts ? new Date(ts).toISOString().slice(0, 10) : '', ts, tag });
        if (out.length >= 10) break; }
      return { tag, rows: out, err: out.length ? '' : 'empty' };
    } catch (e) { return { tag, rows: [], err: e.name === 'AbortError' ? 'timeout' : 'fail' } }
  };
  const wiki = async lang => {
    try {
      const r = await getT(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=2&srsearch=` + encodeURIComponent(q.replace(/(^|\s)-\S+/g, '')), { headers: { 'User-Agent': 'CendonBot/1.0' } }, 4000);
      if (!r.ok) return { tag: 'wiki-' + lang, rows: [], err: String(r.status) };
      const d = await r.json();
      const rows = ((d.query && d.query.search) || []).map(x => ({ title: 'Wikipedia: ' + x.title, snip: unent(x.snippet), url: `https://${lang}.wikipedia.org/wiki/` + encodeURIComponent(x.title.replace(/ /g, '_')), ts: 0, tag: 'wiki-' + lang }));
      return { tag: 'wiki-' + lang, rows, err: rows.length ? '' : 'empty' };
    } catch (e) { return { tag: 'wiki-' + lang, rows: [], err: 'fail' } }
  };
  const qe = encodeURIComponent(q);
  const got = await Promise.all([
    rss(`https://news.google.com/rss/search?q=${qe}&hl=th&gl=TH&ceid=TH:th`, 'gnews-th'),
    rss(`https://news.google.com/rss/search?q=${qe}&hl=en-US&gl=US&ceid=US:en`, 'gnews-en'),
    rss(`https://www.bing.com/news/search?q=${qe}&format=rss&setlang=${th ? 'th' : 'en'}`, 'bing-news'),
    rss(`https://www.bing.com/search?q=${qe}&format=rss&setlang=${th ? 'th' : 'en'}`, 'bing-web'),
    wiki('en'), th ? wiki('th') : Promise.resolve({ tag: 'wiki-th', rows: [], err: 'skip' }),
  ]);
  /* รวม: ข่าวใหม่สุดก่อน · ผลเว็บทั่วไปแทรกเข้ามา · ตัดหัวข้อซ้ำ · เก็บสถิติแต่ละแหล่งไว้ให้แผงผู้ดูแล */
  const seen = new Set(), rows = [];
  const pool = got.flatMap(g => g.rows).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  for (const x of pool) { const k = x.title.toLowerCase().replace(/\W+/g, '').slice(0, 50); if (!k || seen.has(k)) continue; seen.add(k); rows.push(x); if (rows.length >= max + 4) break; }
  let stat = got.map(g => g.tag + ':' + (g.rows.length || g.err)).join(' ');
  /* อ่านเนื้อหาจริงตามโหมด: Sprint ไม่อ่าน · Grand Tour 2 เว็บ (3 วิ) · Atelier 4 เว็บ (6 วิ) — เลือกเว็บน่าเชื่อถือก่อน */
  const READ = depth >= 2 ? { n: 4, ms: 6000 } : depth == 1 ? { n: 2, ms: 3000 } : null;
  let pages = '';
  if (READ && rows.length) {
    const rd = await readPages(rows, q, READ.n, READ.ms);
    pages = rd.text; stat += ' · อ่าน ' + rd.ok + '/' + rd.tried + ' เว็บ';
  }
  return keep(rows.length ? { text: fmt(rows) + (pages ? '\n\nเนื้อหาจากหน้าเว็บที่เปิดอ่าน:\n' + pages : ''), src: 'multi', stat } : { text: '', src: '', stat });
}
export const webBlock = w => w && w.text ? `\n\n[ผลค้นเว็บจริง ณ ตอนนี้ (${w.src}) เรียงข่าวใหม่สุดก่อน — ข้อมูลนี้ใหม่กว่าความรู้ของคุณ ให้เชื่อข่าวเหล่านี้เป็นหลัก แม้ขัดกับที่คุณเคยรู้ (เช่น รุ่นที่คุณคิดว่ายังไม่เปิดตัว) ระบุแหล่ง/วันที่ ห้ามตอบว่ายังไม่มีข้อมูลยืนยันถ้าในผลค้นมีข่าวเรื่องนั้น]\n${w.text}` : '';


/* ══ เปิดอ่านหน้าเว็บจริง ══ */
const TRUST = [
  /* ผู้ผลิตรถ */ /(^|\.)(mitsubishi-motors|toyota|honda|isuzu|nissan|mazda|ford|bmw|mercedes-benz|hyundai|kia|suzuki|mg|byd|gwm|subaru|lexus|volvo|porsche|tesla)\.(com|co\.th|co\.jp|net)$/i,
  /* สื่อรถไทย */ /(^|\.)(headlightmag\.com|autospinn\.com|grandprix\.co\.th|carvariety\.com|autodeft\.com|checkraka\.com|one2car\.com|motortrivia\.com|autostation\.com|car250\.com|tnews\.co\.th)$/i,
  /* สื่อรถต่างประเทศ */ /(^|\.)(carscoops\.com|motor1\.com|autocar\.co\.uk|caranddriver\.com|topgear\.com|carexpert\.com\.au|drive\.com\.au|paultan\.org|carsguide\.com\.au|autoblog\.com|motortrend\.com|whichcar\.com\.au|edmunds\.com)$/i,
  /* ข่าวทั่วไป/ทางการ */ /(^|\.)(thairath\.co\.th|bangkokpost\.com|nationthailand\.com|matichon\.co\.th|prachachat\.net|thaipbs\.or\.th|reuters\.com|bbc\.com|apnews\.com|tmd\.go\.th|go\.th)$/i,
];
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '') } catch (e) { return '' } };
/* ลิงก์ Bing News เป็นลิงก์ผ่าน (apiclick ...&url=) — ดึง url จริงออกมา · ลิงก์ Google News เปิดตรงไม่ได้ ข้าม */
function realUrl(u) {
  try { const x = new URL(u); if (/bing\.com$/.test(x.hostname) && x.searchParams.get('url')) return x.searchParams.get('url');
    if (/news\.google\.com$/.test(x.hostname)) return ''; return u } catch (e) { return '' }
}
function pageText(html, q) {
  let t = String(html || '').replace(/<(script|style|noscript|svg|nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, ' ');
  const art = t.match(/<article[\s\S]*?<\/article>/i); if (art) t = art[0];
  t = unent(t);
  /* เลือกช่วงที่มีคำค้นหนาแน่นที่สุด ไม่ใช่แค่ต้นหน้า (ซึ่งมักเป็นเมนู) */
  const words = String(q).toLowerCase().split(/\s+/).filter(w => w.length > 2 && !w.startsWith('-'));
  if (t.length <= 1600 || !words.length) return t.slice(0, 1600);
  let best = 0, bestAt = 0;
  for (let i = 0; i < t.length - 1600; i += 400) { const seg = t.slice(i, i + 1600).toLowerCase(); const sc = words.reduce((n, w) => n + seg.split(w).length - 1, 0); if (sc > best) { best = sc; bestAt = i } }
  return t.slice(bestAt, bestAt + 1600);
}
export async function readPages(rows, q, n, budgetMs) {
  const score = u => { const h = hostOf(u); const i = TRUST.findIndex(re => re.test(h)); return i < 0 ? 9 : i };
  const cand = rows.map(r => ({ ...r, real: realUrl(r.url) })).filter(r => r.real && !/wikipedia\.org/.test(r.real))
    .sort((a, b) => score(a.real) - score(b.real)).slice(0, n);
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', 'Accept-Language': 'th,en;q=0.8', Accept: 'text/html' };
  const res = await Promise.all(cand.map(async r => {
    try { const x = await getT(r.real, { headers: UA, redirect: 'follow' }, budgetMs);
      if (!x.ok || !/html/i.test(x.headers.get('content-type') || '')) return '';
      const body = (await x.text()).slice(0, 400000), txt = pageText(body, q);
      return txt.length > 200 ? `【${r.title}】 (${hostOf(r.real)}${r.date ? ', ' + r.date : ''})\n${txt}` : '';
    } catch (e) { return '' } }));
  const ok = res.filter(Boolean);
  return { text: ok.join('\n\n'), ok: ok.length, tried: cand.length };
}
