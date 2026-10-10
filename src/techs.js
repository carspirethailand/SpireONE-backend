/*
 * Cendon Care — ระบบช่าง (ส่วนเสริมของ spireonebackend)
 *
 * อยู่ไฟล์แยกจาก worker.js เพื่อไม่ต้องแก้โค้ดเดิมที่ยาวห้าพันบรรทัด
 * worker.js แค่ส่งทุกคำขอที่ขึ้นต้นด้วย /api/tech มาที่ handleTech() ในไฟล์นี้
 * ใช้ฐานข้อมูล ตัวตรวจล็อกอิน และรายชื่อ OWNERS ชุดเดียวกับระบบหลัก
 * ตารางสร้างเองตอนเรียกครั้งแรก ไม่ต้องรัน migration
 *
 * หลักที่ใช้ทั้งไฟล์
 *   - ทุกกฎตรวจที่นี่ซ้ำ ถึงหน้าเว็บจะตรวจแล้วก็ตาม — การตรวจในเบราว์เซอร์คือความสะดวก ไม่ใช่ความปลอดภัย
 *   - ใบงานเปลี่ยนสถานะได้ตามเส้นทางที่กำหนดเท่านั้น ข้ามขั้นไม่ได้
 *   - เบอร์กับที่อยู่ลูกค้าเปิดให้ช่างเห็นหลังลูกค้ายืนยันราคาแล้วเท่านั้น
 */
import { verifyFirebaseToken } from './auth.js';
import { screenApplication, screeningSnapshot } from './tech-screen.js';
import { applicantErrors, imageInfo, approvalError } from './tech-vetting.js';
import { notify, jobCard, card, once, appUrl } from './line-notify.js';
const CATS = ['body', 'ev', 'tyre', 'air', 'eng'];
const CAT_TH = { body: 'ตัวถัง & สี', ev: 'ไฟฟ้า & EV', tyre: 'ยาง & ช่วงล่าง', air: 'แอร์รถยนต์', eng: 'เครื่องยนต์' };
/* ด่านที่ทีมงานต้องตรวจเองก่อนอนุมัติ — ชื่อต้องตรงกับหน้าเว็บ (tech.html) */
const CHECKS = ['identity', 'phone', 'work', 'skills', 'shop', 'terms'];
/* เอกสารที่ผู้สมัครต้องแนบ [ชนิด, ขั้นต่ำ, สูงสุด]
   บัตรประชาชนกับเซลฟี่คู่บัตรใช้ยืนยันว่าเป็นคนเดียวกับเจ้าของบัญชี แล้วลบทิ้งหลังตรวจ (PDPA)
   ใบรับรองฝีมือไม่บังคับ — ช่างเก่งจำนวนมากไม่มีใบ ทีมงานสัมภาษณ์ทักษะแทนได้ */
const DOCS = [['id', 1, 1], ['selfie', 1, 1], ['shop', 1, 3], ['work', 3, 6], ['cert', 0, 2]];
const PRIVATE_DOCS = ['id', 'selfie', 'cert'];
const API_VERSION = 7;
const PHONE = /^0\d{8,9}$/;
const now = () => Date.now();


/* ── ตาราง ── สร้างเองครั้งแรกที่มีคนเรียก /api/tech แบบเดียวกับ ensureSchema ของระบบหลัก */
const TECH_SQL = [
  `CREATE TABLE IF NOT EXISTS tech_limits (scope TEXT, uid TEXT, bucket INTEGER, n INTEGER NOT NULL, PRIMARY KEY(scope,uid,bucket))`,
  `CREATE TABLE IF NOT EXISTS tech_identity_claims (id_hash TEXT PRIMARY KEY, uid TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS tech_applications (
  uid        TEXT PRIMARY KEY,
  email      TEXT,
  data       TEXT NOT NULL,            -- JSON ของทุกช่องในฟอร์ม
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  test       INTEGER NOT NULL DEFAULT 0,
  review     TEXT,                     -- JSON {by, note, checks, at}
  revision   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS tech_profiles (
  id           TEXT PRIMARY KEY,
  uid          TEXT NOT NULL UNIQUE,   -- บัญชีเจ้าของ ใช้ตัดสินว่าใครรับงานแทนช่างคนนี้ได้
  phone        TEXT,                   -- ไม่ส่งออกในรายชื่อสาธารณะ
  data         TEXT NOT NULL,          -- JSON โปรไฟล์ที่แสดงได้
  verified     INTEGER NOT NULL DEFAULT 0,
  test         INTEGER NOT NULL DEFAULT 0,
  suspended    INTEGER NOT NULL DEFAULT 0,
  jobs         INTEGER NOT NULL DEFAULT 0,
  rating_sum   INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS tech_jobs (
  id             TEXT PRIMARY KEY,     -- ฝั่งหน้าเว็บสร้าง ใช้กันกดส่งซ้ำแล้วได้สองใบ
  tech_id        TEXT NOT NULL,
  customer_uid   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'requested',
  test           INTEGER NOT NULL DEFAULT 0,
  car            TEXT NOT NULL,
  symptom        TEXT NOT NULL,
  area           TEXT NOT NULL,
  address        TEXT NOT NULL,
  phone          TEXT NOT NULL,
  requested_time TEXT NOT NULL,
  mode           TEXT NOT NULL,
  quote          TEXT,                 -- JSON
  completion     TEXT,
  dispute        TEXT,
  resolution     TEXT,
  review         TEXT,                 -- JSON {rating, text, at}
  history        TEXT NOT NULL,        -- JSON [{status, at, by}]
  accepted_at    INTEGER,
  revision       INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS tech_docs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS tech_docs_uid ON tech_docs(uid, kind)`,
  `CREATE INDEX IF NOT EXISTS tech_jobs_customer ON tech_jobs(customer_uid, updated_at)`,
  `CREATE INDEX IF NOT EXISTS tech_jobs_tech     ON tech_jobs(tech_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS tech_messages (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT NOT NULL,
  uid     TEXT NOT NULL,
  role    TEXT NOT NULL,               -- customer | technician
  text    TEXT NOT NULL,
  at      INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS tech_messages_job ON tech_messages(job_id, id)`,
  `CREATE TABLE IF NOT EXISTS tech_reads (
  job_id TEXT NOT NULL,
  uid    TEXT NOT NULL,
  last   INTEGER NOT NULL DEFAULT 0,   -- id ข้อความล่าสุดที่เห็น
  PRIMARY KEY (job_id, uid)
)`
];
/* คอลัมน์ที่เพิ่มทีหลัง — ALTER ซ้ำจะ error ว่ามีอยู่แล้ว ซึ่งเป็นเรื่องปกติ ข้ามไปได้ */
const TECH_ALTER = [
  /* รหัสเริ่มงาน (ลูกค้าบอกช่างเมื่อพบกันจริง) และงานเพิ่มที่ลูกค้าต้องกดยอมรับ */
  `ALTER TABLE tech_jobs ADD COLUMN start_code TEXT`,
  `ALTER TABLE tech_jobs ADD COLUMN start_exp INTEGER`,
  `ALTER TABLE tech_jobs ADD COLUMN start_tries INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tech_jobs ADD COLUMN extras TEXT`,
  `ALTER TABLE tech_applications ADD COLUMN ai TEXT`,
  `ALTER TABLE tech_applications ADD COLUMN id_hash TEXT`,
  `ALTER TABLE tech_docs ADD COLUMN hash TEXT`,
  `ALTER TABLE tech_jobs ADD COLUMN group_id TEXT`,
  `ALTER TABLE tech_profiles ADD COLUMN online INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tech_profiles ADD COLUMN last_seen INTEGER`,
  `CREATE TABLE IF NOT EXISTS tech_posts (
  id TEXT PRIMARY KEY, customer_uid TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', test INTEGER NOT NULL DEFAULT 0,
  car TEXT NOT NULL, symptom TEXT NOT NULL, cat TEXT, lat REAL NOT NULL, lng REAL NOT NULL, area TEXT NOT NULL,
  address TEXT NOT NULL, phone TEXT NOT NULL, requested_time TEXT NOT NULL, mode TEXT NOT NULL, urgent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tech_posts_open ON tech_posts(status, created_at)`,
  `ALTER TABLE tech_posts ADD COLUMN note TEXT`,
  `ALTER TABLE tech_jobs ADD COLUMN note TEXT`,
  `CREATE TABLE IF NOT EXISTS tech_media (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, uid TEXT NOT NULL, mime TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tech_media_owner ON tech_media(owner)`,
  `CREATE INDEX IF NOT EXISTS tech_jobs_group ON tech_jobs(group_id)`,
  /* โพสต์ของช่าง: kind = package (บริการพร้อมราคา จองได้) | work (ผลงาน) — ขึ้นหน้าแรกเหมือน Fastwork */
  `CREATE TABLE IF NOT EXISTS tech_gigs (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, tech_id TEXT NOT NULL, kind TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT, price INTEGER, cats TEXT, brands TEXT, photos TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tech_gigs_active ON tech_gigs(active, created_at)`,
  /* บันทึกการกระทำของทีมงาน (ใครดูเอกสาร อนุมัติ ตีกลับ ระงับ) — ไม่เก็บเลขบัตรเต็มหรือ key */
  `CREATE TABLE IF NOT EXISTS tech_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT)`,
  /* ลิงก์แชร์ใบงานให้คนที่ไว้ใจ — หมดอายุ ยกเลิกได้ ไม่มีที่อยู่/เบอร์ */
  `CREATE TABLE IF NOT EXISTS tech_shares (token TEXT PRIMARY KEY, job_id TEXT NOT NULL, uid TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`,
  /* ยอดเข้าชมรายวันของร้าน (Studio → สถิติ): kind = shop | gig | call | book */
  `CREATE TABLE IF NOT EXISTS tech_views (tech_id TEXT NOT NULL, day INTEGER NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tech_id, day, kind))`,
];
const techReady = new WeakMap();
async function ensureTech(env) {
  if (!techReady.has(env.DB)) {
    const task=(async()=>{for(const sql of TECH_SQL)await env.DB.prepare(sql).run();
      for(const sql of TECH_ALTER)try{await env.DB.prepare(sql).run()}catch(e){if(!/duplicate column|already exists/i.test(e.message||''))throw e;}})();
    techReady.set(env.DB,task);task.catch(()=>techReady.delete(env.DB));
  }
  await techReady.get(env.DB);
}
async function limit(env,scope,uid,max){
  const bucket=Math.floor(now()/86400000);
  const row=await env.DB.prepare(`INSERT INTO tech_limits(scope,uid,bucket,n) VALUES(?,?,?,1)
    ON CONFLICT(scope,uid,bucket) DO UPDATE SET n=n+1 WHERE n<? RETURNING n`).bind(scope,uid,bucket,max).first();
  if(!row)fail(429,'ตรวจหรือส่งข้อมูลบ่อยเกินไป กรุณาลองใหม่วันถัดไป');
}

/* ── ตอบกลับ ── */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

