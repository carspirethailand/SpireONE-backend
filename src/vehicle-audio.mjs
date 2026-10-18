// Audio observations cannot authenticate a vehicle or certify that it is safe to drive.
// No recordings, transcripts, VINs, plates or personal identifiers are retained here.
const text = (v, n = 100) => typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '';
export function audioCar(raw = {}) {
  if (!raw || typeof raw !== 'object') return {};
  const name = text(raw.name), words = name.split(/\s+/);
  return Object.fromEntries(Object.entries({make:text(raw.make || words[0]),model:text(raw.model || words.slice(1).join(' ')),year:text(raw.model_year || raw.year, 4),engine:text(raw.engine,80),engine_code:text(raw.engine_code,24),fuel:text(raw.fuel || raw.fuelType,30),mileage:text(raw.mileage,12)}).filter(([,v])=>v));
}
export function audioIdentity(context = {}) {
  const v = context?.audioVehicle;
  const source = v?.version === 1 && ['garage_confirmed','other_confirmed','unknown'].includes(v.source) ? v.source : 'unconfirmed';
  // Old clients may send a saved car. That is a candidate only, never a confirmed recording subject.
  const vehicle = ['garage_confirmed','other_confirmed'].includes(source) ? audioCar(v.vehicle) : {};
  return {source,vehicle,label:[vehicle.make,vehicle.model,vehicle.year,vehicle.engine,vehicle.engine_code].filter(Boolean).join(' '),identifiedFromAudio:false};
}
export const VEHICLE_AUDIO_RULES = [
  'VEHICLE IDENTITY: Never identify make, model, model year, engine code, displacement or fuel from engine sound alone. Similar engines, fans, phone processing and recording positions overlap. Never claim acoustic fingerprint matching or a trained all-model sound database.',
  'The server supplies audioIdentity separately. Only garage_confirmed or other_confirmed is the vehicle the user explicitly chose for THIS recording; it is a user statement, not verified identity. A saved Garage car is only a candidate until confirmed. A friend\'s car or an internet clip MUST NOT inherit the saved car. Do not write any make/model/year names in your observations, causes or speech; the app displays the user-confirmed vehicle separately. If unknown or conflicting, ask which car, year and engine, while still describing audible evidence.',
  'CURRENT EVIDENCE ONLY: Ignore vehicle identity and conclusions in old assistant messages. They may be wrong. No audio attachment or no successful listen_engine result means you have NOT analysed raw engine sound. Ordinary call audio is speech-filtered: use listen_engine for a dedicated recording, and wait for its result. Do not claim a fan, normal engine, exact faulty part or safe-to-drive verdict from speech-filtered call audio.',
  'CAPTURE PROVENANCE: An attached clip from dedicated_microphone is a separate recording, NOT the ordinary call stream. Browser-reported echoCancellation/noiseSuppression/autoGainControl are the only evidence of enabled processing. Unknown settings mean unknown. Never claim telephone filtering, microphone defects, wind or music without actual evidence. Never tell someone already using dedicated_microphone to use that same tool again unless the clip is genuinely unusable. Device settings are client-reported, not authenticated hardware measurements.',
  'MOTORCYCLES: Distinguish manual/semi-automatic chain drive, CVT scooters and electric drivetrains only when confirmed by vehicle details or applicable documents. Do not transplant car radiator-fan/diesel advice to a Wave, CVT advice to a geared bike, or combustion/idle/injector advice to an electric bike. Single-cylinder pulses alone do not establish a fault. Chain, valve train, exhaust leaks, bodywork, CVT and motor/bearing noise are possibilities only with an audible clue and compatible drivetrain, never universal model diseases.',
  'Separate observations, possible explanations and confirmation checks. Airflow/roaring alone cannot distinguish radiator fan, intake, AC or recording wind. Regular diesel ticking alone does not prove either healthy injectors or faulty injectors. Check changes with RPM, cold/warm, AC setting, duration, location, dashboard warnings, smoke and vibration; do not invent any of them. Ask at most two useful missing questions at a time.',
  'Model-year problems need an applicable manufacturer document with matching market, engine and production range. One online repair video is an individual case, not prevalence, recall applicability, a diagnosis, an acoustic template or proof that another car has the same defect. Do not invent known problems or generalise one engine/year to all cars of that badge.',
  'SAFETY: A short recording cannot certify roadworthiness. Do not say safe to drive / fine to drive / ขับต่อได้. Stop safely and arrange professional help for oil-pressure warning, overheating/steam, fuel smell, heavy metallic knock, grinding brakes or severe shaking. Never instruct revving a suspect engine, touching running parts, disconnecting injector lines, removing covers, spraying belts or opening a hot cooling cap. Record only while safely parked in P/N with parking brake, outdoors, at a safe distance from moving/hot parts; idle only, no forced revs.'
].join(' ');

