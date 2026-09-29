/* ══ สมองเวกเตอร์ — ค้นตาม "ความหมาย" ไม่ใช่แค่คำตรงกัน ══
   เช่น ถาม "แอร์ไม่ค่อยเย็น" ก็เจอความรู้เรื่อง "น้ำยาแอร์รั่ว" ได้ แม้ไม่มีคำซ้ำกันเลย
   ใช้ Workers AI (binding AI มีอยู่แล้วใน wrangler.jsonc) แปลงข้อความเป็นเวกเตอร์
   แล้วเก็บใน D1 ตารางเดียว — ไม่ต้องสร้าง Vectorize index หรือตั้งค่าอะไรเพิ่ม
   ข้อมูลระดับหลักพันชิ้น การไล่เทียบใน Worker ใช้เวลาไม่กี่มิลลิวินาที */

const MODEL = '@cf/baai/bge-m3';          /* รองรับภาษาไทยและอีกกว่าร้อยภาษา */
const DIM = 1024;
/* เกณฑ์ขั้นต่ำต่อชนิด — คำตอบใช้ซ้ำต้องเหมือนมาก ไม่งั้นจะตอบผิดคำถาม */
export const MIN_SCORE = { kb: 0.55, cache: 0.82, memory: 0.6 };

const SQL = `CREATE TABLE IF NOT EXISTS vec_store (
  kind       TEXT NOT NULL,
  id         TEXT NOT NULL,
  v          TEXT NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
)`;
let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.prepare(SQL).run();
  ready = true;
}

/* ข้อความที่ใช้แทนแต่ละแถว — ตัดยาวไว้เพราะโมเดลอ่านได้จำกัด และหัวเรื่องสำคัญที่สุด */
const SOURCES = {
  kb: {
    q: 'SELECT id, title, body, keywords, make, model, updated_at FROM kb WHERE id > ? ORDER BY id LIMIT ?',
    text: r => `${r.title}\n${r.keywords || ''}\n${String(r.body || '').slice(0, 1500)}`,
    meta: r => ({ title: r.title, make: r.make, model: r.model }),
  },
  cache: {
    q: 'SELECT id, question, make, model, used_at AS updated_at FROM qa_cache WHERE id > ? ORDER BY id LIMIT ?',
    text: r => String(r.question || ''),
    meta: r => ({ title: String(r.question || '').slice(0, 80), make: r.make, model: r.model }),
  },
  memory: {
    q: 'SELECT id, uid, text, created_at AS updated_at FROM user_memory WHERE id > ? ORDER BY id LIMIT ?',
    text: r => String(r.text || ''),
    meta: r => ({ title: String(r.text || '').slice(0, 80), uid: r.uid }),
  },
};
const TABLE = { kb: 'kb', cache: 'qa_cache', memory: 'user_memory' };

/* เวกเตอร์ถูกทำให้ยาว 1 เสมอ ความคล้าย (cosine) จึงเหลือแค่ผลคูณจุด */
function norm(a) {
  let s = 0; for (const x of a) s += x * x;
  s = Math.sqrt(s) || 1;
  return Float32Array.from(a, x => x / s);
}
function enc(f32) {
  const b = new Uint8Array(f32.buffer); let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
}
function dec(s) {
  const bin = atob(s), b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return new Float32Array(b.buffer);
}
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

export async function embed(env, texts) {
  if (!env.AI) throw new Error('ยังไม่ได้ผูก Workers AI');
  const r = await env.AI.run(MODEL, { text: texts.map(t => String(t).slice(0, 4000) || ' ') });
  const data = r && r.data;
  if (!Array.isArray(data) || data.length !== texts.length) throw new Error('โมเดลแปลงข้อความไม่สำเร็จ');
  return data.map(norm);
}

async function countOf(env, sql) {
  try { const r = await env.DB.prepare(sql).first(); return (r && r.n) || 0; } catch { return 0; }
}

async function status(env) {
  await ensure(env);
  const [kb, cache, memory, vectors] = await Promise.all([
    countOf(env, 'SELECT COUNT(*) AS n FROM kb'), countOf(env, 'SELECT COUNT(*) AS n FROM qa_cache'),
    countOf(env, 'SELECT COUNT(*) AS n FROM user_memory'), countOf(env, 'SELECT COUNT(*) AS n FROM vec_store'),
  ]);
  const enabled = !!env.AI;
  return {
    enabled, model: MODEL, dim: DIM, count: vectors,
    index: { vectors, dimensions: DIM, metric: 'cosine', store: 'D1' },
    rows: { kb, cache, memory, total: kb + cache + memory },
    bindings: { vectorize: true, ai: enabled },
    hint: enabled ? '' : 'ยังไม่ได้ผูก Workers AI — ระบบใช้วิธีจับคำแทนไปก่อน',
  };
}

