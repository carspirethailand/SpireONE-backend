/* หมุดตำแหน่งรถ: ต้องอยู่บนบก และไม่ไกลจากเครื่องของคนกรอก */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {fixture,USER} from './tech-fixtures.mjs';
import {withMechanic,post} from './tech-safety.test.mjs';
import {decodePng,tileOf,waterAt,distKm} from '../src/geo-guard.js';

/* แผ่นแผนที่ทดสอบ 256×256: ครึ่งซ้ายเป็นบก (ครีม) ครึ่งขวาเป็นน้ำ (#aad3df) · palette = แบบพาเลต 8 บิตเหมือนแผ่น OSM จริง */
function tile({palette=true,filter=0}={}){
  const crc=b=>{let c=0xffffffff;for(const n of b){c^=n;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
  const chunk=(k,d)=>{const t=Buffer.from(k),b=Buffer.alloc(d.length+12);b.writeUInt32BE(d.length);t.copy(b,4);d.copy(b,8);b.writeUInt32BE(crc(Buffer.concat([t,d])),b.length-4);return b;};
  const W=256,H=256,land=[242,239,233],water=[170,211,223],ch=palette?1:3,head=Buffer.alloc(13);
  head.writeUInt32BE(W);head.writeUInt32BE(H,4);head[8]=8;head[9]=palette?3:2;
  const raw=Buffer.alloc((W*ch+1)*H);
  for(let y=0;y<H;y++){raw[y*(W*ch+1)]=filter;const row=Buffer.alloc(W*ch);
    for(let x=0;x<W;x++){const c=x<128?land:water;if(palette)row[x]=x<128?0:1;else c.forEach((v,i)=>row[x*3+i]=v);}
    /* filter 1 (Sub): เก็บผลต่างจากพิกเซลซ้าย — ทดสอบว่าถอดตัวกรองถูก */
    for(let i=0;i<row.length;i++)raw[y*(W*ch+1)+1+i]=filter===1?(row[i]-(i>=ch?row[i-ch]:0))&255:row[i];}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),...(palette?[chunk('PLTE',Buffer.from([...land,...water]))]:[]),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
/* หาพิกัดที่ตกครึ่งซ้าย/ขวาของแผ่นเดียวกัน */
const spot=(side)=>{const t=tileOf(13.7563,100.5018),n=2**17,x=t.x+(side==='water'?0.8:0.2),y=t.y+0.5;
  return {lat:Math.atan(Math.sinh(Math.PI*(1-2*y/n)))*180/Math.PI,lng:x/n*360-180};};
function tiles(png){const seen={urls:[]};globalThis.fetch=async url=>{seen.urls.push(String(url));return new Response(png,{headers:{'content-type':'image/png'}});};return seen;}

test('PNG reader understands palette and RGB tiles, including row filters',async()=>{
  for(const opt of [{palette:true},{palette:false},{palette:false,filter:1}]){
    const img=await decodePng(tile(opt));
    assert.deepEqual(img.rgb(10,10),[242,239,233],JSON.stringify(opt));assert.deepEqual(img.rgb(200,40),[170,211,223],JSON.stringify(opt));
  }
  assert.equal(await decodePng(Buffer.from('not a png')),null);
});

test('water under the pin is detected from the map tile; land passes; a broken tile never blocks',async()=>{
  const env={};const seen=tiles(tile());
  assert.equal(await waterAt(env,spot('water').lat,spot('water').lng),true);
  assert.equal(await waterAt(env,spot('land').lat,spot('land').lng),false);
  assert.match(seen.urls[0],/^https:\/\/tile\.openstreetmap\.org\/17\/\d+\/\d+\.png$/);
  globalThis.fetch=async()=>new Response('down',{status:503});assert.equal(await waterAt(env,13.75,100.5),null);
  globalThis.fetch=async()=>{throw Error('offline')};assert.equal(await waterAt(env,13.75,100.5),null);
  assert.equal(await waterAt({PIN_WATER_OFF:'1'},13.75,100.5),null,'switch to turn the check off');
});

test('posts and requests refuse a pin in the water or far from the phone',async()=>{
  const f=fixture({PIN_WATER_OFF:undefined});await withMechanic(f);tiles(tile());
  const w=spot('water'),l=spot('land');
  const sea=await f.call(USER,'/api/tech/posts',post({lat:w.lat,lng:w.lng}));
  assert.equal(sea.status,400);assert.match(sea.error,/ในน้ำ/);
  const ok=await f.call(USER,'/api/tech/posts',post({lat:l.lat,lng:l.lng,gps:{lat:l.lat+0.01,lng:l.lng,acc:30}}));assert.equal(ok.status,200,ok.error);
  /* ด่วน: รถเสียอยู่ตรงนั้น — หมุดห่างเครื่อง ~3 กม. ไม่ผ่าน · ไม่ด่วนห่าง ~3 กม. ผ่าน (เช่น อยู่ที่ทำงาน รถจอดที่บ้าน) */
  const g={lat:l.lat+0.027,lng:l.lng,acc:20};assert.ok(distKm(l,g)>2.9&&distKm(l,g)<3.1);
  const far=await f.call(USER,'/api/tech/posts',post({lat:l.lat,lng:l.lng,urgent:true,gps:g}));
  assert.equal(far.status,400);assert.match(far.error,/ไกลจากตำแหน่งของคุณเกิน 1\.5 กม/);
  const job=await f.call(USER,'/api/tech/jobs',{id:crypto.randomUUID(),techId:'t_mech',car:'Toyota Vios 2018',symptom:'แบตหมด',area:'บางนา กรุงเทพ',address:'ริมถนนบางนา-ตราด กม.3',phone:'0812345678',requestedTime:'ด่วน — ตอนนี้',mode:'mobile',urgent:true,lat:l.lat,lng:l.lng,gps:g});
  assert.equal(job.status,400);assert.match(job.error,/1\.5 กม/);
  const wet=await f.call(USER,'/api/tech/jobs',{id:crypto.randomUUID(),techId:'t_mech',car:'Toyota Vios 2018',symptom:'แอร์ไม่เย็น มีลมแต่ไม่เย็น',area:'บางนา กรุงเทพ',address:'99/1 ซอยทดสอบ บางนา',phone:'0812345678',requestedTime:'พรุ่งนี้',mode:'shop',lat:w.lat,lng:w.lng});
  assert.equal(wet.status,400);assert.match(wet.error,/ในน้ำ/);
  /* GPS คลาดเคลื่อนมาก (บอกความแม่นยำ 2 กม.) ได้ระยะเผื่อเพิ่ม แต่ไม่เกิน 3 กม. */
  assert.equal((await f.call(USER,'/api/tech/posts',post({lat:l.lat,lng:l.lng,urgent:true,gps:{...g,acc:2000}}))).status,200);
  const normal=await f.call(USER,'/api/tech/posts',post({lat:l.lat,lng:l.lng,gps:{lat:l.lat+0.3,lng:l.lng,acc:10}}));
  assert.equal(normal.status,400);assert.match(normal.error,/20 กม/);
});
