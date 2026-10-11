import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { generateKeyPair, exportPKCS8, jwtVerify } from 'jose';
import { EMAIL_AUTH_SQL, handleEmailAuth } from '../src/email-auth.js';

// All delivery/identity transport is mocked here; no email or Firebase account is
// created by these tests. Production code has no test hooks/authentication bypass.
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
const project = 'cendon-unit1', clientEmail = `auth@${project}.iam.gserviceaccount.com`;
const service = { type: 'service_account', project_id: project, client_email: clientEmail, private_key: await exportPKCS8(privateKey) };
const customAud = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

function fixture({ users = [], native = true, mailFailure = false, firebaseFailure = false, createRace = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE users(uid TEXT PRIMARY KEY, banned INTEGER NOT NULL DEFAULT 0)');
  for (const sql of EMAIL_AUTH_SQL) sqlite.exec(sql);
  let queue = Promise.resolve();
  const operation = fn => { const task = queue.then(fn); queue = task.catch(() => {}); return task; };
  const DB = {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...v) { values = v; return this; },
        first: () => operation(() => sqlite.prepare(sql).get(...values) || null),
        all: () => operation(() => ({ results: sqlite.prepare(sql).all(...values) })),
        run: () => operation(() => statement._run()),
        _run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
      };
      return statement;
    },
    batch: list => operation(() => {
      sqlite.exec('BEGIN');
      try { const out = list.map(statement => statement._run()); sqlite.exec('COMMIT'); return out; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }),
  };
  const sent = [], identityCalls = [], accounts = new Map(users.map(user => [user.email.toLowerCase(), { ...user }]));
  const env = {
    DB, FIREBASE_PROJECT_ID: project, FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(service),
    AUTH_OTP_PEPPER: 'unit-test-pepper-not-a-production-secret-32-bytes', AUTH_EMAIL_FROM: 'hello@cendon.unit.test',
    AUTH_ALLOWED_ORIGINS: 'https://cendon.unit.test',
  };
  if (native) env.EMAIL = { async send(message) {
    sent.push(message);
    if (mailFailure) throw Error('provider-sensitive-example');
    return { messageId: 'unit-only-message-' + sent.length };
  } };
  else env.RESEND_API_KEY = 'unit-only-resend-key';
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url === 'https://api.resend.com/emails') {
      assert.equal(init.headers.Authorization, 'Bearer unit-only-resend-key');
      const message = JSON.parse(init.body); sent.push(message);
      return mailFailure ? Response.json({ message: 'provider-sensitive-example' }, { status: 400 }) : Response.json({ id: 'unit-only-resend-message' });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const grant = new URLSearchParams(init.body);
      assert.equal(grant.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const { payload } = await jwtVerify(grant.get('assertion'), publicKey, { issuer: clientEmail, audience: url });
      assert.equal(payload.scope, 'https://www.googleapis.com/auth/identitytoolkit');
      identityCalls.push({ kind: 'oauth' });
      return firebaseFailure ? Response.json({ error: 'provider-sensitive-example' }, { status: 500 }) : Response.json({ access_token: 'unit-access-token', expires_in: 3600 });
    }
    assert.equal(init.headers.Authorization, 'Bearer unit-access-token');
    assert.equal(init.redirect, 'error');
    assert.match(url, /^https:\/\/identitytoolkit\.googleapis\.com\/v1\/projects\/cendon-unit1\/accounts/);
    const body = JSON.parse(init.body);
    if (url.endsWith(':lookup')) {
      identityCalls.push({ kind: 'lookup', body });
      assert.equal(body.email.length, 1);
      const account = accounts.get(body.email[0]);
      return Response.json(account ? { users: [account] } : {});
    }
    assert.ok(url.endsWith('/accounts'));
    identityCalls.push({ kind: 'create', body });
    if (createRace) {
      accounts.set(body.email, { localId: 'google-concurrent-existing', email: body.email, emailVerified: true });
      return Response.json({ error: { message: 'EMAIL_EXISTS' } }, { status: 400 });
    }
    if (accounts.has(body.email)) return Response.json({ error: { message: 'EMAIL_EXISTS' } }, { status: 400 });
    const account = { ...body }; accounts.set(body.email, account);
    return Response.json({ localId: account.localId });
  };
  const call = async (path, body, { method = body === undefined ? 'GET' : 'POST', ip = '192.0.2.9', headers = {}, raw } = {}) => {
    const request = new Request('https://worker.unit.test' + path, { method,
      headers: { 'CF-Connecting-IP': ip, Origin: 'https://cendon.unit.test', ...(body === undefined && raw === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined && raw === undefined ? {} : { body: raw === undefined ? JSON.stringify(body) : raw }),
    });
    const r = await handleEmailAuth(request, env);
    return r ? { status: r.status, body: await r.json(), headers: r.headers } : null;
  };
  const request = email => call('/api/auth/email/request', { email });
  const code = (index = sent.length - 1) => sent[index].text.match(/^รหัสของคุณ: (\d{6})/m)[1];
  const verify = (id, value = code()) => call('/api/auth/email/verify', { challengeId: id, code: value });
  return { sqlite, env, sent, identityCalls, accounts, call, request, verify, code };
}

