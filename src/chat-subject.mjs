/* ══ รถที่ผู้ใช้ "กำลังถามถึง" ไม่ใช่รถในการาจเสมอไป ══
   ของเดิมทุกจุดใช้รถในการาจ: คำค้นเว็บถูกเติม "Honda City 2019" ข้างหน้า · คลังความรู้/สเปก/งานซ่อมจริงเป็นของ Honda
   ผู้ใช้ถามเรื่อง Tesla แต่ได้คำตอบเรื่องรถตัวเอง — ที่นี่ตัดสินด้วยกฎล้วน ๆ (ไม่เรียก AI เพิ่ม ไม่ช้าลง ไม่เพิ่มค่าใช้จ่าย)

   mode: own   = ถามถึงรถในการาจ (ใช้ข้อมูลรถในการาจเต็มที่ เหมือนเดิม)
         other = ถามถึงรถคันอื่น (ไม่ใส่สเปก/ประวัติของรถในการาจ คำค้นใช้รถคันที่ถาม)
         both  = เทียบรถคันอื่นกับรถในการาจ (ใส่ทั้งสอง บอกชัดว่าคันไหนเป็นคันไหน)
         none  = ไม่ได้พูดถึงรถคันไหน (รถในการาจเป็นแค่ข้อมูลประกอบ ไม่เติมลงคำค้นถ้าไม่ใช่เรื่องดูแลรถ) */

