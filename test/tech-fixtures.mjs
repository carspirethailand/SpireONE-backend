import {DatabaseSync} from 'node:sqlite';
import {deflateSync} from 'node:zlib';
import {handleTech} from '../src/techs.js';
export function png(seed=1,w=400,h=300){
  const crc=b=>{let c=0xffffffff;for(const n of b){c^=n;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
  const chunk=(kind,data)=>{const type=Buffer.from(kind),b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);type.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc(Buffer.concat([type,data])),b.length-4);return b;};
  const head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head[8]=8;head[9]=2;
  const raw=Buffer.alloc((w*3+1)*h,seed);for(let y=0;y<h;y++)raw[y*(w*3+1)]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
export const pic=(kind,n)=>({kind,data:'data:image/png;base64,'+png(n).toString('base64')});
export const form=(over={})=>({title:'นาย',name:'สมชาย ใจดี',phone:'0812345678',area:'บางนา กรุงเทพ',age:30,birth:'1996-05-01',years:5,from:500,warranty:30,radius:10,lat:13.7,lng:100.6,cats:['eng'],consent:true,aiConsent:true,idNo:'1101700203450',about:'ซ่อมเครื่องยนต์และระบบแอร์ มีเครื่องตรวจและเครื่องมือประจำอู่',docs:[pic('id',1),pic('selfie',2),pic('shop',3),pic('work',4),pic('work',5),pic('work',6)],...over});
export const evidence=()=>Object.fromEntries(Object.entries({identity:'document_review',phone:'live_call',work:'portfolio_review',skills:'interview',shop:'video_call',terms:'written_agreement'}).map(([key,method])=>[key,{method,note:'Test-only human review record; not a real applicant verification.'}]));
export function fakeGemini(transform=out=>out){
  const seen={calls:0,requests:[]};globalThis.fetch=async(url,init)=>{seen.calls++;const body=JSON.parse(init.body);seen.requests.push(body);
    const images=body.contents[0].parts.filter(p=>p.text).map(p=>{try{return JSON.parse(p.text)}catch{return null}}).filter(x=>x?.imageId).map(x=>({...x,relevance:'relevant',concern:false,note:'Test-only mocked image analysis'}));
    const out=transform({images,descriptionRelevant:'yes',summary:'Mocked response for unit tests only'});
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(out)}]}}]});};return seen;
}
export function fixture(extra={}){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE users(uid TEXT PRIMARY KEY,role TEXT,banned INTEGER)');let queue=Promise.resolve();
  const DB={prepare(sql){let values=[];return {bind(...v){values=v;return this;},async first(){return sqlite.prepare(sql).get(...values)||null;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async run(){const r=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(r.changes)}};}};},batch(list){const task=queue.then(async()=>{sqlite.exec('BEGIN');try{const out=[];for(const st of list)out.push(await st.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}});queue=task.catch(()=>{});return task;}};
  const env={DB,GEMINI_KEY:'test-mock-only',OWNERS:'boss@unit.test',...extra};
  const verifyToken=async token=>{const [uid,email,verified]=token.split('|');if(!uid)throw Error('invalid');return {sub:uid,email,email_verified:verified!=='unverified'};};
  const call=async(token,path,body)=>{const r=await handleTech(new Request('https://unit.test'+path,{method:body?'POST':'GET',headers:token?{Authorization:'Bearer '+token}:{},body:body?JSON.stringify(body):undefined}),env,undefined,{verifyToken});return {...await r.json(),status:r.status};};
  return {call,sqlite,env};
}
export const USER='applicant|person@unit.test',ADMIN='boss|boss@unit.test';
export async function pending(f,over={}){const r=await f.call(USER,'/api/tech/apply',form(over));if(r.status!==200)throw Error(JSON.stringify(r));return (await f.call(ADMIN,'/api/tech/applications')).applications[0];}
export const review=(a,over={})=>({uid:a.uid,revision:a.revision,decision:'approve',checks:Object.fromEntries(['identity','phone','work','skills','shop','terms'].map(k=>[k,true])),evidence:evidence(),resolutions:{},note:'Test-only completed human review with evidence.',...over});
