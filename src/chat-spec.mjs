/* สเปกรุ่นรถในแชต: ดึงสเปกที่คลังของ Cendon ค้นจากเอกสารอ้างอิงไว้แล้ว (car_specs) มาให้ AI ตอบตรงรุ่น
   ไม่เรียก AI เพิ่ม ไม่ค้นใหม่ ไม่หักโควตาค้นสเปก — มีในคลังก็ใช้ ไม่มีก็ไม่ใส่
   ใส่เฉพาะตอนคำถามเกี่ยวกับสเปก/การดูแลรถ (กันกินโทเคนทุกข้อความ)
   ข้อมูลที่เจ้าของรถบันทึกเอง (รุ่นย่อย เครื่อง เกียร์ ยาง ...) ใส่ทุกครั้งที่มี เพราะสั้นและช่วยเลือกรุ่นย่อยถูก
   ไม่ส่ง VIN ทะเบียน หรือจังหวัด ให้ผู้ให้บริการ AI — AI ไม่ต้องใช้ตอบเรื่องสเปก และระบุตัวรถ/เจ้าของได้ */

const SPEC_WORDS = /สเปก|สเปค|แรงม้า|แรงบิด|ซีซี|\bcc\b|เครื่องยนต์|เครื่อง|เกียร์|ยาง|ล้อ|แม็ก|ถังน้ำมัน|น้ำมัน|กี่ลิตร|ลิตร|กินน้ำมัน|สิ้นเปลือง|ประหยัด|ขนาด|ความยาว|ความกว้าง|ความสูง|ฐานล้อ|น้ำหนัก|ที่นั่ง|แบต|แบตเตอรี่|ชาร์จ|วิ่งได้กี่|ระยะทาง|ขับเคลื่อน|ขับหน้า|ขับหลัง|4wd|awd|ไฮบริด|ดีเซล|เบนซิน|อุปกรณ์|ถุงลม|ระบบช่วย|ความปลอดภัย|ออปชั่น|ออฟชั่น|รุ่นย่อย|เจเนอเรชัน|โฉม|ไซส์|เปลี่ยน|รอบ|ดูแล|บำรุง|อะไหล่|\bhp\b|\bps\b|horsepower|torque|spec|engine|gear|transmission|tyre|tire|wheel|fuel|tank|economy|mpg|battery|range|charge|weight|seat|dimension|safety|airbag|adas|trim|variant|oil|service|maintenance/i;
export const wantsSpec = q => SPEC_WORDS.test(String(q || ''));

/* ช่องที่ผู้ใช้บันทึกเองผ่านการ์ด car_info / ฟอร์มข้อมูลรถ — ไม่มี vin/plate/province โดยตั้งใจ */
const OWN = [['trim', 'รุ่นย่อย'], ['engine', 'เครื่อง'], ['engine_code', 'รหัสเครื่อง'], ['model_year', 'ปีรุ่น'],
  ['gear', 'เกียร์'], ['fuel', 'น้ำมัน'], ['drive', 'ขับเคลื่อน'], ['tire', 'ยาง']];