function cors(env, request) {
  const allowed = (env.ALLOWED_ORIGINS || '*').trim();
  let origin = '*';
  if (allowed !== '*') {
    const list = allowed.split(',').map(s => s.trim());
    const o = request.headers.get('Origin') || '';
    origin = list.includes(o) ? o : list[0];
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (data, status, headers) => new Response(JSON.stringify(data), {
  status: status || 200,
  headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

/* ── ตัวตน ── */
function owners(env) {
  return (env.OWNERS || 'anapatmaliwong@gmail.com,carspirethailand@gmail.com').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
}
async function who(request, env, required = true, verifyToken = verifyFirebaseToken) {
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return required ? fail(401, 'กรุณาเข้าสู่ระบบ') : null;
  const token = h.slice(7);
  let uid,email,emailVerified=false;
  try{const payload=await verifyToken(token,env.FIREBASE_PROJECT_ID);uid=payload.sub;email=payload.email||'';emailVerified=payload.email_verified===true;}
  catch(e){return fail(401,'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');}
  if (!uid) return fail(401, 'กรุณาเข้าสู่ระบบ');
  email = String(email || '').toLowerCase();
  /* ผู้ดูแลระบบช่าง = OWNERS หรือคนที่ระบบหลักตั้งยศ admin ขึ้นไป
     บัญชีที่ถูกแบนในระบบหลัก ใช้ระบบช่างไม่ได้ด้วย */
  /* staff = ผู้ดูแลกับทีมงาน (moderator) — เห็นช่างทดสอบ ตรวจใบสมัคร และจัดการระบบช่างได้ */
  let admin = emailVerified && owners(env).includes(email), staff = admin;
  try {
    const u = await env.DB.prepare('SELECT role, banned FROM users WHERE uid = ?').bind(uid).first();
    if (u && u.banned) fail(403, 'บัญชีนี้ถูกระงับ');
    if (u && (u.role === 'admin' || u.role === 'owner' && emailVerified && owners(env).includes(email))) admin = staff = true;
    if (u && u.role === 'moderator') staff = true;
  } catch (e) { if (e instanceof HttpError) throw e; }
  return { uid, email, admin, staff };
}
const adminOnly = me => { if (!me.staff) fail(403, 'เฉพาะผู้ดูแลและทีมงาน'); };

/* ── ตรวจค่า ──
   คืนข้อความภาษาไทยที่บอกว่าช่องไหนผิด เพราะข้อความนี้ขึ้นให้ผู้ใช้เห็นตรง ๆ */
const str = (v, label, min, max) => {
  const s = String(v ?? '').trim();
  if (s.length < min) fail(400, `${label}: ต้องมีอย่างน้อย ${min} ตัวอักษร`);
  if (s.length > max) fail(400, `${label}: ยาวเกิน ${max} ตัวอักษร`);
  return s;
};
const num = (v, label, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(400, `${label}: ต้องอยู่ระหว่าง ${min}–${max}`);
  return n;
};
const phone = (v, label) => {
  const p = String(v ?? '').replace(/[\s-]/g, '');
  if (!PHONE.test(p)) fail(400, `${label}: เบอร์ต้องขึ้นต้นด้วย 0 และมี 9–10 หลัก`);
  return p;
};
const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/* ── ซ่อนช่องทางติดต่อก่อนยืนยันงาน ──
   ไม่ได้หวังว่าจะกันคนตั้งใจได้ — คนตั้งใจเว้นวรรคหรือเขียนเลขไทยก็หลุดแล้ว
   แค่กันไม่ให้หลุดโดยไม่ตั้งใจ ก่อนที่ลูกค้าจะได้เห็นราคาและยืนยันงาน
   หลังยืนยันงานแล้วไม่ซ่อนอะไรเลย เพราะตอนนั้นต้องโทรนัดกันจริง */
function mask(text) {
  return text
    .replace(/(\+?66|0)[\s.-]?\d(?:[\s.-]?\d){7,8}/g, '[ซ่อนเบอร์ไว้จนกว่าจะยืนยันงาน]')
    .replace(/(line|ไลน์)\s*(id)?\s*[:：]?\s*@?[a-z0-9._-]{3,}/gi, '[ซ่อนไลน์ไว้จนกว่าจะยืนยันงาน]');
}

/* ── ลบข้อมูลแฝงในรูปก่อนเก็บ ──
   มือถือหลายรุ่นฝังพิกัด GPS ที่ถ่าย (มักเป็นบ้านลูกค้า) และข้อมูลเครื่องไว้ในไฟล์รูป
   JPEG: ตัด APP1 (EXIF/XMP), APP13 (IPTC), COM · PNG: ตัด eXIf / tEXt / iTXt / zTXt
   ไฟล์ที่อ่านโครงสร้างไม่ออก คืนตามเดิม (ด่านตรวจไฟล์จริงจัดการต่อ) — แอปเราย่อรูปผ่าน canvas อยู่แล้ว นี่คือด่านสำรองฝั่งเซิร์ฟเวอร์ */
function b64bytes(b64) { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }
function bytesb64(parts) {
  let s = '';
  for (const u of parts) for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function stripMeta(mime, b64) {
  let b; try { b = b64bytes(b64); } catch { return b64; }
  if (mime === 'image/jpeg') {
    if (b[0] !== 0xFF || b[1] !== 0xD8) return b64;
    const out = [b.subarray(0, 2)]; let p = 2, sos = false;
    while (p + 2 <= b.length) {
      if (b[p] !== 0xFF) return b64;
      let q = p; while (q < b.length && b[q] === 0xFF) q++;
      const mk = b[q];
      if (mk === 0xDA || mk === 0xD9) { out.push(b.subarray(p)); sos = true; break; }
      if ((mk >= 0xD0 && mk <= 0xD7) || mk === 0x01) { out.push(b.subarray(p, q + 1)); p = q + 1; continue; }
      if (q + 2 >= b.length) return b64;
      const len = (b[q + 1] << 8) | b[q + 2], end = q + 1 + len;
      if (len < 2 || end > b.length) return b64;
      if (mk !== 0xE1 && mk !== 0xED && mk !== 0xFE) out.push(b.subarray(p, end));
      p = end;
    }
    return sos ? bytesb64(out) : b64;
  }
  if (mime === 'image/png') {
    if (b.length < 8 || b[0] !== 137 || b[1] !== 80) return b64;
    const out = [b.subarray(0, 8)], drop = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']); let p = 8, end = false;
    while (p + 12 <= b.length) {
      const n = ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3], type = String.fromCharCode(...b.subarray(p + 4, p + 8)), e = p + 12 + n;
      if (e > b.length) return b64;
      if (!drop.has(type)) out.push(b.subarray(p, e));
      p = e; if (type === 'IEND') { end = true; break; }
    }
    return end ? bytesb64(out) : b64;
  }
  return b64;
}
const imgClean = m => { if (m) m[2] = stripMeta(m[1], m[2]); return m; };

const audit = (env, me, action, target, detail = '') => env.DB.prepare('INSERT INTO tech_audit (at, actor, action, target, detail) VALUES (?,?,?,?,?)')
  .bind(now(), String(me.email || me.uid), action, String(target || ''), String(detail).slice(0, 300)).run().catch(() => {});
async function auditLog(env, me) {
  if (!me.admin) fail(403, 'เฉพาะ admin');
  const { results } = await env.DB.prepare('SELECT at, actor, action, target, detail FROM tech_audit ORDER BY id DESC LIMIT 200').all();
  return { log: results };
}

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/* ── ช่าง ── */
const THEMES = ['orange', 'blue', 'green', 'violet', 'rose', 'slate', 'amber', 'teal'];
function vacationOf(d) {
  const v = d.vacation;
  if (!v || !v.on || (v.until && v.until < Date.now())) return null;
  return { until: v.until || null, note: v.note || '' };
}
function publicTech(r) {
  const d = parse(r.data) || {};
  return {
    id: r.id, name: d.name, shop: d.shop || '', area: d.area || '',
    lat: d.lat ?? null, lng: d.lng ?? null,
    cats: d.cats || [], skills: (d.cats || []).map(c => CAT_TH[c]).filter(Boolean),
    about: d.about || '', years: d.years || 0, from: d.from || 0, to: 0,
    warranty: d.warranty || 0, radius: d.radius || 0,
    mobile: !!d.mobile, urgent: !!d.urgent, brands: [],
    /* ช่างที่ยังไม่มีรีวิวต้องได้ 0 ไม่ใช่ 5 — คะแนนเต็มที่ไม่มีใครให้ คือคะแนนปลอม */
    rating: r.review_count ? Math.round(r.rating_sum / r.review_count * 10) / 10 : 0,
    reviewCount: r.review_count, jobs: r.jobs,
    reply: null, verified: !!r.verified, test: !!r.test,
    photos: r.photos || [], online: !!r.online, hours: d.hours || '',
    /* รูปปกหน้าร้าน (แบนเนอร์) — ต้องเป็นรูปของร้านนี้ที่ยังอยู่ ไม่งั้นใช้รูปแรกแทน */
    cover: d.cover && (r.photos || []).includes(d.cover) ? d.cover : ((r.photos || []).find(x => x !== d.avatar) || null),
    /* รูปโปรไฟล์แยกจากรูปผลงาน — ไม่มีก็ใช้ตัวอักษรย่อ (ไม่เอารูปผลงานมาแทนแล้ว) */
    avatar: d.avatar && (r.photos || []).includes(d.avatar) ? d.avatar : null,
    /* เบอร์โทรโชว์เฉพาะช่างที่เปิดให้ลูกค้าโทรตรง */
    phone: d.showPhone ? String(d.phone || r.phone || '') : undefined, showPhone: !!d.showPhone,
    subs: d.subs || [], week: d.week || null, brands2: d.brands2 || [], line: d.line || '', facebook: d.facebook || '', address: d.address || '',
    /* โหมดพักร้อน: แสดงบนหน้าร้าน และงดรับคำขอใหม่จนกว่าจะถึงวันที่ตั้ง */
    vacation: vacationOf(d), greet: d.greet || '', theme: d.theme || '',
    vetting: d.vetting && r.verified ? { at: d.vetting.at, identity: !!d.vetting.identity, phone: !!d.vetting.phone, shop: d.vetting.shop || '', skills: d.vetting.skills || '', cats: d.vetting.cats || [], mobile: !!d.vetting.mobile } : null,
  };
}
/* D1 รับตัวแปรได้ไม่เกิน 100 ตัวต่อคำสั่ง — พอช่าง/งานเกินร้อย รายชื่อจะพังทั้งหน้า
   จึงแบ่ง IN (...) เป็นชุดละ 90 แล้วรวมผล ({IN} ในคำสั่งคือจุดที่ใส่ ? ของรายการ) */
async function inAll(env, sql, list, pre = [], post = []) {
  const out = [];
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    const { results } = await env.DB.prepare(sql.replace('{IN}', part.map(() => '?').join(','))).bind(...pre, ...part, ...post).all();
    out.push(...results);
  }
  return out;
}
/* แนบรูปอู่และรูปผลงาน (ไม่ใช่บัตร) ให้การ์ดช่าง — ดึงครั้งเดียวทั้งรายการ ไม่ใช่ทีละคน */
async function withPhotos(env, rows) {
  if (!rows.length) return rows;
  const uids = [...new Set(rows.map(r => r.uid))];
  const results = await inAll(env, "SELECT id, uid, kind FROM tech_docs WHERE kind IN ('shop','work') AND uid IN ({IN}) ORDER BY kind DESC, id ASC", uids);
  const by = {};
  results.forEach(d => (by[d.uid] = by[d.uid] || []).push(d.id));
  return rows.map(r => ({ ...r, photos: by[r.uid] || [] }));
}
async function techById(env, id) {
  return env.DB.prepare('SELECT * FROM tech_profiles WHERE id = ?').bind(id).first();
}

async function listTechs(env, me, url) {
  if (url.searchParams.get('test') === '1') {
    adminOnly(me);
    const { results } = await env.DB.prepare(
      'SELECT * FROM tech_profiles WHERE test = 1 AND suspended = 0 ORDER BY created_at DESC').all();
    return { techs: (await withPhotos(env, results)).map(publicTech) };
  }
  /* ทีมงานเห็นช่างทดสอบปนอยู่ในรายชื่อจริงด้วย (มีป้ายบอก) — ทดสอบได้เหมือนลูกค้าจริงทุกขั้น
     คนทั่วไปไม่เห็นช่างทดสอบเลย */
  const q = me && me.staff
    ? 'SELECT * FROM tech_profiles WHERE suspended = 0 AND (verified = 1 OR test = 1) ORDER BY test DESC, online DESC, created_at DESC LIMIT 500'
    : 'SELECT * FROM tech_profiles WHERE test = 0 AND suspended = 0 AND verified = 1 ORDER BY online DESC, created_at DESC LIMIT 500';
  const { results } = await env.DB.prepare(q).all();
  return { techs: (await withPhotos(env, results)).map(publicTech) };
}

/* staff = ทีมงานเห็นผล AI ครบ · ผู้สมัครเห็นแค่สถานะ (ไม่เห็นจุดสงสัย กันการลองหาทางหลบระบบ) */
function appOut(a, staff = false) {
  if (!a) return null;
  const d = parse(a.data) || {}, ai = parse(a.ai);
  return { ...d, uid: a.uid, email: a.email, status: a.status, test: !!a.test,
    review: parse(a.review), revision: a.revision, createdAt: a.created_at, ai: staff ? ai : ai ? { status: ai.status } : null };
}

async function meInfo(env, me) {
  const [a, t] = await Promise.all([
    env.DB.prepare('SELECT * FROM tech_applications WHERE uid = ?').bind(me.uid).first(),
    env.DB.prepare('SELECT * FROM tech_profiles WHERE uid = ?').bind(me.uid).first(),
  ]);
  /* งานที่รอเราทำอะไรสักอย่าง + ข้อความที่ยังไม่ได้อ่าน
     ใช้ขึ้นตัวเลขบนปุ่ม "งานของฉัน" ช่างจะได้ไม่พลาดคำขอราคา
     เพราะเรายังไม่มีการแจ้งเตือนทาง SMS */
  const jobs = await myJobs(env, me, t);
  const attention = jobs.filter(j => j.needsMe || j.unread > 0).length;
  return {
    uid: me.uid, email: me.email, admin: me.admin, staff: me.staff, version: API_VERSION,
    application: appOut(a),
    technician: t ? { ...publicTech((await withPhotos(env, [t]))[0]), suspended: !!t.suspended,
      /* ค่าตั้งของร้านที่เห็นเฉพาะเจ้าของ (Studio → ตั้งค่า) */
      ...(() => { const d = parse(t.data) || {}; return { autoReply: d.autoReply || null, minPrice: d.minPrice || 0, vacationRaw: d.vacation || null }; })() } : null,
    attention,
  };
}

/* เลขบัตรประชาชนไทย 13 หลัก ตรวจหลักสุดท้ายตามสูตรของกรมการปกครอง
   กันพิมพ์ผิดหนึ่งหลักได้เกือบทุกกรณี */
function thaiId(s) {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(s[12]);
}

/* พิกัดต้องอยู่ในไทย (เผื่อขอบ) — กันพิกัดศูนย์ศูนย์จาก GPS ที่ยังจับไม่ได้ */
function coord(b) {
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 5 || lat > 21 || lng < 97 || lng > 106.5)
    fail(400, 'ตำแหน่งอู่: กดปุ่มใช้ตำแหน่งปัจจุบัน หรือเลือกบนแผนที่');
  return { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 };
}

/* รูปเอกสาร — หน้าเว็บย่อเป็น JPEG ก่อนส่งแล้ว ที่นี่ตรวจชนิดและขนาดซ้ำ */
function docList(b) {
  const docs = Array.isArray(b.docs) ? b.docs : [];
  if (docs.length > 14) fail(400, 'แนบรูปได้ไม่เกิน 14 รูป');
  const out = [];
  for (const d of docs) {
    const m = imgClean(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(d && d.data || '')));
    if (!m) fail(400, 'ไฟล์ต้องเป็นรูปภาพ');
    if (m[2].length > 1400000) fail(400, 'รูปใหญ่เกินไป');
    if (!DOCS.some(([k]) => k === d.kind)) fail(400, 'ชนิดเอกสารไม่ถูกต้อง');
    try{imageInfo(m[1],m[2])}catch(e){fail(400,e.message)}
    out.push({ kind: d.kind, mime: m[1], data: m[2] });
  }
  const label = { id: 'บัตรประชาชน', selfie: 'รูปถ่ายคู่บัตร', shop: 'รูปอู่หรือเครื่องมือ', work: 'รูปผลงาน', cert: 'ใบรับรอง' };
  for (const [k, min, max] of DOCS) {
    const n = out.filter(d => d.kind === k).length;
    if (n < min) fail(400, `${label[k]}: ต้องแนบอย่างน้อย ${min} รูป`);
    if (n > max) fail(400, `${label[k]}: แนบได้ไม่เกิน ${max} รูป`);
  }
  return out;
}

async function apply(env, me, b) {
  const t = now();
  if (b.test) {
    /* ช่างทดสอบของทีมงาน — ใช้แค่ตำแหน่งอู่ ข้ามเกณฑ์และเอกสารทั้งหมด
       เห็นได้เฉพาะทีมงาน คนทั่วไปไม่เห็น รีวิวไม่ถูกนับ */
    adminOnly(me);
    if(!me.admin)fail(403,'โหมดข้ามเกณฑ์ใช้ได้เฉพาะ admin');
    const real=await env.DB.prepare('SELECT status,test FROM tech_applications WHERE uid=?').bind(me.uid).first();
    if(real&&!real.test&&real.status!=='rejected')fail(409,'บัญชีนี้มีใบสมัครจริง ใช้บัญชี admin แยกสำหรับทดสอบ');
    /* ทีมงานกด "ข้าม" ได้โดยไม่ส่งตำแหน่ง — ใช้ตำแหน่งเดิมของร้านทีมงาน ถ้าไม่มีใช้กลางกรุงเทพฯ แก้ทีหลังในแท็บร้าน */
    let c;
    if (b.lat == null || b.lng == null) {
      const old = await env.DB.prepare('SELECT data FROM tech_profiles WHERE uid = ?').bind(me.uid).first();
      const od = old && parse(old.data);
      c = od && od.lat ? { lat: od.lat, lng: od.lng } : { lat: 13.7563, lng: 100.5018 };
    } else c = coord(b);
    const nick = (me.email.split('@')[0] || 'staff').slice(0, 30);
    const d = {
      name: String(b.name || '').trim().slice(0, 100) || 'ช่างทดสอบ ' + nick,
      shop: String(b.shop || '').trim().slice(0, 120) || 'อู่ทดสอบ',
      phone: '', area: String(b.area || '').trim().slice(0, 160) || 'ตำแหน่งทดสอบ',
      lat: c.lat, lng: c.lng, cats: CATS.slice(), mobile: true, urgent: true,
      about: 'ช่างทดสอบของทีมงาน', years: 0, from: 0, warranty: 7, radius: 30,
    };
    const id = 't_' + (await sha(me.uid)).slice(0, 16);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO tech_applications (uid,email,data,status,test,review,revision,created_at,updated_at)
        VALUES (?,?,?,'approved',1,NULL,1,?,?)
        ON CONFLICT(uid) DO UPDATE SET data=excluded.data,status='approved',test=1,revision=revision+1,updated_at=excluded.updated_at`)
        .bind(me.uid, me.email, JSON.stringify(d), t, t),
      /* ร้านเดิมที่แก้ไว้แล้วต้องไม่ถูกค่าเริ่มต้นเขียนทับ (บั๊ก "บันทึกแล้วกลับเป็นค่าเดิม") */
      env.DB.prepare(`INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at)
        VALUES (?,?,?,?,0,1,0,?,?)
        ON CONFLICT(uid) DO UPDATE SET data=CASE WHEN tech_profiles.data IS NULL OR tech_profiles.data='' OR tech_profiles.data='{}' THEN excluded.data ELSE tech_profiles.data END,test=1,suspended=0,updated_at=excluded.updated_at`)
        .bind(id, me.uid, d.phone, JSON.stringify(d), t, t),
    ]);
    return { ok: true, id };
  }

  const existing = await env.DB.prepare('SELECT status FROM tech_applications WHERE uid = ?').bind(me.uid).first();
  if (existing && existing.status === 'pending') fail(409, 'ใบสมัครของคุณอยู่ระหว่างตรวจ รอผลก่อนส่งใหม่');
  if (existing && existing.status === 'approved') fail(409, 'บัญชีนี้เป็นช่างในระบบแล้ว');

  const cats = [...new Set((Array.isArray(b.cats) ? b.cats : []).filter(c => CATS.includes(c)))];
  if (!cats.length) fail(400, 'เลือกงานที่รับอย่างน้อย 1 อย่าง');
  if (b.consent !== true || b.aiConsent !== true) fail(400, 'ต้องยินยอมให้ตรวจใบสมัครและให้ Gemini ตรวจรูปอู่/ผลงานก่อนส่ง');
  /* เลขบัตรที่กรอกต้องตรงกับรูปบัตร — ต้องยินยอมให้ระบบตรวจบัตร · การเทียบใบหน้าเป็นความยินยอมแยก ไม่บังคับ (ข้อมูลอ่อนไหว) */
  if (b.idConsent !== true) fail(400, 'ต้องยินยอมให้ระบบตรวจเลขบนรูปบัตรประชาชนก่อนส่ง');
  const idNo = String(b.idNo || '').replace(/\D/g, '');
  if (!thaiId(idNo)) fail(400, 'เลขประจำตัวประชาชนไม่ถูกต้อง');
  const c = coord(b);
  const d = {
    name: str(b.name, 'ชื่อ-นามสกุล (ตรงบัตร)', 4, 100), shop: String(b.shop || '').trim().slice(0, 120),
    phone: phone(b.phone, 'เบอร์โทร'), area: str(b.area, 'เขต / จังหวัด', 3, 160),
    age: num(b.age, 'อายุ', 18, 80), years: num(b.years, 'ประสบการณ์', 2, 60),
    about: String(b.about || '').trim().slice(0, 1000),
    from: num(b.from, 'ราคาเริ่มต้น', 1, 1000000), warranty: num(b.warranty, 'รับประกัน', 7, 365),
    radius: num(b.radius, 'รัศมีบริการ', 0, 200), lat: c.lat, lng: c.lng,
    cats, mobile: !!b.mobile, urgent: !!b.urgent, hasCert: false, consentAt: t,
    title: ['นาย', 'นาง', 'นางสาว'].includes(b.title) ? b.title : '', idNo,
    birth: /^\d{4}-\d{2}-\d{2}$/.test(String(b.birth || '')) ? b.birth : '', aiConsent:true, idConsent:true, faceConsent:b.faceConsent===true,
    appNo: 'CP-' + (await sha(me.uid)).slice(0, 6).toUpperCase(), submittedAt: t,
  };
  if(typeof b.age==='boolean'||typeof b.years==='boolean')fail(400,'อายุและประสบการณ์ต้องเป็นตัวเลข');
  const invalid=applicantErrors(d,t);if(invalid.length)fail(400,invalid.map(x=>x.msg).join(' · '));
  const docs = docList(b);
  for (const x of docs) x.hash = await sha(x.data);
  if(new Set(docs.map(x=>x.hash)).size!==docs.length)fail(400,'ต้องใช้รูปต่างกัน ไม่ใช้รูปเดียวซ้ำหลายช่อง');
  const idHash = await sha('cendon-id:' + idNo);
  const duplicate=await env.DB.prepare("SELECT uid FROM tech_applications WHERE id_hash=? AND uid!=? AND test=0 AND status!='rejected'").bind(idHash,me.uid).first();
  if(duplicate)fail(409,'ข้อมูลตัวตนนี้มีใบสมัครอยู่แล้ว กรุณาติดต่อทีมงาน');
  await limit(env,'apply',me.uid,4);
  d.hasCert = docs.some(x => x.kind === 'cert');
  d.submissionId=crypto.randomUUID();const packed=JSON.stringify(d);
  /* ส่งใหม่หลังถูกตีกลับ = เอกสารชุดใหม่ทั้งชุด ลบชุดเก่าทิ้ง */
  const stored=await env.DB.batch([
    env.DB.prepare(`INSERT INTO tech_applications (uid,email,data,status,test,review,revision,created_at,updated_at)
      VALUES (?,?,?,'pending',0,NULL,1,?,?)
      ON CONFLICT(uid) DO UPDATE SET data=excluded.data,status='pending',test=0,review=NULL,ai=NULL,revision=revision+1,updated_at=excluded.updated_at
      WHERE tech_applications.status='rejected' OR tech_applications.test=1`)
      .bind(me.uid,me.email,packed,t,t),
    env.DB.prepare('INSERT INTO tech_identity_claims(id_hash,uid) SELECT ?,? FROM tech_applications WHERE uid=? AND data=? ON CONFLICT(uid) DO UPDATE SET id_hash=excluded.id_hash').bind(idHash,me.uid,me.uid,packed),
    env.DB.prepare('DELETE FROM tech_docs WHERE uid=? AND EXISTS(SELECT 1 FROM tech_applications WHERE uid=? AND data=?)').bind(me.uid,me.uid,packed),
    ...docs.map(x=>env.DB.prepare('INSERT INTO tech_docs(uid,kind,mime,data,created_at,hash) SELECT ?,?,?,?,?,? FROM tech_applications WHERE uid=? AND data=?').bind(me.uid,x.kind,x.mime,x.data,t,x.hash,me.uid,packed)),
    env.DB.prepare('UPDATE tech_applications SET id_hash=? WHERE uid=? AND data=?').bind(idHash,me.uid,packed),
  ]);
  if(!stored[0].meta.changes)fail(409,'ใบสมัครถูกส่งแล้ว กรุณาโหลดสถานะ ไม่ส่งซ้ำ');
  /* AI คัดกรองทันทีหลังส่ง — ล้มก็ไม่กระทบการสมัคร ทีมงานกด "ตรวจอีกครั้ง" ได้ */
  let ai=null;try{ai=await runScreen(env,me.uid)}catch{ /* stays pending, never approved */ }
  /* ข้อที่ไม่ผ่านแน่นอน (เลขบนบัตรไม่ตรงกับที่กรอก อ่านไม่ได้ บัตรหมดอายุ ฯลฯ) ตีกลับทันทีพร้อมเหตุผล
     ผู้สมัครแก้แล้วส่งใหม่ได้เลย ไม่ต้องรอทีมงาน · ลบรูปบัตร/เซลฟี่ และปล่อยเลขบัตรคืน (กันคนกรอกเลขคนอื่นแล้วจองไว้) */
  const blocks=(ai?.flags||[]).filter(f=>f.block);
  if(blocks.length){
    const reasons=blocks.map(f=>f.msg),rv=JSON.stringify({id:crypto.randomUUID(),by:'system',auto:true,decision:'reject',note:reasons.join(' · '),reasons,at:now()});
    await env.DB.batch([
      env.DB.prepare("UPDATE tech_applications SET status='rejected',review=?,updated_at=?,revision=revision+1 WHERE uid=? AND status='pending' AND revision=?").bind(rv,now(),me.uid,ai.revision),
      env.DB.prepare(`DELETE FROM tech_docs WHERE uid=? AND kind IN (${PRIVATE_DOCS.map(() => '?').join(',')}) AND EXISTS(SELECT 1 FROM tech_applications WHERE uid=? AND review=?)`).bind(me.uid,...PRIVATE_DOCS,me.uid,rv),
      env.DB.prepare('DELETE FROM tech_identity_claims WHERE uid=? AND EXISTS(SELECT 1 FROM tech_applications WHERE uid=? AND review=?)').bind(me.uid,me.uid,rv),
    ]);
    return {ok:true,status:'rejected',result:'rejected',reasons};
  }
  return {ok:true,status:'pending',result:'pending',screening:ai?{status:ai.status,verdict:ai.verdict}:null};
}

/* รัน AI คัดกรองแล้วเก็บผลไว้ในใบสมัคร (ทีมงานเห็นเท่านั้น ผู้สมัครไม่เห็น) */
async function runScreen(env, uid) {
  const app = await env.DB.prepare('SELECT * FROM tech_applications WHERE uid = ?').bind(uid).first();
  if (!app || app.test) return null;
  if(app.status!=='pending')fail(409,'ตรวจได้เฉพาะใบสมัครที่รอตรวจ');
  await limit(env,'screen',uid,6);await limit(env,'screen_global','all',200);
  const { results: docs } = await env.DB.prepare('SELECT kind, mime, data, hash FROM tech_docs WHERE uid = ? ORDER BY id').bind(uid).all();
  const dupId = app.id_hash ? await env.DB.prepare("SELECT COUNT(*) AS n FROM tech_applications WHERE id_hash=? AND uid!=? AND test=0 AND status!='rejected'").bind(app.id_hash,uid).first() : null;
  const hashes = docs.map(x => x.hash).filter(Boolean);
  let dupImageKinds = [];
  if (hashes.length) {
    const { results } = await env.DB.prepare(`SELECT DISTINCT d.hash FROM tech_docs d WHERE d.uid != ? AND d.hash IN (${hashes.map(() => '?').join(',')})`).bind(uid, ...hashes).all();
    const dup = new Set(results.map(r => r.hash));
    dupImageKinds = docs.filter(x => dup.has(x.hash)).map(x => x.kind);
  }
  const ai = await screenApplication(env, { app, docs, dupIdCount: dupId ? dupId.n : 0, dupImageKinds });
  const saved=await env.DB.prepare("UPDATE tech_applications SET ai=? WHERE uid=? AND revision=? AND status='pending'").bind(JSON.stringify(ai),uid,app.revision).run();
  if(!saved.meta.changes)fail(409,'ใบสมัครเปลี่ยนระหว่างตรวจ กรุณาโหลดใหม่');
  return ai;
}
async function rescreen(env, me, b) {
  adminOnly(me);
  await limit(env,'rescreen_admin',me.uid,30);
  const uid = String(b.uid || '');
  await audit(env, me, 'rescreen', uid);
  const a = await env.DB.prepare('SELECT status FROM tech_applications WHERE uid = ?').bind(uid).first();
  if (!a) fail(404, 'ไม่พบใบสมัคร');
  if (a.status !== 'pending') fail(409, 'ตรวจได้เฉพาะใบที่รอตรวจ (เอกสารของใบที่ตรวจแล้วถูกลบไปแล้ว)');
  return { ok: true, ai: await runScreen(env, uid) };
}

/* เอกสารของผู้สมัคร — ทีมงานเท่านั้น */
async function appDocs(env, me, uid) {
  adminOnly(me);
  await audit(env, me, 'view_docs', uid);
  const { results } = await env.DB.prepare('SELECT id, kind, mime, data FROM tech_docs WHERE uid = ? ORDER BY id').bind(uid).all();
  return { docs: results.map(d => ({ id: d.id, kind: d.kind, url: `data:${d.mime};base64,${d.data}` })) };
}

/* รูปอู่/ผลงานบนการ์ดช่าง — เปิดสาธารณะเฉพาะของช่างที่ผ่านการตรวจแล้ว
   บัตรประชาชนกับเซลฟี่ไม่มีทางออกทางนี้ไม่ว่ากรณีใด */
async function image(env, request, id) {
  const d = await env.DB.prepare(
    `SELECT d.mime, d.data, p.verified, p.test FROM tech_docs d JOIN tech_profiles p ON p.uid = d.uid
     WHERE d.id = ? AND d.kind IN ('shop','work','gig','review') AND p.suspended = 0`).bind(id).first();
  /* ร้านทีมงาน (test) ยังไม่ผ่านการตรวจแต่ทีมงานเห็นในรายชื่อ — ถ้าไม่ให้รูปผ่าน ทีมงานเห็นรูปแตก
     แท็ก <img> ส่งโทเคนไม่ได้ จึงเปิดเฉพาะรูปอู่/ผลงาน (ไม่ใช่บัตร) และรหัสรูปมีแค่ในรายชื่อที่ทีมงานเห็น */
  if (!d || !(d.verified || d.test)) return new Response('Not found', { status: 404 });
  const bin = Uint8Array.from(atob(d.data), c => c.charCodeAt(0));
  return new Response(bin, { headers: { 'Content-Type': d.mime, 'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*' } });
}

async function pendingApps(env, me) {
  adminOnly(me);
  const { results } = await env.DB.prepare(
    "SELECT * FROM tech_applications WHERE status = 'pending' ORDER BY created_at ASC").all();
  return { applications: results.map(a => appOut(a, true)) };
}

/* ── ด่านคัดเลือกช่าง ──
   อนุมัติได้ก็ต่อเมื่อผู้ดูแลติ๊กครบทุกข้อ ไม่มีทางลัด
   บันทึกว่าใครตรวจ ตรวจอะไร เมื่อไร — ถ้ามีปัญหาทีหลังจะย้อนดูได้ว่าพลาดที่ด่านไหน */
async function review(env, me, b) {
  adminOnly(me);
  if(!me.admin)fail(403,'เฉพาะ admin ที่อนุมัติใบสมัครจริงได้');
  const a = await env.DB.prepare('SELECT * FROM tech_applications WHERE uid = ?').bind(String(b.uid || '')).first();
  if (!a) fail(404, 'ไม่พบใบสมัคร');
  if (a.status !== 'pending') fail(409, 'ใบสมัครนี้ถูกตรวจไปแล้ว');
  if (Number(b.revision) !== a.revision) fail(409, 'ผู้สมัครเพิ่งแก้ใบสมัคร กรุณาโหลดใหม่ก่อนตรวจ');
  if(a.test)fail(409,'ใบสมัครทดสอบไม่สามารถรับรองเป็นร้านจริง');
  if(me.uid===a.uid)fail(403,'ต้องให้ admin คนอื่นตรวจใบสมัครจริง ไม่อนุมัติตัวเอง');
  const checks = Object.fromEntries(CHECKS.map(k => [k, b.checks?.[k]===true]));
  const note = str(b.note, 'บันทึกการตรวจ', 10, 2000);
  if(!['approve','reject'].includes(b.decision))fail(400,'คำตัดสินไม่ถูกต้อง');
  const decision = b.decision;
  if (decision === 'approve' && !CHECKS.every(k => checks[k])) fail(400, 'อนุมัติได้เมื่อตรวจครบทุกข้อเท่านั้น');
  let evidence={},resolutions={};
  if(decision==='approve'){
    const {results:docs}=await env.DB.prepare('SELECT kind,mime,data,hash FROM tech_docs WHERE uid=? ORDER BY id').bind(a.uid).all();
    const ai=parse(a.ai),error=approvalError({app:a,ai,snapshot:await screeningSnapshot(a,docs),evidence:b.evidence,resolutions:b.resolutions});if(error)fail(400,error);
    const duplicate=await env.DB.prepare("SELECT uid FROM tech_applications WHERE id_hash=? AND uid!=? AND test=0 AND status!='rejected'").bind(a.id_hash,a.uid).first();
    if(duplicate)fail(409,'พบข้อมูลตัวตนซ้ำ ต้องตรวจและแก้ไขก่อน');
    evidence=Object.fromEntries(CHECKS.map(k=>[k,{method:b.evidence[k].method,note:b.evidence[k].note.trim()}]));
    resolutions=Object.fromEntries((ai.flags||[]).filter(f=>f.level!=='low'&&f.source!=='rules').map(f=>[f.code,{outcome:b.resolutions[f.code].outcome,note:b.resolutions[f.code].note.trim()}]));
  }
  const t = now();
  const rv = JSON.stringify({id:crypto.randomUUID(),by:me.email,note,checks,evidence,resolutions,decision,at:t,screeningSnapshot:parse(a.ai)?.snapshot||null});
  /* ตรวจเสร็จแล้วเก็บเลขบัตรไว้แค่ 4 หลักท้าย พอให้ย้อนตรวจได้ แต่ไม่พอเอาไปใช้ปลอมตัว */
  const dd = parse(a.data) || {};
  if (dd.idNo) dd.idNo = 'x-xxxx-xxxxx-' + String(dd.idNo).slice(-3, -1) + '-' + String(dd.idNo).slice(-1);
  const stmts = [env.DB.prepare("UPDATE tech_applications SET status=?,review=?,data=?,updated_at=?,revision=revision+1 WHERE uid=? AND status='pending' AND revision=? AND ai IS ?")
    .bind(decision === 'approve' ? 'approved' : 'rejected', rv, JSON.stringify(dd), t, a.uid,a.revision,a.ai),
    /* ตรวจเสร็จแล้ว ลบรูปบัตร เซลฟี่ และใบรับรองทิ้งทันที ไม่เก็บไว้เกินจำเป็น (PDPA)
       เหลือแค่บันทึกว่าใครตรวจอะไรไปเมื่อไร */
    env.DB.prepare(`DELETE FROM tech_docs WHERE uid=? AND kind IN (${PRIVATE_DOCS.map(() => '?').join(',')}) AND EXISTS(SELECT 1 FROM tech_applications WHERE uid=? AND review=?)`)
      .bind(a.uid,...PRIVATE_DOCS,a.uid,rv)];
  if (decision === 'approve') {
    const d = parse(a.data) || {};
    const id = 't_' + (await sha(a.uid)).slice(0, 16);
    const profile = { name: d.name, shop: d.shop, area: d.area, cats: d.cats, about: d.about, years: d.years,
      from: d.from, warranty: d.warranty, radius: d.radius, mobile: d.mobile, urgent: d.urgent,
      lat: d.lat, lng: d.lng, cert: !!d.hasCert };
    /* ป้ายบนหน้าร้านมาจากสิ่งที่ทีมงานตรวจจริง แยกเป็นเรื่อง ๆ (ตัวตน / เบอร์ / สถานที่ / ทักษะรายหมวด) พร้อมวันที่
       ไม่มีป้าย "ปลอดภัย" เหมารวม — ยืนยันตัวตน ≠ รับรองฝีมือ ≠ รับประกันทุกเหตุการณ์ */
    const vetting = { at: t, identity: true, phone: true, shop: evidence.shop.method, skills: evidence.skills.method, cats: d.cats || [], mobile: !!d.mobile };
    profile.vetting = vetting;
    stmts.push(env.DB.prepare(`INSERT INTO tech_profiles (id,uid,phone,data,verified,test,suspended,created_at,updated_at)
      SELECT ?,?,?,?,1,0,0,?,? FROM tech_applications WHERE uid=? AND status='approved' AND review=?
      /* ร้านเดิมที่ช่างแก้ไว้แล้วต้องไม่ถูกข้อมูลจากใบสมัครเขียนทับ (บั๊ก "บันทึกแล้วกลับเป็นค่าเดิม") */
      ON CONFLICT(uid) DO UPDATE SET data=json_set(CASE WHEN tech_profiles.data IS NULL OR tech_profiles.data='' OR tech_profiles.data='{}' THEN excluded.data ELSE tech_profiles.data END,'$.vetting',json(?)),phone=excluded.phone,verified=1,test=0,suspended=0,updated_at=excluded.updated_at`)
      .bind(id,a.uid,d.phone,JSON.stringify(profile),t,t,a.uid,rv,JSON.stringify(vetting)));
  }
  if(decision==='reject')stmts.push(env.DB.prepare('DELETE FROM tech_identity_claims WHERE uid=? AND EXISTS(SELECT 1 FROM tech_applications WHERE uid=? AND review=?)').bind(a.uid,a.uid,rv));
  const result=await env.DB.batch(stmts);if(!result[0].meta.changes)fail(409,'ใบสมัครเปลี่ยนแล้ว กรุณาโหลดใหม่');
  await audit(env, me, decision, a.uid, decision === 'approve' ? 'ผ่านการตรวจครบทุกข้อ' : note.slice(0, 200));
  tell(env, a.uid, () => decision === 'approve'
    ? card({ tag: 'ผ่านการตรวจ', title: 'ร้านของคุณเปิดใน Cendon แล้ว', url: appUrl(env, '/?studio=1'), label: 'เปิด Studio',
        lines: ['ตั้งค่าร้าน ลงบริการพร้อมราคา แล้วเริ่มรับงานได้เลย'] })
    : card({ tag: 'ใบสมัครช่าง', title: 'ใบสมัครยังไม่ผ่าน', url: appUrl(env, '/?join=1'), label: 'ดูสิ่งที่ต้องแก้',
        lines: [note, 'แก้ไขแล้วส่งใหม่ได้ในแอป'] }));
  return { ok: true };
}

async function moderate(env, me, b) {
  adminOnly(me);
  const r = await env.DB.prepare('UPDATE tech_profiles SET suspended=?, updated_at=? WHERE id=?')
    .bind(b.suspend === false ? 0 : 1, now(), String(b.id || '')).run();
  if (!r.meta.changes) fail(404, 'ไม่พบช่าง');
  await audit(env, me, b.suspend === false ? 'unsuspend' : 'suspend', b.id);
  return { ok: true };
}

/* ── ใบงาน ── */
const NEXT = {
  /* action: [ใครทำได้, สถานะที่ต้องเป็นอยู่, สถานะถัดไป] */
  quote:    ['tech',     ['requested', 'quoted'],                            'quoted'],
  accept:   ['customer', ['quoted'],                                          'accepted'],
  enroute:  ['tech',     ['accepted'],                                        'enroute'],
  start:    ['tech',     ['accepted', 'enroute'],                             'working'],
  done:     ['tech',     ['working'],                                         'done'],
  complete: ['customer', ['done'],                                            'completed'],
  cancel:   ['either',   ['requested', 'quoted', 'accepted', 'enroute'],      'cancelled'],
  dispute:  ['either',   ['accepted', 'enroute', 'working', 'done', 'completed'], 'disputed'],
  resolve:  ['admin',    ['disputed'],                                        null],
  review:   ['customer', ['completed'],                                       null],
};

async function loadJob(env, me, id) {
  const j = await env.DB.prepare('SELECT * FROM tech_jobs WHERE id = ?').bind(id).first();
  if (!j) fail(404, 'ไม่พบใบงาน');
  const t = await techById(env, j.tech_id);
  const isCustomer = j.customer_uid === me.uid;
  const isTech = !!t && t.uid === me.uid;
  /* ตอบว่า "ไม่พบ" แทน "ไม่มีสิทธิ์" เพื่อไม่บอกคนนอกว่าใบงานเลขนี้มีอยู่จริง */
  if (!isCustomer && !isTech && !me.staff) fail(404, 'ไม่พบใบงาน');
  const role = isCustomer && isTech ? 'both' : isCustomer ? 'customer' : isTech ? 'technician' : 'admin';
  return { j, t, role, isCustomer, isTech };
}

function jobOut(j, t, role, messages) {
  const accepted = !!j.accepted_at;
  const d = parse(t && t.data) || {};
  const out = {
    id: j.id, status: j.status, test: !!j.test, role, revision: j.revision,
    techId: j.tech_id, techName: d.shop || d.name || 'ช่าง', group: j.group_id || null,
    car: j.car, symptom: j.symptom, area: j.area, requestedTime: j.requested_time, mode: j.mode,
    quote: parse(j.quote), completion: j.completion, dispute: j.dispute, resolution: j.resolution,
    review: parse(j.review), history: parse(j.history) || [],
    createdAt: j.created_at, acceptedAt: j.accepted_at,
    messages: messages || [], note: j.note || '',
    /* ลูกค้าใช้ตรวจว่าคนที่มาถึงคือช่างที่ตกลงไว้ — รูปโปรไฟล์และสิ่งที่ทีมงานตรวจแล้ว (ข้อมูลเดียวกับหน้าร้านสาธารณะ) */
    techAvatar: d.avatar || null, techVerified: !!(t && t.verified),
    techVetting: d.vetting && t && t.verified ? { identity: !!d.vetting.identity, cats: d.vetting.cats || [], at: d.vetting.at } : null,
  };
  /* งานเพิ่ม: ยอดที่ตกลงแล้ว = ราคาที่ยืนยัน + งานเพิ่มที่ลูกค้ากดยอมรับเท่านั้น */
  out.extras = parse(j.extras) || [];
  const q = out.quote;
  out.agreedTotal = q ? Math.round((q.total + out.extras.filter(x => x.status === 'accepted').reduce((n, x) => n + x.total, 0)) * 100) / 100 : null;
  /* รหัสเริ่มงาน: ลูกค้าเห็นรหัส · ช่างรู้แค่ว่าต้องขอรหัสจากลูกค้า · ทีมงานไม่เห็นรหัส */
  const codeOpen = ['accepted', 'enroute'].includes(j.status) && !!j.start_code;
  if (codeOpen && (role === 'customer' || role === 'both')) { out.startCode = j.start_code; out.startCodeExp = j.start_exp; }
  out.startCodeRequired = codeOpen;
  /* ลูกค้าเห็นที่อยู่ของตัวเองเสมอ ช่างเห็นหลังลูกค้ายืนยันราคาแล้วเท่านั้น */
  if (role === 'customer' || role === 'both' || role === 'admin' || accepted) out.address = j.address;
  if (accepted) { out.customerPhone = j.phone; out.technicianPhone = (t && t.phone) || ''; }
  return out;
}

async function messagesOf(env, jobId, after) {
  const { results } = await env.DB.prepare(
    'SELECT id, role, text, at FROM tech_messages WHERE job_id = ? AND id > ? ORDER BY id ASC LIMIT 500')
    .bind(jobId, after || 0).all();
  return results;
}
async function markRead(env, jobId, uid, last) {
  if (!last) return;
  await env.DB.prepare(`INSERT INTO tech_reads (job_id, uid, last) VALUES (?,?,?)
    ON CONFLICT(job_id, uid) DO UPDATE SET last = MAX(last, excluded.last)`).bind(jobId, uid, last).run();
}

async function myJobs(env, me, myTech, all) {
  let q, args;
  if (all) { q = 'SELECT * FROM tech_jobs ORDER BY updated_at DESC LIMIT 200'; args = []; }
  else if (myTech) {
    q = 'SELECT * FROM tech_jobs WHERE customer_uid = ? OR tech_id = ? ORDER BY updated_at DESC LIMIT 200';
    args = [me.uid, myTech.id];
  } else { q = 'SELECT * FROM tech_jobs WHERE customer_uid = ? ORDER BY updated_at DESC LIMIT 200'; args = [me.uid]; }
  const { results } = await env.DB.prepare(q).bind(...args).all();
  if (!results.length) return [];
  const ids = results.map(r => r.id);
  const [names, unread] = await Promise.all([
    inAll(env, 'SELECT id, data FROM tech_profiles WHERE id IN ({IN})', [...new Set(results.map(r => r.tech_id))]),
    inAll(env, `SELECT m.job_id, COUNT(*) AS n FROM tech_messages m
      LEFT JOIN tech_reads r ON r.job_id = m.job_id AND r.uid = ?
      WHERE m.job_id IN ({IN}) AND m.uid != ? AND m.id > COALESCE(r.last, 0) GROUP BY m.job_id`, ids, [me.uid], [me.uid]),
  ]);
  const nm = Object.fromEntries(names.map(r => { const d = parse(r.data) || {}; return [r.id, d.shop || d.name]; }));
  const un = Object.fromEntries(unread.map(r => [r.job_id, r.n]));
  return results.map(j => {
    const cust = j.customer_uid === me.uid, tech = !!myTech && j.tech_id === myTech.id;
    /* งานไหนรอเราอยู่ — ใช้เรียงขึ้นบนสุดและนับบนปุ่ม */
    const needsMe = (tech && ['requested', 'accepted', 'enroute', 'working'].includes(j.status))
      || (cust && ['quoted', 'done'].includes(j.status));
    const q = parse(j.quote);
    return { id: j.id, status: j.status, test: !!j.test, techName: nm[j.tech_id] || 'ช่าง', techId: j.tech_id,
      group: j.group_id || null, total: q ? q.total : null,
      car: j.car, symptom: j.symptom, createdAt: j.created_at, updatedAt: j.updated_at,
      side: cust && tech ? 'both' : cust ? 'customer' : tech ? 'technician' : 'admin',
      needsMe, unread: un[j.id] || 0 };
  });
}

/* ══ รูปแนบกับคำขอ (เช่น รูปรถที่จอด รูปอาการ) ══
   ผูกกับประกาศหรือใบงาน เห็นได้เฉพาะคนที่เปิดประกาศ/ใบงานนั้นได้ — ไม่มีทางเปิดผ่านลิงก์สาธารณะ */
function mediaIn(b) {
  const list = Array.isArray(b.photos) ? b.photos : [];
  if (list.length > 3) fail(400, 'แนบรูปได้ไม่เกิน 3 รูป');
  return list.map(x => {
    const m = imgClean(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(x || '')));
    if (!m || m[2].length > 1400000) fail(400, 'ไฟล์ต้องเป็นรูปภาพ');
    return { mime: m[1], data: m[2] };
  });
}
async function saveMedia(env, owner, uid, list) {
  if (!list.length) return;
  const have = await env.DB.prepare('SELECT COUNT(*) AS n FROM tech_media WHERE owner = ?').bind(owner).first();
  if (have.n) return;
  await env.DB.batch(list.map(x => env.DB.prepare('INSERT INTO tech_media (owner, uid, mime, data, created_at) VALUES (?,?,?,?,?)').bind(owner, uid, x.mime, x.data, now())));
}
async function mediaOf(env, owners) {
  const o = owners.filter(Boolean);
  if (!o.length) return [];
  const results = await inAll(env, 'SELECT id, mime, data FROM tech_media WHERE owner IN ({IN}) ORDER BY id', o);
  return results.map(r => `data:${r.mime};base64,${r.data}`);
}
const noteIn = b => String(b.note || '').trim().slice(0, 300);

async function createJob(env, me, b) {
  const id = String(b.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) fail(400, 'รหัสคำขอไม่ถูกต้อง');
  /* กดส่งซ้ำตอนเน็ตช้า ต้องได้ใบงานใบเดิม ไม่ใช่ใบที่สอง */
  const dup = await env.DB.prepare('SELECT customer_uid FROM tech_jobs WHERE id = ?').bind(id).first();
  if (dup) { if (dup.customer_uid !== me.uid) fail(409, 'รหัสคำขอซ้ำ'); return { id }; }

  const t = await techById(env, String(b.techId || ''));
  if (!t || t.suspended) fail(404, 'ไม่พบช่าง หรือช่างงดรับงานชั่วคราว');
  if (t.test && !me.staff) fail(404, 'ไม่พบช่าง');
  if (!t.test && !t.verified) fail(404, 'ช่างยังไม่ผ่านการตรวจ');
  if (t.uid === me.uid) fail(400, 'ขอราคาจากร้านตัวเองไม่ได้');
  const d = parse(t.data) || {};
  const vac = vacationOf(d);
  if (vac) fail(409, 'ร้านนี้ปิดชั่วคราว' + (vac.note ? ' — ' + vac.note : '') + ' ลองร้านอื่นก่อนนะ');
  const mode = b.mode === 'mobile' && d.mobile ? 'mobile' : 'shop';

  if (!t.test) {
    /* กันสแปมคำขอ — ลูกค้าจริงไม่มีใครต้องขอราคาเกินสิบครั้งในวันเดียว */
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM tech_jobs WHERE customer_uid = ? AND created_at > ?')
      .bind(me.uid, now() - 86400000).first();
    if (c.n >= 10) fail(429, 'วันนี้ส่งคำขอครบ 10 ครั้งแล้ว ลองใหม่พรุ่งนี้');
  }
  /* ขอราคาหลายร้านพร้อมกัน — ใบงานทุกใบในชุดเดียวกันมี group เดียวกัน
     พอลูกค้ายืนยันร้านหนึ่ง ร้านอื่นในชุดถูกยกเลิกให้อัตโนมัติ */
  const group = b.group ? String(b.group) : null;
  if (group && !/^[0-9a-f-]{36}$/i.test(group)) fail(400, 'รหัสชุดคำขอไม่ถูกต้อง');
  if (group) {
    const g = await env.DB.prepare('SELECT COUNT(*) AS n, MIN(customer_uid) AS u FROM tech_jobs WHERE group_id = ?').bind(group).first();
    if (g.n && g.u !== me.uid) fail(409, 'รหัสชุดคำขอซ้ำ');
    if (g.n >= 5) fail(400, 'ขอราคาพร้อมกันได้ไม่เกิน 5 ร้าน');
  }
  const ts = now();
  const photos = mediaIn(b);
  await env.DB.prepare(`INSERT INTO tech_jobs (id,tech_id,customer_uid,status,test,car,symptom,area,address,phone,requested_time,mode,history,revision,created_at,updated_at,group_id,note)
    VALUES (?,?,?,'requested',?,?,?,?,?,?,?,?,?,1,?,?,?,?)`).bind(
    id, t.id, me.uid, t.test ? 1 : 0,
    str(b.car, 'รถ / รุ่น / ปี', 2, 200), str(b.symptom, 'อาการ', 10, 2000),
    str(b.area, 'พื้นที่', 4, 160), str(b.address, 'ที่อยู่', 8, 500), phone(b.phone, 'เบอร์โทร'),
    str(b.requestedTime, 'วันและเวลา', 4, 160), mode,
    JSON.stringify([{ status: 'requested', at: ts, by: 'customer' }]), ts, ts, group, noteIn(b)).run();
  /* ขอหลายร้านพร้อมกัน เก็บรูปชุดเดียวผูกกับชุดคำขอ ไม่ต้องเก็บซ้ำทุกร้าน */
  await saveMedia(env, group || id, me.uid, photos);
  /* ตอบกลับอัตโนมัติของร้าน — ลูกค้ารู้ทันทีว่าร้านได้รับเรื่องแล้ว */
  if (d.autoReply && d.autoReply.on && d.autoReply.text) {
    await env.DB.prepare('INSERT INTO tech_messages (job_id, uid, role, text, at) VALUES (?,?,?,?,?)')
      .bind(id, t.uid, 'technician', d.autoReply.text, ts + 1).run();
  }
  await bumpView(env, t.id, 'book');
  tell(env, t.uid, async () => jobCard(env, 'request', await env.DB.prepare('SELECT * FROM tech_jobs WHERE id = ?').bind(id).first(), shopOf(t)));
  return { id };
}

/* แจ้งอีกฝ่ายทาง LINE เบื้องหลัง — ผู้กดไม่ต้องรอ LINE ตอบ และ LINE ล่มก็ไม่ทำให้ใบงานพัง
   make = ฟังก์ชันสร้างการ์ด (ถ้าต้องอ่านฐานข้อมูลก็ไปทำเบื้องหลังด้วย) · ยังไม่ตั้ง LINE = ไม่ทำอะไรเลย */
function tell(env, uid, make) {
  if (!uid || !env.LINE_CHANNEL_TOKEN) return;
  const p = (async () => { const m = await make(); if (m) await notify(env, uid, m); })().catch(() => {});
  if (env.bg) env.bg(p);
}
const shopOf = (t) => { const d = parse(t && t.data) || {}; return d.shop || d.name || 'ร้านช่าง'; };

const DAY = 86400000;
async function bumpView(env, techId, kind) {
  try {
    await env.DB.prepare('INSERT INTO tech_views (tech_id, day, kind, n) VALUES (?,?,?,1) ON CONFLICT(tech_id, day, kind) DO UPDATE SET n = n + 1')
      .bind(techId, Math.floor(now() / DAY), kind).run();
  } catch (e) { /* สถิติพลาดไม่ควรทำให้งานหลักพัง */ }
}

async function getJob(env, me, id) {
  const { j, t, role } = await loadJob(env, me, id);
  const messages = await messagesOf(env, id, 0);
  if (role !== 'admin') await markRead(env, id, me.uid, messages.length ? messages[messages.length - 1].id : 0);
  const out = jobOut(j, t, role, messages);
  out.photos = await mediaOf(env, [j.id, j.group_id]);
  out.photosBefore = await mediaOf(env, [j.id + ':before']);
  out.photosAfter = await mediaOf(env, [j.id + ':after']);
  if (role === 'customer' || role === 'both') {
    const sh = await env.DB.prepare('SELECT token, expires_at FROM tech_shares WHERE job_id = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1').bind(j.id, now()).first();
    out.share = sh ? { token: sh.token, expiresAt: sh.expires_at } : null;
  }
  return { job: out };
}

/* ดึงเฉพาะข้อความใหม่ — หน้าแชตเรียกทุกไม่กี่วินาที จึงต้องเบาที่สุด */
async function pollJob(env, me, id, after) {
  const { j, role } = await loadJob(env, me, id);
  const messages = await messagesOf(env, id, after);
  if (role !== 'admin' && messages.length) await markRead(env, id, me.uid, messages[messages.length - 1].id);
  return { messages, status: j.status, revision: j.revision };
}

async function sendMessage(env, me, ctx, b) {
  const { j, role, isCustomer } = ctx;
  if (role === 'admin') fail(403, 'ผู้ดูแลอ่านได้อย่างเดียว');
  if (['completed', 'cancelled'].includes(j.status)) fail(409, 'ใบงานปิดแล้ว ส่งข้อความไม่ได้');
  /* กันส่งข้อความรัว/สแปม — คนคุยงานจริงไม่ถึง 300 ข้อความต่อวัน */
  await limit(env, 'msg', me.uid, 300);
  let text = str(b.message ?? b.text, 'ข้อความ', 1, 2000);
  if (!j.accepted_at) text = mask(text);
  /* งานทดสอบที่ผู้ดูแลเป็นทั้งลูกค้าและช่าง ให้เลือกได้ว่าพิมพ์ในบทไหน
     ไม่งั้นทดสอบแชตสองฝั่งด้วยบัญชีเดียวไม่ได้ */
  const as = role === 'both' ? (b.as === 'technician' ? 'technician' : 'customer')
    : isCustomer ? 'customer' : 'technician';
  const ts = now();
  const r = await env.DB.prepare('INSERT INTO tech_messages (job_id, uid, role, text, at) VALUES (?,?,?,?,?)')
    .bind(j.id, me.uid, as, text, ts).run();
  await env.DB.prepare('UPDATE tech_jobs SET updated_at = ? WHERE id = ?').bind(ts, j.id).run();
  await markRead(env, j.id, me.uid, r.meta.last_row_id);
  /* แจ้งข้อความใหม่ทาง LINE ไม่เกิน 1 ครั้ง / 30 นาที / ใบงาน — คุยกันรัว ๆ ไม่ให้ LINE เด้งทุกข้อความ */
  const to = as === 'technician' ? j.customer_uid : (ctx.t && ctx.t.uid);
  if (to && to !== me.uid) tell(env, to, async () => (await once(env, 'line-msg:' + j.id, to, 1800000))
    ? jobCard(env, 'message', j, shopOf(ctx.t), { from: as === 'technician' ? shopOf(ctx.t) : 'ลูกค้า', text }) : null);
  return { ok: true, message: { id: r.meta.last_row_id, role: as, text, at: ts } };
}

async function updateJob(env, me, id, b) {
  const ctx = await loadJob(env, me, id);
  const { j, t, isCustomer, isTech } = ctx;
  const action = String(b.action || '');
  /* ข้อความไม่ต้องเช็ก revision — สองฝ่ายพิมพ์พร้อมกันเป็นเรื่องปกติของการคุยกัน
     ถ้าบังคับ revision ข้อความจะเด้งทุกครั้งที่อีกฝ่ายเพิ่งกดอะไรไป */
  if (action === 'message') return sendMessage(env, me, ctx, b);
  if (action === 'newcode') return newStartCode(env, me, ctx);
  if (action === 'share' || action === 'unshare') return shareJob(env, me, ctx, action);
  if (action === 'extra' || action === 'extra_ok' || action === 'extra_no') return extraWork(env, ctx, action, b);

  const rule = NEXT[action];
  if (!rule) fail(400, 'ไม่รู้จักคำสั่งนี้');
  const [who_, from, to] = rule;
  const ok = who_ === 'tech' ? isTech : who_ === 'customer' ? isCustomer
    : who_ === 'either' ? (isTech || isCustomer) : me.staff;
  if (!ok) fail(403, 'คุณทำขั้นตอนนี้ในใบงานนี้ไม่ได้');
  if (!from.includes(j.status)) fail(409, 'สถานะใบงานเปลี่ยนไปแล้ว กรุณารีเฟรช');
  if (Number(b.revision) !== j.revision) fail(409, 'ใบงานเพิ่งถูกอัปเดต กรุณารีเฟรชแล้วลองอีกครั้ง');
  if (action === 'enroute' && j.mode !== 'mobile') fail(400, 'งานนี้ลูกค้านำรถไปที่อู่');
  if (action === 'done' && (parse(j.extras) || []).some(x => x.status === 'pending')) fail(409, 'มีรายการงานเพิ่มที่รอลูกค้าตอบ — รอลูกค้ากดยอมรับหรือปฏิเสธก่อน');

  const ts = now();
  const set = {};
  /* เริ่มงานได้ต่อเมื่อช่างใส่รหัสที่ลูกค้าให้ตอนพบกันจริง — ใช้ครั้งเดียว มีวันหมดอายุ ใส่ผิดได้จำกัด
     ช่วยกันการกด "เริ่มงาน" ทั้งที่ยังไม่ได้พบลูกค้า แต่ไม่ใช่หลักฐานรับประกันว่าพบกันจริง */
  let codeOk = false;
  if (action === 'start' && j.start_code) {
    if ((j.start_tries || 0) >= CODE_TRIES) fail(429, 'ใส่รหัสผิดครบ 5 ครั้งแล้ว ให้ลูกค้ากด "ขอรหัสใหม่" ในใบงาน');
    if (j.start_exp && j.start_exp < ts) fail(410, 'รหัสเริ่มงานหมดอายุแล้ว ให้ลูกค้ากด "ขอรหัสใหม่" ในใบงาน');
    if (String(b.code || '').replace(/\D/g, '') !== j.start_code) {
      await env.DB.prepare('UPDATE tech_jobs SET start_tries = start_tries + 1 WHERE id = ?').bind(j.id).run();
      const left = CODE_TRIES - (j.start_tries || 0) - 1;
      fail(400, left > 0 ? `รหัสเริ่มงานไม่ถูกต้อง ลองได้อีก ${left} ครั้ง` : 'ใส่รหัสผิดครบ 5 ครั้งแล้ว ให้ลูกค้ากด "ขอรหัสใหม่" ในใบงาน');
    }
    set.start_code = null; codeOk = true;
  }
  /* รูปก่อนเริ่ม/หลังเสร็จ (ไม่บังคับ) — เก็บกับใบงานไว้เป็นหลักฐานถ้ามีข้อพิพาท */
  const stagePhotos = action === 'start' || action === 'done' ? mediaIn(b) : [];
  let next = to;
  const by = isTech && !isCustomer ? 'technician' : isCustomer && !isTech ? 'customer'
    : who_ === 'tech' ? 'technician' : who_ === 'admin' ? 'admin' : 'customer';
  const extra = [];
  let reviewPics = [];

  if (action === 'quote') {
    const labor = num(b.labor, 'ค่าแรง', 0, 1000000), parts = num(b.parts, 'อะไหล่', 0, 1000000),
      travel = num(b.travel, 'ค่าเดินทาง', 0, 100000);
    if (labor + parts + travel <= 0) fail(400, 'ราคารวมต้องมากกว่า 0');
    set.quote = JSON.stringify({ labor, parts, travel, total: Math.round((labor + parts + travel) * 100) / 100,
      scope: str(b.scope, 'ขอบเขตงาน', 10, 2000), appointment: str(b.appointment, 'วันเวลานัด', 4, 200),
      warranty: num(b.warranty, 'รับประกัน', 0, 365), at: ts });
  }
  if (action === 'accept') {
    if (b.consent !== true) fail(400, 'ต้องยอมรับขอบเขตงานและราคาก่อน');
    set.accepted_at = ts;
    set.start_code = startCode(); set.start_exp = ts + CODE_TTL; set.start_tries = 0;
  }
  if (action === 'done') set.completion = str(b.note, 'สรุปงาน', 10, 2000);
  if (action === 'cancel') set.resolution = 'ยกเลิก: ' + str(b.note, 'เหตุผล', 5, 2000);
  if (action === 'dispute') set.dispute = str(b.note, 'รายละเอียดปัญหา', 10, 2000);
  if (action === 'resolve') {
    set.resolution = str(b.note, 'ผลการช่วยเหลือ', 10, 2000);
    next = b.outcome === 'cancelled' ? 'cancelled' : 'completed';
  }
  if (action === 'complete' && t) extra.push(env.DB.prepare('UPDATE tech_profiles SET jobs = jobs + 1 WHERE id = ?').bind(t.id));
  if (action === 'review') {
    if (j.review) fail(409, 'ให้คะแนนงานนี้ไปแล้ว');
    const rating = Math.round(num(b.rating, 'คะแนน', 1, 5));
    const text = str(b.note, 'รีวิว', 5, 2000);
    /* รูปจากลูกค้า (สูงสุด 4) — เก็บเป็นของร้านนั้น (uid ช่าง) เพื่อให้ /api/tech/img เปิดได้เฉพาะร้านที่ผ่านการตรวจ */
    const add = Array.isArray(b.photos) ? b.photos.slice(0, 4) : [];
    const pics = add.map(x => {
      const m = imgClean(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(x && x.data || x || '')));
      if (!m || m[2].length > 1400000) fail(400, 'ไฟล์ต้องเป็นรูปภาพ');
      return m;
    });
    const ids = [];
    if (pics.length && t) {
      for (const m of pics) {
        const r = await env.DB.prepare('INSERT INTO tech_docs (uid, kind, mime, data, created_at) VALUES (?,?,?,?,?)').bind(t.uid, 'review', m[1], m[2], ts).run();
        if (r.meta && r.meta.last_row_id) ids.push(r.meta.last_row_id);
      }
    }
    reviewPics = ids;
    set.review = JSON.stringify({ rating, text, photos: ids, at: ts });
    /* งานทดสอบไม่นับคะแนน — ไม่งั้นผู้ดูแลปั้นคะแนนให้ช่างทดสอบได้ */
    if (t && !j.test) extra.push(env.DB.prepare(
      'UPDATE tech_profiles SET rating_sum = rating_sum + ?, review_count = review_count + 1 WHERE id = ?').bind(rating, t.id));
  }
  const hist = parse(j.history) || [];
  if (next) { set.status = next; hist.push({ status: next, at: ts, by, ...(codeOk ? { code: true } : {}) }); }
  else hist.push({ status: action, at: ts, by });
  set.history = JSON.stringify(hist);
  set.updated_at = ts;

  const cols = Object.keys(set);
  /* WHERE revision = ? คือกุญแจกันสองคนกดพร้อมกัน — คนที่มาทีหลังจะแก้ไม่ติด */
  const r = await env.DB.prepare(
    `UPDATE tech_jobs SET ${cols.map(c => c + ' = ?').join(', ')}, revision = revision + 1 WHERE id = ? AND revision = ?`)
    .bind(...cols.map(c => set[c]), j.id, j.revision).run();
  if (!r.meta.changes) {
    /* บันทึกรีวิวไม่ติด — ลบรูปที่เพิ่งใส่ไป ไม่ให้ค้างในฐานข้อมูล */
    if (reviewPics.length) await env.DB.batch(reviewPics.map(id => env.DB.prepare("DELETE FROM tech_docs WHERE id = ? AND kind = 'review'").bind(id)));
    fail(409, 'ใบงานเพิ่งถูกอัปเดต กรุณารีเฟรชแล้วลองอีกครั้ง');
  }
  if (action === 'accept' && j.group_id) {
    extra.push(env.DB.prepare("UPDATE tech_posts SET status = 'matched', updated_at = ? WHERE id = ?").bind(ts, j.group_id));
    /* ลูกค้าเลือกร้านนี้แล้ว — ร้านอื่นในชุดเดียวกันที่ยังไม่ได้นัด ปิดให้เลย
       ช่างร้านอื่นจะเห็นว่ายกเลิกพร้อมเหตุผล ไม่ต้องรอเก้อ */
    const { results } = await env.DB.prepare(
      "SELECT id, history FROM tech_jobs WHERE group_id = ? AND id != ? AND status IN ('requested','quoted')").bind(j.group_id, j.id).all();
    for (const o of results) {
      const h = parse(o.history) || []; h.push({ status: 'cancelled', at: ts, by: 'system' });
      extra.push(env.DB.prepare("UPDATE tech_jobs SET status='cancelled', resolution=?, history=?, updated_at=?, revision=revision+1 WHERE id=?")
        .bind('ลูกค้าเลือกร้านอื่นแล้ว', JSON.stringify(h), ts, o.id));
    }
  }
  if (extra.length) await env.DB.batch(extra);
  if (stagePhotos.length) await saveMedia(env, j.id + (action === 'start' ? ':before' : ':after'), me.uid, stagePhotos);
  /* แจ้งอีกฝ่ายทาง LINE เฉพาะจังหวะที่เขาต้องรู้หรือต้องทำอะไรต่อ (เริ่มซ่อม/ทีมงานปิดเรื่อง ไม่แจ้ง) */
  const jj = { ...j, ...set }, shop = shopOf(t), techUid = t && t.uid, other = by === 'customer' ? techUid : j.customer_uid;
  const dest = { quote: j.customer_uid, accept: techUid, enroute: j.customer_uid, done: j.customer_uid,
    complete: techUid, review: techUid, cancel: other, dispute: other }[action];
  if (dest && dest !== me.uid) tell(env, dest, () => jobCard(env, action, jj, shop, {
    note: b.note, by, rating: b.rating && Math.round(Number(b.rating)), text: b.note }));
  return { ok: true };
}

/* แชร์ใบงานให้คนที่ไว้ใจ (เฉพาะลูกค้า ระหว่างที่งานยังดำเนินอยู่) — ลิงก์อายุ 24 ชม. ยกเลิกได้ทุกเมื่อ */
const SHARE_TTL = 86400000, SHARE_OPEN = ['accepted', 'enroute', 'working', 'done'];
async function shareJob(env, me, ctx, action) {
  const { j, isCustomer } = ctx;
  if (!isCustomer) fail(403, 'เฉพาะลูกค้าที่แชร์ใบงานได้');
  if (action === 'unshare') {
    await env.DB.prepare('UPDATE tech_shares SET revoked = 1 WHERE job_id = ? AND revoked = 0').bind(j.id).run();
    return { ok: true };
  }
  if (!SHARE_OPEN.includes(j.status)) fail(409, 'แชร์ได้ตั้งแต่ยืนยันราคาจนงานเสร็จ');
  await limit(env, 'share', me.uid, 20);
  const raw = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const ts = now();
  await env.DB.batch([
    /* ลิงก์ใหม่แทนลิงก์เก่าของใบเดียวกัน — มีลิงก์ใช้งานได้ทีละอันเท่านั้น */
    env.DB.prepare('UPDATE tech_shares SET revoked = 1 WHERE job_id = ? AND revoked = 0').bind(j.id),
    env.DB.prepare('INSERT INTO tech_shares (token, job_id, uid, created_at, expires_at) VALUES (?,?,?,?,?)').bind(token, j.id, me.uid, ts, ts + SHARE_TTL),
  ]);
  return { ok: true, token, expiresAt: ts + SHARE_TTL };
}
/* หน้าที่คนที่ไว้ใจเปิดดู (ไม่ต้องล็อกอิน): ใครมา รถอะไร นัดเมื่อไร สถานะตอนนี้ — ไม่มีที่อยู่ เบอร์ หรือข้อมูลลูกค้า */
async function shareView(env, token) {
  const s0 = await env.DB.prepare('SELECT * FROM tech_shares WHERE token = ?').bind(token).first();
  if (!s0 || s0.revoked || s0.expires_at < now()) fail(404, 'ลิงก์นี้หมดอายุหรือถูกยกเลิกแล้ว');
  const j = await env.DB.prepare('SELECT * FROM tech_jobs WHERE id = ?').bind(s0.job_id).first();
  if (!j) fail(404, 'ลิงก์นี้หมดอายุหรือถูกยกเลิกแล้ว');
  const t = await techById(env, j.tech_id), d = parse(t && t.data) || {}, q = parse(j.quote) || {}, h = parse(j.history) || [];
  return { trip: { status: j.status, updatedAt: (h[h.length - 1] || {}).at || j.updated_at, car: j.car, area: j.area, mode: j.mode,
    appointment: q.appointment || j.requested_time, expiresAt: s0.expires_at,
    tech: { name: d.shop || d.name || 'ช่าง', avatar: d.avatar || null, verified: !!(t && t.verified),
      vetting: d.vetting && t && t.verified ? { identity: !!d.vetting.identity, cats: d.vetting.cats || [] } : null } } };
}

const CODE_TTL = 7 * 86400000, CODE_TRIES = 5;
const startCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
/* ลูกค้าขอรหัสเริ่มงานใหม่ (หมดอายุ / ใส่ผิดครบ / อยากเปลี่ยน) */
async function newStartCode(env, me, ctx) {
  const { j, isCustomer } = ctx;
  if (!isCustomer) fail(403, 'เฉพาะลูกค้าที่ขอรหัสเริ่มงานใหม่ได้');
  if (!['accepted', 'enroute'].includes(j.status)) fail(409, 'ขอรหัสได้หลังยืนยันราคาแล้ว และก่อนเริ่มงาน');
  await limit(env, 'startcode', me.uid, 20);
  const code = startCode();
  await env.DB.prepare('UPDATE tech_jobs SET start_code = ?, start_exp = ?, start_tries = 0 WHERE id = ?').bind(code, now() + CODE_TTL, j.id).run();
  return { ok: true, startCode: code };
}
/* งานเพิ่มระหว่างทำ: ช่างเสนอ → ลูกค้ากดยอมรับ/ปฏิเสธ · ราคาที่ยืนยันแล้วแก้ย้อนหลังไม่ได้ */
async function extraWork(env, ctx, action, b) {
  const { j, isCustomer, isTech } = ctx;
  if (!['accepted', 'enroute', 'working'].includes(j.status)) fail(409, 'เสนองานเพิ่มได้หลังยืนยันราคา และก่อนแจ้งซ่อมเสร็จ');
  if (Number(b.revision) !== j.revision) fail(409, 'ใบงานเพิ่งถูกอัปเดต กรุณารีเฟรชแล้วลองอีกครั้ง');
  const list = parse(j.extras) || [], hist = parse(j.history) || [], ts = now();
  if (action === 'extra') {
    if (!isTech) fail(403, 'เฉพาะช่างที่เสนองานเพิ่มได้');
    if (list.some(x => x.status === 'pending')) fail(409, 'มีรายการงานเพิ่มที่รอลูกค้าตอบอยู่แล้ว');
    if (list.length >= 10) fail(400, 'เสนองานเพิ่มได้ไม่เกิน 10 รายการต่อใบงาน');
    const labor = num(b.labor, 'ค่าแรง', 0, 1000000), parts = num(b.parts, 'อะไหล่', 0, 1000000);
    if (labor + parts <= 0) fail(400, 'ราคางานเพิ่มต้องมากกว่า 0');
    list.push({ id: crypto.randomUUID().slice(0, 8), desc: str(b.desc, 'รายละเอียดงานเพิ่ม', 5, 500), labor, parts,
      total: Math.round((labor + parts) * 100) / 100, status: 'pending', at: ts });
    hist.push({ status: 'extra', at: ts, by: 'technician' });
  } else {
    if (!isCustomer) fail(403, 'เฉพาะลูกค้าที่ตอบรายการงานเพิ่มได้');
    const x = list.find(e => e.id === String(b.extraId || '') && e.status === 'pending');
    if (!x) fail(404, 'ไม่พบรายการงานเพิ่มที่รอตอบ');
    x.status = action === 'extra_ok' ? 'accepted' : 'declined'; x.decidedAt = ts;
    hist.push({ status: action, at: ts, by: 'customer' });
  }
  const r = await env.DB.prepare('UPDATE tech_jobs SET extras = ?, history = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
    .bind(JSON.stringify(list), JSON.stringify(hist), ts, j.id, j.revision).run();
  if (!r.meta.changes) fail(409, 'ใบงานเพิ่งถูกอัปเดต กรุณารีเฟรชแล้วลองอีกครั้ง');
  /* ขอทำงานเพิ่ม → ลูกค้าต้องตอบ · ลูกค้าตอบแล้ว → ช่างรู้ทันที */
  const x = action === 'extra' ? list[list.length - 1] : list.find(e => e.id === String(b.extraId || ''));
  const to = action === 'extra' ? j.customer_uid : (ctx.t && ctx.t.uid);
  tell(env, to, () => jobCard(env, action, j, shopOf(ctx.t), x || {}));
  return { ok: true };
}

/* เทียบราคาหลายร้านในชุดเดียว — เจ้าของคำขอเท่านั้น */
async function groupOf(env, me, gid) {
  const { results } = await env.DB.prepare('SELECT * FROM tech_jobs WHERE group_id = ? AND customer_uid = ? ORDER BY created_at').bind(gid, me.uid).all();
  if (!results.length) fail(404, 'ไม่พบคำขอ');
  const techs = {};
  for (const j of results) if (!techs[j.tech_id]) techs[j.tech_id] = await techById(env, j.tech_id);
  return { jobs: results.map(j => { const t = techs[j.tech_id]; const pt = t ? publicTech(t) : {};
    return { id: j.id, status: j.status, techId: j.tech_id, techName: pt.shop || pt.name || 'ช่าง', rating: pt.rating || 0,
      reviewCount: pt.reviewCount || 0, quote: parse(j.quote), resolution: j.resolution }; }) };
}

/* ══════════════════════════════════════════════════════════════════
   ประกาศหาช่าง — ลูกค้าไม่ต้องเลือกร้าน ช่างรอบตัวเห็นหมุดบนแผนที่แล้วเสนอราคาแข่งกัน
   ข้อเสนอของช่างแต่ละคน = ใบงานหนึ่งใบที่มีราคาแล้ว (status quoted) group_id = รหัสประกาศ
   จึงใช้หน้าเทียบราคา การยืนยัน แชต และการยกเลิกร้านอื่นอัตโนมัติชุดเดิมได้ทั้งหมด
   ตำแหน่งจริงโชว์ให้ช่างเห็นตามที่เจ้าของแอปเลือก (งานรถเสียต้องไปให้ถูกที่)
   แต่เบอร์โทรยังเปิดหลังลูกค้ายืนยันราคาเท่านั้น
   ══════════════════════════════════════════════════════════════════ */
const POST_TTL = 48 * 3600 * 1000;
function km(a, b, c, d) {
  const R = 6371, r = Math.PI / 180, dLa = (c - a) * r, dLo = (d - b) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLo / 2) ** 2;
  return Math.round(R * 2 * Math.asin(Math.sqrt(h)) * 10) / 10;
}
/* รหัสใบงานของข้อเสนอ — คงที่ต่อ (ประกาศ, ช่าง) กดเสนอซ้ำจึงเป็นการแก้ราคา ไม่ใช่ใบใหม่ */
async function offerId(postId, techId) {
  const h = await sha(postId + ':' + techId);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
/* ตำแหน่งโดยประมาณสำหรับช่างที่ลูกค้ายังไม่ได้เลือก — จุดจริงมักเป็นบ้านลูกค้า
   ปัดเข้ากึ่งกลางช่องตาราง ~2 กม. (คงที่ ไม่สุ่ม — ถ้าสุ่มใหม่ทุกครั้ง เปิดดูหลายรอบแล้วเฉลี่ยจะได้จุดจริง)
   จุดจริงอยู่ในที่อยู่ของใบงาน ซึ่งช่างเห็นหลังลูกค้ายืนยันราคาแล้วเท่านั้น */
const APPROX = 0.02, APPROX_KM = 1.6;
const approx = v => Math.round((Math.floor(v / APPROX) + 0.5) * APPROX * 1e4) / 1e4;
/* exact = เจ้าของประกาศ/ทีมงาน · ช่างได้แค่พื้นที่โดยประมาณ */
function postOut(p, extra, exact = false) {
  const loc = exact ? { lat: p.lat, lng: p.lng } : { lat: approx(p.lat), lng: approx(p.lng), approxKm: APPROX_KM };
  return { id: p.id, status: p.status, test: !!p.test, car: p.car, symptom: p.symptom, cat: p.cat,
    ...loc, area: p.area, requestedTime: p.requested_time, mode: p.mode, urgent: !!p.urgent,
    note: p.note || '', createdAt: p.created_at, expiresAt: p.created_at + POST_TTL, ...(extra || {}) };
}
/* ระยะทางให้ช่างดู: ปัดขึ้นเป็นกิโลเมตรเต็ม กันการเอาระยะจากหลายจุดมาคำนวณย้อนหาบ้านลูกค้า */
const roughKm = d => Math.max(1, Math.ceil(d));

async function createPost(env, me, b) {
  const id = String(b.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) fail(400, 'รหัสคำขอไม่ถูกต้อง');
  const dup = await env.DB.prepare('SELECT customer_uid FROM tech_posts WHERE id = ?').bind(id).first();
  if (dup) { if (dup.customer_uid !== me.uid) fail(409, 'รหัสคำขอซ้ำ'); return { id }; }
  const c = coord(b);
  const cat = CATS.includes(b.cat) ? b.cat : '';
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM tech_posts WHERE customer_uid = ? AND status = 'open' AND created_at > ?")
    .bind(me.uid, now() - POST_TTL).first();
  if (open.n >= 3 && !me.staff) fail(429, 'มีประกาศที่เปิดอยู่ 3 รายการแล้ว ปิดอันเก่าก่อน');
  const ts = now();
  const photos = mediaIn(b);
  /* ประกาศของทีมงานเป็นงานทดสอบ — ช่างจริงไม่เห็น เห็นเฉพาะช่างทีมงาน */
  await env.DB.prepare(`INSERT INTO tech_posts (id,customer_uid,status,test,car,symptom,cat,lat,lng,area,address,phone,requested_time,mode,urgent,created_at,updated_at,note)
    VALUES (?,?,'open',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, me.uid, me.staff ? 1 : 0,
    str(b.car, 'รถ / รุ่น / ปี', 2, 200), str(b.symptom, 'อาการ', 10, 2000), cat, c.lat, c.lng,
    str(b.area, 'พื้นที่', 3, 160), str(b.address, 'ที่อยู่', 4, 500), phone(b.phone, 'เบอร์โทร'),
    str(b.requestedTime, 'วันและเวลา', 2, 160), b.mode === 'shop' ? 'shop' : 'mobile', b.urgent ? 1 : 0, ts, ts, noteIn(b)).run();
  await saveMedia(env, id, me.uid, photos);
  return { id };
}

/* รายละเอียดประกาศพร้อมรูป — เจ้าของประกาศ หรือช่างที่มองเห็นประกาศนี้ได้ */
async function postDetail(env, me, id) {
  const p = await env.DB.prepare('SELECT * FROM tech_posts WHERE id = ?').bind(id).first();
  if (!p) fail(404, 'ไม่พบประกาศ');
  /* ทีมงานเปิดดูประกาศได้ทุกอัน เพื่อตรวจความเรียบร้อย */
  if (p.customer_uid !== me.uid && !me.staff) {
    const t = await env.DB.prepare('SELECT test, suspended FROM tech_profiles WHERE uid = ?').bind(me.uid).first();
    if (!t || t.suspended || (p.test && !t.test)) fail(404, 'ไม่พบประกาศ');
  }
  return { post: postOut(p, { photos: await mediaOf(env, [p.id]) }, p.customer_uid === me.uid || me.staff) };
}

async function myPosts(env, me) {
  const { results } = await env.DB.prepare('SELECT * FROM tech_posts WHERE customer_uid = ? ORDER BY created_at DESC LIMIT 30').bind(me.uid).all();
  const out = [];
  for (const p of results) {
    const o = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(CASE WHEN quote IS NOT NULL THEN json_extract(quote,'$.total') END) AS lo FROM tech_jobs WHERE group_id = ? AND status != 'cancelled'").bind(p.id).first();
    const expired = p.status === 'open' && p.created_at + POST_TTL < now();
    out.push(postOut({ ...p, status: expired ? 'expired' : p.status }, { offers: o.n, lowest: o.lo, address: p.address }, true));
  }
  return { posts: out };
}

/* งานรอบตัวช่าง — เฉพาะประกาศที่ยังเปิด ไม่หมดอายุ อยู่ในรัศมีรับงาน และหมวดตรง (หรือไม่ระบุหมวด) */
async function nearPosts(env, me) {
  const t = await env.DB.prepare('SELECT * FROM tech_profiles WHERE uid = ?').bind(me.uid).first();
  if (!t || t.suspended) fail(403, 'ต้องเป็นช่างในระบบก่อน');
  const d = parse(t.data) || {};
  if (d.lat == null) fail(400, 'ตั้งตำแหน่งร้านก่อน');
  const radius = Math.max(Number(d.radius) || 0, 30);
  const { results } = await env.DB.prepare(
    `SELECT * FROM tech_posts WHERE status = 'open' AND created_at > ? AND customer_uid != ? AND (test = 0 OR ? = 1) ORDER BY created_at DESC LIMIT 300`)
    .bind(now() - POST_TTL, me.uid, t.test ? 1 : 0).all();
  const mine = {};
  if (results.length) {
    const ids = await Promise.all(results.map(p => offerId(p.id, t.id)));
    const js = await inAll(env, 'SELECT id, group_id, status, quote FROM tech_jobs WHERE id IN ({IN})', ids);
    js.forEach(j => { mine[j.group_id] = { status: j.status, total: (parse(j.quote) || {}).total }; });
  }
  const pc = {};
  if (results.length) {
    const mc = await inAll(env, 'SELECT owner, COUNT(*) AS n FROM tech_media WHERE owner IN ({IN}) GROUP BY owner', results.map(p => p.id));
    mc.forEach(r => { pc[r.owner] = r.n; });
  }
  const posts = results.map(p => ({ p, dist: km(d.lat, d.lng, p.lat, p.lng) }))
    .filter(x => x.dist <= radius && (!x.p.cat || (d.cats || []).includes(x.p.cat) || t.test))
    .sort((a, b) => (b.p.urgent - a.p.urgent) || a.dist - b.dist)
    .map(x => postOut(x.p, { dist: roughKm(x.dist), mine: mine[x.p.id] || null, photos: pc[x.p.id] || 0 }));
  return { posts, radius, center: { lat: d.lat, lng: d.lng } };
}

async function offer(env, me, postId, b) {
  const p = await env.DB.prepare('SELECT * FROM tech_posts WHERE id = ?').bind(postId).first();
  if (!p) fail(404, 'ไม่พบประกาศ');
  if (p.status !== 'open' || p.created_at + POST_TTL < now()) fail(409, 'ประกาศนี้ปิดแล้ว');
  const t = await env.DB.prepare('SELECT * FROM tech_profiles WHERE uid = ?').bind(me.uid).first();
  if (!t || t.suspended) fail(403, 'ต้องเป็นช่างในระบบก่อน');
  if (p.test && !t.test) fail(404, 'ไม่พบประกาศ');
  if (p.customer_uid === me.uid) fail(400, 'เสนอราคาให้ประกาศของตัวเองไม่ได้');
  const labor = num(b.labor, 'ค่าแรง', 0, 1000000), parts = num(b.parts, 'อะไหล่', 0, 1000000), travel = num(b.travel, 'ค่าเดินทาง', 0, 100000);
  if (labor + parts + travel <= 0) fail(400, 'ราคารวมต้องมากกว่า 0');
  const ts = now();
  const quote = JSON.stringify({ labor, parts, travel, total: Math.round((labor + parts + travel) * 100) / 100,
    scope: str(b.scope, 'ขอบเขตงาน', 10, 2000), appointment: str(b.appointment, 'วันเวลานัด', 4, 200),
    warranty: num(b.warranty, 'รับประกัน', 0, 365), at: ts });
  const id = await offerId(p.id, t.id);
  const ex = await env.DB.prepare('SELECT status, history FROM tech_jobs WHERE id = ?').bind(id).first();
  if (ex) {
    if (!['requested', 'quoted'].includes(ex.status)) fail(409, 'ข้อเสนอนี้ถูกตอบรับหรือปิดไปแล้ว');
    const h = parse(ex.history) || []; h.push({ status: 'quoted', at: ts, by: 'technician' });
    await env.DB.prepare("UPDATE tech_jobs SET quote=?, status='quoted', history=?, updated_at=?, revision=revision+1 WHERE id=?").bind(quote, JSON.stringify(h), ts, id).run();
    return { id, updated: true };
  }
  const d = parse(t.data) || {};
  await env.DB.prepare(`INSERT INTO tech_jobs (id,tech_id,customer_uid,status,test,car,symptom,area,address,phone,requested_time,mode,quote,history,revision,created_at,updated_at,group_id,note)
    VALUES (?,?,?,'quoted',?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`).bind(id, t.id, p.customer_uid, p.test || t.test ? 1 : 0,
    p.car, p.symptom, p.area, p.address + ` · แผนที่ https://maps.google.com/?q=${p.lat},${p.lng}`, p.phone, p.requested_time,
    p.mode === 'mobile' && d.mobile ? 'mobile' : 'shop', quote,
    JSON.stringify([{ status: 'requested', at: p.created_at, by: 'customer' }, { status: 'quoted', at: ts, by: 'technician' }]), ts, ts, p.id, p.note || '').run();
  await env.DB.prepare('UPDATE tech_posts SET updated_at = ? WHERE id = ?').bind(ts, p.id).run();
  return { id };
}

async function closePost(env, me, postId) {
  const p = await env.DB.prepare('SELECT customer_uid, status FROM tech_posts WHERE id = ?').bind(postId).first();
  if (!p || p.customer_uid !== me.uid) fail(404, 'ไม่พบประกาศ');
  const ts = now();
  const { results } = await env.DB.prepare("SELECT id, history FROM tech_jobs WHERE group_id = ? AND status IN ('requested','quoted')").bind(postId).all();
  await env.DB.batch([
    env.DB.prepare("UPDATE tech_posts SET status = 'closed', updated_at = ? WHERE id = ?").bind(ts, postId),
    ...results.map(o => { const h = parse(o.history) || []; h.push({ status: 'cancelled', at: ts, by: 'customer' });
      return env.DB.prepare("UPDATE tech_jobs SET status='cancelled', resolution=?, history=?, updated_at=?, revision=revision+1 WHERE id=?")
        .bind('ลูกค้าปิดประกาศแล้ว', JSON.stringify(h), ts, o.id); }),
  ]);
  return { ok: true };
}

/* ══ ร้านของช่าง: ออนไลน์ แก้ข้อมูล สถิติ ══ */
async function myShop(env, me) {
  const t = await env.DB.prepare('SELECT * FROM tech_profiles WHERE uid = ?').bind(me.uid).first();
  if (!t) fail(403, 'ต้องเป็นช่างในระบบก่อน');
  return t;
}
async function setOnline(env, me, b) {
  const t = await myShop(env, me);
  await env.DB.prepare('UPDATE tech_profiles SET online = ?, last_seen = ? WHERE id = ?').bind(b.online ? 1 : 0, now(), t.id).run();
  return { ok: true, online: !!b.online };
}
async function editShop(env, me, b) {
  const t = await myShop(env, me);
  const d = parse(t.data) || {};
  if(!t.test){
    const changed=['about','cats','lat','lng'].some(k=>b[k]!=null&&JSON.stringify(k==='cats'&&Array.isArray(b[k])?[...b[k]].sort():b[k])!==JSON.stringify(k==='cats'&&Array.isArray(d[k])?[...d[k]].sort():d[k]));
    if(changed||b.addPhotos?.length||b.removePhotos?.length)fail(409,'ข้อมูลทักษะ ตำแหน่ง และรูปที่รับรองแล้ว ต้องให้ทีมงานตรวจใหม่ก่อนเปลี่ยน ติดต่อทีมงาน');
  }
  if (b.shop != null) d.shop = String(b.shop).trim().slice(0, 120);
  if (b.about != null) d.about = String(b.about).trim().slice(0, 1000);
  if (b.from != null) d.from = num(b.from, 'ราคาเริ่มต้น', 0, 1000000);
  if (b.warranty != null) d.warranty = num(b.warranty, 'รับประกัน', t.test?0:7, 365);
  if (b.radius != null) d.radius = num(b.radius, 'รัศมีบริการ', 0, 200);
  if (b.hours != null) d.hours = String(b.hours).trim().slice(0, 120);
  if (Array.isArray(b.cats)) { const c = [...new Set(b.cats.filter(x => CATS.includes(x)))]; if (!c.length) fail(400, 'เลือกงานที่รับอย่างน้อย 1 อย่าง'); d.cats = c; }
  if (b.mobile != null) d.mobile = !!b.mobile;
  if (b.urgent != null) d.urgent = !!b.urgent;
  if (b.lat != null || b.lng != null) Object.assign(d, coord(b));
  /* ตั้งรูปที่มีอยู่เป็นปก หรืออัปโหลดรูปปกใหม่ (นับรวมโควตา 12 รูป) */
  if (b.cover != null) {
    const id = Number(b.cover) || 0;
    if (id && !(await env.DB.prepare("SELECT 1 FROM tech_docs WHERE id = ? AND uid = ? AND kind IN ('shop','work')").bind(id, me.uid).first())) fail(400, 'ไม่พบรูปนี้ในร้าน');
    d.cover = id || null;
  }
  if (b.phone != null) d.phone = String(b.phone).replace(/[^0-9+]/g, '').slice(0, 15);
  if (b.showPhone != null) d.showPhone = !!b.showPhone;
  const strs = (v, n, len) => (Array.isArray(v) ? v : []).map(x => String(x).trim().slice(0, len)).filter(Boolean).slice(0, n);
  if (b.subs != null) d.subs = strs(b.subs, 40, 24);
  if (b.brands2 != null) d.brands2 = strs(b.brands2, 30, 30);
  if (b.line != null) d.line = String(b.line).trim().slice(0, 60);
  if (b.facebook != null) d.facebook = String(b.facebook).trim().slice(0, 200);
  if (b.address != null) d.address = String(b.address).trim().slice(0, 300);
  /* Studio → ตั้งค่า */
  if (b.vacation != null) {
    const v = b.vacation || {};
    d.vacation = { on: !!v.on, until: Number(v.until) > 0 ? Number(v.until) : null, note: String(v.note || '').trim().slice(0, 200) };
  }
  if (b.autoReply != null) { const a = b.autoReply || {}; d.autoReply = { on: !!a.on, text: String(a.text || '').trim().slice(0, 500) }; }
  if (b.greet != null) d.greet = String(b.greet).trim().slice(0, 200);
  if (b.minPrice != null) d.minPrice = num(b.minPrice, 'ราคางานต่ำสุด', 0, 1000000);
  if (b.theme != null) d.theme = THEMES.includes(b.theme) ? b.theme : '';
  /* เวลาทำการรายวัน: 7 ช่อง [จ..อา] แต่ละช่อง {on, open:"08:00", close:"18:00"} */
  if (b.week != null) {
    const w = Array.isArray(b.week) ? b.week.slice(0, 7) : [];
    const hm = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : null;
    d.week = w.length === 7 ? w.map(x => ({ on: !!(x && x.on), open: hm(x && x.open) || '08:00', close: hm(x && x.close) || '18:00' })) : null;
  }
  if (b.addAvatar) {
    const m = imgClean(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.addAvatar.data || '')));
    if (!m || m[2].length > 600000) fail(400, 'ไฟล์ต้องเป็นรูปภาพ');
    const r = await env.DB.prepare('INSERT INTO tech_docs (uid, kind, mime, data, created_at) VALUES (?,?,?,?,?)').bind(me.uid, 'shop', m[1], m[2], now()).run();
    if (d.avatar) await env.DB.prepare("DELETE FROM tech_docs WHERE id = ? AND uid = ? AND kind = 'shop'").bind(d.avatar, me.uid).run();
    d.avatar = r.meta && r.meta.last_row_id || null;
  }
  if (b.addCover) {
    const m = imgClean(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.addCover.data || '')));
    if (!m || m[2].length > 1400000) fail(400, 'ไฟล์ต้องเป็นรูปภาพ');
    const have = await env.DB.prepare("SELECT COUNT(*) AS n FROM tech_docs WHERE uid = ? AND kind IN ('shop','work')").bind(me.uid).first();
    if (have.n >= 1000) fail(400, 'รูปร้านเยอะเกินไป');
    const r = await env.DB.prepare('INSERT INTO tech_docs (uid, kind, mime, data, created_at) VALUES (?,?,?,?,?)').bind(me.uid, 'shop', m[1], m[2], now()).run();
    d.cover = r.meta && r.meta.last_row_id || null;
  }
  const stmts = [env.DB.prepare('UPDATE tech_profiles SET data = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(d), now(), t.id)];
  /* รูปใหม่ต่อท้าย รูปที่ลบคือรหัสรูปของร้านนี้เท่านั้น — ลบรูปร้านอื่นผ่านทางนี้ไม่ได้ */
  if (Array.isArray(b.removePhotos)) b.removePhotos.slice(0, 20).forEach(id =>
    stmts.push(env.DB.prepare("DELETE FROM tech_docs WHERE id = ? AND uid = ? AND kind IN ('shop','work')").bind(Number(id), me.uid)));
  if (Array.isArray(b.addPhotos)) {
    const have = await env.DB.prepare("SELECT COUNT(*) AS n FROM tech_docs WHERE uid = ? AND kind IN ('shop','work')").bind(me.uid).first();
    if (have.n + b.addPhotos.length > 1000) fail(400, 'รูปร้านเยอะเกินไป');
    b.addPhotos.forEach(x => {
      const m = imgClean(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(x && x.data || '')));
      if (!m || m[2].length > 1400000) fail(400, 'ไฟล์ต้องเป็นรูปภาพ');
      stmts.push(env.DB.prepare('INSERT INTO tech_docs (uid, kind, mime, data, created_at) VALUES (?,?,?,?,?)')
        .bind(me.uid, x.kind === 'shop' ? 'shop' : 'work', m[1], m[2], now()));
    });
  }
  await env.DB.batch(stmts);
  return { ok: true };
}

