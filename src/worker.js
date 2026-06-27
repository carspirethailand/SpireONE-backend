import { verifyFirebaseToken } from './auth.js';

const ADMINS = ["anapatmaliwong@gmail.com", "carspirethailand@gmail.com"];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle CORS preflight request
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Helper for JSON response
    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      });
    };

    // Route: POST /api/login
    if (url.pathname === '/api/login' && request.method === 'POST') {
      try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return jsonResponse({ error: 'Missing or invalid Authorization header' }, 401);
        }
        
        const token = authHeader.split('Bearer ')[1];
        const projectId = env.FIREBASE_PROJECT_ID;
        if (!projectId) {
          return jsonResponse({ error: 'FIREBASE_PROJECT_ID environment variable is not configured' }, 500);
        }

        const payload = await verifyFirebaseToken(token, projectId);
        if (!payload) {
          return jsonResponse({ error: 'Invalid authentication token' }, 401);
        }

        // Get optional body parameters for displayName/photo if token does not contain them
        let bodyData = {};
        try {
          bodyData = await request.json();
        } catch (e) {
          // Ignore if no body
        }

        const uid = payload.sub;
        const email = payload.email;
        const name = bodyData.name || payload.name || email.split('@')[0];
        const photo = bodyData.photo || payload.picture || '';
        const role = ADMINS.includes(email.toLowerCase()) ? 'admin' : 'user';
        const now = Date.now();

        if (!env.DB) {
          return jsonResponse({ error: 'D1 Database connection is not configured' }, 500);
        }

        // Upsert user to D1 database
        await env.DB.prepare(`
          INSERT INTO users (uid, name, email, photo, role, last_login)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(uid) DO UPDATE SET
            name = excluded.name,
            email = excluded.email,
            photo = excluded.photo,
            role = excluded.role,
            last_login = excluded.last_login
        `).bind(uid, name, email, photo, role, now).run();

        return jsonResponse({
          uid,
          name,
          email,
          photo,
          role,
          last_login: now
        });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Route: GET /api/admin/users
    if (url.pathname === '/api/admin/users' && request.method === 'GET') {
      try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return jsonResponse({ error: 'Missing or invalid Authorization header' }, 401);
        }

        const token = authHeader.split('Bearer ')[1];
        const projectId = env.FIREBASE_PROJECT_ID;
        if (!projectId) {
          return jsonResponse({ error: 'FIREBASE_PROJECT_ID environment variable is not configured' }, 500);
        }

        const payload = await verifyFirebaseToken(token, projectId);
        if (!payload) {
          return jsonResponse({ error: 'Invalid authentication token' }, 401);
        }

        const email = payload.email;
        const isAdmin = ADMINS.includes(email.toLowerCase());
        if (!isAdmin) {
          return jsonResponse({ error: 'Forbidden: Admin access required' }, 403);
        }

        if (!env.DB) {
          return jsonResponse({ error: 'D1 Database connection is not configured' }, 500);
        }

        const { results } = await env.DB.prepare(`
          SELECT * FROM users ORDER BY last_login DESC
        `).all();

        return jsonResponse(results);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    return jsonResponse({ error: 'Not Found' }, 404);
  }
};