/* สร้างย้อนหลังทีละก้อน — Worker มีเพดานเวลาต่อคำขอ หน้าแอดมินจะวนเรียกจนได้ done */
async function backfill(env, b) {
  await ensure(env);
  const kind = SOURCES[b.kind] ? b.kind : 'kb';
  const src = SOURCES[kind];
  const limit = Math.min(Math.max(+b.limit || 50, 1), 100);
  const { results } = await env.DB.prepare(src.q).bind(String(b.after || ''), limit).all();
  let wrote = 0;
  for (let i = 0; i < results.length; i += 20) {
    const part = results.slice(i, i + 20);
    const vs = await embed(env, part.map(src.text));
    await env.DB.batch(part.map((r, j) => env.DB.prepare(
      `INSERT INTO vec_store (kind, id, v, meta, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(kind, id) DO UPDATE SET v = excluded.v, meta = excluded.meta, updated_at = excluded.updated_at`)
      .bind(kind, r.id, enc(vs[j]), JSON.stringify(src.meta(r)), r.updated_at || Date.now())));
    wrote += part.length;
  }
  /* เวกเตอร์ของแถวที่ถูกลบไปแล้วต้องหายตาม ไม่งั้นค้นแล้วเจอของที่ไม่มีอยู่ */
  if (!b.after) await env.DB.prepare(
    `DELETE FROM vec_store WHERE kind = ? AND id NOT IN (SELECT id FROM ${TABLE[kind]})`).bind(kind).run();
  return { ok: true, kind, read: results.length, wrote, after: results.length ? results[results.length - 1].id : b.after || '', done: results.length < limit };
}

/* ความคล้ายของคำถามกับทุกชิ้นในชนิดนั้น — คืน [{id, score, meta}] เรียงมากไปน้อย */
export async function search(env, kind, q, topK = 8, qv) {
  await ensure(env);
  const v = qv || (await embed(env, [q]))[0];
  const { results } = await env.DB.prepare('SELECT id, v, meta FROM vec_store WHERE kind = ? LIMIT 5000').bind(kind).all();
  return results.map(r => ({ id: r.id, score: dot(v, dec(r.v)), meta: JSON.parse(r.meta || '{}') }))
    .sort((a, b) => b.score - a.score).slice(0, topK);
}

async function probe(env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const kind = SOURCES[url.searchParams.get('kind')] ? url.searchParams.get('kind') : 'kb';
  if (!q) return { ok: false, error: 'พิมพ์คำถามก่อน' };
  const t = Date.now();
  const [qv] = await embed(env, [q]);
  const embedMs = Date.now() - t;
  const m = await search(env, kind, q, 8, qv);
  return { ok: true, dim: qv.length, embedMs, minScore: MIN_SCORE[kind],
    matches: m.map(x => ({ ...x, score: Math.round(x.score * 1000) / 1000, pass: x.score >= MIN_SCORE[kind] })) };
}

/* ใช้ใน kbFor: คะแนนความหมายของความรู้แต่ละชิ้น (เฉพาะที่ผ่านเกณฑ์)
   อยู่บนทางก่อนเริ่มตอบ จึงให้เวลาแค่ 0.7 วินาที ช้ากว่านั้นถอยไปจับคำเหมือนเดิม */
/* โควตา Workers AI ฟรีมีจำกัดต่อวัน และใช้ร่วมกับทางสำรองของแชต — ถ้าหมดแล้วพักการค้นความหมาย 6 ชั่วโมง
   ระหว่างนั้นใช้วิธีจับคำแทน (ผลลัพธ์ยังใช้ได้ แค่ไม่ฉลาดเท่า) */
let aiOffUntil = 0;
export async function kbScores(env, question) {
  if (!env.AI || Date.now() < aiOffUntil) return new Map();
  try {
    const hits = await Promise.race([search(env, 'kb', question, 12),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 700))]);
    return new Map(hits.filter(h => h.score >= MIN_SCORE.kb).map(h => [h.id, h.score]));
  } catch (e) { if (/4006|neurons|quota|429/i.test(String(e && e.message || e))) aiOffUntil = Date.now() + 6 * 3600000; return new Map(); }
}

/* งานประจำวัน: สร้างเวกเตอร์ให้ความรู้ที่เพิ่ม/แก้ใหม่ ทีมงานไม่ต้องกดเอง */
export async function refreshKb(env) {
  if (!env.AI) return;
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT k.id, k.title, k.body, k.keywords, k.make, k.model, k.updated_at FROM kb k
     LEFT JOIN vec_store s ON s.kind = 'kb' AND s.id = k.id
     WHERE s.id IS NULL OR s.updated_at < k.updated_at LIMIT 200`).all();
  for (let i = 0; i < results.length; i += 20) {
    const part = results.slice(i, i + 20), vs = await embed(env, part.map(SOURCES.kb.text));
    await env.DB.batch(part.map((r, j) => env.DB.prepare(
      `INSERT INTO vec_store (kind, id, v, meta, updated_at) VALUES ('kb',?,?,?,?)
       ON CONFLICT(kind, id) DO UPDATE SET v = excluded.v, meta = excluded.meta, updated_at = excluded.updated_at`)
      .bind(r.id, enc(vs[j]), JSON.stringify(SOURCES.kb.meta(r)), r.updated_at)));
  }
}

/* เส้นทาง /api/admin/vectorize/* — worker.js ตรวจสิทธิ์ผู้ดูแลก่อนส่งมาที่นี่ */
export async function handleVec(request, env, url) {
  const p = url.pathname.replace('/api/admin/vectorize/', '');
  if (p === 'status' && request.method === 'GET') return status(env);
  if (p === 'backfill' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    /* หน้าแอดมินรุ่นเก่ากดปุ่มเดียวแบบไม่ระบุชนิด — ทำความรู้ทั้งหมดให้จบในครั้งเดียว */
    if (!b.kind) {
      let after = '', count = 0, r;
      do { r = await backfill(env, { kind: 'kb', after, limit: 100 }); after = r.after; count += r.wrote; } while (!r.done);
      return { ok: true, count };
    }
    return backfill(env, b);
  }
  if (p === 'probe' && request.method === 'GET') return probe(env, url);
  return null;
}
