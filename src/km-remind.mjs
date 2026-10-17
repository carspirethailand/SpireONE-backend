/* ══ เตือนจดเลขไมล์ทุกวัน 18:00 (เวลาไทย) — ผู้ใช้เปิดเองที่กระดิ่งแจ้งเตือน ปิดเมื่อไรก็ได้ ══
   · เชื่อม LINE ไว้ → ถามทาง LINE แล้วพิมพ์เลขตอบในแชตได้เลย (รถหลายคัน = ถามทีละคัน คำตอบเป็น reply ไม่กินโควตา push)
   · ไม่ได้เชื่อม LINE → แจ้งเตือนในเครื่อง แตะแล้วเปิดช่องใส่เลขไมล์ของคันนั้นในการาจ
   · คันที่จดเลขไมล์วันนี้แล้ว (จากแอป ใบเสร็จ เติมน้ำมัน OBD) ไม่ถามซ้ำ · ทุกคันจดแล้ว = ไม่ส่งอะไรเลย
   · ไม่เดาและไม่บันทึกให้เอง: บันทึกเฉพาะเลขที่ผู้ใช้พิมพ์เอง · เลขน้อยกว่าเดิม = ไม่รับ · กระโดดผิดปกติ = ให้ยืนยันก่อน
   · ตารางสร้างเองครั้งแรกที่ใช้ (ไม่ต้องเลื่อนรุ่นฐานข้อมูล) · อยู่ในรายการข้อมูลบัญชี (ส่งออก/รีเซ็ต/ลบบัญชี) */

export const KM_CRON = '0 11 * * *';            // 11:00 UTC = 18:00 เวลาไทย
const DAY = 86400000, TH = 7 * 3600000;
export const PENDING_MS = 18 * 3600000;          // คำถามใน LINE ตอบได้ถึงเที่ยงวันถัดไป
export const MAX_KM = 3000000;

const TABLE = `CREATE TABLE IF NOT EXISTS km_remind (
  uid      TEXT PRIMARY KEY,
  on_      INTEGER NOT NULL DEFAULT 0,
  pending  TEXT,
  sent_day TEXT,
  t        INTEGER NOT NULL
)`;
const ready = new WeakSet();   // สร้างครั้งเดียวต่อฐานข้อมูล (ต่อ isolate)
export async function kmTable(env) {
  if (ready.has(env.DB)) return;
  await env.DB.prepare(TABLE).run();
  ready.add(env.DB);
}

/* วันที่ตามเวลาไทย (YYYY-MM-DD) และเวลาเริ่มวันนั้นเป็น ms */
export const thDay = (now = Date.now()) => new Date(now + TH).toISOString().slice(0, 10);
export const thDayStart = (now = Date.now()) => Date.parse(thDay(now) + 'T00:00:00+07:00');

/* อ่านเลขไมล์จากข้อความสั้น ๆ: "52300" "52,300" "52 300 กม." "ไมล์ 52300" "52300km" · ข้อความอื่นปนมา = ไม่ใช่เลขไมล์ (ปล่อยให้ AI ตอบ) */
const KM_RE = /^(?:(?:เลข\s*)?ไมล์|mileage|odo(?:meter)?)?\s*:?\s*(\d{1,3}(?:[,\s]\d{3})+|\d{1,7})\s*(?:กม\.?|กิโล(?:เมตร)?|km|ไมล์)?\s*$/i;
export function parseKm(text) {
  const m = KM_RE.exec(String(text || '').normalize('NFC').trim());
  if (!m) return null;
  const v = Number(m[1].replace(/[,\s]/g, ''));
  return Number.isInteger(v) && v >= 1 && v <= MAX_KM ? v : null;
}
/* "ยืนยัน 52300" = ยืนยันเลขที่ระบบทักว่าสูงผิดปกติ */
export function parseConfirm(text) {
  const m = /^(?:ยืนยัน|confirm)\s*(.+)$/i.exec(String(text || '').trim());
  return m ? parseKm(m[1]) : null;
}
export const SKIP_RE = /^(ข้าม|ข้ามคันนี้|ไม่ได้ขับ|ไม่ได้ขับวันนี้|ไว้ก่อน|skip)\s*$/i;
export const OFF_RE = /^(หยุดเตือนไมล์|ปิดเตือนไมล์|เลิกเตือนไมล์|ไม่ต้องเตือนไมล์|stop km)\s*$/i;

/* ตรวจเลขใหม่เทียบเลขล่าสุดที่ยืนยันแล้ว — เลขไมล์ถอยหลังไม่ได้ · วิ่งเพิ่มเกินวันละ 1,500 กม. (ขั้นต่ำ 2,000) ให้ยืนยันก่อน */
export function checkKm(v, last, now = Date.now()) {
  if (!Number.isInteger(v) || v < 1 || v > MAX_KM) return { ok: false, why: 'range' };
  const km = Number(last && last.km), at = Number(last && last.at);
  if (!Number.isFinite(km) || km <= 0) return { ok: true };
  if (v < km) return { ok: false, why: 'lower', last: km };
  const days = Number.isFinite(at) && at > 0 ? Math.max(1, (now - at) / DAY) : 1;
  const jump = v - km, cap = Math.max(2000, Math.round(days * 1500));
  if (jump > cap) return { ok: false, why: 'jump', last: km, jump, days: Math.round(days) };
  return { ok: true };
}

const n = v => Math.round(Number(v) || 0).toLocaleString('en-US');
const nameOf = c => `${c.make || ''} ${c.model || ''}`.replace(/\s+/g, ' ').trim().slice(0, 60) || 'รถของคุณ';

