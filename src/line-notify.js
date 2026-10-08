/* ══════════════════════════════════════════════════════════════════
   แจ้งเตือนงานช่างทาง LINE (Messaging API · push)

   ส่งเฉพาะคนที่ผูก LINE กับบัญชีแล้ว (ตาราง line_link ของระบบหลัก)
   ข้อความแบบ push นับโควตารายเดือนของ LINE OA จึงส่งเฉพาะจังหวะที่อีกฝ่าย
   ต้องรู้หรือต้องทำอะไรต่อ และข้อความแชตแจ้งได้ไม่เกิน 1 ครั้งต่อ 30 นาที
   ต่อใบงานต่อผู้รับ (ดู once)

   ปุ่มในการ์ดเปิดแอปใน "เบราว์เซอร์ของเครื่อง" (openExternalBrowser=1)
   ไม่เปิดในเบราว์เซอร์ของ LINE ซึ่งยังไม่ได้ล็อกอิน และ Google ไม่ให้ล็อกอินในนั้น
   ══════════════════════════════════════════════════════════════════ */
const PUSH = 'https://api.line.me/v2/bot/message/push';
const ORANGE = '#E8590C';

export const money = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/* ลิงก์เข้าแอป — path เช่น "/?job=<id>" */
export function appUrl(env, path) {
  const base = String(env.APP_URL || 'https://cendon-beta.pages.dev').replace(/\/+$/, '');
  return base + path + (path.includes('?') ? '&' : '?') + 'openExternalBrowser=1';
}

/* การ์ดแจ้งเตือน: ป้ายเล็กสีส้ม · หัวข้อ · รายละเอียดไม่เกิน 5 บรรทัด · ปุ่มเปิดแอป */
export function card({ tag, title, lines = [], url, label }) {
  const L = lines.map(l => cut(l, 160)).filter(Boolean).slice(0, 5);
  const bubble = {
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '18px', contents: [
      { type: 'text', text: 'CENDON · ' + cut(tag, 40), size: 'xxs', color: ORANGE, weight: 'bold' },
      { type: 'text', text: cut(title, 120) || 'Cendon', size: 'md', weight: 'bold', color: '#18181B', wrap: true },
      ...L.map(l => ({ type: 'text', text: l, size: 'sm', color: '#52525B', wrap: true })),
    ] },
  };
  if (url) bubble.footer = { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [
    { type: 'button', style: 'primary', color: ORANGE, height: 'sm',
      action: { type: 'uri', label: cut(label || 'เปิดในแอป', 20), uri: url } }] };
  return { type: 'flex', altText: cut(title + (L[0] ? ' — ' + L[0] : ''), 380) || 'Cendon', contents: bubble };
}

/* ส่งหาเจ้าของบัญชี uid — ไม่ได้ผูก LINE / ยังไม่ได้ตั้ง token / ผู้ใช้บล็อก OA = เงียบ ๆ ไม่ทำให้งานหลักพัง */
export async function notify(env, uid, msg) {
  if (!env.LINE_CHANNEL_TOKEN || !uid || !msg) return false;
  let link = null;
  try {
    link = await env.DB.prepare('SELECT line_uid FROM line_link WHERE uid = ? AND active = 1').bind(uid).first();
  } catch (e) { return false; }          /* ยังไม่มีตาราง line_link = ระบบหลักยังไม่เปิด LINE */
  if (!link) return false;
  try {
    const r = await fetch(PUSH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_CHANNEL_TOKEN },
      body: JSON.stringify({ to: link.line_uid, messages: [msg] }),
    });
    return r.ok;
  } catch (e) { return false; }
}

/* ได้สิทธิ์ส่งครั้งเดียวต่อช่วงเวลา (เช่น แจ้งแชตใหม่ 1 ครั้ง / 30 นาที / ใบงาน / ผู้รับ) */
export async function once(env, key, uid, ms) {
  try {
    const r = await env.DB.prepare(
      'INSERT INTO tech_limits (scope, uid, bucket, n) VALUES (?,?,?,1) ON CONFLICT(scope, uid, bucket) DO NOTHING RETURNING n')
      .bind(key, uid, Math.floor(Date.now() / ms)).first();
    return !!r;
  } catch (e) { return false; }
}

