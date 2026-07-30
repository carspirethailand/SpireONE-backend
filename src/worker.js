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
    spares_cache: ['k', 'uid', 'payload', 't'],
    push_subs: ['endpoint', 'uid', 'p256dh', 'auth', 'cars', 'lang', 'sent', 't'],
    push_jobs: ['id', 'uid', 'send_at', 'title', 'body', 'url', 'tag', 'done', 't'],
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
async function callGemini(env, { contents, system, search, temp, json: wantJson, maxTokens }) {
  const geminiKey = env.GEMINI_KEY;
  if (!geminiKey) throw new Error('AI is not configured');
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const baseUrl = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${geminiKey}`;

  const gen = { temperature: typeof temp === 'number' ? Math.min(Math.max(temp, 0), 1) : 0.5 };
  if (maxTokens) gen.maxOutputTokens = maxTokens;
  if (wantJson) {
    // Ask for JSON directly and switch thinking off. On 2.5-flash the thinking
    // budget can swallow the whole output allowance and come back with an empty
    // text part, which is what made /api/spares 500 on a valid request.
    gen.responseMimeType = 'application/json';
    // thinkingConfig only exists on the thinking-capable models; sending it to
    // an older one is a 400.
    if (/2\.5|3\./.test(model)) gen.thinkingConfig = { thinkingBudget: 0 };
  }
  const body = { contents, generationConfig: gen };
  if (system) body.systemInstruction = { parts: [{ text: String(system).slice(0, 8000) }] };
  // The search tool and a forced JSON mime type cannot be combined.
  if (search && !wantJson) body.tools = [{ google_search: {} }];

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    /* 429 is the model's own rate/quota limit, not a bug in the request.
       Give it a stable prefix so callers can show a specific message. */
    if (res.status === 429) throw new Error('AI quota exhausted');
    throw new Error(`AI upstream error ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const c = (data.candidates && data.candidates[0]) || {};
  const text = ((c.content && c.content.parts) || []).map(p => p.text || '').join('').trim();
  if (!text) {
    const why = c.finishReason || (data.promptFeedback && data.promptFeedback.blockReason) || 'empty response';
    throw new Error(`AI returned no text (${why})`);
  }
  return text;
}

/* Pulls the first JSON array out of a model reply. Returns null rather than
   throwing so callers can decide whether to retry. */
function parseJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let s = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (e) { return null; }
}

function parseJsonArray(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let s = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const m = s.match(/\[[\s\S]*\]/);
  if (m) s = m[0];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) { return null; }
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
  const parsed = parseJsonArray(text);
  if (!parsed) throw new Error('AI response is not a JSON array');
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
  const parsed = parseJsonArray(text);
  if (!parsed) throw new Error('AI response is not a JSON array');
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

/* ===== SPARES: parts matched to one specific car =====
   No marketplace API keys are involved. The model proposes the parts that
   actually fit the car and a search phrase for each; the browser turns those
   phrases into search links for whichever marketplaces the user picked. So
   the prices below are estimates, never live listings — the UI says so. */
const SPARES_APPS = ['shopee', 'lazada', 'amazon', 'aliexpress', 'jd', 'ebay', 'tiktok', 'local'];

function sparesKey(uid, car, apps) {
  const c = [car.make, car.model, car.year].map(x => String(x || '').toLowerCase().trim()).join('|');
  return `${uid}::${c}::${apps.slice().sort().join(',')}`;
}

async function getSpares(env, { car, apps, needs, lang }) {
  const appNames = {
    shopee: 'Shopee', lazada: 'Lazada', amazon: 'Amazon', aliexpress: 'AliExpress',
    jd: 'JD Central', ebay: 'eBay', tiktok: 'TikTok Shop', local: 'ร้านอะไหล่ในไทย',
  };
  const shops = apps.map(a => appNames[a] || a).join(', ');
  const carLine = [car.year, car.make, car.model].filter(Boolean).join(' ');
  const needLine = (needs && needs.length)
    ? `\nรายการที่รถคันนี้ใกล้ถึงกำหนดหรือเลยกำหนดแล้ว (ให้ความสำคัญก่อน): ${needs.slice(0, 8).join(', ')}`
    : '';

  const prompt = `เลือกอะไหล่และของใช้ที่ "ใส่กับรถคันนี้ได้จริง" และหาซื้อได้บน ${shops}

รถ: ${carLine}${car.mileage ? ` เลขไมล์ประมาณ ${car.mileage} กม.` : ''}${needLine}

ตอบเป็น JSON array เท่านั้น ห้ามมีคำนำ คำอธิบาย หรือ markdown
เลือก 10-14 รายการ เรียงจากที่ควรซื้อก่อนที่สุด แต่ละรายการมีฟิลด์:
1. title: ชื่อสินค้าแบบที่คนไทยใช้ค้นหาจริง เช่น "ผ้าเบรกหน้า Bendix"
2. category: หมวด เลือกจาก: อะไหล่สิ้นเปลือง, ช่วงล่าง, เบรก, เครื่องยนต์, ไฟฟ้า, แอร์, ยางและล้อ, ของตกแต่ง, ดูแลรักษา, อุปกรณ์ความปลอดภัย
3. fit: บอกสั้น ๆ ว่าทำไมตรงรุ่นนี้ เช่น "ตรงรุ่น ${carLine}" หรือเบอร์อะไหล่ถ้ารู้จริง ถ้าไม่แน่ใจให้ว่าง ""
4. why: เหตุผลที่ควรซื้อตอนนี้ 1 ประโยค
5. priceLow, priceHigh: ช่วงราคาในไทยเป็นตัวเลขจำนวนเต็ม (บาท)
6. oem: true ถ้าแนะนำของแท้ศูนย์, false ถ้าของเทียบใช้ได้
7. diy: true ถ้าเจ้าของรถเปลี่ยนเองได้
8. query: คำค้นภาษาไทยที่เอาไปวางในช่องค้นหาของร้านออนไลน์แล้วเจอของจริง ใส่ยี่ห้อและรุ่นรถด้วย
9. queryEn: คำค้นภาษาอังกฤษสำหรับร้านต่างประเทศ

ห้ามแต่งเบอร์อะไหล่หรือลิงก์ขึ้นมาเอง ถ้าไม่รู้ให้เว้นว่าง`;

  const ask = (opts) => callGemini(env, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    temp: 0.3, maxTokens: 4096, ...opts,
  });

  // Grounded search gives better prices, but it also returns prose often enough
  // that the array will not parse. Fall back to a plain JSON-mode call, which is
  // far more reliable, before giving up.
  let parsed = null, firstErr = '';
  try { parsed = parseJsonArray(await ask({ search: true })); }
  catch (e) { firstErr = String(e && e.message || e); }
  if (!parsed) {
    try { parsed = parseJsonArray(await ask({ json: true })); }
    catch (e) {
      throw new Error(`spares_ai: ${String(e && e.message || e)}${firstErr ? ` (first attempt: ${firstErr})` : ''}`);
    }
  }
  if (!parsed || !parsed.length) {
    throw new Error(`spares_ai: model did not return a usable list${firstErr ? ` (${firstErr})` : ''}`);
  }

  return parsed.slice(0, 16).map(x => ({
    title: String(x.title || '').slice(0, 160),
    category: String(x.category || 'อะไหล่สิ้นเปลือง').slice(0, 60),
    fit: String(x.fit || '').slice(0, 120),
    why: String(x.why || '').slice(0, 240),
    priceLow: Math.max(0, parseInt(x.priceLow, 10) || 0),
    priceHigh: Math.max(0, parseInt(x.priceHigh, 10) || 0),
    oem: !!x.oem,
    diy: !!x.diy,
    query: String(x.query || x.title || '').slice(0, 160),
    queryEn: String(x.queryEn || x.query || x.title || '').slice(0, 160),
  })).filter(x => x.title);
}

const LISTEN_TAKES = {
  cold:  'ตอนสตาร์ทเครื่องเย็น',
  idle:  'ตอนเดินเบาอยู่กับที่',
  rev:   'ตอนเร่งเครื่องอยู่กับที่',
  brake: 'ตอนเหยียบเบรก',
  drive: 'ตอนขับอยู่',
};

/* ฟังเสียงเครื่องยนต์ — เจ้าของรถเลียนเสียงให้ช่างฟังไม่เคยเหมือน
   จึงให้อัดเสียงจริงส่งมาแทน แล้วให้โมเดลบอกว่าน่าจะมาจากอะไร */
