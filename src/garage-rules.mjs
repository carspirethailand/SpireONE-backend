const SERVICES=['oil','airf','cabin','plug','brakepad','brakeoil','tire','align','batt','coolant','gearoil','belt','shock'];
const JOB_CAP={oil:15000,airf:5000,cabin:5000,plug:20000,brakepad:25000,brakeoil:6000,tire:80000,align:6000,batt:30000,coolant:10000,gearoil:20000,belt:25000,shock:80000};
const fail=(field,message)=>{throw Object.assign(Error(message),{field,status:400})};
const plain=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
function number(v,min,max,field='number',integer=false){
  if(typeof v!=='number'&&(typeof v!=='string'||!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(v.trim())))fail(field,'กรอกตัวเลขที่ชัดเจน / Enter a valid number');
  const n=typeof v==='number'?v:Number(v.trim().replace(/,/g,''));
  if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n))||(!integer&&Math.abs(n*100-Math.round(n*100))>0.00001))fail(field,'ตัวเลขเกินช่วงที่รองรับ / Number out of range');
  return n;
}
function label(v,max=80,min=2){
  if(typeof v!=='string')fail('text','กรอกข้อความ / Enter text');
  const s=v.normalize('NFC').trim().replace(/\s+/g,' ');
  if(Array.from(s).length<min||Array.from(s).length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e\u2066-\u2069]/.test(s))fail('text','ความยาวหรือรูปแบบข้อความไม่ถูกต้อง / Invalid text length or format');
  if(!s&&min===0)return s;
  const letters=s.toLowerCase().replace(/[^\p{L}]/gu,'');
  if(!letters||/^(.)\1{3,}$/u.test(letters)||/(.{2,5})\1{2,}/u.test(letters)||(letters.length>=6&&new Set(letters).size<=2)||/[bcdfghjklmnpqrstvwxz]{6,}/.test(letters)||/[a-z]{25,}/.test(letters))fail('text','ช่วยใช้ข้อความที่อ่านได้ / Please use readable words');
  const rows=['qwertyuiop','asdfghjkl','zxcvbnm','ฟหกดเ้่าสวง','ๆไำพะัีรนยบลฃ','ผปแอิืทมใฝ'];
  for(const row of rows)for(const r of [row,Array.from(row).reverse().join('')]){const width=/[a-z]/.test(r)?5:4;for(let i=0;i<=r.length-width;i++)if(s.toLowerCase().includes(r.slice(i,i+width)))fail('text','ช่วยใช้ข้อความที่อ่านได้ / Please use readable words')}
  return s;
}
function date(v,past=false,now=Date.now()){
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))fail('date','วันที่ไม่ถูกต้อง / Invalid date');
  const t=Date.parse(v+'T00:00:00Z'),today=new Date(now+7*3600000).toISOString().slice(0,10);
  if(!Number.isFinite(t)||new Date(t).toISOString().slice(0,10)!==v||v<'1990-01-01'||v>(past?today:String(+today.slice(0,4)+10)+today.slice(4)))fail('date','วันที่อยู่นอกช่วง / Date out of range');
  return v;
}
const norm=s=>String(s||'').normalize('NFC').toLowerCase().replace(/[^a-z0-9\u0e00-\u0e7f]/g,'');
function reference(car,rows=[],now=Date.now()){
  const matches=(Array.isArray(rows)?rows:[]).filter(r=>plain(r)&&norm(r.make)===norm(car?.make)&&norm(r.model)===norm(car?.model)&&String(r.year)===String(car?.year)&&/^https:\/\//.test(r.source||'')&&Number.isFinite(Date.parse(r.asOf))&&Date.parse(r.asOf)<=now&&now-Date.parse(r.asOf)<2*365*86400000);
  return matches.length===1?matches[0]:null;
}
function costPolicy(car,ref){
  const n=[car?.make,car?.model,car?.name].filter(Boolean).join(' ').toLowerCase();
  let cap=3000000,factor=1;
  if(/ferrari|lamborghini|rolls|bentley|mclaren|bugatti|pagani|koenigsegg|aston|maybach|rimac/.test(n)){cap=80000000;factor=10}
  else if(/porsche|maserati|land ?rover|range ?rover|lotus|alphard|vellfire|land ?cruiser|lexus ?l[mxc]\b|\bamg\b|\bg ?63\b|\bm[2-8]\b|\br8\b|\brs ?[3-7q]\b|gt-?r\b|lucid/.test(n)){cap=25000000;factor=5}
  else if(/bmw|mercedes|benz|audi|lexus|volvo|jaguar|tesla|mini|genesis|cadillac|lincoln|infiniti|acura|alfa|polestar|jeep|mustang|zeekr|denza|hongqi|lynk|supra|type ?r\b|nismo|corvette|camaro/.test(n)){cap=10000000;factor=2.5}
  const verified=ref&&Number.isFinite(ref.valueThb)&&ref.valueThb>0&&ref.valueThb<=1000000000;
  return {basis:verified?(ref.kind==='documented-new-price'?'documented-new-price':'model-reference'):'heuristic',cap:verified?ref.valueThb:cap,factor,source:verified?ref.source:null,asOf:verified?ref.asOf:null,
    maxByJob:verified&&plain(ref.maxByJob)?Object.fromEntries(Object.entries(ref.maxByJob).filter(([k,v])=>SERVICES.includes(k)&&Number.isFinite(v)&&v>0&&v<=ref.valueThb)):{}};
}
function money(v,car={},job='',ref=null){
  const n=number(v,0,1000000000,'amount'),p=costPolicy(car,ref),limit=Math.min(p.cap,p.maxByJob[job]??(JOB_CAP[job]||500000)*p.factor);
  if(n>limit)fail('amount',p.basis!=='heuristic'?'ยอดสูงกว่าเกณฑ์อ้างอิงรถรุ่น/ปีนี้ / Above this model-year reference limit':'ยอดสูงกว่าเกณฑ์ตรวจสอบเบื้องต้น กรุณาตรวจเลข / Above the preliminary validation limit');
  return n;
}
function record(kind,e,car,ref,now=Date.now()){
  if(!plain(e))fail(kind,'รายการไม่ถูกต้อง / Invalid record');
  if(e.date)date(e.date,true,now);
  if(e.note!=null&&e.note!=='')label(e.note,80,1);
  if(kind==='services'){
    if(!SERVICES.includes(e.k))fail('item','รายการบำรุงรักษาไม่ถูกต้อง / Invalid maintenance item');
    number(e.km??0,0,3000000,'km',true);money(e.amount??0,car,e.k,ref);
  }else if(kind==='fuel'){
    number(e.km??0,0,3000000,'km',true);number(e.amount,0,15000,'amount');number(e.litres??0,0,300,'litres');
  }else if(kind==='trips'){
    label(e.title||'ทริป',60,2);number(e.km,0.1,10000,'distance');
  }
  return e;
}
const stable=x=>JSON.stringify(x,(_k,v)=>plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
function validateState(key,value,previous,car,ref,now=Date.now()){
  const m=/^(carlab_(log|todo|iv|sym)|cal_price)_([A-Za-z0-9_.:-]{1,60})$/.exec(key);
  if(!m)return value;
  if(!car)fail('car','ไม่พบรถในบัญชีนี้ / Car not found in this account');
  if(stable(value)===stable(previous))return value; // Old unchanged data is preserved, never silently deleted.
  const type=m[2]||'price';
  function list(next,old,check,max=1000){
    if(!Array.isArray(next)||next.length>Math.max(max,Array.isArray(old)?old.length:0))fail('records','รายการมากเกินไป / Too many records');
    const existing=new Set((Array.isArray(old)?old:[]).map(stable));
    for(const e of next)if(!existing.has(stable(e)))check(e);
  }
  if(type==='log'){
    if(!plain(value))fail('records','รูปแบบสมุดรถไม่ถูกต้อง / Invalid logbook');
    for(const k of ['services','fuel','trips'])list(value[k]||[],previous?.[k],e=>record(k,e,car,ref,now));
  }else if(type==='todo'){
    list(value,previous,e=>{label(e.title,60);number(e.dueKm??0,0,3000000,'km',true);if(e.dueDate)date(e.dueDate,false,now);if(typeof e.done!=='boolean')fail('done','สถานะไม่ถูกต้อง / Invalid status')},100);
  }else if(type==='sym'){
    list(value,previous,e=>{label(e.t,200,3);if(e.date)date(e.date,true,now);if(e.km!=null)number(e.km,0,3000000,'km',true)},100);
  }else{
    if(!plain(value)||Object.keys(value).length>40)fail('records','รูปแบบรายการไม่ถูกต้อง / Invalid items');
    for(const [k,v] of Object.entries(value)){
      if(stable(v)===stable(previous?.[k]))continue;
      if(!SERVICES.includes(k))fail('item','รายการไม่ถูกต้อง / Invalid item');
      if(type==='price')money(v,car,k,ref);
      else{if(!plain(v))fail('interval','รอบไม่ถูกต้อง / Invalid interval');number(v.km,500,200000,'interval',true);if(v.mo!=null)number(v.mo,1,120,'months',true)}
    }
  }
  return value;
}
const INFO_FIELDS={trim:60,engine:60,engine_code:40,model_year:4,market:40,drive:20,gear:20,fuel:20,tire:30,vin:17,plate:20,province:40,tax_due:10,ins_due:10,ins_co:60,note:300};
export function costReferences(rows,now=Date.now()){
  if(!Array.isArray(rows)||rows.length>1000)fail('references','Invalid reference list');
  const seen=new Set();
  return rows.map(r=>{
    if(!plain(r))fail('reference','Invalid reference');
    const make=label(r.make,60),model=label(r.model,60),year=String(number(r.year,1950,new Date(now).getFullYear()+1,'year',true));
    let url;try{url=new URL(r.source)}catch{fail('source','HTTPS provenance required')}
    if(url.protocol!=='https:'||url.username||url.password||url.href.length>500)fail('source','HTTPS provenance required');
    date(r.asOf,true,now);const key=[norm(make),norm(model),year].join('|');
    if(seen.has(key))fail('reference','Duplicate model year');seen.add(key);
    const valueThb=number(r.valueThb,1,1000000000,'value'),maxByJob={};
    if(r.maxByJob!=null&&!plain(r.maxByJob))fail('reference','Invalid job limits');
    for(const [job,value] of Object.entries(r.maxByJob||{})){
      if(!SERVICES.includes(job))fail('job','Invalid job');maxByJob[job]=number(value,1,valueThb,'job limit');
    }
    return {make,model,year,valueThb,maxByJob,asOf:r.asOf,source:url.href};
  });
}
const INFO_ENUMS={market:['TH','JP','US','UK','DE','AU','EU','GLOBAL'],drive:['FWD','RWD','AWD','4WD'],gear:['อัตโนมัติ','ธรรมดา','CVT','DCT','AT','MT','Automatic','Manual'],fuel:['เบนซิน','ดีเซล','ไฮบริด','ปลั๊กอินไฮบริด','ไฟฟ้า','แก๊ส','petrol','diesel','hybrid','phev','ev','lpg']};
const PROVINCES='กรุงเทพมหานคร กระบี่ กาญจนบุรี กาฬสินธุ์ กำแพงเพชร ขอนแก่น จันทบุรี ฉะเชิงเทรา ชลบุรี ชัยนาท ชัยภูมิ ชุมพร เชียงราย เชียงใหม่ ตรัง ตราด ตาก นครนายก นครปฐม นครพนม นครราชสีมา นครศรีธรรมราช นครสวรรค์ นนทบุรี นราธิวาส น่าน บึงกาฬ บุรีรัมย์ ปทุมธานี ประจวบคีรีขันธ์ ปราจีนบุรี ปัตตานี พระนครศรีอยุธยา พะเยา พังงา พัทลุง พิจิตร พิษณุโลก เพชรบุรี เพชรบูรณ์ แพร่ ภูเก็ต มหาสารคาม มุกดาหาร แม่ฮ่องสอน ยโสธร ยะลา ร้อยเอ็ด ระนอง ระยอง ราชบุรี ลพบุรี ลำปาง ลำพูน เลย ศรีสะเกษ สกลนคร สงขลา สตูล สมุทรปราการ สมุทรสงคราม สมุทรสาคร สระแก้ว สระบุรี สิงห์บุรี สุโขทัย สุพรรณบุรี สุราษฎร์ธานี สุรินทร์ หนองคาย หนองบัวลำภู อ่างทอง อำนาจเจริญ อุดรธานี อุตรดิตถ์ อุทัยธานี อุบลราชธานี'.split(' ');
const PROVINCES_EN='Bangkok|Krabi|Kanchanaburi|Kalasin|Kamphaeng Phet|Khon Kaen|Chanthaburi|Chachoengsao|Chon Buri|Chonburi|Chai Nat|Chaiyaphum|Chumphon|Chiang Rai|Chiang Mai|Trang|Trat|Tak|Nakhon Nayok|Nakhon Pathom|Nakhon Phanom|Nakhon Ratchasima|Nakhon Si Thammarat|Nakhon Sawan|Nonthaburi|Narathiwat|Nan|Bueng Kan|Buri Ram|Buriram|Pathum Thani|Prachuap Khiri Khan|Prachin Buri|Pattani|Phra Nakhon Si Ayutthaya|Ayutthaya|Phayao|Phang Nga|Phatthalung|Phichit|Phitsanulok|Phetchaburi|Phetchabun|Phrae|Phuket|Maha Sarakham|Mukdahan|Mae Hong Son|Yasothon|Yala|Roi Et|Ranong|Rayong|Ratchaburi|Lop Buri|Lopburi|Lampang|Lamphun|Loei|Si Sa Ket|Sisaket|Sakon Nakhon|Songkhla|Satun|Samut Prakan|Samut Songkhram|Samut Sakhon|Sa Kaeo|Saraburi|Sing Buri|Sukhothai|Suphan Buri|Surat Thani|Surin|Nong Khai|Nong Bua Lam Phu|Ang Thong|Amnat Charoen|Udon Thani|Uttaradit|Uthai Thani|Ubon Ratchathani'.toLowerCase().split('|');
function engineCode(s){
  // Shape checks are not proof that this code belongs to this vehicle.
  const code=s.toUpperCase(),core=code.replace(/[ ./-]/g,'');
  if(!/^[A-Z0-9]+(?:[ ./-][A-Z0-9]+)*$/.test(code)||core.length<2||core.length>14||!/[A-Z]/.test(core)||/([A-Z0-9])\1{3}/.test(core)||/[A-Z]{6}/.test(core)||/\d{6}/.test(code)||(!/\d/.test(core)&&core.length>5))return false;
  return !['QWERTYUIOP','ASDFGHJKL','ZXCVBNM'].some(row=>[row,[...row].reverse().join('')].some(r=>Array.from({length:r.length-3},(_,i)=>r.slice(i,i+4)).some(run=>core.includes(run))));
}
function detailField(k,s,input){
  if(INFO_ENUMS[k]&&!INFO_ENUMS[k].includes(s))fail(k,'เลือกค่าจากรายการ / Choose a supported option');
  if(k==='engine'&&!/\d|ดีเซล|เบนซิน|ไฟฟ้า|ไฮบริด|แก๊ส|diesel|petrol|gasoline|electric|hybrid|rotary/i.test(s))fail(k,'ระบุชนิดหรือขนาดเครื่องจากคู่มือ หรือเว้นว่าง / Use a documented engine type or size, or leave blank');
  if(k==='engine_code'&&!engineCode(s))fail(k,'ใช้รหัสเครื่องจากคู่มือ เช่น 1KD-FTV, K20C1 หรือเว้นว่าง / Use a documented engine code or leave blank');
  if(k==='plate'&&(!/^[\p{L}\p{N} -]{2,20}$/u.test(s)||!/[0-9๐-๙]/.test(s)))fail(k,'ตรวจรูปแบบทะเบียนรถ / Check the plate format');
  if(k==='province'&&(!input.market||input.market==='TH')&&!PROVINCES.includes(s.replace(/^จังหวัด|^จ\.\s*/,'').trim())&&!PROVINCES_EN.includes(s.toLowerCase()))fail(k,'ใช้ชื่อจังหวัดจริง เช่น กรุงเทพมหานคร / Use a valid province name');
  if(k==='tire'&&!/^(?:(?:[1-4]\d{2})\/(?:[2-9]\d)\s*(?:ZR|R|-)\s*(?:1\d|2\d)(?:\s*\d{2,3}[A-Z])?|(?:[6-9]\d|1\d{2})\/(?:[5-9]\d|100)\s*(?:R|-)\s*(?:1\d|2\d)|\d{1,2}\.\d{2}\s*(?:R|-)\s*(?:1\d|2\d))$/i.test(s))fail(k,'ตรวจขนาดยาง เช่น 265/60 R18 / Check the tyre size');
}

function infoPatch(input,previous={}){
  if(!plain(input))fail('info','ข้อมูลรถไม่ถูกต้อง / Invalid car details');
  const out={};
  for(const [k,v] of Object.entries(input)){
    if(!Object.hasOwn(INFO_FIELDS,k))continue;
    if(Object.hasOwn(previous||{},k)&&v===previous[k]){out[k]=v;continue}
    if(k==='model_year'&&v!==''&&(typeof v!=='string'||!/^\d{4}$/.test(v.trim())||+v<1950||+v>new Date().getFullYear()+1))fail(k,'ปีรุ่นไม่ถูกต้อง / Invalid model year');
    if(typeof v!=='string'||Array.from(v).length>INFO_FIELDS[k]||/[\u0000-\u001f\u202a-\u202e]/.test(v))fail(k,'ข้อมูลยาวหรือรูปแบบไม่ถูกต้อง / Invalid detail length or format');
    const s=v.normalize('NFC').trim();if(!s){out[k]='';continue}
    if(k==='vin'&&!/^[A-HJ-NPR-Z0-9]{17}$/.test(s.toUpperCase().replace(/[\s-]/g,'')))fail('vin','เลขตัวถังไม่ถูกต้อง / Invalid VIN');
    detailField(k,s,input);
    if(/_due$/.test(k)){try{date(s)}catch(e){e.field=k;throw e}}
    if(!['vin','plate','model_year','tax_due','ins_due','tire','engine_code'].includes(k)){try{label(s,INFO_FIELDS[k],1)}catch(e){e.field=k;throw e}}
    out[k]=k==='vin'?s.toUpperCase().replace(/[\s-]/g,''):s;
  }
  return out;
}
const api=Object.freeze({SERVICES:Object.freeze(SERVICES),INFO_FIELDS:Object.freeze(INFO_FIELDS),infoPatch,number,label,date,reference,costPolicy,money,record,validateState});

export default api;
export {validateState,record,reference,costPolicy,money,label,number,date,infoPatch};