/* ── ข้อความของแต่ละจังหวะในใบงาน ──
   j = แถว tech_jobs · shop = ชื่อร้าน · x = ข้อมูลเสริมของจังหวะนั้น
   ไม่ใส่ที่อยู่หรือเบอร์โทรลงใน LINE — ดูได้ในใบงานเท่านั้น */
export function jobCard(env, kind, j, shop, x = {}) {
  const url = appUrl(env, '/?job=' + encodeURIComponent(j.id));
  let q = {}; try { q = JSON.parse(j.quote || '{}') || {}; } catch (e) {}
  const car = j.car || 'รถของคุณ';
  switch (kind) {
    case 'request': return card({ tag: 'คำขอราคาใหม่', title: car, url, label: 'ดูและเสนอราคา', lines: [
      cut(j.symptom, 90), 'พื้นที่ ' + j.area, 'สะดวก ' + j.requested_time,
      j.mode === 'mobile' ? 'ให้ช่างไปหาถึงที่' : 'ลูกค้านำรถเข้าร้าน'] });
    case 'quote': return card({ tag: 'ได้ราคาแล้ว', title: `${shop} เสนอราคา ฿${money(q.total)}`, url, label: 'ดูใบเสนอราคา', lines: [
      car, cut(q.scope, 90), q.appointment ? 'นัด ' + q.appointment : ''] });
    case 'accept': return card({ tag: 'ลูกค้ายืนยันราคา', title: car, url, label: 'เปิดใบงาน', lines: [
      `ราคาที่ตกลง ฿${money(q.total)}`, q.appointment ? 'นัด ' + q.appointment : '', 'ขอรหัสเริ่มงาน 4 หลักจากลูกค้าตอนพบกัน'] });
    case 'enroute': return card({ tag: 'ช่างกำลังไป', title: `${shop} กำลังเดินทางไปหาคุณ`, url, label: 'ดูใบงาน', lines: [
      car, 'เตรียมรหัสเริ่มงานในใบงานไว้บอกช่างเมื่อพบกัน'] });
    case 'done': return card({ tag: 'ซ่อมเสร็จแล้ว', title: `${shop} แจ้งว่าซ่อมเสร็จ`, url, label: 'ตรวจและยืนยัน', lines: [
      car, cut(x.note, 90), 'ตรวจรถให้เรียบร้อย แล้วกดยืนยันในใบงาน'] });
    case 'complete': return card({ tag: 'งานเสร็จสมบูรณ์', title: `ลูกค้ายืนยันงาน ${car} แล้ว`, url, label: 'เปิดใบงาน', lines: [
      'ขอบคุณที่ดูแลลูกค้าของ Cendon'] });
    case 'review': return card({ tag: 'รีวิวใหม่', title: `ได้ ${'★'.repeat(Math.max(1, Math.min(5, x.rating || 0)))} จากลูกค้า`, url, label: 'ดูรีวิว', lines: [
      car, cut(x.text, 90)] });
    case 'cancel': return card({ tag: 'ยกเลิกงาน', title: `${car} ถูกยกเลิก`, url, label: 'ดูใบงาน', lines: [
      x.by === 'customer' ? 'ลูกค้ายกเลิกงานนี้' : `${shop} ยกเลิกงานนี้`, cut(x.note, 90)] });
    case 'dispute': return card({ tag: 'แจ้งปัญหา', title: `มีการแจ้งปัญหาในงาน ${car}`, url, label: 'ดูใบงาน', lines: [
      cut(x.note, 90), 'ทีมงาน Cendon จะช่วยดูแลเรื่องนี้'] });
    case 'extra': return card({ tag: 'ขอทำงานเพิ่ม', title: `${shop} ขอทำงานเพิ่ม ฿${money(x.total)}`, url, label: 'ยอมรับหรือปฏิเสธ', lines: [
      cut(x.desc, 90), 'งานเพิ่มทำได้ต่อเมื่อคุณกดยอมรับในใบงาน'] });
    case 'extra_ok': case 'extra_no': return card({ tag: 'งานเพิ่ม', title: kind === 'extra_ok' ? 'ลูกค้ายอมรับงานเพิ่ม' : 'ลูกค้าไม่รับงานเพิ่ม', url, label: 'เปิดใบงาน', lines: [
      car, cut(x.desc, 90)] });
    case 'message': return card({ tag: 'ข้อความใหม่', title: x.from || 'ข้อความใหม่', url, label: 'ตอบกลับ', lines: [
      cut(x.text, 140), car] });
    default: return null;
  }
}
