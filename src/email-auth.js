import { importPKCS8, SignJWT } from 'jose';
import { onboardingPolicy } from './onboarding.js';

/* Numeric email OTP -> Firebase custom authentication, never a second UID store.
 * Secrets: FIREBASE_SERVICE_ACCOUNT_JSON, AUTH_OTP_PEPPER (>=32 UTF-8 bytes),
 * RESEND_API_KEY (unless EMAIL binding is configured). Var: AUTH_EMAIL_FROM.
 * EMAIL is Cloudflare Email Sending's structured send_email binding, not an
 * inbound email event. Its sender domain must be verified for outbound sending.
 * Missing credentials fail closed. No development bypass or OTP logging.
 * https://firebase.google.com/docs/auth/admin/create-custom-tokens
 * https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */
export const EMAIL_AUTH_SQL = [
  `CREATE TABLE IF NOT EXISTS auth_otp (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    email_key TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
    ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0, 1)),
    consumed_at INTEGER,
    invalidated_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_otp_email ON auth_otp(email_key)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_otp_expiry ON auth_otp(expires_at)`,
  `CREATE TABLE IF NOT EXISTS auth_rate (
    k TEXT PRIMARY KEY,
    window_end INTEGER NOT NULL,
    count INTEGER NOT NULL CHECK(count > 0)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_rate_expiry ON auth_rate(window_end)`,
];

const encoder = new TextEncoder();
const OTP_TTL = 600_000, RESEND_MS = 60_000, MAX_ATTEMPTS = 5;
const BODY_LIMIT = 2048, UPSTREAM_LIMIT = 64 * 1024, REQUEST_BUDGET = 24_000;
const CUSTOM_AUD = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const oauthCache = new WeakMap();
/* ส่งรหัสผ่าน Gmail ของทีม (Gmail API · สิทธิ์ gmail.send อย่างเดียว) — ไม่ต้องมีโดเมนอีเมลของตัวเอง
   ต้องมี secret ครบ 3 ตัว: GMAIL_CLIENT_ID · GMAIL_CLIENT_SECRET · GMAIL_REFRESH_TOKEN และ AUTH_EMAIL_FROM = อีเมล Gmail นั้น */
const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const gmailCache = new WeakMap();
const gmailReady = env => ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'].every(k => typeof env[k] === 'string' && env[k].trim().length > 0);

class AuthFailure extends Error {
  constructor(status, code, message, retryAfter) {
    super(message); this.status = status; this.code = code; this.retryAfter = retryAfter;
  }
}
const unavailable = () => new AuthFailure(503, 'auth/unavailable', 'Email sign-in is temporarily unavailable. Please use another sign-in method.');
const invalidCode = () => new AuthFailure(400, 'auth/invalid-code', 'This code is incorrect, expired, or already used. Request a new code if needed.');

function emailOf(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) return null;
  const local = email.slice(0, email.indexOf('@'));
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') ? email : null;
}

function response(data, status, request, env, extra = {}) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.AUTH_ALLOWED_ORIGINS || env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const corsOrigin = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : '';
  return Response.json(data, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Vary': 'Origin',
    ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
    ...extra,
  } });
}

function checkOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.AUTH_ALLOWED_ORIGINS || env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  if (origin && !allowed.includes('*') && !allowed.includes(origin)) {
    throw new AuthFailure(403, 'auth/forbidden', 'This sign-in request is not allowed.');
  }
}

function limited(promise, timeoutMs, onTimeout) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => { onTimeout?.(); reject(unavailable()); }, Math.max(1, timeoutMs));
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function readJSONBody(body, maxBytes, signal) {
  if (!body) throw new AuthFailure(400, 'auth/invalid-request', 'A JSON request is required.');
  const reader = body.getReader();
  const cancel = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks = []; let length = 0;
  try {
    if (signal?.aborted) throw unavailable();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new AuthFailure(413, 'auth/request-too-large', 'This request is too large.');
      chunks.push(value);
    }
    const all = new Uint8Array(length); let at = 0;
    for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength; }
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed;
  } catch (error) {
    reader.cancel().catch(() => {});
    if (error instanceof AuthFailure) throw error;
    throw new AuthFailure(400, 'auth/invalid-request', 'A valid JSON request is required.');
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
}

