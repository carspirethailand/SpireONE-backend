import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,fakeVision,pending,review,form,pic,USER,ADMIN} from './tech-fixtures.mjs';
import {open,CTX} from '../src/vault.js';

/* ใบสมัครช่าง: ในฐานข้อมูลต้องไม่มีข้อมูลจริงให้อ่าน — ขโมยฐานข้อมูล/สำเนาสำรองไปก็ได้แต่ตัวอักษรถอดไม่ออก */
const ID='1101700203450';
const dump=f=>JSON.stringify(['tech_applications','tech_docs','tech_identity','tech_identity_claims','tech_audit'].map(t=>f.sqlite.prepare(`SELECT * FROM ${t}`).all()));

test('vault: ใบสมัครที่ส่งแล้ว — ชื่อ เบอร์ วันเกิด พิกัด เลขบัตร และรูปบัตร/เซลฟี่ ไม่อยู่ในฐานข้อมูลแบบอ่านออก',async()=>{
  fakeVision();const f=fixture();const body=form();await f.call(USER,'/api/tech/apply',body);
  const raw=dump(f);
  for(const secret of [body.name,body.phone,body.birth,ID,String(body.lat)])assert.ok(!raw.includes(secret),'เจอข้อมูลจริงในฐานข้อมูล: '+secret);
  const idPic=body.docs.find(d=>d.kind==='id').data.split(',')[1],selfie=body.docs.find(d=>d.kind==='selfie').data.split(',')[1];
  assert.ok(!raw.includes(idPic.slice(0,200))&&!raw.includes(selfie.slice(0,200)),'รูปบัตร/เซลฟี่ต้องเข้ารหัส ไม่ใช่ base64 ที่แปลงกลับได้');
  const app=f.sqlite.prepare('SELECT data FROM tech_applications').get().data;assert.match(app,/^enc:v1:/);
  const d=JSON.parse(await open(f.env,app,CTX.app('applicant')));assert.equal(d.name,body.name);assert.equal(d.idLast3,'450');assert.equal(d.idNo,undefined,'เลขบัตรเต็มไม่เก็บแม้ในข้อมูลที่เข้ารหัส');
  /* ทีมงานเปิดดูผ่านระบบได้ตามปกติ (ถอดให้เฉพาะคนมีสิทธิ์) */
  const a=(await f.call(ADMIN,'/api/tech/applications')).applications[0];assert.equal(a.name,body.name);assert.equal(a.idLast3,'450');assert.equal(a.idNo,undefined);
  const docs=(await f.call(ADMIN,'/api/tech/docs?uid=applicant')).docs;assert.ok(docs.find(x=>x.kind==='id').url.endsWith(idPic));
  /* ผู้สมัครดูใบของตัวเองได้ คนอื่นดูไม่ได้ */
  assert.equal((await f.call(USER,'/api/tech/me')).application.name,body.name);
  assert.equal((await f.call(USER,'/api/tech/docs?uid=applicant')).status,403);
});

test('vault: ข้อมูลเข้ารหัสถูกแก้ หรือถูกย้ายไปแถวของคนอื่น = ระบบปฏิเสธ ไม่แสดงข้อมูลผิด',async()=>{
  fakeVision();const f=fixture();await f.call(USER,'/api/tech/apply',form());
  const row=f.sqlite.prepare("SELECT id,data FROM tech_docs WHERE kind='id'").get();
  f.sqlite.prepare("UPDATE tech_docs SET data=(SELECT data FROM tech_docs WHERE kind='selfie') WHERE id=?").run(row.id);
  assert.equal((await f.call(ADMIN,'/api/tech/docs?uid=applicant')).status,503,'สลับรูปเซลฟี่มาใส่ช่องบัตร = ถอดไม่ได้');
});

test('vault: ไม่มีกุญแจเข้ารหัส หรือกุญแจแฮชเลขบัตร = ไม่รับใบสมัครเลย (ปิดแบบปลอดภัย ไม่แอบเก็บแบบอ่านออก)',async()=>{
  for(const missing of ['APP_DATA_KEY','ID_HASH_KEY']){
    fakeVision();const f=fixture({[missing]:''});const r=await f.call(USER,'/api/tech/apply',form());
    assert.equal(r.status,503,missing);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_applications').get().n,0,missing);
  }
});

