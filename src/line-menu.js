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