async function listenEngine(env, { audio, mime, take, car, note, lang }) {
  const carLine = [car.year, car.make, car.model].filter(Boolean).join(' ');
  const when = LISTEN_TAKES[take] || 'ระหว่างใช้งาน';

  const prompt = `ฟังคลิปเสียงรถคันนี้แล้ววิเคราะห์ให้เจ้าของรถเข้าใจ

รถ: ${carLine || 'ไม่ทราบรุ่น'}${car.mileage ? ` เลขไมล์ประมาณ ${car.mileage} กม.` : ''}
คลิปนี้อัด: ${when}${note ? `\nเจ้าของบอกเพิ่มว่า: ${String(note).slice(0, 200)}` : ''}

ตอบเป็น JSON object เท่านั้น ห้ามมีคำนำหรือ markdown
{
 "heard": สิ่งที่ได้ยินจริงในคลิป อธิบายเป็นคำที่คนทั่วไปเข้าใจ 1-2 ประโยค,
 "quality": "clear" ถ้าเสียงชัดพอวิเคราะห์ได้ | "noisy" ถ้าพอได้แต่มีเสียงรบกวนมาก | "unusable" ถ้าฟังไม่ได้เลย,
 "normal": true ถ้าฟังแล้วเป็นเสียงปกติของรถทั่วไป, false ถ้ามีอะไรน่าสงสัย,
 "urgency": "now" ถ้าควรหยุดใช้รถและตรวจทันที | "soon" ถ้าควรตรวจภายในสัปดาห์สองสัปดาห์ | "watch" ถ้าแค่เฝ้าดูอาการ | "fine" ถ้าไม่ต้องทำอะไร,
 "causes": [ { "what": ชิ้นส่วนหรือระบบที่น่าจะเป็นต้นเหตุ,
               "chance": ความน่าจะเป็นเป็นเปอร์เซ็นต์ 0-100 เป็นตัวเลข,
               "why": เหตุผลที่คิดแบบนั้นจากเสียงที่ได้ยิน 1 ประโยค,
               "check": วิธีตรวจยืนยันแบบที่เจ้าของหรือช่างทำได้ 1 ประโยค } ],
 "doNow": [ สิ่งที่ควรทำต่อ 2-4 ข้อ เรียงจากสำคัญที่สุด ],
 "tellShop": ประโยคเดียวที่เอาไปบอกช่างได้ตรง ๆ ว่าให้ตรวจอะไร
}

กติกา
- ถ้าคลิปไม่มีเสียงเครื่องยนต์เลย หรือสั้นเกินจนฟังไม่ออก ให้ตอบ {"error":"unusable"}
- causes ให้ 2-4 ข้อ เรียงจากน่าจะเป็นมากไปน้อย รวมกันไม่ต้องเท่ากับ 100
- ห้ามฟันธงว่าเสียเป็นอะไรแน่นอนจากเสียงอย่างเดียว ให้พูดในเชิงความน่าจะเป็นเสมอ
- ถ้าฟังแล้วปกติดี ให้บอกตรง ๆ ว่าปกติ อย่าหาเรื่องให้ซ่อม`;

  const parts = [
    { inlineData: { mimeType: mime || 'audio/webm', data: audio } },
    { text: prompt },
  ];
  const text = await callGemini(env, {
    contents: [{ role: 'user', parts }],
    temp: 0.25, maxTokens: 3072, json: true,
  });
  const parsed = parseJsonObject(text);
  if (!parsed) throw new Error('listen_ai: model did not return a usable result');
  if (parsed.error === 'unusable' || parsed.quality === 'unusable') throw new Error('listen_unusable');

  const pct = (v) => { const x = Number(v); return Number.isFinite(x) ? Math.min(100, Math.max(0, Math.round(x))) : null; };
  parsed.heard = String(parsed.heard || '').slice(0, 400);
  parsed.quality = ['clear', 'noisy'].includes(parsed.quality) ? parsed.quality : 'noisy';
  parsed.normal = parsed.normal === true;
  parsed.urgency = ['now', 'soon', 'watch', 'fine'].includes(parsed.urgency) ? parsed.urgency : 'watch';
  parsed.causes = Array.isArray(parsed.causes) ? parsed.causes.slice(0, 4).map((x) => ({
    what: String(x.what || '').slice(0, 100),
    chance: pct(x.chance),
    why: String(x.why || '').slice(0, 240),
    check: String(x.check || '').slice(0, 240),
  })).filter((x) => x.what) : [];
  parsed.doNow = Array.isArray(parsed.doNow)
    ? parsed.doNow.slice(0, 4).map((x) => String(x).slice(0, 160)).filter(Boolean) : [];
  parsed.tellShop = String(parsed.tellShop || '').slice(0, 300);
  parsed.take = take || '';
  return parsed;
}

/* ══════════════════════════════════════════════════════════════════
   WEB PUSH — VAPID + aes128gcm (RFC 8291 / RFC 8292)
   เขียนเองด้วย Web Crypto ล้วน เพราะ Worker ลงไลบรารี node ไม่ได้
   ══════════════════════════════════════════════════════════════════ */

const b64urlToBytes = (s) => {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64url = (b) => {
  let s = '';
  const a = new Uint8Array(b);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const concat = (...arrs) => {
  const len = arrs.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const x of arrs) { out.set(x, o); o += x.length; }
  return out;
};
const utf8 = (s) => new TextEncoder().encode(s);

/* HKDF ตาม RFC 5869 — ใช้ทั้งตอนทำ CEK และ nonce */
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

/* คีย์ VAPID เก็บเป็น base64url ของ private scalar (32 ไบต์) กับ public point (65 ไบต์)
   นำเข้าเป็น JWK เพราะ Web Crypto ไม่รับ raw private key ของ EC */
async function importVapidKey(privB64, pubB64) {
  const d = b64urlToBytes(privB64);
  const pub = b64urlToBytes(pubB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be a 65-byte uncompressed point');
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    d: bytesToB64url(d),
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/* JWT แบบ ES256 — ลายเซ็นของ Web Crypto เป็น r||s อยู่แล้ว ตรงกับที่ JWS ต้องการ */
async function vapidJwt(env, audience) {
  const key = await importVapidKey(env.VAPID_PRIVATE, env.VAPID_PUBLIC);
  const header = bytesToB64url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64url(utf8(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:admin@spireone.app',
  })));
  const signingInput = utf8(`${header}.${claims}`);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signingInput);
  return `${header}.${claims}.${bytesToB64url(sig)}`;
}

/* เข้ารหัสเนื้อหาตาม RFC 8291 — ผู้รับถอดได้ด้วยคีย์ที่เบราว์เซอร์สร้างไว้ตอน subscribe */
async function encryptPayload(payload, p256dhB64, authB64) {
  const clientPub = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);
  if (clientPub.length !== 65) throw new Error('bad p256dh');

  const serverKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
  const clientKey = await crypto.subtle.importKey(
    'raw', clientPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientKey }, serverKeys.privateKey, 256));

  // PRK ผูกกับคีย์ทั้งสองฝั่ง ผู้อื่นที่ดักกลางจึงถอดไม่ได้
  const prkInfo = concat(utf8('WebPush: info\0'), clientPub, serverPubRaw);
  const prk = await hkdf(authSecret, shared, prkInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 คือ delimiter ของเรคคอร์ดสุดท้าย ต้องต่อท้ายก่อนเข้ารหัสเสมอ
  const plain = concat(utf8(payload), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plain));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([serverPubRaw.length]), serverPubRaw, ct);
}

/* ส่งหนึ่งข้อความไปหนึ่งเครื่อง — คืนสถานะให้ผู้เรียกตัดสินใจว่าจะลบ subscription ไหม */
async function sendPush(env, sub, payloadObj, ttl = 86400) {
  if (!env.VAPID_PRIVATE || !env.VAPID_PUBLIC) throw new Error('VAPID keys are not configured');
  const url = new URL(sub.endpoint);
  const jwt = await vapidJwt(env, url.origin);
  const body = await encryptPayload(JSON.stringify(payloadObj), sub.p256dh, sub.auth);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': String(ttl),
      'Urgency': 'normal',
    },
    body,
  });
  return { ok: res.ok, status: res.status, text: res.ok ? '' : (await res.text()).slice(0, 200) };
}



const REG_LABEL = {
  tax: ['ต่อภาษีรถ', 'Road tax'],
  act: ['พ.ร.บ.', 'Compulsory insurance'],
  ins: ['ประกันภัย', 'Insurance'],
  chk: ['ตรวจสภาพ ตรอ.', 'Vehicle inspection'],
};
const PUSH_AT = [30, 7, 1, 0];   // เตือนล่วงหน้ากี่วัน และวันครบกำหนดเอง

/* วันครบกำหนดถัดไปจากวันที่ต่อครั้งล่าสุด — ตรรกะเดียวกับฝั่งหน้าเว็บ
   ของที่เลยกำหนดมาไม่เกิน 60 วันยังค้างเป็น "เลยกำหนด" ไม่กระโดดไปปีหน้า */
function nextDueUTC(dateStr) {
  if (!dateStr) return null;
  const base = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(base)) return null;
  const now = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const d = new Date(base);
  let guard = 0;
  while (d < now && guard++ < 40) d.setUTCFullYear(d.getUTCFullYear() + 1);
  const prev = new Date(d); prev.setUTCFullYear(prev.getUTCFullYear() - 1);
  if (prev < now && (now - prev) <= 60 * 86400000) return prev;
  return d;
}

/* เรื่องที่ถึงคิวเตือนของเครื่องหนึ่ง — คืนรายการที่ยังไม่เคยส่งในรอบนั้น */
function dueAlerts(cars, sent) {
  const out = [];
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  (Array.isArray(cars) ? cars : []).slice(0, 6).forEach((car) => {
    Object.keys(REG_LABEL).forEach((k) => {
      const due = nextDueUTC(car[k]);
      if (!due) return;
      const left = Math.round((due - today) / 86400000);
      // เลยกำหนดแล้วเตือนซ้ำได้ทุก 7 วัน ที่เหลือเตือนเฉพาะหมุดที่กำหนดไว้
      const hit = left < 0 ? (Math.abs(left) % 7 === 0) : PUSH_AT.includes(left);
      if (!hit) return;
      const tag = `${car.id || car.name || 'car'}:${k}:${left}`;
      if (sent && sent[tag]) return;
      out.push({ tag, key: k, left, car: car.name || '', due: due.toISOString().slice(0, 10) });
    });
  });
  return out;
}

function alertText(a, lang) {
  const en = lang === 'en';
  const label = REG_LABEL[a.key][en ? 1 : 0];
  const title = a.left < 0
    ? (en ? `${label} is ${Math.abs(a.left)} days overdue` : `${label}เลยกำหนดมาแล้ว ${Math.abs(a.left)} วัน`)
    : a.left === 0
      ? (en ? `${label} is due today` : `${label}ครบกำหนดวันนี้`)
      : (en ? `${label} due in ${a.left} days` : `${label}เหลืออีก ${a.left} วัน`);
  const body = a.car
    ? (en ? `${a.car} — due ${a.due}` : `${a.car} — ครบกำหนด ${a.due}`)
    : (en ? `Due ${a.due}` : `ครบกำหนด ${a.due}`);
  return { title, body };
}

const QUOTE_CATS = ['เบรก','ช่วงล่าง','เครื่องยนต์','ไฟฟ้า','แอร์','ยางและล้อ',
  'ดูแลรักษา','อะไหล่สิ้นเปลือง','ค่าแรง','อื่นๆ'];

/* อ่านใบเสนอราคา/ใบเสร็จจากอู่ แล้วบอกว่าแต่ละรายการควรจ่ายตอนนี้ไหม
   ตัดสินจากระยะรถและประวัติที่ระบบมีอยู่จริง ไม่ใช่เดาลอย ๆ */