/* คำถามทาง LINE ทีละคัน + ปุ่มลัด (ข้าม / หยุดเตือน) */
export function askLine(car, est, i, total) {
  const head = total > 1 ? `(${i + 1}/${total}) ` : '';
  const guess = est && est.km > 0 ? `\nระบบประเมินไว้ราว ${n(est.km)} กม. ถ้าไม่ตรงก็ไม่เป็นไร พิมพ์เลขจริงจากหน้าปัดได้เลย` : '';
  return {
    type: 'text',
    text: `${head}จดเลขไมล์วันนี้ — ${nameOf(car)}${guess}\nพิมพ์ตอบเป็นตัวเลข เช่น ${n(est && est.km > 0 ? Math.ceil(est.km / 100) * 100 : 52300)}`,
    quickReply: { items: [
      { type: 'action', action: { type: 'message', label: 'ข้ามคันนี้', text: 'ข้ามคันนี้' } },
      { type: 'action', action: { type: 'message', label: 'หยุดเตือนไมล์', text: 'หยุดเตือนไมล์' } },
    ] },
  };
}
/* แจ้งเตือนในเครื่อง (ไม่มี LINE) — คันแรกที่ยังไม่จด แตะแล้วเปิดช่องใส่เลขไมล์ของคันนั้น */
export function pushText(cars, est) {
  const c = cars[0], more = cars.length - 1;
  return {
    title: 'จดเลขไมล์วันนี้',
    body: `${nameOf(c)}${est && est.km > 0 ? ` · ประเมินไว้ราว ${n(est.km)} กม.` : ''} — แตะเพื่อใส่เลขจริง${more > 0 ? ` (และอีก ${more} คัน)` : ''}`,
    url: '/garage?car=' + encodeURIComponent(c.id) + '&km=1',
    tag: 'cendon-km',
  };
}
export function replyFor(check, v) {
  if (check.why === 'lower') return `เลข ${n(v)} น้อยกว่าที่บันทึกไว้ล่าสุด (${n(check.last)} กม.) — เลขไมล์ถอยหลังไม่ได้ ลองดูหน้าปัดอีกครั้งแล้วพิมพ์ใหม่ครับ`;
  if (check.why === 'jump') return `เลข ${n(v)} เพิ่มจากล่าสุด ${n(check.jump)} กม. ใน ${check.days} วัน ซึ่งสูงผิดปกติ — ถ้าถูกต้องพิมพ์ "ยืนยัน ${v}" ครับ`;
  return 'เลขไมล์ต้องเป็นตัวเลข 1 – 3,000,000 ครับ';
}

/* รายการคันที่ยังต้องถาม: ข้ามคันที่จดวันนี้แล้ว · ไม่เกิน 6 คัน */
export const toAsk = (cars, doneIds) => (cars || []).filter(c => c && c.id && !doneIds.has(String(c.id))).slice(0, 6);

/* อัปเดตเลขไมล์ในการาจที่ซิงก์กับแอป (user_state.garage) ให้ทุกเครื่องเห็นเลขใหม่
   เขียนเฉพาะเมื่อเลขใหม่มากกว่าเดิม · เทียบเวลาเดิมก่อนเขียน (ถ้ามีเครื่องอื่นเขียนแทรก ไม่ทับ) */
export async function setGarageKm(env, uid, carId, v, now = Date.now()) {
  const row = await env.DB.prepare('SELECT v, t FROM user_state WHERE uid = ? AND k = ?').bind(uid, 'garage').first();
  if (!row) return false;
  let list; try { list = JSON.parse(row.v); } catch (e) { return false; }
  const c = Array.isArray(list) ? list.find(x => x && String(x.id) === String(carId)) : null;
  if (!c) return false;
  const cur = parseInt(String(c.mileage ?? '').replace(/[^0-9]/g, ''), 10);
  if (Number.isFinite(cur) && cur >= v) return false;
  c.mileage = typeof c.mileage === 'number' ? v : String(v);
  const t = Math.max(now, Number(row.t) + 1);
  const r = await env.DB.prepare('UPDATE user_state SET v = ?, t = ? WHERE uid = ? AND k = ? AND t = ?')
    .bind(JSON.stringify(list), t, uid, 'garage', row.t).run();
  return !!(r && r.meta && r.meta.changes);
}

export async function getPref(env, uid) {
  await kmTable(env);
  const r = await env.DB.prepare('SELECT on_ FROM km_remind WHERE uid = ?').bind(uid).first();
  return !!(r && r.on_);
}
export async function setPref(env, uid, on, now = Date.now()) {
  await kmTable(env);
  await env.DB.prepare(`INSERT INTO km_remind (uid, on_, t) VALUES (?, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET on_ = excluded.on_, t = excluded.t${on ? '' : ', pending = NULL'}`).bind(uid, on ? 1 : 0, now).run();
  return !!on;
}
export async function getPending(env, uid, now = Date.now()) {
  await kmTable(env);
  const r = await env.DB.prepare('SELECT pending FROM km_remind WHERE uid = ? AND on_ = 1').bind(uid).first();
  let p = null; try { p = r && r.pending ? JSON.parse(r.pending) : null; } catch (e) {}
  if (!p || !Array.isArray(p.q) || !(now - Number(p.at) < PENDING_MS) || !(p.i < p.q.length)) return null;
  return p;
}
export async function savePending(env, uid, p) {
  await env.DB.prepare('UPDATE km_remind SET pending = ? WHERE uid = ?').bind(p && p.i < p.q.length ? JSON.stringify(p) : null, uid).run();
}
