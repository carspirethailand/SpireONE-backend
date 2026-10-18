// Curated factual summaries, not copied repair procedures, acoustic templates or training labels.
// Sources were read on 2026-10-18. These are deliberately narrow US-market records.
// A bulletin documents a condition; it does NOT establish prevalence or this vehicle's diagnosis.
const tsb=(year,file)=>`https://static.nhtsa.gov/odi/tsbs/${year}/${file}.pdf`;
const recall=(year,file)=>`https://static.nhtsa.gov/odi/rcl/${year}/${file}.pdf`;
const models=(names,from,to)=>names.map(model=>({model,from,to}));
const entries=[
  {id:'toyota-tsb-0041-13',make:'Toyota',kind:'car',document:'T-SB-0041-13',date:'2013-03-15',
    url:tsb(2013,'MC-10133786-9999'),title:'Toyota — brief cold-start knock/rattle (1AR/2AR)',
    models:[...models(['Camry'],2010,2012),...models(['Highlander','Venza'],2009,2013),...models(['RAV4'],2009,2012),...models(['Sienna'],2011,2013)],
    engines:['1AR-FE','2AR-FE'],engineCodes:['1ARFE','2ARFE'],
    observation:'A brief knock or rattle, approximately one second, immediately after a cold-soak start is documented for certain 1AR-FE/2AR-FE vehicles.',
    interpretation:'A dealer must establish whether this specific start-up condition and bulletin apply; it is not a normal-sound reference.',
    checks:['Engine code and bulletin vehicle identifiers must match; dealer checks applicability.'],soundEvidence:true},
  {id:'ford-tsb-22-2200',make:'Ford',kind:'car',document:'22-2200',date:'2022-05-20',
    url:tsb(2022,'MC-10212106-0001'),title:'Ford — 3.5L EcoBoost cold-start ticking/rattle',
    models:[...models(['F-150'],2017,2020),...models(['Expedition'],2018,2020)],engines:['3.5L EcoBoost','3.5L GTDI'],
    displacement:'3.5',engineLabels:['ecoboost','gtdi'],
    observation:'Some listed vehicles can rattle or tap at the front of the engine for 2–5 seconds after a cold soak of at least six hours.',
    interpretation:'The bulletin associates that specific condition with possible VCT-unit wear; a recording alone cannot confirm it.',
    checks:['Built on or before 2019-10-31; technician confirms source and applicability.'],soundEvidence:true},
  {id:'honda-09-010',make:'Honda',kind:'car',document:'09-010 version 3',date:'2016-03-15',
    url:tsb(2016,'MC-10204264-9999'),title:'Honda — engine rattle at cold start',
    // Only the unrestricted 2010–12 CR-V rows are admitted here, not the VIN-limited 2013 rows.
    models:models(['CR-V'],2010,2012),engines:[],
    observation:'A loud rattle lasting about two seconds at cold start is documented on the listed CR-V years.',
    interpretation:'A VTC actuator is a possible cause for the bulletin-specific condition; different noises need separate diagnosis.',
    checks:['Dealer checks current bulletin and vehicle eligibility. This record does not cover Wave, HR-V or all Honda models.'],soundEvidence:true},
  {id:'mazda-01-008-23',make:'Mazda',kind:'car',document:'01-008/23',date:'2023-06-05',
    url:tsb(2023,'MC-10238663-0001'),title:'Mazda — belt tensioner leakage and engine-bay rattle',
    models:[...models(['CX-5'],2013,2019),...models(['CX-9','CX-3','MX-5'],2016,2019),...models(['Mazda3','Mazda6'],2014,2019)],engines:[],
    observation:'Engine-bay rattling with oil leakage at the drive-belt automatic tensioner is documented for some listed vehicles.',
    interpretation:'Damper sealing is one documented explanation when both the mechanical evidence and applicability match, not a diagnosis from rattling alone.',
    checks:['Dealer confirms vehicle specification and actual tensioner leakage. The separate VIN-limited CX-30 scope is not included here.'],soundEvidence:true},
  {id:'bmw-11-03-17',make:'BMW',kind:'car',document:'SIB 11 03 17 revision 7',date:'2021-07-01',
    url:tsb(2021,'MC-10204619-9999'),title:'BMW — N20/N26 chain-drive whine',
    // Conservative subset of the explicit model table. Engine and exact production dates still matter.
    models:[...models(['320i','528i','Z4 sDrive28i'],2012,2015).map(m=>({...m,engineCodes:['N20']})),
      ...models(['328i'],2012,2015),...models(['228i'],2014,2014).map(m=>({...m,engineCodes:['N20']})),...models(['228i'],2015,2015),...models(['428i'],2014,2015),
      ...models(['X1 xDrive28i'],2012,2015).map(m=>({...m,engineCodes:['N20']})),...models(['X1 sDrive28i','X3 xDrive28i'],2013,2015).map(m=>({...m,engineCodes:['N20']}))],
    engines:['N20','N26'],engineCodes:['N20','N26'],
    observation:'A lower-engine whine increasing in frequency with engine speed is documented in this chain-drive bulletin.',
    interpretation:'Timing-chain or oil-pump-chain wear is a possible explanation requiring the BMW test plan. This is a limited-warranty bulletin, not a recall.',
    checks:['Exact chassis, engine, production dates and dealer vehicle inquiry are required; model/year alone is insufficient. No present warranty eligibility is asserted.'],soundEvidence:true},
  {id:'audi-2039995-2',make:'Audi',kind:'car',document:'15 16 28 / 2039995/2',date:'2016-04-27',
    url:tsb(2016,'SB-10093541-0699'),title:'Audi — 3.0 TFSI first-start chain rattle',
    models:[...models(['A4','A5 Cabriolet','A6','Q7'],2011,2015),...models(['A5','A8','Q5'],2013,2015),...models(['A7'],2012,2015)],
    engines:['3.0L TFSI'],displacement:'3.0',engineLabels:['tfsi'],
    observation:'A timing-drive rattle for about 1–3 seconds on the first start of the day is described for the listed 3.0 TFSI vehicles.',
    interpretation:'An upper chain tensioner is a documented cause of that narrow condition; unrelated rattles must not inherit this explanation or its damage assessment.',
    checks:['Technician verifies engine, actual sound and current bulletin applicability.'],soundEvidence:true},
  {id:'mercedes-li07-02-p-054717',make:'Mercedes',kind:'car',document:'LI07.02-P-054717 version 3',date:'2016-11-14',
    url:tsb(2016,'MC-10205147-9999'),title:'Mercedes-Benz — injection-system ticking/pulsing',
    models:[],engines:['M276','M278','M157','M152'],engineCodes:['M276','M278','M157','M152','276','278','157','152'],
    observation:'The manufacturer describes high-frequency ticking or pulsing from certain high-pressure pumps and injectors as a possible characteristic operating sound.',
    interpretation:'This does not make every tick normal. The bulletin calls for comparison with a reference vehicle under similar conditions before judging sound level.',
    checks:['Confirmed engine family is required. A technician must distinguish it from unrelated noises or abnormal sound levels.'],soundEvidence:true},
  {id:'porsche-sy-05-14',make:'Porsche',kind:'car',document:'SY 05/14 ENU 1055',date:'2018-08-14',
    url:tsb(2018,'MC-10148789-9999'),title:'Porsche — pulsating high-frequency engine-bay noise',
    models:models(['Boxster','Cayman','911'],2009,2016),engines:[],
    observation:'A high-frequency pulsating noise is documented for specified 987/981 and 997/991 sports cars.',
    interpretation:'Oil-separator spring tolerance is one documented explanation only with the affected part fitted. A revised part can rule out the bulletin’s stated cause.',
    checks:['Dealer checks exact generation, variant and oil-separator part. It is not a Cayenne bulletin and does not establish current warranty coverage.'],soundEvidence:true},
  {id:'mitsubishi-sc-16-001rev',make:'Mitsubishi',kind:'car',document:'SC-16-001REV',date:'2016-03',
    url:tsb(2016,'MC-10194159-9999'),title:'Mitsubishi — Mirage cold-start knocking campaign',
    models:models(['Mirage'],2014,2015),engines:[],
    observation:'The campaign describes cold-start noise associated with inappropriate fuel commands from the engine controller on certain Mirage vehicles.',
    interpretation:'ECM reprogramming is the campaign action; rare mechanically verified knocking cases require further dealer assessment. Noise alone does not justify engine replacement.',
    checks:['Built before 2015-02-18; dealer confirms affected vehicle and whether the campaign was already completed.'],soundEvidence:true},
  {id:'honda-16v528',make:'Honda',kind:'motorcycle',document:'16V-528 / KB9',date:'2019-12-12',
    url:recall(2016,'RCRIT-16V528-0266'),title:'Honda — selected CBR300R/CB300F crankshaft recall',
    models:models(['CBR300R','CBR300RA','CB300F'],2015,2016),engines:[],
    observation:'This US recall describes premature connecting-rod-bearing-retainer damage that can lead to stalling or a failure to restart.',
    interpretation:'The document does not provide an acoustic test. Do not infer recall status or a damaged bearing from a recording.',
    checks:['Dealer confirms affected vehicle and completed remedy. Not applicable to Wave 110i by brand association.'],soundEvidence:false},
  {id:'yamaha-15v176',make:'Yamaha',kind:'motorcycle',document:'15V-176',date:'2015',
    url:recall(2015,'RCMN-15V176-2068'),title:'Yamaha — selected 2015 shift-shaft campaign',
    models:models(['FJ-09','FZ-09','FZ6R','Super Tenere','Super Tenere ES','YZF-R6'],2015,2015),engines:[],
    observation:'Certain listed 2015 motorcycles had a shift-shaft component that could crack and prevent proper shifting.',
    interpretation:'This is transmission safety information, not an engine-noise reference or proof that an individual motorcycle is affected.',
    checks:['Dealer must verify affected variant and campaign completion. Do not encourage riding a vehicle with unsafe shifting.'],soundEvidence:false}
];
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x)}return x};
export const VEHICLE_ISSUES=freeze(entries.map(x=>({...x,markets:['US'],checkedAt:'2026-10-18',
  evidence:'manufacturer_document',prevalence:'not_established',audioTrainingLabel:false})));
