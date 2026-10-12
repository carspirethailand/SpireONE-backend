/* ══════════════════════════════════════════════════════════════════
   ไฟล์แนบในแชต (รูป · วิดีโอ · เสียง) — เก็บไฟล์จริงไว้บนเซิร์ฟเวอร์
   ปิดแอป ล้างเครื่อง หรือเปลี่ยนเครื่อง ไฟล์ยังอยู่ (ข้อความเก็บแค่รหัสไฟล์)

   ที่เก็บ: มีถัง R2 (binding ชื่อ MEDIA) ใช้ R2 · ไม่มีก็เก็บใน D1 แบ่งชิ้นละไม่เกิน ~900KB
            (D1 เก็บแถวละไม่เกิน 2MB และเก็บเป็นข้อความ base64 แบบเดียวกับรูปร้าน)
   รหัสไฟล์: หน้าเว็บสร้างเอง (m_ + สุ่ม) ส่งซ้ำได้ไม่เกิดไฟล์ซ้ำ — เน็ตหลุดกลางทางก็ส่งใหม่ได้
   ขอบเขต (scope):
     ai          แชต AI ของเจ้าของ — เจ้าของคนเดียวเปิดได้
     draft       เพิ่งอัปโหลด ยังไม่ได้ส่งในห้องไหน — เจ้าของคนเดียวเปิดได้
     thread:<id> / job:<id>  ส่งในห้องทักช่าง/ใบงานแล้ว — คนในห้องนั้นและทีมงานเปิดได้
   แท็ก <img> ส่งโทเคนไม่ได้ หน้าเว็บจึงดึงไฟล์ด้วย fetch (มีโทเคน) แล้วแสดงเป็น blob
   ══════════════════════════════════════════════════════════════════ */

export const MEDIA_SQL = [
  `CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  scope      TEXT NOT NULL,
  kind       TEXT NOT NULL,             -- image | video | audio
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  parts      INTEGER NOT NULL DEFAULT 0, -- จำนวนชิ้นใน D1 (0 = อยู่ใน R2)
  store      TEXT NOT NULL,             -- d1 | r2
  created_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS media_uid ON media(uid, created_at)`,
  `CREATE TABLE IF NOT EXISTS media_parts (
  id   TEXT NOT NULL,
  n    INTEGER NOT NULL,
  data TEXT NOT NULL,                   -- base64
  PRIMARY KEY (id, n)
)`,
];

export class MediaError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new MediaError(status, msg); };

export const MEDIA_ID = /^m_[A-Za-z0-9_-]{8,64}$/;
const MB = 1024 * 1024;
/* ขนาดสูงสุดต่อไฟล์ — วิดีโอใน D1 จำกัดต่ำกว่า R2 เพราะต้องแบ่งเป็นหลายแถว */
const TYPES = {
  image: { re: /^image\/(jpeg|png|webp|gif|heic|heif)$/, max: 10 * MB },
  video: { re: /^video\/(mp4|webm|quicktime|3gpp|x-matroska)$/, max: 25 * MB, maxD1: 20 * MB },
  audio: { re: /^audio\/(webm|ogg|mp4|mpeg|aac|wav|x-wav|x-m4a|m4a|mp3|3gpp|amr)$/, max: 10 * MB },
};
const PART = 900 * 1024;
/* พื้นที่ต่อบัญชี — กันบัญชีเดียวอัดไฟล์จนฐานข้อมูลเต็ม */
const QUOTA = 500 * MB;

export function mediaKind(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  for (const [kind, t] of Object.entries(TYPES)) if (t.re.test(m)) return { kind, mime: m };
  return null;
}
const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/* อ่านไฟล์จากคำขอ ไม่เกินขนาดที่กำหนด (ตัดทันทีที่เกิน ไม่ต้องรอรับจนจบ) */
async function readCapped(request, max) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > max) fail(413, 'ไฟล์ใหญ่เกินไป');
  const reader = request.body && request.body.getReader();
  if (!reader) fail(400, 'ไม่มีไฟล์');
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch (e) {} fail(413, 'ไฟล์ใหญ่เกินไป'); }
    chunks.push(value);
  }
  if (!total) fail(400, 'ไม่มีไฟล์');
  const out = new Uint8Array(total); let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/* อัปโหลด: PUT /api/tech/media/<id>?scope=ai|draft  (Content-Type = ชนิดไฟล์)
   scope ส่งทาง query ไม่ใช่ header — header ใหม่ต้องเพิ่มในรายการ CORS ของทุก worker */
