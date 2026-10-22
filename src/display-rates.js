/* Public reference data only: never forward a user token, IP, amount or account. */
const currencies=['USD','EUR','GBP','JPY','CNY','SGD','AUD','CAD','CHF','NZD','HKD','MYR','IDR','KRW','VND','INR','TWD','AED'];
export async function displayRates(request,cors={}){
  const headers={...cors,'Content-Type':'application/json','Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff','Vary':'Origin'};
  if(request.method!=='GET')return Response.json({error:'Method not allowed'},{status:405,headers:{...headers,Allow:'GET'}});
  let stage='fetch';
  try{
    const r=await fetch('https://api.frankfurter.dev/v2/rates?base=THB&quotes='+currencies.join(','),{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(8000),cf:{cacheEverything:true,cacheTtl:3600}});
    stage='upstream_'+r.status;
    if(!r.ok)throw Error('upstream');
    stage='body';
    const reader=r.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768){await reader.cancel();throw Error('size')}chunks.push(value)}}finally{reader.releaseLock()}
    const all=new Uint8Array(size);let offset=0;for(const b of chunks){all.set(b,offset);offset+=b.length}
    stage='format';const rows=JSON.parse(new TextDecoder().decode(all));if(!Array.isArray(rows)||rows.length>currencies.length)throw Error('shape');
    stage='validation';
    const rates={THB:1},dates=[];
    for(const x of rows){const time=Date.parse(x.date+'T00:00:00Z');if(x.base!=='THB'||!currencies.includes(x.quote)||!Number.isFinite(x.rate)||x.rate<=0||x.rate>1e9||!Number.isFinite(time)||time>Date.now()+86400000||Date.now()-time>7*86400000)throw Error('invalid');rates[x.quote]=x.rate;dates.push(time)}
    if(!dates.length)throw Error('empty');
    return Response.json({result:'success',base_code:'THB',rates,time_last_update_unix:Math.min(...dates)/1000,source:'Frankfurter',estimated:true},{headers});
  }catch{return Response.json({error:'Reference rates unavailable',code:'rates_'+stage},{status:503,headers:{...headers,'Cache-Control':'no-store'}})}
}