async function requestJSON(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new AuthFailure(415, 'auth/invalid-request', 'Use an application/json request.');
  }
  if (Number(request.headers.get('Content-Length') || 0) > BODY_LIMIT) {
    throw new AuthFailure(413, 'auth/request-too-large', 'This request is too large.');
  }
  const controller = new AbortController();
  return limited(readJSONBody(request.body, BODY_LIMIT, controller.signal), 5000, () => controller.abort());
}

/* บัญชีบริการ Firebase (ใช้สร้างผู้ใช้จากอีเมล และลบผู้ใช้ตอนลบบัญชีถาวร) — ตั้งไม่ครบหรือผิดรูป = null */
async function serviceConfig(env) {
  try {
    if (typeof env.FIREBASE_SERVICE_ACCOUNT_JSON !== 'string') return null;
    const service = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (service.type !== 'service_account' || !/^[a-z][a-z0-9-]{4,62}$/.test(env.FIREBASE_PROJECT_ID || '') || service.project_id !== env.FIREBASE_PROJECT_ID ||
        typeof service.client_email !== 'string' || !/^[a-z0-9._-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(service.client_email) ||
        !service.client_email.endsWith(`@${env.FIREBASE_PROJECT_ID}.iam.gserviceaccount.com`) ||
        typeof service.private_key !== 'string' || !service.private_key.includes('-----BEGIN PRIVATE KEY-----')) return null;
    const signingKey = await importPKCS8(service.private_key, 'RS256');
    const bits = signingKey.algorithm?.modulusLength || signingKey.asymmetricKeyDetails?.modulusLength;
    if (!Number.isInteger(bits) || bits < 2048) return null;
    return { service, signingKey, project: env.FIREBASE_PROJECT_ID };
  } catch { return null; }
}

/* ลบผู้ใช้ออกจาก Firebase Authentication ฝั่งเซิร์ฟเวอร์ (ผู้ใช้กดลบบัญชีถาวร)
   true = ลบแล้วหรือไม่มีอยู่แล้ว · false = ยังไม่ได้ตั้งบัญชีบริการ หรือเรียกไม่สำเร็จ (หน้าเว็บจะลบเองต่อ) */
export async function deleteFirebaseUser(env, uid) {
  try {
    const config = await serviceConfig(env);
    if (!config || typeof uid !== 'string' || !uid || uid.length > 128) return false;
    const deadline = Date.now() + 12_000;
    const access = await googleAccessToken(env, config, deadline);
    const result = await fetchJSON(`https://identitytoolkit.googleapis.com/v1/projects/${config.project}/accounts:delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` }, body: JSON.stringify({ localId: uid }),
    }, deadline);
    return result.ok || result.data?.error?.message === 'USER_NOT_FOUND';
  } catch { return false; }
}

