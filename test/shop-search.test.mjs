import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {shopStatus,shopInput,productUrl,searchShop,shopRateLimit,distanceM} from '../src/shop-search.mjs';
const env={SHOPEE_APP_ID:'fixture-id',SHOPEE_APP_SECRET:'fixture-shopee',AMAZON_CREATOR_ID:'fixture-amazon-id',AMAZON_CREATOR_SECRET:'fixture-amazon',AMAZON_PARTNER_TAG:'fixture-tag',ALIEXPRESS_APP_KEY:'fixture-ali-id',ALIEXPRESS_APP_SECRET:'fixture-ali',ALIEXPRESS_TRACKING_ID:'fixture-track',EBAY_CLIENT_ID:'fixture-ebay-id',EBAY_CLIENT_SECRET:'fixture-ebay',GOOGLE_MAPS_API_KEY:'fixture-maps',SHOP_GOOGLE_MAPS_ENABLED:'1'};
const json=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
const body=providers=>({query:'brake pads',providers});
test('unconfigured APIs do not call providers or invent listings; Maps requires explicit enablement',async()=>{
  let calls=0;const r=await searchShop({},body(['shopee','amazon','aliexpress','ebay','maps']),{fetcher:()=>{calls++;throw Error()}});
  assert.equal(calls,0);assert.equal(r.items.length,0);assert.ok(r.providers.every(p=>p.state==='setup_required'));
  assert.equal(shopStatus({GOOGLE_MAPS_API_KEY:'set'}).providers.find(p=>p.id==='maps').state,'setup_required');
  assert.ok(!JSON.stringify(shopStatus(env)).includes('fixture-'));
});
test('query validation blocks private identifiers and location is opt-in',()=>{
  for(const query of ['a','x'.repeat(181),'mail@example.test','1234567890123','JH4KA8260MC000000','pads\nprivate'])assert.throws(()=>shopInput({query}));
  assert.equal(shopInput({...body(['maps']),lat:13,lng:100}).location,null);
  assert.deepEqual(shopInput({...body(['maps']),lat:13,lng:100,locationConsent:true}).location,{lat:13,lng:100});
  assert.equal(shopInput({...body(['maps']),lat:999,lng:100,locationConsent:true}).location,null);
  assert.throws(()=>shopInput(body(['unknown'])));
});
test('product destinations reject lookalikes, credentials, ports, HTTP and script URLs',()=>{
  for(const u of ['javascript:alert(1)','http://ebay.com/item','https://ebay.com.evil.test/x','https://ebay.com@evil.test','https://u:p@ebay.com/x','https://ebay.com:444/x'])assert.equal(productUrl(u,'ebay'),null,u);
  assert.equal(productUrl('https://www.ebay.com/itm/1','ebay'),'https://www.ebay.com/itm/1');
});
test('eBay uses OAuth headers and returns real price/currency without claiming fit',async()=>{
  const calls=[];const r=await searchShop(env,body(['ebay']),{fetcher:async(u,o)=>{calls.push({u,o});return calls.length===1?json({access_token:'fixture-access'}):json({itemSummaries:[{itemId:'1',title:'Brake pads',itemWebUrl:'https://www.ebay.com/itm/1',price:{value:'23.5',currency:'USD'}},{itemId:'2',title:'Bad',itemWebUrl:'https://evil.test',price:{value:1,currency:'USD'}}]})}});
  assert.equal(calls.length,2);assert.equal(calls[0].o.redirect,'manual');assert.match(calls[0].o.headers.Authorization,/^Basic /);assert.equal(calls[1].o.headers.Authorization,'Bearer fixture-access');
  assert.equal(r.items.length,1);assert.equal(r.items[0].price,23.5);assert.equal(r.items[0].currency,'USD');assert.equal(r.items[0].fitConfirmed,false);
  assert.ok(calls.every(c=>!c.u.includes('fixture-')));
});
test('Amazon uses Creators API and offersV2, not deprecated PA API',async()=>{
  const calls=[];const r=await searchShop(env,body(['amazon']),{fetcher:async(u,o)=>{calls.push({u,o});return calls.length===1?json({access_token:'fixture-access'}):json({searchResult:{items:[{asin:'B123',itemInfo:{title:{displayValue:'Filter'}},detailPageURL:'https://www.amazon.com/dp/B123',offersV2:{listings:[{price:{money:{amount:18.95,currency:'USD'}}}]}}]}})}});
  assert.equal(r.items[0].price,18.95);assert.equal(calls[1].u,'https://creatorsapi.amazon/catalog/v1/searchItems');assert.equal(JSON.parse(calls[1].o.body).partnerTag,'fixture-tag');
  assert.equal(calls[1].o.headers.Authorization,'Bearer fixture-access');assert.ok(calls.every(c=>!c.u.includes('fixture-')));
});
test('Shopee signs the exact GraphQL request and rejects API-level errors',async()=>{
  let options;const r=await searchShop(env,body(['shopee']),{fetcher:async(u,o)=>{options=o;assert.equal(u,'https://open-api.affiliate.shopee.co.th/graphql');return json({data:{productOfferV2:{nodes:[{itemId:1,productName:'Filter',priceMin:90,productLink:'https://shopee.co.th/product/1/2'}]}}})}});
  assert.match(options.headers.Authorization,/^SHA256 Credential=fixture-id, Timestamp=\d+, Signature=[a-f0-9]{64}$/);assert.equal(r.items[0].currency,'THB');
  const bad=await searchShop(env,body(['shopee']),{fetcher:async()=>json({errors:[{message:'secret detail'}]})});assert.equal(bad.providers[0].state,'unavailable');assert.ok(!JSON.stringify(bad).includes('secret detail'));
});
test('AliExpress signs a POST form with no app key in URL',async()=>{
  let sent;const r=await searchShop(env,body(['aliexpress']),{fetcher:async(u,o)=>{assert.equal(u,'https://api.taobao.com/router/rest');sent=new URLSearchParams(o.body);return json({aliexpress_affiliate_product_query_response:{resp_result:{resp_code:200,result:{products:{product:[{product_id:1,product_title:'Filter',target_sale_price:'99',target_sale_price_currency:'THB',product_detail_url:'https://www.aliexpress.com/item/1.html'}]}}}}})}});
  assert.equal(sent.get('method'),'aliexpress.affiliate.product.query');assert.match(sent.get('sign'),/^[A-F0-9]{64}$/);assert.equal(r.items[0].price,99);
});
test('Google Places sends key in header, minimal fields, and only consented coordinates',async()=>{
  for(const consent of [false,true]){let sent;const r=await searchShop(env,{...body(['maps']),lat:13,lng:100,locationConsent:consent},{fetcher:async(u,o)=>{sent=o;return json({places:[{id:'p1',displayName:{text:'Parts shop'},googleMapsUri:'https://maps.google.com/?cid=1',formattedAddress:'Area'}]})}});
    assert.equal(sent.headers['X-Goog-Api-Key'],'fixture-maps');assert.equal(!!JSON.parse(sent.body).locationBias,consent);assert.ok(!sent.headers['X-Goog-FieldMask'].includes('reviews'));assert.equal(r.places.length,1);
  }
});
test('malformed/failed/redirected upstream responses remain unavailable, not empty-success',async()=>{
  for(const id of ['shopee','amazon','aliexpress','ebay'])for(const status of [200,302,500]){let n=0;const r=await searchShop(env,body([id]),{fetcher:async()=>{n++;if(['amazon','ebay'].includes(id)&&n===1)return json({access_token:'fixture'});return new Response('{}',{status})}});assert.equal(r.providers[0].state,'unavailable',id+':'+status);assert.deepEqual(r.items,[])}
});
test('rate limit is account-scoped and bounded atomically',async()=>{
  const db=new DatabaseSync(':memory:'),DB={prepare(sql){let args=[];return {bind(...a){args=a;return this},async first(){return db.prepare(sql).get(...args)||null},async run(){return db.prepare(sql).run(...args)}}}},e={DB};
  for(let i=0;i<5;i++)await shopRateLimit(e,'one',['maps']);await assert.rejects(shopRateLimit(e,'one',['maps']),{status:429});await shopRateLimit(e,'two',['maps']);db.close();
});