test('vault: ทีมงานตรวจเลขบัตรด้วยการพิมพ์เลขบนรูปบัตร — บังคับก่อนอนุมัติ ตอบแค่ตรง/ไม่ตรง ไม่บันทึกตัวเลข',async()=>{
  fakeVision();const f=fixture();const a=await pending(f,{},{idcheck:false});
  const r=await f.call(ADMIN,'/api/tech/review',review(a));assert.equal(r.status,400);assert.match(r.error,/ตรวจเลขบัตร/);
  assert.equal((await f.call(ADMIN,'/api/tech/review/idcheck',{uid:a.uid,idNo:'1101700203451'})).status,400,'เลขผิดสูตรถูกปฏิเสธก่อนเทียบ');
  assert.equal((await f.call(ADMIN,'/api/tech/review/idcheck',{uid:a.uid,idNo:'3100503399632'})).match,false);
  assert.equal((await f.call(USER,'/api/tech/review/idcheck',{uid:a.uid,idNo:ID})).status,403,'ผู้สมัคร/คนทั่วไปใช้ไม่ได้');
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,400,'เทียบไม่ตรงยังอนุมัติไม่ได้');
  const chk=async()=>(await f.call(ADMIN,'/api/tech/applications')).applications.find(x=>x.uid===a.uid).idChecked;
  assert.equal(await chk(),false);
  assert.equal((await f.call(ADMIN,'/api/tech/review/idcheck',{uid:a.uid,idNo:'1-1017-00203-45-0'})).match,true,'พิมพ์มีขีดได้');
  assert.equal(await chk(),true,'ระบบจำว่าเทียบผ่านแล้ว (ต่อฉบับแก้ไข) เปิดหน้าตรวจใหม่ไม่ต้องพิมพ์ซ้ำ');
  assert.equal((await f.call(ADMIN,'/api/tech/review',review(a))).status,200);
  assert.ok(!dump(f).includes(ID),'ไม่มีเลขบัตรเต็มในฐานข้อมูลและบันทึกการทำงาน');
  const acts=f.sqlite.prepare('SELECT action FROM tech_audit').all().map(x=>x.action);assert.ok(acts.includes('idcheck_mismatch')&&acts.includes('idcheck_match'));
});

test('vault: ใช้ช่องตรวจเลขบัตรไล่เดาเลขไม่ได้ (จำกัดจำนวนครั้งต่อใบสมัคร)',async()=>{
  fakeVision();const f=fixture();const a=await pending(f,{},{idcheck:false});
  let last;for(let i=0;i<11;i++)last=await f.call(ADMIN,'/api/tech/review/idcheck',{uid:a.uid,idNo:'3100503399632'});
  assert.equal(last.status,429);
});

test('vault: ดาวน์โหลดข้อมูลของฉัน — เจ้าของได้ข้อมูลใบสมัครที่อ่านออก (ถอดให้เฉพาะเจ้าของ)',async()=>{
  fakeVision();const f=fixture();const body=form();await f.call(USER,'/api/tech/apply',body);
  const {exportAccount}=await import('../src/account-data.js');
  const out=await exportAccount(f.env,'applicant');
  assert.equal(out.data.tech_applications[0].data.name,body.name);
  assert.ok(!JSON.stringify(out).includes(ID));
});

test('vault: ใบสมัครเก่าที่ยังมีเลขบัตรเต็มค้าง (ก่อนรอบเก็บกวาด) — ระบบไม่ส่งเลขเต็มออกไปให้ใครเห็น',async()=>{
  fakeVision();const f=fixture();const a=await pending(f,{},{idcheck:false});
  /* จำลองแถวรุ่นเก่า: ข้อมูลไม่เข้ารหัส และมีเลขบัตรเต็ม */
  const d=JSON.parse(await open(f.env,f.sqlite.prepare('SELECT data FROM tech_applications WHERE uid=?').get(a.uid).data,CTX.app(a.uid)));
  delete d.idLast3;d.idNo=ID;f.sqlite.prepare('UPDATE tech_applications SET data=? WHERE uid=?').run(JSON.stringify(d),a.uid);
  const out=JSON.stringify(await f.call(ADMIN,'/api/tech/applications'))+JSON.stringify(await f.call(USER,'/api/tech/me'));
  assert.ok(!out.includes(ID),'เลขบัตรเต็มต้องไม่หลุดออกทาง API');
  assert.equal((await f.call(ADMIN,'/api/tech/applications')).applications[0].idLast3,'450');
});

