import { open, CTX } from './vault.js';
/* ══════════════════════════════════════════════════════════════════
   ข้อมูลส่วนตัวของบัญชี (สิทธิ์ตาม PDPA): ดาวน์โหลดข้อมูลของฉัน · ล้างข้อมูล · ลบบัญชีถาวร

   กติกาสำคัญ: ตารางใหม่ที่เก็บ uid / line_uid / ข้อมูลที่ผูกกับคน ต้องเพิ่มใน TABLES ด้านล่างด้วย
   และอัปเดตหน้า /privacy ของเว็บให้ตรง — เทสต์ account-data.test.mjs ไล่ทุก CREATE TABLE ในโค้ด
   ถ้าเจอตารางที่ไม่ได้จัดกลุ่มไว้จะฟ้องทันที กันลืมลบข้อมูลคนใช้

   ลบบัญชีถาวร = ลบ/ทำให้ระบุตัวไม่ได้ทุกแถวของบัญชีนี้ ยกเว้นที่จำเป็นตามกฎหมาย/ความปลอดภัย:
     • ใบงานที่จบแล้วกับช่าง: เก็บไว้ให้อีกฝ่ายดูประวัติได้ แต่ตัดเบอร์ ที่อยู่ หมายเหตุ ข้อความรีวิว และตัดการเชื่อมกับบัญชี
     • บันทึกการกระทำของทีมงาน (audit / tech_audit): เก็บไว้ แต่เปลี่ยนอีเมลผู้ใช้เป็น "deleted"
     • แฮชเลขบัตร (ย้อนกลับไม่ได้) ของร้านที่ทีมงานระงับ: เก็บไว้กันสมัครซ้ำด้วยบัตรเดิม
   งานที่ยังทำค้างอยู่ (รับงานแล้ว/กำลังซ่อม/มีข้อพิพาท) ต้องปิดให้จบก่อน ไม่งั้นอีกฝ่ายเสียหาย
   ══════════════════════════════════════════════════════════════════ */

/* ตารางที่ไม่มีข้อมูลรายคน (ใช้ร่วมกันทั้งแอป) — เทสต์ใช้ยืนยันว่าทุกตารางถูกจัดกลุ่มแล้ว */
/* qa_cache = คำตอบใช้ซ้ำตามรุ่นรถ (ไม่มี uid · cacheSave ไม่เก็บคำถามที่มีชื่อ/อีเมล/เบอร์ของคนถาม)
   part_prices / part_price_runs = ราคาอะไหล่ตามรุ่นรถ (ตารางรุ่นเก่าจาก migrations) */
export const SHARED_TABLES = ['config', 'kb', 'qa_cache', 'magazine', 'shop', 'car_specs', 'vec_store', 'tech_views', 'tech_identity_events',
  'auth_otp', 'auth_rate', 'media_parts', 'audit', 'tech_audit', 'spec_log', 'ws_store', 'part_prices', 'part_price_runs'];

