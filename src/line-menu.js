/* ══════════════════════════════════════════════════════════════════
   เมนูในห้องแชต LINE ของ Cendon (rich menu)

   6 ช่อง 3×2 บนรูปขนาด 2500×1686 — รูปอยู่ในเว็บ: /img/line-richmenu.png
   ทุกปุ่มเปิดแอปใน "เบราว์เซอร์ของเครื่อง" (openExternalBrowser=1) เหมือนปุ่มในการ์ดแจ้งเตือน

   ตั้งครั้งเดียวจากหน้าแอดมิน → ตั้งค่าเว็บ → เมนูในห้องแชต LINE
   ขั้นตอน: สร้างเมนู → อัปโหลดรูป → ตั้งเป็นเมนูของทุกคน → ลบเมนูรุ่นก่อนของเราทิ้ง
   (สร้างตัวใหม่ให้เสร็จก่อนค่อยลบตัวเก่า ระหว่างนั้นผู้ใช้ไม่เจอห้องแชตที่ไม่มีเมนู)
   เมนูที่ตั้งผ่าน API ชนะเมนูที่ตั้งใน LINE OA Manager
   ══════════════════════════════════════════════════════════════════ */
import { appUrl } from './line-notify.js';

const BOT = 'https://api.line.me/v2/bot';
const BOT_DATA = 'https://api-data.line.me/v2/bot';
const NAME = 'cendon-main';
const IMG = '/img/line-richmenu.png';

/* ลำดับเดียวกับรูป: แถวบน ซ้าย→ขวา แล้วแถวล่าง */
export const MENU_TILES = [
  ['หาช่าง', '/'],
  ['ถาม AI', '/chat'],
  ['งานของฉัน', '/?jobs=1'],
  ['รถของฉัน', '/garage'],
  ['สำหรับช่าง', '/?studio=1'],
  ['บัญชี', '/profile'],
];

export function richMenuBody(env) {
  const W = [833, 834, 833], H = 843;
  return {
    size: { width: 2500, height: 1686 },
    selected: true,                      /* เปิดห้องแชตแล้วเห็นเมนูกางอยู่เลย */
    name: NAME,
    chatBarText: 'เมนู Cendon',
    areas: MENU_TILES.map(([label, path], i) => {
      const c = i % 3, r = Math.floor(i / 3);
      return {
        bounds: { x: W.slice(0, c).reduce((a, b) => a + b, 0), y: r * H, width: W[c], height: H },
        action: { type: 'uri', label, uri: appUrl(env, path) },
      };
    }),
  };
}

const auth = (env) => ({ Authorization: 'Bearer ' + env.LINE_CHANNEL_TOKEN });
const siteBase = (env) => String(env.APP_URL || 'https://cendon-beta.pages.dev').replace(/\/+$/, '');

/* สถานะสำหรับหน้าแอดมิน */
export async function richMenuStatus(env) {
  if (!env.LINE_CHANNEL_TOKEN) return { configured: false, current: null, ours: false };
  let current = null, ours = false;
  try {
    const r = await fetch(BOT + '/user/all/richmenu', { headers: auth(env) });
    if (r.ok) current = (await r.json()).richMenuId || null;
    if (current) {
      const m = await fetch(BOT + '/richmenu/' + current, { headers: auth(env) });
      ours = m.ok && (await m.json()).name === NAME;
    }
  } catch (e) {}
  return { configured: true, current, ours };
}