/* ═══ โพสต์บริการของช่าง ═══
   ร้านละไม่เกิน 2 รายการ — ให้หน้าแรกเป็นที่หาช่าง ไม่ใช่ฟีดโซเชียล
   (โพสต์ "ผลงาน" แบบเก่าเลิกใช้แล้ว ความน่าเชื่อถือมาจากรีวิวลูกค้าแทน) */
const GIG_MAX = 2;
function gigOut(g, t) {
  return { id: g.id, kind: g.kind, title: g.title, body: g.body || '', price: g.price || 0, cats: parse(g.cats) || [],
    brands: parse(g.brands) || [], photos: parse(g.photos) || [], createdAt: g.created_at, tech: t ? publicTech(t) : null };
}
async function listGigs(env, me, url) {
  const mine = url.searchParams.get('mine') === '1';
  let rows;
  if (mine) {
    if (!me) fail(401, 'ต้องเข้าสู่ระบบ');
    rows = (await env.DB.prepare("SELECT * FROM tech_gigs WHERE uid = ? AND active = 1 AND kind = 'package' ORDER BY created_at DESC LIMIT 100").bind(me.uid).all()).results;
  } else {
    rows = (await env.DB.prepare("SELECT * FROM tech_gigs WHERE active = 1 AND kind = 'package' ORDER BY created_at DESC LIMIT 600").all()).results;
    /* ร้านที่โพสต์ไว้ก่อนมีเพดาน — ลูกค้าเห็นแค่ 2 รายการล่าสุดของแต่ละร้าน */
    const per = {};
    rows = rows.filter(r => (per[r.tech_id] = (per[r.tech_id] || 0) + 1) <= GIG_MAX).slice(0, 300);
  }
  if (!rows.length) return { gigs: [] };
  const ids = [...new Set(rows.map(r => r.tech_id))];
  const techs = await inAll(env, 'SELECT * FROM tech_profiles WHERE id IN ({IN}) AND suspended = 0', ids);
  const by = Object.fromEntries((await withPhotos(env, techs)).map(t => [t.id, t]));
  const ok = t => t && (t.verified || (t.test && me && me.staff) || (mine && t.uid === me.uid));
  return { gigs: rows.filter(r => ok(by[r.tech_id])).map(r => gigOut(r, by[r.tech_id])) };
}
/* หมวดบริการ (ชุดเดียวกับแถวหมวดหน้าแรก) → หมวดหลักที่ทีมงานตรวจทักษะ */
const GIG_BASE = { air: 'air', 'air-clean': 'air', eng: 'eng', oil: 'eng', service: 'eng', gear: 'eng', cool: 'eng', exhaust: 'eng',
  tyre: 'tyre', brake: 'tyre', susp: 'tyre', align: 'tyre', ev: 'ev', battery: 'ev', audio: 'ev',
  body: 'body', detail: 'body', glass: 'body', wash: 'body', mobile: 'mobile', tow: 'mobile' };
