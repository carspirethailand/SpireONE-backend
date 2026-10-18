/* หมุดตำแหน่งรถ: ต้องอยู่บนบก และไม่ไกลจากเครื่องของคนกรอก (กันคนกวนลากหมุดไปกลางทะเล/แม่น้ำ หรือไปจังหวัดอื่น)
   น้ำ: อ่านสีพิกเซลใต้หมุดจากแผ่นแผนที่ OSM ซูม 17 (น้ำทุกชนิดเป็นฟ้า #aad3df — ทะเล แม่น้ำ คลอง บึง) ตรวจ 5×5 จุดรอบหมุด
        สะพานวาดเป็นถนนทับน้ำ = ไม่นับเป็นน้ำ · โหลดแผ่นไม่ได้/อ่านไม่ออก = ปล่อยผ่าน (คนจริงไม่ควรโดนบล็อกเพราะแผนที่ล่ม)
   รัศมี: หน้าเว็บส่งพิกัด GPS ของเครื่องตอนกรอกมาด้วย (gps) → หมุดห่างได้ไม่เกิน 1.5 กม. (ด่วน — รถเสียอยู่ตรงนั้น)
        หรือ 20 กม. (ไม่ด่วน — เช่น อยู่ที่ทำงาน รถจอดที่บ้าน) + ความคลาดเคลื่อนของ GPS ไม่เกิน 3 กม.
   PIN_WATER_OFF = ปิดการตรวจน้ำ (เช่น แผ่นแผนที่ใช้ไม่ได้ชั่วคราว) */
export const PIN_KM = { urgent: 1.5, normal: 20 };
const WATER = [170, 211, 223], Z = 17;

export function distKm(a, b) {
  const r = Math.PI / 180, x = (b.lat - a.lat) * r, y = (b.lng - a.lng) * r;
  const q = Math.sin(x / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(y / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(Math.max(0, 1 - q)));
}

/* แผ่นแผนที่และพิกเซลที่หมุดตกอยู่ (Web Mercator มาตรฐาน) */
export function tileOf(lat, lng, z = Z) {
  const n = 2 ** z, la = lat * Math.PI / 180;
  const x = (lng + 180) / 360 * n, y = (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n;
  const tx = Math.floor(x), ty = Math.floor(y);
  return { z, x: tx, y: ty, px: Math.min(255, Math.floor((x - tx) * 256)), py: Math.min(255, Math.floor((y - ty) * 256)) };
}

async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/* ถอด PNG พอให้อ่านสีได้: 8 บิตทุกแบบสี + พาเลต 1/2/4/8 บิต · ไม่รองรับแบบสลับบรรทัด (interlace) → null */
export async function decodePng(buf) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 33 || b[1] !== 80 || b[2] !== 78 || b[3] !== 71) return null;
  let o = 8, w = 0, h = 0, depth = 0, type = 0, lace = 0, pal = null;
  const idat = [];
  while (o + 8 <= b.length) {
    const len = dv.getUint32(o), kind = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), d = b.subarray(o + 8, o + 8 + len);
    if (kind === 'IHDR') { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); depth = b[o + 16]; type = b[o + 17]; lace = b[o + 20]; }
    else if (kind === 'PLTE') pal = d;
    else if (kind === 'IDAT') idat.push(d);
    else if (kind === 'IEND') break;
    o += len + 12;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!w || !h || lace || !ch || (type === 3 ? ![1, 2, 4, 8].includes(depth) || !pal : depth !== 8)) return null;
  const all = new Uint8Array(idat.reduce((n, x) => n + x.length, 0));
  idat.reduce((at, x) => (all.set(x, at), at + x.length), 0);
  const raw = await inflate(all);
  const row = Math.ceil(w * ch * depth / 8), bpp = Math.max(1, ch * depth / 8);
  if (raw.length < (row + 1) * h) return null;
  const px = new Uint8Array(row * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (row + 1)], src = raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1)), cur = px.subarray(y * row, (y + 1) * row);
    const up = y ? px.subarray((y - 1) * row, y * row) : null;
    for (let i = 0; i < row; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, c = up ? up[i] : 0, cc = up && i >= bpp ? up[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += c; else if (f === 3) v += (a + c) >> 1;
      else if (f === 4) { const p = a + c - cc, pa = Math.abs(p - a), pb = Math.abs(p - c), pc = Math.abs(p - cc); v += pa <= pb && pa <= pc ? a : pb <= pc ? c : cc; }
      cur[i] = v & 255;
    }
  }
  const rgb = (x, y) => {
    if (type === 3) {
      const bit = x * depth, byte = px[y * row + (bit >> 3)], idx = (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      return [pal[idx * 3], pal[idx * 3 + 1], pal[idx * 3 + 2]];
    }
    const i = y * row + x * ch;
    return ch < 3 ? [px[i], px[i], px[i]] : [px[i], px[i + 1], px[i + 2]];
  };
  return { w, h, rgb };
}

/* true = หมุดอยู่ในน้ำ · false = บนบก · null = ตรวจไม่ได้ (ปล่อยผ่าน) */
export async function waterAt(env, lat, lng) {
  if (env.PIN_WATER_OFF) return null;
  const t = tileOf(lat, lng), url = `https://tile.openstreetmap.org/${t.z}/${t.x}/${t.y}.png`;
  try {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 2500);
    let r;
    try { r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Cendon/1.0 (+https://cendon.app; pin check)' }, cf: { cacheTtl: 604800, cacheEverything: true } }); }
    finally { clearTimeout(timer); }
    if (!r.ok) return null;
    const img = await decodePng(await r.arrayBuffer());
    if (!img) return null;
    let wet = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = Math.min(img.w - 1, Math.max(0, t.px + dx)), y = Math.min(img.h - 1, Math.max(0, t.py + dy)), c = img.rgb(x, y);
      n++; if (c.every((v, i) => Math.abs(v - WATER[i]) <= 8)) wet++;
    }
    return wet / n >= 0.6;
  } catch { return null; }
}

/* ตรวจหมุดก่อนบันทึกงาน — fail(400, ข้อความที่บอกผู้ใช้ได้ตรง ๆ) */
export async function pinCheck(env, fail, pin, gps, urgent) {
  const g = gps && typeof gps === 'object' ? { lat: Number(gps.lat), lng: Number(gps.lng), acc: Number(gps.acc) || 0 } : null;
  if (g && Number.isFinite(g.lat) && Number.isFinite(g.lng) && Math.abs(g.lat) <= 90 && Math.abs(g.lng) <= 180) {
    const max = (urgent ? PIN_KM.urgent : PIN_KM.normal) + Math.min(Math.max(0, g.acc), 3000) / 1000;
    if (distKm(pin, g) > max) fail(400, `ตำแหน่งรถ: หมุดอยู่ไกลจากตำแหน่งของคุณเกิน ${urgent ? '1.5' : '20'} กม. — เลื่อนหมุดให้ตรงที่รถจอดอยู่`);
  }
  if (await waterAt(env, pin.lat, pin.lng)) fail(400, 'ตำแหน่งรถ: หมุดอยู่ในน้ำ — เลื่อนหมุดให้อยู่บนถนนหรือที่จอดรถ');
}
