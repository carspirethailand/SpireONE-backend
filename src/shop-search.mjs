/* Official APIs only. No scraping, generated listings, invented prices or keys in URLs. */
const NAMES={shopee:'Shopee',amazon:'Amazon',aliexpress:'AliExpress',ebay:'eBay',maps:'Google Maps'};
const REQUIRED={shopee:['SHOPEE_APP_ID','SHOPEE_APP_SECRET'],amazon:['AMAZON_CREATOR_ID','AMAZON_CREATOR_SECRET','AMAZON_PARTNER_TAG'],aliexpress:['ALIEXPRESS_APP_KEY','ALIEXPRESS_APP_SECRET','ALIEXPRESS_TRACKING_ID'],ebay:['EBAY_CLIENT_ID','EBAY_CLIENT_SECRET'],maps:['GOOGLE_MAPS_API_KEY']};
const HOSTS={shopee:['shopee.co.th'],amazon:['amazon.com','amazon.co.uk','amazon.co.jp','amazon.sg','amazon.com.au'],aliexpress:['aliexpress.com'],ebay:['ebay.com','ebay.co.uk','ebay.de','ebay.com.au'],maps:['google.com','maps.google.com']};
const ready=(env,id)=>REQUIRED[id].every(k=>typeof env[k]==='string'&&env[k].trim())&&(id!=='maps'||env.SHOP_GOOGLE_MAPS_ENABLED==='1');
export function shopStatus(env){return {providers:Object.entries(NAMES).map(([id,name])=>({id,name,state:ready(env,id)?'ready':'setup_required'})),livePricesOnly:true,fitmentRequiresVerification:true}}
export function productUrl(url,id){try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&HOSTS[id]?.some(h=>u.hostname===h||u.hostname.endsWith('.'+h))?u.href:null}catch{return null}}
function imageUrl(url){try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['ebayimg.com','media-amazon.com','ssl-images-amazon.com','susercontent.com','alicdn.com','aliexpress-media.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h))?u.href:null}catch{return null}}
const text=(s,n=220)=>String(s??'').replace(/[\u0000-\u001f]/g,' ').slice(0,n);
const amount=v=>{const n=typeof v==='number'?v:Number(v);return v!==null&&v!==undefined&&v!==''&&Number.isFinite(n)&&n>=0&&n<=1e9?n:null};
function item(provider,x){const url=productUrl(x.url,provider),price=amount(x.price),currency=/^[A-Z]{3}$/.test(x.currency||'')?x.currency:null;
  if(!url||!x.title||price===null||!currency)return null;return {id:provider+':'+text(x.id,100),provider,title:text(x.title),url,image:imageUrl(x.image),price,currency,seller:text(x.seller,100),observedAt:Date.now(),fitConfirmed:false};
}
export function shopInput(b){
  const q=String(b?.query||'').trim();if(q.length<2||q.length>180||/[\u0000-\u001f]/.test(q)||/\b\d{13}\b|\b[A-HJ-NPR-Z0-9]{17}\b|\S+@\S+\.\S+/i.test(q))throw Object.assign(Error('Use a part name or part number, not private identifiers'),{status:400});
  const providers=[...new Set(Array.isArray(b.providers)?b.providers:['shopee','amazon','aliexpress','ebay'])];if(!providers.length||providers.length>5||providers.some(p=>!NAMES[p]))throw Object.assign(Error('Invalid platforms'),{status:400});
  const lat=Number(b.lat),lng=Number(b.lng),location=b.locationConsent===true&&b.lat!=null&&b.lng!=null&&Number.isFinite(lat)&&Math.abs(lat)<=90&&Number.isFinite(lng)&&Math.abs(lng)<=180?{lat,lng}:null;
  return {query:q,providers,location,lang:b.lang==='en'?'en':'th'};
}
async function jsonFetch(fetcher,url,options={}){
  const r=await fetcher(url,{...options,redirect:'manual',signal:AbortSignal.timeout(9000)});if(!r.ok){const why=await r.text().then(t=>t.replace(/\s+/g,' ').slice(0,300)).catch(()=>'');throw Error('upstream unavailable HTTP '+r.status+(why?' '+why:''))}
  const reader=r.body?.getReader();if(!reader)throw Error('upstream unavailable');let size=0,all=[];
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1500000)throw Error('upstream oversized');all.push(value)}}finally{await reader.cancel().catch(()=>{})}
  const buffer=new Uint8Array(size);let at=0;for(const x of all){buffer.set(x,at);at+=x.length}return JSON.parse(new TextDecoder().decode(buffer));
}
const enc=new TextEncoder(),hex=b=>Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');
async function ebay(env,q,fetcher){
  const token=await jsonFetch(fetcher,'https://api.ebay.com/identity/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+btoa(env.EBAY_CLIENT_ID+':'+env.EBAY_CLIENT_SECRET),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',scope:'https://api.ebay.com/oauth/api_scope'}).toString()});
  if(!token.access_token)throw Error('authorization');
  const d=await jsonFetch(fetcher,'https://api.ebay.com/buy/browse/v1/item_summary/search?'+new URLSearchParams({q,limit:'10'}),{headers:{Authorization:'Bearer '+token.access_token,'X-EBAY-C-MARKETPLACE-ID':'EBAY_US'}});
  if(d.errors?.length||(!Array.isArray(d.itemSummaries)&&d.total!==0))throw Error('invalid upstream response');
  return (d.itemSummaries||[]).map(x=>item('ebay',{id:x.itemId,title:x.title,url:x.itemAffiliateWebUrl||x.itemWebUrl,image:x.image?.imageUrl,price:x.price?.value,currency:x.price?.currency,seller:x.seller?.username})).filter(Boolean);
}
async function amazon(env,q,fetcher){
  const region={NA:'api.amazon.com',EU:'api.amazon.co.uk',FE:'api.amazon.co.jp'}[env.AMAZON_CREATOR_REGION||'NA'];if(!region)throw Error('configuration');
  const market=env.AMAZON_MARKETPLACE||'www.amazon.com';if(!HOSTS.amazon.includes(market.replace(/^www\./,'')))throw Error('configuration');
  const token=await jsonFetch(fetcher,'https://'+region+'/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:env.AMAZON_CREATOR_ID,client_secret:env.AMAZON_CREATOR_SECRET,scope:'creatorsapi::default'})});if(!token.access_token)throw Error('authorization');
  const d=await jsonFetch(fetcher,'https://creatorsapi.amazon/catalog/v1/searchItems',{method:'POST',headers:{Authorization:'Bearer '+token.access_token,'Content-Type':'application/json','x-marketplace':market},body:JSON.stringify({keywords:q,searchIndex:'Automotive',itemCount:10,partnerTag:env.AMAZON_PARTNER_TAG,marketplace:market,resources:['images.primary.medium','itemInfo.title','offersV2.listings.price']})});
  if(d.errors?.length||(!Array.isArray(d.searchResult?.items)&&d.searchResult?.totalResultCount!==0))throw Error('invalid upstream response');
  return (d.searchResult?.items||[]).map(x=>{const p=x.offersV2?.listings?.[0]?.price;return item('amazon',{id:x.asin,title:x.itemInfo?.title?.displayValue,url:x.detailPageURL,image:x.images?.primary?.medium?.url,price:p?.money?.amount??p?.amount,currency:p?.money?.currency||p?.currency})}).filter(Boolean);
}
async function shopee(env,q,fetcher){
  const payload=JSON.stringify({query:`query { productOfferV2(keyword: ${JSON.stringify(q)}, limit: 10, page: 1) { nodes { itemId productName priceMin imageUrl productLink offerLink shopName } } }`}),timestamp=String(Math.floor(Date.now()/1000));
  const signature=hex(await crypto.subtle.digest('SHA-256',enc.encode(env.SHOPEE_APP_ID+timestamp+payload+env.SHOPEE_APP_SECRET)));
  const d=await jsonFetch(fetcher,'https://open-api.affiliate.shopee.co.th/graphql',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`SHA256 Credential=${env.SHOPEE_APP_ID}, Timestamp=${timestamp}, Signature=${signature}`},body:payload});
  if(d.errors?.length||!Array.isArray(d.data?.productOfferV2?.nodes))throw Error('upstream rejected');return d.data.productOfferV2.nodes.map(x=>item('shopee',{id:x.itemId,title:x.productName,url:x.offerLink||x.productLink,image:x.imageUrl,price:x.priceMin,currency:'THB',seller:x.shopName})).filter(Boolean);
}
async function aliexpress(env,q,fetcher){
  const params={app_key:env.ALIEXPRESS_APP_KEY,format:'json',method:'aliexpress.affiliate.product.query',sign_method:'hmac-sha256',timestamp:new Date(Date.now()+8*3600000).toISOString().slice(0,19).replace('T',' '),v:'2.0',keywords:q,page_no:'1',page_size:'10',target_currency:'THB',target_language:'EN',ship_to_country:'TH',tracking_id:env.ALIEXPRESS_TRACKING_ID};
  const raw=Object.keys(params).sort().map(k=>k+params[k]).join(''),key=await crypto.subtle.importKey('raw',enc.encode(env.ALIEXPRESS_APP_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);params.sign=hex(await crypto.subtle.sign('HMAC',key,enc.encode(raw))).toUpperCase();
  const d=await jsonFetch(fetcher,'https://api.taobao.com/router/rest',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params).toString()});if(d.error_response)throw Error('upstream rejected');
  const result=d.aliexpress_affiliate_product_query_response?.resp_result;if(result?.resp_code!=null&&Number(result.resp_code)!==200)throw Error('upstream rejected');
  if(!result||(!Array.isArray(result.result?.products?.product)&&result.result?.current_record_count!==0))throw Error('invalid upstream response');
  return (result?.result?.products?.product||[]).map(x=>item('aliexpress',{id:x.product_id,title:x.product_title,url:x.promotion_link||x.product_detail_url,image:x.product_main_image_url,price:x.target_sale_price,currency:x.target_sale_price_currency,seller:x.shop_name})).filter(Boolean);
}
/* ร้านอะไหล่ใกล้ตำแหน่งผู้ใช้ที่ "น่าจะมี" สินค้านี้ — Google ค้นจากชื่อสินค้า + ประเภทร้านในแผนที่ ไม่ได้รู้สต็อกจริง
   พิกัดที่ผู้ใช้ยินยอมถูกปัดเหลือ ~100 ม. ก่อนส่งให้ Google และไม่เก็บไว้ที่เรา */
