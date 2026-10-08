import * as jose from 'jose';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const JWKS = jose.createRemoteJWKSet(new URL(JWKS_URL));

/**
 * Verifies a Firebase ID token (JWT).
 * @param {string} token - The raw JWT token string.
 * @param {string} firebaseProjectId - The Firebase Project ID.
 * @returns {Promise<object|null>} The parsed JWT payload if valid, otherwise null.
 */
export async function verifyFirebaseToken(token, firebaseProjectId) {
  if (!token) {
    throw new Error('Token is empty');
  }
  
  const { payload } = await jose.jwtVerify(token, JWKS, {
    issuer: `https://securetoken.google.com/${firebaseProjectId}`,
    audience: firebaseProjectId,
    clockTolerance: 120, // 2 minutes clock skew tolerance
  });
  return payload;
}

/* ── custom token ของ Firebase (ใช้กับการเข้าสู่ระบบด้วย LINE) ──
   Firebase ไม่มี LINE เป็นผู้ให้บริการล็อกอินในตัว เราตรวจกับ LINE เองแล้วออกโทเคนนี้
   ให้หน้าเว็บเรียก signInWithCustomToken — ต้องเซ็นด้วยกุญแจ service account ของโปรเจกต์ Firebase
   FIREBASE_SA_EMAIL = client_email · FIREBASE_SA_KEY = private_key (ทั้งก้อน -----BEGIN PRIVATE KEY----- …) */
const CUSTOM_AUD = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
let saKey = null, saKeySrc = '';
export async function firebaseCustomToken(env, uid, claims = {}) {
  const email = env.FIREBASE_SA_EMAIL, pem = String(env.FIREBASE_SA_KEY || '').replace(/\\n/g, '\n');
  if (!email || !pem) throw new Error('ยังไม่ได้ตั้ง service account ของ Firebase');
  if (!saKey || saKeySrc !== pem) { saKey = await jose.importPKCS8(pem, 'RS256'); saKeySrc = pem; }
  const now = Math.floor(Date.now() / 1000);
  return await new jose.SignJWT({ uid, claims })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(email).setSubject(email).setAudience(CUSTOM_AUD)
    .setIssuedAt(now).setExpirationTime(now + 3600)
    .sign(saKey);
}