test('email auth: unrelated routes are untouched, route methods and cache headers are explicit', async () => {
  const f = fixture();
  assert.equal(await f.call('/api/cars'), null);
  assert.equal((await f.call('/api/auth/email/request')).status, 405);
  assert.equal((await f.call('/api/auth/config', {})).status, 405);
  const config = await f.call('/api/auth/config');
  assert.deepEqual(config.body, { emailOtpReady: true, otpLength: 6, onboardingReady:false,privacyUrl:null });
  assert.equal(config.headers.get('Cache-Control'), 'no-store');
  assert.equal(config.headers.get('Access-Control-Allow-Origin'), 'https://cendon.unit.test');
  const forbidden = await f.call('/api/auth/email/request', { email: 'person@unit.test' }, { headers: { Origin: 'https://untrusted.unit.test' } });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(f.sent.length, 0);
});

test('email auth: absent or malformed signing, pepper, sender, mail configuration fails closed', async () => {
  for (const overrides of [
    { FIREBASE_SERVICE_ACCOUNT_JSON: undefined }, { FIREBASE_SERVICE_ACCOUNT_JSON: 'not json' },
    { FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...service, project_id: 'other-project' }) },
    { FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...service, client_email: 'auth@other-project.iam.gserviceaccount.com' }) },
    { FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...service, private_key: 'not a key' }) },
    { AUTH_OTP_PEPPER: 'short' }, { AUTH_EMAIL_FROM: 'not an address' }, { EMAIL: undefined },
    { EMAIL: { send: true } }, { DB: undefined },
  ]) {
    const f = fixture(); Object.assign(f.env, overrides);
    assert.equal((await f.call('/api/auth/config')).body.emailOtpReady, false);
    const result = await f.request('person@unit.test');
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'auth/unavailable');
    assert.equal(f.sent.length, 0); assert.equal(f.identityCalls.length, 0);
  }
});

test('email auth: input is bounded and validated before any delivery', async () => {
  const f = fixture();
  for (const email of ['bad', 'person@', 'person@localhost', 'a..b@unit.test', '.person@unit.test', 'person. @unit.test', 'person@unit.test\nBcc:bad@unit.test', 'a'.repeat(65) + '@unit.test']) {
    assert.equal((await f.request(email)).status, 400);
  }
  assert.equal((await f.call('/api/auth/email/request', { email: 'person@unit.test' }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.call('/api/auth/email/request', undefined, { method: 'POST', raw: '{invalid' })).status, 400);
  // Use a fresh IP so malformed requests cannot conceal the body-limit check.
  assert.equal((await f.call('/api/auth/email/request', undefined, { method: 'POST', raw: JSON.stringify({ email: 'person@unit.test', padding: 'x'.repeat(3000) }), ip: '192.0.2.10' })).status, 413);
  assert.equal(f.sent.length, 0);
});

test('email auth: native delivery stores only a peppered hash and returns no code/email', async () => {
  const f = fixture(), result = await f.request(' Person+Car@Unit.Test ');
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['challengeId', 'expiresIn', 'resendAfter']);
  assert.equal(result.body.expiresIn, 600); assert.equal(result.body.resendAfter, 60);
  assert.equal(f.sent[0].to, 'person+car@unit.test');
  assert.equal(f.sent[0].from.email, 'hello@cendon.unit.test');
  assert.match(f.code(), /^\d{6}$/);
  const row = f.sqlite.prepare('SELECT * FROM auth_otp').get();
  assert.match(row.code_hash, /^[0-9a-f]{64}$/); assert.match(row.email_key, /^[0-9a-f]{64}$/);
  assert.notEqual(row.code_hash, f.code()); assert.equal(row.ready, 1); assert.equal(row.attempts, 0);
  assert.equal(row.expires_at - row.created_at, 600_000);
  assert.equal(f.identityCalls.length, 0);
  assert.ok(f.sqlite.prepare('SELECT k FROM auth_rate').all().every(row => /^[0-9a-f]{64}$/.test(row.k)));
});