async function saveGig(env, me, b) {
  const t = await myShop(env, me);
  const kind = 'package';
  const title = String(b.title || '').trim().slice(0, 100);
  if (title.length < 3) fail(400, 'ใส่หัวข้อโพสต์อย่างน้อย 3 ตัวอักษร');
  const body = String(b.body || '').trim().slice(0, 2000);
  const price = num(b.price, 'ราคา', 1, 1000000);
  /* ทุกบริการต้องอยู่ในหมวด — หน้าแรกแบ่งบริการตามหมวด ลูกค้าหาเจอจากหมวดนั้น */
  const catList = (Array.isArray(b.cats) ? b.cats : []).map(x => String(x).slice(0, 24)).filter(Boolean).slice(0, 6);
  if (!catList.length) fail(400, 'เลือกหมวดหมู่บริการก่อน');
  /* ช่างลงบริการได้เฉพาะหมวดที่ผ่านการตรวจทักษะ — ผ่านงานแอร์ ไม่ได้แปลว่าผ่านงานเบรกหรือ EV */
  const sd = parse(t.data) || {};
  for (const c of catList) {
    const base = GIG_BASE[c];
    if (!base) fail(400, 'หมวดหมู่บริการไม่ถูกต้อง');
    if (!t.test && (base === 'mobile' ? !sd.mobile : !(sd.cats || []).includes(base))) fail(403, 'ลงบริการได้เฉพาะหมวดที่ผ่านการตรวจทักษะแล้ว — ถ้าต้องการรับหมวดนี้ ติดต่อทีมงานเพื่อตรวจเพิ่ม');
  }
  const cats = JSON.stringify(catList);
  const brands = JSON.stringify((Array.isArray(b.brands) ? b.brands : []).map(x => String(x).slice(0, 30)).slice(0, 10));
  let photos = (Array.isArray(b.keep) ? b.keep.map(Number).filter(Boolean) : []);
  /* รูปไม่จำกัดต่อโพสต์ — แอปส่งมาเป็นชุดละไม่กี่รูป (คำขอเดียวไม่ใหญ่เกิน) เพดานกันพังไว้ 300 */
  const add = Array.isArray(b.addPhotos) ? b.addPhotos.slice(0, 6) : [];
  if (photos.length + add.length > 300) fail(400, 'รูปในโพสต์เดียวเยอะเกินไป');
  if (!b.id) {
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM tech_gigs WHERE uid = ? AND active = 1 AND kind = 'package'").bind(me.uid).first();
    if (c.n >= GIG_MAX) fail(400, `โพสต์บริการได้สูงสุด ${GIG_MAX} รายการ ลบหรือแก้รายการเดิมแทน`);
  }
  for (const x of add) {
    const m = imgClean(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(x && x.data || '')));
    if (!m || m[2].length > 1400000) fail(400, 'ไฟล์ต้องเป็นรูปภาพ');
    const r = await env.DB.prepare('INSERT INTO tech_docs (uid, kind, mime, data, created_at) VALUES (?,?,?,?,?)').bind(me.uid, 'gig', m[1], m[2], now()).run();
    photos.push(r.meta && r.meta.last_row_id);
  }
  photos = JSON.stringify(photos.filter(Boolean));
  if (b.id) {
    const g = await env.DB.prepare('SELECT uid, active FROM tech_gigs WHERE id = ?').bind(+b.id).first();
    if (!g || g.uid !== me.uid || !g.active) fail(404, 'ไม่พบโพสต์');
    await env.DB.prepare('UPDATE tech_gigs SET kind=?,title=?,body=?,price=?,cats=?,brands=?,photos=?,updated_at=? WHERE id=?')
      .bind(kind, title, body, price, cats, brands, photos, now(), +b.id).run();
    return { ok: true, id: +b.id };
  }
  const r = await env.DB.prepare('INSERT INTO tech_gigs (uid,tech_id,kind,title,body,price,cats,brands,photos,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)')
    .bind(me.uid, t.id, kind, title, body, price, cats, brands, photos, now(), now()).run();
  return { ok: true, id: r.meta && r.meta.last_row_id };
}
async function delGig(env, me, b) {
  const g = await env.DB.prepare('SELECT uid FROM tech_gigs WHERE id = ?').bind(+b.id).first();
  if (!g || (g.uid !== me.uid && !me.staff)) fail(404, 'ไม่พบโพสต์');
  await env.DB.prepare('UPDATE tech_gigs SET active = 0, updated_at = ? WHERE id = ?').bind(now(), +b.id).run();
  return { ok: true };
}

