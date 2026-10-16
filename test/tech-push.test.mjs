/* แจ้งเตือนในเครื่อง (Web Push) สำหรับงานช่าง: จังหวะเดียวกับ LINE ส่งได้แม้ยังไม่ตั้ง LINE · ไม่มีเบอร์/ที่อยู่ */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,USER} from './tech-fixtures.mjs';
import {withMechanic,MECH} from './tech-safety.test.mjs';
import {pushOf} from '../src/techs.js';
import {card,jobCard} from '../src/line-notify.js';

test('push: a LINE card becomes a short device notification that opens the job, one per job',()=>{
  const j={id:'11111111-2222-3333-4444-555555555555',car:'Honda City 2019',symptom:'แอร์ไม่เย็น',area:'บางนา',requested_time:'วันนี้',mode:'shop',quote:JSON.stringify({total:1700,scope:'ล้างแอร์',appointment:'พรุ่งนี้'})};
  const p=pushOf(jobCard({APP_URL:'https://app.test'},'quote',j,'นนท์แอร์'));
  assert.equal(p.title,'นนท์แอร์ เสนอราคา ฿1,700');assert.match(p.body,/ได้ราคาแล้ว · Honda City 2019/);
  assert.equal(p.url,'/jobs/'+j.id);assert.equal(p.tag,'cendon-job-'+j.id);
  const q=pushOf(card({tag:'ทั่วไป',title:'สวัสดี',lines:['บรรทัด'],url:'https://app.test/garage?openExternalBrowser=1'}));
  assert.equal(q.url,'/garage');assert.equal(q.tag,'cendon');
});

test('push: a new request reaches the mechanic\'s devices even without LINE, and never carries phone or address',async()=>{
  const f=fixture();await withMechanic(f);const sent=[];
  f.env.pushTo=async(uid,p)=>{sent.push({uid,...p})};delete f.env.LINE_CHANNEL_TOKEN;
  const r=await f.call(USER,'/api/tech/jobs',{id:crypto.randomUUID(),techId:'t_mech',car:'Mazda 2 2019',symptom:'เบรกมีเสียงดังเวลาเหยียบ',area:'บางนา กรุงเทพ',address:'99/1 ซอยลับมาก บางนา',phone:'0812345678',requestedTime:'พรุ่งนี้ 10:00',mode:'shop'});
  assert.equal(r.status,200,r.error);
  for(let i=0;i<20&&!sent.length;i++)await new Promise(z=>setTimeout(z,10));
  assert.equal(sent.length,1);assert.equal(sent[0].uid,'mech');assert.match(sent[0].title,/Mazda 2/);assert.equal(sent[0].url,'/jobs/'+r.id);
  assert.doesNotMatch(JSON.stringify(sent),/0812345678|ซอยลับมาก/);
});