test('email auth: Resend delivery sends one recipient and requires provider acknowledgement', async () => {
  const f = fixture({ native: false }), result = await f.request('person@unit.test');
  assert.equal(result.status, 200); assert.deepEqual(f.sent[0].to, ['person@unit.test']);
  assert.equal(f.sent[0].from, 'Cendon <hello@cendon.unit.test>');
  assert.match(f.code(), /^\d{6}$/); assert.equal(f.identityCalls.length, 0);
});

test('email auth: failed native or Resend delivery makes any delivered code unusable', async () => {
  for (const native of [true, false]) {
    const f = fixture({ native, mailFailure: true }), result = await f.request('person@unit.test');
    assert.equal(result.status, 503); assert.equal(result.body.code, 'auth/unavailable');
    assert.ok(!JSON.stringify(result.body).includes('provider-sensitive'));
    const row = f.sqlite.prepare('SELECT * FROM auth_otp').get();
    assert.equal(row.ready, 0); assert.ok(row.invalidated_at);
    assert.equal((await f.verify(row.id)).status, 400); assert.equal(f.identityCalls.length, 0);
  }
});

test('email auth: new verified passwordless account receives a valid five-minute RSA custom token', async () => {
  const f = fixture(), issued = await f.request('person@unit.test');
  const result = await f.verify(issued.body.challengeId);
  assert.equal(result.status, 200); assert.deepEqual(Object.keys(result.body), ['customToken']);
  const { payload, protectedHeader } = await jwtVerify(result.body.customToken, publicKey, { issuer: clientEmail, subject: clientEmail, audience: customAud });
  assert.equal(protectedHeader.alg, 'RS256'); assert.equal(payload.exp - payload.iat, 300);
  assert.match(payload.uid, /^email_[0-9a-f-]{36}$/);
  assert.equal(payload.claims, undefined);
  const created = f.identityCalls.find(call => call.kind === 'create').body;
  assert.deepEqual(Object.keys(created).sort(), ['email', 'emailVerified', 'localId']);
  assert.equal(created.localId, payload.uid); assert.equal(created.emailVerified, true);
  assert.equal(f.sqlite.prepare('SELECT consumed_at FROM auth_otp').get().consumed_at > 0, true);
});

test('email auth: existing Google/Firebase UID is retained without creating or linking an account', async () => {
  const f = fixture({ users: [{ localId: 'existing-google-user', email: 'person@unit.test', emailVerified: true, providerUserInfo: [{ providerId: 'google.com' }] }] });
  const issued = await f.request('person@unit.test'), result = await f.verify(issued.body.challengeId);
  assert.equal(result.status, 200);
  assert.equal((await jwtVerify(result.body.customToken, publicKey)).payload.uid, 'existing-google-user');
  assert.equal(f.identityCalls.filter(call => call.kind === 'create').length, 0);
  assert.equal(f.accounts.size, 1);
});

test('email auth: concurrent Firebase creation is re-looked up, preserving the winning UID', async () => {
  const f = fixture({ createRace: true }), issued = await f.request('person@unit.test');
  const result = await f.verify(issued.body.challengeId);
  assert.equal(result.status, 200);
  assert.equal((await jwtVerify(result.body.customToken, publicKey)).payload.uid, 'google-concurrent-existing');
  assert.equal(f.identityCalls.filter(call => call.kind === 'lookup').length, 2);
  assert.equal(f.accounts.size, 1);
});

test('email auth: unverified existing account fails closed and never changes its credentials', async () => {
  const account = { localId: 'old-unverified-user', email: 'person@unit.test', emailVerified: false, providerUserInfo: [{ providerId: 'password' }] };
  const f = fixture({ users: [account] }), issued = await f.request('person@unit.test');
  assert.equal(f.identityCalls.length, 0);
  const result = await f.verify(issued.body.challengeId);
  assert.equal(result.status, 409); assert.equal(result.body.code, 'auth/account-recovery-required');
  assert.equal(result.body.customToken, undefined); assert.deepEqual(f.accounts.get(account.email), account);
  assert.equal(f.identityCalls.filter(call => call.kind === 'create').length, 0);
});