export async function setupRichMenu(env) {
  if (!env.LINE_CHANNEL_TOKEN) throw Object.assign(new Error('ยังไม่ได้ตั้ง LINE_CHANNEL_TOKEN ในหลังบ้าน'), { status: 503 });
  const H = auth(env);

  const img = await fetch(siteBase(env) + IMG, { cache: 'no-store' }).catch(() => null);
  if (!img || !img.ok) throw Object.assign(new Error('โหลดรูปเมนูจากเว็บไม่ได้ (' + IMG + ')'), { status: 502 });
  const bytes = await img.arrayBuffer();
  if (bytes.byteLength > 1024 * 1024) throw Object.assign(new Error('รูปเมนูใหญ่เกิน 1 MB'), { status: 400 });

  let old = [];
  try { old = ((await (await fetch(BOT + '/richmenu/list', { headers: H })).json()).richmenus || []); } catch (e) {}

  const cr = await fetch(BOT + '/richmenu', {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(richMenuBody(env)),
  });
  const made = await cr.json().catch(() => ({}));
  if (!cr.ok || !made.richMenuId) throw Object.assign(new Error('LINE ไม่รับเมนู: ' + (made.message || cr.status)), { status: 502 });
  const id = made.richMenuId;
  const drop = (mid) => fetch(BOT + '/richmenu/' + mid, { method: 'DELETE', headers: H }).then((r) => r.ok).catch(() => false);

  const up = await fetch(BOT_DATA + '/richmenu/' + id + '/content', {
    method: 'POST', headers: { ...H, 'Content-Type': 'image/png' }, body: bytes,
  });
  if (!up.ok) { await drop(id); throw Object.assign(new Error('อัปโหลดรูปเมนูไม่สำเร็จ (' + up.status + ')'), { status: 502 }); }
  const def = await fetch(BOT + '/user/all/richmenu/' + id, { method: 'POST', headers: H });
  if (!def.ok) { await drop(id); throw Object.assign(new Error('ตั้งเป็นเมนูของทุกคนไม่สำเร็จ (' + def.status + ')'), { status: 502 }); }

  /* ลบเฉพาะเมนูรุ่นก่อนที่ระบบนี้สร้าง (ชื่อ cendon-main) */
  let removed = 0;
  for (const m of old) if (m.name === NAME && m.richMenuId !== id && await drop(m.richMenuId)) removed++;
  return { richMenuId: id, removed, tiles: MENU_TILES.map((t) => t[0]) };
}

/* ══════════════════════════════════════════════════════════════════
   ตรวจการเชื่อม LINE (หน้าแอดมิน) — ไม่ต้องเดาว่าทำไมบอทเงียบ
   ดูทีละขั้น: มีค่าลับครบไหม → token ใช้ได้ไหม → LINE ตั้ง Webhook มาที่เราหรือยัง/เปิดใช้หรือยัง
   → ข้อความล่าสุดที่ LINE ส่งมา / ลายเซ็นไม่ผ่าน / ตอบกลับไม่สำเร็จ (บันทึกไว้ใน config ตอนเกิดจริง)
   ══════════════════════════════════════════════════════════════════ */
const thTime = (ms) => ms ? new Date(ms).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

