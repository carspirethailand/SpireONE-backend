/* ตู้เซฟข้อมูลใบสมัครช่าง — เข้ารหัสจริง (AES-256-GCM) ไม่ใช่แค่แปลงรูปแบบ (base64 ใครได้ไปก็แปลงกลับได้)
   ───────────────────────────────────────────────────────────────────
   กุญแจ: APP_DATA_KEY (Worker secret, 32 ไบต์แบบ base64) — อยู่นอกฐานข้อมูลเสมอ
     ฐานข้อมูลหรือสำเนาสำรองหลุดออกไป = ได้แต่ตัวอักษรที่ถอดไม่ออก
   ผูกข้อมูลกับเจ้าของ (AAD): เอาข้อมูลเข้ารหัสของคนหนึ่งไปวางแทนแถวของอีกคน = ถอดไม่ได้ (กันสลับ/ปลอมแถว)
   GCM มีลายเซ็นในตัว: แก้ข้อมูลเข้ารหัสแม้แต่ตัวเดียว = ถอดไม่ได้ ระบบรู้ทันทีว่าถูกแตะ
   เปลี่ยนกุญแจได้: ตั้งกุญแจใหม่เป็น APP_DATA_KEY ย้ายของเดิมไป APP_DATA_KEY_PREV
     ระบบยังอ่านของเก่าได้ และเข้ารหัสใหม่ด้วยกุญแจใหม่ให้เองตอนรอบเก็บกวาด
   ห้ามทำกุญแจหาย: หายแล้วข้อมูลที่เข้ารหัสไว้กู้ไม่ได้ (เก็บสำเนาไว้ในที่เก็บรหัสผ่านของบริษัท) */

const PREFIX = 'enc:v1:';
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/* กุญแจที่ใช้งานได้ต่อ env: [{id, key}] ตัวแรก = ตัวปัจจุบัน (ใช้เข้ารหัส) */
const cache = new WeakMap();
async function keysOf(env) {
  if (cache.has(env)) return cache.get(env);
  const p = (async () => {
    const out = [];
    for (const raw of [env.APP_DATA_KEY, env.APP_DATA_KEY_PREV]) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      let bytes; try { bytes = unb64(raw.trim()); } catch { continue; }
      if (bytes.length !== 32) continue;
      /* รหัสกุญแจ 8 ตัว (แฮชของกุญแจ) ใส่ไว้หน้าข้อมูล บอกว่าเข้ารหัสด้วยกุญแจตัวไหน ไม่ใช่ตัวกุญแจเอง */
      const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].slice(0, 4).map(x => x.toString(16).padStart(2, '0')).join('');
      out.push({ id, key: await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']) });
    }
    return out;
  })();
  cache.set(env, p);
  return p;
}

/* พร้อมเข้ารหัสไหม — ไม่มีกุญแจที่ถูกต้อง = ระบบต้องปฏิเสธการรับข้อมูลอ่อนไหว (ปิดแบบปลอดภัย) */
export async function vaultReady(env) { return (await keysOf(env)).length > 0; }
export const isSealed = v => typeof v === 'string' && v.startsWith(PREFIX);

/* เข้ารหัส: ข้อความ → "enc:v1:<รหัสกุญแจ>:<iv>:<ข้อมูล>" · context = ผูกกับเจ้าของ เช่น app:<uid> */
export async function seal(env, text, context) {
  const [k] = await keysOf(env);
  if (!k) throw Object.assign(new Error('vault_not_ready'), { vault: true });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(String(context)) }, k.key, enc.encode(String(text))));
  return `${PREFIX}${k.id}:${b64(iv)}:${b64(ct)}`;
}

/* ถอดรหัส · ค่าที่ยังไม่เคยเข้ารหัส (แถวเก่าก่อนมีระบบนี้) คืนตามเดิม ให้ระบบอ่านต่อได้ระหว่างย้ายข้อมูล
   ถอดไม่ได้ (กุญแจผิด/ข้อมูลถูกแก้/ถูกย้ายไปแถวอื่น) = โยนข้อผิดพลาด ห้ามเดาหรือคืนค่าว่างเงียบ ๆ */
export async function open(env, value, context) {
  if (!isSealed(value)) return value;
  const [, , kid, iv, ct] = value.split(':');
  const k = (await keysOf(env)).find(x => x.id === kid);
  if (!k) throw Object.assign(new Error('vault_key_missing'), { vault: true });
  try {
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(String(context)) }, k.key, unb64(ct)));
  } catch {
    throw Object.assign(new Error('vault_tampered'), { vault: true });
  }
}

/* รหัสของกุญแจปัจจุบัน (8 ตัว) — ใช้หาแถวที่ยังเข้ารหัสด้วยกุญแจเก่าหลังเปลี่ยนกุญแจ · ไม่มีกุญแจ = null */
export async function currentKeyId(env) { const [k] = await keysOf(env); return k ? k.id : null; }

/* ต้องเข้ารหัสใหม่ไหม (ยังไม่เข้ารหัส หรือเข้ารหัสด้วยกุญแจเก่า) — ใช้ตอนเก็บกวาด/เปลี่ยนกุญแจ */
export async function needsReseal(env, value) {
  if (value == null || value === '') return false;
  if (!isSealed(value)) return true;
  const [k] = await keysOf(env);
  return !!k && value.split(':')[2] !== k.id;
}

/* บริบทของแต่ละช่อง — ต้องตรงกันทั้งตอนเข้าและถอดรหัส */
export const CTX = {
  app: uid => 'cendon:app:' + uid,
  ident: uid => 'cendon:ident:' + uid,
  doc: (uid, kind) => 'cendon:doc:' + uid + ':' + kind,
};
