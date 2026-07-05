import { verifyFirebaseToken } from './auth.js';

const ADMINS = ["anapatmaliwong@gmail.com", "carspirethailand@gmail.com"];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * Extracts and verifies the Firebase Bearer token from the request.
 * @param {Request} request - HTTP Request
 * @param {object} env - Cloudflare Worker env
 * @returns {Promise<object>} Parsed JWT payload
 */
async function getAuthenticatedUser(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }
  const token = authHeader.split('Bearer ')[1];
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new Error('FIREBASE_PROJECT_ID environment variable is not configured');
  }
  return await verifyFirebaseToken(token, projectId);
}

/**
 * Calls Gemini with Search tool enabled to fetch and summarize car news.
 * @param {object} env - Cloudflare Worker env
 * @returns {Promise<Array>} Array of news items
 */
async function getGeminiNews(env) {
  const geminiKey = env.GEMINI_KEY;
  console.log("DEBUG: GEMINI_KEY value:", JSON.stringify(geminiKey));
  console.log("DEBUG: GEMINI_KEY length:", geminiKey ? geminiKey.length : 0);
  if (!geminiKey) {
    throw new Error('GEMINI_KEY environment variable is not configured');
  }
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const baseUrl = env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${geminiKey}`;

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

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.4
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const text = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [])
    .map(p => p.text || "")
    .join("")
    .trim();

  let s = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const m = s.match(/[\[{][\s\S]*[\]}]/);
  if (m) s = m[0];
  
  const parsed = JSON.parse(s);
  if (!Array.isArray(parsed)) {
    throw new Error('Gemini response is not a JSON array');
  }
  return parsed;
}

/**
 * Helper to fetch with retry for bypassing temporary Cloudflare Workers egress WAF blocks.
 */
async function fetchWithRetry(url, options, maxRetries = 2) {
  let lastRes;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 403) {
        lastRes = res;
        const text = await res.clone().text();
        if (text.includes("Cloudflare") || text.includes("Attention Required")) {
          console.warn(`Cloudflare WAF block detected on egress. Retry ${i + 1}/${maxRetries}...`);
          await new Promise(r => setTimeout(r, 400 + Math.random() * 300));
          continue;
        }
      }
      return res;
    } catch (err) {
      if (i === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 400 + Math.random() * 300));
    }
  }
  return lastRes;
}

/**
 * Calls the Gemma model to diagnose a car problem from a symptom description.
 * @param {object} env - Cloudflare Worker env
 * @param {object} carInfo - { make, model, year, mileage }
 * @param {string} symptoms - Free-text description of the car's symptoms
 * @returns {Promise<object>} Structured diagnosis object
 */
async function getGroqDiagnosis(env, carInfo, symptoms) {
  const groqKey = env.GROQ_API_KEY;
  if (!groqKey) {
    throw new Error('GROQ_API_KEY environment variable is not configured');
  }
  const model = env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const baseUrl = env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
  const url = `${baseUrl}/chat/completions`;

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

  const body = {
    model,
    messages: [
      { role: "system", content: "You are an expert car mechanic. You must output only a valid JSON object matching the requested schema. Do not write any explanations outside the JSON." },
      { role: "user", content: prompt }
    ],
    temperature: 0.3
  };

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${groqKey}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "application/json",
      "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`Groq API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const text = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();

  let s = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const m = s.match(/[\[{][\s\S]*[\]}]/);
  if (m) s = m[0];

  const parsed = JSON.parse(s);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Groq response is not a JSON object');
  }
  return parsed;
}

/**
 * Executes a ReAct loop on gpt-oss-120b to solve the user's automotive problem.
 * @param {object} env - Cloudflare Worker env
 * @param {object} carInfo - { make, model, year, mileage }
 * @param {Array} messages - Conversation history
 * @returns {Promise<string>} Final answer text
 */
