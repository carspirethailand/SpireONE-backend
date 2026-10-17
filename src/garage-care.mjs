// Scheduling metadata only. No transcript, audio, inferred fact or auto-written car data.
export const GARAGE_CARE_KEY = '_garage_care';
const DAY = 86400000;
export const GARAGE_CARE_POLICY = Object.freeze({ accountGap: 7 * DAY, mileageAge: 30 * DAY, fieldGap: 90 * DAY, dueWindow: 30 * DAY });
const FIELDS = ['mileage', 'ins', 'act', 'tax', 'chk'];
const idOK = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,59}$/.test(id);
const parse = raw => { try { return JSON.parse(raw); } catch { return null; } };
const fresh = () => ({ version: 1, enabled: true, nextAt: 0, cars: {}, prompt: null });
const dateTime = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const t = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0,10) === value ? t : null;
};
const mileage = value => {
  const s = String(value ?? '').replace(/,/g, '').trim();
  return /^\d{1,7}$/.test(s) && Number(s) <= 3000000 ? String(Number(s)) : '';
};

// Pure planner: silence is a client-side invitation opportunity, not a diagnosis
// of hesitation. Only supplied owner-saved values influence freshness.
export function planGarageCheckin(previous, carId, values, now) {
  const state = previous ? structuredClone(previous) : fresh();
  if (state.version !== 1 || !state.cars || typeof state.cars !== 'object' || Array.isArray(state.cars)) throw Error('Invalid care state');
  const old = Object.hasOwn(state.cars, carId) ? state.cars[carId] : {};
  const fields = {}, candidates = [];
  for (const field of FIELDS) {
    const value = field === 'mileage' ? mileage(values.mileage) : dateTime(values[field]) === null ? '' : values[field];
    const before = old?.[field];
    const record = before && before.value === value ? { ...before } : { value, observedAt: now, askedAt: before?.askedAt || 0 };
    fields[field] = record;
    const missing = !value;
    const due = field === 'mileage' ? value && now - record.observedAt >= GARAGE_CARE_POLICY.mileageAge
      : value && dateTime(value) - now <= GARAGE_CARE_POLICY.dueWindow;
    const wait = field === 'mileage' ? GARAGE_CARE_POLICY.mileageAge : GARAGE_CARE_POLICY.fieldGap;
    if ((missing || due) && (!record.askedAt || now - record.askedAt >= wait)) candidates.push(field);
  }
  state.cars[carId] = fields;
  // Keep current + most recent cars bounded. A per-account gap still covers evicted cars.
  const ids = Object.keys(state.cars).filter(id => id !== carId).slice(-19);
  state.cars = Object.fromEntries([...ids, carId].map(id => [id, state.cars[id]]));
  const field = state.enabled === false || now < (state.nextAt || 0) ? null : candidates[0] || null;
  return { state, field };
}

async function readPolicy(env, uid) {
  const row = await env.DB.prepare('SELECT v, t FROM user_state WHERE uid = ? AND k = ?').bind(uid, GARAGE_CARE_KEY).first();
  const state = row ? parse(row.v) : fresh();
  if (!state || state.version !== 1) throw Error('Invalid care policy');
  return { state, revision: row?.t || 0 };
}
async function writePolicy(env, uid, state, revision, now) {
  // Atomic compare-and-swap: two calls/devices cannot both claim a weekly question.
  const result = await env.DB.prepare(`INSERT INTO user_state (uid,k,v,t) VALUES (?,?,?,?)
    ON CONFLICT(uid,k) DO UPDATE SET v=excluded.v,t=excluded.t WHERE user_state.t=? RETURNING t`)
    .bind(uid, GARAGE_CARE_KEY, JSON.stringify(state), Math.max(now, revision + 1), revision).first();
  return !!result;
}
async function valuesFor(env, uid, carId) {
  if (!idOK(carId)) return null;
  const deleted = await env.DB.prepare('SELECT t FROM user_state WHERE uid=? AND k=?').bind(uid, '_car_deleted:' + carId).first();
  if (deleted) return null;
  const [car, rows] = await Promise.all([
    env.DB.prepare('SELECT id,mileage FROM cars WHERE uid=? AND id=?').bind(uid, carId).first(),
    env.DB.prepare('SELECT k,v FROM user_state WHERE uid=? AND k IN (?,?)').bind(uid, 'garage', 'reg_' + carId).all()
  ]);
  const entries = Object.fromEntries((rows.results || []).map(r => [r.k, parse(r.v)]));
  const local = Array.isArray(entries.garage) ? entries.garage.find(c => c?.id === carId) : null;
  if (!car && !local) return null;
  const reg = entries['reg_' + carId];
  return { mileage: local?.mileage ?? car?.mileage, ...Object.fromEntries(FIELDS.slice(1).map(k => [k, reg && typeof reg === 'object' && !Array.isArray(reg) ? reg[k] : null])) };
}
const QUESTIONS = {
  mileage: ['ถ้าจอดรถแล้วและสะดวก เลขไมล์รถคันที่เลือกที่ทราบล่าสุดเท่าไรครับ ถ้าจำไม่แม่นไว้ตอบทีหลังก็ได้', 'If you are parked and it is convenient, what is the latest known odometer reading of your selected car? If unsure, you can answer another time.'],
  ins: ['ประกันรถคันที่เลือก รอบล่าสุดหมดอายุวันไหนครับ ถ้ายังไม่ทราบไว้ตอบทีหลังก็ได้', 'When does the current insurance for your selected car expire? It is fine to answer another time.'],
  act: ['พ.ร.บ. รถคันที่เลือก รอบล่าสุดหมดอายุวันไหนครับ ถ้าไม่สะดวกข้ามได้เลย', 'When does the current compulsory insurance for your selected car expire? You can skip this.'],
  tax: ['ภาษีรถคันที่เลือก รอบล่าสุดครบกำหนดวันไหนครับ ถ้ายังไม่ทราบไว้ตอบทีหลังก็ได้', 'When is the current road-tax renewal date for your selected car? It is fine to answer later.'],
  chk: ['รถคันที่เลือกมีวันตรวจสภาพครั้งถัดไปที่ทราบแล้วไหมครับ ถ้ายังไม่ทราบข้ามได้เลย', 'Do you already know the next inspection date for your selected car? You can skip this if not.']
};

