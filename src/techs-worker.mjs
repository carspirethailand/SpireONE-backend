import { verifyFirebaseToken } from './auth.js';
import { marketplace } from './techs-api.mjs';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : '',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    };
    if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:cors});
    const response = await marketplace(request, env, async () => {
      const token = /^Bearer (.+)$/i.exec(request.headers.get('Authorization') || '')?.[1];
      if (!token) throw Object.assign(new Error('กรุณาเข้าสู่ระบบ'), {status:401});
      let payload;
      try { payload = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID); }
      catch { throw Object.assign(new Error('การเข้าสู่ระบบหมดอายุ กรุณาเข้าสู่ระบบใหม่'), {status:401}); }
      const row = await env.DB.prepare('SELECT role, banned FROM users WHERE uid = ?').bind(payload.sub).first();
      if (row?.banned) throw Object.assign(new Error('บัญชีถูกระงับ'), {status:403});
      const owner = payload.email_verified === true && (env.OWNERS || '').toLowerCase().split(',').map(x=>x.trim()).includes((payload.email || '').toLowerCase());
      return {uid:payload.sub, name:payload.name || '', admin:owner || row?.role === 'admin' || row?.role === 'owner'};
    });
    for (const [key,value] of Object.entries(cors)) response.headers.set(key,value);
    return response;
  }
};
