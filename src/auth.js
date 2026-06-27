import * as jose from 'jose';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken-system@system.gserviceaccount.com';
const JWKS = jose.createRemoteJWKSet(new URL(JWKS_URL));

/**
 * Verifies a Firebase ID token (JWT).
 * @param {string} token - The raw JWT token string.
 * @param {string} firebaseProjectId - The Firebase Project ID.
 * @returns {Promise<object|null>} The parsed JWT payload if valid, otherwise null.
 */
export async function verifyFirebaseToken(token, firebaseProjectId) {
  if (!token) return null;
  
  try {
    const { payload } = await jose.jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${firebaseProjectId}`,
      audience: firebaseProjectId,
    });
    return payload;
  } catch (err) {
    console.error('Firebase token verification error:', err);
    return null;
  }
}