const clip = (s, n) => String(s == null ? '' : s).replace(/[\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function ownBlock(info) {
  if (!info || typeof info !== 'object') return '';
  const out = OWN.map(([k, l]) => { const v = clip(info[k], 60); return v ? `${l} ${v}` : ''; }).filter(Boolean);
  return out.length ? `ข้อมูลที่เจ้าของรถบันทึกเอง (ยังไม่ยืนยันกับเอกสาร): ${out.join(' · ')}` : '';
}

const FUEL = { petrol: 'เบนซิน', diesel: 'ดีเซล', hybrid: 'ไฮบริด', phev: 'ปลั๊กอินไฮบริด', ev: 'ไฟฟ้า', lpg: 'LPG' };
const UNIT = { cc: ' cc', hp: ' แรงม้า', torque_nm: ' Nm', l_per_100km: ' ลิตร/100 กม.', battery_kwh: ' kWh', range_km: ' กม.',
  seats: ' ที่นั่ง', doors: ' ประตู', length_mm: ' มม.', width_mm: ' มม.', height_mm: ' มม.', wheelbase_mm: ' มม.', kerb_kg: ' กก.', tank_l: ' ลิตร' };
const LBL = { cc: 'ความจุ', hp: 'กำลัง', torque_nm: 'แรงบิด', l_per_100km: 'อัตราสิ้นเปลือง', battery_kwh: 'แบตเตอรี่', range_km: 'วิ่งได้',
  seats: 'ที่นั่ง', doors: 'ประตู', length_mm: 'ยาว', width_mm: 'กว้าง', height_mm: 'สูง', wheelbase_mm: 'ฐานล้อ', kerb_kg: 'น้ำหนักรถเปล่า', tank_l: 'ถังน้ำมัน', tire: 'ยาง' };
Object.assign(UNIT,{boot_l:' L',turning_radius_m:' m',ground_clearance_mm:' mm',towing_braked_kg:' kg'});Object.assign(LBL,{boot_l:'สัมภาระ',turning_radius_m:'รัศมีวงเลี้ยว',ground_clearance_mm:'ระยะใต้ท้อง',towing_braked_kg:'ลากจูงแบบมีเบรก'});
const num = v => typeof v === 'number' ? v.toLocaleString('en-US') : clip(v, 40);
/* ✓ = สองรอบตรงกัน · (แหล่งเดียว) · ⚠ ขัดกันให้บอกทั้งสองค่า */
function cell(c, unit = '') {
  if (!c || c.v == null || c.v === '') return '';
  const v = num(c.v) + unit;
  if (c.ok === true) return v + ' ✓';
  if (c.ok === false) return `${v} ⚠ หรือ ${num(c.alt)}${unit}`;
  return v + ' (แหล่งเดียว)';
}

/* spec = ผลจาก getSpec() (row2out) · equip = ผลรายการอุปกรณ์ (ถ้ามี) */
export function specBlock(spec, equip) {
  const d = spec && ['ready', 'verified'].includes(spec.status) ? spec.data : null;
  const lines = [];
  if (d) {
    const head = [d.generation && `เจเนอเรชัน ${clip(d.generation, 60)}`, d.body && `ตัวถัง ${d.body}`, d.market && `ตลาดในเอกสาร ${clip(d.market, 30)}`]
      .filter(Boolean).join(' · ');
    lines.push(`${clip(spec.make, 40)} ${clip(spec.model, 40)} ปี ${clip(spec.year, 4)}${head ? ' · ' + head : ''} · ${spec.verified ? 'ทีมงานตรวจแล้ว' : 'ยังไม่ผ่านการตรวจโดยทีมงาน'}`);
    const vs = (Array.isArray(d.variants) ? d.variants : []).slice(0, 8).map(v => {
      const bits = [cell(v.engine), ...['cc', 'hp', 'torque_nm'].map(k => cell(v[k], UNIT[k])), cell(v.gearbox) && 'เกียร์ ' + cell(v.gearbox),
        cell(v.drive), FUEL[v.fuel] || '',cell(v.power_ps)&&'กำลัง PS: '+cell(v.power_ps,' PS'),cell(v.power_kw)&&'กำลัง kW: '+cell(v.power_kw,' kW'),...['engine_code','cylinders','valves','gears','induction','front_suspension','rear_suspension','front_brakes','rear_brakes','front_tire','rear_tire'].map(k=>cell(v[k])&&k+': '+cell(v[k])),cell(v.price_thb)&&'ราคาจำหน่ายเดิมตามเอกสาร ไม่ใช่มูลค่าปัจจุบัน: '+cell(v.price_thb,' THB'), cell(v.l_per_100km, UNIT.l_per_100km), cell(v.battery_kwh, UNIT.battery_kwh), cell(v.range_km) && 'วิ่งได้ ' + cell(v.range_km, UNIT.range_km)]
        .filter(Boolean);
      return bits.length ? `- ${clip(v.name, 60) || 'รุ่นย่อย'}: ${bits.join(' · ')}` : '';
    }).filter(Boolean);
    if (vs.length) lines.push('รุ่นย่อย/เครื่องยนต์:\n' + vs.join('\n'));
    const f = d.facts || {};
    const fs = ['tank_l', 'tire', 'kerb_kg', 'seats', 'doors', 'length_mm', 'width_mm', 'height_mm', 'wheelbase_mm','boot_l','turning_radius_m','ground_clearance_mm','towing_braked_kg']
      .map(k => { const c = cell(f[k], UNIT[k] || ''); return c ? `${LBL[k]} ${c}` : ''; }).filter(Boolean);
    if (fs.length) lines.push('ข้อมูลตัวรถ: ' + fs.join(' · '));
  }
  const eq = equip && ['ready', 'verified'].includes(equip.status) && Array.isArray(equip.data?.equipment) ? equip.data.equipment : [];
  if (eq.length) lines.push('อุปกรณ์ที่พบในเอกสาร (รุ่นย่อย/ตลาดอาจต่างกัน ไม่ได้ยืนยันว่าคันนี้มีครบ): '
    + eq.slice(0, 32).map(x => clip(x.name, 50) + (x.availability === 'optional' ? ' (ออปชัน)' : x.availability === 'standard' ? ' (มาตรฐาน)' : '') + (x.variant ? ` [${clip(x.variant, 30)}]` : '')).join(', '));
  if (!lines.length) return '';
  const sources=[...(spec?.sources||[]),...(equip?.sources||[])].filter(s=>s&&/^https:\/\//.test(s.url||''));
  const seen=new Set(),refs=sources.filter(s=>!seen.has(s.url)&&seen.add(s.url)).slice(0,8);
  if(refs.length)lines.push('เอกสารที่ใช้: '+refs.map(s=>clip(s.title||'Source',90)+' '+s.url.slice(0,500)).join('\n'));
  return `\n[สเปกรุ่นนี้จากคลังของ Cendon — สกัดจากเอกสารอ้างอิง]\n${lines.join('\n')}
วิธีใช้: ตอบเรื่องสเปกจากข้อมูลนี้ก่อน ✓ = สองแหล่งตรงกัน · (แหล่งเดียว) ให้บอกว่ายังยืนยันได้แหล่งเดียว · ⚠ แหล่งขัดกัน ให้บอกทั้งสองค่า
มีหลายรุ่นย่อย: เลือกรุ่นที่ตรงกับข้อมูลที่เจ้าของบันทึก ถ้ายังไม่รู้ว่าคันไหน บอกค่าของแต่ละรุ่นหรือถามรุ่นย่อย ห้ามเลือกเอง
สิ่งที่ไม่มีในนี้ (เช่น เบอร์/ปริมาณน้ำมันเครื่อง ลมยาง น้ำมันเกียร์ หัวเทียน) ค้นจากแหล่งที่เชื่อถือได้หรือแนะนำให้ดูคู่มือ/ป้ายข้างประตูคนขับ ห้ามเดาตัวเลข`;
}
