/* ตั้งค่าการโทรคุยกับ Cendon (Gemini Live) ที่ล็อกไว้ในกุญแจใช้ครั้งเดียว — แยกออกมาให้เทสต์ได้โดยไม่ต้องเรียก Google */
import { LIVE_CALL_TOOLS, LIVE_CALL_AGENT_RULES } from './live-call-tools.mjs';
import { GARAGE_CARE_RULES } from './garage-care.mjs';
import { VEHICLE_AUDIO_RULES } from './vehicle-audio.mjs';

/* เครื่องมือที่ผู้ช่วยเสียงเรียกเองได้ระหว่างโทร: ผู้ใช้พูดว่า "ฟังเสียงเครื่องหน่อย" / "ดูห้องเครื่องให้หน่อย"
   หน้าเว็บเปิดโหมดฟังเสียงดิบ (ไม่กรองเสียงรบกวน) หรือสแกนกล้องแบบสด แล้วส่งผลกลับให้ AI พูดต่อ */
export const LIVE_TOOLS = [{ functionDeclarations: [
  { name: 'listen_engine', description: 'Open vehicle confirmation, then record about 10 seconds of raw car sound only after the user taps Start. The vehicle may be the selected Garage car, another car or unknown. Never identify a make/model/year from sound, inherit the saved car without confirmation, or claim normal/safe operation from speech-filtered call audio. Call whenever asked to listen to an engine, noise, knock, squeal or car sound; wait for the actual tool result.',
    parameters: { type: 'OBJECT', properties: { area: { type: 'STRING', description: 'Where the phone is held, e.g. engine bay, wheel, exhaust, cabin' }, when: { type: 'STRING', description: 'When the sound happens, e.g. idle, revving, braking, turning' } } } },
  { name: 'scan_engine_bay', description: 'Start a rear-camera car OR motorcycle component-identification scan, including scooters and electric vehicles. Red numbered boxes locate clearly identified visible parts; red does NOT mean damaged. Use for engine bays, motorcycle engine sides and already exposed powertrain assemblies. Covers, fairings, closed CVT and battery enclosures do not reveal hidden parts. The tool may return no confirmed parts or ask for a clearer view. Use latest results only; the photographed vehicle may differ from the saved car. This is fallible identification, not a diagnosis or safety inspection. Tell the user to park safely, switch off, let it cool and observe without touching. Never suggest opening caps, removing covers/fairings/seats/tanks, disconnecting parts or touching high-voltage equipment. Call when asked to identify, scan, highlight or explain car or motorcycle parts.',
    parameters: { type: 'OBJECT', properties: {} } },
] }];

const thinking = m => /2\.5/.test(m) ? { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } }
  : /gemini-3\.1/.test(m) ? { thinkingConfig: { thinkingLevel: 'minimal', includeThoughts: false } }
  : /extended-thinking/.test(m) ? { thinkingConfig: { thinkingLevel: 'low', includeThoughts: false } } : {};

/* handle = รหัสต่อสายต่อที่ Google ให้มาในสายก่อนหน้า (sessionResumptionUpdate) — ต่อใหม่แล้วจำบทสนทนาเดิมได้ */
export const cleanHandle = h => typeof h === 'string' && /^[\w\-.:/+=]{8,600}$/.test(h) ? h : '';

export function liveToken({ model, system, tools, agent = false, webResearch = false, garageCare = false, garageAssist = false, handle, resume, now = Date.now() }) {
  const agentTools=structuredClone(LIVE_CALL_TOOLS[0].functionDeclarations).filter(t=>(t.name!=='web_search'||webResearch===true)&&(t.name!=='garage_checkin_control'||garageCare===true)&&(t.name!=='get_parking'||garageAssist===true));
  if(!garageAssist){const v=agentTools.find(t=>t.name==='valet');if(v)v.parameters.properties.do.enum=v.parameters.properties.do.enum.filter(d=>d!=='car_info');}
  const declarations=[...(tools ? LIVE_TOOLS[0].functionDeclarations : []),...(agent === true ? agentTools : [])];
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
      systemInstruction: { parts: [{ text: VEHICLE_AUDIO_RULES+'\n'+(agent===true ? LIVE_CALL_AGENT_RULES+'\n' : '')+GARAGE_CARE_RULES+'\n'+String(system || '').slice(0, agent===true ? 4800 : 6000) }] },
      ...(declarations.length ? { tools: [{functionDeclarations:declarations}] } : {}),
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}