const STORE_TERM={th:'ร้านอะไหล่รถยนต์',en:'auto parts store'},STORE_WORDS=/ร้าน|อู่|ศูนย์|shop|store|parts|garage|dealer/i;
const MAPS_RADIUS=15000,MAPS_FETCH=20,MAPS_SHOW=12,coarse=n=>Math.round(n*1000)/1000;
export function distanceM(a,b){const r=x=>x*Math.PI/180,h=Math.sin(r(b.lat-a.lat)/2)**2+Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(r(b.lng-a.lng)/2)**2;return Math.round(12742000*Math.asin(Math.min(1,Math.sqrt(h))))}
const MAPS_MIN=5;
const PLACE_MASK='places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.attributions,places.primaryTypeDisplayName';
async function placesSearch(env,fetcher,textQuery,lang,here){
  const d=await jsonFetch(fetcher,'https://places.googleapis.com/v1/places:searchText',{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':env.GOOGLE_MAPS_API_KEY,'X-Goog-FieldMask':PLACE_MASK},body:JSON.stringify({textQuery,languageCode:lang,regionCode:'TH',pageSize:MAPS_FETCH,...(here?{rankPreference:'DISTANCE',locationBias:{circle:{center:{latitude:here.lat,longitude:here.lng},radius:MAPS_RADIUS}}}:{})})});
  if(d.error||('places' in d&&!Array.isArray(d.places)))throw Error('invalid upstream response');
  return (d.places||[]).slice(0,MAPS_FETCH).map(x=>{const lat=Number(x.location?.latitude),lng=Number(x.location?.longitude),ok=x.location?.latitude!=null&&x.location?.longitude!=null&&Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180;
    return {id:text(x.id,100),name:text(x.displayName?.text),address:text(x.formattedAddress,320),type:text(x.primaryTypeDisplayName?.text,80),url:productUrl(x.googleMapsUri,'maps'),lat:ok?lat:null,lng:ok?lng:null,distanceM:here&&ok?distanceM(here,{lat,lng}):null,attributions:(x.attributions||[]).map(a=>({name:text(a.provider),uri:productUrl(a.providerUri,'maps')}))}}).filter(x=>x.url);
}
const byDistance=(a,b)=>(a.distanceM??Infinity)-(b.distanceM??Infinity);
/* ขั้น 1: ร้านที่ค้นเจอด้วยชื่อสินค้า (น่าจะมีสินค้านี้) · ผลน้อยกว่า MAPS_MIN และรู้ตำแหน่งผู้ใช้ → ขั้น 2: ร้านอะไหล่ทั่วไปใกล้ ๆ
   ติดป้าย broad ให้หน้าเว็บบอกผู้ใช้ว่าไม่ได้ตรงกับชื่อสินค้า ไม่แกล้งว่าเป็นผลตรง */
async function maps(env,input,fetcher){
  const here=input.location?{lat:coarse(input.location.lat),lng:coarse(input.location.lng)}:null;
  const textQuery=STORE_WORDS.test(input.query)?input.query:input.query+' '+STORE_TERM[input.lang];
  const exact=await placesSearch(env,fetcher,textQuery,input.lang,here);
  if(here){for(let i=exact.length-1;i>=0;i--)if(exact[i].distanceM==null||exact[i].distanceM>MAPS_RADIUS)exact.splice(i,1);exact.sort(byDistance);}
  let out=exact.slice(0,MAPS_SHOW).map(x=>({...x,broad:false}));
  if(here&&out.length<MAPS_MIN){
    try{const seen=new Set(out.map(x=>x.id)),more=(await placesSearch(env,fetcher,STORE_TERM[input.lang],input.lang,here)).filter(x=>!seen.has(x.id)&&x.distanceM!=null&&x.distanceM<=MAPS_RADIUS).sort(byDistance);
      out=[...out,...more.slice(0,MAPS_SHOW-out.length).map(x=>({...x,broad:true}))]}
    catch(e){console.error('shop maps broad search failed',String(e&&e.message||e).slice(0,300))}
  }
  console.log('shop maps results',JSON.stringify({exact:exact.length,total:out.length,located:!!here}));
  return out;
}
const adapters={shopee,amazon,aliexpress,ebay};
export async function searchShop(env,body,{fetcher=fetch}={}){
  const input=shopInput(body),providers=await Promise.all(input.providers.map(async id=>{
    if(!ready(env,id))return {id,name:NAMES[id],state:'setup_required',items:[]};
    try{return {id,name:NAMES[id],state:'ready',...(id==='maps'?{places:await maps(env,input,fetcher)}:{items:await adapters[id](env,input.query,fetcher)})}}
    catch(e){console.error('shop provider failed',id,String(e&&e.message||e).slice(0,400));return {id,name:NAMES[id],state:'unavailable',items:[]}}
  }));return {query:input.query,providers,items:providers.flatMap(p=>p.items||[]),places:providers.flatMap(p=>p.places||[]),observedAt:Date.now(),fitmentRequiresVerification:true};
}
const schemas=new WeakMap();
export async function shopRateLimit(env,uid,providers){
  if(!schemas.has(env.DB)){const p=env.DB.prepare('CREATE TABLE IF NOT EXISTS shop_search_rate(uid TEXT NOT NULL,slot INTEGER NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(uid,slot))').run();schemas.set(env.DB,p);p.catch(()=>schemas.delete(env.DB))}await schemas.get(env.DB);
  const slot=Math.floor(Date.now()/60000),n=providers.includes('maps')?3:1;
  const r=await env.DB.prepare('INSERT INTO shop_search_rate(uid,slot,n) VALUES(?,?,?) ON CONFLICT(uid,slot) DO UPDATE SET n=shop_search_rate.n+excluded.n WHERE shop_search_rate.n+excluded.n<=15 RETURNING n').bind(uid,slot,n).first();
  if(!r)throw Object.assign(Error('Please wait before searching again'),{status:429});
  await env.DB.prepare('DELETE FROM shop_search_rate WHERE slot<?').bind(slot-60).run();
}