/* ยี่ห้อ: ชื่อมาตรฐาน → คำที่คนพิมพ์ (ไทย/อังกฤษ) */
const BRANDS = {
  Toyota: ['toyota', 'โตโยต้า', 'โตโยตา'], Honda: ['honda', 'ฮอนด้า'], Isuzu: ['isuzu', 'อีซูซุ', 'อีซูซู'], Nissan: ['nissan', 'นิสสัน'],
  Mazda: ['mazda', 'มาสด้า', 'มาสดา'], Mitsubishi: ['mitsubishi', 'มิตซูบิชิ', 'มิตซู'], Ford: ['ford', 'ฟอร์ด'], Chevrolet: ['chevrolet', 'chevy', 'เชฟโรเลต', 'เชฟ'],
  Suzuki: ['suzuki', 'ซูซูกิ'], Subaru: ['subaru', 'ซูบารุ'], Hyundai: ['hyundai', 'ฮุนได', 'ฮุนได'], Kia: ['kia', 'เกีย'],
  BMW: ['bmw', 'บีเอ็มดับเบิลยู', 'บีเอ็ม'], 'Mercedes-Benz': ['mercedes-benz', 'mercedes', 'benz', 'เบนซ์', 'เมอร์เซเดส'], Audi: ['audi', 'อาวดี้', 'ออดี้'],
  Volvo: ['volvo', 'วอลโว่'], Porsche: ['porsche', 'ปอร์เช่', 'ปอร์เช'], Lexus: ['lexus', 'เล็กซัส'], Mini: ['mini cooper', 'มินิ คูเปอร์'],
  Tesla: ['tesla', 'เทสล่า', 'เทสลา'], BYD: ['byd', 'บีวายดี'], MG: ['mg', 'เอ็มจี'], GWM: ['gwm', 'great wall', 'เกรท วอลล์', 'เกรทวอลล์'],
  Haval: ['haval', 'ฮาวาล'], ORA: ['ora', 'โอร่า'], Neta: ['neta', 'เนต้า'], Aion: ['aion', 'ไอออน'], Deepal: ['deepal', 'ดีพอล'],
  Zeekr: ['zeekr', 'ซีคร์'], Xpeng: ['xpeng', 'เสี่ยวเผิง'], Changan: ['changan', 'ฉางอาน'], Volkswagen: ['volkswagen', 'vw', 'โฟล์ค'],
  Peugeot: ['peugeot', 'เปอโยต์'], Jaguar: ['jaguar', 'จากัวร์'], 'Land Rover': ['land rover', 'range rover', 'แลนด์โรเวอร์', 'เรนจ์โรเวอร์'],
};
/* รุ่นที่พิมพ์มาโดยไม่มียี่ห้อ ("Model Y", "ยาริส", "Atto 3") → ยี่ห้อ */
const MODELS = [
  ['Tesla', 'Model 3', ['model 3', 'โมเดล 3', 'โมเดลทรี']], ['Tesla', 'Model Y', ['model y', 'โมเดล y', 'โมเดลวาย']], ['Tesla', 'Model S', ['model s']], ['Tesla', 'Model X', ['model x']], ['Tesla', 'Cybertruck', ['cybertruck', 'ไซเบอร์ทรัค']],
  ['BYD', 'Atto 3', ['atto 3', 'อัตโต้ 3', 'แอตโต้ 3']], ['BYD', 'Dolphin', ['dolphin', 'ดอลฟิน']], ['BYD', 'Seal', ['byd seal', 'ซีล']], ['BYD', 'Sealion', ['sealion', 'ซีไลออน']], ['BYD', 'M6', ['byd m6']],
  ['Toyota', 'Yaris', ['yaris', 'ยาริส']], ['Toyota', 'Vios', ['vios', 'วีออส']], ['Toyota', 'Corolla Cross', ['corolla cross', 'โคโรลล่า ครอส', 'ครอส']], ['Toyota', 'Corolla Altis', ['altis', 'อัลติส']],
  ['Toyota', 'Camry', ['camry', 'แคมรี่']], ['Toyota', 'Fortuner', ['fortuner', 'ฟอร์จูนเนอร์']], ['Toyota', 'Hilux Revo', ['revo', 'รีโว่', 'hilux', 'ไฮลักซ์']], ['Toyota', 'Alphard', ['alphard', 'อัลพาร์ด']], ['Toyota', 'Veloz', ['veloz', 'เวลอซ']],
  ['Honda', 'City', ['honda city', 'ฮอนด้า ซิตี้', 'ซิตี้']], ['Honda', 'Civic', ['civic', 'ซีวิค']], ['Honda', 'Accord', ['accord', 'แอคคอร์ด']], ['Honda', 'HR-V', ['hr-v', 'hrv', 'เอชอาร์วี']],
  ['Honda', 'CR-V', ['cr-v', 'crv', 'ซีอาร์วี']], ['Honda', 'Jazz', ['jazz', 'แจ๊ส']], ['Honda', 'BR-V', ['br-v', 'brv']], ['Honda', 'WR-V', ['wr-v', 'wrv']],
  ['Isuzu', 'D-Max', ['d-max', 'dmax', 'ดีแม็กซ์', 'ดีแมกซ์']], ['Isuzu', 'MU-X', ['mu-x', 'mux', 'มิว-เอ็กซ์', 'มิวเอ็กซ์']],
  ['Mazda', 'CX-5', ['cx-5', 'cx5']], ['Mazda', 'CX-3', ['cx-3', 'cx3']], ['Mazda', 'CX-30', ['cx-30', 'cx30']], ['Mazda', 'BT-50', ['bt-50', 'bt50']],
  ['Nissan', 'Almera', ['almera', 'อัลเมร่า']], ['Nissan', 'Navara', ['navara', 'นาวารา']], ['Nissan', 'Kicks', ['kicks', 'คิกส์']], ['Nissan', 'Terra', ['nissan terra']],
  ['Mitsubishi', 'Pajero Sport', ['pajero', 'ปาเจโร่']], ['Mitsubishi', 'Xpander', ['xpander', 'เอ็กซ์แพนเดอร์']], ['Mitsubishi', 'Triton', ['triton', 'ไทรทัน']], ['Mitsubishi', 'Attrage', ['attrage', 'แอททราจ']], ['Mitsubishi', 'Mirage', ['mirage', 'มิราจ']],
  ['Ford', 'Ranger', ['ranger', 'เรนเจอร์']], ['Ford', 'Everest', ['everest', 'เอเวอเรสต์']], ['Suzuki', 'Swift', ['swift', 'สวิฟท์']], ['Suzuki', 'Ciaz', ['ciaz', 'เซียส']],
  ['MG', 'ZS', ['mg zs']], ['MG', 'MG4', ['mg4', 'mg 4']], ['MG', 'MG5', ['mg5', 'mg 5']], ['ORA', 'Good Cat', ['good cat', 'กู๊ดแคท']], ['Haval', 'H6', ['haval h6']], ['Haval', 'Jolion', ['jolion', 'โจไลอ้อน']],
  ['Neta', 'V', ['neta v']], ['Hyundai', 'Staria', ['staria', 'สตาเรีย']], ['Hyundai', 'Creta', ['creta', 'เครต้า']],
];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/* คำภาษาอังกฤษต้องเป็นคำเดี่ยว ("ora" ห้ามไปเจอใน "corolla") · คำไทยไม่มีช่องว่างคั่นคำ จับตามตัวอักษร */
const term = a => /^[\x00-\x7f]+$/.test(a) ? `(?<![a-z0-9])${esc(a).replace(/\\-|\s/g, '[\\s-]?')}(?![a-z0-9])` : esc(a);
const BRAND_RE = Object.entries(BRANDS).map(([make, al]) => [make, new RegExp(al.map(term).join('|'), 'i')]);
const MODEL_RE = MODELS.map(([make, model, al]) => [make, model, new RegExp(al.map(term).join('|'), 'i')]);
const canon = make => { const m = String(make || '').trim().toLowerCase(); if (!m) return ''; for (const [k, al] of Object.entries(BRANDS)) if (k.toLowerCase() === m || al.includes(m)) return k; return String(make).trim() };