test('nearby shops: store term added, coordinates coarsened, nearest first with distance, bad coordinates tolerated',async()=>{
  const place=(id,lat,lng)=>({id,displayName:{text:'Shop '+id},googleMapsUri:'https://maps.google.com/?cid='+id,formattedAddress:'Area',location:lat==null?undefined:{latitude:lat,longitude:lng},primaryTypeDisplayName:{text:'ร้านอะไหล่รถยนต์'}});
  let sent;const f=async(u,o)=>{sent=JSON.parse(o.body);return json({places:[place('far',13.80,100.60),place('none'),place('near',13.7461,100.5352)]})};
  const r=await searchShop(env,{...body(['maps']),query:'ผ้าเบรก Toyota',lat:13.74567,lng:100.53491,locationConsent:true},{fetcher:f});
  assert.equal(sent.textQuery,'ผ้าเบรก Toyota ร้านอะไหล่รถยนต์');assert.equal(sent.regionCode,'TH');
  assert.deepEqual(sent.locationBias.circle.center,{latitude:13.746,longitude:100.535},'~100 m precision only');
  assert.deepEqual(r.places.map(x=>x.id),['near','far','none'],'nearest first, unknown distance last');
  assert.ok(r.places[0].distanceM<200&&r.places[1].distanceM>5000);assert.equal(r.places[2].distanceM,null);assert.equal(r.places[2].lat,null);assert.equal(r.places[0].type,'ร้านอะไหล่รถยนต์');
  await searchShop(env,{...body(['maps']),query:'auto parts shop near Siam',lang:'en',lat:13,lng:100,locationConsent:true},{fetcher:f});assert.equal(sent.textQuery,'auto parts shop near Siam','already names a store: not doubled');
  await searchShop(env,{...body(['maps']),query:'brake pads',lang:'en'},{fetcher:f});assert.equal(sent.textQuery,'brake pads auto parts store');assert.equal(sent.locationBias,undefined,'no consent → no location');
  const r2=await searchShop(env,{...body(['maps']),query:'ผ้าเบรก'},{fetcher:f});assert.ok(r2.places.every(x=>x.distanceM===null),'no distance without a location');
  assert.equal(distanceM({lat:13.75,lng:100.5},{lat:13.75,lng:100.5}),0);
});
test('provider failure is logged for the owner with HTTP status and reason, but the client only sees "unavailable"',async()=>{
  const logged=[],orig=console.error;console.error=(...a)=>logged.push(a.join(' '));
  try{const r=await searchShop(env,{...body(['maps']),query:'brake pads'},{fetcher:async()=>new Response(JSON.stringify({error:{status:'PERMISSION_DENIED',message:'Places API (New) has not been used in project 1 before.'}}),{status:403})});
    assert.equal(r.providers[0].state,'unavailable');assert.ok(!JSON.stringify(r).includes('PERMISSION_DENIED'));}
  finally{console.error=orig}
  assert.ok(logged.some(l=>/shop provider failed maps .*HTTP 403.*PERMISSION_DENIED/.test(l)));assert.ok(!logged.join(' ').includes('fixture-maps'),'the key is never logged');
});