async function readQuote(env, { image, mime, car, done, lang }) {
  const carLine = [car.year, car.make, car.model].filter(Boolean).join(' ');
  const doneLine = (done && done.length)
    ? `\nรายการที่เจ้าของเพิ่งทำไปแล้ว (ถ้าใบนี้เสนอซ้ำ ให้ตีเป็น no): ${done.slice(0, 10).join(', ')}`
    : '';

  const prompt = `คุณคือช่างยนต์อาวุโสที่ซื่อสัตย์ กำลังช่วยเจ้าของรถอ่านใบเสนอราคาจากอู่

รถ: ${carLine || 'ไม่ทราบรุ่น'}${car.mileage ? ` เลขไมล์ประมาณ ${car.mileage} กม.` : ''}${doneLine}

อ่านทุกบรรทัดในรูป แล้วตอบเป็น JSON object เท่านั้น ห้ามมีคำนำหรือ markdown
{
 "shop": ชื่ออู่หรือร้านถ้าอ่านได้ ถ้าไม่มีให้ "",
 "docDate": วันที่บนเอกสารรูปแบบ YYYY-MM-DD ถ้าอ่านไม่ได้ให้ "",
 "odometer": เลขไมล์ที่พิมพ์อยู่บนเอกสาร เป็นตัวเลขจำนวนเต็ม ถ้าไม่มีให้ null,
 "currency": "THB",
 "items": [
   {
    "name": ชื่อรายการตามที่เขียนในเอกสาร,
    "category": เลือกจาก ${QUOTE_CATS.join(', ')},
    "qty": จำนวน เป็นตัวเลข ถ้าไม่ระบุให้ 1,
    "price": ราคารวมของบรรทัดนั้นเป็นตัวเลขจำนวนเต็ม,
    "verdict": "yes" ถ้าจำเป็นต้องทำตอนนี้จริง | "later" ถ้าทำได้แต่ยังไม่ด่วน | "no" ถ้ายังไม่ถึงเวลาหรือไม่จำเป็น,
    "reason": เหตุผลสั้น ๆ 1 ประโยค อ้างอิงระยะรถหรือรอบบำรุงรักษาถ้าทำได้,
    "fairLow": ราคาตลาดที่สมเหตุสมผลขั้นต่ำในไทย เป็นตัวเลข ถ้าประเมินไม่ได้ให้ null,
    "fairHigh": ราคาตลาดขั้นสูง เป็นตัวเลข ถ้าประเมินไม่ได้ให้ null
   }
 ],
 "total": ยอดรวมที่อ่านได้จากเอกสาร เป็นตัวเลข ถ้าไม่มีให้ null,
 "summary": สรุป 2-3 ประโยคว่าใบนี้โดยรวมสมเหตุสมผลไหม ควรต่อรองตรงไหน,
 "askShop": อาเรย์ของคำถาม 2-4 ข้อที่เจ้าของควรถามอู่ก่อนตัดสินใจ
}

กติกา
- อ่านเฉพาะสิ่งที่เห็นในรูปจริง ห้ามแต่งรายการที่ไม่มีในเอกสาร
- ถ้ารูปไม่ใช่ใบเสนอราคาหรืออ่านไม่ออก ให้ตอบ {"error":"unreadable"}
- ค่าแรงให้แยกเป็นรายการหมวด "ค่าแรง"
- ตัดสิน verdict จากระยะรถกับรอบบำรุงรักษามาตรฐาน ไม่ใช่จากราคา
- ราคาตลาดให้อิงราคาในประเทศไทย`;

  const parts = [
    { inlineData: { mimeType: mime || 'image/jpeg', data: image } },
    { text: prompt },
  ];
  const text = await callGemini(env, {
    contents: [{ role: 'user', parts }],
    temp: 0.2, maxTokens: 4096, json: true,
  });
  const parsed = parseJsonObject(text);
  if (!parsed) throw new Error('quote_ai: model did not return a usable result');
  if (parsed.error === 'unreadable') throw new Error('quote_unreadable');
  if (!Array.isArray(parsed.items) || !parsed.items.length) throw new Error('quote_unreadable');

  /* ตัวเลขจากโมเดลเชื่อทั้งดุ้นไม่ได้ ต้องกรองให้อยู่ในรูปที่หน้าเว็บใช้ได้เสมอ */
  const n = (v) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? Math.round(x) : null; };
  parsed.items = parsed.items.slice(0, 40).map((it) => ({
    name: String(it.name || '').slice(0, 120),
    category: QUOTE_CATS.includes(it.category) ? it.category : 'อื่นๆ',
    qty: n(it.qty) || 1,
    price: n(it.price),
    verdict: ['yes', 'later', 'no'].includes(it.verdict) ? it.verdict : 'later',
    reason: String(it.reason || '').slice(0, 240),
    fairLow: n(it.fairLow),
    fairHigh: n(it.fairHigh),
  })).filter((it) => it.name);
  if (!parsed.items.length) throw new Error('quote_unreadable');

  parsed.odometer = n(parsed.odometer);
  parsed.total = n(parsed.total);
  if (parsed.total == null) {
    const sum = parsed.items.reduce((a, it) => a + (it.price || 0), 0);
    parsed.total = sum || null;
  }
  parsed.shop = String(parsed.shop || '').slice(0, 80);
  parsed.docDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.docDate || '') ? parsed.docDate : '';
  parsed.summary = String(parsed.summary || '').slice(0, 600);
  parsed.askShop = Array.isArray(parsed.askShop)
    ? parsed.askShop.slice(0, 4).map((q) => String(q).slice(0, 160)).filter(Boolean) : [];
  return parsed;
}


/* ══════════════════════════════════════════════════════════════════
   ODOMETER ENGINE — ประเมินเลขไมล์เองโดยผู้ใช้ไม่ต้องทำอะไร

   ข้อจำกัดที่ยอมรับตรง ๆ: เว็บแอปอ่านเซนเซอร์เบื้องหลังไม่ได้
   (ไม่มี background location / Bluetooth / motion บนเบราว์เซอร์)
   ระบบนี้จึงไม่ "วัด" ระยะทาง แต่ "เรียนรู้อัตราการขับ" ของรถแต่ละคัน
   จากจุดยืนยันจริง แล้วเดินเลขต่อเองที่เซิร์ฟเวอร์ทุกวัน

   จุดยืนยันมาจากสิ่งที่ผู้ใช้ทำอยู่แล้ว ไม่ได้เพิ่มภาระ:
     • เลขไมล์ตอนเพิ่มรถ            → ได้ค่าเฉลี่ยทั้งชีวิตรถทันทีจากปีรถ
     • ใบเสร็จอู่ที่สแกนอยู่แล้ว      → มีเลขไมล์จริงพิมพ์อยู่บนใบ
     • ลิตรที่เติม × อัตราสิ้นเปลือง  → ได้ระยะที่วิ่งไปโดยประมาณ
     • กดยืนยันจากการแจ้งเตือน       → แฝงในเรื่องที่เขาจะได้รับอยู่แล้ว

   หลักสำคัญ: บอกความไม่แน่นอนตรง ๆ (±) ไม่แกล้งแม่น และเมื่อไม่มั่นใจ
   ให้ตกไปใช้เกณฑ์เวลา ซึ่งแม่น 100% เสมอ ไม่ต้องเดาและไม่ต้องถามใคร
   ══════════════════════════════════════════════════════════════════ */

const DAY_MS = 86400000;

/* ขอบเขตความสมเหตุสมผลของอัตราการขับ — กันข้อมูลเพี้ยนทำให้ระบบหลุดโลก
   1 กม./วัน = รถจอดเกือบตลอด · 400 กม./วัน = ขับรับจ้างเต็มเวลา */
const RATE_MIN = 1, RATE_MAX = 400;
/* ยังไม่รู้อะไรเลยเกี่ยวกับรถคันนี้ ใช้ค่ากลางของรถใช้งานทั่วไป
   ~15,000 กม./ปี เป็นตัวเลขที่ใช้กันกว้างขวางเป็นค่าเริ่มต้น */
const RATE_FALLBACK = 41;

const clampRate = (r) => Math.min(RATE_MAX, Math.max(RATE_MIN, r));
const nowMs = () => Date.now();

/* ค่าเฉลี่ยทั้งชีวิตรถ — ใช้ได้ตั้งแต่มีจุดยืนยันจุดเดียว
   ผู้ใช้กรอกปีรถกับเลขไมล์ตอนเพิ่มรถอยู่แล้ว จึงได้อัตราเริ่มต้นฟรี
   โดยไม่ต้องรอสะสมข้อมูลเป็นเดือน */
function lifetimeRate(car, anchorKm, anchorAt) {
  const year = parseInt(car && car.year, 10);
  if (!year || year < 1950 || year > 2100) return null;
  /* ถือว่ารถออกจากโรงงานกลางปีนั้น ค่าเฉลี่ยจึงไม่เพี้ยนมากไม่ว่าซื้อเดือนไหน */
  const born = Date.UTC(year, 5, 30);
  const days = (anchorAt - born) / DAY_MS;
  if (days < 90) return null;                  // รถใหม่มาก ค่าเฉลี่ยยังไม่มีความหมาย
  const r = anchorKm / days;
  if (!isFinite(r) || r <= 0) return null;
  return clampRate(r);
}

/* อัตราที่เรียนรู้จากพฤติกรรมจริงของรถคันนี้
   ใช้จุดยืนยันในช่วง 18 เดือนหลัง เพราะพฤติกรรมการขับเปลี่ยนได้
   ต้องมีช่วงห่างอย่างน้อย 20 วัน ไม่งั้นสัญญาณรบกวนกลบแนวโน้มจริง */
function learnedRate(anchors) {
  if (!anchors || anchors.length < 2) return null;
  const cut = nowMs() - 540 * DAY_MS;
  let recent = anchors.filter((a) => a.observed_at >= cut);
  if (recent.length < 2) recent = anchors.slice(-2);

  const first = recent[0], last = recent[recent.length - 1];
  const days = (last.observed_at - first.observed_at) / DAY_MS;
  const dist = last.km - first.km;
  if (days < 20 || dist < 0) return null;
  /* เลขไมล์ถอยหลังแปลว่าข้อมูลผิด (พิมพ์ผิด/สลับคัน) ไม่ใช่รถวิ่งถอยหลัง */
  const r = dist / days;
  if (!isFinite(r) || r <= 0) return null;
  return clampRate(r);
}

/* ความคลาดเคลื่อนสัมพัทธ์ของอัตรา — ยิ่งมีจุดยืนยันมาก ยิ่งมั่นใจ
   ตัวเลขชุดนี้เป็นค่าตั้งต้นเชิงออกแบบ ไม่ใช่ค่าที่วัดจากผู้ใช้จริง
   ควรปรับหลังเก็บสถิติจากการใช้งานจริงได้แล้ว */
function rateError(basis, nAnchor) {
  if (basis === 'lifetime') return 0.35;       // ค่าเฉลี่ยทั้งชีวิต หยาบที่สุด
  if (nAnchor >= 5) return 0.10;
  if (nAnchor >= 3) return 0.15;
  return 0.22;
}

/* ประมาณเลขไมล์ ณ เวลาหนึ่ง พร้อมความไม่แน่นอน
   sigma โตตามระยะที่เดินมาจากจุดยืนยันล่าสุด ไม่ใช่ตามเวลาเปล่า ๆ
   รถที่จอดทิ้งไว้จึงไม่ถูกลงโทษด้วยความไม่แน่นอนที่บวมขึ้นฟรี ๆ */
function estimateAt(state, at) {
  const base = Number(state.anchor_km);
  const from = Number(state.anchor_at);
  if (!isFinite(base) || !isFinite(from)) {
    return { km: Math.round(Number(state.est_km) || 0), sigma: 0, days: 0 };
  }
  const days = Math.max(0, (at - from) / DAY_MS);
  const run = Number(state.km_per_day) * days;
  const err = rateError(state.rate_basis, Number(state.n_anchor) || 0);
  /* พื้น 40 กม. เพราะแม้แต่เลขที่อ่านจากใบเสร็จก็มีวันคลาดเคลื่อนได้บ้าง */
  const sigma = Math.max(40, run * err);
  return { km: Math.round(base + run), sigma: Math.round(sigma), days: Math.round(days) };
}

