const CHECKS = ['identity','phone','portfolio','skills','equipment','terms'];
const CATS = ['body','ev','tyre','air','eng'];
const fail = (message,status=400) => {throw Object.assign(new Error(message),{status});};
const text = (value,max=2000) => String(value ?? '').trim().slice(0,max);
const number = (value,min,max) => {const n=Number(value); if(!Number.isFinite(n)||n<min||n>max)fail('ตัวเลขอยู่นอกช่วงที่กำหนด'); return n;};
const phone = value => {const p=text(value,30).replace(/[\s()-]/g,''); if(!/^0\d{8,9}$/.test(p))fail('เบอร์โทรต้องเป็นตัวเลข 9–10 หลัก เริ่มด้วย 0'); return p;};
const required = (value,min,max) => {const v=text(value,max); if(v.length<min)fail('กรอกข้อมูลที่จำเป็นให้ครบ'); return v;};
const json = (data,status=200) => Response.json(data,{status});
const read = row => row ? JSON.parse(row.data) : null;
const adminOnly = actor => {if(!actor.admin)fail('เฉพาะผู้ดูแลระบบ',403);};
const rows = async (db,sql,...args) => (await db.prepare(sql).bind(...args).all()).results || [];
const one = (db,sql,...args) => db.prepare(sql).bind(...args).first();
const run = (db,sql,...args) => db.prepare(sql).bind(...args).run();
const id = () => crypto.randomUUID();
function application(input,test=false) {
  const cats=Array.isArray(input.cats)?[...new Set(input.cats)].filter(x=>CATS.includes(x)):[];
  const links=(Array.isArray(input.portfolio)?input.portfolio:[]).map(x=>text(x,500));
  if(links.length>12 || links.some(x=>{try{return new URL(x).protocol!=='https:'}catch{return true}}))fail('ลิงก์ผลงานต้องเป็น HTTPS และไม่เกิน 12 ลิงก์');
  if(!test && (!cats.length || links.length<3 || !input.consent))fail('เลือกประเภทงาน แนบลิงก์ผลงาน 3 ชิ้น และยอมรับเงื่อนไข');
  return {
    name:required(input.name,1,100), shop:text(input.shop,120),
    phone:test ? text(input.phone,30) : phone(input.phone),
    area:test?text(input.area,160):required(input.area,4,160),
    age:test?0:number(input.age,18,100), years:test?0:number(input.years,1,80),
    from:test?0:number(input.from,1,1000000), warranty:test?0:number(input.warranty,7,365),
    about:test?text(input.about):required(input.about,40,2000),
    experience:test?'':required(input.experience,10,1000),
    radius:test?0:number(input.radius,0,200),
    cats, portfolio:links, mobile:!!input.mobile, urgent:!!input.urgent,
    consent:!test, consentVersion:'2026-09-07', test
  };
}
function publicTech(row,stats={}) {
  const t=read(row);
  return {id:row.id,name:t.name,shop:t.shop,area:t.area,cats:t.cats||[],
    from:t.from,to:t.from,years:t.years,warranty:t.warranty,mobile:t.mobile,urgent:t.urgent,
    radius:t.radius,about:t.about,skills:t.cats?.map(c=>({body:'ตัวถังและสี',ev:'ไฟฟ้าและ EV',tyre:'ยางและช่วงล่าง',air:'แอร์รถยนต์',eng:'เครื่องยนต์'}[c]))||[],brands:[],
    verified:!row.test, test:!!row.test, jobs:Number(stats.jobs||0),
    rating:Number(stats.rating||0),reviewCount:Number(stats.reviews||0),reply:null};
}
function viewJob(row,actor) {
  const data=read(row), own=actor.uid===row.customer, tech=actor.uid===row.technician;
  if(!own&&!tech&&!actor.admin)fail('ไม่พบงาน',404);
  const reveal=!!data.acceptedAt;
  return {id:row.id,status:row.status,revision:row.revision,test:!!row.test,createdAt:row.created_at,
    role:own&&tech?'both':own?'customer':tech?'technician':'admin',
    ...data, customerPhone:reveal||own?data.customerPhone:undefined,
    technicianPhone:reveal||tech?data.technicianPhone:undefined,
    address:reveal||own?data.address:undefined};
}
async function body(request) {
  if(Number(request.headers.get('Content-Length'))>40000)fail('ข้อมูลมากเกินไป',413);
  const raw=await request.text(); if(raw.length>40000)fail('ข้อมูลมากเกินไป',413);
  try{return JSON.parse(raw)}catch{fail('ข้อมูลไม่ถูกต้อง');}
}

