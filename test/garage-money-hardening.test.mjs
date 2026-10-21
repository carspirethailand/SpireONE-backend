import test from 'node:test';
import assert from 'node:assert/strict';
import rules from '../src/garage-rules.mjs';
const car={id:'car',make:'Toyota',model:'Vios',year:2020};
test('direct API records cannot bypass currency precision or custom-job ceilings',()=>{
  for(const amount of [Infinity,NaN,-1,1.234,1e20])assert.throws(()=>rules.money(amount,car,'oil'));
  assert.equal(rules.money('1,234.56',car,'oil'),1234.56);
  assert.throws(()=>rules.money(500001,car,'unknown'));
  assert.equal(rules.money(60000,{make:'Porsche',model:'911'},'oil'),60000);
  assert.throws(()=>rules.money(75001,{make:'Porsche',model:'911'},'oil'));
  assert.throws(()=>rules.money(400001,car,'unknown',{valueThb:400000}));
});
test('new custom jobs and symptoms reject obvious junk, preserving useful Thai terms and unchanged history',()=>{
  const bad=['อิอิอิอิ','ababab','lkjhgfdsa','ก'.repeat(61)];
  for(const title of bad)assert.throws(()=>rules.validateState('carlab_todo_car',[{title,dueKm:0,done:false}],[],car));
  const history=[{title:'old arbitrary entry',dueKm:0,done:false}];
  assert.deepEqual(rules.validateState('carlab_todo_car',history,history,car),history);
  for(const title of ['เปลี่ยนใบปัดน้ำฝน','ตรวจสอบรถยนต์','เช็กเบรก ABS'])assert.doesNotThrow(()=>rules.validateState('carlab_todo_car',[{title,dueKm:50000,done:false}],[],car));
});
