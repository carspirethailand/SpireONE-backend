/* Server-side boundaries for the staff workspace. UI filtering is not authorization. */
export class WorkspaceError extends Error { constructor(status,message){super(message);this.status=status;} }
const stop=(status=403,message='Forbidden')=>{throw new WorkspaceError(status,message);};
export const workspaceMeta=row=>{try{const x=JSON.parse(row?.keywords||'{}');return x&&typeof x==='object'&&!Array.isArray(x)?x:{};}catch{return {};}};
const DEPTS=new Set(['exec','backend','frontend','ai','design','qa','ops','marketing','finance','support']);
const DEFAULT_DEPT={ceo:'exec',cto:'backend',cfo:'finance',coo:'ops',cmo:'marketing',head_ai:'ai',head_ops:'ops',support:'support',staff:'ops'};
const KIND=/^(pos|nda|lgl|vc|sig|mt|msg|ch|hb)_[A-Za-z0-9ก-๙:_.-]{1,160}$/;
const validMeta=row=>{try{const v=JSON.parse(row?.keywords||'{}');return !!v&&typeof v==='object'&&!Array.isArray(v)}catch{return false}};
export function meetingLink(value){try{const u=new URL(String(value||''));return u.protocol==='https:'&&!u.username&&!u.password&&u.href.length<=1200?u.href:'';}catch{return '';}}
export function workspacePolicy(actor,records,people){
  const uid=actor.payload.sub, admin=['owner','admin'].includes(actor.role),owner=actor.role==='owner';
  const byId=new Map(records.map(r=>[r.id,r])),users=new Map(people.map(u=>[u.uid,u]));
  const person=users.get(uid),position=workspaceMeta(byId.get('pos_'+uid));
  const dept=DEPTS.has(position.d)?position.d:DEFAULT_DEPT[position.p]||({owner:'exec',admin:'ops',moderator:'support'}[actor.role])||'ops';
  const mine=row=>row?.author===actor.email&&!!actor.email;
  function room(id){
    if(id==='team')return true;
    if(typeof id!=='string'||id.length>320)return false;
    if(id.startsWith('dm:')){const ids=id.slice(3).split('|');return ids.length===2&&ids[0]!==ids[1]&&ids.includes(uid)&&ids.every(id=>users.has(id));}
    if(id.startsWith('dept:'))return DEPTS.has(id.slice(5))&&(owner||id.slice(5)===dept);
    if(id.startsWith('ch:')){const row=byId.get('ch_'+id.slice(3));if(!row||!validMeta(row))return false;const m=workspaceMeta(row);return owner||m.by===uid||mine(row)||m.m==null||Array.isArray(m.m)&&(!m.m.length||m.m.includes(uid));}
    return false;
  }
  function signal(row){
    const m=workspaceMeta(row);
    if(typeof m.from==='string'&&typeof m.to==='string')return {from:m.from,to:m.to};
    // Legacy IDs have no explicit sender fields. Resolve against known UIDs, not underscore splitting.
    for(const to of users.keys())for(const from of users.keys())if(row.id.startsWith('sig_'+to+'_'+from+'_'))return {from,to};
    return {};
  }
  function read(row){
    if(!validMeta(row))return owner; // damaged/truncated metadata must not become a public room
    if(/^(pos|hb)_/.test(row.id)||row.make==='__handbook__')return true;
    if(/^(nda|lgl)_/.test(row.id))return owner||row.id.slice(4)===uid;
    const m=workspaceMeta(row);
    if(row.id.startsWith('ch_'))return room('ch:'+row.id.slice(3));
    if(row.id.startsWith('sig_')){const s=signal(row);return (s.from===uid||s.to===uid)&&room(m.r||'team');}
    if(/^(msg|mt|vc)_/.test(row.id))return room(m.r||'team');
    return false;
  }
  function remove(row){
    if(!row)return false;
    if(/^(pos|hb)_/.test(row.id))return admin;
    if(/^(nda|lgl)_/.test(row.id))return owner||row.id.slice(4)===uid;
    if(!read(row))return false;
    if(row.id.startsWith('sig_'))return true; // recipient consumes the signal
    if(row.id.startsWith('vc_'))return owner||workspaceMeta(row).u===uid||row.id.endsWith('__'+uid);
    return admin||mine(row);
  }
  function write(input){
    const id=String(input.id||'');if(!KIND.test(id))stop();
    if(!validMeta(input))stop(400,'Invalid workspace metadata');
    const old=byId.get(id),m=workspaceMeta({keywords:input.keywords}),prior=workspaceMeta(old),kind=id.split('_')[0];
    if(['pos','hb'].includes(kind)){if(!admin)stop();}
    else if(['nda','lgl'].includes(kind)){if(id.slice(4)!==uid)stop();}
    else if(kind==='ch'){
      if(old&&!admin&&!mine(old))stop();
      m.k=id.slice(3);m.by=old?(prior.by||uid):uid;
      m.m=Array.isArray(m.m)?[...new Set(m.m.filter(x=>typeof x==='string'&&users.has(x)))].slice(0,100):null;
      m.n=String(m.n||input.title||'').slice(0,100);m.d=DEPTS.has(m.d)?m.d:'';
    } else {
      m.r=String(m.r||'team');if(!room(m.r)||old&&!read(old))stop();
      if(kind==='msg'){
        if(old&&!mine(old))stop();
        if(m.u&&m.u!==uid)stop();m.u=uid;m.n=String(person?.name||actor.email||'Team').slice(0,80);m.t=Date.now();
        m.a=['image','audio','video'].includes(m.a)?m.a:'';m.cap=String(m.cap||'').slice(0,160);
      }else if(kind==='vc'){
        if(id!=='vc_'+m.r.replace(/[^a-zA-Z0-9ก-๙:_-]/g,'')+'__'+uid||m.u&&m.u!==uid)stop();
        m.u=uid;m.n=String(person?.name||'Team').slice(0,40);m.t=Date.now();m.cam=m.cam?1:0;m.mic=m.mic?1:0;
      }else if(kind==='sig'){
        const to=String(m.to||signal({id,keywords:input.keywords}).to||'');
        if(!users.has(to)||!id.startsWith('sig_'+to+'_'+uid+'_')||m.from&&m.from!==uid)stop();
        m.from=uid;m.to=to;m.t=Date.now();m.n=String(person?.name||'Team').slice(0,40);
        if(!['offer','answer','ice','hangup','reject','busy','end','invite','decline','bye'].includes(m.k))stop(400,'Invalid signal');
      }else if(kind==='mt'){
        if(!Number.isFinite(Number(m.t))||Number(m.t)<0)stop(400,'Invalid meeting time');
        m.t=Number(m.t);m.len=Math.max(5,Math.min(1440,Number(m.len)||30));
        if(m.lk&&!meetingLink(m.lk))stop(400,'Meeting link must use HTTPS');m.lk=meetingLink(m.lk);
        m.by=old?(prior.by||uid):uid;m.byn=old?String(prior.byn||'').slice(0,80):String(person?.name||'Team').slice(0,80);
        m.at=Array.isArray(m.at)?[...new Set(m.at.filter(x=>typeof x==='string'&&users.has(x)))].slice(0,100):[];
        if(old&&!mine(old)&&!admin){
          for(const k of ['r','t','len','lk'])if(m[k]!==prior[k])stop();
          const before=(Array.isArray(prior.at)?prior.at:[]).filter(x=>x!==uid).sort(),after=m.at.filter(x=>x!==uid).sort();
          if(JSON.stringify(before)!==JSON.stringify(after)||String(input.title)!==old.title)stop();
        }
      }
    }
    const keywords=JSON.stringify(m);if(keywords.length>4000)stop(400,'Workspace metadata is too large');
    return {...input,id,keywords};
  }
  return {read,write,remove,room};
}
