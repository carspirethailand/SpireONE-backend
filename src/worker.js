import { verifyFirebaseToken } from './auth.js';

/*
 * SpireONE backend — security-hardened.
 * - GEMINI_KEY lives ONLY here (wrangler secret), never in the frontend.
 * - Every privileged route verifies the Firebase ID token server-side.
 * - Role system: owner > admin > moderator > user (owners come from OWNERS env).
 * - AI proxy with per-user daily quota; banned users are rejected everywhere.
 * - Config (announcement / maintenance) + audit log stored in D1.
 */

const ROLE_RANK = { owner: 4, admin: 3, moderator: 2, user: 1 };

function owners(env) {
  return (env.OWNERS || 'anapatmaliwong@gmail.com,carspirethailand@gmail.com')
    .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
}

function corsHeaders(env, request) {
  const allowed = (env.ALLOWED_ORIGINS || '*').trim();
  let origin = '*';
  if (allowed !== '*') {
    const reqOrigin = request.headers.get('Origin') || '';
    const list = allowed.split(',').map(s => s.trim());
    origin = list.includes(reqOrigin) ? reqOrigin : list[0] || '*';
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin',
  };
}

async function getAuthenticatedUser(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }
  const token = authHeader.split('Bearer ')[1];
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is not configured');
  return await verifyFirebaseToken(token, projectId);
}

/** Returns { payload, role, banned, email }. Owner role comes from env, others from DB. */
async function getActor(request, env) {
  const payload = await getAuthenticatedUser(request, env);
  const email = (payload.email || '').toLowerCase();
  if (owners(env).includes(email)) {
    return { payload, email, role: 'owner', banned: false };
  }
  const row = await env.DB.prepare('SELECT role, banned FROM users WHERE uid = ?')
    .bind(payload.sub).first();
  return {
    payload, email,
    role: (row && ROLE_RANK[row.role]) ? row.role : 'user',
    banned: !!(row && row.banned),
  };
}

function rank(role) { return ROLE_RANK[role] || 0; }

async function getConfig(env, key, fallback) {
  try {
    const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(key).first();
    return row && row.value ? JSON.parse(row.value) : fallback;
  } catch { return fallback; }
}

async function setConfig(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, JSON.stringify(value)).run();
}

