import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './tech-fixtures.mjs';
import worker from '../src/worker.js';

/* รถในการาจ: สีและประเภทตัวถังเก็บข้ามเครื่องได้ และส่งรถคันเดิมซ้ำเพื่อเปลี่ยนสีได้ */
function setup(){
  const f=fixture({DEV_AUTH:'1',FIREBASE_PROJECT_ID:'unit-test'});
  f.sqlite.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT); INSERT INTO config VALUES ('schema_version','999');
    CREATE TABLE cars (id TEXT PRIMARY KEY, uid TEXT NOT NULL, make TEXT NOT NULL, model TEXT NOT NULL, year TEXT, mileage TEXT, created_at INTEGER NOT NULL, color TEXT, body TEXT);`);
  const call=async(method,path,body)=>{const r=await worker.fetch(new Request('https://api.unit.test'+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer dev:cust:cust@unit.test'},body:body&&JSON.stringify(body)}),f.env,{waitUntil(){}});return {status:r.status,json:await r.json()}};
  return {f,call};
}

test('cars: color and body type are saved, and re-sending the same car changes only what is sent',async()=>{
  const {call}=setup();
  let r=await call('POST','/api/cars',{id:'c1',make:'Honda',model:'Civic',year:'2021',mileage:'61200',color:'#d64545',body:'sedan'});
  assert.equal(r.status,200);assert.equal(r.json.color,'#D64545');
  r=await call('POST','/api/cars',{id:'c1',make:'Honda',model:'Civic',year:'2021',mileage:'62000'});
  let [c]=(await call('GET','/api/cars')).json;
  assert.equal(c.color,'#D64545','no color sent = keep the old one');assert.equal(c.body,'sedan');assert.equal(c.mileage,'62000');
  await call('POST','/api/cars',{id:'c1',make:'Honda',model:'Civic',color:'#4F8FD9'});
  [c]=(await call('GET','/api/cars')).json;assert.equal(c.color,'#4F8FD9');
  await call('POST','/api/cars',{id:'c2',make:'X',model:'Y',color:'red;drop',body:'tank'});
  const c2=(await call('GET','/api/cars')).json.find(x=>x.id==='c2');assert.equal(c2.color,null);assert.equal(c2.body,null,'unknown values are ignored');
});
