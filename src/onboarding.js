/* Account-scoped onboarding. Browser setup flags are preferences, never proof
 * that onboarding or the tutorial was completed. Birthday stays in this private
 * endpoint; do not include this table in public/user-directory projections. */
export const ONBOARDING_VERSIONS = Object.freeze({terms: '2026-10-10', privacy: '2026-10-10'});
export const ONBOARDING_LANGS = Object.freeze(['th','en','zh','ja','ko','id','vi','ms','de','fr','es','pt','ar']);
export const ONBOARDING_CURRENCIES = Object.freeze(['THB','USD','EUR','GBP','JPY','CNY','SGD','AUD','CAD','CHF','NZD','HKD','MYR','IDR','KRW','VND','INR','TWD','AED']);
const LEVELS = ['basic','advance','enthusiast'];
const THEMES = ['light','dark','ocean','plant','magma'];
const PLANS = ['free','light','exclusive','pro','plus','max','premium'];

/* Run the complete array in one D1 batch BEFORE marking schema 21 ready or
 * allowing any state writes. The seed_done flag freezes the grandfathering
 * snapshot: backdating a later /api/state upload cannot finish onboarding. */
export const ONBOARDING_SQL = [
  `CREATE TABLE IF NOT EXISTS user_onboarding (
    uid TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    terms_version TEXT NOT NULL,
    privacy_version TEXT NOT NULL,
    consented_at INTEGER,
    tutorial_status TEXT NOT NULL DEFAULT 'pending' CHECK(tutorial_status IN ('pending','completed','skipped')),
    tutorial_finished_at INTEGER,
    legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1))
  )`,
  `INSERT INTO config (key,value) VALUES ('onboarding_rollout_at', CAST(CAST(strftime('%s','now') AS INTEGER)*1000 AS TEXT))
    ON CONFLICT(key) DO NOTHING`,
  `INSERT INTO user_onboarding (uid,profile,completed_at,terms_version,privacy_version,consented_at,tutorial_status,tutorial_finished_at,legacy)
    SELECT u.uid,s.v,s.t,'legacy-pre-onboarding','legacy-pre-onboarding',NULL,'skipped',s.t,1
    FROM users u JOIN user_state s ON s.uid=u.uid AND s.k='setup'
    WHERE NOT EXISTS (SELECT 1 FROM config WHERE key='onboarding_seed_done')
      AND u.created_at IS NOT NULL AND u.created_at>0
      AND u.created_at<CAST((SELECT value FROM config WHERE key='onboarding_rollout_at') AS INTEGER)
      AND s.t>0 AND s.t<=CAST((SELECT value FROM config WHERE key='onboarding_rollout_at') AS INTEGER)
      AND CASE WHEN json_valid(s.v) THEN json_type(s.v)='object'
        AND json_extract(s.v,'$.v')=3
        AND json_extract(s.v,'$.level') IN ('basic','advance','enthusiast')
        AND (json_extract(s.v,'$.uid') IS NULL OR json_extract(s.v,'$.uid')=u.uid)
        ELSE 0 END
    ON CONFLICT(uid) DO NOTHING`,
  `INSERT INTO config (key,value) SELECT 'onboarding_seed_done',value FROM config WHERE key='onboarding_rollout_at'
    ON CONFLICT(key) DO NOTHING`,
];

const reply = (data, status=200) => Response.json(data, {status, headers:{'Cache-Control':'private, no-store'}});
const reject = (error, status=400) => reply({ok:false,error},status);
const decode = raw => {try {const v=JSON.parse(raw);return v && typeof v==='object' && !Array.isArray(v)?v:{};} catch {return {};}};