async function configuration(env) {
  try {
    if (!env.DB?.prepare || !env.DB?.batch || typeof env.AUTH_OTP_PEPPER !== 'string' || encoder.encode(env.AUTH_OTP_PEPPER).length < 32) return null;
    const from = emailOf(env.AUTH_EMAIL_FROM);
    if (!from || (typeof env.EMAIL?.send !== 'function' && !gmailReady(env) && !(typeof env.RESEND_API_KEY === 'string' && env.RESEND_API_KEY.trim()))) return null;
    if (typeof env.FIREBASE_SERVICE_ACCOUNT_JSON !== 'string') return null;
    const service = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (service.type !== 'service_account' || !/^[a-z][a-z0-9-]{4,62}$/.test(env.FIREBASE_PROJECT_ID || '') || service.project_id !== env.FIREBASE_PROJECT_ID ||
        typeof service.client_email !== 'string' || !/^[a-z0-9._-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(service.client_email) ||
        !service.client_email.endsWith(`@${env.FIREBASE_PROJECT_ID}.iam.gserviceaccount.com`) ||
        typeof service.private_key !== 'string' || !service.private_key.includes('-----BEGIN PRIVATE KEY-----')) return null;
    const signingKey = await importPKCS8(service.private_key, 'RS256');
    const bits = signingKey.algorithm?.modulusLength || signingKey.asymmetricKeyDetails?.modulusLength;
    if (!Number.isInteger(bits) || bits < 2048) return null;
    const pepperKey = await crypto.subtle.importKey('raw', encoder.encode(env.AUTH_OTP_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return { from, service, signingKey, pepperKey, project: env.FIREBASE_PROJECT_ID };
  } catch { return null; }
}

async function hmac(config, text) {
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', config.pepperKey, encoder.encode(text)));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== 64 || b.length !== 64) return false;
  let different = 0;
  for (let i = 0; i < 64; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

function randomCode() {
  // Rejection sampling avoids modulo bias; leading zeroes are deliberately valid.
  const max = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while (value[0] >= max);
  return String(value[0] % 1_000_000).padStart(6, '0');
}

function clientIP(request) {
  // Cloudflare overwrites this header at its edge. Never trust X-Forwarded-For.
  const ip = request.headers.get('CF-Connecting-IP') || '';
  return /^[0-9a-f:.]{3,64}$/i.test(ip) ? ip.toLowerCase() : 'unknown';
}

async function rate(env, config, scope, subject, windowMs, maximum) {
  const now = Date.now(), key = await hmac(config, `rate\n${scope}\n${subject}`);
  const row = await env.DB.prepare(`INSERT INTO auth_rate (k, window_end, count) VALUES (?, ?, 1)
    ON CONFLICT(k) DO UPDATE SET
      count = CASE WHEN auth_rate.window_end <= ? THEN 1 ELSE auth_rate.count + 1 END,
      window_end = CASE WHEN auth_rate.window_end <= ? THEN excluded.window_end ELSE auth_rate.window_end END
    WHERE auth_rate.window_end <= ? OR auth_rate.count < ?
    RETURNING count, window_end`).bind(key, now + windowMs, now, now, now, maximum).first();
  if (!row) {
    const current = await env.DB.prepare('SELECT window_end FROM auth_rate WHERE k = ?').bind(key).first();
    const seconds = Math.max(1, Math.ceil(((current?.window_end || now + windowMs) - now) / 1000));
    throw new AuthFailure(429, 'auth/rate-limited', 'Too many attempts. Please try again later.', seconds);
  }
}

async function fetchJSON(url, init, deadline) {
  const controller = new AbortController();
  const remaining = Math.min(6000, deadline - Date.now());
  if (remaining <= 0) throw unavailable();
  try {
    return await limited((async () => {
      const result = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
      const data = await readJSONBody(result.body, UPSTREAM_LIMIT, controller.signal);
      return { ok: result.ok, status: result.status, data };
    })(), remaining, () => controller.abort());
  } catch { throw unavailable(); }
  finally { controller.abort(); }
}

const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const utf8b64 = text => b64(new TextEncoder().encode(text));
/* ข้อความอีเมลแบบ MIME (ข้อความ + HTML) · ทุกหัวข้อเข้ารหัส UTF-8 · ผู้รับผ่าน emailOf แล้ว จึงไม่มีขึ้นบรรทัดแทรกหัวอีเมล */
function mimeMessage(from, to, subject, text, html) {
  const boundary = 'cendon-' + crypto.randomUUID(), wrap = s => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
  return [`From: =?UTF-8?B?${utf8b64('Cendon')}?= <${from}>`, `To: <${to}>`, `Subject: =?UTF-8?B?${utf8b64(subject)}?=`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(utf8b64(text)),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(utf8b64(html)),
    `--${boundary}--`, ''].join('\r\n');
}
async function gmailAccessToken(env, deadline) {
  const cached = gmailCache.get(env);
  if (cached?.credential === env.GMAIL_REFRESH_TOKEN && cached.expires > Date.now() + 60_000) return cached.token;
  const result = await fetchJSON(OAUTH_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.GMAIL_CLIENT_ID.trim(), client_secret: env.GMAIL_CLIENT_SECRET.trim(), refresh_token: env.GMAIL_REFRESH_TOKEN.trim() }).toString(),
  }, deadline);
  if (!result.ok || typeof result.data.access_token !== 'string' || !result.data.access_token || !Number.isFinite(Number(result.data.expires_in)) || Number(result.data.expires_in) <= 60) throw unavailable();
  gmailCache.set(env, { token: result.data.access_token, credential: env.GMAIL_REFRESH_TOKEN, expires: Date.now() + Math.min(3600, Number(result.data.expires_in)) * 1000 });
  return result.data.access_token;
}

async function deliver(env, config, email, code, deadline) {
  const subject = `รหัสเข้าสู่ระบบ Cendon: ${code}`;
  const text = `รหัสของคุณ: ${code}\n\nใช้รหัสนี้เพื่อเข้าสู่ระบบ Cendon ภายใน 10 นาที (ใช้ได้ครั้งเดียว)\nห้ามบอกรหัสนี้กับใคร รวมถึงผู้ที่อ้างว่าเป็นเจ้าหน้าที่ Cendon\nหากคุณไม่ได้ขอรหัสนี้ ไม่ต้องทำอะไร บัญชีของคุณยังปลอดภัย`;
  const html = `<!doctype html><html lang="th"><body style="margin:0;padding:0;background:#0b0b0c"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0c;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#141416;border:1px solid #2a2a2e;border-radius:18px;font-family:Kanit,'Segoe UI',system-ui,sans-serif;color:#f5f3ef">
<tr><td style="padding:28px 28px 6px;font-size:15px;font-weight:700;letter-spacing:.06em">CENDON</td></tr>
<tr><td style="padding:6px 28px 0;font-size:22px;font-weight:600">รหัสเข้าสู่ระบบของคุณ</td></tr>
<tr><td style="padding:18px 28px"><div style="background:#0b0b0c;border:1px solid #2a2a2e;border-radius:14px;padding:18px 0;text-align:center;font-size:34px;font-weight:600;letter-spacing:10px;color:#ffffff">${code}</div></td></tr>
<tr><td style="padding:0 28px 6px;font-size:14px;line-height:1.7;color:#a29d96">ใช้ได้ภายใน 10 นาที และใช้ได้ครั้งเดียว</td></tr>
<tr><td style="padding:0 28px 26px;font-size:13px;line-height:1.7;color:#77726b">ห้ามบอกรหัสนี้กับใคร รวมถึงผู้ที่อ้างว่าเป็นเจ้าหน้าที่ Cendon · หากคุณไม่ได้ขอรหัสนี้ ไม่ต้องทำอะไร บัญชีของคุณยังปลอดภัย</td></tr>
</table></td></tr></table></body></html>`;
  if (typeof env.EMAIL?.send === 'function') {
    const accepted = await limited(env.EMAIL.send({ from: { email: config.from, name: 'Cendon' }, to: email, subject, text, html }), Math.min(6000, deadline - Date.now()));
    if (!accepted?.messageId) throw unavailable();
    return;
  }
  if (gmailReady(env)) {
    const token = await gmailAccessToken(env, deadline);
    const raw = utf8b64(mimeMessage(config.from, email, subject, text, html)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const result = await fetchJSON(GMAIL_SEND, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ raw }) }, deadline);
    if (!result.ok || typeof result.data.id !== 'string' || !result.data.id) throw unavailable();
    return;
  }
  const result = await fetchJSON('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY.trim()}` },
    body: JSON.stringify({ from: `Cendon <${config.from}>`, to: [email], subject, text, html }),
  }, deadline);
  if (!result.ok || typeof result.data.id !== 'string' || !result.data.id) throw unavailable();
}