export async function lineStatus(env, origin, notes = {}) {
  const want = origin + '/api/line/webhook';
  const out = { secret: !!env.LINE_CHANNEL_SECRET, token: !!env.LINE_CHANNEL_TOKEN, oa: env.LINE_OA_ID || '',
    want, bot: null, webhook: null, notes, problems: [] };
  const P = (s) => out.problems.push(s);
  if (!out.secret) P('หลังบ้านยังไม่มี LINE_CHANNEL_SECRET — ใส่ด้วย npx wrangler secret put LINE_CHANNEL_SECRET แล้ว deploy');
  if (!out.token) { P('หลังบ้านยังไม่มี LINE_CHANNEL_TOKEN — ใส่ด้วย npx wrangler secret put LINE_CHANNEL_TOKEN แล้ว deploy'); return out; }
  const H = auth(env);
  try {
    const r = await fetch(BOT + '/info', { headers: H });
    if (r.ok) { const j = await r.json(); out.bot = { name: j.displayName || '', basicId: j.basicId || '', chatMode: j.chatMode || '', pictureUrl: j.pictureUrl || '' }; }
    else out.tokenStatus = r.status;
  } catch (e) { out.tokenStatus = 0; }
  if (!out.bot) { P('LINE ไม่รับ LINE_CHANNEL_TOKEN (ตอบ ' + (out.tokenStatus || 'ไม่ได้') + ') — ก๊อป Channel access token (long-lived) ใหม่จากแท็บ Messaging API แล้วใส่ใหม่'); return out; }
  if (out.oa && out.bot.basicId && out.oa.toLowerCase() !== out.bot.basicId.toLowerCase())
    P(`LINE_OA_ID (${out.oa}) ไม่ตรงกับบัญชีจริง (${out.bot.basicId}) — ปุ่มเชื่อมในแอปจะเปิดผิดห้อง`);
  try {
    const r = await fetch(BOT + '/channel/webhook/endpoint', { headers: H });
    if (r.ok) { const j = await r.json(); out.webhook = { endpoint: j.endpoint || '', active: !!j.active }; }
  } catch (e) {}
  if (out.webhook) {
    if (out.webhook.endpoint !== want) P('Webhook URL ใน LINE ยังไม่ได้ชี้มาที่หลังบ้านของเรา — กดปุ่ม "ตั้งและทดสอบ Webhook"');
    if (!out.webhook.active) P('ยังไม่ได้เปิด "Use webhook" — LINE Developers → ช่อง Messaging API → แท็บ Messaging API → Webhook settings → เปิด Use webhook');
  }
  if (notes.badSig && (!notes.event || notes.badSig.at > notes.event.at))
    P(`LINE ส่งข้อความมาแล้วแต่ลายเซ็นไม่ผ่าน (${thTime(notes.badSig.at)}) — LINE_CHANNEL_SECRET ไม่ตรงกับช่องนี้ ก๊อป Channel secret จากแท็บ Basic settings มาใส่ใหม่`);
  if (notes.replyErr && (!notes.event || notes.replyErr.at >= notes.event.at))
    P(`ตอบกลับไม่สำเร็จ (${thTime(notes.replyErr.at)}, LINE ตอบ ${notes.replyErr.status}) ${notes.replyErr.detail || ''}`.trim());
  return out;
}

/* ตั้ง Webhook URL ให้ชี้มาที่หลังบ้านนี้ แล้วให้ LINE ยิงทดสอบจริงหนึ่งครั้ง */
export async function lineFixWebhook(env, origin) {
  if (!env.LINE_CHANNEL_TOKEN) throw Object.assign(new Error('หลังบ้านยังไม่มี LINE_CHANNEL_TOKEN'), { status: 503 });
  const want = origin + '/api/line/webhook', H = { ...auth(env), 'Content-Type': 'application/json' };
  const set = await fetch(BOT + '/channel/webhook/endpoint', { method: 'PUT', headers: H, body: JSON.stringify({ endpoint: want }) });
  if (!set.ok) {
    const j = await set.json().catch(() => ({}));
    throw Object.assign(new Error('ตั้ง Webhook URL ไม่สำเร็จ: ' + (j.message || set.status)), { status: 502 });
  }
  let test = null;
  try {
    const r = await fetch(BOT + '/channel/webhook/test', { method: 'POST', headers: H, body: JSON.stringify({ endpoint: want }) });
    test = await r.json();
  } catch (e) {}
  const ok = !!(test && test.success);
  const why = ok ? '' : test && test.statusCode === 401 ? 'หลังบ้านปฏิเสธลายเซ็น — LINE_CHANNEL_SECRET ไม่ตรงกับช่องนี้'
    : test && test.statusCode === 404 ? 'หลังบ้านยังไม่มีทางรับ webhook — ยังไม่ได้ deploy รุ่นล่าสุด'
    : test ? `LINE ทดสอบไม่ผ่าน: ${test.statusCode || ''} ${test.reason || ''} ${test.detail || ''}`.trim() : 'ทดสอบไม่ได้';
  return { endpoint: want, ok, why, test };
}
