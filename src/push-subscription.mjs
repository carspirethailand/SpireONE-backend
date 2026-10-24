/* Accept browser push services, never caller-chosen arbitrary fetch destinations. */
export async function pushSubscription(input){
  let url;try{url=new URL(input?.endpoint)}catch{throw Error('Invalid push endpoint')}
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.href.length>800||url.hash||!(['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(host)||host.endsWith('.notify.windows.com')))throw Error('Unsupported push endpoint');
  function bytes(value,n){
    if(typeof value!=='string'||! /^[A-Za-z0-9_-]+={0,2}$/.test(value))throw Error('Invalid push key');
    const raw=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));if(raw.length!==n)throw Error('Invalid push key');return raw;
  }
  const point=bytes(input?.keys?.p256dh,65);if(point[0]!==4)throw Error('Invalid push public point');
  await crypto.subtle.importKey('raw',point,{name:'ECDH',namedCurve:'P-256'},false,[]);bytes(input?.keys?.auth,16);
  return {endpoint:url.href,keys:{p256dh:input.keys.p256dh,auth:input.keys.auth}};
}