async function logAudit(env, actor, action, target, detail) {
  try {
    await env.DB.prepare('INSERT INTO audit (t, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
      .bind(Date.now(), actor || '', action || '', target || '', String(detail || '').slice(0, 500)).run();
  } catch (e) { /* audit must never break the request */ }
}

/* ===== Gemini (server-side only — key never leaves the Worker) ===== */
async function callGemini(env, { contents, system, search, temp }) {
  const geminiKey = env.GEMINI_KEY;
  if (!geminiKey) throw new Error('AI is not configured');
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const baseUrl = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${geminiKey}`;

  const body = { contents, generationConfig: { temperature: typeof temp === 'number' ? Math.min(Math.max(temp, 0), 1) : 0.5 } };
  if (system) body.systemInstruction = { parts: [{ text: String(system).slice(0, 8000) }] };
  if (search) body.tools = [{ google_search: {} }];

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AI upstream error ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const c = (data.candidates && data.candidates[0]) || {};
  return ((c.content && c.content.parts) || []).map(p => p.text || '').join('').trim();
}

/** Validates the AI request body coming from the browser. Throws on abuse. */
function validateContents(contents) {
  if (!Array.isArray(contents) || contents.length === 0 || contents.length > 30) {
    throw new Error('Invalid contents');
  }
  for (const m of contents) {
    if (!m || (m.role !== 'user' && m.role !== 'model') || !Array.isArray(m.parts) || m.parts.length > 8) {
      throw new Error('Invalid message');
    }
    for (const p of m.parts) {
      if (typeof p.text === 'string') {
        if (p.text.length > 24000) throw new Error('Message too long');
      } else if (p.inline_data) {
        const d = p.inline_data;
        if (typeof d.mime_type !== 'string' || !/^(image|video|audio)\//.test(d.mime_type)) throw new Error('Invalid media type');
        if (typeof d.data !== 'string' || d.data.length > 15000000) throw new Error('Media too large');
      } else {
        throw new Error('Invalid part');
      }
    }
  }
}

async function fetchWithRetry(url, options, maxRetries = 2) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    attempt++;
    const res = await fetch(url, options);
    if (res.status === 403 && attempt <= maxRetries) {
      const text = await res.clone().text();
      if (text.includes('Cloudflare') || text.includes('Attention Required')) {
        console.warn(`WAF block detected (attempt ${attempt}/${maxRetries+1}). Retrying in 500ms...`);
        await new Promise(resolve => setTimeout(resolve, 400 + Math.random() * 300));
        continue;
      }
    }
    return res;
  }
  return fetch(url, options);
}

async function callWorkersAI(env, messages) {
  if (!env.AI) {
    throw new Error("Cloudflare Workers AI binding 'AI' is not configured");
  }
  const model = env.CF_AI_FALLBACK_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  
  const formatted = messages.map(m => {
    let role = m.role;
    if (role !== "system" && role !== "user" && role !== "assistant") {
      role = "user";
    }
    return { role, content: m.content || "" };
  });

  const response = await env.AI.run(model, { messages: formatted });
  if (!response || !response.response) {
    throw new Error("Cloudflare Workers AI returned an empty response");
  }
  return response.response.trim();
}

async function callReasoningModel(env, messages) {
  if (env.OPENROUTER_API_KEY) {
    const model = env.OPENROUTER_MODEL || "openai/gpt-oss-120b:free";
    const baseUrl = env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
    const url = `${baseUrl}/chat/completions`;
    
    try {
      const res = await fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://carspirethailand.com",
          "X-Title": "SpireONE"
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.3
        })
      });

      if (res.ok) {
        const data = await res.json();
        const content = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
        if (content) return content;
      }
      
      console.warn(`OpenRouter primary call returned status ${res.status}. Falling back to Cloudflare Workers AI...`);
    } catch (err) {
      console.warn(`OpenRouter primary call failed: ${err.message}. Falling back to Cloudflare Workers AI...`);
    }
  } else {
    console.warn("OPENROUTER_API_KEY is not configured. Falling back to Cloudflare Workers AI...");
  }

  try {
    return await callWorkersAI(env, messages);
  } catch (err) {
    throw new Error(`Reasoning failure (OpenRouter failed & Cloudflare Workers AI fallback failed: ${err.message})`);
  }
}

async function runReActAgent(env, carInfo, messages) {
  const carContext = (carInfo.make || carInfo.model) 
    ? `\nรถของผู้ใช้: ${carInfo.make || ''} ${carInfo.model || ''} ปี ${carInfo.year || '-'} เลขไมล์ ${carInfo.mileage || '-'} กม.` 
    : '';

  const systemPrompt = `คุณคือ SpireONE ผู้ช่วย AI ดูแลรถยนต์และวิเคราะห์ปัญหารถยนต์ที่ชาญฉลาด ตอบเป็นภาษาไทยเป็นหลัก พูดจาเป็นกันเองและเป็นมืออาชีพ คุณจะควบคุมกระบวนการคิดในการหาคำตอบที่ถูกต้องที่สุดให้ผู้ใช้ โดยเขียนวิเคราะห์กระบวนการใน Thought ก่อนเสมอ
ข้อมูลรถปัจจุบัน:${carContext}

คุณมีเครื่องมือช่วยเหลือดังต่อไปนี้ที่คุณสามารถระบุสั่งงานได้:
1. describe_media(prompt): สั่งให้ Gemini ช่วยตรวจดูและอธิบายไฟล์สื่อ (ภาพ, วิดีโอ, เสียง) ที่แนบเข้ามาในประวัติแชต โดยคุณสามารถใส่คำอธิบายเพิ่มเติมใน prompt ได้ตามต้องการ เช่น describe_media("ตรวจสอบจุดรั่วซึมใต้ท้องรถจากภาพถ่าย")
2. google_search(query): สั่งให้ Gemini ช่วยค้นหาข้อมูลและสรุปข่าวสาร ราคากลาง หรือสเปกทางวิศวกรรมล่าสุดจากเว็บด้วยคำค้น query เช่น google_search("ราคายาง Michelin Primacy 4 ปี 2026")

รูปแบบที่คุณต้องปฏิบัติตามในการตอบสนอง (ตอบแบบ ReAct):
Thought: [ความคิดหรือเหตุผลของคุณว่าต้องทำอะไรต่อ]
Action: [เลือกเรียกเครื่องมือเพียง 1 อย่างในแต่ละรอบ เช่น describe_media("...") หรือ google_search("...")]
Observation: [ระบบหลังบ้านจะนำผลลัพธ์มาแปะให้ตรงนี้เอง ห้ามคุณเขียนขึ้นมาเองเด็ดขาด]
... (คิดวนซ้ำ Thought/Action/Observation ได้สูงสุด 3 รอบ)
Thought: [เมื่อได้ข้อมูลครบถ้วนแล้วและต้องการปิดคำตอบ]
Final Answer: [คำตอบภาษาไทยสรุปอย่างเป็นมืออาชีพที่จะส่งไปให้ผู้ใช้จริง]

สำคัญมาก:
- ห้ามเขียน Observation หรือข้อมูลหลังคำว่า Observation เองเด็ดขาด!
- หากมีไฟล์แนบในแชต คุณต้องเรียกใช้ describe_media เสมอเพื่อเอาข้อมูลสังเกตมาคิดวิเคราะห์
- หากต้องการเช็กราคาสินค้า ข่าว หรือสเปกที่ต้องการความสดใหม่ ให้เรียกใช้ google_search
- หากข้อมูลพร้อมและไม่ต้องรันเครื่องมือ ให้ข้าม Action และเขียน Final Answer ได้เลย`;

  const chatHistory = messages.map(m => {
    const o = { role: m.role === "user" ? "user" : "assistant", content: "" };
    if (m.parts && Array.isArray(m.parts)) {
      m.parts.forEach(p => {
        if (p.text) {
          o.content += p.text;
        }
        if (p.inline_data) {
          o.content += ` [ไฟล์สื่อแนบประเภท: ${p.inline_data.mime_type}]`;
        }
      });
    } else {
      o.content = m.text || "";
    }
    return o;
  });

  const agentLog = [
    { role: "system", content: systemPrompt },
    ...chatHistory
  ];

  let step = 0;
  const maxSteps = 3;

  while (step < maxSteps) {
    step++;
    
    let completionText;
    try {
      completionText = await callReasoningModel(env, agentLog);
    } catch (err) {
      throw new Error(`ReAct reasoning failure: ${err.message}`);
    }

    agentLog.push({ role: "assistant", content: completionText });

    const actionMatch = completionText.match(/Action:\s*(\w+)\s*\((["'])(.*?)\2\)/i);
    
    if (actionMatch) {
      const toolName = actionMatch[1].toLowerCase();
      const toolInput = actionMatch[3];
      let observation = "";

      try {
        if (toolName === "describe_media") {
          observation = await executeDescribeMediaTool(env, messages, toolInput);
        } else if (toolName === "google_search") {
          observation = await executeGoogleSearchTool(env, toolInput);
        } else {
          observation = `Error: Unknown tool "${toolName}"`;
        }
      } catch (toolErr) {
        observation = `Error running tool: ${toolErr.message}`;
      }

      agentLog.push({ role: "user", content: `Observation: ${observation}` });
    } else {
      const finalAnswerMatch = completionText.match(/Final Answer:\s*([\s\S]+)$/i);
      if (finalAnswerMatch) {
        return finalAnswerMatch[1].trim();
      }
      return completionText;
    }
  }

  const lastText = agentLog[agentLog.length - 1].content;
  const finalAnswerMatch = lastText.match(/Final Answer:\s*([\s\S]+)$/i);
  return finalAnswerMatch ? finalAnswerMatch[1].trim() : lastText;
}

async function executeDescribeMediaTool(env, messages, prompt) {
  const geminiKey = env.GEMINI_KEY;
  if (!geminiKey) {
    throw new Error('GEMINI_KEY environment variable is not configured');
  }
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const baseUrl = env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${geminiKey}`;

  const parts = [];
  messages.forEach(m => {
    if (m.parts && Array.isArray(m.parts)) {
      m.parts.forEach(p => {
        if (p.inline_data) {
          parts.push({
            inline_data: {
              mime_type: p.inline_data.mime_type,
              data: p.inline_data.data
            }
          });
        }
      });
    }
  });

  if (parts.length === 0) {
    return "ไม่มีไฟล์รูปภาพ วิดีโอ หรือข้อความเสียงแนบมาในแชตนี้";
  }

  parts.push({ text: `กรุณาอธิบายไฟล์สื่อตามคำสั่งนี้: ${prompt}\nตอบสั้นกระชับเข้าใจง่าย` });

  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.4 }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`Media reader error: ${res.status}`);
  }

  const data = await res.json();
  const candidate = (data.candidates && data.candidates[0]) || {};
  return ((candidate.content && candidate.content.parts) || [])
    .map(p => p.text || "")
    .join("")
    .trim();
}

