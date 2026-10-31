// Synthetic integration entry only: not part of any production build.
import {handleTech} from '../../src/techs.js';
export {CendonStudioLive} from '../../src/studio-live-object.js';
export default {async fetch(request,env,ctx){const p=new URL(request.url).pathname;
 if(p.startsWith('/api/tech'))return handleTech(request,{...env,APP_URL:new URL(request.url).origin,PIN_WATER_OFF:'1'},undefined,{ctx,verifyToken:async token=>({sub:token,email:token+'@fixture.test',email_verified:true})});
 if(p==='/studio-live.js')return new Response(env.SCRIPT,{headers:{'Content-Type':'text/javascript'}});
 return new Response(env.HTML,{headers:{'Content-Type':'text/html; charset=utf-8'}});
}};
