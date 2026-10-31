import test from 'node:test';
import assert from 'node:assert/strict';
import { featuresBlock } from '../src/fastai.js';

/* Intelligent UI: คำสั่งให้ AI ประกอบหน้าจอในแชต ([[UI]]) — ต้องตรงกับชิ้นส่วนที่หน้าเว็บ (ai-ui.js) รู้จัก */
const ALLOWED = new Set(['card', 'row', 'col', 'grid', 'divider', 'h', 'text', 'badge', 'stat', 'meter', 'gauge', 'range', 'list', 'steps', 'timeline', 'table', 'alert', 'checklist', 'choices', 'button', 'buttons', 'shops']);
const f = featuresBlock();

test('the app chat prompt teaches the [[UI]] block with a text answer first', () => {
  assert.match(f, /\[\[UI\]\]\{"blocks":\[ \.\.\.ชิ้นส่วน\.\.\. \]\}\[\[\/UI\]\]/);
  assert.match(f, /ให้เขียนคำตอบสั้น ๆ เป็นข้อความก่อน 1–3 ประโยค \(ต้องอ่านรู้เรื่องแม้ไม่มีหน้าจอ\)/);
  assert.match(f, /ใช้ \[\[UI\]\] ได้บล็อกเดียวต่อคำตอบ วางก่อน \[\[NEXT\]\]/);
});

test('safety and honesty rules travel with the UI contract', () => {
  assert.match(f, /shops\{cat,q,title,limit:1-3\} = ระบบใส่ร้านจริงในรายชื่อ Cendon ให้เอง — ห้ามแต่งชื่อร้าน/);
  assert.match(f, /ห้ามแต่งให้ดูแม่น/);
  assert.match(f, /ใส่ alert tone "danger" บอกให้หยุดขับ\/เรียกช่าง/);
  assert.match(f, /ไม่มีลิงก์ออกนอกแอป ไม่มี HTML\/โค้ด/);
  assert.match(f, /act ได้แค่: \{"do":"ask"/);
});

test('the worked example is valid JSON built only from parts the app can draw', () => {
  const m = f.match(/ตัวอย่างวินิจฉัย: \[\[UI\]\]([\s\S]*?)\[\[\/UI\]\]/);
  assert.ok(m, 'example present');
  const ui = JSON.parse(m[1]);
  const walk = n => { assert.ok(ALLOWED.has(n.t), n.t); (n.children || []).forEach(walk); };
  ui.blocks.forEach(walk);
  assert.ok(ui.blocks.some(b => b.t === 'shops'), 'example shows real shops, not invented ones');
});
