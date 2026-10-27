import {DurableObject} from 'cloudflare:workers';
import {ChatJobEngine} from './chat-jobs.mjs';
import {executeChatJob,completeChatJob} from './worker.js';
export class CendonChatJobs extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.jobs=new ChatJobEngine(ctx,env,executeChatJob,(uid,job)=>completeChatJob(env,uid,job))}
  create(uid,actor,body){return this.jobs.create(uid,actor,body)}
  list(uid){return this.jobs.list(uid)}
  read(uid,id){return this.jobs.read(uid,id)}
  stream(uid,id){return this.jobs.stream(uid,id)}
  cancel(uid,id){return this.jobs.cancel(uid,id)}
  purge(uid){return this.jobs.purge(uid)}
  alarm(){return this.jobs.alarm()}
}