async function googleAccessToken(env, config, deadline) {
  const cached = oauthCache.get(env);
  if (cached?.credential === env.FIREBASE_SERVICE_ACCOUNT_JSON && cached.expires > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/identitytoolkit' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).setIssuer(config.service.client_email)
    .setAudience(OAUTH_URL).setIssuedAt(now).setExpirationTime(now + 3000).sign(config.signingKey);
  const result = await fetchJSON(OAUTH_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  }, deadline);
  if (!result.ok || typeof result.data.access_token !== 'string' || !result.data.access_token || !Number.isFinite(Number(result.data.expires_in)) || Number(result.data.expires_in) <= 60) throw unavailable();
  oauthCache.set(env, { token: result.data.access_token, credential: env.FIREBASE_SERVICE_ACCOUNT_JSON, expires: Date.now() + Math.min(3600, Number(result.data.expires_in)) * 1000 });
  return result.data.access_token;
}

async function firebaseUID(env, config, email, deadline) {
  const access = await googleAccessToken(env, config, deadline);
  const base = `https://identitytoolkit.googleapis.com/v1/projects/${config.project}/accounts`;
  const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` }, body: JSON.stringify(body) });
  const lookup = async () => {
    const result = await fetchJSON(base + ':lookup', post({ email: [email] }), deadline);
    if (!result.ok) throw unavailable();
    if (result.data.users !== undefined && !Array.isArray(result.data.users)) throw unavailable();
    const users = result.data.users || [];
    if (users.length > 1) throw unavailable();
    return users[0] || null;
  };
  let user = await lookup();
  if (!user) {
    const id = 'email_' + crypto.randomUUID();
    // This is the same admin endpoint used by firebase-admin, authenticated with
    // service-account OAuth. The project is in the path; no client API key needed.
    const created = await fetchJSON(base, post({ localId: id, email, emailVerified: true }), deadline);
    if (created.ok && created.data.localId === id) user = { localId: id, email, emailVerified: true };
    else if (created.data.error?.message === 'EMAIL_EXISTS') user = await lookup();
    else throw unavailable();
  }
  if (!user || typeof user.localId !== 'string' || !user.localId || user.localId.length > 128 || /[\x00-\x1f\x7f]/.test(user.localId) || emailOf(user.email) !== email) throw unavailable();
  if (user.disabled) throw new AuthFailure(403, 'auth/account-unavailable', 'This account is not available.');
  if (user.emailVerified !== true) {
    // Do not let an OTP attach to a pre-hijacked unverified password/provider
    // account. Its old credentials/sessions would still work after custom login.
    throw new AuthFailure(409, 'auth/account-recovery-required', 'Please use your existing sign-in method to recover this account before using email codes.');
  }
  const local = await env.DB.prepare('SELECT banned FROM users WHERE uid = ?').bind(user.localId).first();
  if (Number(local?.banned)) throw new AuthFailure(403, 'auth/account-unavailable', 'This account is not available.');
  return user.localId;
}

async function requestCode(request, env, config, deadline) {
  const ip = clientIP(request);
  await rate(env, config, 'request-ip-10m', ip, 600_000, 10);
  await rate(env, config, 'request-ip-day', ip, 86_400_000, 60);
  const body = await requestJSON(request), email = emailOf(body.email);
  if (!email) throw new AuthFailure(400, 'auth/invalid-email', 'Enter a valid email address.');
  await rate(env, config, 'request-email-minute', email, RESEND_MS, 1);
  await rate(env, config, 'request-email-hour', email, 3_600_000, 5);
  await rate(env, config, 'request-email-day', email, 86_400_000, 12);
  const id = crypto.randomUUID(), code = randomCode(), now = Date.now();
  const emailKey = await hmac(config, 'email\n' + email);
  const codeHash = await hmac(config, `code\n${id}\n${email}\n${code}`);
  await env.DB.batch([
    env.DB.prepare('UPDATE auth_otp SET invalidated_at = ? WHERE email_key = ? AND consumed_at IS NULL AND invalidated_at IS NULL').bind(now, emailKey),
    env.DB.prepare('INSERT INTO auth_otp (id, email, email_key, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, email, emailKey, codeHash, now, now + OTP_TTL),
    env.DB.prepare('DELETE FROM auth_otp WHERE id IN (SELECT id FROM auth_otp WHERE expires_at < ? LIMIT 100)').bind(now - 86_400_000),
    env.DB.prepare('DELETE FROM auth_rate WHERE k IN (SELECT k FROM auth_rate WHERE window_end < ? LIMIT 100)').bind(now - 86_400_000),
  ]);
  try {
    await deliver(env, config, email, code, deadline);
    const marked = await env.DB.prepare('UPDATE auth_otp SET ready = 1 WHERE id = ? AND invalidated_at IS NULL AND expires_at > ?').bind(id, Date.now()).run();
    if (marked.meta?.changes !== 1) throw unavailable();
  } catch {
    await env.DB.prepare('UPDATE auth_otp SET invalidated_at = ?, ready = 0 WHERE id = ?').bind(Date.now(), id).run();
    throw unavailable();
  }
  return response({ challengeId: id, expiresIn: 600, resendAfter: 60 }, 200, request, env);
}

async function verifyCode(request, env, config, deadline) {
  const ip = clientIP(request);
  await rate(env, config, 'verify-ip-minute', ip, 60_000, 30);
  await rate(env, config, 'verify-ip-hour', ip, 3_600_000, 120);
  const body = await requestJSON(request);
  const id = body.challengeId, code = body.code;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) || typeof code !== 'string' || !/^\d{6}$/.test(code)) throw invalidCode();
  // Reserve an attempt in SQLite itself; concurrent isolates cannot exceed five.
  const attempt = await env.DB.prepare(`UPDATE auth_otp SET attempts = attempts + 1
    WHERE id = ? AND ready = 1 AND consumed_at IS NULL AND invalidated_at IS NULL
      AND expires_at > ? AND attempts < ?
    RETURNING email, code_hash, attempts`).bind(id, Date.now(), MAX_ATTEMPTS).first();
  if (!attempt) throw invalidCode();
  const proposed = await hmac(config, `code\n${id}\n${attempt.email}\n${code}`);
  if (!sameHash(proposed, attempt.code_hash)) throw invalidCode();
  // Consume before any identity API/signing call. Only one successful contender
  // may get a custom token; an upstream outage requires a fresh OTP, not replay.
  const consumed = await env.DB.prepare(`UPDATE auth_otp SET consumed_at = ?
    WHERE id = ? AND ready = 1 AND consumed_at IS NULL AND invalidated_at IS NULL
      AND expires_at > ? AND attempts <= ?`).bind(Date.now(), id, Date.now(), MAX_ATTEMPTS).run();
  if (consumed.meta?.changes !== 1) throw invalidCode();
  const uid = await firebaseUID(env, config, attempt.email, deadline);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ uid })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).setIssuer(config.service.client_email)
    .setSubject(config.service.client_email).setAudience(CUSTOM_AUD)
    .setIssuedAt(now).setExpirationTime(now + 300).sign(config.signingKey);
  return response({ customToken: token }, 200, request, env);
}

export async function handleEmailAuth(request, env) {
  const path = new URL(request.url).pathname;
  if (!['/api/auth/config', '/api/auth/email/request', '/api/auth/email/verify'].includes(path)) return null;
  try {
    checkOrigin(request, env);
    const method = path === '/api/auth/config' ? 'GET' : 'POST';
    if (request.method !== method) return response({ error: 'Method not allowed.', code: 'auth/method-not-allowed' }, 405, request, env, { Allow: method });
    const config = await configuration(env);
    if (path === '/api/auth/config') {const policy=onboardingPolicy(env);return response({ emailOtpReady: !!config, appleAuthReady:env.AUTH_APPLE_ENABLED==='1', otpLength: 6, onboardingReady:policy.enabled,privacyUrl:policy.privacyUrl }, 200, request, env);}
    if (!config) throw unavailable();
    const deadline = Date.now() + REQUEST_BUDGET;
    return path.endsWith('/request') ? await requestCode(request, env, config, deadline) : await verifyCode(request, env, config, deadline);
  } catch (error) {
    const safe = error instanceof AuthFailure ? error : unavailable();
    return response({ error: safe.message, code: safe.code, ...(safe.retryAfter ? { retryAfter: safe.retryAfter } : {}) }, safe.status, request, env,
      safe.retryAfter ? { 'Retry-After': String(safe.retryAfter) } : {});
  }
}
