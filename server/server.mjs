// Local host adapter: serves the static app and maps node:http onto the shared route table.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, sqliteStore } from '../lib/store-sqlite.mjs';
import { handle } from '../lib/routes.mjs';
import { makeRateLimiter, MAX_BODY_BYTES, fail } from '../lib/core.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const STATIC = /^(app\/[a-zA-Z0-9.-]+|fonts\/[a-zA-Z0-9.-]+\.woff2|karats-pdf-libs\/[a-zA-Z0-9.-]+\.js|Karats-Elite-Plan-Brochure-source\.html|Karats-Smart-Capital-Calculator\.html|sw\.js|manifest\.webmanifest)$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

export function makeServer(db = openDatabase()) {
  const store = sqliteStore(db);
  const limiter = makeRateLimiter();
  const sweep = setInterval(() => { limiter.sweep(); store.sweepSessions(Date.now()); }, 60000);
  sweep.unref();

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost');

      if (!url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'Method not allowed');
        const name = url.pathname === '/' ? 'app/index.html' : decodeURIComponent(url.pathname.slice(1));
        if (!STATIC.test(name)) fail(404, 'Not found');
        const bytes = await readFile(resolve(root, name)).catch(() => fail(404, 'Not found'));
        res.writeHead(200, { 'Content-Type': TYPES[extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : bytes);
        return;
      }

      if (req.method !== 'GET') {
        const origin = process.env.APP_ORIGIN || `http://${req.headers.host}`;
        if (req.headers.origin !== origin || req.headers['x-karats-request'] !== '1') fail(403, 'Request origin is not allowed');
      }

      let body = {};
      if (['POST', 'PUT'].includes(req.method)) {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > MAX_BODY_BYTES) fail(413, 'Request too large'); }
        try { body = JSON.parse(raw || '{}'); } catch { fail(400, 'Invalid JSON'); }
        if (!body || Array.isArray(body) || typeof body !== 'object') fail(400, 'Invalid request');
      }

      // First-run setup is offered only to a browser on this machine, never once an account exists.
      const localSetup = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
        && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')
        && !process.env.APP_ORIGIN;

      const result = await handle({
        method: req.method,
        path: url.pathname.replace(/^\/api/, ''),
        query: Object.fromEntries(url.searchParams),
        body,
        token: /(?:^|;\s*)karats_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1] || '',
        clientId: req.socket.remoteAddress || ''
      }, { store, limiter, setupAvailable: async () => localSetup && !(await store.hasAnyUser()) });

      if (result.cookie) {
        const secure = process.env.APP_ORIGIN?.startsWith('https:') ? '; Secure' : '';
        res.setHeader('Set-Cookie', `karats_session=${result.cookie.value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${result.cookie.maxAge}${secure}`);
      }
      send(result.status, result.body);
    } catch (error) {
      if (!error.status) console.error(error);
      if (res.headersSent) { res.end(); return; }
      send(error.status || 500, error.status ? { error: error.message, ...(error.extra || {}) } : { error: 'The server could not complete this request' });
    }
  });
  server.on('close', () => clearInterval(sweep));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  makeServer().listen(port, process.env.HOST || '127.0.0.1', () => console.log(`KARATS workspace: http://localhost:${port}`));
}
