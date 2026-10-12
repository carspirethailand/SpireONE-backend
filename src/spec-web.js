/* Free, document-backed discovery. No search-service key, Bing RSS, Google
 * grounding tool, browser cookies or VIN is used. Only pages actually read
 * can become sources. Robots restrictions and access barriers are respected. */
const WIKI='https://en.wikipedia.org/w/api.php';
const UA='CendonSpecs/1.0 (+https://cendon-beta.pages.dev/)';
const OEM=['mitsubishi-motors.com','mitsubishi-motors.co.th','mitsubishi-motors.co.jp','toyota.com','toyota.co.th','global.toyota','honda.com','honda.co.th','isuzu.co.th','nissan.com','nissan.co.th','mazda.com','mazda.co.th','ford.com','ford.co.th','bmw.com','bmw.co.th','mercedes-benz.com','mercedes-benz.co.th','hyundai.com','kia.com','suzuki.co.th','mgcars.com','byd.com','gwm-global.com','subaru.com','lexus.com','volvocars.com','porsche.com','astonmartin.com','tesla.com','ferrari.com','lamborghini.com'];
const PRESS=['headlightmag.com','autospinn.com','grandprix.co.th','autodeft.com','motortrivia.com','autostation.com','car250.com','caranddriver.com','edmunds.com','motortrend.com','autocar.co.uk','autoexpress.co.uk','topgear.com','carsguide.com.au','carexpert.com.au','paultan.org','roadandtrack.com','thedrive.com','carfolio.com','ultimatespecs.com'];
const HOSTS=[...OEM,...PRESS,'en.wikipedia.org'];
const robotCache=new Map();
const SEARCH_SITES=['https://www.headlightmag.com','https://www.autodeft.com','https://www.motortrivia.com'];
export function active(signal){if(signal?.aborted)throw Object.assign(new Error('ค้นนานเกินกำหนด'),{name:'AbortError'})}
/* The race also bounds stalled response bodies and fetch mocks that ignore
 * abort. All nested requests inherit cancellation; no fallback survives it. */