/* คำนวณสถานะใหม่ทั้งก้อนจากจุดยืนยันทั้งหมดของรถคันนั้น
   เรียกทุกครั้งที่มีจุดยืนยันเข้ามาใหม่ — ถูกกว่าการพยายามอัปเดตทีละนิด
   และไม่มีทางเพี้ยนสะสมเหมือนการบวกเพิ่มไปเรื่อย ๆ */
async function recomputeOdo(env, uid, carId, car) {
  const rs = await env.DB.prepare(
    'SELECT km, source, observed_at FROM odo_anchor WHERE car_id = ? ORDER BY observed_at ASC'
  ).bind(carId).all();
  const anchors = (rs && rs.results) || [];
  if (!anchors.length) return null;

  const last = anchors[anchors.length - 1];
  let rate = learnedRate(anchors);
  let basis = 'learned';
  if (rate == null) {
    rate = lifetimeRate(car, last.km, last.observed_at);
    basis = 'lifetime';
  }
  if (rate == null) { rate = RATE_FALLBACK; basis = 'lifetime'; }

  const t = nowMs();
  const state = {
    car_id: carId, uid,
    km_per_day: rate, rate_basis: basis,
    anchor_km: last.km, anchor_at: last.observed_at,
    n_anchor: anchors.length,
  };
  const est = estimateAt(state, t);

  await env.DB.prepare(
    `INSERT INTO odo_state
       (car_id, uid, est_km, km_per_day, sigma_km, anchor_km, anchor_at, n_anchor, rate_basis, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(car_id) DO UPDATE SET
       uid = excluded.uid, est_km = excluded.est_km, km_per_day = excluded.km_per_day,
       sigma_km = excluded.sigma_km, anchor_km = excluded.anchor_km,
       anchor_at = excluded.anchor_at, n_anchor = excluded.n_anchor,
       rate_basis = excluded.rate_basis, updated_at = excluded.updated_at`
  ).bind(carId, uid, est.km, rate, est.sigma, last.km, last.observed_at,
    anchors.length, basis, t).run();

  return Object.assign({}, state, { est_km: est.km, sigma_km: est.sigma, updated_at: t });
}

/* บันทึกจุดยืนยันหนึ่งจุด แล้วคำนวณสถานะใหม่
   ปฏิเสธค่าที่เป็นไปไม่ได้ตั้งแต่ต้นทาง ดีกว่าปล่อยให้ไปทำลายอัตราที่เรียนรู้ไว้ */
async function addAnchor(env, uid, carId, km, source, observedAt, note) {
  const v = Math.round(Number(km));
  if (!isFinite(v) || v < 0 || v > 3000000) throw new Error('bad_km');
  const at = Number(observedAt) || nowMs();
  /* จุดยืนยันในอนาคตแปลว่านาฬิกาเครื่องผู้ใช้เพี้ยน ดึงกลับมาเป็นตอนนี้ */
  const when = Math.min(at, nowMs());

  const car = await env.DB.prepare('SELECT * FROM cars WHERE id = ? AND uid = ?')
    .bind(carId, uid).first();
  if (!car) throw new Error('no_car');

  /* ใบเสร็จใบเดิมสแกนซ้ำได้ — ดัชนี unique กันซ้ำไว้แล้ว ชนก็ข้ามไปเงียบ ๆ */
  try {
    await env.DB.prepare(
      `INSERT INTO odo_anchor (id, uid, car_id, km, source, observed_at, note, t)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind('a' + when + Math.random().toString(36).slice(2, 8), uid, carId, v,
      String(source || 'manual').slice(0, 20), when, String(note || '').slice(0, 200), nowMs()).run();
  } catch (e) {
    if (!String(e && e.message || '').includes('UNIQUE')) throw e;
  }

  /* เลขไมล์บนการ์ดรถต้องขยับตามด้วย ไม่งั้นผู้ใช้เห็นเลขเก่าค้างอยู่ */
  const cur = parseInt(String(car.mileage || '').replace(/[^0-9]/g, ''), 10);
  if (!isFinite(cur) || v > cur) {
    await env.DB.prepare('UPDATE cars SET mileage = ? WHERE id = ?').bind(String(v), carId).run();
  }
  return await recomputeOdo(env, uid, carId, car);
}

/* ══════════════ รายการบำรุงรักษา ══════════════ */

/* ชุดเริ่มต้นสำหรับรถที่เพิ่งเพิ่มเข้ามา — ผู้ใช้ไม่ต้องตั้งอะไรเลย
   ระยะเหล่านี้เป็นค่ากลางที่ใช้กันทั่วไป ไม่ใช่คู่มือของรุ่นใดรุ่นหนึ่ง
   ผู้ใช้แก้ได้ภายหลัง และเมื่อสแกนใบเสร็จจริงระบบจะรีเซ็ตรอบให้เอง */
const DEFAULT_MAINT = [
  { part: 'engine_oil',    km: 10000, months: 6 },
  { part: 'oil_filter',    km: 10000, months: 6 },
  { part: 'air_filter',    km: 20000, months: 12 },
  { part: 'cabin_filter',  km: 20000, months: 12 },
  { part: 'brake_pad_f',   km: 40000, months: null },
  { part: 'brake_fluid',   km: 40000, months: 24 },
  { part: 'coolant',       km: 80000, months: 48 },
  { part: 'spark_plug',    km: 60000, months: null },
  { part: 'tyre',          km: 50000, months: 60 },
  { part: 'battery',       km: null,  months: 30 },
];

async function seedMaint(env, uid, carId, baseKm, baseAt) {
  const t = nowMs();
  for (const m of DEFAULT_MAINT) {
    try {
      await env.DB.prepare(
        `INSERT INTO maint_item
           (id, uid, car_id, part, interval_km, interval_months, last_km, last_at, enabled, t)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      ).bind('m' + carId.slice(0, 8) + '_' + m.part, uid, carId, m.part,
        m.km, m.months, baseKm, baseAt, t).run();
    } catch (e) { /* มีอยู่แล้วก็ข้าม */ }
  }
}

/* ประเมินว่ารายการไหนถึงคิวแล้ว
   เกณฑ์ระยะใช้ขอบบนของช่วงความมั่นใจ (est + sigma) ไม่ใช่ค่ากลาง —
   พลาดการเตือนอันตรายกว่าเตือนเช้าไปหน่อย ส่วนเกณฑ์เวลาแม่นเสมอ
   จึงเป็นตัวกันเหนียวช่วงที่ค่าประมาณยังหยาบ โดยไม่ต้องถามผู้ใช้เลย */
function dueItems(items, est, at) {
  const out = [];
  for (const it of items) {
    if (!it.enabled) continue;
    let byKm = null, byTime = null;

    if (it.interval_km && it.last_km != null) {
      const dueKm = it.last_km + it.interval_km;
      const reach = est.km + est.sigma;
      if (reach >= dueKm) {
        /* เตือนซ้ำเรื่องเดิมได้ก็ต่อเมื่อเลยไปอีกครึ่งรอบ ไม่ใช่ทุกวัน */
        const already = it.notified_km != null && (est.km - it.notified_km) < it.interval_km * 0.5;
        if (!already) byKm = { dueKm, over: Math.round(est.km - dueKm) };
      }
    }
    if (it.interval_months && it.last_at != null) {
      const d = new Date(Number(it.last_at));
      d.setMonth(d.getMonth() + it.interval_months);
      const dueAt = d.getTime();
      if (at >= dueAt) {
        const already = it.notified_at != null && (at - it.notified_at) < 45 * DAY_MS;
        if (!already) byTime = { dueAt, overDays: Math.round((at - dueAt) / DAY_MS) };
      }
    }
    if (byKm || byTime) out.push({ item: it, byKm, byTime });
  }
  return out;
}

const PART_TH = {
  engine_oil: 'น้ำมันเครื่อง', oil_filter: 'กรองน้ำมันเครื่อง',
  air_filter: 'กรองอากาศ', cabin_filter: 'กรองแอร์',
  brake_pad_f: 'ผ้าเบรกหน้า', brake_fluid: 'น้ำมันเบรก',
  coolant: 'น้ำยาหม้อน้ำ', spark_plug: 'หัวเทียน',
  tyre: 'ยาง', battery: 'แบตเตอรี่',
};
const PART_EN = {
  engine_oil: 'Engine oil', oil_filter: 'Oil filter',
  air_filter: 'Air filter', cabin_filter: 'Cabin filter',
  brake_pad_f: 'Front brake pads', brake_fluid: 'Brake fluid',
  coolant: 'Coolant', spark_plug: 'Spark plugs',
  tyre: 'Tyres', battery: 'Battery',
};
const partName = (k, lang) => (lang === 'th' ? PART_TH[k] : PART_EN[k]) || k;

/* ข้อความแจ้งเตือน — การขอยืนยันเลขไมล์ถูกแฝงไว้ในเรื่องที่เขาจะได้รับอยู่แล้ว
   ไม่มีการเด้งถามเป็นรอบ ๆ ต่างหาก เพราะนั่นคือการผลักภาระกลับไปหาผู้ใช้ */
function maintText(d, est, lang, carName) {
  const th = lang === 'th';
  const name = partName(d.item.part, lang);
  const approx = d.item.interval_km && est.sigma > 0;
  const kmTxt = est.km.toLocaleString('en-US');

  if (d.byTime && !d.byKm) {
    return {
      title: th ? `ถึงกำหนดเปลี่ยน${name}แล้ว` : `${name} is due`,
      body: th
        ? `${carName} — ครบตามอายุการใช้งานแล้ว ไม่ว่าจะวิ่งมากี่กิโล`
        : `${carName} — due by age, regardless of distance covered`,
    };
  }
  return {
    title: th ? `ใกล้ถึงระยะเปลี่ยน${name}` : `${name} is coming due`,
    body: th
      ? `${carName} — ประเมินว่าตอนนี้ราว ${kmTxt} กม.${approx ? ` (±${est.sigma.toLocaleString('en-US')})` : ''} แตะเพื่อดูและแก้เลขได้ถ้าไม่ตรง`
      : `${carName} — we estimate about ${kmTxt} km${approx ? ` (±${est.sigma.toLocaleString('en-US')})` : ''}. Tap to check or correct it`,
  };
}


