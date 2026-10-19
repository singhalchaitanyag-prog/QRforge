// Cloudflare Worker entry point. Static files (the generator, landing pages, CSS, JS) are served straight from
// the assets binding; this code only runs for the dynamic routes listed in wrangler.jsonc
// (/api/*, /r/*, /p/*, /healthz). The database is Turso, reached over HTTPS.
import { createClient } from '@libsql/client/web';
import { createCore } from '../server/core.js';
import { wrapClient } from '../server/dbadapter.js';
import { renderQr } from '../server/qrsvg.js';

const REQUIRED = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'APP_SECRET'];
let cached;                                         // reused for as long as this isolate stays warm

function getCore(env) {
  if (cached) return cached;
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing settings: ${missing.join(', ')}`);
  const client = createClient({ url: env.TURSO_DATABASE_URL.replace(/^libsql:/, 'https:'), authToken: env.TURSO_AUTH_TOKEN });
  cached = createCore({
    db: wrapClient(client),
    config: {
      secret: env.APP_SECRET,
      baseUrl: (env.BASE_URL || '').replace(/\/$/, ''),
      secureCookies: env.COOKIE_SECURE !== '0',     // always HTTPS on Cloudflare; only local `wrangler dev` turns this off
      pbkdf2Iterations: Number(env.PBKDF2_ITERATIONS) || undefined,
      renderQr,
    },
  }).handle;
  return cached;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname.startsWith('www.')) {                       // one canonical host
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    let handle;
    try { handle = getCore(env); } catch (err) {
      console.error(err.message);
      return new Response('QRForge is not configured yet.', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    const response = await handle(request, {
      ip: request.headers.get('cf-connecting-ip') || '',          // set by Cloudflare itself; clients cannot forge it
      defer: (fn) => ctx.waitUntil(Promise.resolve().then(fn).catch((err) => console.error('Deferred task failed:', err?.message))),
    });
    return response || env.ASSETS.fetch(request);
  },
};
