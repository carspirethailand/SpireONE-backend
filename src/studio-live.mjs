// Invalidation only. Business data stays behind its existing authenticated API.
export const STUDIO_PROTOCOL='cendon-studio.v1';
export const STUDIO_TOPICS=Object.freeze(['jobs','posts','threads','profile','services','stats']);
export const studioTopics=list=>Array.isArray(list)?[...new Set(list.filter(x=>STUDIO_TOPICS.includes(x)))]:[];
export const studioLiveReady=env=>typeof env.STUDIO_LIVE?.getByName==='function';
export function studioOriginAllowed(request,env){
 const origin=request.headers.get('Origin');if(!origin)return true;
 const allowed=new Set();for(const raw of [env.APP_URL,...String(env.ALLOWED_ORIGINS||'').split(',')])try{if(raw&&raw!=='*')allowed.add(new URL(raw.trim()).origin)}catch{}
 return allowed.has(origin);
}
export function studioAuthRequest(request){
 const protocols=String(request.headers.get('Sec-WebSocket-Protocol')||'').split(',').map(x=>x.trim());
 const tokens=protocols.filter(x=>x.startsWith('auth.'));
 if(!protocols.includes(STUDIO_PROTOCOL)||tokens.length!==1||tokens[0].length<6||tokens[0].length>8192)return null;
 const headers=new Headers(request.headers);headers.set('Authorization','Bearer '+tokens[0].slice(5));
 // Never put this credential in a URL, event, log, stored attachment or response.
 headers.delete('Sec-WebSocket-Protocol');return new Request(request,{headers});
}
export async function connectStudio(request,env,authenticate){
 const deny=(status,error)=>Response.json({error},{status,headers:{'Cache-Control':'private, no-store'}});
 if(request.method!=='GET'||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return deny(426,'WebSocket upgrade required');
 if(!studioOriginAllowed(request,env))return deny(403,'Origin not allowed');
 const auth=studioAuthRequest(request);if(!auth)return deny(401,'Authentication required');
 const me=await authenticate(auth);if(!me?.uid)return deny(401,'Authentication required');
 if(!studioLiveReady(env))return deny(503,'Live updates unavailable');
 const stub=env.STUDIO_LIVE.getByName('user:'+me.uid);
 return stub.fetch(new Request('https://studio.internal/connect',{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':STUDIO_PROTOCOL,'X-Studio-Until':String(Date.now()+25*60000)}}));
}
export async function publishStudioChanges(env,changes){
 if(!studioLiveReady(env))return {available:false};
 const targets=new Map();for(const [uid,list]of changes){if(typeof uid!=='string'||!uid||uid.length>128)continue;const topics=studioTopics(list);if(!topics.length)continue;targets.set(uid,[...new Set([...(targets.get(uid)||[]),...topics])]);}
 const entries=[...targets];let cursor=0,failed=0;
 await Promise.all(Array.from({length:Math.min(12,entries.length)},async()=>{while(cursor<entries.length){const [uid,topics]=entries[cursor++];try{await env.STUDIO_LIVE.getByName('user:'+uid).invalidate(topics)}catch{failed++;}}}));
 // A failed wake-up is recoverable by reconnect/pulse. Do not log identities.
 if(failed)console.warn('studio.live.publish_unavailable');return {available:true,failed};
}
export class StudioLiveHub{
 constructor(ctx){this.ctx=ctx;if(typeof WebSocketRequestResponsePair!=='undefined')ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));}
 prune(){for(const socket of this.ctx.getWebSockets())try{if(!(socket.deserializeAttachment()?.until>Date.now()))socket.close(1008,'Reconnect required')}catch{try{socket.close(1008,'Reconnect required')}catch{}}}
 fetch(request){
  if(request.method!=='GET'||new URL(request.url).pathname!=='/connect'||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('Not found',{status:404});
  this.prune();if(this.ctx.getWebSockets().filter(s=>s.deserializeAttachment()?.until>Date.now()).length>=8)return new Response('Connection limit',{status:429});
  const until=Number(request.headers.get('X-Studio-Until'));if(!Number.isFinite(until)||until<=Date.now()||until>Date.now()+26*60000)return new Response('Invalid lease',{status:403});
  const pair=new WebSocketPair(),[client,server]=Object.values(pair);this.ctx.acceptWebSocket(server);server.serializeAttachment({until});
  server.send(JSON.stringify({type:'ready',topics:STUDIO_TOPICS}));
  return new Response(null,{status:101,webSocket:client,headers:{'Sec-WebSocket-Protocol':STUDIO_PROTOCOL}});
 }
 invalidate(list){
  const topics=studioTopics(list);if(!topics.length)return {sent:0};this.prune();
  const event=JSON.stringify({type:'invalidate',topics,revision:crypto.randomUUID(),at:Date.now()});let sent=0;
  for(const socket of this.ctx.getWebSockets())try{if(socket.deserializeAttachment()?.until>Date.now()){socket.send(event);sent++}}catch{try{socket.close(1011,'Reconnect required')}catch{}}
  return {sent};
 }
 webSocketMessage(socket,message){if(message==='ping'){socket.send('pong');return}socket.close(1008,'Unsupported message');}
 webSocketClose(socket,code){try{socket.close(code===1005||code===1006?1000:code,'')}catch{}}
 webSocketError(socket){try{socket.close(1011,'Reconnect required')}catch{}}
}