/* หา "รถคันที่พูดถึง" ในข้อความ: รุ่นก่อน (เจาะจงกว่า) แล้วค่อยยี่ห้อ · ไม่เจอ = null */
export function detectCar(text) {
  const t = String(text || '').normalize('NFC');
  if (!t.trim()) return null;
  for (const [make, model, re] of MODEL_RE) if (re.test(t)) return { make, model };
  for (const [make, re] of BRAND_RE) if (re.test(t)) return { make, model: '' };
  return null;
}
const lower = s => String(s || '').toLowerCase().replace(/[\s-]/g, '');
export function sameCar(a, garage) {
  if (!a || !garage || !(garage.make || garage.model)) return false;
  const gm = canon(garage.make);
  if (gm && a.make && gm !== a.make) return false;
  if (!gm && !(a.model && lower(garage.model).includes(lower(a.model)))) return false;
  return !a.model || !garage.model || lower(garage.model).includes(lower(a.model)) || lower(a.model).includes(lower(garage.model));
}

const OWN = /รถ(ของ)?(ผม|ฉัน|หนู|เรา|กู|ข้า|ดิฉัน|พี่|ตัวเอง)|คันนี้|คันของ(ผม|ฉัน)|รถที่บ้าน|\bmy (car|vehicle|truck)\b|\bour (car|vehicle)\b/i;
const COMPARE = /เทียบ|เปรียบเทียบ|ดีกว่า|คุ้มกว่า|ต่างกัน|แทนรถ|เปลี่ยนจาก|เปลี่ยนเป็น|\bvs\.?\b|versus|compare|better than/i;
/* เรื่องดูแล/อาการ = ถ้าไม่ได้บอกคันอื่น ก็คือรถของเขาเอง */
const CARE = /อาการ|เสียง|สั่น|รั่ว|ไฟโชว์|ไฟเตือน|สตาร์ท|ดับ|กระตุก|ร้อน|ควัน|เปลี่ยนถ่าย|น้ำมันเครื่อง|เช็กระยะ|เช็คระยะ|ยาง|แบต|เบรก|แอร์|เกียร์|ช่วงล่าง|ซ่อม|บำรุง|อะไหล่|เลขไมล์|กินน้ำมัน|ประกัน|พ\.ร\.บ|ต่อภาษี|warning|noise|leak|service|maintenance|repair/i;

