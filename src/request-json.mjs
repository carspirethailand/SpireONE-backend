export class RequestBodyError extends Error {constructor(status,message){super(message);this.status=status;}}
/* Cap bytes while streaming, not after request.json() has allocated everything. */
export async function requestText(request,max=4*1024*1024){
  if(Number(request.headers.get('content-length'))>max)throw new RequestBodyError(413,'Request is too large');
  const reader=request.body?.getReader();if(!reader)return '';
  let size=0;const chunks=[];
  const timer=AbortSignal.timeout(10000);
  const timed=new Promise((_,reject)=>timer.addEventListener('abort',()=>reject(new RequestBodyError(408,'Request timed out')),{once:true}));
  try{
    for(;;){const {done,value}=await Promise.race([reader.read(),timed]);if(done)break;size+=value.byteLength;if(size>max)throw new RequestBodyError(413,'Request is too large');chunks.push(value);}
    const out=new Uint8Array(size);let at=0;for(const chunk of chunks){out.set(chunk,at);at+=chunk.length;}
    return new TextDecoder().decode(out);
  }catch(e){reader.cancel().catch(()=>{});throw e;}
}
export async function requestJson(request,max){const raw=await requestText(request,max);try{return JSON.parse(raw)}catch{return null}}