/* รีวิวลูกค้าของร้าน (หน้าร้านสาธารณะ) — ไม่บอกชื่อ/ทะเบียนลูกค้า มีแค่คะแนน ข้อความ รูป และวันที่ */
async function listReviews(env, me, url) {
  const id = String(url.searchParams.get('id') || '');
  const t = id && await techById(env, id);
  if (!t || t.suspended || !(t.verified || (t.test && me && me.staff))) fail(404, 'ไม่พบร้าน');
  const { results } = await env.DB.prepare(
    'SELECT review, test FROM tech_jobs WHERE tech_id = ? AND review IS NOT NULL ORDER BY updated_at DESC LIMIT 200').bind(t.id).all();
  const reviews = results.filter(j => !j.test || (me && me.staff)).map(j => parse(j.review)).filter(Boolean)
    .map(r => ({ rating: r.rating, text: r.text || '', photos: r.photos || [], at: r.at }))
    .sort((a, b) => b.at - a.at);
  return { reviews };
}

async function stats(env, me) {
  const t = await myShop(env, me);
  const { results } = await env.DB.prepare('SELECT status, quote, history, created_at, updated_at, review FROM tech_jobs WHERE tech_id = ?').bind(t.id).all();
  const day = 86400000, ts = now();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const month = new Date(start.getFullYear(), start.getMonth(), 1).getTime();
  let earnToday = 0, earnMonth = 0, done = 0, quoted = 0, requested = results.length, won = 0, respSum = 0, respN = 0;
  const daily = Array.from({ length: 14 }, (_, i) => ({ d: today - (13 - i) * day, v: 0 }));
  const reviews = [];
  for (const j of results) {
    const q = parse(j.quote), h = parse(j.history) || [];
    const fq = h.find(x => x.status === 'quoted');
    if (fq) { quoted++; respSum += fq.at - j.created_at; respN++; }
    if (['accepted', 'enroute', 'working', 'done', 'completed'].includes(j.status)) won++;
    if (j.status === 'completed' && q) {
      done++;
      const at = (h.find(x => x.status === 'completed') || {}).at || j.updated_at;
      if (at >= today) earnToday += q.total;
      if (at >= month) earnMonth += q.total;
      const slot = daily.find(x => at >= x.d && at < x.d + day); if (slot) slot.v += q.total;
    }
    const rv = parse(j.review); if (rv) reviews.push(rv);
  }
  reviews.sort((a, b) => b.at - a.at);
  const pt = publicTech(t);
  /* ── Studio → สถิติ: 30 วัน, เดือนนี้เทียบเดือนก่อน, funnel ── */
  const d30 = Array.from({ length: 30 }, (_, i) => ({ d: today - (29 - i) * day, earn: 0, jobs: 0, shop: 0, gig: 0, call: 0, book: 0 }));
  const slot30 = at => d30.find(x => at >= x.d && at < x.d + day);
  const prevMonth = new Date(start.getFullYear(), start.getMonth() - 1, 1).getTime();
  const M = { earn: 0, done: 0, req: 0, views: 0, reviews: 0, rsum: 0 }, P = { earn: 0, done: 0, req: 0, views: 0, reviews: 0, rsum: 0 };
  let completed = 0;
  for (const j of results) {
    const q = parse(j.quote), h = parse(j.history) || [];
    if (j.created_at >= month) M.req++; else if (j.created_at >= prevMonth) P.req++;
    const s0 = slot30(j.created_at); if (s0) s0.jobs++;
    if (j.status === 'completed') {
      completed++;
      const at = (h.find(x => x.status === 'completed') || {}).at || j.updated_at;
      const tot = q ? q.total : 0;
      const s1 = slot30(at); if (s1) s1.earn += tot;
      if (at >= month) { M.earn += tot; M.done++; } else if (at >= prevMonth) { P.earn += tot; P.done++; }
    }
    const rv = parse(j.review);
    if (rv) { if (rv.at >= month) { M.reviews++; M.rsum += rv.rating; } else if (rv.at >= prevMonth) { P.reviews++; P.rsum += rv.rating; } }
  }
  const { results: vs } = await env.DB.prepare('SELECT day, kind, n FROM tech_views WHERE tech_id = ? AND day >= ?')
    .bind(t.id, Math.floor(prevMonth / DAY)).all();
  const views = { shop: 0, gig: 0, call: 0, book: 0 };
  for (const v of vs) {
    const at = v.day * DAY;
    const s2 = d30.find(x => at + DAY / 2 >= x.d && at + DAY / 2 < x.d + day) || slot30(at);
    if (s2 && s2[v.kind] != null) s2[v.kind] += v.n;
    if (at >= month - DAY) { if (v.kind === 'shop' || v.kind === 'gig') M.views += v.n; if (views[v.kind] != null) views[v.kind] += v.n; }
    else if (v.kind === 'shop' || v.kind === 'gig') P.views += v.n;
  }
  const fin = o => ({ earn: o.earn, done: o.done, requests: o.req, views: o.views, reviews: o.reviews, rating: o.reviews ? Math.round(o.rsum / o.reviews * 10) / 10 : null });
  return {
    online: !!t.online, earnToday, earnMonth, done, requested, quoted, won,
    winRate: quoted ? Math.round(won / quoted * 100) : 0,
    replyMin: respN ? Math.round(respSum / respN / 60000) : null,
    rating: pt.rating, reviewCount: pt.reviewCount, daily, reviews: reviews.slice(0, 5),
    days30: d30, month: fin(M), prev: fin(P), viewsMonth: views,
    funnel: { requested, quoted, won, completed },
  };
}