export async function timebox(task,ms,signal){
  active(signal);const ac=new AbortController();let timer,onAbort;
  const stopped=new Promise((_,reject)=>{onAbort=()=>{ac.abort();reject(Object.assign(new Error('ค้นนานเกินกำหนด'),{name:'AbortError'}))};timer=setTimeout(onAbort,ms);signal?.addEventListener('abort',onAbort,{once:true})});
  try{return await Promise.race([stopped,task(ac.signal)])}finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort()}
}
const normal=s=>String(s||'').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
const under=(host,list)=>list.some(d=>host===d||host.endsWith('.'+d));
export function allowedSource(raw){try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&under(u.hostname.toLowerCase(),HOSTS)}catch{return false}}
export function textOf(html){return String(html||'').replace(/<!--[^]*?-->/g,' ').replace(/<(script|style|noscript|svg|nav|footer|header|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
  .replace(/<\/(?:p|tr|li|h[1-6]|div|section|table)>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(Math.min(parseInt(n,16),0x10ffff)))
  .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(Number(n),0x10ffff))).replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n').trim();}
export function wikiPlain(raw){
  const s=String(raw||'').replace(/<ref\b[^>]*>[\s\S]*?<\/ref>|<ref\b[^>]*\/>/gi,' ')
    .replace(/\{\{convert\|([\d,.]+)\|([a-zA-Z³²]+)(?:\|[^{}]*)?\}\}/g,'$1 $2')
    .replace(/\{\{val\|([\d,.]+)\|u=([^|{}]+)(?:\|[^{}]*)?\}\}/g,'$1 $2')
    .replace(/\[\[([^\]\n]+)\]\]/g,(_,link)=>link.split('|').pop())
    .replace(/'{2,5}/g,'');
  return textOf(s);
}
export function robotsAllow(text,path){
  let agents=[],rules=[],signals='',groups=[];
  for(const line of String(text||'').split(/\r?\n/)){const m=line.replace(/#.*$/,'').match(/^\s*(user-agent|allow|disallow|content-signal)\s*:\s*(.*?)\s*$/i);if(!m)continue;const k=m[1].toLowerCase();
    if(k==='user-agent'){if(rules.length||signals){groups.push({agents,rules,signals});agents=[];rules=[];signals=''}agents.push(m[2].toLowerCase())}else if(k==='content-signal'){signals+=' '+m[2]}else if(agents.length&&m[2])rules.push({allow:k==='allow',path:m[2]});
  }groups.push({agents,rules,signals});
  // Also respect the publisher's Google-Extended restriction: free Gemini API
  // content may be used for model improvement, so do not circumvent that rule.
  const specific=groups.filter(g=>g.agents.some(a=>a!=='*'&&a!=='google-extended'&&UA.toLowerCase().includes(a)));
  const selected=specific.length?specific:groups.filter(g=>g.agents.includes('*'));
  const permitted=gs=>{if(gs.some(g=>/ai-(?:input|train)\s*=\s*no/i.test(g.signals)))return false;let best=null;for(const g of gs)for(const r of g.rules){const escaped=r.path.replace(/[.+?^{}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*');if(new RegExp('^'+escaped).test(path)&&(!best||r.path.length>best.path.length||r.path.length===best.path.length&&r.allow))best=r}return !best||best.allow};
  // Google-Extended restrictions are an additional gate, not rules that a
  // longer wildcard Allow can override.
  return permitted(selected)&&permitted(groups.filter(g=>g.agents.includes('google-extended')));
}
async function boundedText(response,max=350000){
  if(!response.body?.getReader){const t=await response.text();if(t.length>max)throw Error('document_too_large');return t}
  const reader=response.body.getReader(),decoder=new TextDecoder();let n=0,out='';
  try{for(;;){const x=await reader.read();if(x.done)break;n+=x.value.length;if(n>max){await reader.cancel();throw Error('document_too_large')}out+=decoder.decode(x.value,{stream:true})}return out+decoder.decode()}finally{reader.releaseLock()}
}
async function request(url,ms=6500,signal){return timebox(async own=>{const r=await fetch(url,{headers:{'User-Agent':UA,Accept:'text/html,application/json;q=.9,text/plain;q=.8'},redirect:'manual',signal:own});return {r,text:await boundedText(r)}},ms,signal)}
async function wiki(params,signal,ms=7000){const {r,text}=await request(WIKI+'?'+new URLSearchParams({format:'json',...params}),Math.max(1,Math.min(7000,ms)),signal);if(!r.ok)throw Error('source_unavailable: discovery_http_'+r.status);return JSON.parse(text)}
async function mayRead(url,signal){const u=new URL(url),cached=robotCache.get(u.origin);let rules=cached?.until>Date.now()?cached.rules:null;
  if(rules==null){try{const {r,text}=await request(u.origin+'/robots.txt',3500,signal);if(r.status===404)rules='';else if(r.ok)rules=text;else return false;robotCache.set(u.origin,{rules,until:Date.now()+600000});if(robotCache.size>60)robotCache.delete(robotCache.keys().next().value)}catch(e){active(signal);return false}}
  return robotsAllow(rules,u.pathname+u.search);
}
async function publisherLinks(q,log,signal){
  const results=await Promise.all(SEARCH_SITES.map(async origin=>{try{
    const url=origin+'/wp-json/wp/v2/posts?'+new URLSearchParams({search:q.model+' '+q.year,per_page:'15',orderby:'relevance',_fields:'link,title,date',after:(Number(q.year)-1)+'-01-01T00:00:00',before:(Number(q.year)+1)+'-01-01T00:00:00'});
    if(!await mayRead(url,signal))return [];
    const {r,text}=await request(url,4000,signal);if(!r.ok)return [];
    const rows=JSON.parse(text);if(!Array.isArray(rows))return [];
    return rows.filter(x=>allowedSource(x.link)&&normal(textOf(x.title?.rendered)).includes(normal(q.model))).map(x=>({url:x.link,title:textOf(x.title?.rendered),published:x.date}));
  }catch(e){active(signal);return []}}));
  const links=results.flat();log.push({step:'publisher-discovery',ok:!!links.length,links:links.length});return links;
}
function relevant(text,q){const n=normal(text);return n.includes(normal(q.make))&&n.includes(normal(q.model))}
export function documentRank(url,q,meta={}){
  const u=new URL(url),title=textOf(meta.title||''),context=u.pathname+' '+title;
  let score=(under(u.hostname,OEM)?20:0)+(normal(context).includes(normal(q.model))?10:0)+(context.includes(q.year)?15:0);
  if(String(meta.published||'').startsWith(q.year+'-'))score+=10;
  if(/official[- ]price|technical[- ]data|specification|full[- ]review|thai[- ]spec|ราคาอย่างเป็นทางการ|ข้อมูลทั้งหมด|สเปค|สเปก|ทดลองขับ/i.test(context))score+=35;
  if(/spy[- ]?shot|teaser|rumo[u]?r|rendering|one[- ]off|anniversary|ข่าวลือ|ภาพหลุด|คาดว่า/i.test(context))score-=60;
  return score;
}
export function excerpt(text,q){
  // An archive URL containing ...2020... is not model-year evidence. Prefer
  // the applicable generation's production block, otherwise an exact year.
  const production=[...text.matchAll(/\b(?:production|model_years)\s*=\s*[^\n]{1,180}/gi)].filter(m=>coversYear(m[0],q.year)).sort((a,b)=>Number((b[0].match(/(?:19|20)\d{2}/)||[])[0]||0)-Number((a[0].match(/(?:19|20)\d{2}/)||[])[0]||0))[0];
  const exact=text.match(new RegExp('(?<!\\d)'+String(q.year)+'(?!\\d)'));
  const at=production?.index??exact?.index??-1,start=Math.max(0,at<0?0:at-(production?350:1800));
  return text.slice(start,start+9000);
}
async function readPage(raw,q,log,signal){
  if(!allowedSource(raw)||/\.pdf(?:\?|$)/i.test(raw))return null;
  let url=raw;try{for(let hop=0;hop<3;hop++){
    active(signal);if(!allowedSource(url)||!await mayRead(url,signal))return null;
    const {r,text}=await request(url,6500,signal);if([301,302,303,307,308].includes(r.status)){url=new URL(r.headers.get('location')||'',url).href;continue}
    if(!r.ok||!/(?:text\/html|text\/plain|application\/xhtml)/i.test(r.headers.get('content-type')||'text/html'))return null;
    const title=textOf((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||new URL(url).hostname),plain=textOf(text);
    if(/captcha|verify you are human|access denied|enable javascript.*cookies|checking your browser/i.test(plain.slice(0,1200))||plain.length<250||!relevant(plain,q))return null;
    if(!normal(title+' '+new URL(url).pathname).includes(normal(q.model)))return null;
    const titleYears=title.match(/\b(?:19|20)\d{2}\b/g)||[];
    if(titleYears.length&&!titleYears.includes(String(q.year)))return null;
    log.push({step:'document',ok:true,url,title,chars:plain.length});return {url,title,text:excerpt(plain,q),primary:under(new URL(url).hostname,OEM)};
  }}catch(e){active(signal);log.push({step:'document',ok:false,url,err:String(e.message).slice(0,90)})}return null;
}
export async function collectSpecDocuments(q,log=[],signal){
  const deadline=Date.now()+12000;
  // Public publisher search APIs are read-only. These provide local-market
  // articles beyond Wikipedia's reference list; no search-service key needed.
  const localLinks=publisherLinks(q,log,signal);
  // Observe rejection even if required discovery exits before using links.
  localLinks.catch(()=>{});
  const found=await wiki({action:'query',list:'search',srsearch:q.make+' '+q.model,srlimit:'3'},signal,deadline-Date.now());
  const rows=found.query?.search||[],exact=rows.find(x=>normal(x.title)===normal(q.make+' '+q.model)),chosen=exact||rows.find(x=>relevant(textOf(x.title+' '+x.snippet),q));
  if(!chosen?.pageid)throw Error('ไม่พบเอกสารอ้างอิงของรุ่นนี้จากแหล่งค้นข้อมูลเปิด');
  // Wikitext avoids downloading hundreds of KB of generated table/layout HTML
  // and retains the specification table. It is still untrusted document data.
  const page=await wiki({action:'parse',pageid:String(chosen.pageid),prop:'wikitext|externallinks'},signal,deadline-Date.now()),rawWiki=page.parse?.wikitext?.['*'],plain=rawWiki?wikiPlain(rawWiki):textOf(page.parse?.text?.['*']||'');
  let published=[];try{published=await localLinks}catch(e){active(signal)}
  const candidates=[...published.map(x=>x.url),...(page.parse?.externallinks||[])].filter(allowedSource).filter(u=>!/^https:\/\/en\.wikipedia/.test(u));
  const metadata=new Map(published.map(x=>[x.url,x]));
  candidates.sort((a,b)=>documentRank(b,q,metadata.get(b))-documentRank(a,q,metadata.get(a)));
  const hostCounts=new Map(),unique=new Set(),urls=[];for(const u of candidates){const host=new URL(u).hostname.replace(/^www\./,'');if(unique.has(u)||(hostCounts.get(host)||0)>=2||/\.pdf(?:\?|$)/i.test(u))continue;unique.add(u);hostCounts.set(host,(hostCounts.get(host)||0)+1);urls.push(u);if(urls.length===10)break}
  const docs=[];if(relevant(plain,q)&&plain.length>250){docs.push({url:'https://en.wikipedia.org/wiki/'+encodeURIComponent(chosen.title.replace(/ /g,'_')),title:chosen.title,text:excerpt(plain,q),primary:false,license:'CC BY-SA'});log.push({step:'document',ok:true,url:docs[0].url,title:chosen.title,chars:plain.length})}
  // Four simultaneous requests at most; no payment keys and no access-barrier
  // workarounds. Five distinct readable sites are the target, not fabricated.
  for(let i=0;i<urls.length&&docs.length<6&&Date.now()<deadline;i+=4){active(signal);
    try{await timebox(own=>Promise.all(urls.slice(i,i+4).map(async u=>{const d=await readPage(u,q,log,own);active(own);if(d&&docs.length<6)docs.push(d)})),Math.min(7000,deadline-Date.now()),signal)}
    catch(e){active(signal);log.push({step:'documents-partial',ok:false,err:'บางเอกสารอ่านไม่ทัน ใช้เฉพาะเอกสารที่อ่านเสร็จแล้ว'})}
  }
  if(!docs.length)throw Error('ไม่พบหน้าเอกสารที่เปิดอ่านและใช้อ้างอิงได้');return docs.map((d,id)=>({...d,id}));
}
const WORDS={seats:['seats','seating','passenger','ที่นั่ง'],doors:['doors','ประตู'],length_mm:['length','ยาว'],width_mm:['width','กว้าง'],height_mm:['height','สูง'],wheelbase_mm:['wheelbase','ฐานล้อ'],kerb_kg:['weight','kerb','curb','น้ำหนัก'],tank_l:['tank','fuel capacity','ถัง'],cc:['cc','displacement','cubic','ความจุ','ซีซี'],hp:['hp','bhp','horsepower','แรงม้า'],torque_nm:['torque','nm','แรงบิด'],l_per_100km:['l/100','litres per 100','ลิตร/100'],battery_kwh:['kwh','battery','แบตเตอรี่'],range_km:['range','driving distance','ระยะทาง']};
const ENUM={coupe:['coupe','coupé','sports car','คูเป้','รถสปอร์ต'],sedan:['sedan','saloon','ซีดาน'],suv:['suv','sport utility','เอสยูวี'],hatchback:['hatchback','แฮทช์แบ็ก'],pickup:['pickup','pick-up','กระบะ'],mpv:['mpv','minivan','เอ็มพีวี'],van:['van','รถตู้'],ev:['electric','battery electric','ไฟฟ้า'],petrol:['petrol','gasoline','เบนซิน'],diesel:['diesel','ดีเซล'],hybrid:['hybrid','ไฮบริด'],phev:['plug-in','phev','ปลั๊กอิน'],lpg:['lpg','แก๊ส'],FWD:['fwd','front-wheel','front wheel','ขับหน้า'],RWD:['rwd','rear-wheel','rear wheel','ขับหลัง'],AWD:['awd','all-wheel','all wheel','ขับสี่'], '4WD':['4wd','four-wheel','4x4','ขับสี่']};
const squash=s=>String(s||'').normalize('NFC').replace(/[–—−]/g,'-').replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/\s+/g,' ').trim().toLowerCase();
const COUNTRY={TH:['thailand','thai market','ประเทศไทย','ตลาดไทย'],JP:['japan','japanese market','ญี่ปุ่น'],US:['united states','u.s. market','us market','สหรัฐ'],UK:['united kingdom','uk market','british market','สหราชอาณาจักร'],DE:['germany','german market','เยอรมนี'],AU:['australia','australian market','ออสเตรเลีย'],EU:['europe','european market','ยุโรป']};
function coversYear(quote,year){
  const s=squash(quote),y=Number(year);
  for(const m of s.matchAll(/\b((?:19|20)\d{2})\s*(?:[-–—]|to|ถึง)\s*((?:19|20)\d{2}|present|ปัจจุบัน)\b/g))if(y>=Number(m[1])&&y<=(/present|ปัจจุบัน/.test(m[2])?new Date().getUTCFullYear():Number(m[2])))return true;
  return new RegExp('\\b'+y+'\\b').test(s);
}
function supports(k,value,quote){const s=squash(quote);if(value==null)return false;
  if(k==='hp'&&/\b(?:ps|kw)\b/.test(s)&&!/\b(?:hp|bhp|horsepower)\b/.test(s))return false;
  const contains=w=>/^[a-z0-9 ]+$/i.test(w)?new RegExp('\\b'+w+'\\b','i').test(s):s.includes(w);
  if(ENUM[value])return ENUM[value].some(contains);
  if(typeof value==='number'){const n=String(value),flat=s.replace(/,(?=\d{3}\b)/g,'');let at=-1;while((at=flat.indexOf(n,at+1))>=0){const end=at+n.length;if(/\d/.test(flat[at-1]||'')||/\d/.test(flat[end]||'')||flat[at-1]==='.'&&/\d/.test(flat[at-2]||'')||flat[end]==='.'&&/\d/.test(flat[end+1]||''))continue;const near=flat.slice(Math.max(0,at-25),end+25);if((WORDS[k]||[]).some(w=>/^[a-z]+$/.test(w)?new RegExp('\\b'+w+'\\b').test(near):near.includes(w)))return true}return false}
  return s.includes(squash(value));
}
/* Quotes are validated in RAM and discarded. Public evidence keeps source
 * links only, not reproductions of article paragraphs or user information. */
export function cleanDocumentExtraction(raw,docs,q){
  if(!raw||typeof raw!=='object'||raw.found!==true)throw Error('เอกสารยังไม่ยืนยันข้อมูลของปี/รุ่นนี้');
  const inputProof=raw.evidence&&typeof raw.evidence==='object'?raw.evidence:{},proof=Object.create(null);
  const idOf=s=>{if(typeof s==='number')return Number.isInteger(s)&&s>=0?s:NaN;const m=String(s??'').match(/^(?:doc(?:ument)?[-_ ]?)?(\d+)$/i);return m?Number(m[1]):NaN};
  const addProof=(path,value,depth=0)=>{if(depth>8||!value||typeof value!=='object')return;
    if((value.source!==undefined||value.source_id!==undefined)&&typeof(value.quote??value.text)==='string'){
      const p=String(value.path||value.field||path||'').replace(/\[(\d+)\]/g,'.$1');if(p)proof[p]=[...(proof[p]||[]),{source:idOf(value.source??value.source_id),quote:value.quote??value.text}];return;
    }
    if(Array.isArray(value)){value.forEach((v,i)=>addProof(v?.path||v?.field||((v?.source!==undefined||v?.source_id!==undefined)?path:path+'.'+i),v,depth+1));return}
    for(const [k,v] of Object.entries(value))addProof(path?path+'.'+k:k,v,depth+1);
  };addProof('',inputProof);
  const evidence=Object.create(null),positions=Object.create(null),scopesInput=Array.isArray(raw.scope)?raw.scope:raw.scope&&typeof raw.scope==='object'?[raw.scope]:[],diagnostic={scopeReceived:scopesInput.length,scopedDocuments:0,proofPaths:Object.keys(proof).length,acceptedFields:0,rejected:{},nestedFacts:!!raw.facts};
  const texts=new Map(docs.map(d=>[d.id,squash(d.text)])),scopes=new Map();
  const quoteAt=(id,s)=>typeof s==='string'&&s.length>=4&&s.length<=260?(texts.get(id)||'').indexOf(squash(s)):-1;
  for(const s of scopesInput){const id=idOf(s.source??s.source_id),d=docs.find(x=>x.id===id),at=quoteAt(id,s.year_quote);if(!d||at<0||!coversYear(s.year_quote,q?.year))continue;
    const market=q?.market||'GLOBAL',country=COUNTRY[market]||[],host=new URL(d.url).hostname;
    const directTH=market==='TH'&&/\.co\.th$/.test(host);
    if(market!=='GLOBAL'&&!directTH&&!(quoteAt(id,s.market_quote)>=0&&country.some(x=>squash(s.market_quote).includes(x))&&!/\b(?:assembly|assembled|manufactur|export)\w*|ผลิต|ประกอบ/i.test(s.market_quote)))continue;
    const points=scopes.get(id)||[];points.push(at);scopes.set(id,points);
  }
  diagnostic.scopedDocuments=scopes.size;
  const reject=reason=>{diagnostic.rejected[reason]=(diagnostic.rejected[reason]||0)+1;return false};
  function value(path,k,v,anchors){if(v&&typeof v==='object'&&!Array.isArray(v))v=v.value??v.v;
    if(WORDS[k]&&typeof v==='string'){const n=v.replace(/,/g,'');v=/^\d+(?:\.\d+)?$/.test(n)?Number(n):null}
    if(WORDS[k]&&typeof v!=='number')v=null;
    const aliases=[...new Set(path.startsWith('facts.')?[path,path.slice(6),'facts.'+k]:[path,path.replace(/\.(\d+)\./,'[$1].')])];const entries=aliases.flatMap(p=>proof[p]||[]);const good=entries.filter(e=>{const id=Number(e.source),at=quoteAt(id,e.quote),d=docs.find(x=>x.id===id);if(!d||at<0)return reject('quote_missing');if(!scopes.has(id))return reject('scope_missing');if(!supports(k,v,e.quote))return reject('value_not_supported');
      const identifiedYear=(d.title+' '+new URL(d.url).pathname).match(/(?<!\d)(?:19|20)\d{2}(?!\d)/g)||[];
      const inYear=identifiedYear.includes(String(q.year))||scopes.get(id).some(p=>Math.abs(p-at)<=1200);
      if(!inYear)return reject('outside_year_context');return !anchors||anchors.some(a=>a.id===id&&Math.abs(a.at-at)<=900)||reject('outside_variant_context');});
    if(!good.length)return null;diagnostic.acceptedFields++;evidence[path]=[...new Set(good.map(e=>Number(e.source)))];positions[path]=good.map(e=>({id:Number(e.source),at:quoteAt(Number(e.source),e.quote)}));return v;
  }
  const out={found:true,variants:[],evidence};
  for(const k of ['body','generation','market','seats','doors','length_mm','width_mm','height_mm','wheelbase_mm','kerb_kg','tank_l','tire'])out[k]=value('facts.'+k,k,raw[k]??raw.facts?.[k]);
  for(const [i,v] of (Array.isArray(raw.variants)?raw.variants:[]).slice(0,12).entries()){
    const next={},base='variants.'+i+'.';for(const k of ['name','engine'])next[k]=value(base+k,k,v?.[k]);
    const anchors=[...(positions[base+'name']||[]),...(positions[base+'engine']||[])];
    if(!anchors.length)continue;
    for(const k of ['fuel','cc','hp','torque_nm','gearbox','drive','l_per_100km','battery_kwh','range_km'])next[k]=value(base+k,k,v?.[k],anchors);
    next._sources={};for(const k of Object.keys(next)){const refs=evidence[base+k];if(refs)next._sources[k]=refs}
    out.variants.push(next);
  }
  out.equipment=[];
  for(const [i,item] of (Array.isArray(raw.equipment)?raw.equipment:[]).slice(0,40).entries()){
    const path='equipment.'+i+'.name',name=value(path,'equipment',item?.name);
    if(typeof name!=='string'||!name.trim()||name.length>120)continue;
    const entries=(proof[path]||[]).filter(e=>(positions[path]||[]).some(p=>p.id===e.source&&p.at===quoteAt(e.source,e.quote))&&supports('equipment',name,e.quote));
    const positiveEntries=entries.filter(e=>!/(?:does not|doesn't|not equipped|not available|unavailable|without|no longer includes)|ไม่มี|ไม่ได้ติดตั้ง|ไม่รองรับ/.test(squash(e.quote)));
    const ids=[...new Set(positiveEntries.map(e=>e.source))],positiveQuotes=positiveEntries.map(e=>squash(e.quote));
    if(!positiveQuotes.length)continue;
    let availability='listed';
    if(item.availability==='optional'&&positiveQuotes.some(s=>/\b(?:optional|option|extra.cost)\b|อุปกรณ์เสริม|ออปชัน|ออฟชั่น|เลือกติดตั้ง/.test(s)))availability='optional';
    if(item.availability==='standard'&&positiveQuotes.some(s=>!/not standard|ไม่ใช่.*มาตรฐาน|ไม่เป็น.*มาตรฐาน/.test(s)&&/\bstandard\b|เป็นอุปกรณ์มาตรฐาน|ติดตั้ง.*มาตรฐาน/.test(s)))availability='standard';
    let variant=null;
    if(typeof item.variant==='string'&&item.variant.length<=80){const candidate=squash(item.variant);if(candidate&&ids.some(id=>normal(docs.find(d=>d.id===id)?.title).includes(normal(candidate))))variant=item.variant;
      else variant=value('equipment.'+i+'.variant','variant',item.variant,positions[path]);}
    out.equipment.push({name:name.trim(),category:item.category==='safety'?'safety':'comfort',availability,variant,sourceIds:ids});
  }
  out.safety=[];out.comfort=[];out.notes=null;out.diagnostic=diagnostic;return out;
}