export async function putMedia(env, me, id, request, limit) {
  if (!MEDIA_ID.test(id)) fail(400, 'รหัสไฟล์ไม่ถูกต้อง');
  const scope = String(new URL(request.url).searchParams.get('scope') || 'draft');
  if (!['ai', 'draft'].includes(scope)) fail(400, 'ที่เก็บไฟล์ไม่ถูกต้อง');
  const type = mediaKind(request.headers.get('Content-Type'));
  if (!type) fail(415, 'รองรับเฉพาะรูปภาพ วิดีโอ และไฟล์เสียง');
  const have = await env.DB.prepare('SELECT uid, kind, mime, size FROM media WHERE id = ?').bind(id).first();
  if (have) {
    /* ส่งซ้ำ (เน็ตหลุดตอนรอคำตอบ) = สำเร็จ ไม่เก็บซ้ำ · รหัสของคนอื่นห้ามทับ */
    if (have.uid !== me.uid) fail(409, 'รหัสไฟล์ซ้ำ');
    return { id, kind: have.kind, mime: have.mime, size: have.size, existed: true };
  }
  const t = TYPES[type.kind], r2 = !!env.MEDIA;
  const max = r2 ? t.max : (t.maxD1 || t.max);
  const bytes = await readCapped(request, max);
  if (limit) await limit(env, 'media', me.uid, 300);
  const used = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM media WHERE uid = ?').bind(me.uid).first();
  if (Number(used && used.n || 0) + bytes.byteLength > QUOTA) fail(413, 'พื้นที่เก็บไฟล์ของบัญชีนี้เต็มแล้ว ลบแชตเก่าที่มีไฟล์ใหญ่ออกก่อน');
  let parts = 0;
  if (r2) {
    await env.MEDIA.put('m/' + id, bytes, { httpMetadata: { contentType: type.mime } });
  } else {
    try {
      for (let at = 0; at < bytes.byteLength; at += PART, parts++)
        await env.DB.prepare('INSERT OR REPLACE INTO media_parts (id, n, data) VALUES (?,?,?)')
          .bind(id, parts, b64(bytes.subarray(at, at + PART))).run();
    } catch (e) {
      await env.DB.prepare('DELETE FROM media_parts WHERE id = ?').bind(id).run().catch(() => {});
      throw e;
    }
  }
  /* แถวหลักบันทึกเป็นอย่างสุดท้าย — อัปโหลดค้างกลางทางจะไม่มีไฟล์ครึ่ง ๆ ให้เปิด */
  await env.DB.prepare('INSERT INTO media (id, uid, scope, kind, mime, size, parts, store, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, me.uid, scope, type.kind, type.mime, bytes.byteLength, parts, r2 ? 'r2' : 'd1', Date.now()).run();
  return { id, kind: type.kind, mime: type.mime, size: bytes.byteLength };
}

/* เปิดไฟล์: เจ้าของ · ทีมงาน · คนในห้อง/ใบงานที่ไฟล์ถูกส่งไป (inScope ตรวจให้) */
export async function getMedia(env, me, id, inScope, headers) {
  if (!MEDIA_ID.test(id)) fail(404, 'ไม่พบไฟล์');
  const row = await env.DB.prepare('SELECT * FROM media WHERE id = ?').bind(id).first();
  /* ไม่มีสิทธิ์ตอบว่า "ไม่พบ" — ไม่บอกคนนอกว่ารหัสนี้มีไฟล์อยู่ */
  if (!row) fail(404, 'ไม่พบไฟล์');
  const ok = row.uid === me.uid || me.staff || (/^(thread|job):/.test(row.scope) && await inScope(row.scope));
  if (!ok) fail(404, 'ไม่พบไฟล์');
  const h = new Headers(headers || {});
  h.set('Content-Type', row.mime);
  h.set('Cache-Control', 'private, max-age=31536000, immutable');
  h.set('Content-Disposition', 'inline');
  h.set('X-Content-Type-Options', 'nosniff');
  if (row.store === 'r2') {
    if (!env.MEDIA) fail(503, 'ที่เก็บไฟล์ไม่พร้อม');
    const obj = await env.MEDIA.get('m/' + id);
    if (!obj) fail(404, 'ไม่พบไฟล์');
    return new Response(obj.body, { headers: h });
  }
  const { results } = await env.DB.prepare('SELECT n, data FROM media_parts WHERE id = ? ORDER BY n').bind(id).all();
  if (results.length !== row.parts) fail(404, 'ไม่พบไฟล์');
  const out = new Uint8Array(row.size); let at = 0;
  for (const p of results) { const b = unb64(p.data); out.set(b, at); at += b.byteLength; }
  h.set('Content-Length', String(row.size));
  return new Response(out, { headers: h });
}

/* ลบไฟล์ (เจ้าของเท่านั้น) — ไฟล์ที่ส่งในห้องคุยแล้วลบไม่ได้ อีกฝ่ายยังต้องเห็นหลักฐาน */
export async function deleteMedia(env, me, id) {
  const row = MEDIA_ID.test(id) && await env.DB.prepare('SELECT uid, scope, store FROM media WHERE id = ?').bind(id).first();
  if (!row || row.uid !== me.uid) fail(404, 'ไม่พบไฟล์');
  if (!['ai', 'draft'].includes(row.scope)) fail(409, 'ไฟล์ที่ส่งในห้องคุยแล้วลบไม่ได้');
  if (row.store === 'r2' && env.MEDIA) await env.MEDIA.delete('m/' + id);
  await env.DB.prepare('DELETE FROM media_parts WHERE id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM media WHERE id = ?').bind(id).run();
  return { ok: true };
}

/* ไฟล์ที่แนบมากับข้อความในห้องคุย: ต้องเป็นของผู้ส่งเอง ยังเป็นร่าง (หรือส่งในห้องเดียวกันแล้ว = ส่งซ้ำ)
   แล้วย้ายเข้าห้องนั้น — จากนี้คนในห้องเปิดดูได้ คืนรายการสั้น ๆ สำหรับเก็บกับข้อความ */
export async function claimMedia(env, me, list, scope) {
  if (list == null) return [];
  if (!Array.isArray(list)) fail(400, 'ไฟล์แนบไม่ถูกต้อง');
  if (list.length > 4) fail(400, 'แนบได้ไม่เกิน 4 ไฟล์ต่อข้อความ');
  const out = [];
  for (const x of list) {
    const id = String(x && typeof x === 'object' ? x.id : x || '');
    if (!MEDIA_ID.test(id) || out.some(o => o.id === id)) fail(400, 'ไฟล์แนบไม่ถูกต้อง');
    const row = await env.DB.prepare('SELECT id, uid, scope, kind, mime, size FROM media WHERE id = ?').bind(id).first();
    if (!row || row.uid !== me.uid || !(row.scope === 'draft' || row.scope === scope)) fail(400, 'ไม่พบไฟล์แนบ กรุณาแนบใหม่');
    if (row.scope === 'draft') await env.DB.prepare("UPDATE media SET scope = ? WHERE id = ? AND scope = 'draft'").bind(scope, id).run();
    out.push({ id, kind: row.kind, mime: row.mime, size: row.size });
  }
  return out;
}

/* ป้ายสั้นแทนข้อความ (รายการห้อง / แจ้ง LINE) เมื่อส่งแต่ไฟล์ */
export function mediaLabel(media) {
  if (!media || !media.length) return '';
  const k = media[0].kind;
  return (k === 'video' ? '🎬 วิดีโอ' : k === 'audio' ? '🎙 ข้อความเสียง' : '📷 รูปภาพ') + (media.length > 1 ? ` (${media.length})` : '');
}