function readableName(value) {
  if(typeof value!=='string' || /[<>\p{Cc}\p{Cf}]/u.test(value)) return null;
  const s=value.normalize('NFC').trim().replace(/\s+/gu,' ');
  return Array.from(s).length>=1 && Array.from(s).length<=60 && /[\p{L}\p{N}]/u.test(s)?s:null;
}
function validBirth(value, now=Date.now()) {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year,month,day]=value.split('-').map(Number);
  if(year<1900 || month<1 || month>12 || day<1 || day>31) return false;
  const date=new Date(Date.UTC(year,month-1,day));
  const today=new Date(now).toISOString().slice(0,10);
  return date.getUTCFullYear()===year && date.getUTCMonth()===month-1 && date.getUTCDate()===day && value<=today;
}
const locale = (s,fallback='en') => ONBOARDING_LANGS.includes(s)?s:fallback;
const currency = (s,fallback='THB') => ONBOARDING_CURRENCIES.includes(s)?s:fallback;
function photo(value) {
  if(typeof value!=='string') return '';
  if(value.length<=2048 && /^https:\/\//i.test(value)) {try {return new URL(value).href;}catch {return '';}}
  return value.length<=2*1024*1024 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)?value:'';
}

/* Preserve preferences, not client-provided authority. Existing paid-plan
 * labels are only UI compatibility; quota/billing remains server-controlled. */
function compatible(old, uid) {
  if(old.uid && old.uid!==uid) old={};
  const distance=['km','mi','m'].includes(old.distance)?old.distance:old.units==='imperial'?'mi':'km';
  return {v:3,uid,name:readableName(old.name)||'',lang:locale(old.lang),distance,
    units:distance==='mi'?'imperial':'metric',currency:currency(old.currency),
    level:LEVELS.includes(old.level)?old.level:'enthusiast',
    theme:THEMES.includes(old.theme)?old.theme:'light',
    plan:PLANS.includes(old.plan)?old.plan:'free',photo:photo(old.photo),notify:old.notify===true};
}
function envelope(row, uid, preferences={}) {
  if(!row) return {ok:true,status:'required',ready:false,completed:false,profile:null,
    tutorial:{status:'pending',finishedAt:null},versions:ONBOARDING_VERSIONS};
  const source=decode(row.profile);
  const preserved=compatible(preferences,uid);
  const profile={...compatible(source,uid),birthDate:row.legacy?null:(validBirth(source.birthDate)?source.birthDate:null),at:Number(row.completed_at)};
  for(const key of ['level','theme','plan','photo','notify']) if(Object.hasOwn(preferences,key) && (!preferences.uid || preferences.uid===uid)) profile[key]=preserved[key];
  return {ok:true,status:'completed',ready:true,completed:true,profile,completedAt:Number(row.completed_at),
    consentedAt:row.consented_at==null?null:Number(row.consented_at),legacy:row.legacy===1,
    termsVersion:row.terms_version,privacyVersion:row.privacy_version,
    tutorial:{status:row.tutorial_status,finishedAt:row.tutorial_finished_at==null?null:Number(row.tutorial_finished_at)},
    versions:ONBOARDING_VERSIONS};
}
async function readRow(env,uid) {return env.DB.prepare('SELECT * FROM user_onboarding WHERE uid=?').bind(uid).first();}
/* Called on BOTH generic state reads and writes. Canonical authority never
 * comes from a browser snapshot, even a newer timestamp or explicit null.
 * Deliberately throw DB errors: callers must fail closed, not return raw state. */
