/* Synthetic executor only. This file is never an entry point for deployment. */
import {DurableObject} from 'cloudflare:workers';
import {ChatJobEngine} from '../../src/chat-jobs.mjs';
export class TestJobs extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.engine=new ChatJobEngine(ctx,env,async(e,a,b,send)=>{
    await new Promise(r=>setTimeout(r,200));await send({type:'text',delta:'Runtime fixture answer'});await send({type:'done'});
  })}
  create(uid,b){return this.engine.create(uid,{role:'user'},b)}
  read(uid,id){return this.engine.read(uid,id)}
  list(uid){return this.engine.list(uid)}
  cancel(uid,id){return this.engine.cancel(uid,id)}
  purge(uid){return this.engine.purge(uid)}
  alarm(){return this.engine.alarm()}
}
export default {async fetch(request,env){const u=new URL(request.url),uid=u.searchParams.get('uid')||'one',stub=env.JOBS.getByName('user:'+uid),id=u.searchParams.get('id');
  const r=request.method==='POST'?await stub.create(uid,await request.json()):id?await stub.read(uid,id):await stub.list(uid);
  return Response.json(r,{status:r.status||200});
}};