const MINE = 'uid = ?';
const MY_SHOP = 'tech_id IN (SELECT id FROM tech_profiles WHERE uid = ?)';
const MY_LINE = 'line_uid IN (SELECT line_uid FROM line_link WHERE uid = ?)';
/* [ตาราง, เงื่อนไขเลือกแถวของผู้ใช้ (ทุก ? = uid), คอลัมน์ที่ไม่ส่งออก (ความลับ/ไฟล์ใหญ่/ข้อมูลของอีกฝ่าย)] */
export const TABLES = [
  ['users', MINE, []],
  ['user_onboarding', MINE, []],
  ['user_state', MINE, []],
  ['user_memory', MINE, []],
  ['chat_prefs', MINE, []],
  ['cars', MINE, []],
  ['odo_anchor', MINE, []],
  ['odo_state', MINE, []],
  ['maint_item', MINE, []],
  ['notify_state', MINE, []],
  ['obd_device', MINE, ['secret']],
  ['usage', MINE, []],
  ['usage_win', MINE, []],
  ['ai_events', MINE, []],
  /* ตัวเลขโทเคนต่อครั้งที่ใช้ AI (ตั้งแต่ schema 24 ไม่เก็บข้อความ) */
  ['chat_logs', MINE, []],
  /* ตารางช่างรุ่นเก่า (migrations 0014) — อาจยังมีในฐานข้อมูลที่เคยรัน migration นั้น */
  ['technicians', MINE, []],
  ['push_subs', MINE, ['endpoint', 'p256dh', 'auth']],
  ['push_jobs', MINE, []],
  ['feedback', MINE, []],
  ['skills', MINE, []],
  ['skill_stars', MINE, []],
  ['spares_cache', MINE, ['payload']],
  ['media', MINE, []],
  ['line_link', MINE, []],
  ['line_chat', MY_LINE, []],
  ['line_link_token', MY_LINE, ['hash']],
  ['line_code', MINE, ['code']],
  ['car_spec_reports', "who = 'u:' || ?", []],
  ['spec_quota', "who IN ('u:' || ?1, 'attempt:u:' || ?1)", []],
  ['tech_applications', MINE, ['id_hash']],
  ['tech_identity', MINE, ['id_hash', 'session_id']],
  ['tech_identity_claims', MINE, ['id_hash']],
  ['tech_docs', MINE, ['data', 'hash']],
  ['tech_profiles', MINE, []],
  ['tech_gigs', MINE, []],
  ['tech_sponsors', MINE, []],
  ['tech_media', MINE, ['data']],
  ['tech_posts', 'customer_uid = ?', []],
  ['tech_jobs', 'customer_uid = ?', ['start_code']],
  /* ใบงานที่เราเป็นช่าง: เบอร์/ที่อยู่ลูกค้าเป็นข้อมูลของลูกค้า ไม่ส่งออกให้ช่าง */
  ['tech_jobs', MY_SHOP, ['phone', 'address', 'start_code', 'note']],
  ['tech_threads', `customer_uid = ? OR ${MY_SHOP}`, []],
  /* ข้อความ: ส่งออกเฉพาะที่เราพิมพ์เอง ข้อความของอีกฝ่ายเป็นข้อมูลของเขา */
  ['tech_messages', MINE, []],
  ['tech_reads', MINE, []],
  ['tech_shares', MINE, ['token']],
  ['tech_limits', MINE, []],
  ['tech_agent_actions', MINE, ['secret_hash']],
  /* Car Passport ที่เจ้าของเปิดไว้ (ลิงก์ไม่ส่งออก — เป็นกุญแจเปิดหน้า) */
  ['car_passports', MINE, ['token']],
  /* ตัวนับเครื่องมือ AI รายวัน (f:<tool>:<uid>) อยู่ในตาราง usage */
  ['usage', "uid LIKE 'f:%:' || ?", []],
];

