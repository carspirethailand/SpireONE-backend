import {DurableObject} from 'cloudflare:workers';
import {StudioLiveHub} from './studio-live.mjs';
export class CendonStudioLive extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.hub=new StudioLiveHub(ctx);}
 fetch(request){return this.hub.fetch(request);}
 invalidate(topics){return this.hub.invalidate(topics);}
 webSocketMessage(socket,message){return this.hub.webSocketMessage(socket,message);}
 webSocketClose(socket,code){return this.hub.webSocketClose(socket,code);}
 webSocketError(socket){return this.hub.webSocketError(socket);}
}
