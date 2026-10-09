/* ══════════════════════════════════════════════════════════════════
   เลขตัวถัง (VIN) และข้อมูลเพิ่มเติมของรถ (ไม่บังคับกรอก)

   VIN 17 หลัก บอกได้แน่นอน: ประเทศที่ผลิต (หลัก 1–2) และผู้ผลิต (หลัก 1–3 = WMI)
   หลักที่ 10 คือรหัสปีรุ่น — มาตรฐานบังคับในอเมริกาเหนือ ผู้ผลิตหลายรายใช้ทั่วโลก แต่ไม่ทุกราย
   จึงเป็น "ปีตามรหัส (ใช้อ้างอิง)" ไม่ใช่ความจริงร้อยเปอร์เซ็นต์

   รายละเอียดเพิ่ม (รุ่น เครื่อง ตัวถัง) ถามฐานข้อมูล VIN ของ NHTSA (vPIC — ฟรี ไม่ต้องใช้คีย์)
   ซึ่งครบสำหรับรถตลาดอเมริกา ส่วนรถประกอบไทยมักได้แค่ชื่อผู้ผลิต — ถามไม่ได้ก็ยังได้ผลจากการถอดรหัสในเครื่อง
   ══════════════════════════════════════════════════════════════════ */

export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/* ประเทศตามมาตรฐาน ISO 3780 (เฉพาะช่วงที่แน่ใจ) */
const COUNTRY = [
  [/^J/, 'ญี่ปุ่น'], [/^K[L-R]/, 'เกาหลีใต้'], [/^L/, 'จีน'], [/^M[L-R]/, 'ไทย'], [/^M[A-E]/, 'อินเดีย'],
  [/^M[F-K]/, 'อินโดนีเซีย'], [/^P[L-R]/, 'มาเลเซีย'], [/^S[A-M]/, 'สหราชอาณาจักร'], [/^W/, 'เยอรมนี'],
  [/^V[F-R]/, 'ฝรั่งเศส'], [/^V[S-W]/, 'สเปน'], [/^Y[S-W]/, 'สวีเดน'], [/^Z[A-R]/, 'อิตาลี'],
  [/^[145]/, 'สหรัฐอเมริกา'], [/^2/, 'แคนาดา'], [/^3/, 'เม็กซิโก'], [/^6/, 'ออสเตรเลีย'], [/^9[A-E]/, 'บราซิล'],
];
/* ผู้ผลิตตามรหัส WMI — ใส่เฉพาะรหัสที่เป็นที่รู้กันแน่นอน ที่เหลือให้ vPIC ตอบ */
const WMI = [
  [/^JT/, 'Toyota'], [/^MR0/, 'Toyota (ไทย)'], [/^JH/, 'Honda'], [/^JN/, 'Nissan'], [/^JM/, 'Mazda'],
  [/^MPA/, 'Isuzu (ไทย)'], [/^KM[8H]/, 'Hyundai'], [/^KN/, 'Kia'], [/^WB[ASY]/, 'BMW'],
  [/^(WD[BCD]|W1[KNV])/, 'Mercedes-Benz'], [/^WV[W12]/, 'Volkswagen'], [/^WAU/, 'Audi'], [/^WP[01]/, 'Porsche'],
  [/^SAL/, 'Land Rover'], [/^SAJ/, 'Jaguar'], [/^SCF/, 'Aston Martin'], [/^ZFF/, 'Ferrari'], [/^YV/, 'Volvo'],
  [/^5YJ/, 'Tesla'],
];
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

export function decodeVin(raw, now = new Date()) {
  const vin = String(raw || '').toUpperCase().replace(/[\s-]/g, '');
  if (!VIN_RE.test(vin)) return { vin, valid: false, why: vin.length !== 17 ? 'ต้องมี 17 ตัวอักษร' : 'มีตัวอักษรที่ใช้ใน VIN ไม่ได้ (I, O, Q)' };
  const country = (COUNTRY.find(([re]) => re.test(vin)) || [])[1] || null;
  const maker = (WMI.find(([re]) => re.test(vin)) || [])[1] || null;
  const i = YEAR_CODES.indexOf(vin[9]);
  let year = null;
  if (i >= 0) { const y2 = 2010 + i, y1 = 1980 + i; year = y2 <= now.getUTCFullYear() + 1 ? y2 : y1; }
  return { vin, valid: true, wmi: vin.slice(0, 3), country, maker, year_hint: year };
}

/* ถาม vPIC (NHTSA) — ไม่เกิน 5 วินาที ได้แค่ไหนเอาแค่นั้น */
export async function vpic(vin) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`, { signal: ac.signal });
    if (!r.ok) return null;
    const x = ((await r.json()).Results || [])[0] || {};
    const v = (k) => { const s = String(x[k] == null ? '' : x[k]).trim(); return s && s !== '0' && !/^not applicable$/i.test(s) ? s.slice(0, 80) : null; };
    const out = { make: v('Make'), manufacturer: v('Manufacturer'), model: v('Model'), year: v('ModelYear'), body: v('BodyClass'),
      engine_l: v('DisplacementL'), cylinders: v('EngineCylinders'), fuel: v('FuelTypePrimary'), drive: v('DriveType'),
      trim: v('Trim'), plant_country: v('PlantCountry') };
    return Object.values(out).some(Boolean) ? out : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}

/* ข้อมูลเพิ่มเติมที่เจ้าของรถกรอกเอง (ไม่บังคับทุกช่อง) — รับเฉพาะคีย์ที่รู้จัก ตัดความยาว */
const INFO = { vin: 17, trim: 60, engine: 60, gear: 20, fuel: 20, plate: 20, province: 40, tax_due: 10, ins_due: 10, ins_co: 60, tire: 30, note: 300 };
export function cleanInfo(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  for (const [k, n] of Object.entries(INFO)) {
    if (o[k] == null) continue;
    let s = String(o[k]).normalize('NFC').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
    if (!s) continue;
    if (k === 'vin') { s = s.toUpperCase().replace(/[\s-]/g, ''); if (!VIN_RE.test(s)) continue; }
    if ((k === 'tax_due' || k === 'ins_due') && !/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;
    out[k] = s;
  }
  return Object.keys(out).length ? out : null;
}