async function executeGoogleSearchTool(env, query) {
  const geminiKey = env.GEMINI_KEY;
  if (!geminiKey) {
    throw new Error('GEMINI_KEY environment variable is not configured');
  }
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const baseUrl = env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${geminiKey}`;

  const body = {
    contents: [{ parts: [{ text: `ค้นข้อมูลในอินเทอร์เน็ตเกี่ยวกับหัวข้อนี้ และตอบสรุปสั้นๆ ให้ถูกต้องและกระชับ: ${query}` }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.4 }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`Google Search tool error: ${res.status}`);
  }

  const data = await res.json();
  const candidate = (data.candidates && data.candidates[0]) || {};
  return ((candidate.content && candidate.content.parts) || [])
    .map(p => p.text || "")
    .join("")
    .trim();
}

function parseJsonLoose(text) {
  let s = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const m = s.match(/[\[{][\s\S]*[\]}]/);
  if (m) s = m[0];
  return JSON.parse(s);
}

/** Structured car diagnosis — powered by Gemini. */
async function getGeminiDiagnosis(env, carInfo, symptoms) {
  const prompt = `คุณเป็นผู้เชี่ยวชาญด้านการวินิจฉัยปัญหารถยนต์ กรุณาวิเคราะห์อาการต่อไปนี้แล้วให้การวินิจฉัยเบื้องต้น

ข้อมูลรถ: ยี่ห้อ ${carInfo.make || 'ไม่ระบุ'} รุ่น ${carInfo.model || 'ไม่ระบุ'} ปี ${carInfo.year || 'ไม่ระบุ'} เลขไมล์ ${carInfo.mileage || 'ไม่ระบุ'} กิโลเมตร

อาการที่พบ: ${symptoms}

ตอบเป็น JSON object เท่านั้น ห้ามเขียนคำนำ คำอธิบาย หรือ markdown ใดๆ นอกจาก JSON โดยมีโครงสร้างดังนี้:
{
  "summary": "สรุปอาการและแนวโน้มปัญหาโดยย่อ 1-2 ประโยค",
  "possibleCauses": [
    { "cause": "ชื่อสาเหตุที่เป็นไปได้", "likelihood": "สูง หรือ กลาง หรือ ต่ำ", "explanation": "คำอธิบายสั้นๆ ว่าทำไมถึงเป็นไปได้" }
  ],
  "severity": "ต่ำ หรือ ปานกลาง หรือ สูง หรือ ฉุกเฉิน",
  "recommendedAction": "คำแนะนำว่าควรทำอย่างไรต่อไป",
  "shouldVisitMechanic": true หรือ false,
  "disclaimer": "คำเตือนว่านี่เป็นการวินิจฉัยเบื้องต้นจาก AI ไม่ใช่การวินิจฉัยของช่างผู้เชี่ยวชาญ"
}`;
  const text = await callGemini(env, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    system: 'You are an expert car mechanic. You must output only a valid JSON object matching the requested schema. Do not write any explanations outside the JSON.',
    temp: 0.3,
  });
  const parsed = parseJsonLoose(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('AI response is not a JSON object');
  }
  return parsed;
}

/* ===== Magazine news via Gemini ===== */
async function getGeminiNews(env) {
  const prompt = `ค้นเว็บหาข่าวและบทความเกี่ยวกับรถยนต์ล่าสุดในไทยวันนี้ โดยใช้ข้อมูลจากแหล่งข่าวที่น่าเชื่อถือ ทั้งข่าวไทยและต่างประเทศ เช่น Car And Driver, Top Gear, autolifethailand, headlightmag, motorexpo, thairath, prachatai, manager ฯลฯ สรุปออกมา 10-20 ข่าว/บทความที่น่าสนใจที่สุด

ตอบเป็น JSON array เท่านั้น ห้ามเขียนคำนำ คำอธิบาย หรือ markdown ใดๆ นอกจาก JSON

แต่ละรายการต้องมีฟิลด์ดังนี้:
1. title: พาดหัวข่าวที่กระชับและดึงดูดความสนใจ
2. shortDescription: สรุปสั้น 1-2 ประโยค สำหรับแสดงในการ์ดข่าว
3. fullDescription: เนื้อหาข่าวฉบับเต็มที่ละเอียด ครบถ้วน และถูกต้องที่สุด ความยาวอย่างน้อย 50-350 ประโยค ครอบคลุม: บริบทและที่มาของข่าว, ข้อเท็จจริงสำคัญทั้งหมด (ตัวเลข ราคา สเปค ฯลฯ), ผลกระทบหรือความสำคัญต่อผู้ใช้รถในไทย, ข้อมูลเพิ่มเติมที่เป็นประโยชน์
4. type: ประเภทข่าว เลือกจาก: ข่าวเด่น, รีวิว, เทคโนโลยี, เคล็ดลับ, EV, ราคา, อุบัติเหตุ, นโยบาย

ตัวอย่าง JSON:
[
  {
    "title": "พาดหัวข่าว",
    "shortDescription": "สรุปสั้น 1-2 ประโยค",
    "fullDescription": "เนื้อหาข่าวฉบับเต็มที่ละเอียดและครบถ้วน อธิบายบริบท ข้อเท็จจริง ตัวเลข และผลกระทบอย่างครอบคลุม...",
    "type": "ข่าวเด่น"
  }
]`;

  const text = await callGemini(env, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    search: true, temp: 0.4,
  });
  let s = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const m = s.match(/[\[{][\s\S]*[\]}]/);
  if (m) s = m[0];
  const parsed = JSON.parse(s);
  if (!Array.isArray(parsed)) throw new Error('AI response is not a JSON array');
  return parsed;
}

async function fetchAndSaveNews(env) {
  if (!env.DB) throw new Error('D1 Database connection is not configured');
  const newsList = await getGeminiNews(env);
  if (!Array.isArray(newsList) || newsList.length === 0) throw new Error('Fetched news array is empty');

  await env.DB.prepare('DELETE FROM magazine').run();
  const stmt = env.DB.prepare(
    'INSERT INTO magazine (title, short_description, full_description, type, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const now = Date.now();
  await env.DB.batch(newsList.map(n => stmt.bind(
    n.title || '', n.shortDescription || n.short_description || '',
    n.fullDescription || n.full_description || '', n.type || 'ข่าวเด่น', now
  )));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { ...cors, 'Content-Type': 'application/json' },
    });
    const deny = (msg, status) => json({ error: msg }, status);

    if (!env.DB) return deny('Database is not configured', 500);

    // Wraps a handler with auth + minimum-role + ban checks.
    const guarded = (minRole, handler) => async () => {
      let actor;
      try { actor = await getActor(request, env); }
      catch (e) { return deny('Invalid authentication token', 401); }
      if (actor.banned) return deny('Account suspended', 403);
      if (rank(actor.role) < rank(minRole)) return deny('Forbidden: insufficient role', 403);
      try { return await handler(actor); }
      catch (e) { return deny(e.message || 'Server error', 500); }
    };

    const readBody = async () => { try { return await request.json(); } catch { return null; } };

    try {

      /* ===== PUBLIC: site config (announcement / maintenance) ===== */
      if (url.pathname === '/api/config' && request.method === 'GET') {
        const announcement = await getConfig(env, 'announcement', { enabled: false, text: '', type: 'info' });
        const maintenance = await getConfig(env, 'maintenance', { enabled: false, message: '' });
        return json({ announcement, maintenance });
      }

      /* ===== LOGIN ===== */
      if (url.pathname === '/api/login' && request.method === 'POST') {
        let payload;
        try { payload = await getAuthenticatedUser(request, env); }
        catch (e) { return deny('Invalid authentication token', 401); }

        const bodyData = (await readBody()) || {};
        const uid = payload.sub;
        const email = (payload.email || '').toLowerCase();
        const name = String(bodyData.name || payload.name || email.split('@')[0]).slice(0, 120);
        const photo = String(bodyData.photo || payload.picture || '').slice(0, 500);
        const isOwner = owners(env).includes(email);
        const now = Date.now();

        // Preserve assigned role/banned/created_at on re-login; owners are always owner.
        await env.DB.prepare(`
          INSERT INTO users (uid, name, email, photo, role, last_login, created_at, banned)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(uid) DO UPDATE SET
            name = excluded.name,
            email = excluded.email,
            photo = excluded.photo,
            last_login = excluded.last_login,
            role = CASE WHEN excluded.role = 'owner' THEN 'owner' ELSE users.role END,
            created_at = COALESCE(users.created_at, excluded.created_at)
        `).bind(uid, name, email, photo, isOwner ? 'owner' : 'user', now, now).run();

        const row = await env.DB.prepare('SELECT role, banned FROM users WHERE uid = ?').bind(uid).first();
        if (row && row.banned && !isOwner) return deny('Account suspended', 403);
        const role = isOwner ? 'owner' : ((row && row.role) || 'user');

        return json({ uid, name, email, photo, role, last_login: now });
      }

      /* ===== AI PROXY (login required, quota enforced) ===== */
      if (url.pathname === '/api/ai/chat' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const maintenance = await getConfig(env, 'maintenance', { enabled: false });
          if (maintenance.enabled && rank(actor.role) < rank('moderator')) {
            return deny('maintenance', 503);
          }
          const body = await readBody();
          if (!body) return deny('Invalid JSON body', 400);
          try { validateContents(body.contents); }
          catch (e) { return deny(e.message, 400); }

          // Daily quota (admins and owners are exempt)
          if (rank(actor.role) < rank('admin')) {
            const limit = parseInt(env.AI_DAILY_LIMIT || '60', 10);
            const day = new Date().toISOString().slice(0, 10);
            const row = await env.DB.prepare(`
              INSERT INTO usage (uid, day, count) VALUES (?, ?, 1)
              ON CONFLICT(uid, day) DO UPDATE SET count = count + 1
              RETURNING count
            `).bind(actor.payload.sub, day).first();
            if (row && row.count > limit) return deny('quota', 429);
          }

          let carInfo = { make: '', model: '', year: '', mileage: '' };
          if (body.carId && actor.payload.sub && env.DB) {
            const car = await env.DB.prepare('SELECT make, model, year, mileage FROM cars WHERE id = ? AND uid = ?')
              .bind(String(body.carId), actor.payload.sub).first();
            if (car) carInfo = car;
          }

          const text = await runReActAgent(env, carInfo, body.contents);
          return json({ text });
        })();
      }

      /* ===== LIVE CALL — ephemeral token so the browser can open a
       * Gemini Live API WebSocket directly (voice + camera), without
       * ever seeing the real API key. Token is single-use, short-lived,
       * and locked to our model + system prompt. ===== */
      if (url.pathname === '/api/ai/live-token' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const maintenance = await getConfig(env, 'maintenance', { enabled: false });
          if (maintenance.enabled && rank(actor.role) < rank('moderator')) return deny('maintenance', 503);

          // a live session is heavier than a text message — count it as 5 toward the daily quota
          if (rank(actor.role) < rank('admin')) {
            const limit = parseInt(env.AI_DAILY_LIMIT || '60', 10);
            const day = new Date().toISOString().slice(0, 10);
            const row = await env.DB.prepare(`
              INSERT INTO usage (uid, day, count) VALUES (?, ?, 5)
              ON CONFLICT(uid, day) DO UPDATE SET count = count + 5
              RETURNING count
            `).bind(actor.payload.sub, day).first();
            if (row && row.count > limit) return deny('quota', 429);
          }

          const geminiKey = env.GEMINI_KEY;
          if (!geminiKey) return deny('AI is not configured', 500);
          const b = (await readBody()) || {};
          const liveModel = env.GEMINI_LIVE_MODEL || 'gemini-live-2.5-flash-native-audio';
          const baseUrl = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
          const now = Date.now();

          const tokenReq = {
            uses: 1,
            expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
            newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
            liveConnectConstraints: {
              model: 'models/' + liveModel,
              config: {
                responseModalities: ['AUDIO'],
                systemInstruction: { parts: [{ text: String(b.system || '').slice(0, 6000) }] },
                inputAudioTranscription: {},
                outputAudioTranscription: {},
              },
            },
          };

          const res = await fetch(`${baseUrl}/v1alpha/auth_tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
            body: JSON.stringify(tokenReq),
          });
          if (!res.ok) {
            const t = await res.text();
            return deny(`Live token error ${res.status}: ${t.slice(0, 200)}`, 502);
          }
          const tok = await res.json();
          return json({ token: tok.name, model: liveModel });
        })();
      }

      /* ===== DIAGNOSE (all-Gemini) =====
       * Auth is optional (kept compatible with demo clients), but:
       * - anonymous callers get a strict per-IP daily quota
       * - signed-in users share the normal AI quota; banned users rejected
       */
      if (url.pathname === '/api/diagnose' && request.method === 'POST') {
        try {
          let actor = null;
          if ((request.headers.get('Authorization') || '').startsWith('Bearer ')) {
            try { actor = await getActor(request, env); } catch (e) { /* treat as anonymous */ }
          }
          if (actor && actor.banned) return deny('Account suspended', 403);

          const maintenance = await getConfig(env, 'maintenance', { enabled: false });
          if (maintenance.enabled && (!actor || rank(actor.role) < rank('moderator'))) {
            return deny('maintenance', 503);
          }

          const b = await readBody();
          if (!b) return deny('Invalid JSON body', 400);
          const mode = b.mode || 'diagnose';

          const exempt = actor && rank(actor.role) >= rank('admin');
          if (!exempt) {
            const key = actor ? actor.payload.sub : 'ip:' + (request.headers.get('CF-Connecting-IP') || 'unknown');
            const limit = actor ? parseInt(env.AI_DAILY_LIMIT || '60', 10) : parseInt(env.AI_ANON_DAILY_LIMIT || '15', 10);
            const day = new Date().toISOString().slice(0, 10);
            const row = await env.DB.prepare(`
              INSERT INTO usage (uid, day, count) VALUES (?, ?, 1)
              ON CONFLICT(uid, day) DO UPDATE SET count = count + 1
              RETURNING count
            `).bind(key, day).first();
            if (row && row.count > limit) return deny('quota', 429);
          }

          let carInfo = { make: '', model: '', year: '', mileage: '' };
          if (b.carId && actor) {
            const car = await env.DB.prepare('SELECT make, model, year, mileage FROM cars WHERE id = ? AND uid = ?')
              .bind(String(b.carId), actor.payload.sub).first();
            if (car) carInfo = car;
          }
          if (!carInfo.make) {
            carInfo = {
              make: String(b.make || '').slice(0, 60), model: String(b.model || '').slice(0, 60),
              year: b.year != null ? String(b.year).slice(0, 8) : '',
              mileage: b.mileage != null ? String(b.mileage).slice(0, 12) : '',
            };
          }

          if (mode === 'diagnose') {
            const symptomsText = (b.symptoms
              || (Array.isArray(b.messages) && b.messages.length && b.messages[b.messages.length - 1].text) || '').trim();
            if (!symptomsText) return deny('Missing required field: symptoms', 400);
            const diagnosis = await getGeminiDiagnosis(env, carInfo, symptomsText.slice(0, 4000));
            return json({ carInfo, diagnosis, created_at: Date.now() });
          }

          if (mode === 'chat') {
            if (!Array.isArray(b.messages)) return deny('Missing or invalid messages array', 400);
            const carContext = (carInfo.make || carInfo.model)
              ? `\nรถของผู้ใช้: ${carInfo.make || ''} ${carInfo.model || ''} ปี ${carInfo.year || '-'} เลขไมล์ ${carInfo.mileage || '-'} กม.` : '';
            const systemPrompt = `คุณคือ SpireONE ผู้ช่วย AI ดูแลรถยนต์ พูดจาเป็นกันเองอบอุ่นเหมือนเพื่อนช่างมืออาชีพ ตอบเป็นภาษาไทยเป็นหลัก (หรือสลับภาษาตามที่คู่สนทนาพิมพ์มา). ช่วยวินิจฉัยอาการรถ ให้คำแนะนำเป็นขั้นตอน ประเมินค่าใช้จ่ายคร่าวๆ และตอบคำถามเรื่องรถทุกอย่าง. ตอบกระชับ อ่านง่าย ใช้หัวข้อย่อย (ขึ้นต้นด้วย "- ") เมื่อเหมาะสม. ย้ำเสมอว่าเป็นการประเมินเบื้องต้น ควรให้ช่างตรวจจริงเพื่อความปลอดภัย.${carContext}`;
            const hasMedia = b.messages.some(m => m.atts && m.atts.some(a => a.b64));
            const contents = b.messages.slice(-12).map(m => {
              const parts = [];
              if (m.text) parts.push({ text: String(m.text) });
              (m.atts || []).forEach(a => { if (a.b64 && a.mime) parts.push({ inline_data: { mime_type: a.mime, data: a.b64 } }); });
              if (!parts.length) parts.push({ text: '' });
              return { role: m.role === 'user' ? 'user' : 'model', parts };
            });
            try { validateContents(contents); } catch (e) { return deny(e.message, 400); }
            const text = await callGemini(env, { contents, system: systemPrompt, search: !hasMedia, temp: 0.5 });
            return json({ text });
          }

          if (mode === 'summarize') {
            if (!Array.isArray(b.messages)) return deny('Missing or invalid messages array', 400);
            const convo = b.messages.slice(-14)
              .map(m => (m.role === 'user' ? 'USER: ' : 'AI: ') + String(m.text || '').slice(0, 2000)).join('\n');
            const prompt = `จากบทสนทนาวินิจฉัยรถต่อไปนี้ สรุปผลเป็น JSON เท่านั้น ห้ามมีข้อความอื่น:
{"symptom":"อาการหลักโดยย่อ","causes":["สาเหตุที่เป็นไปได้ เรียงจากน่าจะเป็นมากสุด 2-4 ข้อ"],"urgency":"low หรือ medium หรือ high","cost":"ช่วงค่าซ่อมโดยประมาณ (ระบุสกุลเงินบาท)","advice":"คำแนะนำขั้นตอนถัดไป 1-2 ประโยค"}
เขียนค่าทุกฟิลด์เป็นภาษาไทย

บทสนทนา:
${convo}`;
            const text = await callGemini(env, { contents: [{ role: 'user', parts: [{ text: prompt }] }], temp: 0.3 });
            return json({ summary: parseJsonLoose(text) });
          }

          return deny('Unsupported mode: ' + mode, 400);
        } catch (err) {
          return deny(err.message || 'Server error', 500);
        }
      }

      /* ===== CARS ===== */
      if (url.pathname === '/api/cars' && request.method === 'GET') {
        return await guarded('user', async (actor) => {
          const { results } = await env.DB.prepare('SELECT * FROM cars WHERE uid = ? ORDER BY created_at DESC')
            .bind(actor.payload.sub).all();
          return json(results);
        })();
      }

      if (url.pathname === '/api/cars' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const bodyData = await readBody();
          if (!bodyData) return deny('Invalid JSON body', 400);
          const { id, make, model, year, mileage } = bodyData;
          if (!make || !model) return deny('Missing required fields: make, model', 400);
          const carId = (typeof id === 'string' && id.length < 60 ? id : '') || 'c' + Date.now();
          const now = Date.now();
          await env.DB.prepare(`
            INSERT INTO cars (id, uid, make, model, year, mileage, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              make = excluded.make, model = excluded.model,
              year = excluded.year, mileage = excluded.mileage
            WHERE cars.uid = excluded.uid
          `).bind(carId, actor.payload.sub, String(make).slice(0, 60), String(model).slice(0, 60),
            String(year || '').slice(0, 8), String(mileage || '').slice(0, 12), now).run();
          return json({ id: carId, uid: actor.payload.sub, make, model, year: year || '', mileage: mileage || '', created_at: now });
        })();
      }

      if (url.pathname.startsWith('/api/cars/') && request.method === 'DELETE') {
        return await guarded('user', async (actor) => {
          const carId = url.pathname.split('/').pop();
          if (!carId) return deny('Missing car ID', 400);
          const result = await env.DB.prepare('DELETE FROM cars WHERE id = ? AND uid = ?')
            .bind(carId, actor.payload.sub).run();
          if (result.meta && result.meta.changes === 0) return deny('Car not found or unauthorized', 404);
          return json({ success: true });
        })();
      }

      /* ===== MAGAZINE (public read) ===== */
      if (url.pathname === '/api/magazine' && request.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM magazine ORDER BY id ASC').all();
        return json(results);
      }

      /* ===== MAGAZINE MANAGEMENT (moderator+) ===== */
      if (url.pathname === '/api/magazine/sync' && request.method === 'POST') {
        return await guarded('moderator', async (actor) => {
          await fetchAndSaveNews(env);
          await logAudit(env, actor.email, 'magazine.sync', '', 'AI refresh');
          return json({ success: true });
        })();
      }

      if (url.pathname === '/api/admin/magazine' && request.method === 'POST') {
        return await guarded('moderator', async (actor) => {
          const b = await readBody();
          if (!b || !b.title) return deny('Missing title', 400);
          await env.DB.prepare(
            'INSERT INTO magazine (title, short_description, full_description, type, created_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(String(b.title).slice(0, 300), String(b.short_description || '').slice(0, 1000),
            String(b.full_description || '').slice(0, 20000), String(b.type || 'ข่าวเด่น').slice(0, 40), Date.now()).run();
          await logAudit(env, actor.email, 'magazine.create', String(b.title).slice(0, 80), '');
          return json({ success: true });
        })();
      }

      if (url.pathname === '/api/admin/magazine' && request.method === 'DELETE') {
        return await guarded('admin', async (actor) => {
          await env.DB.prepare('DELETE FROM magazine').run();
          await logAudit(env, actor.email, 'magazine.clear', '', 'deleted all articles');
          return json({ success: true });
        })();
      }

      const magIdMatch = url.pathname.match(/^\/api\/admin\/magazine\/(\d+)$/);
      if (magIdMatch && request.method === 'PUT') {
        return await guarded('moderator', async (actor) => {
          const b = await readBody();
          if (!b) return deny('Invalid JSON body', 400);
          const r = await env.DB.prepare(
            'UPDATE magazine SET title = ?, short_description = ?, full_description = ?, type = ? WHERE id = ?'
          ).bind(String(b.title || '').slice(0, 300), String(b.short_description || '').slice(0, 1000),
            String(b.full_description || '').slice(0, 20000), String(b.type || 'ข่าวเด่น').slice(0, 40), +magIdMatch[1]).run();
          if (r.meta && r.meta.changes === 0) return deny('Article not found', 404);
          await logAudit(env, actor.email, 'magazine.edit', '#' + magIdMatch[1], String(b.title || '').slice(0, 80));
          return json({ success: true });
        })();
      }
      if (magIdMatch && request.method === 'DELETE') {
        return await guarded('moderator', async (actor) => {
          const r = await env.DB.prepare('DELETE FROM magazine WHERE id = ?').bind(+magIdMatch[1]).run();
          if (r.meta && r.meta.changes === 0) return deny('Article not found', 404);
          await logAudit(env, actor.email, 'magazine.delete', '#' + magIdMatch[1], '');
          return json({ success: true });
        })();
      }

      /* ===== ADMIN: USERS & ROLES ===== */
      if (url.pathname === '/api/admin/users' && request.method === 'GET') {
        return await guarded('admin', async () => {
          const q = (url.searchParams.get('q') || '').trim().toLowerCase();
          let results;
          if (q) {
            ({ results } = await env.DB.prepare(
              'SELECT uid, name, email, photo, role, banned, last_login, created_at FROM users WHERE lower(name) LIKE ? OR lower(email) LIKE ? ORDER BY last_login DESC LIMIT 200'
            ).bind(`%${q}%`, `%${q}%`).all());
          } else {
            ({ results } = await env.DB.prepare(
              'SELECT uid, name, email, photo, role, banned, last_login, created_at FROM users ORDER BY last_login DESC LIMIT 200'
            ).all());
          }
          const own = owners(env);
          return json(results.map(u => ({ ...u, role: own.includes((u.email || '').toLowerCase()) ? 'owner' : u.role })));
        })();
      }

      if (url.pathname === '/api/admin/users/role' && request.method === 'POST') {
        return await guarded('admin', async (actor) => {
          const b = await readBody();
          if (!b || !b.uid || !['admin', 'moderator', 'user'].includes(b.role)) return deny('Invalid role request', 400);
          const target = await env.DB.prepare('SELECT uid, email, role FROM users WHERE uid = ?').bind(b.uid).first();
          if (!target) return deny('User not found', 404);
          const targetIsOwner = owners(env).includes((target.email || '').toLowerCase());
          if (targetIsOwner) return deny('Cannot change an owner', 403);
          // Only the owner may grant/revoke admin, or touch another admin.
          if ((b.role === 'admin' || target.role === 'admin') && actor.role !== 'owner') {
            return deny('Only the owner can manage admins', 403);
          }
          await env.DB.prepare('UPDATE users SET role = ? WHERE uid = ?').bind(b.role, b.uid).run();
          await logAudit(env, actor.email, 'user.role', target.email, `${target.role} → ${b.role}`);
          return json({ success: true });
        })();
      }

      if (url.pathname === '/api/admin/users/ban' && request.method === 'POST') {
        return await guarded('admin', async (actor) => {
          const b = await readBody();
          if (!b || !b.uid) return deny('Invalid request', 400);
          const target = await env.DB.prepare('SELECT uid, email, role FROM users WHERE uid = ?').bind(b.uid).first();
          if (!target) return deny('User not found', 404);
          const targetIsOwner = owners(env).includes((target.email || '').toLowerCase());
          if (targetIsOwner) return deny('Cannot ban an owner', 403);
          if (target.role === 'admin' && actor.role !== 'owner') return deny('Only the owner can ban admins', 403);
          await env.DB.prepare('UPDATE users SET banned = ? WHERE uid = ?').bind(b.banned ? 1 : 0, b.uid).run();
          await logAudit(env, actor.email, b.banned ? 'user.ban' : 'user.unban', target.email, '');
          return json({ success: true });
        })();
      }

      /* ===== ADMIN: STATS ===== */
      if (url.pathname === '/api/admin/stats' && request.method === 'GET') {
        return await guarded('moderator', async () => {
          const now = Date.now();
          const totalUsers = await env.DB.prepare('SELECT COUNT(*) c FROM users').first();
          const activeToday = await env.DB.prepare('SELECT COUNT(*) c FROM users WHERE last_login > ?').bind(now - 864e5).first();
          const bannedCount = await env.DB.prepare('SELECT COUNT(*) c FROM users WHERE banned = 1').first();
          const totalCars = await env.DB.prepare('SELECT COUNT(*) c FROM cars').first();
          const magCount = await env.DB.prepare('SELECT COUNT(*) c FROM magazine').first();
          const day = new Date().toISOString().slice(0, 10);
          const aiToday = await env.DB.prepare('SELECT COALESCE(SUM(count),0) c FROM usage WHERE day = ?').bind(day).first();
          const aiTotal = await env.DB.prepare('SELECT COALESCE(SUM(count),0) c FROM usage').first();
          const { results: aiDaily } = await env.DB.prepare(
            'SELECT day, SUM(count) c FROM usage GROUP BY day ORDER BY day DESC LIMIT 14'
          ).all();
          const { results: signups } = await env.DB.prepare(
            "SELECT date(created_at/1000,'unixepoch') d, COUNT(*) c FROM users WHERE created_at IS NOT NULL GROUP BY d ORDER BY d DESC LIMIT 14"
          ).all();
          return json({
            totalUsers: totalUsers.c, activeToday: activeToday.c, banned: bannedCount.c,
            totalCars: totalCars.c, magazine: magCount.c,
            aiToday: aiToday.c, aiTotal: aiTotal.c,
            aiDaily: aiDaily.reverse(), signups: signups.reverse(),
          });
        })();
      }

      /* ===== ADMIN: CONFIG ===== */
      if (url.pathname === '/api/admin/config' && request.method === 'POST') {
        return await guarded('admin', async (actor) => {
          const b = await readBody();
          if (!b) return deny('Invalid JSON body', 400);
          if (b.announcement) {
            const a = {
              enabled: !!b.announcement.enabled,
              text: String(b.announcement.text || '').slice(0, 300),
              type: ['info', 'warn'].includes(b.announcement.type) ? b.announcement.type : 'info',
            };
            await setConfig(env, 'announcement', a);
            await logAudit(env, actor.email, 'config.announcement', '', a.enabled ? a.text.slice(0, 80) : 'disabled');
          }
          if (b.maintenance) {
            const m = { enabled: !!b.maintenance.enabled, message: String(b.maintenance.message || '').slice(0, 300) };
            await setConfig(env, 'maintenance', m);
            await logAudit(env, actor.email, 'config.maintenance', '', m.enabled ? 'ON' : 'OFF');
          }
          return json({ success: true });
        })();
      }

      /* ===== ADMIN: AUDIT LOG ===== */
      if (url.pathname === '/api/admin/audit' && request.method === 'GET') {
        return await guarded('admin', async () => {
          const { results } = await env.DB.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 150').all();
          return json(results);
        })();
      }

      return deny('Not Found', 404);
    } catch (err) {
      return deny('Server error', 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndSaveNews(env));
  }
};
