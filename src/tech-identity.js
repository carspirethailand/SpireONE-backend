/* ยืนยันตัวตนช่าง (บัตร/ใบหน้า/ชื่อ/อายุ) ผ่าน Didit — ไม่ส่งบัตรให้ AI ของเรา ไม่เก็บรูปบัตรไว้ที่เรา
   เปิดเมื่อตั้ง DIDIT_API_KEY + DIDIT_WORKFLOW_ID · ไม่ตั้ง = โหมดทีมงานตรวจรูปบัตรเอง (แล้วลบทิ้งหลังตรวจ)
   ผลจาก webhook ไม่เชื่อเนื้อหาตรง ๆ: ตรวจลายเซ็นแล้วดึงผลจริงจาก Didit อีกครั้งเสมอ
   เก็บเฉพาะที่ต้องใช้เทียบ: สถานะ ชื่อ วันเกิด เลข 3 หลักท้าย และค่าแฮชกันบัตรเดียวสมัครหลายบัญชี */
import {ageFromBirth} from './tech-vetting.js';
import {sha256,nameMatch,digits,thaiIdOk} from './tech-screen.js';

export const diditReady=env=>!!(env.DIDIT_API_KEY&&env.DIDIT_WORKFLOW_ID);
const enc=new TextEncoder();
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
export async function hmacHex(key,msg){
  const k=await crypto.subtle.importKey('raw',enc.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',k,enc.encode(msg)));
}
/* เทียบลายเซ็นแบบใช้เวลาเท่ากันทุกกรณี กันเดาทีละตัวอักษรจากเวลาตอบ */
export function sameHex(a,b){a=String(a||'').toLowerCase();b=String(b||'').toLowerCase();if(!a||a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;}
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const canonicalJson=v=>JSON.stringify(canonical(v));
/* Didit v3 signs the exact raw UTF-8 body in X-Signature-V2. Keep the
   timestamped legacy signature during the Console migration. */
export async function verifyDidit(secret,raw,headers,nowMs=Date.now()){
  if(!secret)return false;
  const sig=headers.get('x-signature'),v2=headers.get('x-signature-v2');
  if(v2&&sameHex(v2,await hmacHex(secret,raw)))return true;
  const ts=Number(headers.get('x-timestamp'));
  if(!Number.isFinite(ts)||ts<=0||Math.abs(nowMs/1000-ts)>300)return false;
  if(sig&&sameHex(sig,await hmacHex(secret,raw)))return true;
  /* Temporary compatibility with destinations created before v3's raw-body
     signature. A timestamp is mandatory on this legacy canonical form. */
  if(v2){let b;try{b=JSON.parse(raw)}catch{return false;}if(sameHex(v2,await hmacHex(secret,canonicalJson(b))))return true;}
  return false;
}
/* แฮชเลขบัตร: มี ID_HASH_KEY = HMAC ด้วยกุญแจลับ (ฐานข้อมูลหลุดก็ไล่เดาเลขบัตรจากแฮชไม่ได้)
   ห่อแฮชแบบเดิมอีกชั้น เพื่อแปลงแถวเก่าได้โดยไม่ต้องรู้เลขบัตร · ตั้งกุญแจแล้วห้ามเปลี่ยน ไม่งั้นเทียบซ้ำไม่ได้ */
export const upgradeHash=(env,legacy)=>hmacHex(env.ID_HASH_KEY,legacy).then(h=>'h2:'+h);
export async function idHashOf(env,idKey){const legacy=await sha256('cendon-id:'+idKey);return env.ID_HASH_KEY?upgradeHash(env,legacy):legacy;}

const STATUS={'approved':'approved','declined':'declined','in review':'review','not started':'pending','in progress':'pending','awaiting user':'pending','resubmitted':'pending','abandoned':'expired','expired':'expired','kyc expired':'expired'};
export const diditStatus=s=>STATUS[String(s||'').trim().toLowerCase().replace(/_/g,' ')]||'pending';
const text=v=>typeof v==='string'?v.normalize('NFKC').trim():'';
/* YYYY-MM-DD (รับ พ.ศ.) → ค.ศ. · อ่านไม่ได้ = '' */
export function isoDate(v){const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(text(v));if(!m)return '';let y=+m[1];if(y>2400)y-=543;return `${y}-${m[2]}-${m[3]}`;}
/* ดึงข้อมูลที่ต้องใช้จากผลของ Didit — โครงสร้างผลมีหลายรุ่น อ่านแบบยืดหยุ่น และทิ้งทุกอย่างที่ไม่ใช้ (รูป ที่อยู่ ฯลฯ) */
export function diditFacts(dec){
  const one=v=>Array.isArray(v)?v[0]:v;
  const idv=one(dec?.id_verifications)||one(dec?.id_verification)||one(dec?.kyc)||{};
  const name=text(idv.full_name)||[text(idv.first_name),text(idv.last_name)].filter(Boolean).join(' ');
  const nums=[idv.personal_number,idv.document_number,idv.national_id,idv.id_number].map(digits).filter(Boolean);
  const thai=nums.find(thaiIdOk)||'';
  const raw=text(idv.document_number).toUpperCase().replace(/\s+/g,'');
  return {status:diditStatus(dec?.status??dec?.session_status??dec?.decision?.status),name:name.slice(0,120),birth:isoDate(idv.date_of_birth),
    idKey:thai||(raw?`${text(idv.issuing_state)}:${text(idv.document_type)}:${raw}`:''),last3:(thai||digits(raw)).slice(-3)};
}
const thaiScript=s=>/[฀-๿]/.test(s);
/* ข้อสงสัยจากผล Didit ที่ทีมงานต้องดู · block = อนุมัติไม่ได้เลย */
export function identityFlags(f,d,at=Date.now()){
  const flags=[],add=(code,level,msg,block=false)=>flags.push({code,level,msg,source:'identity',...(block?{block:true}:{})});
  if(f.status!=='approved')return flags;
  const age=ageFromBirth(f.birth,at);
  if(age!==null&&age<18)add('id_underage','high','อายุตามบัตรต่ำกว่า 18 ปี',true);
  if(f.birth&&isoDate(d.birth)&&f.birth!==isoDate(d.birth))add('id_birth','medium','วันเกิดตามบัตร (Didit) ไม่ตรงกับที่กรอกในใบสมัคร');
  if(f.name&&d.name){
    if(thaiScript(f.name)!==thaiScript(d.name))add('id_name_script','low',`ชื่อตามบัตรจาก Didit: "${f.name}" — คนละภาษากับที่กรอก ("${String(d.name).slice(0,100)}") ดูให้แน่ใจว่าเป็นคนเดียวกัน`);
    else if(nameMatch(d.name,f.name)===false)add('id_name','medium',`ชื่อตามบัตร "${f.name}" ไม่ตรงกับที่กรอก "${String(d.name).slice(0,100)}"`);
  }
  if(!f.idKey)add('id_number_missing','medium','Didit ไม่ส่งเลขบัตรกลับมา — ตรวจซ้ำบัญชีด้วยเลขบัตรไม่ได้');
  return flags;
}
export async function diditFetch(env,path,body){
  const base=new URL(env.DIDIT_BASE_URL||'https://verification.didit.me');if(base.protocol!=='https:')throw Error('Didit endpoint must use HTTPS');
  const r=await fetch(base.origin+path,{method:body?'POST':'GET',signal:AbortSignal.timeout(15000),
    headers:{'x-api-key':env.DIDIT_API_KEY,'Accept':'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw Error('Didit HTTP '+r.status);return r.json();
}