export const carName = c => [c && c.make, c && c.model, c && c.year].filter(Boolean).join(' ').trim();

/* ตัดสินว่าคำถามรอบนี้พูดถึงรถคันไหน · prior = ข้อความของผู้ใช้ก่อนหน้า (ใหม่สุดก่อน) ไว้ตามคำถามต่อเนื่อง ("แล้วรุ่นนี้ราคาเท่าไหร่") */
export function resolveSubject(question, garage, prior = []) {
  const q = String(question || ''), hasGarage = !!(garage && (garage.make || garage.model));
  const own = OWN.test(q), mentioned = detectCar(q);
  if (mentioned && !sameCar(mentioned, garage)) return { mode: hasGarage && (own || COMPARE.test(q)) ? 'both' : 'other', subject: mentioned, via: 'question' };
  if (mentioned || own) return { mode: hasGarage ? 'own' : 'none', subject: hasGarage ? garage : mentioned, via: 'question' };
  for (const p of prior.slice(0, 4)) {
    const d = detectCar(p);
    if (!d) continue;
    if (sameCar(d, garage)) break;
    return { mode: hasGarage && COMPARE.test(q) ? 'both' : 'other', subject: d, via: 'history' };
  }
  if (hasGarage && CARE.test(q)) return { mode: 'own', subject: garage, via: 'care' };
  return { mode: 'none', subject: hasGarage ? garage : null, via: 'default' };
}

/* รถที่ใช้เติมคำค้นเว็บ: คันที่ถาม · ไม่ได้พูดถึงรถ = ไม่เติม (เช่น "ราคาน้ำมันวันนี้" ไม่ต้องมี Honda City นำหน้า) */
export function searchCarFor(subj) {
  if (!subj) return null;
  if (subj.mode === 'other' || subj.mode === 'both' || subj.mode === 'own') return subj.subject || null;
  return null;
}

/* บล็อกในคำสั่งระบบ — บอกโมเดลชัด ๆ ว่ารอบนี้ถามถึงคันไหน และรถในการาจใช้เมื่อไร */
export function subjectBlock(subj, garage) {
  const g = garage && (garage.make || garage.model) ? `${carName(garage)}${garage.mileage ? ` เลขไมล์ ${garage.mileage} กม.` : ''}` : '';
  if (subj.mode === 'other') return `\n[รถที่ผู้ใช้ถามถึงรอบนี้] ${carName(subj.subject)}
คำถามนี้เป็นเรื่องรถคันนี้ ไม่ใช่รถของผู้ใช้ ตอบเรื่อง ${carName(subj.subject)} เท่านั้น${g ? `
[รถในการาจของผู้ใช้ — ข้อมูลประกอบ] ${g} · ห้ามตอบเรื่องรถคันนี้ เว้นแต่ผู้ใช้ขอเทียบหรือถามถึงเอง` : ''}`;
  if (subj.mode === 'both') return `\n[ผู้ใช้ขอเทียบรถสองคัน]
คันที่ถามถึง: ${carName(subj.subject)}
รถของผู้ใช้เอง: ${g}
บอกให้ชัดเสมอว่าข้อมูลไหนเป็นของคันไหน`;
  if (subj.mode === 'own') return g ? `\n[รถที่กำลังคุยถึง]\nรถของผู้ใช้: ${carName(garage)} ปี ${garage.year || '-'} เลขไมล์ ${garage.mileage || '-'} กม.` : '';
  return g ? `\n[รถในการาจของผู้ใช้ — ใช้เมื่อคำถามเกี่ยวกับรถของเขา] ${g}` : '';
}
