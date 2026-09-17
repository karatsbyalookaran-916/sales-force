// Hosted adapter: maps the Vercel request/response onto the shared route table.
import { PrismaClient, Prisma } from '@prisma/client';
import { prismaStore } from '../lib/store-prisma.mjs';
import { handle } from '../lib/routes.mjs';
import { fail } from '../lib/core.mjs';

// Reused across invocations on a warm instance so each request does not open a new pool.
const prisma = globalThis.karatsPrisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalThis.karatsPrisma = prisma;

const store = prismaStore(prisma, Prisma);

function routeFor(req) {
  const raw = Array.isArray(req.query?.route) ? req.query.route.join('/') : req.query?.route;
  return '/' + String(raw || req.url?.split('/api/')[1]?.split('?')[0] || '').replace(/^\/+/, '');
}
function cookie(req, name) {
  return new RegExp(`(?:^|;\s*)${name}=([^;]+)`).exec(req.headers.cookie || '')?.[1] || '';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  try {
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.headers.origin;
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (!origin || new URL(origin).host !== host || req.headers['x-karats-request'] !== '1') fail(403, 'Request origin is not allowed');
    }
    let body = {};
    if (req.body !== undefined && req.body !== null) {
      try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body; }
      catch { fail(400, 'Invalid JSON'); }
      if (!body || Array.isArray(body) || typeof body !== 'object') fail(400, 'Invalid request');
    }

    const result = await handle({
      method: req.method,
      path: routeFor(req),
      query: req.query || {},
      body,
      token: cookie(req, 'karats_session'),
      clientId: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
      authorization: req.headers.authorization || ''
    }, {
      store,
      setupAvailable: () => store.hasAdminLock().then(locked => !locked),
      cronSecret: process.env.CRON_SECRET
    });

    if (result.cookie) {
      res.setHeader('Set-Cookie', `karats_session=${result.cookie.value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${result.cookie.maxAge}`);
    }
    res.status(result.status).json(result.body);
  } catch (error) {
    if (!error.status) console.error(error);
    res.status(error.status || 500).json(error.status
      ? { error: error.message, ...(error.extra || {}) }
      : { error: 'The server could not complete this request' });
  }
}