/* แถวรุ่นเก่าที่เก็บก่อนมีตู้เซฟ: จำลองโดยถอดรหัสแล้วเขียนกลับแบบอ่านออก (พร้อมเลขบัตรเต็มแบบรุ่นเก่า) */
async function legacy(f,uid){
  const a=f.sqlite.prepare('SELECT data FROM tech_applications WHERE uid=?').get(uid);
  const d=JSON.parse(await open(f.env,a.data,CTX.app(uid)));delete d.idLast3;d.idNo=ID;
  f.sqlite.prepare('UPDATE tech_applications SET data=? WHERE uid=?').run(JSON.stringify(d),uid);
  for(const doc of f.sqlite.prepare("SELECT id,kind,data FROM tech_docs WHERE uid=? AND kind IN ('id','selfie','cert')").all(uid))
    f.sqlite.prepare('UPDATE tech_docs SET data=? WHERE id=?').run(await open(f.env,doc.data,CTX.doc(uid,doc.kind)),doc.id);
  f.sqlite.prepare("INSERT OR REPLACE INTO tech_identity(uid,session_id,status,id_hash,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(uid,'sess-legacy','pending',null,JSON.stringify({name:'สมชาย ใจดี',birth:'1996-05-01'}),1,1);
}

test('vault: รอบเก็บกวาดเข้ารหัสแถวรุ่นเก่าที่ยังอ่านออก ตัดเลขบัตรเต็ม และทีมงานยังเปิดดูได้ตามปกติ',async()=>{
  fakeVision();const f=fixture();const body=form();await f.call(USER,'/api/tech/apply',body);
  await legacy(f,'applicant');
  assert.ok(dump(f).includes(ID)&&dump(f).includes(body.name),'จำลองแถวเก่าสำเร็จ');
  const {vaultSweep}=await import('../src/techs.js');
  const r=await vaultSweep(f.env);assert.equal(r.sealed,4,'เข้ารหัสครบ: ใบสมัคร ตัวตน รูปบัตร เซลฟี่');
  assert.match(f.sqlite.prepare('SELECT data FROM tech_identity').get().data,/^enc:v1:/);
  const raw=dump(f);
  for(const secret of [ID,body.name,body.phone,body.birth])assert.ok(!raw.includes(secret),'ยังเจอข้อมูลอ่านออก: '+secret);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM tech_docs WHERE kind IN ('id','selfie') AND data NOT LIKE 'enc:v1:%'").get().n,0);
  /* ใบที่รอตรวจและเพิ่งตัดเลขบัตร: ผล AI เดิมผูกกับข้อมูลชุดก่อน ต้องตรวจใหม่ ไม่ปล่อยผลเก่าค้าง */
  assert.equal(f.sqlite.prepare('SELECT ai FROM tech_applications').get().ai,null);
  const a=(await f.call(ADMIN,'/api/tech/applications')).applications[0];assert.equal(a.name,body.name);assert.equal(a.idLast3,'450');assert.equal(a.idNo,undefined);
  assert.ok((await f.call(ADMIN,'/api/tech/docs?uid=applicant')).docs.find(x=>x.kind==='id'));
  assert.equal((await vaultSweep(f.env)).sealed,0,'รอบถัดไปไม่มีอะไรต้องทำ');
});

test('vault: เปลี่ยนกุญแจ — ของเดิมอ่านได้ด้วยกุญแจเก่าระหว่างย้าย และรอบเก็บกวาดเข้ารหัสใหม่ด้วยกุญแจใหม่ทั้งหมด',async()=>{
  fakeVision();const f=fixture();const body=form();await f.call(USER,'/api/tech/apply',body);
  const {vaultSweep}=await import('../src/techs.js');const {currentKeyId}=await import('../src/vault.js');
  const env2={...f.env,APP_DATA_KEY:Buffer.alloc(32,9).toString('base64'),APP_DATA_KEY_PREV:f.env.APP_DATA_KEY};
  const k1=await currentKeyId(f.env),k2=await currentKeyId(env2);assert.notEqual(k1,k2);
  assert.ok((await vaultSweep(env2)).sealed>=3);
  const kids=f.sqlite.prepare("SELECT data FROM tech_applications UNION ALL SELECT data FROM tech_docs WHERE kind IN ('id','selfie')").all().map(x=>x.data.split(':')[2]);
  assert.ok(kids.every(k=>k===k2),'ทุกแถวใช้กุญแจใหม่');
  const app=f.sqlite.prepare('SELECT data FROM tech_applications').get().data;
  assert.equal(JSON.parse(await open(env2,app,CTX.app('applicant'))).name,body.name);
  await assert.rejects(open(f.env,app,CTX.app('applicant')),/vault_key_missing/,'กุญแจเก่าอย่างเดียวเปิดของใหม่ไม่ได้ — ลบกุญแจเก่าทิ้งได้หลังย้ายเสร็จ');
});

test('vault: ใบสมัครค้างรอตรวจเกิน 30 วัน — หมดอายุ ลบรูปบัตร/เซลฟี่ ปล่อยเลขบัตรคืน ผู้สมัครส่งใหม่ได้',async()=>{
  fakeVision();const f=fixture();await f.call(USER,'/api/tech/apply',form());
  const {expireStaleApplications,PENDING_TTL}=await import('../src/techs.js');
  assert.equal((await expireStaleApplications(f.env)).expired,0,'ยังไม่ครบ 30 วัน ไม่แตะ');
  f.sqlite.prepare('UPDATE tech_applications SET updated_at=?').run(Date.now()-PENDING_TTL-60000);
  assert.equal((await expireStaleApplications(f.env)).expired,1);
  const a=f.sqlite.prepare('SELECT status,review FROM tech_applications').get();
  assert.equal(a.status,'rejected');assert.match(JSON.parse(a.review).note,/เกิน 30 วัน/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM tech_docs WHERE kind IN ('id','selfie','cert')").get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tech_identity_claims').get().n,0);
  assert.ok(f.sqlite.prepare("SELECT 1 FROM tech_audit WHERE action='expire'").get());
  /* ผู้สมัครเห็นเหตุผล และส่งใหม่ได้ทันที */
  assert.match((await f.call(USER,'/api/tech/me')).application.review.note,/ส่งใบสมัครใหม่/);
  assert.equal((await f.call(USER,'/api/tech/apply',form())).status,200);
});
