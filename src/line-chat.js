/* ══════════════════════════════════════════════════════════════════
   แชต LINE ของ Cendon — ตัวช่วยที่ไม่แตะฐานข้อมูล (แยกไว้ให้เทสต์ง่าย)
   ส่วนที่คุยกับฐานข้อมูลและ LINE อยู่ใน worker.js (lineHandleText, lineAsk)
   ══════════════════════════════════════════════════════════════════ */
import { fastAnswer } from './fastai.js';

/* ─────────── รหัสเชื่อมบัญชีที่ส่งมาในแชต ───────────
   หยิบเป็นรหัสเฉพาะเมื่อตั้งใจส่งรหัสจริง: มีคำว่า "รหัส"/code (ข้อความที่แอปเตรียมให้)
   หรือพิมพ์มาแค่รหัสอย่างเดียว — คำอังกฤษธรรมดาอย่าง PLEASE, BRAKES หน้าตาเหมือนรหัส ห้ามหยิบมั่ว
   (ตัวอักษรชุดเดียวกับ newCode: ไม่มี I O 0 1) */
export function lineCodeIn(text) {
  const s = String(text || '').trim();
  if (/^[A-HJ-NP-Z2-9]{6}$/.test(s) || /^(?=.*[2-9])[a-hj-np-z2-9]{6}$/i.test(s)) return s.toUpperCase();
  if (/รหัส|code/i.test(s)) {
    const m = s.toUpperCase().match(/(?:^|[^A-Z0-9])([A-HJ-NP-Z2-9]{6})(?![A-Z0-9])/);
    if (m) return m[1];
  }
  return null;
}

/* ตัวเรียก AI — เทสต์สลับ ask เป็นตัวปลอมได้ ไม่ต้องยิง AI จริง */
export const LINE_AI = { ask: (env, opts) => fastAnswer(env, opts), timeoutMs: 25000 };

export const LINE_TALK = `[คุยผ่าน LINE]
คำตอบนี้จะขึ้นในแชต LINE ซึ่งไม่รองรับการจัดรูปแบบ:
- เขียนเป็นข้อความธรรมดา ห้ามใช้ markdown (ห้าม ** __ # ตาราง หรือบล็อกโค้ด)
- รายการให้ขึ้นบรรทัดใหม่ด้วย "• " ย่อหน้าสั้น
- สั้นกว่าในแอป ปกติไม่เกิน 8 บรรทัด เรื่องยาวให้บอกสิ่งสำคัญที่สุดก่อน
- ห้ามใช้บล็อก [[ASK]] ถ้าต้องการข้อมูลเพิ่มให้ถามเป็นประโยคธรรมดา 1 คำถาม

[ค้นหาช่างใน Cendon] ถ้าผู้ใช้อยากหาหรือจ้างช่าง ร้าน หรือบริการ หรือคุณแนะนำให้เอารถไปให้ช่างดู ให้ปิดท้ายคำตอบด้วยบรรทัดเดียวรูปแบบนี้: [[ค้นหา: คำค้นสั้น ๆ]] เช่น [[ค้นหา: เปลี่ยนผ้าเบรก]] ระบบจะใส่ปุ่มเปิดรายชื่อช่างของ Cendon ให้เอง
แนะนำได้เฉพาะช่างใน Cendon เท่านั้น ห้ามแนะนำอู่ ร้าน ศูนย์บริการ เว็บไซต์ หรือแอปอื่นนอก Cendon (รวมถึงที่เจอจากการค้นเว็บ) ห้ามแต่งชื่อร้าน ราคา หรือรีวิวขึ้นเอง`;

export const LINE_MARK = /\[\[\s*(?:ค้นหา|search)\s*:\s*([^\]\n]{1,60})\]\]/i;

/* LINE แสดงข้อความดิบ — แปลง markdown ที่หลุดมาให้อ่านง่ายแทนที่จะเห็นดอกจันเต็มจอ */
export function linePlain(t) {
  return String(t || '')
    .replace(/\[\[ASK\]\][\s\S]*?(\[\[\/ASK\]\]|$)/g, '')
    .replace(new RegExp(LINE_MARK.source, 'gi'), '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/^\|(.*)\|\s*$/gm, (m, row) => row.split('|').map((x) => x.trim()).filter(Boolean).join(' · '))
    .replace(/^[\s\-:·|]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ข้อความ LINE ยาวได้ไม่เกิน 5,000 ตัว — ตัดที่ย่อหน้า ไม่เกิน 2 ข้อความ */
export function lineChunks(t) {
  const out = [];
  let rest = t;
  while (rest && out.length < 2) {
    if (rest.length <= 4800) { out.push(rest); break; }
    let cut = rest.lastIndexOf('\n\n', 4800);
    if (cut < 2000) cut = 4800;
    out.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  return out;
}