export const SOUND_REFERENCES = Object.freeze([
  {id:'dayco-belt',title:'Dayco — diagnosing drive system belt noise',url:'https://www.dayco.com/na-en/techhub/diagnosing-drive-system-belt-noise/',scope:'General belt-drive education, not a vehicle-specific defect rate.',note:'Rhythmic chirp and sustained squeal have multiple belt-drive causes. A technician must confirm alignment, wear and tension; audio alone is not proof.'},
  {id:'denso-diesel',title:'DENSO — diesel injection technology',url:'https://www.denso-am.eu/news/denso-injecting-life-into-diesel-technology',scope:'General diesel injection technology; not a Fortuner fault bulletin.',note:'Injection control affects combustion noise. Diesel ticking or knocking needs supporting symptoms and workshop diagnostics; do not equate it to a failed injector.'}
]);
export function soundGrounding(context) {
  const identity = audioIdentity(context);
  return {audioIdentity:identity,recording:captureInfo(context),referenceNotes:SOUND_REFERENCES.map(({id,note,scope})=>({id,note,scope})),modelYearFaults:[],limitation:'No validated vehicle-specific audio classifier or model-year fault corpus. Do not claim otherwise.'};
}
export function captureInfo(context={}){
  const r=context.recording||{},out={source:['dedicated_microphone','uploaded_file'].includes(r.source)?r.source:'unknown',processing:{}};
  for(const k of ['echoCancellation','noiseSuppression','autoGainControl'])if(typeof r.processing?.[k]==='boolean')out.processing[k]=r.processing[k];
  for(const [k,min,max] of [['durationSeconds',0,120],['sampleRate',8000,192000],['gain',0,8]])if(Number.isFinite(r[k])&&r[k]>=min&&r[k]<=max)out[k]=r[k];
  return out;
}
export const SOUND_TASK = [
  VEHICLE_AUDIO_RULES,
  'Listen to the actual attached audio. Describe what you actually hear (tick, knock, squeal, chirp, hum, roar, hiss, rattle, grind, misfire), rhythm and whether change with RPM is actually audible. Name wind, clipping, speech, music, too-short clips and other masking. Only give 0-3 possible causes supported by audible clues. Likelihood is qualitative, never a percentage.',
  'Return JSON only: {"quality":"good|noisy|too_quiet|no_engine","evidence":"distinct|limited|none","hear":"observed sound only","normality":"not_established|can_be_normal|unusual","causes":[{"name":"possible system, not an asserted fault","likelihood":"possible|less likely","clue":"audible evidence, not invented symptoms"}],"urgency":"unassessed|soon|stop","next":["safe next step or missing question"],"speak":"2 short sentences, no vehicle identity or driving clearance"}. Quality measures recording usability, NOT vehicle condition. With noisy audio retain 0-3 hypotheses ONLY if a distinct clue remains audible (evidence=distinct); otherwise no part diagnosis. can_be_normal means no clear abnormality heard, NOT proof of health. unusual means an abnormal sound with an actual clue, NOT proof of a faulty part. too_quiet/no_engine must have evidence=none. Ask at most TWO useful questions, not engine code as a mandatory requirement.'
].join(' ');
export const SOUND_SCHEMA={type:'OBJECT',properties:{quality:{type:'STRING',enum:['good','noisy','too_quiet','no_engine']},evidence:{type:'STRING',enum:['distinct','limited','none']},hear:{type:'STRING'},normality:{type:'STRING',enum:['not_established','can_be_normal','unusual']},causes:{type:'ARRAY',items:{type:'OBJECT',properties:{name:{type:'STRING'},likelihood:{type:'STRING',enum:['possible','less likely']},clue:{type:'STRING'}},required:['name','likelihood','clue']}},urgency:{type:'STRING',enum:['unassessed','soon','stop']},next:{type:'ARRAY',items:{type:'STRING'}},speak:{type:'STRING'}},required:['quality','evidence','hear','normality','causes','urgency','next','speak']};

