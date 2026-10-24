import rules from './garage-rules.mjs';
import {specKey,detailsKey} from './carspec.js';
import {documentedPrice} from './spec-details.mjs';
const parse=v=>{try{return JSON.parse(v)}catch{return null}};
export async function garageRulesFor(env,uid,id,incomingGarage){
  if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,59}$/.test(id))return null;
  if(await env.DB.prepare('SELECT t FROM user_state WHERE uid=? AND k=?').bind(uid,'_car_deleted:'+id).first())return null;
  const canonical=await env.DB.prepare('SELECT * FROM cars WHERE id=?').bind(id).first();
  if(canonical&&canonical.uid!==uid)return null;
  const own=await env.DB.prepare('SELECT v FROM user_state WHERE uid=? AND k=?').bind(uid,'garage').first();
  const list=Array.isArray(incomingGarage)?incomingGarage:parse(own?.v);
  const saved=Array.isArray(list)?list.find(c=>c?.id===id):null;
  const car=canonical||saved;if(!car)return null;
  const row=await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('garage_cost_reference').first();
  let ref=rules.reference(car,parse(row?.value));
  if(!ref){
    try{const keys=[detailsKey(car.make,car.model,car.year,'TH'),detailsKey(car.make,car.model,car.year,'GLOBAL'),specKey(car.make,car.model,car.year,'TH'),specKey(car.make,car.model,car.year,'GLOBAL')];const rows=await env.DB.prepare('SELECT * FROM car_specs WHERE k IN (?,?,?,?)').bind(...keys).all();const records=(rows.results||[]).map(r=>({...r,data:parse(r.data),sources:parse(r.sources)}));const found=documentedPrice(car,records);ref=rules.reference(car,found?[found]:[])}catch{}
  }
  return {car,ref,policy:rules.costPolicy(car,ref)};
}
export async function validateGarageWrite(env,uid,key,value,incomingGarage){
  if(key==='garage'&&value!==null){
    if(!Array.isArray(value))throw Object.assign(Error('Invalid Garage list'),{status:400});
    const row=await env.DB.prepare('SELECT v FROM user_state WHERE uid=? AND k=?').bind(uid,key).first();
    const old=parse(row?.v),seen=new Set();
    if(value.length>Math.max(100,Array.isArray(old)?old.length:0))throw Object.assign(Error('Too many cars'),{status:400});
    for(const car of value){
      if(!car||typeof car.id!=='string'||seen.has(car.id))throw Object.assign(Error('Invalid car'),{status:400});seen.add(car.id);
      const prev=Array.isArray(old)?old.find(x=>x?.id===car.id):null;
      if(car.info!=null)rules.infoPatch(car.info,prev?.info||{});
    }
    return value;
  }
  const m=/^(?:carlab_(?:log|todo|iv|sym)|cal_price)_([A-Za-z0-9_.:-]{1,60})$/.exec(key);
  if(!m||value===null)return value;
  const ctx=await garageRulesFor(env,uid,m[1],incomingGarage);
  const old=await env.DB.prepare('SELECT v FROM user_state WHERE uid=? AND k=?').bind(uid,key).first();
  return rules.validateState(key,value,parse(old?.v),ctx?.car,ctx?.ref);
}
export async function appendGarageLog(env,uid,body,now=Date.now()){
  const {carId,kind,entry,requestId}=body||{};
  if(!['fuel','services','trips'].includes(kind)||typeof requestId!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(requestId))throw Object.assign(Error('Invalid log request'),{status:400});
  const ctx=await garageRulesFor(env,uid,carId);
  if(!ctx)throw Object.assign(Error('Car not found'),{status:404});
  rules.record(kind,entry,ctx.car,ctx.ref,now);
  const fields=kind==='services'?['k','km','amount','date','note']:kind==='fuel'?['km','amount','litres','date','note']:['title','km','date','note'];
  const e={id:requestId};
  for(const field of fields)if(entry[field]!=null)e[field]=['km','amount','litres'].includes(field)?Number(String(entry[field]).replace(/,/g,'')):entry[field];
  const key='carlab_log_'+carId;
  for(let attempt=0;attempt<3;attempt++){
    const old=await env.DB.prepare('SELECT v,t FROM user_state WHERE uid=? AND k=?').bind(uid,key).first();
    const log=parse(old?.v)||body.baseLog||{services:[],fuel:[],trips:[]};
    if(!old)rules.validateState(key,log,null,ctx.car,ctx.ref,now);
    for(const k of ['services','fuel','trips'])if(!Array.isArray(log[k]))log[k]=[];
    const duplicate=log[kind].find(x=>x.id===requestId);
    if(duplicate)return {entry:duplicate,log,duplicate:true};
    if(log[kind].length>=1000)throw Object.assign(Error('Logbook limit reached'),{status:400});
    log[kind].push(e);
    const raw=JSON.stringify(log);if(raw.length>256*1024)throw Object.assign(Error('Logbook too large'),{status:400});
    const r=await env.DB.prepare(`INSERT INTO user_state(uid,k,v,t) VALUES(?,?,?,?)
      ON CONFLICT(uid,k) DO UPDATE SET v=excluded.v,t=excluded.t WHERE user_state.t=? RETURNING t`)
      .bind(uid,key,raw,Math.max(now,Number(old?.t||0)+1),old?.t||0).first();
    if(r)return {entry:e,log};
  }
  throw Object.assign(Error('Another device updated the logbook; retry'),{status:409});
}