const norm=v=>typeof v==='string'?v.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,''):'';
const makeOf=v=>({mercedesbenz:'mercedes',benz:'mercedes',mitsubish:'mitsubishi',โตโยต้า:'toyota',ฮอนด้า:'honda',มิตซูบิชิ:'mitsubishi',ยามาฮ่า:'yamaha'})[norm(v)]||norm(v);
function marketOf(v){const n=norm(v);return ({us:'US',usa:'US',unitedstates:'US',unitedstatesofamerica:'US',สหรัฐอเมริกา:'US',th:'TH',thailand:'TH',ไทย:'TH',ประเทศไทย:'TH',ca:'CA',canada:'CA'})[n]||(n?'OTHER':'')}
function engineMatch(row,v,scope){
  if(!row.engines.length)return true;
  const code=norm(v.engine_code),engine=norm(v.engine);
  if(row.engineCodes){
    const codes=scope?.engineCodes||row.engineCodes;
    if(code)return codes.some(c=>norm(c)===code);
    // Bound codes: N20 is not N200, 276 is not a substring of 1276.
    const words=String(v.engine||'').toUpperCase().match(/[A-Z0-9]+(?:-[A-Z0-9]+)*/g)||[];
    return codes.some(c=>words.some(w=>norm(w)===norm(c)));
  }
  const litre=row.displacement.replace('.','[.,]'),cc=String(Number(row.displacement)*1000);
  return new RegExp('(?<![\\d.])(?:'+litre+'(?!\\d)|'+cc+'\\s*cc\\b)','i').test(String(v.engine||''))&&row.engineLabels.some(t=>engine.includes(t));
}
export function modelIssueKnowledge(vehicle={}){
  if(!vehicle||typeof vehicle!=='object'||Array.isArray(vehicle))return result([]);
  const make=makeOf(vehicle.make),model=norm(vehicle.model),year=Number(vehicle.model_year||vehicle.year);
  const market=marketOf(vehicle.market||vehicle.country),kind=String(vehicle.kind||vehicle.vehicle_type||'').toLowerCase();
  const records=[];
  if(!make||!model||!Number.isInteger(year)||year<1900||year>2100)return result(records);
  for(const row of VEHICLE_ISSUES){
    if(makeOf(row.make)!==make||(kind&&kind!==row.kind)||(market&&!row.markets.includes(market)))continue;
    const scope=row.models.find(m=>norm(m.model)===model&&year>=m.from&&year<=m.to);
    if(row.models.length&&!scope)continue;
    // Engine-family-only documents cannot match a badge/model alone.
    if(!row.models.length&&!engineMatch(row,vehicle))continue;
    const missing=[];
    if(row.engines.length&&!engineMatch(row,vehicle,scope)){
      if(norm(vehicle.engine)||norm(vehicle.engine_code))continue;
      missing.push('engine');
    }
    if(!market)missing.push('market');
    records.push({...row,status:missing.length?'scope_check_required':'documented_candidate',missing,
      applicability:'not_confirmed_for_this_vehicle',diagnosis:false});
  }
  return result(records.slice(0,4));
}
function result(records){return {status:records.length?'candidates':'no_documented_match',records,
  acousticModelsTrained:0,limitation:'Curated manufacturer evidence, not model-weight training or a confirmed diagnosis. No prevalence, recall eligibility, current warranty coverage or safe-to-drive verdict is established. Missing scope requires verification; absence of a record does not mean no defects exist.'}}