test('email auth: Apple private relay is used only as its exact verified Firebase email', async () => {
  const email = 'relay-user@privaterelay.appleid.com';
  const f = fixture({ users: [{ localId: 'apple-user', email, emailVerified: true, providerUserInfo: [{ providerId: 'apple.com' }] }] });
  const issued = await f.request(email), result = await f.verify(issued.body.challengeId);
  assert.equal(result.status, 200); assert.equal(f.sent[0].to, email);
  assert.deepEqual(f.identityCalls.find(call => call.kind === 'lookup').body.email, [email]);
  assert.equal((await jwtVerify(result.body.customToken, publicKey)).payload.uid, 'apple-user');
});

test('email auth: Firebase-disabled and D1-banned accounts cannot receive custom tokens', async () => {
  for (const disabled of [true, false]) {
    const f = fixture({ users: [{ localId: 'blocked-user', email: 'person@unit.test', emailVerified: true, disabled }] });
    if (!disabled) f.sqlite.prepare('INSERT INTO users(uid,banned) VALUES(?,1)').run('blocked-user');
    const issued = await f.request('person@unit.test'), result = await f.verify(issued.body.challengeId);
    assert.equal(result.status, 403); assert.equal(result.body.code, 'auth/account-unavailable');
    assert.equal(result.body.customToken, undefined);
  }
});

test('email auth: five wrong attempts lock the challenge and never call Firebase', async () => {
  const f = fixture(), issued = await f.request('person@unit.test');
  const wrong = String((Number(f.code()) + 1) % 1_000_000).padStart(6, '0');
  for (let i = 0; i < 5; i++) assert.equal((await f.verify(issued.body.challengeId, wrong)).status, 400);
  assert.equal((await f.verify(issued.body.challengeId)).status, 400);
  assert.equal(f.sqlite.prepare('SELECT attempts FROM auth_otp').get().attempts, 5);
  assert.equal(f.identityCalls.length, 0);
});

test('email auth: parallel guesses cannot reserve more than five attempts', async () => {
  const f = fixture(), issued = await f.request('person@unit.test');
  const wrong = String((Number(f.code()) + 1) % 1_000_000).padStart(6, '0');
  const results = await Promise.all(Array.from({ length: 20 }, () => f.verify(issued.body.challengeId, wrong)));
  assert.ok(results.every(result => result.status === 400));
  assert.equal(f.sqlite.prepare('SELECT attempts FROM auth_otp').get().attempts, 5);
  assert.equal(f.identityCalls.length, 0);
});

test('email auth: concurrent correct submissions consume once and only one gets a token', async () => {
  const f = fixture({ users: [{ localId: 'existing-user', email: 'person@unit.test', emailVerified: true }] });
  const issued = await f.request('person@unit.test');
  const results = await Promise.all(Array.from({ length: 6 }, () => f.verify(issued.body.challengeId)));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 400).length, 5);
  assert.equal(f.identityCalls.filter(call => call.kind === 'oauth').length, 1);
  assert.equal(f.identityCalls.filter(call => call.kind === 'lookup').length, 1);
  assert.equal((await f.verify(issued.body.challengeId)).status, 400);
});

test('email auth: expired, unknown, malformed and superseded challenges are invalid', async () => {
  const f = fixture(), issued = await f.request('person@unit.test'), oldCode = f.code();
  for (const [id, code] of [[crypto.randomUUID(), oldCode], ['bad', oldCode], [issued.body.challengeId, 123456], [issued.body.challengeId, '1e0000'], [issued.body.challengeId, '1234567']]) {
    assert.equal((await f.verify(id, code)).status, 400);
  }
  f.sqlite.prepare('UPDATE auth_otp SET expires_at=? WHERE id=?').run(Date.now() - 1, issued.body.challengeId);
  assert.equal((await f.verify(issued.body.challengeId, oldCode)).status, 400);
  assert.equal(f.identityCalls.length, 0);
  f.sqlite.prepare('UPDATE auth_rate SET window_end=? WHERE window_end<=?').run(Date.now() - 1, Date.now() + 61_000);
  const second = await f.request('person@unit.test');
  assert.equal(second.status, 200);
  assert.notEqual(second.body.challengeId, issued.body.challengeId);
  assert.ok(f.sqlite.prepare('SELECT invalidated_at FROM auth_otp WHERE id=?').get(issued.body.challengeId).invalidated_at);
  assert.equal((await f.verify(issued.body.challengeId, oldCode)).status, 400);
  assert.equal((await f.verify(second.body.challengeId)).status, 200);
});

