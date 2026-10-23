/* Account-scoped durable work. Payloads/results are encrypted, never logged. */
import {seal,open,vaultReady} from './vault.js';
const DAY=86400000,CHUNK=60000,MAX_BYTES=24*1024*1024;
const done=s=>['complete','error','cancelled'].includes(s);
const fail=(error,status=400)=>({error,status});
const validId=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
const validCar=x=>typeof x==='string'&&/^[\w-]{1,100}$/.test(x);
const clean=m=>({id:m.id,sessionId:m.sessionId,carId:m.carId,status:m.status,createdAt:m.createdAt,updatedAt:m.updatedAt,expiresAt:m.expiresAt});
export class ChatJobEngine {
  constructor(ctx,env,execute,notify){this.ctx=ctx;this.env=env;this.execute=execute;this.notify=notify}
  key(uid,id,kind){return 'cendon:chat-job:'+uid+':'+id+':'+kind}
  async owner(uid){return (await this.ctx.storage.get('owner'))===uid}
  async writeBlob(tx,id,kind,value){const chunks=Math.ceil(value.length/CHUNK);const entries={};for(let i=0;i<chunks;i++)entries[`${kind}:${id}:${i}`]=value.slice(i*CHUNK,(i+1)*CHUNK);await tx.put(entries);return chunks}
  async dropBlob(tx,m,kind){const n=m[kind+'Parts']||0;if(n)await tx.delete(Array.from({length:n},(_,i)=>`${kind}:${m.id}:${i}`))}
  async blob(uid,m,kind){let value='';for(let i=0;i<(m[kind+'Parts']||0);i++){const part=await this.ctx.storage.get(`${kind}:${m.id}:${i}`);if(typeof part!=='string')throw Error('incomplete');value+=part}return JSON.parse(await open(this.env,value,this.key(uid,m.id,kind)))}
  async create(uid,actor,b){
    if(!validId(b?.jobId)||!/^s[a-z0-9]{8,60}$/i.test(b.sessionId||'')||!validCar(b.carId))return fail('Invalid chat job');
    if(!await vaultReady(this.env))return fail('Chat storage unavailable',503);
    const raw=JSON.stringify({body:b,actor:{payload:{sub:uid},role:actor.role}});if(new TextEncoder().encode(raw).length>MAX_BYTES)return fail('Chat request too large',413);
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))).map(n=>n.toString(16).padStart(2,'0')).join('');
    const encrypted=await seal(this.env,raw,this.key(uid,b.jobId,'input'));
    return this.ctx.storage.transaction(async tx=>{
      const owner=await tx.get('owner');if(owner&&owner!==uid)return fail('Not found',404);
      const old=await tx.get('m:'+b.jobId);if(old)return old.digest===digest?{job:clean(old)}:fail('Job identifier conflict',409);
      let rows=[...(await tx.list({prefix:'m:'})).values()];
      const prune=rows.filter(m=>m.expiresAt<=Date.now()||done(m.status)).sort((a,b)=>b.createdAt-a.createdAt);
      for(const m of prune.filter((m,i)=>m.expiresAt<=Date.now()||i>=17)){await this.dropBlob(tx,m,'input');await this.dropBlob(tx,m,'result');await tx.delete('m:'+m.id);rows=rows.filter(x=>x.id!==m.id)}
      if(rows.filter(m=>!done(m.status)).length>=3)return fail('Three answers are already queued',409);
      const at=Date.now(),m={id:b.jobId,sessionId:b.sessionId,carId:b.carId,status:'queued',digest,createdAt:at,updatedAt:at,expiresAt:at+DAY};
      m.inputParts=await this.writeBlob(tx,m.id,'input',encrypted);await tx.put({'owner':uid,['m:'+m.id]:m});await tx.setAlarm(at+1);return {job:clean(m)};
    });
  }
  async list(uid){if(!await this.owner(uid))return {jobs:[]};const rows=[...(await this.ctx.storage.list({prefix:'m:'})).values()];return {jobs:rows.filter(m=>m.expiresAt>Date.now()).sort((a,b)=>b.createdAt-a.createdAt).slice(0,20).map(clean)}}
  async read(uid,id){if(!validId(id)||!await this.owner(uid))return fail('Not found',404);const m=await this.ctx.storage.get('m:'+id);if(!m||m.expiresAt<=Date.now())return fail('Not found',404);let result={};if(m.resultParts)try{result=await this.blob(uid,m,'result')}catch{return fail('Answer temporarily unavailable',503)}return {job:{...clean(m),...result}}}
  async cancel(uid,id){if(!validId(id)||!await this.owner(uid))return fail('Not found',404);return this.ctx.storage.transaction(async tx=>{const m=await tx.get('m:'+id);if(!m)return fail('Not found',404);if(!done(m.status)){m.status='cancelled';m.updatedAt=Date.now();await this.dropBlob(tx,m,'input');m.inputParts=0;await tx.put('m:'+id,m)}return {job:clean(m)}})}
  async purge(uid){if(!await this.owner(uid))return {ok:true};await this.ctx.storage.deleteAll();await this.ctx.storage.deleteAlarm();return {ok:true}}
  async result(uid,id,result,status){
    const encrypted=await seal(this.env,JSON.stringify(result),this.key(uid,id,'result'));
    return this.ctx.storage.transaction(async tx=>{const m=await tx.get('m:'+id);if(!m||m.status!=='running')return false;
      await this.dropBlob(tx,m,'result');m.resultParts=await this.writeBlob(tx,id,'result',encrypted);m.updatedAt=Date.now();if(status)m.status=status;
      if(done(m.status)){await this.dropBlob(tx,m,'input');m.inputParts=0;if(this.notify){m.deliveryAt=Date.now();m.deliveryTries=0;await tx.setAlarm(Date.now()+1)}}await tx.put('m:'+id,m);return true;
    });
  }
  async alarm(){
    const uid=await this.ctx.storage.get('owner');if(!uid)return;
    let rows=[...(await this.ctx.storage.list({prefix:'m:'})).values()];
    for(const m of rows.filter(m=>m.expiresAt<=Date.now()))await this.ctx.storage.transaction(async tx=>{await this.dropBlob(tx,m,'input');await this.dropBlob(tx,m,'result');await tx.delete('m:'+m.id)});
    rows=rows.filter(m=>m.expiresAt>Date.now());
    /* An interrupted paid inference is not blindly replayed on alarm retry. */
    for(const m of rows.filter(m=>m.status==='running'))await this.result(uid,m.id,{text:'การประมวลผลสะดุด กรุณาส่งใหม่อีกครั้ง',retryable:true},'error');
    const m=rows.filter(m=>m.status==='queued').sort((a,b)=>a.createdAt-b.createdAt)[0];
    if(m){
      const claimed=await this.ctx.storage.transaction(async tx=>{const live=await tx.get('m:'+m.id);if(live?.status!=='queued')return false;live.status='running';await tx.put('m:'+m.id,live);return true});
      if(claimed){let result={text:'',research:[],statusText:'กำลังคิด'},last=0;
        const active=async()=>{const live=await this.ctx.storage.get('m:'+m.id);return live?.status==='running'&&live.expiresAt>Date.now()};
        try{const input=await this.blob(uid,m,'input');await this.execute(this.env,input.actor,input.body,async event=>{
          if(!await active())throw Error('job no longer active');
          if(event.type==='text')result.text=(result.text+String(event.delta||'')).slice(0,160000);
          if(event.type==='text_done')result.text=String(event.text||result.text).slice(0,160000);
          if(event.type==='status')result.statusText=String(event.text||'').slice(0,160);
          if(event.type==='research'&&result.research.length<12)result.research.push(String(event.q||'').slice(0,120));
          if(event.type==='done')result.usage=event.usage||null;
          if(event.type==='error')throw Error('generation failed');
          if(Date.now()-last>1000||event.type==='done'){last=Date.now();await this.result(uid,m.id,result)}
        },{active});result.statusText='';await this.result(uid,m.id,result,'complete');}
        catch{await this.result(uid,m.id,{text:result.text||'ยังตอบไม่ได้ชั่วคราว กรุณาลองใหม่',retryable:true},'error')}
      }
    }
    /* Retry delivery only; never repeat an inference because a push failed. Stable tags deduplicate notifications. */
    if(this.notify)for(const row of (await this.ctx.storage.list({prefix:'m:'})).values()){
      if(!['complete','error'].includes(row.status)||!row.deliveryAt||row.deliveryAt>Date.now()||row.deliveryTries>=3)continue;
      let sent=false;try{await this.notify(uid,clean(row));sent=true}catch{}
      await this.ctx.storage.transaction(async tx=>{const m=await tx.get('m:'+row.id);if(!m||m.status!==row.status)return;m.deliveryTries=(m.deliveryTries||0)+1;m.deliveryAt=sent||m.deliveryTries>=3?null:Date.now()+30000*m.deliveryTries;await tx.put('m:'+m.id,m)});
    }
    const live=[...(await this.ctx.storage.list({prefix:'m:'})).values()];
    if(live.length)await this.ctx.storage.setAlarm(live.some(x=>x.status==='queued')?Date.now()+1:Math.min(...live.flatMap(x=>[x.expiresAt,...(x.deliveryAt?[x.deliveryAt]:[])])));
    else{await this.ctx.storage.deleteAll();await this.ctx.storage.deleteAlarm()}
  }
}