// A public search can retrieve candidates but cannot confirm a recording subject.
// Do not infer market/engine from location, account, phone microphone or a saved car.
export function issueKnowledgeForQuery(query){
  if(typeof query!=='string'||query.length>240)return result([]);
  const q=query.normalize('NFKC').toLowerCase(),years=[...new Set(q.match(/\b(?:19|20)\d{2}\b/g)||[])];
  const makes=[...new Set(VEHICLE_ISSUES.map(r=>r.make))].filter(make=>{
    const names=make==='Mercedes'?['mercedes','mercedes-benz']:make==='Mitsubishi'?['mitsubishi','mitsubish']:[make.toLowerCase()];
    return names.some(n=>new RegExp('(?:^|[^a-z])'+n+'(?:$|[^a-z])','i').test(q));
  });
  if(makes.length!==1||years.length!==1)return result([]);
  const found=[...new Set(VEHICLE_ISSUES.filter(r=>r.make===makes[0]).flatMap(r=>r.models.map(m=>m.model)))].filter(m=>{
    const pattern=m.toLowerCase().split(/[ -]+/).join('[ -]*').replace(/\./g,'\\.');
    return new RegExp('(?:^|[^a-z0-9])'+pattern+'(?:$|[^a-z0-9])','i').test(q);
  });
  // Longest exact public model token avoids A5 also matching A5 Cabriolet.
  found.sort((a,b)=>b.length-a.length);
  if(!found.length)return result([]);
  if(found.slice(1).some(m=>!norm(found[0]).startsWith(norm(m))))return result([]);
  const hasEngine=/\b(?:\d\.\d\s*l?|\d{3,4}\s*cc|[1-9][a-z]{2,4}(?:-?[a-z]{1,4})?|[nm]\d{2,3}|diesel|electric|hybrid)\b/i.test(q);
  const market=/\b(?:thailand|thai|th)\b|ประเทศไทย|ตลาดไทย/i.test(q)?'TH':/\b(?:usa|united states|us market)\b/i.test(q)?'US':'';
  return modelIssueKnowledge({make:makes[0],model:found[0],year:years[0],...(hasEngine?{engine:query}:{}),market});
}
