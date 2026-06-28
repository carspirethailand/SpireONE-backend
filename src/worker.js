import { verifyFirebaseToken } from './auth.js';

const ADMINS = ["anapatmaliwong@gmail.com", "carspirethailand@gmail.com"];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * Extracts and verifies the Firebase Bearer token from the request.
 * @param {Request} request - HTTP Request
 * @param {object} env - Cloudflare Worker env
 * @returns {Promise<object>} Parsed JWT payload
 */
async function getAuthenticatedUser(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }
  const token = authHeader.split('Bearer ')[1];
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new Error('FIREBASE_PROJECT_ID environment variable is not configured');
  }
  return await verifyFirebaseToken(token, projectId);
}

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
        let payload;
        try {
          payload = await getAuthenticatedUser(request, env);
        } catch (authErr) {
          return jsonResponse({ error: 'Invalid authentication token: ' + authErr.message }, 401);
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
        let payload;
        try {
          payload = await getAuthenticatedUser(request, env);
        } catch (authErr) {
          return jsonResponse({ error: 'Invalid authentication token: ' + authErr.message }, 401);
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

    // Route: GET /api/cars
    if (url.pathname === '/api/cars' && request.method === 'GET') {
      try {
        let payload;
        try {
          payload = await getAuthenticatedUser(request, env);
        } catch (authErr) {
          return jsonResponse({ error: 'Invalid authentication token: ' + authErr.message }, 401);
        }

        const uid = payload.sub;
        if (!env.DB) {
          return jsonResponse({ error: 'D1 Database connection is not configured' }, 500);
        }

        const { results } = await env.DB.prepare(`
          SELECT * FROM cars WHERE uid = ? ORDER BY created_at DESC
        `).bind(uid).all();

        return jsonResponse(results);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Route: POST /api/cars
    if (url.pathname === '/api/cars' && request.method === 'POST') {
      try {
        let payload;
        try {
          payload = await getAuthenticatedUser(request, env);
        } catch (authErr) {
          return jsonResponse({ error: 'Invalid authentication token: ' + authErr.message }, 401);
        }

        const uid = payload.sub;
        if (!env.DB) {
          return jsonResponse({ error: 'D1 Database connection is not configured' }, 500);
        }

        let bodyData;
        try {
          bodyData = await request.json();
        } catch (e) {
          return jsonResponse({ error: 'Invalid JSON request body' }, 400);
        }

        const { id, make, model, year, mileage } = bodyData;
        if (!make || !model) {
          return jsonResponse({ error: 'Missing required fields: make, model' }, 400);
        }

        const carId = id || 'c' + Date.now();
        const carYear = year || '';
        const carMileage = mileage || '';
        const now = Date.now();

        // Upsert car in D1, checking that the user owns the car if updating
        await env.DB.prepare(`
          INSERT INTO cars (id, uid, make, model, year, mileage, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            make = excluded.make,
            model = excluded.model,
            year = excluded.year,
            mileage = excluded.mileage
          WHERE cars.uid = excluded.uid
        `).bind(carId, uid, make, model, carYear, carMileage, now).run();

        return jsonResponse({
          id: carId,
          uid,
          make,
          model,
          year: carYear,
          mileage: carMileage,
          created_at: now
        });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Route: DELETE /api/cars/:id
    if (url.pathname.startsWith('/api/cars/') && request.method === 'DELETE') {
      try {
        let payload;
        try {
          payload = await getAuthenticatedUser(request, env);
        } catch (authErr) {
          return jsonResponse({ error: 'Invalid authentication token: ' + authErr.message }, 401);
        }

        const uid = payload.sub;
        if (!env.DB) {
          return jsonResponse({ error: 'D1 Database connection is not configured' }, 500);
        }

        const parts = url.pathname.split('/');
        const carId = parts[parts.length - 1];
        if (!carId) {
          return jsonResponse({ error: 'Missing car ID' }, 400);
        }

        const result = await env.DB.prepare(`
          DELETE FROM cars WHERE id = ? AND uid = ?
        `).bind(carId, uid).run();

        if (result.meta && result.meta.changes === 0) {
          return jsonResponse({ error: 'Car not found or unauthorized' }, 404);
        }

        return jsonResponse({ success: true, message: 'Car removed successfully' });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    return jsonResponse({ error: 'Not Found' }, 404);
  }
};