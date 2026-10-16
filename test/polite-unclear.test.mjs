/* ข้อความที่อ่านไม่ออก/พิมพ์มั่ว: คำสั่งระบบบังคับให้ตอบอย่างสุภาพ ไม่ตำหนิ ไม่เรียกว่าขยะ */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('chat identity prompt: unclear or random input gets a kind reply, never words like ขยะ/สแปม/ไร้สาระ',async()=>{
  const src=await readFile(new URL('../src/worker.js',import.meta.url),'utf8');
  const id=src.slice(src.indexOf('const IDENTITY = `'),src.indexOf('`;',src.indexOf('const IDENTITY = `')));
  assert.match(id,/\[ข้อความที่อ่านไม่ออก พิมพ์ผิด หรือไม่มีความหมาย\]/);
  for(const word of ['ขยะ','สแปม','ไร้สาระ'])assert.match(id,new RegExp('ห้าม[^\\n]*"'+word+'"'),word+' is explicitly forbidden');
  assert.match(id,/ชวนเล่าอาการรถ/);
});