export async function marketplace(request,env,authenticate) {
  try {
    const db=env.DB, url=new URL(request.url), path=url.pathname, method=request.method;
    if(path==='/api/tech' && method==='GET') {
      const test=url.searchParams.get('test')==='1';
      if(test)adminOnly(await authenticate());
      const list=await rows(db,"SELECT * FROM technicians WHERE status = 'approved' AND test = ? ORDER BY updated_at DESC LIMIT 200",test?1:0);
      const stats=await rows(db,`SELECT tech_id, COUNT(*) AS jobs,
        AVG(json_extract(data,'$.review.rating')) AS rating,
        COUNT(json_extract(data,'$.review.rating')) AS reviews
        FROM tech_jobs WHERE status='completed' AND test=? GROUP BY tech_id`,test?1:0);
      return json({techs:list.map(t=>publicTech(t,stats.find(s=>s.tech_id===t.id)))});
    }
    const actor=await authenticate(), uid=actor.uid, now=Date.now();
    if(path==='/api/tech/me' && method==='GET') {
      const app=await one(db,'SELECT * FROM tech_applications WHERE uid=?',uid);
      const tech=await one(db,'SELECT * FROM technicians WHERE uid=?',uid);
      return json({admin:actor.admin,uid,application:app?{...read(app),status:app.status,revision:app.revision}:null,technician:tech?publicTech(tech):null});
    }
    if(path==='/api/tech/apply' && method==='POST') {
      const input=await body(request), test=!!input.test;
      if(test)adminOnly(actor);
      const data=application(input,test), existing=await one(db,'SELECT * FROM tech_applications WHERE uid=?',uid);
      if(existing && existing.status!=='rejected')fail('มีใบสมัครอยู่แล้ว ดูสถานะได้ที่พื้นที่ช่าง',409);
      if(await one(db,'SELECT id FROM technicians WHERE uid=?',uid))fail('บัญชีนี้มีโปรไฟล์ช่างแล้ว',409);
      const status=test?'approved':'pending';
      data.submittedAt=now;
      const statements=[db.prepare(`INSERT INTO tech_applications(uid,status,data,revision,updated_at) VALUES(?,?,?,0,?)
        ON CONFLICT(uid) DO UPDATE SET status=excluded.status,data=excluded.data,revision=tech_applications.revision+1,updated_at=excluded.updated_at
        WHERE tech_applications.status='rejected'`).bind(uid,status,JSON.stringify(data),now)];
      if(test)statements.push(db.prepare('INSERT INTO technicians(id,uid,status,test,data,updated_at) VALUES(?,?,?,?,?,?)').bind(id(),uid,'approved',1,JSON.stringify(data),now));
      const result=await db.batch(statements);
      if(!result[0].meta.changes)fail('ใบสมัครเปลี่ยนแล้ว กรุณาโหลดใหม่',409);
      return json({status,test},201);
    }
    if(path==='/api/tech/applications' && method==='GET') {
      adminOnly(actor);
      return json({applications:(await rows(db,"SELECT * FROM tech_applications WHERE status='pending' ORDER BY updated_at LIMIT 100")).map(r=>({uid:r.uid,revision:r.revision,...read(r)}))});
    }
    if(path==='/api/tech/review' && method==='POST') {
      adminOnly(actor);
      const input=await body(request), row=await one(db,'SELECT * FROM tech_applications WHERE uid=?',text(input.uid,128));
      if(!row||row.status!=='pending'||row.revision!==input.revision)fail('ใบสมัครเปลี่ยนแล้ว กรุณาโหลดใหม่',409);
      if(actor.uid===row.uid)fail('ต้องให้ผู้ดูแลคนอื่นตรวจใบสมัครจริง ใช้โหมดทดสอบเมื่อต้องการข้ามเกณฑ์',403);
      const approve=input.decision==='approve';
      if(!approve&&input.decision!=='reject')fail('การตัดสินไม่ถูกต้อง');
      const note=required(input.note,10,2000);
      if(approve && CHECKS.some(k=>input.checks?.[k]!==true))fail('ต้องตรวจครบทั้ง 6 ข้อก่อนอนุมัติ');
      const data={...read(row),review:{actor:uid,at:now,note,checks:input.checks||{}}};
      const status=approve?'approved':'rejected', techId=id(), packed=JSON.stringify(data);
      const statements=[db.prepare('UPDATE tech_applications SET status=?,data=?,revision=revision+1,updated_at=? WHERE uid=? AND revision=? AND status=?').bind(status,packed,now,row.uid,row.revision,'pending')];
      if(approve)statements.push(db.prepare(`INSERT INTO technicians(id,uid,status,test,data,updated_at)
        SELECT ?,uid,'approved',0,data,? FROM tech_applications WHERE uid=? AND status='approved' AND data=?
        ON CONFLICT(uid) DO NOTHING`).bind(techId,now,row.uid,packed));
      const result=await db.batch(statements);
      if(!result[0].meta.changes)fail('ใบสมัครเปลี่ยนแล้ว',409);
      return json({status});
    }
    if(path==='/api/tech/moderate' && method==='POST') {
      adminOnly(actor); const input=await body(request);
      const status=input.suspend?'suspended':'approved';
      await run(db,'UPDATE technicians SET status=?,updated_at=? WHERE id=?',status,now,text(input.id,40));
      return json({status});
    }
    if(path==='/api/tech/jobs' && method==='GET') {
      const list=actor.admin&&url.searchParams.get('all')==='1'
        ?await rows(db,'SELECT * FROM tech_jobs ORDER BY updated_at DESC LIMIT 100')
        :await rows(db,'SELECT * FROM tech_jobs WHERE customer=? OR technician=? ORDER BY updated_at DESC LIMIT 100',uid,uid);
      return json({jobs:list.map(r=>viewJob(r,actor))});
    }
    if(path==='/api/tech/jobs' && method==='POST') {
      const input=await body(request), tech=await one(db,"SELECT * FROM technicians WHERE id=? AND status='approved'",text(input.techId,40));
      if(!tech || tech.test&&!actor.admin)fail('ไม่พบช่างที่รับงานได้',404);
      if(tech.uid===uid&&!tech.test)fail('ไม่สามารถจองงานของตัวเอง');
      const active=await one(db,"SELECT COUNT(*) AS n FROM tech_jobs WHERE customer=? AND status NOT IN ('cancelled','completed')",uid);
      if(active.n>=20)fail('มีงานเปิดอยู่ครบ 20 งานแล้ว',429);
      const t=read(tech), jobId=required(input.id,36,36);
      if(!/^[a-f0-9-]{36}$/.test(jobId))fail('หมายเลขงานไม่ถูกต้อง');
      const data={techName:t.shop||t.name,customerName:actor.name||'ลูกค้า',
        symptom:required(input.symptom,10,2000),car:required(input.car,2,200),
        area:required(input.area,4,160),address:required(input.address,8,1000),
        requestedTime:required(input.requestedTime,4,160),customerPhone:phone(input.phone),
        technicianPhone:t.phone,mode:input.mode==='mobile'?'mobile':'shop',
        messages:[],history:[{status:'requested',at:now,actor:uid}]};
      if(data.mode==='mobile'&&!t.mobile)fail('ช่างคนนี้รับงานที่อู่เท่านั้น');
      const duplicate=await one(db,'SELECT * FROM tech_jobs WHERE id=?',jobId);
      if(duplicate){if(duplicate.customer!==uid)fail('หมายเลขงานซ้ำ',409);return json({job:viewJob(duplicate,actor)});}
      await run(db,'INSERT INTO tech_jobs(id,customer,technician,tech_id,status,test,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',jobId,uid,tech.uid,tech.id,'requested',tech.test,JSON.stringify(data),now,now);
      return json({id:jobId},201);
    }
    const match=/^\/api\/tech\/jobs\/([a-f0-9-]{36})$/.exec(path);
    if(match) {
      const row=await one(db,'SELECT * FROM tech_jobs WHERE id=?',match[1]);
      if(!row)fail('ไม่พบงาน',404);
      if(method==='GET')return json({job:viewJob(row,actor)});
      if(method!=='POST')fail('ไม่รองรับคำสั่งนี้',405);
      viewJob(row,actor);
      const input=await body(request), data=read(row), own=row.customer===uid, tech=row.technician===uid;
      if(input.revision!==row.revision)fail('งานมีข้อมูลใหม่ กรุณาโหลดอีกครั้งก่อนบันทึก',409);
      let status=row.status;
      const need=(ok)=>{if(!ok)fail('ทำรายการนี้ไม่ได้ในสถานะปัจจุบัน',409);};
      if(input.action==='message') {
        need(own||tech); need(!['cancelled','completed'].includes(status));
        const message=required(input.message,1,2000);
        const normalized=message.replace(/[๐-๙]/g,x=>String(x.charCodeAt(0)-3664)).replace(/[\s()._-]/g,'');
        if(!data.acceptedAt && /\d{9,}|https?:|www|@|ไลน์|line[:：]|tel:/i.test(normalized))fail('เปิดข้อมูลติดต่อได้หลังยืนยันใบเสนอราคา โปรดคุยรายละเอียดงานในนี้ก่อน');
        if(data.messages.length>=200)fail('ข้อความครบ 200 รายการต่อใบงานแล้ว');
        data.messages.push({id:id(),actor:uid,role:own?'customer':'technician',text:message,at:now});
      } else if(input.action==='quote') {
        need(tech&&['requested','quoted'].includes(status));
        const labor=number(input.labor,0,1000000),parts=number(input.parts,0,1000000),travel=number(input.travel,0,100000);
        if(labor+parts+travel<=0)fail('ราคารวมต้องมากกว่า 0');
        data.quote={labor,parts,travel,total:labor+parts+travel,scope:required(input.scope,10,2000),
          appointment:required(input.appointment,4,200),warranty:number(input.warranty,0,365),at:now};
        status='quoted';
      } else if(input.action==='accept') {
        need(own&&status==='quoted'); if(input.consent!==true)fail('ยืนยันการเปิดเผยเบอร์และที่อยู่สำหรับงานนี้');
        data.acceptedAt=now; status='accepted';
      } else if(input.action==='enroute') {need(tech&&status==='accepted'&&data.mode==='mobile');status='enroute';}
      else if(input.action==='start') {need(tech&&['accepted','enroute'].includes(status));status='working';}
      else if(input.action==='done') {need(tech&&status==='working');data.completion=required(input.note,10,2000);status='done';}
      else if(input.action==='complete') {need(own&&status==='done');status='completed';data.completedAt=now;}
      else if(input.action==='cancel') {need((own||tech)&&['requested','quoted','accepted','enroute'].includes(status));data.cancelReason=required(input.note,5,1000);status='cancelled';}
      else if(input.action==='dispute') {need((own||tech)&&['accepted','enroute','working','done','completed'].includes(status));data.dispute=required(input.note,10,2000);status='disputed';}
      else if(input.action==='resolve') {adminOnly(actor);need(status==='disputed');data.resolution=required(input.note,10,2000);need(['completed','cancelled'].includes(input.outcome));status=input.outcome;}
      else if(input.action==='review') {need(own&&status==='completed'&&!data.review);data.review={rating:number(input.rating,1,5),text:required(input.note,5,1000),at:now};}
      else fail('ไม่รู้จักรายการนี้');
      data.history.push({status,action:input.action,at:now,actor:uid});
      if(data.history.length>500)fail('ใบงานมีรายการมากเกินไป');
      const result=await run(db,'UPDATE tech_jobs SET data=?,status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',JSON.stringify(data),status,now,row.id,row.revision);
      if(!result.meta.changes)fail('มีผู้บันทึกข้อมูลก่อนแล้ว กรุณาโหลดใหม่',409);
      return json({job:viewJob({...row,data:JSON.stringify(data),status,revision:row.revision+1},actor)});
    }
    fail('ไม่พบรายการ',404);
  }catch(error){return json({error:error.status?error.message:'ระบบช่างยังไม่พร้อม กรุณาลองใหม่ภายหลัง'},error.status||503);}
}