export async function sanitizeSetupState(env,uid,value) {
  if(typeof uid!=='string' || !uid || !env.DB) throw new Error('onboarding_unavailable');
  const canonical=await readRow(env,uid);
  const own=v=>v && typeof v==='object' && !Array.isArray(v) &&
    (!Object.hasOwn(v,'uid') || v.uid===uid);
  let input=own(value)?value:{};
  if(canonical) {
    const stored=await env.DB.prepare("SELECT v FROM user_state WHERE uid=? AND k='setup'").bind(uid).first();
    const previous=decode(stored?.v);
    input={...(own(previous)?previous:{}),...input};
  }
  const safe=compatible(input,uid);
  if(canonical) {
    const authority=compatible(decode(canonical.profile),uid);
    for(const key of ['name','lang','distance','units','currency']) safe[key]=authority[key];
  }
  return {...safe,at:canonical?Number(canonical.completed_at):0,
    completed:!!canonical,onboardingComplete:!!canonical};
}
export async function onboardingName(env,uid) {
  if(typeof uid!=='string' || !uid || !env.DB) return '';
  try {const row=await env.DB.prepare('SELECT profile FROM user_onboarding WHERE uid=?').bind(uid).first();return readableName(decode(row?.profile).name)||'';} catch {return '';}
}
async function responseFor(env,row,uid) {
  if(!row) return envelope(null,uid);
  const state=await env.DB.prepare("SELECT v FROM user_state WHERE uid=? AND k='setup'").bind(uid).first();
  return envelope(row,uid,decode(state?.v));
}
function compatibilityStatements(env,uid,at) {
  return [
    env.DB.prepare(`UPDATE users SET name=(SELECT json_extract(profile,'$.name') FROM user_onboarding WHERE uid=?)
      WHERE uid=? AND EXISTS (SELECT 1 FROM user_onboarding WHERE uid=?)`).bind(uid,uid,uid),
    env.DB.prepare(`INSERT INTO user_state (uid,k,v,t)
      SELECT uid,'setup',json_remove(json_set(profile,'$.uid',uid,'$.v',3,'$.at',completed_at),'$.birthDate','$.birth','$.dob'),?
      FROM user_onboarding WHERE uid=?
      ON CONFLICT(uid,k) DO UPDATE SET v=excluded.v,t=excluded.t`).bind(at,uid),
    env.DB.prepare(`INSERT INTO user_state (uid,k,v,t) SELECT uid,'lang',json_quote(json_extract(profile,'$.lang')),?
      FROM user_onboarding WHERE uid=? ON CONFLICT(uid,k) DO UPDATE SET v=excluded.v,t=excluded.t`).bind(at,uid),
    env.DB.prepare(`INSERT INTO user_state (uid,k,v,t) SELECT uid,'currency',json_quote(json_extract(profile,'$.currency')),?
      FROM user_onboarding WHERE uid=? ON CONFLICT(uid,k) DO UPDATE SET v=excluded.v,t=excluded.t`).bind(at,uid),
  ];
}
async function body(request) {
  const maxBytes=16384;
  const declared=request.headers.get('Content-Length');
  if(declared!==null && (!/^\d+$/.test(declared) || Number(declared)>maxBytes)) {
    try {request.body?.cancel().catch(()=>{});} catch {}
    throw new Error(Number(declared)>maxBytes?'too_large':'invalid_body');
  }
  if(!request.body) throw new Error('invalid_body');
  const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
  let timeout,bytes=0;
  const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('read_timeout')),5000);});
  try {
    const chunks=[];
    while(true) {
      const {done,value}=await Promise.race([reader.read(),deadline]);
      if(done) break;
      bytes+=value.byteLength;
      if(bytes>maxBytes) throw new Error('too_large');
      chunks.push(decoder.decode(value,{stream:true}));
    }
    chunks.push(decoder.decode());
    const value=JSON.parse(chunks.join(''));
    if(!value || typeof value!=='object' || Array.isArray(value) || Object.getPrototypeOf(value)!==Object.prototype) throw new Error('invalid_body');
    return value;
  } finally {
    clearTimeout(timeout);
    // Do not await cancellation: a malicious source's cancel callback may
    // itself never settle. The response deadline must remain bounded.
    try {reader.cancel().catch(()=>{});} catch {}
  }
}

