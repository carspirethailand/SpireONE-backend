/* ตั้งค่าการโทรคุยกับ Cendon (Gemini Live) ที่ล็อกไว้ในกุญแจใช้ครั้งเดียว — แยกออกมาให้เทสต์ได้โดยไม่ต้องเรียก Google */
import { LIVE_CALL_TOOLS, LIVE_CALL_AGENT_RULES } from './live-call-tools.mjs';

/* เครื่องมือที่ผู้ช่วยเสียงเรียกเองได้ระหว่างโทร: ผู้ใช้พูดว่า "ฟังเสียงเครื่องหน่อย" / "ดูห้องเครื่องให้หน่อย"
   หน้าเว็บเปิดโหมดฟังเสียงดิบ (ไม่กรองเสียงรบกวน) หรือสแกนกล้องแบบสด แล้วส่งผลกลับให้ AI พูดต่อ */
export const LIVE_TOOLS = [{ functionDeclarations: [
  { name: 'listen_engine', description: 'Record about 10 seconds of raw engine or car sound from the phone microphone (no noise filtering) and analyse it. Call this whenever the user asks you to listen to the engine, a noise, a knock, a squeal or any car sound, or says they will hold the phone near the car.',
    parameters: { type: 'OBJECT', properties: { area: { type: 'STRING', description: 'Where the phone is held, e.g. engine bay, wheel, exhaust, cabin' }, when: { type: 'STRING', description: 'When the sound happens, e.g. idle, revving, braking, turning' } } } },
  { name: 'scan_engine_bay', description: 'Start a live scan on the rear camera: labelled boxes appear over each visible engine-bay part (battery, air intake pipe, coolant, brake fluid, dipstick and so on) and follow the camera. Returns the list of parts and where they are on screen. Call this when the user asks you to look at, scan, highlight or explain the engine bay or under the bonnet.',
    parameters: { type: 'OBJECT', properties: {} } },
] }];

const thinking = m => /2\.5/.test(m) ? { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } }
  : /gemini-3\.1/.test(m) ? { thinkingConfig: { thinkingLevel: 'minimal', includeThoughts: false } }
  : /extended-thinking/.test(m) ? { thinkingConfig: { thinkingLevel: 'low', includeThoughts: false } } : {};

/* handle = รหัสต่อสายต่อที่ Google ให้มาในสายก่อนหน้า (sessionResumptionUpdate) — ต่อใหม่แล้วจำบทสนทนาเดิมได้ */
export const cleanHandle = h => typeof h === 'string' && /^[\w\-.:/+=]{8,600}$/.test(h) ? h : '';

export function liveToken({ model, system, tools, agent = false, handle, resume, now = Date.now() }) {
  const declarations=[...(tools ? LIVE_TOOLS[0].functionDeclarations : []),...(agent === true ? LIVE_CALL_TOOLS[0].functionDeclarations : [])];
  return {
    uses: 1,
    expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
    newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
    /* REST ใช้ชื่อ bidiGenerateContentSetup (liveConnectConstraints เป็นชื่อฝั่ง SDK — ส่งไปจะได้ 400 Unknown name) */
    bidiGenerateContentSetup: {
      model: 'models/' + model,
      /* ความหน่วง: ปิดการคิดยาว (คิดก่อนพูดทำให้เงียบไป 1-3 วิ) */
      generationConfig: { responseModalities: ['AUDIO'], ...thinking(model) },
      contextWindowCompression: { slidingWindow: {} },
      /* จับจังหวะพูด: เดิมไวมาก (เริ่มพูด HIGH + เงียบ 0.35 วิ = จบ) เสียงรถ/เสียง AI ที่สะท้อนเข้าไมค์จึงถูกนับเป็นผู้ใช้พูดแทรก
         AI หยุดพูดกลางคันแล้วรอ = "อยู่ ๆ AI เงียบ" · ตอนนี้: ต้องเป็นเสียงพูดชัด ๆ ถึงนับว่าแทรก และเว้นจังหวะคนไทยพูดคิดได้ 0.6 วิ */
      realtimeInputConfig: { automaticActivityDetection: {
        startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', prefixPaddingMs: 120, silenceDurationMs: 600 } },
      /* ต่อสายใหม่ (Google หมุนเวียนการเชื่อมต่อทุกราว 10 นาที / เน็ตสะดุด) โดยจำบทสนทนาเดิมได้ */
      ...(resume !== false ? { sessionResumption: cleanHandle(handle) ? { handle: cleanHandle(handle) } : {} } : {}),
      systemInstruction: { parts: [{ text: (agent===true ? LIVE_CALL_AGENT_RULES+'\n' : '')+String(system || '').slice(0, agent===true ? 4800 : 6000) }] },
      ...(declarations.length ? { tools: [{functionDeclarations:declarations}] } : {}),
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}