export async function garageCheckin(env, uid, body, now = Date.now()) {
  const action = body?.action || 'claim';
  if (!['claim', 'skip', 'disable', 'enable'].includes(action)) return { error: 'Invalid check-in action', status: 400 };
  const { state, revision } = await readPolicy(env, uid);
  if (action !== 'claim') {
    if (action === 'skip') {
      if (!state.prompt || state.prompt.ticket !== body.ticket || state.prompt.expiresAt < now) return { error: 'Check-in expired', status: 409 };
      state.nextAt = Math.max(state.nextAt || 0, now + GARAGE_CARE_POLICY.accountGap);
      state.prompt = null;
    } else { state.enabled = action === 'enable'; state.prompt = null; }
    if (!await writePolicy(env, uid, state, revision, now)) return { error: 'Check-in state changed; retry later', status: 409 };
    return { ok: true, enabled: state.enabled !== false, skipped: action === 'skip' };
  }
  const values = await valuesFor(env, uid, body?.carId);
  if (!values) return { question: null };
  const plan = planGarageCheckin(state, body.carId, values, now);
  let question = null;
  if (plan.field) {
    plan.state.cars[body.carId][plan.field].askedAt = now;
    plan.state.nextAt = now + GARAGE_CARE_POLICY.accountGap;
    const ticket = crypto.randomUUID();
    plan.state.prompt = { ticket, expiresAt: now + 30 * 60000 };
    question = { ticket, carId: body.carId, field: plan.field,
      text: QUESTIONS[plan.field][body.lang === 'en' ? 1 : 0],
      prepare: plan.field === 'mileage' ? { do: 'car_km', car: body.carId } : { do: 'due', car: body.carId, key: plan.field } };
    if (plan.field !== 'mileage' && values[plan.field]) {
      const names = {ins:['ประกันภัย','insurance'],act:['พ.ร.บ.','compulsory insurance'],tax:['ภาษีรถ','road tax'],chk:['ตรวจสภาพ','vehicle inspection']};
      const label = names[plan.field][body.lang === 'en' ? 1 : 0];
      question.text = body.lang === 'en' ? `The saved ${label} date is approaching or has passed. Do you have a confirmed date for the next period? It is fine to skip.`
        : `วัน${label}ที่บันทึกไว้ใกล้ถึงหรือผ่านแล้ว มีวันที่รอบใหม่ที่ยืนยันแล้วไหมครับ ถ้ายังไม่มีข้ามได้เลย`;
    }
  }
  if (!await writePolicy(env, uid, plan.state, revision, now)) return { question: null };
  return { question };
}

export const GARAGE_CARE_RULES = 'Garage check-ins are optional and rare. Silence alone does not prove confusion or consent. Never repeatedly ask for garage details on your own. Only when the app provides one scheduled garage check-in, and the conversation is idle with no urgent/safety issue, optionally ask that ONE short question. Do not repeat it or start a questionnaire if ignored. Never request driving/reading a dashboard while moving, identity documents, VIN, phone, location or other personal information for this feature. A user may skip or turn check-ins off using garage_checkin_control; only do this on their explicit request. Saved mileage/renewal dates are owner-reported, not verified specifications or proof a vehicle is safe. Clarify the car, mileage unit or exact date if ambiguous; never invent facts, assume an expired policy was renewed, infer a replacement interval, or treat an estimate as an exact reading. To save a clear answer, use the existing valet prepare/read-back/explicit-confirm flow, never save just because the user was silent. Respect Valet permissions. Never claim a value was saved unless the save tool actually succeeds. Safety, the user\'s topic and pending work always take priority.';