export async function handleOnboarding(request, env, actor) {
  const path=new URL(request.url).pathname;
  if(!['/api/onboarding','/api/onboarding/tutorial','/api/onboarding/preferences'].includes(path)) return null;
  const uid=actor?.payload?.sub;
  if(typeof uid!=='string' || !uid || uid.length>200) return reject('authentication_required',401);
  if(!env.DB) return reject('onboarding_unavailable',503);
  if((path==='/api/onboarding' && !['GET','POST'].includes(request.method)) ||
     (path==='/api/onboarding/tutorial' && request.method!=='POST') ||
     (path==='/api/onboarding/preferences' && request.method!=='PATCH')) return reject('method_not_allowed',405);
  try {
    const existing=await readRow(env,uid);
    if(path==='/api/onboarding' && request.method==='GET') return reply(await responseFor(env,existing,uid));
    // A completion retry, including a stale device, returns the original result.
    // It cannot change another account's name, DOB, consent or tutorial status.
    if(path==='/api/onboarding' && existing) return reply(await responseFor(env,existing,uid));
    let input;
    try {input=await body(request);} catch(e) {
      return reject(e.message==='too_large'?'request_too_large':e.message==='read_timeout'?'request_timeout':'invalid_json',e.message==='too_large'?413:e.message==='read_timeout'?408:400);
    }
    if(path==='/api/onboarding/tutorial') {
      if(!existing) return reject('onboarding_required',409);
      if(!['completed','skipped'].includes(input.status)) return reject('invalid_tutorial_status');
      await env.DB.prepare(`UPDATE user_onboarding SET tutorial_status=?,tutorial_finished_at=?
        WHERE uid=? AND tutorial_status='pending'`).bind(input.status,Date.now(),uid).run();
      return reply(await responseFor(env,await readRow(env,uid),uid));
    }
    if(path==='/api/onboarding/preferences') {
      if(!existing) return reject('onboarding_required',409);
      const keys=Object.keys(input);
      if(!keys.length || keys.some(k=>!['name','lang','distance','currency'].includes(k))) return reject('invalid_preference_fields');
      const pairs=[],values=[];
      const add=(key,value)=>{pairs.push(key==='notify'?'?,json(?)':'?,?');values.push('$.'+key,value);};
      if(Object.hasOwn(input,'name')) {const name=readableName(input.name);if(!name)return reject('invalid_name');add('name',name);}
      if(Object.hasOwn(input,'lang')) {if(!ONBOARDING_LANGS.includes(input.lang))return reject('invalid_language');add('lang',input.lang);}
      if(Object.hasOwn(input,'distance')) {if(!['km','mi','m'].includes(input.distance))return reject('invalid_distance');add('distance',input.distance);add('units',input.distance==='mi'?'imperial':'metric');}
      if(Object.hasOwn(input,'currency')) {if(!ONBOARDING_CURRENCIES.includes(input.currency))return reject('invalid_currency');add('currency',input.currency);}
      // Keep current legacy preferences without permitting this endpoint to set
      // a paid plan or to alter completion/consent. Only requested editable
      // fields are changed by json_set, so concurrent partial updates compose.
      const state=await env.DB.prepare("SELECT v FROM user_state WHERE uid=? AND k='setup'").bind(uid).first();
      const old=decode(state?.v),safe=compatible(old,uid);
      if(!old.uid || old.uid===uid) for(const key of ['level','theme','plan','photo','notify']) if(Object.hasOwn(old,key)) add(key,key==='notify'?(safe[key]?'true':'false'):safe[key]);
      await env.DB.batch([
        env.DB.prepare(`UPDATE user_onboarding SET profile=json_set(profile,${pairs.join(',')}) WHERE uid=?`).bind(...values,uid),
        ...compatibilityStatements(env,uid,Date.now()),
      ]);
      return reply(await responseFor(env,await readRow(env,uid),uid));
    }
    if(input.consent!==true) return reject('consent_required');
    if(input.termsVersion!==ONBOARDING_VERSIONS.terms || input.privacyVersion!==ONBOARDING_VERSIONS.privacy) return reject('consent_version_changed',409);
    const name=readableName(input.name);
    if(!name) return reject('invalid_name');
    if(!validBirth(input.birthDate)) return reject('invalid_birth_date');
    if(!ONBOARDING_LANGS.includes(input.lang)) return reject('invalid_language');
    if(!['km','mi','m'].includes(input.distance)) return reject('invalid_distance');
    if(!ONBOARDING_CURRENCIES.includes(input.currency)) return reject('invalid_currency');
    const state=await env.DB.prepare("SELECT v FROM user_state WHERE uid=? AND k='setup'").bind(uid).first();
    const profile={...compatible(decode(state?.v),uid),name,birthDate:input.birthDate,
      lang:input.lang,distance:input.distance,units:input.distance==='mi'?'imperial':'metric',currency:input.currency,at:Date.now()};
    const now=profile.at;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO user_onboarding (uid,profile,completed_at,terms_version,privacy_version,consented_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(uid) DO NOTHING`).bind(uid,JSON.stringify(profile),now,ONBOARDING_VERSIONS.terms,ONBOARDING_VERSIONS.privacy,now),
      ...compatibilityStatements(env,uid,now),
    ]);
    return reply(await responseFor(env,await readRow(env,uid),uid));
  } catch {
    // Fail closed: the UI must not mark setup finished during a DB outage or a
    // rolled-back partial write. A retry is safe after connectivity returns.
    return reject('onboarding_unavailable',503);
  }
}