/* รอบเดินเลขไมล์ประจำวัน — หัวใจของ "ไมล์ขยับเองจริง"
   ไม่ได้รอให้ผู้ใช้เปิดแอป เซิร์ฟเวอร์เดินเลขให้ทุกวันตามอัตราที่เรียนรู้ไว้
   แล้วเช็คว่ามีอะไรถึงคิวหรือยัง ถ้าถึงก็ยิงแจ้งเตือนออกไปเลย
   นี่คือเหตุผลที่การแจ้งเตือนตรงเวลาจริงโดยที่แอปไม่ต้องเปิดค้างไว้ */
async function runOdoRound(env) {
  const at = Date.now();

  /* 1. เดินเลขทุกคันให้เป็นปัจจุบัน — เขียนลง odo_state เพื่อให้หน้าเว็บ
        อ่านค่าเดียวกับที่ระบบเตือนใช้ ไม่ใช่ต่างคนต่างคำนวณแล้วเลขไม่ตรงกัน */
  let states;
  try { states = await env.DB.prepare('SELECT * FROM odo_state').all(); }
  catch (e) { return; }                       // ยังไม่ได้ migrate ก็ข้ามทั้งรอบ

  for (const st of (states.results || [])) {
    const est = estimateAt(st, at);
    try {
      await env.DB.prepare(
        'UPDATE odo_state SET est_km = ?, sigma_km = ?, updated_at = ? WHERE car_id = ?'
      ).bind(est.km, est.sigma, at, st.car_id).run();
      /* การ์ดรถควรโชว์เลขล่าสุดด้วย แต่ห้ามทับเลขที่ยืนยันแล้วให้ต่ำลง */
      await env.DB.prepare(
        'UPDATE cars SET mileage = ? WHERE id = ? AND CAST(mileage AS INTEGER) < ?'
      ).bind(String(est.km), st.car_id, est.km).run();
    } catch (e) { /* คันเดียวล้มต้องไม่ทำให้ทั้งรอบหยุด */ }
  }

  if (!env.VAPID_PRIVATE || !env.VAPID_PUBLIC) return;   // ยังไม่ตั้งคีย์ก็แค่ไม่ส่ง

  /* 2. หาว่ามีรายการไหนถึงคิว แล้วส่งให้เจ้าของรถ */
  let subs;
  try { subs = await env.DB.prepare('SELECT * FROM push_subs').all(); }
  catch (e) { return; }
  const byUid = new Map();
  for (const s of (subs.results || [])) {
    if (!byUid.has(s.uid)) byUid.set(s.uid, []);
    byUid.get(s.uid).push(s);
  }

  for (const st of (states.results || [])) {
    const devices = byUid.get(st.uid);
    if (!devices || !devices.length) continue;       // ไม่ได้เปิดแจ้งเตือนไว้

    let items;
    try {
      items = await env.DB.prepare(
        'SELECT * FROM maint_item WHERE car_id = ? AND enabled = 1'
      ).bind(st.car_id).all();
    } catch (e) { continue; }

    const est = estimateAt(st, at);
    const due = dueItems(items.results || [], est, at);
    if (!due.length) continue;

    /* เรื่องที่เลยกำหนดมากที่สุดก่อน และส่งรอบละเรื่องเดียวต่อรถหนึ่งคัน
       การยิงรัวคือเหตุผลอันดับหนึ่งที่คนกดปิดแจ้งเตือนแล้วไม่กลับมาเปิดอีก */
    due.sort((a, b) => {
      const ao = (a.byKm ? a.byKm.over : 0) + (a.byTime ? a.byTime.overDays * 40 : 0);
      const bo = (b.byKm ? b.byKm.over : 0) + (b.byTime ? b.byTime.overDays * 40 : 0);
      return bo - ao;
    });
    const d = due[0];

    const car = await env.DB.prepare('SELECT make, model FROM cars WHERE id = ?')
      .bind(st.car_id).first();
    const carName = car ? `${car.make || ''} ${car.model || ''}`.trim() : 'รถของคุณ';

    let anySent = false;
    for (const sub of devices) {
      const lang = sub.lang || 'th';
      const { title, body } = maintText(d, est, lang, carName);
      try {
        const r = await sendPush(env, sub, {
          title, body,
          /* แตะแล้วเปิดการาจพร้อมชี้ไปที่รถคันนั้น หน้าเว็บจะเปิดแผงยืนยันเลขไมล์ให้
             การขอยืนยันจึงแฝงอยู่ในเรื่องที่เขาได้รับอยู่แล้ว ไม่ใช่การเด้งถามต่างหาก */
          url: `/garage.html?car=${encodeURIComponent(st.car_id)}&due=${encodeURIComponent(d.item.part)}`,
          tag: 'maint_' + d.item.part,
        });
        if (r.status === 404 || r.status === 410) {
          await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
          continue;
        }
        if (r.ok) anySent = true;
      } catch (e) { /* เครื่องเดียวล้มต้องไม่ทำให้ทั้งรอบหยุด */ }
    }

    /* จดว่าเตือนไปแล้วก็ต่อเมื่อส่งถึงอย่างน้อยหนึ่งเครื่องจริง
       ไม่งั้นเน็ตสะดุดรอบเดียวแล้วเรื่องนั้นเงียบหายไปเลย */
    if (anySent) {
      try {
        await env.DB.prepare(
          'UPDATE maint_item SET notified_km = ?, notified_at = ? WHERE id = ?'
        ).bind(est.km, at, d.item.id).run();
      } catch (e) {}
    }
  }
}


/* รอบเตือนประจำวัน — ไล่ทุกเครื่องที่สมัครไว้ แล้วส่งเฉพาะเรื่องที่ถึงคิว
   ถ้าคีย์ VAPID ยังไม่ได้ตั้ง ให้เงียบไปเฉย ๆ ไม่ต้องทำให้ cron ทั้งรอบล้ม */
async function runPushRound(env) {
  if (!env.VAPID_PRIVATE || !env.VAPID_PUBLIC) return;
  let rows;
  try { rows = await env.DB.prepare('SELECT * FROM push_subs').all(); }
  catch (e) { return; }                       // ยังไม่ได้ migrate ก็ข้ามไป
  const subs = (rows && rows.results) || [];
  const today = new Date().toISOString().slice(0, 10);

  for (const sub of subs) {
    let cars = [], sent = {};
    try { cars = JSON.parse(sub.cars || '[]'); } catch (e) {}
    try { sent = JSON.parse(sub.sent || '{}'); } catch (e) {}
    // ล้างบันทึกการส่งของวันก่อน ๆ ทิ้ง ไม่ให้โตไม่รู้จบ
    Object.keys(sent).forEach((k) => { if (sent[k] !== today) delete sent[k]; });

    const alerts = dueAlerts(cars, sent);
    if (!alerts.length) continue;

    // ส่งเรื่องที่ด่วนที่สุดเรื่องเดียวต่อรอบ การยิงรัวคือเหตุผลที่คนปิดแจ้งเตือน
    alerts.sort((a, b) => a.left - b.left);
    const a = alerts[0];
    const { title, body } = alertText(a, sub.lang);
    try {
      const r = await sendPush(env, sub, { title, body, url: '/', tag: a.key });
      if (r.status === 404 || r.status === 410) {
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
        continue;
      }
      if (r.ok) {
        sent[a.tag] = today;
        await env.DB.prepare('UPDATE push_subs SET sent = ? WHERE endpoint = ?')
          .bind(JSON.stringify(sent), sub.endpoint).run();
      }
    } catch (e) { /* เครื่องเดียวล้มต้องไม่ทำให้ทั้งรอบหยุด */ }
  }
}


/* ส่งงานที่นัดเวลาไว้และถึงกำหนดแล้ว — รันถี่กว่ารอบเตือนประจำวัน
   เพราะเรื่องอย่างหมดเวลาจอดรถ ช้าไปสิบนาทีก็ไม่มีประโยชน์แล้ว */
