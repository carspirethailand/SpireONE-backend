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


/* Runs a query that may fail because a migration has not been applied yet.
   Returns `fallback` instead of throwing, and records what was missing so the
   admin panel can tell the operator exactly which migration to run. */
async function safe(env, warnings, label, fn, fallback) {
  try { return await fn(); }
  catch (e) {
    const m = String(e && e.message || e);
    warnings.push({ part: label, error: m.slice(0, 200) });
    return fallback;
  }
}

/* Probes the schema so the admin panel can show a precise diagnosis. */
async function schemaReport(env) {
  const need = {
    users:    ['uid', 'name', 'email', 'photo', 'role', 'last_login', 'banned', 'created_at'],
    cars:     ['id', 'uid', 'make', 'model', 'year', 'mileage', 'created_at'],
    magazine: ['id', 'title', 'short_description', 'full_description', 'type', 'created_at'],
    config:   ['key', 'value'],
    audit:    ['id', 't', 'actor', 'action', 'target', 'detail'],
    usage:    ['uid', 'day', 'count'],
    shop:     ['id', 'title', 'category', 'price', 'url', 'image', 'note', 'created_at'],
  };
  const out = { ok: true, tables: {}, missingTables: [], missingColumns: [] };
  for (const table of Object.keys(need)) {
    let cols = [];
    try {
      const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
      cols = (results || []).map(r => r.name);
    } catch (e) { cols = []; }
    if (!cols.length) {
      out.tables[table] = { exists: false, columns: [] };
      out.missingTables.push(table);
      out.ok = false;
      continue;
    }
    const missing = need[table].filter(c => !cols.includes(c));
    out.tables[table] = { exists: true, columns: cols, missing };
    if (missing.length) { out.missingColumns.push({ table, columns: missing }); out.ok = false; }
  }
  out.fix = out.ok ? '' : 'wrangler d1 migrations apply spireone --remote';
  return out;
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
  const hasKey = !!env.OPENROUTER_API_KEY;
  console.log(`[AI Reasoning] OPENROUTER_API_KEY configured: ${hasKey}`);

  if (hasKey) {
    const model = env.OPENROUTER_MODEL || "openai/gpt-oss-20b:free";
    const baseUrl = env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
    const url = `${baseUrl}/chat/completions`;
    
    console.log(`[OpenRouter] Sending request to model: ${model} at ${url}`);
    
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

      console.log(`[OpenRouter] Response HTTP status: ${res.status} ${res.statusText}`);

      const resText = await res.text();

      if (res.ok) {
        let data;
        try {
          data = JSON.parse(resText);
        } catch (e) {
          console.error(`[OpenRouter] Failed to parse JSON response: ${resText}`);
          throw e;
        }

        const content = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
        if (content) {
          console.log(`[OpenRouter] Success! Generated content length: ${content.length}`);
          return content;
        }
        console.warn(`[OpenRouter] Empty content in choices payload:`, JSON.stringify(data));
      } else {
        console.error(`[OpenRouter Error ${res.status}]: ${resText}`);
      }
      
      console.warn(`[OpenRouter] Call failed (Status ${res.status}). Falling back to Cloudflare Workers AI...`);
    } catch (err) {
      console.error(`[OpenRouter Exception]: ${err.message}`, err.stack);
      console.warn(`Falling back to Cloudflare Workers AI...`);
    }
  } else {
    console.warn("OPENROUTER_API_KEY is not configured in environment. Falling back to Cloudflare Workers AI...");
  }

  console.log(`[AI Reasoning] Attempting fallback via Cloudflare Workers AI...`);
  try {
    return await callWorkersAI(env, messages);
  } catch (err) {
    console.error(`[Cloudflare Workers AI Fallback Failed]: ${err.message}`);
    throw new Error(`Reasoning failure (OpenRouter failed & Cloudflare Workers AI fallback failed: ${err.message})`);
  }
}

