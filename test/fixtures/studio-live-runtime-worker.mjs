// Isolated synthetic runtime only. Never deploy this fixture.
export {CendonStudioLive} from '../../src/studio-live-object.js';
export default {async fetch(request,env){const u=new URL(request.url),stub=env.LIVE.getByName('user:'+(u.searchParams.get('uid')||'one'));
 if(u.pathname==='/emit')return Response.json(await stub.invalidate(['posts','jobs','not-allowed']));
 return stub.fetch(new Request('https://studio.internal/connect',{headers:{Upgrade:'websocket','X-Studio-Until':String(Date.now()+(u.searchParams.has('expired')?-100:25*60000))}}));
}};