async function runReActAgent(env, carInfo, messages) {
  const groqKey = env.GROQ_API_KEY;
  if (!groqKey) {
    throw new Error('GROQ_API_KEY environment variable is not configured');
  }
  const model = env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const baseUrl = env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
  const url = `${baseUrl}/chat/completions`;

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
    
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqKey}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site"
      },
      body: JSON.stringify({
        model,
        messages: agentLog,
        temperature: 0.3
      })
    });

    if (!res.ok) {
      throw new Error(`Groq ReAct error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const completionText = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();

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

/**
 * Tool helper to describe media attachments using Gemini.
 */
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

/**
 * Tool helper to run Google Search using Gemini.
 */
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

/**
 * Calls Gemini to summarize a conversation log.
 * @param {object} env - Cloudflare Worker env
 * @param {Array} messages - Conversation history
 * @returns {Promise<object>} Structured summary data
 */
async function getGeminiSummary(env, messages) {
  const geminiKey = env.GEMINI_KEY;
  if (!geminiKey) {
    throw new Error('GEMINI_KEY environment variable is not configured');
  }
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const baseUrl = env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${geminiKey}`;

  const convo = messages.slice(-14)
    .map(m => (m.role === "user" ? "USER: " : "AI: ") + (m.text || ""))
    .join("\n");

  const prompt = `จากบทสนทนาวินิจฉัยรถต่อไปนี้ สรุปผลเป็น JSON เท่านั้น ห้ามมีข้อความอื่น:
{
  "symptom": "อาการหลักโดยย่อ",
  "causes": ["สาเหตุที่เป็นไปได้ เรียงจากน่าจะเป็นมากสุด 2-4 ข้อ"],
  "urgency": "low หรือ medium หรือ high",
  "cost": "ช่วงค่าซ่อมโดยประมาณ (ระบุสกุลเงินบาท)",
  "advice": "คำแนะนำขั้นตอนถัดไป 1-2 ประโยค"
}
เขียนค่าทุกฟิลด์เป็นภาษาไทย

บทสนทนา:
${convo}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3 }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`Gemini Summary API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const candidate = (data.candidates && data.candidates[0]) || {};
  const text = ((candidate.content && candidate.content.parts) || [])
    .map(p => p.text || "")
    .join("")
    .trim();

  let s = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const m = s.match(/[\[{][\s\S]*[\]}]/);
  if (m) s = m[0];

  return JSON.parse(s);
}


/**
 * Triggers news fetch from Gemini and batch-saves it to Cloudflare D1.
 * @param {object} env - Cloudflare Worker env
 * @returns {Promise<void>}
 */
async function fetchAndSaveNews(env) {
  if (!env.DB) {
    throw new Error('D1 Database connection is not configured');
  }

  const newsList = await getGeminiNews(env);
  if (Array.isArray(newsList) && newsList.length > 0) {
    await env.DB.prepare("DELETE FROM magazine").run();

    const stmt = env.DB.prepare(`
      INSERT INTO magazine (title, short_description, full_description, type, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    const batch = newsList.map(n => 
      stmt.bind(
        n.title || "",
        n.shortDescription || n.short_description || "",
        n.fullDescription || n.full_description || "",
        n.type || "ข่าวเด่น",
        now
      )
    );

    await env.DB.batch(batch);
  } else {
    throw new Error('Fetched news array is empty or invalid');
  }
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle CORS preflight request
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Helper for JSON response
    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      });
    };

    // Route: POST /api/login
    if (url.pathname === '/api/login' && request.method === 'POST') {
      try {
        let payload;
        try {
          payload = await getAuthenticatedUser(request, env);
        } catch (authErr) {
          return jsonResponse({ error: 'Invalid authentication token: ' + authErr.message }, 401);
        }

        // Get optional body parameters for displayName/photo if token does not contain them
        let bodyData = {};
        try {
          bodyData = await request.json();
        } catch (e) {
          // Ignore if no body
        }

        const uid = payload.sub;
        const email = payload.email;
        const name = bodyData.name || payload.name || email.split('@')[0];
        const photo = bodyData.photo || payload.picture || '';
        const role = ADMINS.includes(email.toLowerCase()) ? 'admin' : 'user';
        const now = Date.now();

        if (!env.DB) {
          return jsonResponse({ error: 'D1 Database connection is not configured' }, 500);
        }

        // Upsert user to D1 database
        await env.DB.prepare(`
          INSERT INTO users (uid, name, email, photo, role, last_login)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(uid) DO UPDATE SET
            name = excluded.name,
            email = excluded.email,
            photo = excluded.photo,
            role = excluded.role,
            last_login = excluded.last_login
        `).bind(uid, name, email, photo, role, now).run();

        return jsonResponse({
          uid,
          name,
          email,
          photo,
          role,
          last_login: now
        });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Route: GET /api/admin/users
    if (url.pathname === '/api/admin/users' && request.method === 'GET') {
      try {
        let payload;
        try {
          payload = await getAuthenticatedUser(request, env);
        } catch (authErr) {
          return jsonResponse({ error: 'Invalid authentication token: ' + authErr.message }, 401);
        }

        const email = payload.email;
        const isAdmin = ADMINS.includes(email.toLowerCase());
        if (!isAdmin) {
          return jsonResponse({ error: 'Forbidden: Admin access required' }, 403);
        }

        if (!env.DB) {
          return jsonResponse({ error: 'D1 Database connection is not configured' }, 500);
        }

        const { results } = await env.DB.prepare(`
          SELECT * FROM users ORDER BY last_login DESC
        `).all();

        return jsonResponse(results);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Route: GET /api/cars
    if (url.pathname === '/api/cars' && request.method === 'GET') {
      try {
        let payload;
        try {
          payload = await getAuthenticatedUser(request, env);
        } catch (authErr) {
          return jsonResponse({ error: 'Invalid authentication token: ' + authErr.message }, 401);
        }

        const uid = payload.sub;
        if (!env.DB) {
          return jsonResponse({ error: 'D1 Database connection is not configured' }, 500);
        }

        const { results } = await env.DB.prepare(`
          SELECT * FROM cars WHERE uid = ? ORDER BY created_at DESC
        `).bind(uid).all();

        return jsonResponse(results);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Route: POST /api/cars
    if (url.pathname === '/api/cars' && request.method === 'POST') {
      try {
        let payload;
        try {
          payload = await getAuthenticatedUser(request, env);
        } catch (authErr) {
          return jsonResponse({ error: 'Invalid authentication token: ' + authErr.message }, 401);
        }

        const uid = payload.sub;
        if (!env.DB) {
          return jsonResponse({ error: 'D1 Database connection is not configured' }, 500);
        }

        let bodyData;
        try {
          bodyData = await request.json();
        } catch (e) {
          return jsonResponse({ error: 'Invalid JSON request body' }, 400);
        }

        const { id, make, model, year, mileage } = bodyData;
        if (!make || !model) {
          return jsonResponse({ error: 'Missing required fields: make, model' }, 400);
        }

        const carId = id || 'c' + Date.now();
        const carYear = year || '';
        const carMileage = mileage || '';
        const now = Date.now();

        // Upsert car in D1, checking that the user owns the car if updating
        await env.DB.prepare(`
          INSERT INTO cars (id, uid, make, model, year, mileage, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            make = excluded.make,
            model = excluded.model,
            year = excluded.year,
            mileage = excluded.mileage
          WHERE cars.uid = excluded.uid
        `).bind(carId, uid, make, model, carYear, carMileage, now).run();

        return jsonResponse({
          id: carId,
          uid,
          make,
          model,
          year: carYear,
          mileage: carMileage,
          created_at: now
        });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Route: DELETE /api/cars/:id
    if (url.pathname.startsWith('/api/cars/') && request.method === 'DELETE') {
      try {
        let payload;
        try {
          payload = await getAuthenticatedUser(request, env);
        } catch (authErr) {
          return jsonResponse({ error: 'Invalid authentication token: ' + authErr.message }, 401);
        }

        const uid = payload.sub;
        if (!env.DB) {
          return jsonResponse({ error: 'D1 Database connection is not configured' }, 500);
        }

        const parts = url.pathname.split('/');
        const carId = parts[parts.length - 1];
        if (!carId) {
          return jsonResponse({ error: 'Missing car ID' }, 400);
        }

        const result = await env.DB.prepare(`
          DELETE FROM cars WHERE id = ? AND uid = ?
        `).bind(carId, uid).run();

        if (result.meta && result.meta.changes === 0) {
          return jsonResponse({ error: 'Car not found or unauthorized' }, 404);
        }

        return jsonResponse({ success: true, message: 'Car removed successfully' });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Route: POST /api/diagnose
    if (url.pathname === '/api/diagnose' && request.method === 'POST') {
      try {
        let uid = null;
        const authHeader = request.headers.get('Authorization');
        if (authHeader && authHeader.startsWith('Bearer ')) {
          try {
            const payload = await getAuthenticatedUser(request, env);
            uid = payload.sub;
          } catch (authErr) {
            console.warn("Optional auth failed:", authErr.message);
          }
        }

        if (!env.DB) {
          return jsonResponse({ error: 'D1 Database connection is not configured' }, 500);
        }

        let bodyData;
        try {
          bodyData = await request.json();
        } catch (e) {
          return jsonResponse({ error: 'Invalid JSON request body' }, 400);
        }

        const { mode, carId, symptoms, messages } = bodyData;
        const currentMode = mode || "diagnose";

        let carInfo = { make: '', model: '', year: '', mileage: '' };
        if (carId && uid) {
          const car = await env.DB.prepare(`
            SELECT make, model, year, mileage FROM cars WHERE id = ? AND uid = ?
          `).bind(carId, uid).first();

          if (car) {
            carInfo = car;
          }
        }

        if (!carInfo.make) {
          carInfo.make = bodyData.make || '';
          carInfo.model = bodyData.model || '';
          carInfo.year = bodyData.year != null ? String(bodyData.year) : '';
          carInfo.mileage = bodyData.mileage != null ? String(bodyData.mileage) : '';
        }

        if (currentMode === "diagnose") {
          const symptomsText = symptoms || (messages && messages.length && messages[messages.length - 1].text) || '';
          if (!symptomsText || !symptomsText.trim()) {
            return jsonResponse({ error: 'Missing required field: symptoms' }, 400);
          }
          const diagnosis = await getGroqDiagnosis(env, carInfo, symptomsText.trim());
          return jsonResponse({
            carInfo,
            diagnosis,
            created_at: Date.now()
          });
        } 
        
        else if (currentMode === "chat") {
          if (!messages || !Array.isArray(messages)) {
            return jsonResponse({ error: 'Missing or invalid messages array' }, 400);
          }
          const text = await getGeminiChatResponse(env, carInfo, messages);
          return jsonResponse({ text });
        } 
        
        else if (currentMode === "summarize") {
          if (!messages || !Array.isArray(messages)) {
            return jsonResponse({ error: 'Missing or invalid messages array' }, 400);
          }
          const summary = await getGeminiSummary(env, messages);
          return jsonResponse({ summary });
        }

        return jsonResponse({ error: 'Unsupported mode: ' + currentMode }, 400);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Route: GET /api/magazine
    if (url.pathname === '/api/magazine' && request.method === 'GET') {
      try {
        if (!env.DB) {
          return jsonResponse({ error: 'D1 Database connection is not configured' }, 500);
        }

        const { results } = await env.DB.prepare(`
          SELECT * FROM magazine ORDER BY id ASC
        `).all();

        return jsonResponse(results);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Route: POST /api/magazine/sync
    if (url.pathname === '/api/magazine/sync' && request.method === 'POST') {
      try {
        let payload;
        try {
          payload = await getAuthenticatedUser(request, env);
        } catch (authErr) {
          return jsonResponse({ error: 'Invalid authentication token: ' + authErr.message }, 401);
        }

        const email = payload.email;
        const isAdmin = ADMINS.includes(email.toLowerCase());
        if (!isAdmin) {
          return jsonResponse({ error: 'Forbidden: Admin access required' }, 403);
        }

        await fetchAndSaveNews(env);

        return jsonResponse({ success: true, message: 'Magazine news synchronized successfully' });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Route: POST /api/ai/chat
    if (url.pathname === '/api/ai/chat' && request.method === 'POST') {
      try {
        let payload;
        try {
          payload = await getAuthenticatedUser(request, env);
        } catch (authErr) {
          return jsonResponse({ error: 'Invalid authentication token: ' + authErr.message }, 401);
        }

        const uid = payload.sub;
        
        let bodyData;
        try {
          bodyData = await request.json();
        } catch (e) {
          return jsonResponse({ error: 'Invalid JSON request body' }, 400);
        }

        const { contents, carId } = bodyData;
        if (!contents || !Array.isArray(contents)) {
          return jsonResponse({ error: 'Missing or invalid contents array' }, 400);
        }

        let carInfo = { make: '', model: '', year: '', mileage: '' };
        if (carId && uid && env.DB) {
          const car = await env.DB.prepare(`
            SELECT make, model, year, mileage FROM cars WHERE id = ? AND uid = ?
          `).bind(carId, uid).first();
          if (car) {
            carInfo = car;
          }
        }

        const text = await runReActAgent(env, carInfo, contents);
        return jsonResponse({ text });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    return jsonResponse({ error: 'Not Found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndSaveNews(env));
  }
};