async function runReActAgent(env, carInfo, messages) {
  const carContext = (carInfo.make || carInfo.model) 
    ? `\nรถของผู้ใช้: ${carInfo.make || ''} ${carInfo.model || ''} ปี ${carInfo.year || '-'} เลขไมล์ ${carInfo.mileage || '-'} กม.` 
    : '';

  console.log(`[ReAct Agent] Injected vehicle context: ${carContext ? carContext.trim() : '(None)'}`);

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

/* ===== SHOP: AI-sourced parts & accessories ===== */
async function getGeminiShop(env) {
  const prompt = `ค้นเว็บหาสินค้าอะไหล่รถยนต์และของตกแต่งที่กำลังนิยมในไทยตอนนี้ จากร้านค้าออนไลน์ที่น่าเชื่อถือ (เช่น Shopee, Lazada, ร้านอะไหล่แท้ศูนย์) สรุปออกมา 12-20 รายการที่คุ้มค่าและน่าสนใจที่สุด

ตอบเป็น JSON array เท่านั้น ห้ามมีคำนำ คำอธิบาย หรือ markdown ใดๆ

แต่ละรายการต้องมีฟิลด์:
1. title: ชื่อสินค้าแบบกระชับ
2. category: หมวดหมู่ เลือกจาก: อะไหล่, ของตกแต่ง, น้ำมันเครื่อง, ยางและล้อ, เครื่องเสียง, อุปกรณ์ความปลอดภัย, ดูแลรักษา
3. price: ช่วงราคาเป็นบาท เช่น "1,200 - 1,800 บาท"
4. url: ลิงก์สินค้า ถ้าไม่มั่นใจให้เว้นว่าง ""
5. note: เหตุผลสั้นๆ ว่าทำไมน่าซื้อ 1-2 ประโยค

ตัวอย่าง:
[{"title":"ผ้าเบรกหน้า Bendix","category":"อะไหล่","price":"1,200 - 1,800 บาท","url":"","note":"ทนความร้อนดี ฝุ่นน้อย เหมาะกับรถบ้านใช้ในเมือง"}]`;

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

async function fetchAndSaveShop(env) {
  if (!env.DB) throw new Error('D1 Database connection is not configured');
  const list = await getGeminiShop(env);
  if (!Array.isArray(list) || list.length === 0) throw new Error('Fetched product array is empty');
  await env.DB.prepare('DELETE FROM shop').run();
  const stmt = env.DB.prepare(
    'INSERT INTO shop (title, category, price, url, image, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const now = Date.now();
  await env.DB.batch(list.slice(0, 40).map(n => stmt.bind(
    String(n.title || '').slice(0, 200), String(n.category || 'อะไหล่').slice(0, 60),
    String(n.price || '').slice(0, 40), String(n.url || '').slice(0, 500),
    String(n.image || '').slice(0, 500), String(n.note || '').slice(0, 1000), now
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
        const features = await getConfig(env, 'features', {});
        const limits = await getConfig(env, 'limits', {
          aiDaily: parseInt(env.AI_DAILY_LIMIT || '60', 10),
          anonDaily: parseInt(env.AI_ANON_DAILY_LIMIT || '15', 10),
        });
        return json({ announcement, maintenance, features, limits });
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
            const limit = (await getConfig(env, 'limits', {})).aiDaily || parseInt(env.AI_DAILY_LIMIT || '60', 10);
            const day = new Date().toISOString().slice(0, 10);
            const row = await env.DB.prepare(`
              INSERT INTO usage (uid, day, count) VALUES (?, ?, 1)
              ON CONFLICT(uid, day) DO UPDATE SET count = count + 1
              RETURNING count
            `).bind(actor.payload.sub, day).first();
            if (row && row.count > limit) return deny('quota', 429);
          }

          let carInfo = { make: '', model: '', year: '', mileage: '' };
          console.log(`[AI Chat] Received request with carId: ${body.carId || 'None'} for UID: ${actor.payload.sub}`);
          if (body.carId && actor.payload.sub && env.DB) {
            const car = await env.DB.prepare('SELECT make, model, year, mileage FROM cars WHERE id = ? AND uid = ?')
              .bind(String(body.carId), actor.payload.sub).first();
            if (car) {
              carInfo = car;
              console.log(`[AI Chat] Car details found in D1:`, JSON.stringify(carInfo));
            } else {
              console.warn(`[AI Chat] carId ${body.carId} requested but no matching record found in D1 for UID ${actor.payload.sub}`);
            }
          }
          
          if (!carInfo.make && !carInfo.model) {
            carInfo = {
              make: String(body.make || '').slice(0, 60),
              model: String(body.model || '').slice(0, 60),
              year: body.year != null ? String(body.year).slice(0, 8) : '',
              mileage: body.mileage != null ? String(body.mileage).slice(0, 12) : '',
            };
            if (carInfo.make || carInfo.model) {
              console.log(`[AI Chat] Used fallback car details from request body:`, JSON.stringify(carInfo));
            } else {
              console.log(`[AI Chat] No car details available from D1 or request body`);
            }
          }

          try {
            const text = await runReActAgent(env, carInfo, body.contents);
            return json({ text });
          } catch (err) {
            console.error('[AI Chat Route Error]:', err);
            return deny(err.message || 'AI processing error', 500);
          }
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
            const limit = (await getConfig(env, 'limits', {})).aiDaily || parseInt(env.AI_DAILY_LIMIT || '60', 10);
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
            const cfgLim = await getConfig(env, 'limits', {});
            const limit = actor ? (cfgLim.aiDaily || parseInt(env.AI_DAILY_LIMIT || '60', 10)) : (cfgLim.anonDaily || parseInt(env.AI_ANON_DAILY_LIMIT || '15', 10));
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
        // Moderators may READ the roster; changing roles/bans below still needs admin.
        return await guarded('moderator', async () => {
          const q = (url.searchParams.get('q') || '').trim().toLowerCase();
          const w = [];
          // Fall back to the pre-0003 column set if the migration has not been applied.
          const pull = (cols) => async () => {
            const sql = q
              ? `SELECT ${cols} FROM users WHERE lower(name) LIKE ? OR lower(email) LIKE ? ORDER BY last_login DESC LIMIT 200`
              : `SELECT ${cols} FROM users ORDER BY last_login DESC LIMIT 200`;
            const st = q ? env.DB.prepare(sql).bind(`%${q}%`, `%${q}%`) : env.DB.prepare(sql);
            const { results } = await st.all();
            return results || [];
          };
          let results = await safe(env, w, 'users.full',
            pull('uid, name, email, photo, role, banned, last_login, created_at'), null);
          if (results === null) {
            results = await safe(env, w, 'users.basic',
              pull('uid, name, email, photo, role, last_login'), []);
          }
          const own = owners(env);
          return json({
            users: results.map(u => ({
              banned: 0, created_at: null, ...u,
              role: own.includes((u.email || '').toLowerCase()) ? 'owner' : u.role,
            })),
            warnings: w,
          });
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
          const day = new Date().toISOString().slice(0, 10);
          const w = [];
          const one = (label, sql, binds) => safe(env, w, label, async () => {
            const r = await (binds ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql)).first();
            return (r && r.c) || 0;
          }, 0);
          const many = (label, sql) => safe(env, w, label, async () => {
            const { results } = await env.DB.prepare(sql).all();
            return results || [];
          }, []);

          const [totalUsers, activeToday, active7, bannedCount, totalCars, magCount,
                 aiToday, aiTotal, shopCount, auditCount] = await Promise.all([
            one('users', 'SELECT COUNT(*) c FROM users'),
            one('users.active', 'SELECT COUNT(*) c FROM users WHERE last_login > ?', [now - 864e5]),
            one('users.active7', 'SELECT COUNT(*) c FROM users WHERE last_login > ?', [now - 7 * 864e5]),
            one('users.banned', 'SELECT COUNT(*) c FROM users WHERE banned = 1'),
            one('cars', 'SELECT COUNT(*) c FROM cars'),
            one('magazine', 'SELECT COUNT(*) c FROM magazine'),
            one('usage.today', 'SELECT COALESCE(SUM(count),0) c FROM usage WHERE day = ?', [day]),
            one('usage.total', 'SELECT COALESCE(SUM(count),0) c FROM usage'),
            one('shop', 'SELECT COUNT(*) c FROM shop'),
            one('audit', 'SELECT COUNT(*) c FROM audit'),
          ]);

          const aiDaily = await many('usage.daily',
            'SELECT day, SUM(count) c FROM usage GROUP BY day ORDER BY day DESC LIMIT 14');
          const signups = await many('users.signups',
            "SELECT date(created_at/1000,'unixepoch') d, COUNT(*) c FROM users WHERE created_at IS NOT NULL GROUP BY d ORDER BY d DESC LIMIT 14");
          const roles = await many('users.roles',
            'SELECT role, COUNT(*) c FROM users GROUP BY role');
          const topUsers = await many('usage.top',
            `SELECT u.uid, u.name, u.email, u.role, COALESCE(SUM(g.count),0) c
             FROM users u LEFT JOIN usage g ON g.uid = u.uid
             GROUP BY u.uid ORDER BY c DESC LIMIT 10`);
          const topMakes = await many('cars.makes',
            'SELECT make, COUNT(*) c FROM cars GROUP BY make ORDER BY c DESC LIMIT 10');
          const recentUsers = await many('users.recent',
            'SELECT uid, name, email, role, last_login, created_at FROM users ORDER BY last_login DESC LIMIT 8');

          return json({
            totalUsers, activeToday, active7, banned: bannedCount,
            totalCars, magazine: magCount, shop: shopCount, auditCount,
            aiToday, aiTotal,
            aiLimit: parseInt(env.AI_DAILY_LIMIT || '60', 10),
            model: env.GEMINI_MODEL || 'gemini-2.5-flash',
            aiDaily: aiDaily.slice().reverse(),
            signups: signups.slice().reverse(),
            roles, topUsers, topMakes, recentUsers,
            warnings: w,
            serverTime: now,
          });
        })();
      }

      /* ===== ADMIN: SCHEMA HEALTH ===== */
      if (url.pathname === '/api/admin/health' && request.method === 'GET') {
        return await guarded('moderator', async () => {
          const schema = await schemaReport(env);
          return json({
            schema,
            env: {
              aiConfigured: !!env.GEMINI_KEY,
              model: env.GEMINI_MODEL || 'gemini-2.5-flash',
              fallbackModel: env.GEMINI_FALLBACK_MODEL || '',
              liveModel: env.GEMINI_LIVE_MODEL || '',
              aiDailyLimit: parseInt(env.AI_DAILY_LIMIT || '60', 10),
              anonDailyLimit: parseInt(env.AI_ANON_DAILY_LIMIT || '15', 10),
              allowedOrigins: env.ALLOWED_ORIGINS || '*',
              owners: owners(env),
              firebaseProject: env.FIREBASE_PROJECT_ID || '',
            },
            serverTime: Date.now(),
          });
        })();
      }

      /* ===== ADMIN: ALL CARS ===== */
      if (url.pathname === '/api/admin/cars' && request.method === 'GET') {
        return await guarded('moderator', async () => {
          const q = (url.searchParams.get('q') || '').trim().toLowerCase();
          const w = [];
          const rows = await safe(env, w, 'cars.list', async () => {
            const sql = `SELECT c.id, c.uid, c.make, c.model, c.year, c.mileage, c.created_at,
                                u.name AS owner_name, u.email AS owner_email
                         FROM cars c LEFT JOIN users u ON u.uid = c.uid
                         ${q ? 'WHERE lower(c.make) LIKE ?1 OR lower(c.model) LIKE ?1 OR lower(u.email) LIKE ?1' : ''}
                         ORDER BY c.created_at DESC LIMIT 300`;
            const st = q ? env.DB.prepare(sql).bind(`%${q}%`) : env.DB.prepare(sql);
            const { results } = await st.all();
            return results || [];
          }, []);
          return json({ cars: rows, warnings: w });
        })();
      }

      /* ===== ADMIN: ONE USER IN DETAIL ===== */
      const userDetail = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/detail$/);
      if (userDetail && request.method === 'GET') {
        return await guarded('moderator', async () => {
          const uid = decodeURIComponent(userDetail[1]);
          const w = [];
          const user = await safe(env, w, 'user', () =>
            env.DB.prepare('SELECT * FROM users WHERE uid = ?').bind(uid).first(), null);
          if (!user) return deny('User not found', 404);
          const cars = await safe(env, w, 'cars', async () => {
            const { results } = await env.DB.prepare('SELECT * FROM cars WHERE uid = ? ORDER BY created_at DESC').bind(uid).all();
            return results || [];
          }, []);
          const usage = await safe(env, w, 'usage', async () => {
            const { results } = await env.DB.prepare('SELECT day, count FROM usage WHERE uid = ? ORDER BY day DESC LIMIT 30').bind(uid).all();
            return results || [];
          }, []);
          const own = owners(env);
          return json({
            user: { ...user, role: own.includes((user.email || '').toLowerCase()) ? 'owner' : user.role },
            cars, usage, warnings: w,
          });
        })();
      }

      /* ===== ADMIN: EXPORT ===== */
      if (url.pathname === '/api/admin/export' && request.method === 'GET') {
        return await guarded('admin', async (actor) => {
          const w = [];
          const grab = (label, sql) => safe(env, w, label, async () => {
            const { results } = await env.DB.prepare(sql).all(); return results || [];
          }, []);
          const [users, cars, magazine, audit, shop] = await Promise.all([
            grab('users', 'SELECT uid, name, email, role, banned, last_login, created_at FROM users'),
            grab('cars', 'SELECT * FROM cars'),
            grab('magazine', 'SELECT * FROM magazine'),
            grab('audit', 'SELECT * FROM audit ORDER BY id DESC LIMIT 1000'),
            grab('shop', 'SELECT * FROM shop'),
          ]);
          await logAudit(env, actor.email, 'data.export', '', `${users.length} users, ${cars.length} cars`);
          return json({ exportedAt: Date.now(), users, cars, magazine, audit, shop, warnings: w });
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
          if (b.limits) {
            const l = {
              aiDaily: Math.max(0, Math.min(100000, parseInt(b.limits.aiDaily, 10) || 0)),
              anonDaily: Math.max(0, Math.min(100000, parseInt(b.limits.anonDaily, 10) || 0)),
            };
            await setConfig(env, 'limits', l);
            await logAudit(env, actor.email, 'config.limits', '', `ai=${l.aiDaily} anon=${l.anonDaily}`);
          }
          if (b.features) {
            const f = {};
            for (const k of Object.keys(b.features).slice(0, 30)) f[String(k).slice(0, 40)] = !!b.features[k];
            await setConfig(env, 'features', f);
            await logAudit(env, actor.email, 'config.features', '',
              Object.entries(f).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(', ').slice(0, 200));
          }
          return json({ success: true });
        })();
      }

      /* ===== ADMIN: AUDIT LOG ===== */
      if (url.pathname === '/api/admin/audit' && request.method === 'GET') {
        return await guarded('admin', async () => {
          const w = [];
          const rows = await safe(env, w, 'audit', async () => {
            const { results } = await env.DB.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all();
            return results || [];
          }, []);
          return json({ audit: rows, warnings: w });
        })();
      }

      if (url.pathname === '/api/admin/audit' && request.method === 'DELETE') {
        return await guarded('owner', async (actor) => {
          await env.DB.prepare('DELETE FROM audit').run();
          await logAudit(env, actor.email, 'audit.clear', '', 'cleared the audit log');
          return json({ success: true });
        })();
      }

      /* ===== SHOP (public read) ===== */
      if (url.pathname === '/api/shop' && request.method === 'GET') {
        const w = [];
        const rows = await safe(env, w, 'shop', async () => {
          const { results } = await env.DB.prepare('SELECT * FROM shop ORDER BY id DESC LIMIT 120').all();
          return results || [];
        }, []);
        return json(rows);
      }

      /* ===== SHOP MANAGEMENT ===== */
      if (url.pathname === '/api/shop/sync' && request.method === 'POST') {
        return await guarded('moderator', async (actor) => {
          await fetchAndSaveShop(env);
          await logAudit(env, actor.email, 'shop.sync', '', 'AI refresh');
          return json({ success: true });
        })();
      }

      if (url.pathname === '/api/admin/shop' && request.method === 'POST') {
        return await guarded('moderator', async (actor) => {
          const b = await readBody();
          if (!b || !b.title) return deny('Missing title', 400);
          await env.DB.prepare(
            'INSERT INTO shop (title, category, price, url, image, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(String(b.title).slice(0, 200), String(b.category || 'อะไหล่').slice(0, 60),
            String(b.price || '').slice(0, 40), String(b.url || '').slice(0, 500),
            String(b.image || '').slice(0, 500), String(b.note || '').slice(0, 1000), Date.now()).run();
          await logAudit(env, actor.email, 'shop.create', String(b.title).slice(0, 80), '');
          return json({ success: true });
        })();
      }

      const shopIdMatch = url.pathname.match(/^\/api\/admin\/shop\/(\d+)$/);
      if (shopIdMatch && request.method === 'PUT') {
        return await guarded('moderator', async (actor) => {
          const b = await readBody();
          if (!b) return deny('Invalid JSON body', 400);
          const r = await env.DB.prepare(
            'UPDATE shop SET title = ?, category = ?, price = ?, url = ?, image = ?, note = ? WHERE id = ?'
          ).bind(String(b.title || '').slice(0, 200), String(b.category || 'อะไหล่').slice(0, 60),
            String(b.price || '').slice(0, 40), String(b.url || '').slice(0, 500),
            String(b.image || '').slice(0, 500), String(b.note || '').slice(0, 1000), +shopIdMatch[1]).run();
          if (r.meta && r.meta.changes === 0) return deny('Product not found', 404);
          await logAudit(env, actor.email, 'shop.edit', '#' + shopIdMatch[1], String(b.title || '').slice(0, 80));
          return json({ success: true });
        })();
      }
      if (shopIdMatch && request.method === 'DELETE') {
        return await guarded('moderator', async (actor) => {
          const r = await env.DB.prepare('DELETE FROM shop WHERE id = ?').bind(+shopIdMatch[1]).run();
          if (r.meta && r.meta.changes === 0) return deny('Product not found', 404);
          await logAudit(env, actor.email, 'shop.delete', '#' + shopIdMatch[1], '');
          return json({ success: true });
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
