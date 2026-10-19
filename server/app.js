// Node shell around the shared core: turns Node HTTP requests into web Requests, serves static files from
// /public, and supplies the Node-only pieces (DNS lookups for the webhook guard, PNG QR images).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import dns from 'node:dns/promises';
import QRCode from 'qrcode';
import { createCore, PAGE_CSP } from './core.js';
import { wrapSync } from './dbadapter.js';
import { MIME } from './util.js';

async function renderQr({ data, size, fg, bg, format }) {
  const opts = { errorCorrectionLevel: 'H', margin: 2, width: size, color: { dark: fg, light: bg } };
  if (format === 'svg') return { body: await QRCode.toString(data, { ...opts, type: 'svg' }), type: 'image/svg+xml' };
  return { body: await QRCode.toBuffer(data, { ...opts, type: 'png' }), type: 'image/png' };
}

const resolveHost = async (hostname) => (await dns.lookup(hostname, { all: true })).map((a) => a.address);

/** db: a local libsql database, or asyncDb: an already-async facade (for Turso). One of the two is needed. */
export function createApp({ db, asyncDb, config }) {
  const publicDir = resolve(config.publicDir);
  const core = createCore({ db: asyncDb || wrapSync(db), config: { ...config, resolveHost, renderQr } });

  function clientIp(req) {
    if (config.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (xff) return String(xff).split(',')[0].trim();
    }
    return req.socket.remoteAddress || '';
  }

  function toRequest(req) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else if (v !== undefined) headers.set(k, v);
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    return new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
      method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half',
    });
  }

  async function write(res, response, method) {
    const headers = {};
    for (const [k, v] of response.headers) if (k !== 'set-cookie') headers[k] = v;
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length) headers['set-cookie'] = setCookies;
    res.writeHead(response.status, headers);
    if (method === 'HEAD' || !response.body) return res.end();
    return res.end(Buffer.from(await response.arrayBuffer()));
  }

  /* ------------------------------ static files ---------------------------- */

  async function serveStatic(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) return false;
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return false; }
    if (rel.includes('\0')) return false;
    const candidates = rel.endsWith('/') ? [`${rel}index.html`] : [rel, `${rel}.html`];
    for (const cand of candidates) {
      const full = resolve(join(publicDir, normalize(cand)));
      if (full !== publicDir && !full.startsWith(publicDir + sep)) continue;
      try {
        const st = await stat(full);
        if (!st.isFile()) continue;
        const ext = extname(full).toLowerCase();
        const isHtml = ext === '.html';
        const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
        const headers = {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          // Code and markup revalidate (cheap 304s via ETag) so deploys show up immediately; media can be cached.
          'Cache-Control': ['.html', '.js', '.css', '.json'].includes(ext) ? 'no-cache' : 'public, max-age=3600',
          ETag: etag, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
          ...(isHtml ? { 'Content-Security-Policy': PAGE_CSP, 'X-Frame-Options': 'DENY' } : {}),
        };
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
        res.writeHead(200, { ...headers, 'Content-Length': st.size });
        if (req.method === 'HEAD') { res.end(); return true; }
        res.end(await readFile(full));
        return true;
      } catch { /* try next candidate */ }
    }
    return false;
  }

  /* -------------------------------- server -------------------------------- */

  // Runs after the response has been sent, so a QR scan never waits for its own bookkeeping.
  const defer = (fn) => setImmediate(() => { Promise.resolve().then(fn).catch((err) => console.error('Deferred task failed:', err?.message)); });

  return createServer(async (req, res) => {
    try {
      let request;
      try { request = toRequest(req); } catch { res.writeHead(400); return res.end('Bad request'); }
      const url = new URL(request.url);

      const response = await core.handle(request, { ip: clientIp(req), defer });
      if (response) return await write(res, response, req.method);

      if (await serveStatic(req, res, url)) return undefined;
      try {
        const body = await readFile(join(publicDir, '404.html'));
        res.writeHead(404, { 'Content-Type': MIME['.html'], 'Content-Security-Policy': PAGE_CSP, 'X-Content-Type-Options': 'nosniff' });
        return res.end(body);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
    } catch (err) {
      console.error(err);
      if (res.headersSent) return res.end();
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
}