// Defensive output gate: identity stays server-owned; discard brand-swapping hallucinations.
// The model is instructed to keep ALL vehicle names out of prose, including the selected one.
const vehicleName = /\b(?:toyota|honda|fortuner|hr[ -]?v|cr[ -]?v|isuzu|mitsubishi|ford|mazda|nissan|suzuki|subaru|bmw|mercedes|porsche|audi|volvo|tesla|hyundai|kia|chevrolet|mg|byd|gwm|haval|lexus|daihatsu|peugeot|renault|volkswagen|ducati|yamaha|kawasaki|vespa|1kd[ -]?ftv|2gd[ -]?ftv)\b|โตโยต้า|ฮอนด้า|ฟอร์จูนเนอร์|เอชอาร์วี|อีซูซุ|มิตซูบิชิ|ฟอร์ด|มาสด้า|นิสสัน|เบนซ์/i;
export function cleanSound(raw, context = {}, lang = 'th') {
  const en = lang === 'en', identity = audioIdentity(context);
  const fallback = en ? 'This recording does not establish the source or whether the vehicle is operating normally.' : 'คลิปนี้ยังยืนยันต้นเสียงหรือความปกติของรถไม่ได้ครับ';
  const arr = v => Array.isArray(v) ? v : [];
  const prose = [raw.hear,raw.normal,raw.speak,...arr(raw.next),...arr(raw.causes).flatMap(x=>[x?.name,x?.clue])].map(x=>text(x,600)).join(' ');
  // A correct user-stated name is not a brand swap. Strip ONLY those exact
  // tokens for this check; other makes/models remain a rejection.
  let foreignProse=prose;
  for(const v of [identity.vehicle.make,identity.vehicle.model,identity.vehicle.engine_code].filter(Boolean)){
    const escaped=v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    foreignProse=foreignProse.replace(new RegExp('(?<![\\p{L}\\p{N}])'+escaped+'(?![\\p{L}\\p{N}])','giu'),'');
  }
  const identityRejected = vehicleName.test(foreignProse)||/\b(?:lambretta|gpx|deco|lion ev|em motor)\b|ยามาฮ่า|ซูซูกิ|เวสป้า|แลมเบรตต้า/i.test(foreignProse);
  const safetyRejected= /ขับต่อได้|เครื่อง(?:ยนต์)?ปกติ(?:แน่นอน|ครับ)|ไม่มีปัญหาแน่นอน|\b(?:safe|fine|okay|ok) to (?:drive|keep driving)\b|definitely (?:normal|healthy)/i.test(prose);
  const rejected=identityRejected||safetyRejected;
  const quality = !rejected && text(raw.hear,400) && ['good','noisy','too_quiet','no_engine'].includes(raw.quality) ? raw.quality : 'noisy';
  const good = quality === 'good';
  const usable=!rejected&&(good||quality==='noisy'&&raw.evidence==='distinct')&&raw.evidence!=='none';
  const urgency = raw.urgency === 'stop' ? 'stop' : usable && raw.urgency === 'soon' ? 'soon' : 'unassessed';
  const normality = usable && ['can_be_normal','unusual'].includes(raw.normality) ? raw.normality : 'not_established';
  const recording=captureInfo(context);
  const processingClaim=/telephone|phone.call filtering|speech.filter|noise.suppress|กรองเสียงจากการโทร|โทรศัพท์ที่มีการกรอง|ผ่านการกรองเสียง/i;
  const falseProcessingClaim=recording.source==='dedicated_microphone'&&(/telephone|phone.call filtering|speech.filter|กรองเสียงจากการโทร|โทรศัพท์ที่มีการกรอง/i.test(prose)||recording.processing.noiseSuppression!==true&&recording.processing.echoCancellation!==true&&processingClaim.test(prose));
  const next = rejected ? [] : arr(raw.next).slice(0,2).map(x=>text(x,180)).filter(x=>x&&!(falseProcessingClaim&&processingClaim.test(x)));
  if (!identity.vehicle.model) next.unshift(en ? 'Which car, model year and engine is in this recording? It may not be the Garage car.' : 'คลิปนี้เป็นรถรุ่นไหน ปีไหน เครื่องอะไรครับ อาจไม่ใช่คันใน Garage');
  if (!good && !next.length) next.push(en ? 'If safe, record again while parked outdoors, without talking or music. Do not rev or touch running parts.' : 'หากปลอดภัย ให้อัดใหม่ขณะจอดกลางแจ้ง ไม่พูดหรือเปิดเพลง ไม่เร่งเครื่องหรือสัมผัสส่วนที่กำลังหมุน');
  if (urgency === 'stop') next.unshift(en ? 'Stop safely and arrange professional help. Do not rev the engine for another recording.' : 'หยุดใช้รถในที่ปลอดภัยและให้ช่างตรวจ ห้ามเร่งเครื่องเพื่ออัดซ้ำ');
  const observationRejected=falseProcessingClaim&&processingClaim.test(String(raw.hear||''));
  const finalNormality=observationRejected?'not_established':normality;
  const observation= observationRejected ? (en?'The cause of masking noise or microphone processing cannot be established from this clip.':'ยังระบุที่มาของเสียงรบกวนหรือตัวกรองไมค์จากคลิปนี้ไม่ได้') : text(raw.hear,400)||fallback;
  return {audioVersion:2,identity,identityRejected,safetyRejected,recording,falseProcessingClaim,quality,evidence:usable?'distinct':raw.evidence==='limited'?'limited':'none',hear:rejected ? fallback : observation,
    assessment:finalNormality==='can_be_normal'?'no_clear_abnormality':finalNormality==='unusual'?(good?'abnormal_sound':'possible_abnormality'):'inconclusive',
    normality:finalNormality,normal:finalNormality==='can_be_normal' ? (en?'No clear abnormality heard; this does not confirm a healthy engine.':'ยังไม่พบความผิดปกติชัดจากคลิป ไม่ใช่การยืนยันว่าเครื่องสมบูรณ์') : finalNormality==='unusual'?(en?'An unusual sound is audible; the source needs inspection.':'ได้ยินลักษณะเสียงผิดปกติ ควรตรวจยืนยันต้นเสียง'):fallback,
    causes:usable&&!observationRejected ? arr(raw.causes).slice(0,3).map(c=>({name:text(c?.name,100),likelihood:c?.likelihood==='less likely'?'less likely':'possible',clue:text(c?.clue,180)})).filter(c=>c.name&&c.clue&&!(falseProcessingClaim&&processingClaim.test(c.name+' '+c.clue))) : [],
    urgency,next:next.slice(0,4),speak:rejected ? fallback : falseProcessingClaim ? observation : text(raw.speak,400)||fallback};
}
export function soundText(d, lang='th') {
  const en=lang==='en';
  return [(en?'Recording vehicle: ':'รถในคลิป: ')+(d.identity.label || (en?'Not confirmed':'ยังไม่ยืนยัน')),
    en?'Vehicle details are user-selected, not identified from sound.':'ข้อมูลรถมาจากที่ผู้ใช้เลือก ไม่ใช่การระบุรุ่นจากเสียง',d.hear,d.normal,
    ...d.causes.map(c=>'• '+c.name+' — '+c.clue),...d.next.map(n=>'→ '+n)].join('\n');
}
export function legacySound(d,take='') {
  return {audioVersion:2,identity:d.identity,assessment:d.assessment,normality:d.normality,research:d.research,recording:d.recording,quality:d.quality==='good'?'clear':'noisy',heard:d.hear,normal:false,
    urgency:d.urgency==='stop'?'now':d.urgency==='soon'?'soon':'watch',causes:d.causes.map(c=>({what:c.name,chance:null,why:c.clue,check:''})),
    doNow:d.next,tellShop:d.hear,take};
}
