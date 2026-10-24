import * as jose from 'jose';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const JWKS = jose.createRemoteJWKSet(new URL(JWKS_URL));
const PROJECT = /^[a-z][a-z0-9-]{4,62}$/;

/**
 * โปรเจกต์ Firebase ที่ยอมรับ token: ตัวหลัก (FIREBASE_PROJECT_ID) + ตัวเก่าช่วงย้ายโปรเจกต์ (FIREBASE_LEGACY_PROJECT_IDS คั่นด้วยจุลภาค)
 * ย้ายผู้ใช้ครบแล้วให้ลบ FIREBASE_LEGACY_PROJECT_IDS ออก — token ของโปรเจกต์เก่าจะใช้ไม่ได้ทันที
 * @param {object} env
 * @returns {string[]}
 */
export function firebaseProjects(env) {
  const all = [env.FIREBASE_PROJECT_ID, ...String(env.FIREBASE_LEGACY_PROJECT_IDS || '').split(',')]
    .map(s => String(s || '').trim()).filter(s => PROJECT.test(s));
  return [...new Set(all)];
}

/**
 * Verifies a Firebase ID token (JWT).
 * @param {string} token - The raw JWT token string.
 * @param {string|string[]} firebaseProjectId - Firebase project ID, or the list of accepted project IDs.
 * @returns {Promise<object>} The parsed JWT payload if valid (throws otherwise).
 */
export async function verifyFirebaseToken(token, firebaseProjectId) {
  if (!token) {
    throw new Error('Token is empty');
  }
  const allowed = (Array.isArray(firebaseProjectId) ? firebaseProjectId : [firebaseProjectId]).filter(Boolean);
  if (!allowed.length) throw new Error('FIREBASE_PROJECT_ID is not configured');
  /* อ่าน aud แบบยังไม่ตรวจลายเซ็น เพื่อเลือกว่าจะตรวจกับโปรเจกต์ไหน — ไม่อยู่ในรายการ = ปฏิเสธ (ตรวจลายเซ็นจริงด้านล่างเสมอ) */
  let project = allowed[0];
  if (allowed.length > 1) {
    let aud = '';
    try { aud = String(jose.decodeJwt(token).aud || ''); } catch (e) { throw new Error('Token is malformed'); }
    if (!allowed.includes(aud)) throw new Error('Token is for another project');
    project = aud;
  }
  const { payload } = await jose.jwtVerify(token, JWKS, {
    algorithms: ['RS256'],
    issuer: `https://securetoken.google.com/${project}`,
    audience: project,
    clockTolerance: 120, // 2 minutes clock skew tolerance
  });
  if(typeof payload.sub!=='string'||!payload.sub||payload.sub.length>128)throw new Error('Invalid subject');
  return payload;
}

// Local synthetic identities must remain impossible on production, even if a
// DEV_AUTH variable is accidentally copied into the deployed environment.
export function localTestIdentity(request,env,token){
  const host=new URL(request.url).hostname;
  const local=host==='test'||host.endsWith('.test')||['localhost','127.0.0.1','[::1]'].includes(host);
  if(env.DEV_AUTH!=='1'||!local||!/(?:^|-)test$/.test(String(env.FIREBASE_PROJECT_ID))||!token.startsWith('dev:'))return null;
  const match=/^dev:([^:]{1,128}):([^:\s]+@[^:\s]+)$/.exec(token);if(!match)throw new Error('Invalid test identity');
  return {sub:match[1],email:match[2],email_verified:true,name:match[2].split('@')[0]};
}