async function runDueJobs(env) {
  if (!env.VAPID_PRIVATE || !env.VAPID_PUBLIC) return;
  let rows;
  try {
    rows = await env.DB.prepare(
      'SELECT * FROM push_jobs WHERE done = 0 AND send_at <= ? ORDER BY send_at LIMIT 40'
    ).bind(Date.now()).all();
  } catch (e) { return; }
  const jobs = (rows && rows.results) || [];
  if (!jobs.length) return;

  for (const j of jobs) {
    let subs = [];
    try {
      const r = await env.DB.prepare('SELECT * FROM push_subs WHERE uid = ?').bind(j.uid).all();
      subs = (r && r.results) || [];
    } catch (e) {}
    for (const sub of subs) {
      try {
        const res = await sendPush(env, sub, { title: j.title, body: j.body, url: j.url, tag: j.tag });
        if (res.status === 404 || res.status === 410) {
          await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
        }
      } catch (e) { /* เครื่องเดียวล้มต้องไม่ค้างงานทั้งคิว */ }
    }
    // ปิดงานเสมอแม้ส่งไม่สำเร็จ ไม่งั้นจะวนส่งซ้ำทุกสิบนาทีไม่จบ
    try {
      await env.DB.prepare('UPDATE push_jobs SET done = 1 WHERE id = ?').bind(j.id).run();
    } catch (e) {}
  }
  // เก็บกวาดงานเก่าที่ส่งไปแล้วเกินสามวัน
  try {
    await env.DB.prepare('DELETE FROM push_jobs WHERE done = 1 AND send_at < ?')
      .bind(Date.now() - 3 * 86400000).run();
  } catch (e) {}
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

      /* ═══════════════ SKILLS ═══════════════
         สกิลคือคำสั่งสำเร็จรูปที่ผู้ใช้เขียนเอง แล้วเรียกด้วย /ชื่อ ในห้องแชต
         เก็บส่วนตัวได้ หรือส่งขึ้น Skills Hub ให้คนอื่นใช้ก็ได้
         การเผยแพร่ต้องผ่านมาตรฐานที่ตรวจฝั่งเซิร์ฟเวอร์ แล้วรอผู้ดูแลอนุมัติ
         — ตรวจฝั่งหน้าเว็บอย่างเดียวไม่พอ เพราะยิง API ตรงข้ามได้ */

      // มาตรฐานขั้นต่ำของสกิลที่จะเผยแพร่ คืนรายการปัญหาที่เจอ (ว่าง = ผ่าน)
      const skillIssues = (sk) => {
        const out = [];
        const name = String(sk.name || '').trim();
        const slug = String(sk.slug || '').trim();
        const summary = String(sk.summary || '').trim();
        const body = String(sk.body || '').trim();
        if (name.length < 3 || name.length > 60) out.push('ชื่อสกิลต้องยาว 3–60 ตัวอักษร');
        if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug))
          out.push('คำเรียกต้องเป็น a–z 0–9 หรือ - ยาว 2–31 ตัว และขึ้นต้นด้วยตัวอักษรหรือตัวเลข');
        if (summary.length < 20 || summary.length > 200)
          out.push('คำอธิบายต้องยาว 20–200 ตัวอักษร บอกให้ชัดว่าสกิลนี้ทำอะไร');
        if (body.length < 100) out.push('เนื้อหาคำสั่งสั้นเกินไป ต้องอย่างน้อย 100 ตัวอักษร');
        if (body.length > 20000) out.push('เนื้อหาคำสั่งยาวเกิน 20,000 ตัวอักษร');
        // กันคนเผลอแปะกุญแจของตัวเองขึ้นที่สาธารณะ
        if (/\b(AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,})/.test(body))
          out.push('พบสิ่งที่ดูเหมือนกุญแจ API ในเนื้อหา กรุณาเอาออกก่อนเผยแพร่');
        return out;
      };

      const skillRow = (r, stars) => ({
        id: r.id, name: r.name, slug: r.slug, summary: r.summary, body: r.body,
        status: r.status, reason: r.reason, author: r.author, uid: r.uid,
        installs: r.installs, updatedAt: r.updated_at,
        stars: stars ? { avg: stars.avg, count: stars.count } : undefined,
      });

      // สกิลของฉัน
      /* ══════════════ ODOMETER + MAINTENANCE ══════════════
         ระบบเดินเลขไมล์เองที่เซิร์ฟเวอร์ ดูคำอธิบายที่ odo engine ด้านบน */

      // สถานะไมล์ + รายการที่ถึงคิว ของรถทุกคันของผู้ใช้
      if (url.pathname === '/api/odo/state' && request.method === 'GET') {
        return await guarded('user', async (actor) => {
          const uid = actor.payload.sub;
          const cars = await env.DB.prepare('SELECT * FROM cars WHERE uid = ?').bind(uid).all();
          const at = Date.now();
          const out = [];
          for (const car of (cars.results || [])) {
            let st = await env.DB.prepare('SELECT * FROM odo_state WHERE car_id = ?')
              .bind(car.id).first();
            /* รถที่เพิ่มไว้ก่อนมีระบบนี้ยังไม่มีจุดยืนยัน — สร้างจากเลขที่กรอกไว้
               ให้อัตโนมัติ ผู้ใช้ไม่ต้องกลับมากรอกอะไรใหม่ */
            if (!st) {
              const km = parseInt(String(car.mileage || '').replace(/[^0-9]/g, ''), 10);
              if (isFinite(km) && km > 0) {
                await addAnchor(env, uid, car.id, km, 'signup', car.created_at || at, '');
                await seedMaint(env, uid, car.id, km, car.created_at || at);
                st = await env.DB.prepare('SELECT * FROM odo_state WHERE car_id = ?')
                  .bind(car.id).first();
              }
            }
            if (!st) { out.push({ carId: car.id, known: false }); continue; }

            const est = estimateAt(st, at);
            const items = await env.DB.prepare(
              'SELECT * FROM maint_item WHERE car_id = ? AND enabled = 1'
            ).bind(car.id).all();
            const list = (items.results || []).map((it) => {
              const o = {
                part: it.part, intervalKm: it.interval_km, intervalMonths: it.interval_months,
                lastKm: it.last_km, lastAt: it.last_at,
              };
              if (it.interval_km && it.last_km != null) {
                o.dueKm = it.last_km + it.interval_km;
                o.leftKm = o.dueKm - est.km;
              }
              if (it.interval_months && it.last_at != null) {
                const d = new Date(Number(it.last_at));
                d.setMonth(d.getMonth() + it.interval_months);
                o.dueAt = d.getTime();
                o.leftDays = Math.round((o.dueAt - at) / 86400000);
              }
              return o;
            });
            out.push({
              carId: car.id, known: true,
              km: est.km, sigma: est.sigma, kmPerDay: Math.round(st.km_per_day * 10) / 10,
              basis: st.rate_basis, anchors: st.n_anchor,
              anchorKm: st.anchor_km, anchorAt: st.anchor_at,
              daysSinceAnchor: est.days, items: list,
            });
          }
          return json({ cars: out, at });
        })();
      }

      // บันทึกจุดยืนยันเลขไมล์ — ใช้ร่วมกันทุกแหล่ง (ใบเสร็จ/ยืนยัน/น้ำมัน/OBD)
      if (url.pathname === '/api/odo/anchor' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const b = await readBody();
          if (!b || !b.carId) return deny('carId required', 400);
          const OK = ['receipt', 'confirm', 'fuel', 'obd', 'signup', 'manual'];
          const src = OK.includes(b.source) ? b.source : 'manual';
          let st;
          try {
            st = await addAnchor(env, actor.payload.sub, String(b.carId), b.km, src,
              b.observedAt, b.note);
          } catch (e) {
            const m = e && e.message;
            if (m === 'no_car') return deny('Car not found', 404);
            if (m === 'bad_km') return deny('Mileage out of range', 400);
            throw e;
          }
          /* รถที่ยังไม่มีรายการบำรุงรักษาให้ตั้งชุดเริ่มต้นให้เลย
             ผู้ใช้ไม่ต้องมานั่งกรอกว่ารถต้องเปลี่ยนอะไรบ้าง */
          const has = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM maint_item WHERE car_id = ?'
          ).bind(String(b.carId)).first();
          if (!has || !has.n) {
            await seedMaint(env, actor.payload.sub, String(b.carId), Math.round(b.km),
              Number(b.observedAt) || Date.now());
          }
          const est = estimateAt(st, Date.now());
          return json({ ok: true, km: est.km, sigma: est.sigma, basis: st.rate_basis,
            kmPerDay: Math.round(st.km_per_day * 10) / 10, anchors: st.n_anchor });
        })();
      }

      // บันทึกว่าเพิ่งเปลี่ยนอะไหล่ชิ้นนี้ไป — รีเซ็ตรอบของชิ้นนั้น
      if (url.pathname === '/api/maint/done' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const b = await readBody();
          if (!b || !b.carId || !b.part) return deny('carId and part required', 400);
          const uid = actor.payload.sub;
          const car = await env.DB.prepare('SELECT id FROM cars WHERE id = ? AND uid = ?')
            .bind(String(b.carId), uid).first();
          if (!car) return deny('Car not found', 404);
          const at = Number(b.at) || Date.now();
          let km = Math.round(Number(b.km));
          if (!isFinite(km)) {
            const st = await env.DB.prepare('SELECT * FROM odo_state WHERE car_id = ?')
              .bind(String(b.carId)).first();
            km = st ? estimateAt(st, at).km : 0;
          }
          await env.DB.prepare(
            `UPDATE maint_item SET last_km = ?, last_at = ?, notified_km = NULL, notified_at = NULL
             WHERE car_id = ? AND part = ?`
          ).bind(km, at, String(b.carId), String(b.part)).run();
          return json({ ok: true, km, at });
        })();
      }

      // แก้ระยะ/รอบเวลาของรายการหนึ่ง หรือปิดรายการที่ไม่ต้องการ
      if (url.pathname === '/api/maint/set' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const b = await readBody();
          if (!b || !b.carId || !b.part) return deny('carId and part required', 400);
          const car = await env.DB.prepare('SELECT id FROM cars WHERE id = ? AND uid = ?')
            .bind(String(b.carId), actor.payload.sub).first();
          if (!car) return deny('Car not found', 404);
          const km = b.intervalKm == null ? null : Math.max(0, Math.round(Number(b.intervalKm))) || null;
          const mo = b.intervalMonths == null ? null : Math.max(0, Math.round(Number(b.intervalMonths))) || null;
          await env.DB.prepare(
            `UPDATE maint_item SET interval_km = ?, interval_months = ?, enabled = ?
             WHERE car_id = ? AND part = ?`
          ).bind(km, mo, b.enabled === false ? 0 : 1, String(b.carId), String(b.part)).run();
          return json({ ok: true });
        })();
      }

      if (url.pathname === '/api/skills/mine' && request.method === 'GET') {
        return await guarded('user', async (actor) => {
          const rs = await env.DB.prepare(
            'SELECT * FROM skills WHERE uid = ? ORDER BY updated_at DESC'
          ).bind(actor.payload.sub).all();
          return json({ skills: (rs.results || []).map((r) => skillRow(r)) });
        })();
      }

      // สร้างหรือแก้ไข — ส่ง id มาด้วยคือแก้ไข ไม่ส่งคือสร้างใหม่
      if (url.pathname === '/api/skills' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const uid = actor.payload.sub;
          const b = (await readBody()) || {};
          const name = String(b.name || '').trim().slice(0, 60);
          const slug = String(b.slug || '').trim().toLowerCase().slice(0, 31);
          const summary = String(b.summary || '').trim().slice(0, 200);
          const body = String(b.body || '').slice(0, 20000);
          if (!name || !slug || !body) return deny('name, slug and body are required', 400);
          const now = Date.now();
          if (b.id) {
            const own = await env.DB.prepare('SELECT uid, status FROM skills WHERE id = ?')
              .bind(String(b.id)).first();
            if (!own) return deny('Skill not found', 404);
            if (own.uid !== uid && rank(actor.role) < rank('moderator'))
              return deny('Not your skill', 403);
            // แก้เนื้อหาของสกิลที่เผยแพร่ไปแล้ว ต้องผ่านการอนุมัติใหม่
            const nextStatus = own.status === 'public' ? 'pending' : own.status;
            await env.DB.prepare(
              `UPDATE skills SET name=?, slug=?, summary=?, body=?, status=?, updated_at=? WHERE id=?`
            ).bind(name, slug, summary, body, nextStatus, now, String(b.id)).run();
            return json({ ok: true, id: String(b.id), status: nextStatus });
          }
          const id = 'sk_' + now.toString(36) + Math.random().toString(36).slice(2, 8);
          await env.DB.prepare(
            `INSERT INTO skills (id, uid, author, name, slug, summary, body, status, reason,
             installs, created_at, updated_at) VALUES (?,?,?,?,?,?,?, 'private', '', 0, ?, ?)`
          ).bind(id, uid, String(actor.email || '').split('@')[0], name, slug, summary, body, now, now).run();
          return json({ ok: true, id, status: 'private' });
        })();
      }

      const skillIdMatch = url.pathname.match(/^\/api\/skills\/([A-Za-z0-9_]+)(\/[a-z]+)?$/);

      if (skillIdMatch && skillIdMatch[2] === undefined && request.method === 'DELETE') {
        return await guarded('user', async (actor) => {
          const row = await env.DB.prepare('SELECT uid FROM skills WHERE id = ?')
            .bind(skillIdMatch[1]).first();
          if (!row) return deny('Skill not found', 404);
          if (row.uid !== actor.payload.sub && rank(actor.role) < rank('moderator'))
            return deny('Not your skill', 403);
          await env.DB.prepare('DELETE FROM skills WHERE id = ?').bind(skillIdMatch[1]).run();
          await env.DB.prepare('DELETE FROM skill_stars WHERE skill_id = ?').bind(skillIdMatch[1]).run();
          return json({ ok: true });
        })();
      }

      // ขอเผยแพร่ — ตรวจมาตรฐานก่อน แล้วเข้าคิวรออนุมัติ
      if (skillIdMatch && skillIdMatch[2] === '/publish' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const row = await env.DB.prepare('SELECT * FROM skills WHERE id = ?')
            .bind(skillIdMatch[1]).first();
          if (!row) return deny('Skill not found', 404);
          if (row.uid !== actor.payload.sub) return deny('Not your skill', 403);
          const issues = skillIssues(row);
          if (issues.length) return json({ ok: false, issues }, 422);
          const clash = await env.DB.prepare(
            "SELECT id FROM skills WHERE slug = ? AND status = 'public' AND id <> ?"
          ).bind(row.slug, row.id).first();
          if (clash) return json({ ok: false, issues: ['คำเรียก /' + row.slug + ' ถูกใช้ไปแล้ว เลือกคำอื่น'] }, 422);
          await env.DB.prepare(
            "UPDATE skills SET status = 'pending', reason = '', updated_at = ? WHERE id = ?"
          ).bind(Date.now(), row.id).run();
          return json({ ok: true, status: 'pending' });
        })();
      }

      // ให้ดาว 1–5 คนละหนึ่งครั้งต่อสกิล แก้คะแนนเดิมได้
      if (skillIdMatch && skillIdMatch[2] === '/star' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const b = (await readBody()) || {};
          const stars = Math.max(1, Math.min(5, parseInt(b.stars, 10) || 0));
          if (!stars) return deny('stars must be 1-5', 400);
          const row = await env.DB.prepare("SELECT uid, status FROM skills WHERE id = ?")
            .bind(skillIdMatch[1]).first();
          if (!row || row.status !== 'public') return deny('Skill not found', 404);
          // ให้ดาวสกิลตัวเองไม่ได้ ไม่งั้นคะแนนใน Hub เชื่อไม่ได้เลย
          if (row.uid === actor.payload.sub) return deny('You cannot rate your own skill', 400);
          await env.DB.prepare(
            `INSERT INTO skill_stars (skill_id, uid, stars, t) VALUES (?,?,?,?)
             ON CONFLICT(skill_id, uid) DO UPDATE SET stars = excluded.stars, t = excluded.t`
          ).bind(skillIdMatch[1], actor.payload.sub, stars, Date.now()).run();
          const agg = await env.DB.prepare(
            'SELECT AVG(stars) a, COUNT(*) c FROM skill_stars WHERE skill_id = ?'
          ).bind(skillIdMatch[1]).first();
          return json({ ok: true, avg: agg ? Number(agg.a) : stars, count: agg ? agg.c : 1 });
        })();
      }

      if (skillIdMatch && skillIdMatch[2] === '/install' && request.method === 'POST') {
        return await guarded('user', async () => {
          await env.DB.prepare(
            "UPDATE skills SET installs = installs + 1 WHERE id = ? AND status = 'public'"
          ).bind(skillIdMatch[1]).run();
          return json({ ok: true });
        })();
      }

      /* Skills Hub — เฉพาะที่อนุมัติแล้ว
         เรียงตามคะแนนแบบถ่วงน้ำหนัก ไม่ใช่ค่าเฉลี่ยดิบ ไม่งั้นสกิลที่มีคนให้
         5 ดาวคนเดียวจะขึ้นเหนือสกิลที่มี 200 คนให้ 4.6 ซึ่งไม่สมเหตุสมผล */
      if (url.pathname === '/api/skills/hub' && request.method === 'GET') {
        return await guarded('user', async (actor) => {
          const sort = url.searchParams.get('sort') === 'new' ? 'new' : 'top';
          const q = (url.searchParams.get('q') || '').trim().toLowerCase();
          const rs = await env.DB.prepare(`
            SELECT s.*, COALESCE(AVG(v.stars), 0) avg_stars, COUNT(v.uid) star_count,
                   MAX(CASE WHEN v.uid = ? THEN v.stars END) my_stars
            FROM skills s LEFT JOIN skill_stars v ON v.skill_id = s.id
            WHERE s.status = 'public'
            GROUP BY s.id
          `).bind(actor.payload.sub).all();
          let list = (rs.results || []).map((r) => {
            const c = Number(r.star_count) || 0;
            const a = Number(r.avg_stars) || 0;
            // ค่าเฉลี่ยแบบเบย์: ถ่วงเข้าหา 3.5 ดาวจนกว่าจะมีคนโหวตมากพอ
            const PRIOR = 5, MEAN = 3.5;
            return {
              id: r.id, name: r.name, slug: r.slug, summary: r.summary, body: r.body,
              author: r.author, installs: r.installs, updatedAt: r.updated_at,
              mine: r.uid === actor.payload.sub,
              stars: { avg: c ? a : 0, count: c, mine: r.my_stars || 0 },
              score: (a * c + MEAN * PRIOR) / (c + PRIOR),
            };
          });
          if (q) list = list.filter((x) =>
            (x.name + ' ' + x.slug + ' ' + x.summary).toLowerCase().includes(q));
          list.sort((x, y) => sort === 'new' ? y.updatedAt - x.updatedAt : y.score - x.score);
          return json({ skills: list.slice(0, 100) });
        })();
      }

      /* คิวรออนุมัติ + ตัดสิน — ผู้ควบคุมขึ้นไป */
      if (url.pathname === '/api/skills/pending' && request.method === 'GET') {
        return await guarded('moderator', async () => {
          const rs = await env.DB.prepare(
            "SELECT * FROM skills WHERE status = 'pending' ORDER BY updated_at ASC"
          ).all();
          return json({ skills: (rs.results || []).map((r) => skillRow(r)) });
        })();
      }

      if (skillIdMatch && skillIdMatch[2] === '/review' && request.method === 'POST') {
        return await guarded('moderator', async (actor) => {
          const b = (await readBody()) || {};
          const ok = b.action === 'approve';
          const reason = String(b.reason || '').slice(0, 300);
          if (!ok && !reason) return deny('A reason is required when rejecting', 400);
          const row = await env.DB.prepare('SELECT * FROM skills WHERE id = ?')
            .bind(skillIdMatch[1]).first();
          if (!row) return deny('Skill not found', 404);
          if (ok) {
            const issues = skillIssues(row);
            if (issues.length) return json({ ok: false, issues }, 422);
          }
          await env.DB.prepare('UPDATE skills SET status = ?, reason = ?, updated_at = ? WHERE id = ?')
            .bind(ok ? 'public' : 'rejected', ok ? '' : reason, Date.now(), row.id).run();
          await logAudit(env, actor.email, ok ? 'skill.approve' : 'skill.reject', row.slug, reason);
          return json({ ok: true, status: ok ? 'public' : 'rejected' });
        })();
      }

      /* ===== ACCOUNT: RESET / DEACTIVATE =====
         รีเซ็ต = ลบข้อมูลของผู้ใช้คนนี้ทุกตารางที่ผูกกับ uid แต่เก็บแถวใน users ไว้
         เขาจึงยังล็อกอินเข้ามาตั้งค่าใหม่ได้ทันทีโดยไม่ต้องสมัครใหม่
         ปิดใช้งาน = ตั้งธง banned ทำให้ guarded() ปฏิเสธทุกเส้นทางหลังจากนี้ */
      if (url.pathname === '/api/account/reset' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const uid = actor.payload.sub;
          // ลบทีละตาราง ไม่ใช้ transaction เพราะ D1 ยังไม่รองรับข้าม statement
          // ถ้าตารางไหนพลาด ตัวที่ลบไปแล้วยังถือว่าลบจริง จึงรายงานเป็นรายตาราง
          const tables = ['cars', 'usage', 'push_subs', 'push_jobs'];
          const removed = {};
          for (const t of tables) {
            try {
              const r = await env.DB.prepare(`DELETE FROM ${t} WHERE uid = ?`).bind(uid).run();
              removed[t] = (r.meta && r.meta.changes) || 0;
            } catch (e) {
              removed[t] = 'error: ' + String(e.message || e).slice(0, 80);
            }
          }
          await logAudit(env, actor.email, 'account.reset', uid, JSON.stringify(removed));
          return json({ ok: true, uid, removed });
        })();
      }

      if (url.pathname === '/api/account/deactivate' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const uid = actor.payload.sub;
          // เจ้าของระบบปิดบัญชีตัวเองไม่ได้ ไม่งั้นจะไม่เหลือใครกู้ระบบคืน
          if (actor.role === 'owner') return deny('Owners cannot deactivate their own account', 400);
          await env.DB.prepare('UPDATE users SET banned = 1 WHERE uid = ?').bind(uid).run();
          await logAudit(env, actor.email, 'account.deactivate', uid, 'self-service');
          return json({ ok: true, uid });
        })();
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

      /* ===== SPARES: AI-matched parts for the caller's own car ===== */
      /* ===== PUSH — แจ้งเตือนบนเครื่องผู้ใช้ ===== */
      if (url.pathname === '/api/push/key' && request.method === 'GET') {
        return json({ key: env.VAPID_PUBLIC || '', enabled: !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE) });
      }
      if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const b = (await readBody()) || {};
          const sub = b.sub || {};
          const keys = sub.keys || {};
          if (!sub.endpoint || !keys.p256dh || !keys.auth) return deny('Invalid subscription', 400);
          if (String(sub.endpoint).length > 800) return deny('Endpoint too long', 400);
          // วันครบกำหนดอยู่ในเครื่องผู้ใช้ ต้องซิงก์ขึ้นมาด้วย ไม่งั้นเซิร์ฟเวอร์เตือนอะไรไม่ได้
          const cars = (Array.isArray(b.cars) ? b.cars : []).slice(0, 6).map((c) => ({
            id: String(c.id || '').slice(0, 40),
            name: String(c.name || '').slice(0, 60),
            tax: String(c.tax || '').slice(0, 10),
            act: String(c.act || '').slice(0, 10),
            ins: String(c.ins || '').slice(0, 10),
            chk: String(c.chk || '').slice(0, 10),
          }));
          const w = [];
          await safe(env, w, 'push.save', () => env.DB.prepare(`
            INSERT INTO push_subs (endpoint, uid, p256dh, auth, cars, lang, sent, t)
            VALUES (?, ?, ?, ?, ?, ?, '{}', ?)
            ON CONFLICT(endpoint) DO UPDATE SET
              uid = excluded.uid, p256dh = excluded.p256dh, auth = excluded.auth,
              cars = excluded.cars, lang = excluded.lang, t = excluded.t
          `).bind(String(sub.endpoint), actor.payload.sub, String(keys.p256dh), String(keys.auth),
            JSON.stringify(cars), b.lang === 'en' ? 'en' : 'th', Date.now()).run(), null);
          return json({ ok: true, warnings: w });
        })();
      }
      if (url.pathname === '/api/push/unsubscribe' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const b = (await readBody()) || {};
          if (!b.endpoint) return deny('Missing endpoint', 400);
          await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND uid = ?')
            .bind(String(b.endpoint), actor.payload.sub).run();
          return json({ ok: true });
        })();
      }
      if (url.pathname === '/api/push/test' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const rows = await env.DB.prepare('SELECT * FROM push_subs WHERE uid = ?')
            .bind(actor.payload.sub).all();
          const subs = (rows && rows.results) || [];
          if (!subs.length) return deny('No subscription on file', 404);
          const out = [];
          for (const sub of subs) {
            try {
              const r = await sendPush(env, sub, {
                title: sub.lang === 'en' ? 'SpireONE notifications are on'
                                         : 'เปิดการแจ้งเตือนเรียบร้อย',
                body: sub.lang === 'en' ? "We'll tell you before tax and insurance run out."
                                        : 'ใกล้ครบกำหนดต่อภาษีหรือประกัน เราจะเตือนให้ก่อน',
                url: '/',
              });
              out.push(r.status);
              // 404/410 คือ subscription ตายแล้ว ลบทิ้งเลยไม่ต้องรอ
              if (r.status === 404 || r.status === 410) {
                await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
              }
            } catch (e) { out.push(String(e.message || e).slice(0, 80)); }
          }
          return json({ ok: true, sent: out });
        })();
      }

      /* ===== แจ้งเตือนตามเวลาที่นัดไว้ (เช่น หมดเวลาจอด) ===== */
      if (url.pathname === '/api/push/schedule' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const b = (await readBody()) || {};
          const at = Number(b.sendAt);
          if (!Number.isFinite(at)) return deny('Bad sendAt', 400);
          // กันตั้งเวลาย้อนหลังหรือไกลเกินสองวัน ซึ่งไม่ใช่การใช้งานที่ตั้งใจ
          if (at < Date.now() - 60000 || at > Date.now() + 2 * 86400000) {
            return deny('sendAt out of range', 400);
          }
          const id = String(b.id || crypto.randomUUID()).slice(0, 60);
          const w = [];
          await safe(env, w, 'jobs.save', () => env.DB.prepare(`
            INSERT INTO push_jobs (id, uid, send_at, title, body, url, tag, done, t)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
            ON CONFLICT(id) DO UPDATE SET
              send_at = excluded.send_at, title = excluded.title, body = excluded.body,
              url = excluded.url, tag = excluded.tag, done = 0
          `).bind(id, actor.payload.sub, Math.round(at),
            String(b.title || 'SpireONE').slice(0, 120),
            String(b.body || '').slice(0, 200),
            String(b.url || '/').slice(0, 200),
            String(b.tag || 'spireone').slice(0, 40), Date.now()).run(), null);
          return json({ ok: true, id, warnings: w });
        })();
      }
      if (url.pathname === '/api/push/cancel' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const b = (await readBody()) || {};
          if (!b.id) return deny('Missing id', 400);
          await env.DB.prepare('DELETE FROM push_jobs WHERE id = ? AND uid = ?')
            .bind(String(b.id), actor.payload.sub).run();
          return json({ ok: true });
        })();
      }

      /* ===== LISTEN — วิเคราะห์เสียงเครื่องยนต์ ===== */
      if (url.pathname === '/api/listen' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const b = (await readBody()) || {};
          let audio = String(b.audio || '');
          const m = audio.match(/^data:([^;,]+);base64,(.*)$/);
          let mime = String(b.mime || '');
          if (m) { mime = mime || m[1]; audio = m[2]; }
          if (!audio) return deny('Missing audio', 400);
          if (audio.length > 8_000_000) return deny('Audio too large', 413);
          if (!/^audio\//i.test(mime || 'audio/webm')) return deny('Unsupported audio type', 415);

          const uid = actor.payload.sub;
          const w = [];
          const day = new Date().toISOString().slice(0, 10);
          const cfgLim = await getConfig(env, 'limits', {});
          const limit = cfgLim.aiDaily || parseInt(env.AI_DAILY_LIMIT || '60', 10);
          if (rank(actor.role) < rank('admin')) {
            const used = await safe(env, w, 'usage.read', () =>
              env.DB.prepare('SELECT count FROM usage WHERE uid = ? AND day = ?')
                .bind(uid, day).first(), null);
            if (used && used.count >= limit) return deny('quota', 429);
          }

          const result = await listenEngine(env, {
            audio, mime: mime || 'audio/webm', take: String(b.take || '').slice(0, 20),
            car: b.car || {}, note: b.note || '', lang: b.lang || 'th',
          });
          await safe(env, w, 'usage.write', () => env.DB.prepare(`
            INSERT INTO usage (uid, day, count) VALUES (?, ?, 3)
            ON CONFLICT(uid, day) DO UPDATE SET count = count + 3
          `).bind(uid, day).run(), null);

          return json({ ...result, warnings: w });
        })();
      }

      /* ===== QUOTE READER — อ่านใบเสนอราคาจากอู่ ===== */
      if (url.pathname === '/api/quote' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const b = (await readBody()) || {};
          let image = String(b.image || '');
          // หน้าเว็บอาจส่งมาเป็น data URL เต็ม ๆ — ตัดหัวออกให้เหลือ base64 ล้วน
          const m = image.match(/^data:([^;,]+);base64,(.*)$/);
          let mime = String(b.mime || '');
          if (m) { mime = mime || m[1]; image = m[2]; }
          if (!image) return deny('Missing image', 400);
          // ~6MB base64 ≈ 4.5MB ของจริง เกินนี้คำขอจะหนักเกินไปสำหรับ Worker
          if (image.length > 6_000_000) return deny('Image too large', 413);
          if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(mime || 'image/jpeg')) {
            return deny('Unsupported image type', 415);
          }

          const uid = actor.payload.sub;
          const w = [];
          const day = new Date().toISOString().slice(0, 10);
          const cfgLim = await getConfig(env, 'limits', {});
          const limit = cfgLim.aiDaily || parseInt(env.AI_DAILY_LIMIT || '60', 10);
          if (rank(actor.role) < rank('admin')) {
            const used = await safe(env, w, 'usage.read', () =>
              env.DB.prepare('SELECT count FROM usage WHERE uid = ? AND day = ?')
                .bind(uid, day).first(), null);
            if (used && used.count >= limit) return deny('quota', 429);
          }

          const done = Array.isArray(b.done)
            ? b.done.map(x => String(x).slice(0, 60)).slice(0, 10) : [];
          const result = await readQuote(env, {
            image, mime: mime || 'image/jpeg', car: b.car || {}, done, lang: b.lang || 'th',
          });

          // อ่านรูปหนึ่งใบกินแรงกว่าข้อความ จึงคิดโควตาหนักกว่าปกติ
          await safe(env, w, 'usage.write', () => env.DB.prepare(`
            INSERT INTO usage (uid, day, count) VALUES (?, ?, 3)
            ON CONFLICT(uid, day) DO UPDATE SET count = count + 3
          `).bind(uid, day).run(), null);

          return json({ ...result, warnings: w });
        })();
      }

      if (url.pathname === '/api/spares' && request.method === 'POST') {
        return await guarded('user', async (actor) => {
          const b = (await readBody()) || {};
          const car = b.car || {};
          if (!car.make && !car.model) return deny('Missing car', 400);
          const apps = Array.isArray(b.apps)
            ? b.apps.filter(a => SPARES_APPS.includes(a)).slice(0, 8) : [];
          if (!apps.length) return deny('Pick at least one marketplace', 400);
          const needs = Array.isArray(b.needs) ? b.needs.map(x => String(x).slice(0, 60)).slice(0, 8) : [];

          const uid = actor.payload.sub;
          const key = sparesKey(uid, car, apps);
          const w = [];
          const TTL = 12 * 3600e3;

          /* Always read the cache row, even on a refresh: if the model is out of
             quota we would rather hand back yesterday's list than an error page. */
          const hit = await safe(env, w, 'spares.cache', () =>
            env.DB.prepare('SELECT payload, t FROM spares_cache WHERE k = ?').bind(key).first(), null);
          const cachedItems = (() => {
            if (!hit) return null;
            try { const p = JSON.parse(hit.payload); return Array.isArray(p) && p.length ? p : null; }
            catch (e) { return null; }
          })();

          if (!b.refresh && cachedItems && Date.now() - hit.t < TTL) {
            return json({ items: cachedItems, cachedAt: hit.t, cached: true, apps });
          }

          /* A refresh costs AI quota like any other generation. */
          const day = new Date().toISOString().slice(0, 10);
          const cfgLim = await getConfig(env, 'limits', {});
          const limit = cfgLim.aiDaily || parseInt(env.AI_DAILY_LIMIT || '60', 10);
          if (rank(actor.role) < rank('admin')) {
            const used = await safe(env, w, 'usage.read', () =>
              env.DB.prepare('SELECT count FROM usage WHERE uid = ? AND day = ?').bind(uid, day).first(), null);
            if (used && used.count >= limit) return deny('quota', 429);
          }

          let items;
          try {
            items = await getSpares(env, { car, apps, needs, lang: b.lang || 'th' });
          } catch (e) {
            const msg = String((e && e.message) || e);
            /* Upstream is rate limited or out of credit. A stale list still shows
               the right parts for this car, so serve it rather than nothing. */
            if (cachedItems) {
              return json({
                items: cachedItems, cachedAt: hit.t, cached: true, stale: true,
                apps, warnings: w.concat([`spares.live: ${msg.slice(0, 200)}`]),
              });
            }
            throw e;
          }
          await safe(env, w, 'usage.write', () => env.DB.prepare(`
            INSERT INTO usage (uid, day, count) VALUES (?, ?, 2)
            ON CONFLICT(uid, day) DO UPDATE SET count = count + 2
          `).bind(uid, day).run(), null);
          await safe(env, w, 'spares.save', () => env.DB.prepare(
            'INSERT INTO spares_cache (k, uid, payload, t) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(k) DO UPDATE SET payload = excluded.payload, t = excluded.t'
          ).bind(key, uid, JSON.stringify(items), Date.now()).run(), null);

          return json({ items, cachedAt: Date.now(), cached: false, apps, warnings: w });
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
    // รอบถี่ทำเฉพาะงานที่นัดเวลาไว้ ส่วนงานหนักปล่อยให้รอบวันละครั้งทำ
    ctx.waitUntil(runDueJobs(env));
    if (event.cron !== '*/10 * * * *') {
      ctx.waitUntil(fetchAndSaveNews(env));
      ctx.waitUntil(runPushRound(env));
      ctx.waitUntil(runOdoRound(env));
    }
  }
};