test('email auth: email cooldown is normalized and atomically permits one concurrent send', async () => {
  const f = fixture();
  const results = await Promise.all([
    f.call('/api/auth/email/request', { email: 'Person@Unit.Test' }, { ip: '192.0.2.1' }),
    f.call('/api/auth/email/request', { email: ' person@unit.test ' }, { ip: '192.0.2.2' }),
    f.call('/api/auth/email/request', { email: 'PERSON@UNIT.TEST' }, { ip: '192.0.2.3' }),
  ]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  const throttled = results.filter(result => result.status === 429);
  assert.equal(throttled.length, 2);
  assert.ok(throttled.every(result => result.body.retryAfter > 0 && Number(result.headers.get('Retry-After')) > 0));
  assert.equal(f.sent.length, 1); assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS c FROM auth_otp').get().c, 1);
});

test('email auth: IP send limits prevent rotating email mail-bombing; forwarded IP is ignored', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 14 }, (_, i) => f.call('/api/auth/email/request', { email: `person${i}@unit.test` }, { headers: { 'X-Forwarded-For': `192.0.2.${i}` } })));
  assert.equal(results.filter(result => result.status === 200).length, 10);
  assert.equal(results.filter(result => result.status === 429).length, 4);
  assert.equal(f.sent.length, 10);
});

test('email auth: hourly email limits persist across cooldown windows and IP changes', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    f.sqlite.prepare('UPDATE auth_rate SET window_end=? WHERE window_end<=?').run(Date.now() - 1, Date.now() + 61_000);
    assert.equal((await f.call('/api/auth/email/request', { email: 'person@unit.test' }, { ip: `192.0.2.${i + 1}` })).status, 200);
  }
  f.sqlite.prepare('UPDATE auth_rate SET window_end=? WHERE window_end<=?').run(Date.now() - 1, Date.now() + 61_000);
  const result = await f.call('/api/auth/email/request', { email: 'person@unit.test' }, { ip: '192.0.2.7' });
  assert.equal(result.status, 429); assert.ok(result.body.retryAfter > 60); assert.equal(f.sent.length, 5);
});

test('email auth: verify IP limits apply even to unknown challenges', async () => {
  const f = fixture(), id = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 32 }, () => f.verify(id, '000000')));
  assert.equal(results.filter(result => result.status === 400).length, 30);
  assert.equal(results.filter(result => result.status === 429).length, 2);
  assert.equal(f.identityCalls.length, 0);
});

test('email auth: Firebase outage never grants a token or allows a consumed code to replay', async () => {
  const f = fixture({ firebaseFailure: true }), issued = await f.request('person@unit.test');
  const result = await f.verify(issued.body.challengeId);
  assert.equal(result.status, 503); assert.equal(result.body.customToken, undefined);
  assert.ok(!JSON.stringify(result.body).includes('provider-sensitive'));
  assert.equal((await f.verify(issued.body.challengeId)).status, 400);
});

test('email auth: stalled sending times out and invalidates the challenge', async () => {
  const f = fixture(); f.env.EMAIL.send = message => { f.sent.push(message); return new Promise(() => {}); };
  const started = Date.now(), result = await f.request('person@unit.test');
  assert.equal(result.status, 503); assert.ok(Date.now() - started < 9000);
  const row = f.sqlite.prepare('SELECT * FROM auth_otp').get();
  assert.equal(row.ready, 0); assert.ok(row.invalidated_at);
  assert.equal((await f.verify(row.id)).status, 400);
});

test('email auth: stalled request-body stream is bounded and its reader is cancelled', async () => {
  const f = fixture(); let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
  const request = new Request('https://worker.unit.test/api/auth/email/request', { method: 'POST', duplex: 'half', body,
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.20' },
  });
  const started = Date.now(), result = await handleEmailAuth(request, f.env);
  assert.equal(result.status, 503); assert.ok(Date.now() - started < 8000);
  assert.equal(cancelled, true); assert.equal(f.sent.length, 0);
});

test('email auth: standalone migration and boot schema create the same tables/indexes', async () => {
  const f = fixture(), other = new DatabaseSync(':memory:');
  other.exec(await readFile(new URL('../migrations/0020_email_auth.sql', import.meta.url), 'utf8'));
  const schema = db => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'auth_%' OR name LIKE 'idx_auth_%' ORDER BY name").all().map(row => ({ ...row, sql: row.sql.replace(/\s+/g, ' ').trim() }));
  assert.deepEqual(schema(f.sqlite), schema(other));
});