/* ══ AI แนะนำร้าน ══
   คำแนะนำหลักมาจากข้อมูลจริงของร้านเสมอ (ไม่ต้องพึ่ง AI) แล้วถ้ามี Gemini ค่อยให้ช่วยเรียบเรียงเพิ่ม
   AI ล่มหรือหมดโควตา ช่างยังได้คำแนะนำที่ใช้ได้ */
async function advice(env, me) {
  const t = await myShop(env, me);
  const d = parse(t.data) || {};
  const s = await stats(env, me);
  const { results: ph } = await env.DB.prepare("SELECT kind FROM tech_docs WHERE uid = ? AND kind IN ('shop','work')").bind(me.uid).all();
  const { results: peers } = await env.DB.prepare('SELECT data FROM tech_profiles WHERE verified = 1 AND test = 0 AND suspended = 0 AND id != ? LIMIT 300').bind(t.id).all();
  const same = peers.map(x => parse(x.data) || {}).filter(x => (x.cats || []).some(c => (d.cats || []).includes(c)) && x.from);
  const med = same.length ? same.map(x => x.from).sort((a, b) => a - b)[Math.floor(same.length / 2)] : null;
  const tips = [];
  const add = (level, title, text, action) => tips.push({ level, title, text, action });
  if ((s.reviewCount || 0) < 3) add('high', 'เก็บรีวิวจากลูกค้า', 'ร้านที่มีรีวิวพร้อมรูปอย่างน้อย 3 รีวิว ลูกค้าใหม่เชื่อใจมากกว่า ปิดงานแล้วชวนลูกค้าให้คะแนนในแอป', 'reviews');
  if (!ph.some(x => x.kind === 'shop')) add('mid', 'เพิ่มรูปหน้าร้าน', 'ให้ลูกค้าเห็นว่าอู่มีอยู่จริง หาเจอง่าย', 'photos');
  if (!d.about || d.about.length < 40) add('mid', 'เขียนความถนัดให้ชัด', 'บอกรุ่นรถที่ถนัด เครื่องมือที่มี และงานที่ไม่รับ ช่วยให้ AI จับคู่ลูกค้าให้ตรงขึ้น', 'about');
  if (!t.online) add('high', 'เปิดรับงาน', 'ตอนนี้คุณออฟไลน์ ประกาศงานใหม่จะไม่แจ้งเตือน', 'online');
  if (s.replyMin != null && s.replyMin > 30) add('high', 'ตอบให้เร็วขึ้น', `เฉลี่ยคุณเสนอราคาใน ${s.replyMin} นาที ร้านที่ตอบภายใน 15 นาทีมักได้งานมากกว่า`, 'queue');
  if (s.quoted >= 3 && s.winRate < 30) add('mid', 'ราคาอาจสูงไป', `ได้งาน ${s.winRate}% ของที่เสนอ ลองเขียนขอบเขตงานให้ละเอียดขึ้น หรือทบทวนราคา`, 'shop');
  if (med && d.from > med * 1.4) add('mid', 'ราคาเริ่มต้นสูงกว่าร้านอื่น', `ร้านหมวดเดียวกันเริ่มราว ฿${med.toLocaleString()} ของคุณ ฿${Number(d.from).toLocaleString()}`, 'shop');
  if (!d.mobile) add('low', 'ลองรับงานนอกสถานที่', 'ประกาศหาช่างส่วนใหญ่เป็นรถที่ขับมาไม่ได้', 'shop');
  if ((d.radius || 0) < 10) add('low', 'ขยายรัศมีรับงาน', 'รัศมีแคบ เห็นประกาศน้อย', 'shop');
  if (!d.hours) add('low', 'ใส่เวลาทำการ', 'ลูกค้าจะรู้ว่าติดต่อได้ช่วงไหน', 'shop');
  if (s.reviewCount && s.rating < 4) add('high', 'ดูรีวิวล่าสุด', 'คะแนนต่ำกว่า 4 ลองอ่านสิ่งที่ลูกค้าบอก แล้วแก้จุดนั้นก่อน', 'reviews');
  if (!tips.length) add('low', 'ร้านของคุณพร้อมมาก', 'ข้อมูลครบ ตอบไว คงมาตรฐานนี้ไว้', null);
  let summary = null;
  if (env.GEMINI_KEY) {
    try {
      const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
      const r = await fetch(`${env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com'}/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        /* สรุปจาก AI เป็นของเสริม — ช้าเกิน 8 วินาทีก็ตัดทิ้ง ช่างยังได้คำแนะนำจากระบบครบ */
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text:
          `คุณเป็นที่ปรึกษาธุรกิจอู่ซ่อมรถ เขียนสรุปสั้น 2-3 ประโยค ภาษาไทย เป็นกันเอง ว่าร้านนี้ควรปรับอะไรก่อนเพื่อได้งานมากขึ้น ห้ามแต่งตัวเลขเอง ใช้เฉพาะข้อมูลนี้:\n` +
          JSON.stringify({ ร้าน: d.shop, หมวด: d.cats, ราคาเริ่ม: d.from, ราคากลางร้านอื่น: med, ความถนัด: d.about, สถิติ: { งานเสร็จ: s.done, เสนอราคา: s.quoted, ได้งานเปอร์เซ็นต์: s.winRate, ตอบเฉลี่ยนาที: s.replyMin, คะแนน: s.rating, รีวิว: s.reviewCount }, จุดที่ระบบพบ: tips.map(x => x.title) }) }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 300 } }),
      });
      if (r.ok) { const j = await r.json(); summary = ((j.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('').trim() || null; }
    } catch (e) { summary = null; }
  }
  return { tips, summary, median: med };
}

/* ── เส้นทาง ── */
async function route(request, env, verifyToken) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '');
  const m = request.method;
  const body=async()=>{const reader=request.body?.getReader();if(!reader)fail(400,'ข้อมูลไม่ถูกต้อง');let total=0,raw='';const decoder=new TextDecoder();
    for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>20*1024*1024){await reader.cancel();fail(413,'ข้อมูลใหญ่เกินไป');}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();
    let data;try{data=JSON.parse(raw)}catch{fail(400,'ข้อมูลไม่ถูกต้อง');}if(!data||typeof data!=='object'||Array.isArray(data))fail(400,'ข้อมูลไม่ถูกต้อง');return data;};

  if (p === '/api/tech' && m === 'GET') {
    /* รายชื่อเปิดให้ทุกคน — โทเคนหมดอายุต้องไม่ทำให้คนทั่วไปดูรายชื่อไม่ได้ */
    const wantTest = url.searchParams.get('test') === '1';
    let me = null;
    try { me = await who(request, env, wantTest,verifyToken); } catch (e) { if (wantTest) throw e; }
    return listTechs(env, me, url);
  }
  if (p === '/api/tech/gigs' && m === 'GET') {
    let me = null;
    try { me = await who(request, env, false); } catch (e) {}
    return listGigs(env, me, url);
  }
  /* นับยอดเข้าชม (ไม่ต้องล็อกอิน) — นับเฉพาะร้านที่มีอยู่จริง */
  if (p === '/api/tech/view' && m === 'POST') {
    const b = await body();
    const kind = ['shop', 'gig', 'call'].includes(b.kind) ? b.kind : null;
    const t = kind && await techById(env, String(b.id || ''));
    if (t && !t.suspended) await bumpView(env, t.id, kind);
    return { ok: true };
  }
  const shm = p.match(/^\/api\/tech\/share\/([A-Za-z0-9_-]{20,64})$/);
  if (shm && m === 'GET') return shareView(env, shm[1]);
  if (p === '/api/tech/reviews' && m === 'GET') {
    let me = null;
    try { me = await who(request, env, false); } catch (e) {}
    return listReviews(env, me, url);
  }
  /* หน้าเว็บใช้เช็กว่าเซิร์ฟเวอร์มีระบบช่างรุ่นนี้แล้ว — ถ้าไม่มี แสดงให้ทีมงานรู้ว่ายังไม่ได้ deploy */
  if (p === '/api/tech/ping') return { ok: true, version: API_VERSION };

  const me = await who(request, env,true,verifyToken);
  if (p === '/api/tech/me' && m === 'GET') return meInfo(env, me);
  if (p === '/api/tech/apply' && m === 'POST') return apply(env, me, await body());
  if (p === '/api/tech/applications' && m === 'GET') return pendingApps(env, me);
  if (p === '/api/tech/audit' && m === 'GET') return auditLog(env, me);
  if (p === '/api/tech/docs' && m === 'GET') return appDocs(env, me, String(url.searchParams.get('uid') || ''));
  if (p === '/api/tech/review' && m === 'POST') return review(env, me, await body());
  if (p === '/api/tech/rescreen' && m === 'POST') return rescreen(env, me, await body());
  if (p === '/api/tech/moderate' && m === 'POST') return moderate(env, me, await body());
  if (p === '/api/tech/jobs' && m === 'GET') {
    const all = url.searchParams.get('all') === '1';
    if (all) adminOnly(me);
    const myTech = await env.DB.prepare('SELECT id FROM tech_profiles WHERE uid = ?').bind(me.uid).first();
    const jobs = await myJobs(env, me, myTech, all);
    jobs.sort((a, b) => (b.needsMe - a.needsMe) || (b.unread > 0) - (a.unread > 0) || b.updatedAt - a.updatedAt);
    return { jobs };
  }
  if (p === '/api/tech/jobs' && m === 'POST') return createJob(env, me, await body());
  if (p === '/api/tech/posts' && m === 'POST') return createPost(env, me, await body());
  if (p === '/api/tech/posts' && m === 'GET') return myPosts(env, me);
  if (p === '/api/tech/posts/near' && m === 'GET') return nearPosts(env, me);
  if (p === '/api/tech/online' && m === 'POST') return setOnline(env, me, await body());
  if (p === '/api/tech/shop' && m === 'POST') return editShop(env, me, await body());
  if (p === '/api/tech/gig' && m === 'POST') return saveGig(env, me, await body());
  if (p === '/api/tech/gig/delete' && m === 'POST') return delGig(env, me, await body());
  if (p === '/api/tech/stats' && m === 'GET') return stats(env, me);
  if (p === '/api/tech/advice' && m === 'GET') return advice(env, me);
  const pd = p.match(/^\/api\/tech\/posts\/([0-9a-f-]{36})$/i);
  if (pd && m === 'GET') return postDetail(env, me, pd[1]);
  let pm = p.match(/^\/api\/tech\/posts\/([0-9a-f-]{36})\/(offer|close)$/i);
  if (pm && m === 'POST') return pm[2] === 'offer' ? offer(env, me, pm[1], await body()) : closePost(env, me, pm[1]);
  let mm = p.match(/^\/api\/tech\/jobs\/([0-9a-f-]{36})$/i);
  if (mm && m === 'GET') return getJob(env, me, mm[1]);
  if (mm && m === 'POST') return updateJob(env, me, mm[1], await body());
  mm = p.match(/^\/api\/tech\/groups\/([0-9a-f-]{36})$/i);
  if (mm && m === 'GET') return groupOf(env, me, mm[1]);
  mm = p.match(/^\/api\/tech\/jobs\/([0-9a-f-]{36})\/messages$/i);
  if (mm && m === 'GET') return pollJob(env, me, mm[1], Number(url.searchParams.get('after')) || 0);
  fail(404, 'ไม่พบปลายทาง');
}

/* worker.js เรียกฟังก์ชันนี้สำหรับทุกคำขอที่ขึ้นต้นด้วย /api/tech */
export async function handleTech(request, env, corsHeaders, options={}) {
  const h = corsHeaders || cors(env, request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  /* งานเบื้องหลังของคำขอนี้ (แจ้ง LINE) — ctx.waitUntil ให้ Worker ทำต่อหลังตอบผู้ใช้ไปแล้ว
     ห่อ env เป็นชั้นใหม่ต่อคำขอ ไม่แก้ env ตัวจริงที่ใช้ร่วมกันทั้ง isolate */
  const ctx = options.ctx;
  env = Object.create(env, { bg: { value: (p) => { const q = Promise.resolve(p).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(q); return q; } } });
  try {
    await ensureTech(env);
    const img = new URL(request.url).pathname.match(/^\/api\/tech\/img\/(\d+)$/);
    if (img) return await image(env, request, Number(img[1]));
    return json(await route(request, env,options.verifyToken), 200, h);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, h);
    console.error(e);
    return json({ error: 'ระบบขัดข้องชั่วคราว กรุณาลองใหม่' }, 500, h);
  }
}
