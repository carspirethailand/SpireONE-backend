import {test} from 'node:test';
import assert from 'node:assert/strict';
import {detectCar,resolveSubject,searchCarFor,subjectBlock} from '../src/chat-subject.mjs';
import {chatSearchQuery} from '../src/web-search.mjs';
import {generateChatAnswer} from '../src/worker.js';
import {unpark} from '../src/fastai.js';

/* ถามถึงรถคันอื่น ต้องได้คำตอบเรื่องคันนั้น ไม่ใช่รถในการาจ — ทุกอย่างในเทสต์เป็นข้อมูลจำลอง */
const garage={make:'Honda',model:'City',year:'2019',mileage:'80000'};

test('the car being asked about is told apart from the garage car (Thai and English names, models without brand, follow-ups)',()=>{
  const m=(q,prior)=>resolveSubject(q,garage,prior).mode;
  assert.equal(m('ค้นเรื่อง Tesla Model Y ให้หน่อย'),'other');assert.equal(m('เทสล่าชาร์จนานไหม'),'other');
  assert.equal(m('Atto 3 วิ่งได้กี่โล'),'other');assert.equal(resolveSubject('Atto 3 วิ่งได้กี่โล',garage).subject.make,'BYD');
  assert.equal(m('แอร์ไม่เย็น'),'own','a symptom with no other car named is about the garage car');
  assert.equal(m('รถผมกินน้ำมันไหม'),'own');assert.equal(m('ซิตี้ เปลี่ยนน้ำมันเครื่องกี่โล'),'own','the garage car named in Thai is still the garage car');
  assert.equal(m('Model 3 กับรถผมอะไรคุ้มกว่า'),'both');
  assert.equal(m('ราคาน้ำมันวันนี้'),'none');
  assert.equal(m('แล้วรุ่นนี้ราคาเท่าไหร่',['ค้นเรื่อง Tesla Model Y ให้หน่อย']),'other','a follow-up stays on the car from the previous question');
  assert.equal(m('แล้วรุ่นนี้ราคาเท่าไหร่',['แอร์ City ไม่เย็น','Tesla Model Y ดีไหม']),'other');
  assert.equal(detectCar('corolla cross hybrid ดีไหม').model,'Corolla Cross');
  assert.equal(detectCar('ขับไปเที่ยวโคราช'),null,'"ora" inside other words is not the ORA brand');
});

test('web search adds the asked-about car, never the garage car in front of another car; unrelated questions get no car',()=>{
  assert.equal(chatSearchQuery('Tesla Model Y ชาร์จนานไหม',garage),'Tesla Model Y ชาร์จนานไหม');
  assert.equal(chatSearchQuery('เทสล่าชาร์จนานไหม',garage),'เทสล่าชาร์จนานไหม');
  assert.equal(chatSearchQuery('แอร์ไม่เย็น',garage),'Honda City 2019 แอร์ไม่เย็น');
  assert.equal(searchCarFor(resolveSubject('ราคาน้ำมันวันนี้',garage)),null);
  assert.equal(searchCarFor(resolveSubject('เทสล่าชาร์จนานไหม',garage)).make,'Tesla');
});

test('the prompt names the asked-about car and keeps the garage car to the side (no mileage/history as if it were the subject)',()=>{
  const other=subjectBlock(resolveSubject('Tesla Model Y ดีไหม',garage),garage);
  assert.match(other,/\[รถที่ผู้ใช้ถามถึงรอบนี้\] Tesla Model Y/);assert.match(other,/ห้ามตอบเรื่องรถคันนี้ เว้นแต่ผู้ใช้ขอเทียบ/);
  assert.doesNotMatch(other,/\[รถที่กำลังคุยถึง\]/);
  const both=subjectBlock(resolveSubject('Model 3 กับรถผมอะไรคุ้มกว่า',garage),garage);assert.match(both,/คันที่ถามถึง: Tesla Model 3/);assert.match(both,/รถของผู้ใช้เอง: Honda City 2019/);
  assert.match(subjectBlock(resolveSubject('แอร์ไม่เย็น',garage),garage),/\[รถที่กำลังคุยถึง\]\nรถของผู้ใช้: Honda City/);
});

test('real chat path: asking about Tesla searches Tesla and tells the model so, while the garage car stays a side note',async t=>{
  unpark();const searches=[],systems=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{const u=String(url);
    if(/api\.tavily\.com/.test(u)){searches.push(JSON.parse(init.body).query);return Response.json({results:[{title:'Tesla',url:'https://www.tesla.com/th_th/model-y',content:'ชาร์จเร็ว'}]})}
    if(/generativelanguage/.test(u)){systems.push(JSON.parse(init.body).systemInstruction?.parts?.[0]?.text||'');return new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text:'Model Y ชาร์จเร็วสุดราว 30 นาที'}]},finishReason:'STOP'}]})+'\n\n')}
    throw Error('unexpected '+u)});
  const env={GEMINI_KEY:'fixture-only',TAVILY_API_KEY:'tvly-fixture-only',DB:{prepare(){return {bind(){return this},async first(){return null},async run(){return {}},async all(){return {results:[]}}}}}};
  const body={make:'Honda',model:'City',year:'2019',mileage:'80000',contents:[{role:'user',parts:[{text:'ค้นข้อมูลล่าสุดเรื่อง Tesla Model Y ชาร์จนานไหม'}]}]};
  const ev=[];await generateChatAnswer(env,{payload:{sub:'fixture'},role:'user'},body,async e=>ev.push(e));
  assert.ok(searches.length>=1);for(const q of searches){assert.match(q,/Tesla/);assert.doesNotMatch(q,/Honda|City/)}
  assert.match(systems[0],/\[รถที่ผู้ใช้ถามถึงรอบนี้\] Tesla Model Y/);assert.doesNotMatch(systems[0],/\[รถที่กำลังคุยถึง\]/);
  const car=ev.find(e=>e.type==='step'&&e.id==='car'&&e.state==='done');assert.equal(car.car,'Tesla Model Y');assert.equal(car.other,true);
  unpark();
});
