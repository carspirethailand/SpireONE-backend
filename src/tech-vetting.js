/* Server-owned rules, not proof of identity or professional competence. */
export const VETTING_VERSION=2;
export function fullNameError(value){
  if(typeof value!=='string')return 'กรอกชื่อและนามสกุลตามเอกสาร';
  const n=value.normalize('NFKC').trim();
  return n.length<4||n.length>100||!/^\p{L}[\p{L}\p{M}\s.'’-]+$/u.test(n)||n.split(/\s+/).length<2?'กรอกชื่อและนามสกุลให้ครบ ใช้ตัวอักษร ไม่ใช้ชื่อเล่นหรือข้อความสุ่ม':'';
}
export function ageFromBirth(value,at=Date.now()){
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value||''));if(!m)return null;
  let y=+m[1];if(y>2400)y-=543;const month=+m[2],day=+m[3],date=new Date(Date.UTC(y,month-1,day));
  if(y<1900||date.getUTCFullYear()!==y||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||date.getTime()>at)return null;
  const today=new Date(at);let age=today.getUTCFullYear()-y;
  if(today.getUTCMonth()<month-1||(today.getUTCMonth()===month-1&&today.getUTCDate()<day))age--;return age;
}
export function applicantErrors(d,at=Date.now()){
  const errors=[],add=(code,msg)=>errors.push({code,level:'high',source:'rules',msg});
  const name=fullNameError(d.name);if(name)add('name_format',name);
  const age=ageFromBirth(d.birth,at);
  if(age===null||age<18||age>80||!Number.isInteger(d.age)||d.age!==age)add('birth_age','วันเกิดและอายุต้องตรงกัน และอายุ 18–80 ปี');
  if(!Number.isInteger(d.years)||d.years<2||d.years>60||(age!==null&&d.years>age-16))add('experience','ประสบการณ์ต้องเป็นจำนวนเต็ม 2–60 ปี และไม่มากกว่าอายุที่เป็นไปได้');
  if(typeof d.about!=='string'||d.about.trim().length<30||d.about.length>1000)add('description','อธิบายความถนัด เครื่องมือ และงานที่เคยทำอย่างน้อย 30 ตัวอักษร');
  if(!/^0\d{8,9}$/.test(String(d.phone))||/^0(\d)\1+$/.test(String(d.phone)))add('phone_format','เบอร์โทรไม่ถูกต้อง');return errors;
}
export function imageInfo(mime,data){
  let raw;try{raw=atob(data)}catch{throw Error('ข้อมูลรูปเสียหาย');}if(btoa(raw)!==data)throw Error('รูปต้องเป็น base64 มาตรฐาน');
  const b=Uint8Array.from(raw,c=>c.charCodeAt(0)),v=new DataView(b.buffer);let w=0,h=0;
  if(mime==='image/png'){
    if(b.length<45||[137,80,78,71,13,10,26,10].some((n,i)=>b[i]!==n)||String.fromCharCode(...b.slice(12,16))!=='IHDR')throw Error('ไฟล์ไม่ใช่ PNG จริง');
    w=v.getUint32(16);h=v.getUint32(20);let p=8,idat=false,end=false;
    while(p+12<=b.length){const n=v.getUint32(p),k=String.fromCharCode(...b.slice(p+4,p+8));if(n>b.length-p-12)throw Error('PNG ไม่ครบ');if(k==='IDAT'&&n>0)idat=true;p+=n+12;if(k==='IEND'){end=p===b.length;break;}}
    if(!idat||!end)throw Error('PNG ไม่ครบ');
  }else if(mime==='image/jpeg'){
    if(b.length<20||b[0]!==255||b[1]!==216||b.at(-2)!==255||b.at(-1)!==217)throw Error('ไฟล์ไม่ใช่ JPEG จริง');
    let p=2,sos=false;
    while(p+4<=b.length){if(b[p++]!==255)throw Error('JPEG เสียหาย');while(b[p]===255)p++;const m=b[p++];if(m===217)break;const n=v.getUint16(p);if(n<2||p+n>b.length)throw Error('JPEG ไม่ครบ');
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(m)){if(n<8)throw Error('JPEG เสียหาย');h=v.getUint16(p+3);w=v.getUint16(p+5);}if(m===218){sos=true;break;}p+=n;}
    if(!sos)throw Error('JPEG ไม่มีข้อมูลภาพ');
  }else if(mime==='image/webp'){
    if(b.length<30||String.fromCharCode(...b.slice(0,4))!=='RIFF'||String.fromCharCode(...b.slice(8,12))!=='WEBP'||v.getUint32(4,true)+8!==b.length)throw Error('ไฟล์ไม่ใช่ WebP จริง');
    const k=String.fromCharCode(...b.slice(12,16));
    if(k==='VP8X'){w=1+b[24]+(b[25]<<8)+(b[26]<<16);h=1+b[27]+(b[28]<<8)+(b[29]<<16);if(b[20]&2)throw Error('ใช้รูปนิ่ง ไม่ใช้ภาพเคลื่อนไหว');}
    else if(k==='VP8 '&&b[23]===157&&b[24]===1&&b[25]===42){w=v.getUint16(26,true)&16383;h=v.getUint16(28,true)&16383;}
    else if(k==='VP8L'&&b[20]===47){const n=v.getUint32(21,true);w=(n&16383)+1;h=((n>>>14)&16383)+1;}else throw Error('WebP เสียหาย');
  }else throw Error('ชนิดรูปไม่รองรับ');
  if(Math.min(w,h)<240||Math.max(w,h)<320||w>8192||h>8192||w*h>32000000)throw Error('รูปต้องชัดอย่างน้อย 320×240 และไม่ใหญ่เกิน 32 ล้านพิกเซล');return {width:w,height:h};
}
export const EVIDENCE_METHODS={identity:['document_review'],phone:['live_call'],work:['portfolio_review'],skills:['interview','certificate_review'],shop:['site_visit','video_call','document_review'],terms:['written_agreement']};
export function approvalError({app,ai,snapshot,evidence,resolutions}){
  if(app.test)return 'โปรไฟล์ทดสอบไม่สามารถรับรองเป็นร้านจริง';
  if(!ai||ai.status!=='complete'||ai.policyVersion!==VETTING_VERSION||ai.revision!==app.revision||ai.snapshot!==snapshot)return 'ต้องตรวจ AI สำเร็จด้วยข้อมูลและรูปชุดล่าสุดก่อนอนุมัติ';
  for(const f of ai.flags||[]){if(f.source==='rules'&&f.level==='high')return 'ข้อมูลไม่ผ่านกฎพื้นฐาน ต้องให้ผู้สมัครแก้ไขก่อน';if(f.level==='low')continue;const r=resolutions?.[f.code];
    if(r?.outcome!=='false_positive'||typeof r.note!=='string'||r.note.trim().length<30||r.note.length>1000)return 'ต้องตรวจและบันทึกหลักฐานตอบข้อสงสัยของ AI ทุกข้อ หรือส่งกลับให้แก้ไข';}
  for(const [key,methods] of Object.entries(EVIDENCE_METHODS)){const i=evidence?.[key];if(!methods.includes(i?.method)||typeof i.note!=='string'||i.note.trim().length<20||i.note.length>1000)return 'ต้องบันทึกวิธีและหลักฐานการตรวจครบทั้ง 6 ข้อ ไม่ใช่ติ๊กอย่างเดียว';}return '';
}