const missing = e => /no such table|no such column/i.test(String(e && e.message || e));
const binds = (where, uid) => /\?1/.test(where) ? [uid] : Array((where.match(/\?/g) || []).length).fill(uid);
async function rows(env, table, where, uid) {
  try { return (await env.DB.prepare(`SELECT * FROM ${table} WHERE ${where}`).bind(...binds(where, uid)).all()).results || []; }
  catch (e) { if (missing(e)) return []; throw e; }
}
async function run(env, sql, ...args) {
  try { const r = await env.DB.prepare(sql).bind(...args).run(); return (r && r.meta && r.meta.changes) || 0; }
  catch (e) { if (missing(e)) return 0; throw e; }
}
/* ค่า JSON ที่เก็บเป็นข้อความ → แปลงกลับเป็นออบเจ็กต์ให้อ่านง่ายในไฟล์ที่ดาวน์โหลด */
const unwrap = v => { if (typeof v !== 'string' || !/^[\[{]/.test(v)) return v; try { return JSON.parse(v); } catch { return v; } };

/* ดาวน์โหลดข้อมูลของฉัน — ทุกตารางที่ผูกกับบัญชี ยกเว้นความลับของระบบ (กุญแจ token แฮชบัตร) และไฟล์ดิบ
   ไฟล์แนบ (รูป/เสียง/วิดีโอ) ให้เป็นรายการพร้อมรหัส เปิดดาวน์โหลดทีละไฟล์ได้จาก /api/media/<id> */
/* ข้อมูลใบสมัครช่าง/ผลยืนยันตัวตนเก็บแบบเข้ารหัส (vault.js) — เจ้าของบัญชีดาวน์โหลดแล้วต้องอ่านได้ จึงถอดให้ตรงนี้ */
const SEALED = { tech_applications: CTX.app, tech_identity: CTX.ident };
async function unseal(env, table, r) {
  const ctx = SEALED[table];
  if (!ctx || r.data == null) return r;
  try { return { ...r, data: await open(env, r.data, ctx(r.uid)) }; }
  catch { return { ...r, data: null, data_note: 'ถอดรหัสไม่ได้ — ติดต่อทีมงาน' }; }
}
export async function exportAccount(env, uid, { email = '' } = {}) {
  const data = {};
  for (const [table, where, omit] of TABLES) {
    const list = (await Promise.all((await rows(env, table, where, uid)).map(r => unseal(env, table, r)))).map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !omit.includes(k)).map(([k, v]) => [k, unwrap(v)])));
    if (!list.length) continue;
    const key = table === 'tech_jobs' && where === MY_SHOP ? 'tech_jobs_as_mechanic' : table;
    data[key] = (data[key] || []).concat(list);
  }
  return {
    format: 'cendon-account-export', version: 1, exportedAt: new Date().toISOString(), uid, email,
    note: 'ข้อมูลทั้งหมดที่ Cendon เก็บเกี่ยวกับบัญชีนี้ (ไม่รวมความลับของระบบ เช่น กุญแจแจ้งเตือน รหัสชั่วคราว และค่าแฮชเลขบัตร) · ไฟล์แนบดาวน์โหลดทีละไฟล์ได้จากรหัสใน media',
    data,
  };
}

/* ล้างข้อมูลการใช้งาน แต่คงบัญชี ร้านช่าง และการเชื่อม LINE ไว้ (ปุ่ม "รีเซ็ตบัญชี") */
export const RESET_TABLES = ['user_onboarding', 'cars', 'usage', 'usage_win', 'user_state', 'user_memory', 'push_subs', 'push_jobs', 'chat_prefs',
  'odo_anchor', 'odo_state', 'maint_item', 'notify_state', 'obd_device', 'spares_cache', 'ai_events', 'chat_logs', 'tech_agent_actions'];
export async function resetAccount(env, uid) {
  const removed = {};
  for (const t of RESET_TABLES) {
    try { removed[t] = await run(env, `DELETE FROM ${t} WHERE uid = ?`, uid); }
    catch (e) { removed[t] = 'error: ' + String(e.message || e).slice(0, 80); }
  }
  try { removed.line_chat = await run(env, `DELETE FROM line_chat WHERE ${MY_LINE}`, uid); }
  catch (e) { removed.line_chat = 'error: ' + String(e.message || e).slice(0, 80); }
  /* ไฟล์ในแชต AI และไฟล์ร่างที่ยังไม่ได้ส่งให้ใคร (ไฟล์ที่ส่งในห้องคุยกับช่างแล้วไม่ลบ อีกฝ่ายยังต้องเห็น) */
  try { removed.media = await dropMedia(env, "uid = ? AND scope IN ('ai','draft')", uid); }
  catch (e) { removed.media = 'error: ' + String(e.message || e).slice(0, 80); }
  return removed;
}

async function dropMedia(env, where, ...args) {
  let list;
  try { list = (await env.DB.prepare(`SELECT id, store FROM media WHERE ${where}`).bind(...args).all()).results || []; }
  catch (e) { if (missing(e)) return 0; throw e; }
  for (const m of list) {
    if (m.store === 'r2' && env.MEDIA) { try { await env.MEDIA.delete('m/' + m.id); } catch { /* ไฟล์หายไปแล้วก็ถือว่าลบ */ } }
    await run(env, 'DELETE FROM media_parts WHERE id = ?', m.id);
    await run(env, 'DELETE FROM media WHERE id = ?', m.id);
  }
  return list.length;
}

