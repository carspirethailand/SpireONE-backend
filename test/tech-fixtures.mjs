import {DatabaseSync} from 'node:sqlite';
import {deflateSync} from 'node:zlib';
import {handleTech} from '../src/techs.js';
import {CONSENT_VER} from '../src/tech-vetting.js';
import {hmacHex} from '../src/tech-identity.js';
export function png(seed=1,w=400,h=300){
  const crc=b=>{let c=0xffffffff;for(const n of b){c^=n;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
  const chunk=(kind,data)=>{const type=Buffer.from(kind),b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);type.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc(Buffer.concat([type,data])),b.length-4);return b;};
  const head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head[8]=8;head[9]=2;
  const raw=Buffer.alloc((w*3+1)*h,seed);for(let y=0;y<h;y++)raw[y*(w*3+1)]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
export const pic=(kind,n)=>({kind,data:'data:image/png;base64,'+png(n).toString('base64')});
export const form=(over={})=>({title:'นาย',name:'สมชาย ใจดี',phone:'0812345678',area:'บางนา กรุงเทพ',age:30,birth:'1996-05-01',years:5,from:500,warranty:30,radius:10,lat:13.7,lng:100.6,cats:['eng'],consent:true,aiConsent:true,consentVer:CONSENT_VER,idConsent:true,idNo:'1101700203450',about:'ซ่อมเครื่องยนต์และระบบแอร์ มีเครื่องตรวจและเครื่องมือประจำอู่',docs:[pic('id',1),pic('selfie',2),pic('shop',3),pic('work',4),pic('work',5),pic('work',6)],...over});
export const evidence=()=>Object.fromEntries(Object.entries({identity:'document_review',phone:'live_call',work:'portfolio_review',skills:'interview',shop:'video_call',terms:'written_agreement'}).map(([key,method])=>[key,{method,note:'Test-only human review record; not a real applicant verification.'}]));
/* Workers AI ปลอม: ตอบครบทุกรูปที่ส่งมาในคำขอนั้น · transform(out, ลำดับคำขอ) ใช้จำลองคำตอบเสีย/ไม่ครบ
   ห่อคำตอบใน ```json``` เหมือนโมเดลจริงบางรุ่น เพื่อทดสอบการอ่านแบบยืดหยุ่น */
let vision=null;
export const AI={run:(model,input)=>{if(!vision)throw Error('AI mock not set');return vision(model,input);}};
export function fakeVision(transform=out=>out){
  const seen={calls:0,requests:[],models:[]};
  vision=async(model,input)=>{const n=seen.calls++;seen.requests.push(input);seen.models.push(model);
    const head=JSON.parse(input.messages.find(m=>m.role==='user').content[0].text);
    const images=head.images.map(x=>({...x,relevance:'relevant',concern:false,note:'Test-only mocked image analysis'}));
    const out=transform({images,descriptionRelevant:'yes',summary:'Mocked response for unit tests only'},n);
    return {response:'```json\n'+JSON.stringify(out)+'\n```'};};
  return seen;
}
/* AI ตรวจคลิปหลักฐานปลอม: answer(step) คืน {result, part, note} หรือ throw = AI ล้ม */
export function proofVision(answer){const seen={calls:0,steps:[]};vision=async(model,input)=>{seen.calls++;const head=JSON.parse(input.messages.find(m=>m.role==='user').content[0].text);seen.steps.push(head.step);return {response:JSON.stringify(answer(head.step,seen.calls))};};return seen;}
export function failVision(msg='quota exceeded: private provider details'){const seen={calls:0};vision=async()=>{seen.calls++;throw Error(msg);};return seen;}
/* Didit ปลอม: เปิด session / ส่งผล · decision = ผลที่จะตอบเมื่อถูกดึง (เปลี่ยนได้ระหว่างเทสต์) */
export const DIDIT={DIDIT_API_KEY:'test-mock-only',DIDIT_WORKFLOW_ID:'wf-test',DIDIT_WEBHOOK_SECRET:'whsec-test-only'};
export const approvedDecision=(over={})=>({session_id:'sess-0001-test',status:'Approved',id_verifications:[{status:'Approved',first_name:'สมชาย',last_name:'ใจดี',date_of_birth:'1996-05-01',document_number:'1101700203450',personal_number:'1101700203450',expiration_date:'2031-01-01',document_type:'Identity Card',issuing_state:'THA',front_image:'https://didit.example/private.jpg',...over}]});
export function fakeDidit(decision=approvedDecision()){
  const seen={sessions:[],decisions:0,other:0,decision,next:1};
  globalThis.fetch=async(url,init={})=>{const u=new URL(url);
    if(u.pathname==='/v3/session/'&&init.method==='POST'){const body=JSON.parse(init.body);seen.sessions.push({body,headers:init.headers});const id='sess-'+String(seen.next++).padStart(4,'0')+'-test';
      return Response.json({session_id:id,url:'https://verify.didit.me/session/'+id,status:'Not Started',vendor_data:body.vendor_data});}
    const m=u.pathname.match(/^\/v3\/session\/([\w-]+)\/decision\/$/);
    if(m){seen.decisions++;const d=typeof seen.decision==='function'?seen.decision(m[1]):seen.decision;return Response.json({...d,session_id:m[1]});}
    seen.other++;return Response.json({});};
  return seen;
}
/* webhook ที่เซ็นด้วยกุญแจทดสอบ (หรือกุญแจผิด) */
export async function diditHook(f,sessionId,{secret=DIDIT.DIDIT_WEBHOOK_SECRET,ts=Math.floor(Date.now()/1000),status='Approved'}={}){
  const raw=JSON.stringify({session_id:sessionId,status,webhook_type:'status.updated',vendor_data:'x'});
  const r=await handleTech(new Request('https://unit.test/api/tech/didit/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Timestamp':String(ts),'X-Signature':await hmacHex(secret,raw)},body:raw}),f.env,undefined,{});
  return {...await r.json(),status:r.status};
}
export const TEST_DATA_KEY=Buffer.alloc(32,5).toString('base64');
export function fixture(extra={}){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE users(uid TEXT PRIMARY KEY,role TEXT,banned INTEGER)');let queue=Promise.resolve();
  const DB={prepare(sql){let values=[];return {bind(...v){values=v;return this;},async first(){return sqlite.prepare(sql).get(...values)||null;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async run(){const r=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(r.changes)}};}};},batch(list){const task=queue.then(async()=>{sqlite.exec('BEGIN');try{const out=[];for(const st of list)out.push(await st.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}});queue=task.catch(()=>{});return task;}};
  /* กุญแจทดสอบเท่านั้น — ของจริงตั้งด้วย wrangler secret put (ดู DEPLOY.md) */
  const env={DB,AI,PIN_WATER_OFF:'1',OWNERS:'boss@unit.test',APP_DATA_KEY:TEST_DATA_KEY,ID_HASH_KEY:'test-only-id-hash-key',...extra};
  const verifyToken=async token=>{const [uid,email,verified]=token.split('|');if(!uid)throw Error('invalid');return {sub:uid,email,email_verified:verified!=='unverified'};};
  /* อัปโหลดไฟล์ดิบ (คลิป/รูป) ผ่าน /api/tech/media แบบเดียวกับหน้าเว็บ */
  const put=async(token,id,bytes,mime,scope='draft')=>{const r=await handleTech(new Request(`https://unit.test/api/tech/media/${id}?scope=${scope}`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':mime},body:bytes}),env,undefined,{verifyToken});return {...await r.json(),status:r.status};};
  const call=async(token,path,body)=>{const r=await handleTech(new Request('https://unit.test'+path,{method:body?'POST':'GET',headers:token?{Authorization:'Bearer '+token}:{},body:body?JSON.stringify(body):undefined}),env,undefined,{verifyToken});return {...await r.json(),status:r.status};};
  return {call,put,sqlite,env};
}
export const USER='applicant|person@unit.test',ADMIN='boss|boss@unit.test';
/* ส่งใบสมัคร แล้วทีมงานตรวจเลขบัตรตามขั้นตอนปกติ (พิมพ์เลขที่เห็นบนรูปบัตร ระบบเทียบแฮช) · idcheck:false = ข้ามขั้นนี้ ใช้ทดสอบว่าระบบบังคับจริง */
export async function pending(f,over={},{idcheck=true}={}){const body=form(over),r=await f.call(USER,'/api/tech/apply',body);if(r.status!==200)throw Error(JSON.stringify(r));
  const a=(await f.call(ADMIN,'/api/tech/applications')).applications[0];
  if(idcheck&&a.identity?.mode!=='didit'&&body.idNo){const c=await f.call(ADMIN,'/api/tech/review/idcheck',{uid:a.uid,idNo:body.idNo});if(!c.match)throw Error('idcheck '+JSON.stringify(c));}
  return a;}
/* ข้อสงสัยด่านบัตร (ทีมงานเทียบเลขบัตรเอง / ข้อสงสัยจาก Didit) ต้องมีบันทึกของทีมงาน — เติมให้เฉพาะด่านบัตร ด่านรูปผลงานยังให้แต่ละเทสต์กำหนดเอง */
export const idNotes=a=>Object.fromEntries([...(a.ai?.flags||[]),...(a.identity?.flags||[])].filter(f=>f.source==='identity'&&f.level!=='low'&&!f.block).map(f=>[f.code,{outcome:'false_positive',note:'Test-only: compared the ID number digit by digit with the form.'}]));
export const review=(a,over={})=>({uid:a.uid,revision:a.revision,decision:'approve',checks:Object.fromEntries(['identity','phone','work','skills','shop','terms'].map(k=>[k,true])),evidence:evidence(),note:'Test-only completed human review with evidence.',...over,resolutions:{...idNotes(a),...(over.resolutions||{})}});

/* หลักฐานการซ่อม: อัดคลิป (ไฟล์ทดสอบเล็ก ๆ) ทีละช็อต แล้วส่งพร้อมภาพนิ่งจากคลิป */
export const frame=(n=1)=>'data:image/png;base64,'+png(n,64,48).toString('base64');
export async function proveShots(f,token,jobId,shots=['old','new','fit']){
  const out=[];
  for(const [i,shot] of shots.entries()){
    const mid='m_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
    const up=await f.put(token,mid,new Uint8Array([0,0,0,24,102,116,121,112,105+i]),'video/mp4');if(up.status!==200)throw Error('upload '+JSON.stringify(up));
    const r=await f.call(token,'/api/tech/jobs/'+jobId+'/proof',{shot,media:mid,frames:[frame(10+i+Math.floor(Math.random()*200))]});
    if(r.status!==200)throw Error('proof '+JSON.stringify(r));out.push(r);
  }
  return out;
}