/* สถานะใบงานที่ยังทำค้าง — ลบบัญชีไม่ได้จนกว่าจะจบ (อีกฝ่ายยังต้องติดต่อ/มีเงินหรือข้อพิพาทค้าง) */
export const BUSY = ['accepted', 'enroute', 'working', 'done', 'disputed'];
export async function deleteBlockers(env, uid) {
  const q = `SELECT id, status FROM tech_jobs WHERE status IN (${BUSY.map(() => '?').join(',')}) AND (customer_uid = ? OR ${MY_SHOP}) LIMIT 20`;
  try { return (await env.DB.prepare(q).bind(...BUSY, uid, uid).all()).results || []; }
  catch (e) { if (missing(e)) return []; throw e; }
}

/* ลบบัญชีถาวร — คืนจำนวนแถวที่ลบ/ทำให้ระบุตัวไม่ได้ ต่อตาราง (ไม่มีข้อมูลส่วนตัวในผลลัพธ์) */
export async function deleteAccount(env, uid, { email = '' } = {}) {
  const at = Date.now(), done = {};
  const add = (k, n) => { done[k] = (done[k] || 0) + n; };
  const shop = await env.DB.prepare('SELECT id, suspended, id_hold FROM tech_profiles WHERE uid = ?').bind(uid).first().catch(e => { if (missing(e)) return null; throw e; });

  /* ไฟล์แนบทั้งหมดของบัญชีนี้ (รวมที่ส่งในห้องคุยแล้ว — อีกฝ่ายจะเห็นว่าไฟล์ถูกลบ) */
  add('media', await dropMedia(env, 'uid = ?', uid));

  /* ห้องทักช่าง (คุยก่อนจ้าง) ทั้งฝั่งลูกค้าและฝั่งร้าน: ลบทั้งห้อง */
  const threadWhere = shop ? 'customer_uid = ? OR tech_id = ?' : 'customer_uid = ?';
  const threadArgs = shop ? [uid, shop.id] : [uid];
  add('tech_messages', await run(env, `DELETE FROM tech_messages WHERE job_id IN (SELECT id FROM tech_threads WHERE ${threadWhere})`, ...threadArgs));
  add('tech_reads', await run(env, `DELETE FROM tech_reads WHERE job_id IN (SELECT id FROM tech_threads WHERE ${threadWhere})`, ...threadArgs));
  add('tech_threads', await run(env, `DELETE FROM tech_threads WHERE ${threadWhere}`, ...threadArgs));

  /* ใบงานที่ยังไม่มีใครรับ (ขอราคา/เสนอราคา) → ยกเลิก */
  const cancelled = JSON.stringify({ status: 'cancelled', at, by: 'system' });
  add('tech_jobs_cancelled', await run(env, `UPDATE tech_jobs SET status = 'cancelled', history = json_insert(CASE WHEN json_valid(history) THEN history ELSE '[]' END, '$[#]', json(?)), updated_at = ?
    WHERE status IN ('requested','quoted') AND (customer_uid = ? OR tech_id = ?)`, cancelled, at, uid, shop ? shop.id : '\u0000'));
  /* ใบงานของเราในฐานะลูกค้า: เก็บประวัติให้ช่าง แต่ตัดทุกอย่างที่ระบุตัวเรา */
  add('tech_jobs', await run(env, `UPDATE tech_jobs SET customer_uid = 'deleted', phone = '', address = '', note = NULL, start_code = NULL, dispute = NULL,
    review = CASE WHEN review IS NOT NULL AND json_valid(review) THEN json_remove(review, '$.text') ELSE NULL END, updated_at = ? WHERE customer_uid = ?`, at, uid));
  /* ข้อความที่เราพิมพ์ในใบงาน: ลบเนื้อหา คงแถวไว้ให้ลำดับบทสนทนาอีกฝ่ายไม่พัง */
  add('tech_messages', await run(env, "UPDATE tech_messages SET uid = 'deleted', text = '', orig_text = NULL, media = NULL, deleted_at = ? WHERE uid = ?", at, uid));
  add('tech_reads', await run(env, 'DELETE FROM tech_reads WHERE uid = ?', uid));
  add('tech_posts', await run(env, 'DELETE FROM tech_posts WHERE customer_uid = ?', uid));

  if (shop) {
    /* ร้านของเรา: ลบบริการ สปอนเซอร์ สถิติ แล้วเปลี่ยนโปรไฟล์เป็น "ร้านที่ปิดบัญชีแล้ว" (ใบงานเก่าของลูกค้ายังอ้างถึงได้) */
    add('tech_gigs', await run(env, 'DELETE FROM tech_gigs WHERE uid = ?', uid));
    add('tech_sponsors', await run(env, 'DELETE FROM tech_sponsors WHERE uid = ?', uid));
    add('tech_views', await run(env, 'DELETE FROM tech_views WHERE tech_id = ?', shop.id));
    add('tech_profiles', await run(env, `UPDATE tech_profiles SET uid = 'deleted:' || id, phone = NULL, data = ?, verified = 0, suspended = 1, online = 0, updated_at = ? WHERE uid = ?`,
      JSON.stringify({ name: 'ร้านที่ปิดบัญชีแล้ว', shop: 'ร้านที่ปิดบัญชีแล้ว', deleted: true }), at, uid));
  }
  /* แฮชเลขบัตรของร้านที่ทีมงานระงับ (ไม่ใช่พักเพราะรอยืนยันตัวตน) เก็บไว้กันสมัครซ้ำ — อย่างอื่นลบ */
  const keepClaim = shop && Number(shop.suspended) === 1 && Number(shop.id_hold) !== 1;
  add('tech_identity_claims', keepClaim
    ? await run(env, "UPDATE tech_identity_claims SET uid = 'deleted:' || id_hash WHERE uid = ?", uid)
    : await run(env, 'DELETE FROM tech_identity_claims WHERE uid = ?', uid));
  for (const t of ['tech_applications', 'tech_identity', 'tech_docs', 'tech_media', 'tech_shares', 'tech_limits', 'technicians', 'car_passports'])
    add(t, await run(env, `DELETE FROM ${t} WHERE uid = ?`, uid));
  add('usage', await run(env, "DELETE FROM usage WHERE uid LIKE 'f:%:' || ?", uid));
  /* ตำแหน่งล่าสุดตอนเราเป็นช่างที่กำลังเดินทาง: ลบทิ้ง */
  if (shop) add('tech_jobs_live', await run(env, 'UPDATE tech_jobs SET live = NULL WHERE tech_id = ? AND live IS NOT NULL', shop.id));

  /* LINE: ลบการเชื่อม ประวัติคุยกับบอท และลิงก์เชื่อมที่ค้าง */
  for (const t of ['line_chat', 'line_link_token']) add(t, await run(env, `DELETE FROM ${t} WHERE ${MY_LINE}`, uid));
  for (const t of ['line_link', 'line_code']) add(t, await run(env, `DELETE FROM ${t} WHERE uid = ?`, uid));

  /* สกิลที่เราสร้าง + ดาวที่คนอื่นให้สกิลนั้น + ดาวที่เราให้คนอื่น */
  add('skill_stars', await run(env, 'DELETE FROM skill_stars WHERE skill_id IN (SELECT id FROM skills WHERE uid = ?) OR uid = ?', uid, uid));
  add('skills', await run(env, 'DELETE FROM skills WHERE uid = ?', uid));

  /* สเปกรถที่เคยค้น: คลังสเปกใช้ร่วมกันทุกคน เก็บไว้ แต่ตัดว่าใครค้น */
  add('car_specs', await run(env, 'UPDATE car_specs SET by_uid = NULL WHERE by_uid = ?', uid));
  add('car_spec_reports', await run(env, "DELETE FROM car_spec_reports WHERE who = 'u:' || ?", uid));
  add('spec_quota', await run(env, "DELETE FROM spec_quota WHERE who IN ('u:' || ?1, 'attempt:u:' || ?1)", uid));
  add('spec_log', await run(env, "UPDATE spec_log SET who = 'deleted' WHERE who = 'u:' || ?", uid));

  for (const t of [...RESET_TABLES, 'feedback']) add(t, await run(env, `DELETE FROM ${t} WHERE uid = ?`, uid));

  /* บันทึกของทีมงานเก็บไว้ (ความปลอดภัย/ข้อพิพาท) แต่ไม่เหลืออีเมลของคนที่ลบบัญชี */
  if (email) add('audit', await run(env, "UPDATE audit SET actor = 'deleted' WHERE actor = ?", email));
  add('users', await run(env, 'DELETE FROM users WHERE uid = ?', uid));
  return done;
}
