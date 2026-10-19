import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, resolve, sep } from 'node:path';
import QRCode from 'qrcode';
import {
  sha256, token, shortCode, hashPassword, verifyPassword, escapeHtml, cleanUrl,
  assertPublicHost, parseUA, refHost, rateLimiter, MIME,
} from './util.js';
import { newSecret, verifyTotp, otpauthUrl, newRecoveryCodes, normalizeRecovery } from './totp.js';
import { encrypt, decrypt } from './vault.js';
import { validatePassword } from './password.js';

const SESSION_DAYS = 30;
const TICKET_MINUTES = 5;
const TICKET_MAX_ATTEMPTS = 5;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60_000;
const MAX_LINKS_PER_USER = 1000;
const COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country', 'x-appengine-country'];

export function createApp({ db, config }) {
  const publicDir = resolve(config.publicDir);
  const authLimit = rateLimiter({ windowMs: 60_000, max: config.authLimitPerMinute ?? 15 });   // per IP; sign-in and sensitive actions
  const unlockLimit = rateLimiter({ windowMs: 10 * 60_000, max: 10 });
  const apiLimit = rateLimiter({ windowMs: 60_000, max: 120 });

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    insertUser: db.prepare('INSERT INTO users (email, name, pass_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?)'),
    setPassword: db.prepare('UPDATE users SET pass_hash = ?, password_changed_at = ? WHERE id = ?'),
    setTotpPending: db.prepare('UPDATE users SET totp_secret_enc = ?, totp_enabled = 0, totp_last_step = 0, recovery_hashes = NULL WHERE id = ?'),
    setTotpEnabled: db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ?, recovery_hashes = ? WHERE id = ?'),
    setTotpStep: db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?'),
    setRecovery: db.prepare('UPDATE users SET recovery_hashes = ? WHERE id = ?'),
    clearTotp: db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, totp_last_step = 0, recovery_hashes = NULL WHERE id = ?'),
    insertTicket: db.prepare('INSERT INTO login_tickets (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    ticketByHash: db.prepare('SELECT * FROM login_tickets WHERE token_hash = ?'),
    bumpTicket: db.prepare('UPDATE login_tickets SET attempts = attempts + 1 WHERE token_hash = ?'),
    delTicket: db.prepare('DELETE FROM login_tickets WHERE token_hash = ?'),
    purgeTickets: db.prepare('DELETE FROM login_tickets WHERE expires_at < ?'),
    delOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    delAllSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    countSessions: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?'),
    insertEvent: db.prepare('INSERT INTO events (user_id, ts, type, detail) VALUES (?, ?, ?, ?)'),
    recentEvents: db.prepare('SELECT ts, type, detail FROM events WHERE user_id = ? ORDER BY ts DESC, id DESC LIMIT 15'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByKey: db.prepare('SELECT * FROM users WHERE api_key_hash = ?'),
    setKey: db.prepare('UPDATE users SET api_key_hash = ?, api_key_hint = ? WHERE id = ?'),
    setBrand: db.prepare('UPDATE users SET brand_json = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, user_agent) VALUES (?, ?, ?, ?, ?)'),
    sessionByHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    linkByCode: db.prepare('SELECT * FROM links WHERE code = ?'),
    linkByIdUser: db.prepare('SELECT * FROM links WHERE id = ? AND user_id = ?'),
    linksByUser: db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM scans s WHERE s.link_id = l.id) AS scan_count
                             FROM links l WHERE l.user_id = ? ORDER BY l.created_at DESC`),
    countLinks: db.prepare('SELECT COUNT(*) AS n FROM links WHERE user_id = ?'),
    insertLink: db.prepare(`INSERT INTO links (user_id, code, kind, name, dest_url, page_json, pass_hash, expires_at, max_scans, active, webhook_url, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`),
    updateLink: db.prepare(`UPDATE links SET name=?, dest_url=?, page_json=?, pass_hash=?, expires_at=?, max_scans=?, active=?, webhook_url=?, updated_at=? WHERE id=?`),
    deleteLink: db.prepare('DELETE FROM links WHERE id = ?'),
    insertScan: db.prepare('INSERT INTO scans (link_id, ts, device, browser, os, country, referrer, ip_hash) VALUES (?,?,?,?,?,?,?,?)'),
    scanCount: db.prepare('SELECT COUNT(*) AS n FROM scans WHERE link_id = ?'),
  };

  /* ------------------------------ helpers ------------------------------ */

  const baseUrl = (req) => config.baseUrl || `${config.secureCookies ? 'https' : 'http'}://${req.headers.host}`;

  function clientIp(req) {
    if (config.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (xff) return String(xff).split(',')[0].trim();
    }
    return req.socket.remoteAddress || '';
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      ...headers,
    });
    res.end(body);
  }
  const json = (res, status, obj, headers = {}) =>
    send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  const html = (res, status, body, headers = {}) =>
    send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...pageCsp, ...headers });

  const pageCsp = {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
      // connect-src needs data:/blob: because the QR library reads uploaded logos back as data URLs.
      "img-src 'self' data: blob: https:; connect-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };

  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const bad = (msg) => new HttpError(400, msg);

  async function readBody(req, limit = 1_000_000) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, 'Request body too large');
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  async function readJson(req, limit) {
    const type = String(req.headers['content-type'] || '');
    if (!type.includes('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
    const raw = await readBody(req, limit);
    try { return raw ? JSON.parse(raw) : {}; } catch { throw bad('Invalid JSON'); }
  }

  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  // The __Host- prefix makes browsers refuse the cookie unless it is Secure, host-only and Path=/.
  const SID = config.secureCookies ? '__Host-qrf_sid' : 'qrf_sid';
  const sessionCookie = (value, maxAge) =>
    `${SID}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;

  function authenticate(req) {
    const authz = String(req.headers.authorization || '');
    if (authz.startsWith('Bearer ')) {
      const user = q.userByKey.get(sha256(authz.slice(7).trim()));
      return user ? { user, via: 'key' } : null;
    }
    const sid = cookies(req)[SID];
    if (!sid) return null;
    const sessionHash = sha256(sid);
    const row = q.sessionByHash.get(sessionHash);
    if (!row || row.expires_at < Date.now()) return null;
    const user = q.userById.get(row.user_id);
    return user ? { user, via: 'session', sessionHash } : null;
  }

  /* ---------------------- sign-in protection & security log ---------------------- */

  // Failed sign-ins are counted per email address, whether or not the account exists, so lockouts
  // never reveal which emails are registered. Counters are in memory (single-process deployment).
  const fails = new Map();
  const lockedFor = (key) => { const r = fails.get(key); return r && r.until > Date.now() ? r.until - Date.now() : 0; };
  function recordFail(key) {
    const r = fails.get(key) || { n: 0, until: 0 };
    r.n += 1;
    if (r.n >= LOGIN_MAX_FAILS) { r.until = Date.now() + LOGIN_LOCK_MS; r.n = 0; }
    fails.set(key, r);
    if (fails.size > 10_000) for (const [k, v] of fails) if (v.until < Date.now() && v.n === 0) fails.delete(k);
  }
  const lockMessage = (ms) => `Too many failed attempts. Try again in ${Math.max(1, Math.ceil(ms / 60_000))} minute(s).`;

  function logEvent(userId, type, req, extra = '') {
    const ua = parseUA(req?.headers?.['user-agent']);
    const detail = `${ua.browser} on ${ua.os}${extra ? `, ${extra}` : ''}`;
    q.insertEvent.run(userId, Date.now(), type, detail);
  }

  /** Accept a 6-digit authenticator code or a single-use recovery code. Returns 'totp', 'recovery' or null. */
  function checkSecondFactor(user, input) {
    const raw = String(input ?? '').trim();
    if (/^\d{3}\s?\d{3}$/.test(raw) && user.totp_secret_enc) {
      const step = verifyTotp(decrypt(user.totp_secret_enc, config.secret), raw, { lastStep: user.totp_last_step });
      if (step !== null) { q.setTotpStep.run(step, user.id); return 'totp'; }
      return null;
    }
    const norm = normalizeRecovery(raw);
    if (norm.length === 10 && user.recovery_hashes) {
      const hashes = JSON.parse(user.recovery_hashes);
      const h = sha256(norm);
      const i = hashes.indexOf(h);
      if (i >= 0) { hashes.splice(i, 1); q.setRecovery.run(JSON.stringify(hashes), user.id); return 'recovery'; }
    }
    return null;
  }

  const recoveryLeft = (u) => (u.recovery_hashes ? JSON.parse(u.recovery_hashes).length : 0);
  const hashRecovery = (codes) => JSON.stringify(codes.map((c) => sha256(normalizeRecovery(c))));

  function requireAuth(req) {
    const a = authenticate(req);
    if (!a) throw new HttpError(401, 'Authentication required');
    if (a.via === 'session' && !['GET', 'HEAD'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let ok = false;
        try { ok = new URL(origin).host === req.headers.host; } catch { /* invalid origin */ }
        if (!ok) throw new HttpError(403, 'Cross-origin request blocked');
      }
    }
    return a;
  }

  const publicUser = (u) => ({
    id: u.id, email: u.email, name: u.name || '', apiKeyHint: u.api_key_hint || null,
    twoFactor: !!u.totp_enabled, createdAt: u.created_at,
  });

  function publicLink(l, req) {
    const base = baseUrl(req);
    return {
      id: l.id, code: l.code, kind: l.kind, name: l.name,
      shortUrl: `${base}/${l.kind === 'page' ? 'p' : 'r'}/${l.code}`,
      destUrl: l.dest_url, page: l.page_json ? JSON.parse(l.page_json) : null,
      hasPassword: !!l.pass_hash, expiresAt: l.expires_at, maxScans: l.max_scans,
      active: !!l.active, webhookUrl: l.webhook_url,
      scans: l.scan_count ?? q.scanCount.get(l.id).n,
      createdAt: l.created_at, updatedAt: l.updated_at,
    };
  }

  /* ----------------------------- validation ----------------------------- */

  const HEX = /^#[0-9a-fA-F]{6}$/;

  function validatePage(p) {
    if (!p || typeof p !== 'object') throw bad('page is required');
    const str = (v, max) => String(v ?? '').trim().slice(0, max);
    const links = Array.isArray(p.links) ? p.links.slice(0, 20) : [];
    const out = {
      title: str(p.title, 80), bio: str(p.bio, 300),
      accent: HEX.test(p.accent || '') ? p.accent : '#5258e4',
      avatar: p.avatar ? cleanUrl(p.avatar) : null,
      links: links.map((l) => {
        const url = cleanUrl(l?.url);
        const label = str(l?.label, 60);
        if (!url || !label) throw bad('Each page link needs a label and a valid http(s) URL');
        return { label, url };
      }),
    };
    if (!out.title) throw bad('Page title is required');
    return out;
  }

  function sameHostLoop(req, url) {
    try {
      const u = new URL(url);
      return u.host === req.headers.host && /^\/(r|p)\//.test(u.pathname);
    } catch { return false; }
  }

  async function validateLinkInput(req, body, existing = null) {
    const kind = existing ? existing.kind : (body.kind === 'page' ? 'page' : 'link');
    const next = {
      name: existing?.name, dest_url: existing?.dest_url ?? null, page_json: existing?.page_json ?? null,
      pass_hash: existing?.pass_hash ?? null, expires_at: existing?.expires_at ?? null,
      max_scans: existing?.max_scans ?? null, active: existing ? existing.active : 1,
      webhook_url: existing?.webhook_url ?? null,
    };
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

    if (kind === 'link') {
      if (has('destUrl') || !existing) {
        const url = cleanUrl(body.destUrl);
        if (!url) throw bad('destUrl must be a valid http(s) URL');
        if (sameHostLoop(req, url)) throw bad('destUrl cannot point back to this service');
        next.dest_url = url;
      }
      if (has('password')) {
        if (body.password === null || body.password === '') next.pass_hash = null;
        else {
          const pw = String(body.password);
          if (pw.length < 4 || pw.length > 100) throw bad('password must be 4-100 characters');
          next.pass_hash = hashPassword(pw);
        }
      }
    } else if (has('page') || !existing) {
      next.page_json = JSON.stringify(validatePage(body.page));
    }

    if (has('name') || !existing) {
      const name = String(body.name ?? '').trim().slice(0, 100);
      next.name = name || (kind === 'link' ? new URL(next.dest_url).hostname : JSON.parse(next.page_json).title);
    }
    if (has('expiresAt')) {
      if (body.expiresAt === null || body.expiresAt === '') next.expires_at = null;
      else {
        const t = typeof body.expiresAt === 'number' ? body.expiresAt : Date.parse(body.expiresAt);
        if (!Number.isFinite(t)) throw bad('expiresAt is not a valid date');
        next.expires_at = Math.round(t);
      }
    }
    if (has('maxScans')) {
      if (body.maxScans === null || body.maxScans === '') next.max_scans = null;
      else {
        const n = Number(body.maxScans);
        if (!Number.isInteger(n) || n < 1 || n > 10_000_000) throw bad('maxScans must be a positive integer');
        next.max_scans = n;
      }
    }
    if (has('active')) next.active = body.active ? 1 : 0;
    if (has('webhookUrl')) {
      if (!body.webhookUrl) next.webhook_url = null;
      else {
        const w = cleanUrl(body.webhookUrl);
        if (!w || !w.startsWith('https://')) throw bad('webhookUrl must be a valid https URL');
        try { await assertPublicHost(w); } catch { throw bad('webhookUrl must resolve to a public address'); }
        next.webhook_url = w;
      }
    }
    return { kind, next };
  }

  /* ------------------------------ scan logic ----------------------------- */

  function linkState(l) {
    if (!l.active) return 'paused';
    if (l.expires_at && l.expires_at < Date.now()) return 'expired';
    if (l.max_scans && q.scanCount.get(l.id).n >= l.max_scans) return 'limit';
    return 'ok';
  }

  function recordScan(l, req) {
    const ua = parseUA(req.headers['user-agent']);
    if (ua.device === 'Bot') return;
    const country = COUNTRY_HEADERS.map((h) => req.headers[h]).find((v) => v && v !== 'XX' && v !== 'T1') || 'Unknown';
    const day = new Date().toISOString().slice(0, 10);
    const scan = {
      ts: Date.now(), device: ua.device, browser: ua.browser, os: ua.os,
      country: String(country).slice(0, 2).toUpperCase() === country ? country : String(country).slice(0, 40),
      referrer: refHost(req.headers.referer), ipHash: sha256(`${config.secret}|${clientIp(req)}|${day}`).slice(0, 16),
    };
    q.insertScan.run(l.id, scan.ts, scan.device, scan.browser, scan.os, scan.country, scan.referrer, scan.ipHash);
    if (l.webhook_url) fireWebhook(l, scan);
  }

  // Counting a scan is a database write (a network round trip with Turso). Do it after the response has been
  // sent so a QR scan never waits for it, and never let a failed write take the server down.
  function recordScanLater(l, req) {
    setImmediate(() => {
      try { recordScan(l, req); } catch (err) { console.error('Could not record scan:', err.message); }
    });
  }

  async function fireWebhook(l, scan) {
    try {
      await assertPublicHost(l.webhook_url);
      await fetch(l.webhook_url, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(4000),
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'QRForge-Webhook/1' },
        body: JSON.stringify({
          event: 'scan', link: { code: l.code, name: l.name, destUrl: l.dest_url },
          scan: { time: new Date(scan.ts).toISOString(), device: scan.device, os: scan.os, browser: scan.browser, country: scan.country, referrer: scan.referrer },
        }),
      });
    } catch { /* webhooks are best effort */ }
  }

  /* ------------------------------- pages -------------------------------- */

  const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><link rel="stylesheet" href="/css/app.css"></head>
<body class="plain"><main class="notice">${body}</main></body></html>`;

  const noticePage = (res, status, title, msg) =>
    html(res, status, shell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(msg)}</p><p><a class="btn" href="/">Go to QRForge</a></p>`));

  function passwordPage(res, code, error) {
    html(res, 200, shell('Password required', `<h1>Password required</h1><p>This link is protected.</p>
      ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="/r/${escapeHtml(code)}">
        <label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="off" required autofocus>
        <button class="btn" type="submit" style="margin-top:12px">Continue</button></form>`));
  }

  function renderLanding(l) {
    const p = JSON.parse(l.page_json);
    const accent = HEX.test(p.accent) ? p.accent : '#5258e4';
    const links = p.links.map((x) => `<a class="pg-link" href="${escapeHtml(x.url)}" rel="noopener noreferrer nofollow">${escapeHtml(x.label)}</a>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(p.title)}</title>
<style>
body{margin:0;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:${accent}14;color:#1c1c1c;min-height:100vh;display:grid;place-items:start center;padding:40px 16px}
.pg{width:100%;max-width:460px;text-align:center}
.pg img{width:96px;height:96px;border-radius:50%;object-fit:cover;border:3px solid ${accent}}
h1{margin:14px 0 6px;font-size:1.5rem}p{margin:0 0 22px;color:#555}
.pg-link{display:block;margin:10px 0;padding:14px 18px;border-radius:999px;background:${accent};color:#fff;text-decoration:none;font-weight:600}
.pg-link:hover{filter:brightness(1.08)}.f{margin-top:28px;font-size:.8rem;color:#777}
</style></head><body><main class="pg">
${p.avatar ? `<img src="${escapeHtml(p.avatar)}" alt="" referrerpolicy="no-referrer">` : ''}
<h1>${escapeHtml(p.title)}</h1>${p.bio ? `<p>${escapeHtml(p.bio)}</p>` : ''}${links}
<div class="f">Made with QRForge</div></main></body></html>`;
  }

  /* ------------------------------- routes -------------------------------- */

  async function handleApi(req, res, url) {
    const path = url.pathname.replace(/^\/api\/v1\//, '/api/');
    const m = req.method;
    const ip = clientIp(req);

    if (!apiLimit(`api:${ip}`)) throw new HttpError(429, 'Too many requests');

    if (path === '/api/health' && m === 'GET') return json(res, 200, { ok: true });

    // ---- auth
    if (path === '/api/auth/signup' && m === 'POST') {
      if (!authLimit(`auth:${ip}`)) throw new HttpError(429, 'Too many attempts, try again in a minute');
      const b = await readJson(req);
      if (b.website) throw bad('Could not create the account.');            // honeypot field: humans never fill it
      const email = String(b.email || '').trim().toLowerCase();
      const name = String(b.name || '').replace(/\s+/g, ' ').trim();
      const password = String(b.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) throw bad('Enter a valid email address');
      if (name.length < 2 || name.length > 80 || /[\u0000-\u001f<>]/.test(name)) throw bad('Enter your name (2 to 80 characters).');
      if (b.acceptTerms !== true) throw bad('Please accept the Terms and the Privacy policy to continue.');
      const weak = validatePassword(password, { email, name });
      if (weak) throw bad(weak);
      if (q.userByEmail.get(email)) throw new HttpError(409, 'An account with this email already exists');
      const now = Date.now();
      const info = q.insertUser.run(email, name, hashPassword(password), now, now);
      const created = q.userById.get(Number(info.lastInsertRowid));
      logEvent(created.id, 'account_created', req);
      return startSession(res, created, 201, req);
    }
    if (path === '/api/auth/login' && m === 'POST') {
      if (!authLimit(`auth:${ip}`)) throw new HttpError(429, 'Too many attempts, try again in a minute');
      const b = await readJson(req);
      const email = String(b.email || '').trim().toLowerCase();
      const key = `login:${email}`;
      const wait = lockedFor(key);
      if (wait) throw new HttpError(429, lockMessage(wait));
      const user = q.userByEmail.get(email);
      const ok = verifyPassword(String(b.password || ''), user ? user.pass_hash : DUMMY_HASH);
      if (!user || !ok) {
        recordFail(key);
        if (user) logEvent(user.id, 'login_failed', req);
        throw new HttpError(401, 'Incorrect email or password');
      }
      if (user.totp_enabled) {
        // Password was right; require the second factor before any session exists.
        q.purgeTickets.run(Date.now());
        const ticket = token();
        q.insertTicket.run(sha256(ticket), user.id, Date.now() + TICKET_MINUTES * 60_000);
        return json(res, 200, { needs2fa: true, ticket });
      }
      fails.delete(key);
      logEvent(user.id, 'login', req);
      return startSession(res, user, 200, req);
    }
    if (path === '/api/auth/2fa' && m === 'POST') {
      if (!authLimit(`auth:${ip}`)) throw new HttpError(429, 'Too many attempts, try again in a minute');
      const b = await readJson(req);
      const hash = sha256(String(b.ticket || ''));
      const t = q.ticketByHash.get(hash);
      if (!t || t.expires_at < Date.now()) throw new HttpError(401, 'Your sign-in expired. Please start again.');
      if (t.attempts >= TICKET_MAX_ATTEMPTS) { q.delTicket.run(hash); throw new HttpError(429, 'Too many incorrect codes. Please sign in again.'); }
      const user = q.userById.get(t.user_id);
      const method = user ? checkSecondFactor(user, b.code) : null;
      if (!method) {
        q.bumpTicket.run(hash);
        if (user) logEvent(user.id, 'second_factor_failed', req);
        throw new HttpError(401, 'That code is not correct. Check your authenticator app and try again.');
      }
      q.delTicket.run(hash);
      fails.delete(`login:${user.email}`);
      logEvent(user.id, 'login', req, method === 'recovery' ? 'used a recovery code' : '2-step verified');
      return startSession(res, user, 200, req, method === 'recovery' ? { recoveryLeft: recoveryLeft(q.userById.get(user.id)) } : {});
    }
    if (path === '/api/auth/logout' && m === 'POST') {
      const sid = cookies(req)[SID];
      if (sid) q.delSession.run(sha256(sid));
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }

    // ---- everything below needs auth
    if (path === '/api/me' && m === 'GET') {
      const a = authenticate(req);
      return json(res, 200, { user: a ? publicUser(a.user) : null });
    }
    const a = requireAuth(req);
    const user = a.user;

    // ---- account security (browser sessions only; API keys can never change credentials)
    if (path.startsWith('/api/me/') && /^\/api\/me\/(security|password|2fa\/|sessions\/)/.test(path)) {
      if (a.via !== 'session') throw new HttpError(403, 'Manage account security from the dashboard');

      const reauth = (body) => {
        if (!authLimit(`reauth:${user.id}`)) throw new HttpError(429, 'Too many attempts, try again in a minute');
        if (!verifyPassword(String(body.password || ''), user.pass_hash)) {
          logEvent(user.id, 'reauth_failed', req);
          throw new HttpError(403, 'Incorrect password');
        }
      };

      if (path === '/api/me/security' && m === 'GET') {
        return json(res, 200, {
          twoFactor: !!user.totp_enabled, recoveryLeft: recoveryLeft(user),
          sessions: q.countSessions.get(user.id, Date.now()).n,
          passwordChangedAt: user.password_changed_at || null,
          events: q.recentEvents.all(user.id),
        });
      }

      if (path === '/api/me/password' && m === 'POST') {
        const b = await readJson(req);
        reauth({ password: b.current });
        const weak = validatePassword(String(b.next || ''), { email: user.email, name: user.name });
        if (weak) throw bad(weak);
        if (String(b.next) === String(b.current)) throw bad('Choose a password you have not used just now.');
        q.setPassword.run(hashPassword(String(b.next)), Date.now(), user.id);
        q.delOtherSessions.run(user.id, a.sessionHash);        // a stolen session cannot outlive a password change
        logEvent(user.id, 'password_changed', req);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/me/sessions/revoke-others' && m === 'POST') {
        q.delOtherSessions.run(user.id, a.sessionHash);
        logEvent(user.id, 'other_sessions_revoked', req);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/me/2fa/setup' && m === 'POST') {
        if (user.totp_enabled) throw new HttpError(409, 'Two-factor authentication is already on.');
        const secret = newSecret();
        q.setTotpPending.run(encrypt(secret, config.secret), user.id);
        return json(res, 200, { secret, otpauthUrl: otpauthUrl({ secret, account: user.email }) });
      }

      if (path === '/api/me/2fa/enable' && m === 'POST') {
        const b = await readJson(req);
        if (!authLimit(`reauth:${user.id}`)) throw new HttpError(429, 'Too many attempts, try again in a minute');
        if (user.totp_enabled || !user.totp_secret_enc) throw bad('Start the setup first.');
        const step = verifyTotp(decrypt(user.totp_secret_enc, config.secret), b.code, {});
        if (step === null) throw bad('That code is not correct. Check the time on your phone and try again.');
        const codes = newRecoveryCodes(10);
        q.setTotpEnabled.run(step, hashRecovery(codes), user.id);
        logEvent(user.id, 'two_factor_enabled', req);
        return json(res, 200, { recoveryCodes: codes });
      }

      if (path === '/api/me/2fa/recovery' && m === 'POST') {
        const b = await readJson(req);
        if (!user.totp_enabled) throw bad('Two-factor authentication is off.');
        reauth(b);
        if (checkSecondFactor(user, b.code) !== 'totp') throw bad('Enter the 6-digit code from your authenticator app.');
        const codes = newRecoveryCodes(10);
        q.setRecovery.run(hashRecovery(codes), user.id);
        logEvent(user.id, 'recovery_codes_regenerated', req);
        return json(res, 200, { recoveryCodes: codes });
      }

      if (path === '/api/me/2fa/disable' && m === 'POST') {
        const b = await readJson(req);
        if (!user.totp_enabled) throw bad('Two-factor authentication is already off.');
        reauth(b);
        if (!checkSecondFactor(user, b.code)) throw bad('Enter a current authenticator code or an unused recovery code.');
        q.clearTotp.run(user.id);
        q.delOtherSessions.run(user.id, a.sessionHash);
        logEvent(user.id, 'two_factor_disabled', req);
        return json(res, 200, { ok: true });
      }
    }

    if (path === '/api/me/apikey' && m === 'POST') {
      if (a.via !== 'session') throw new HttpError(403, 'Manage API keys from the dashboard');
      const key = `qrf_live_${token(24)}`;
      q.setKey.run(sha256(key), key.slice(-4), user.id);
      return json(res, 200, { apiKey: key, hint: key.slice(-4) });
    }
    if (path === '/api/me/apikey' && m === 'DELETE') {
      q.setKey.run(null, null, user.id);
      return json(res, 200, { ok: true });
    }

    if (path === '/api/brand' && m === 'GET') {
      return json(res, 200, { brand: user.brand_json ? JSON.parse(user.brand_json) : null });
    }
    if (path === '/api/brand' && m === 'PUT') {
      const b = await readJson(req, 4_500_000);
      if (!Array.isArray(b.kits) || b.kits.length > 20) throw bad('kits must be an array of up to 20 items');
      const raw = JSON.stringify({ kits: b.kits });
      if (raw.length > 4_000_000) throw bad('Brand kit is too large');
      q.setBrand.run(raw, user.id);
      return json(res, 200, { ok: true });
    }

    if (path === '/api/qr' && m === 'GET') return qrImage(res, url);

    if (path === '/api/links' && m === 'GET') {
      return json(res, 200, { links: q.linksByUser.all(user.id).map((l) => publicLink(l, req)) });
    }
    if (path === '/api/links' && m === 'POST') {
      if (q.countLinks.get(user.id).n >= MAX_LINKS_PER_USER) throw new HttpError(403, 'Link limit reached');
      const body = await readJson(req, 200_000);
      const { kind, next } = await validateLinkInput(req, body);
      let code;
      for (let i = 0; i < 5; i++) {
        code = shortCode(7);
        if (!q.linkByCode.get(code)) break;
        code = null;
      }
      if (!code) throw new HttpError(500, 'Could not allocate a short code');
      const now = Date.now();
      const info = q.insertLink.run(user.id, code, kind, next.name, next.dest_url, next.page_json, next.pass_hash,
        next.expires_at, next.max_scans, next.webhook_url, now, now);
      return json(res, 201, { link: publicLink(q.linkByIdUser.get(Number(info.lastInsertRowid), user.id), req) });
    }

    const lm = path.match(/^\/api\/links\/(\d+)(?:\/(stats|export\.csv))?$/);
    if (lm) {
      const link = q.linkByIdUser.get(Number(lm[1]), user.id);
      if (!link) throw new HttpError(404, 'Link not found');
      if (!lm[2] && m === 'GET') return json(res, 200, { link: publicLink(link, req) });
      if (!lm[2] && m === 'PATCH') {
        const body = await readJson(req, 200_000);
        const { next } = await validateLinkInput(req, body, link);
        q.updateLink.run(next.name, next.dest_url, next.page_json, next.pass_hash, next.expires_at, next.max_scans,
          next.active, next.webhook_url, Date.now(), link.id);
        return json(res, 200, { link: publicLink(q.linkByIdUser.get(link.id, user.id), req) });
      }
      if (!lm[2] && m === 'DELETE') {
        q.deleteLink.run(link.id);
        return json(res, 200, { ok: true });
      }
      if (lm[2] === 'stats' && m === 'GET') return json(res, 200, stats(link, Number(url.searchParams.get('days')) || 30));
      if (lm[2] === 'export.csv' && m === 'GET') return exportCsv(res, link);
    }

    throw new HttpError(404, 'Not found');
  }

  const DUMMY_HASH = hashPassword('dummy-password-for-timing');

  function startSession(res, user, status, req, extra = {}) {
    q.purgeSessions.run(Date.now());
    const t = token();
    const now = Date.now();
    q.insertSession.run(sha256(t), user.id, now + SESSION_DAYS * 86_400_000, now, String(req?.headers?.['user-agent'] || '').slice(0, 160));
    return json(res, status, { user: publicUser(q.userById.get(user.id)), ...extra }, { 'Set-Cookie': sessionCookie(t, SESSION_DAYS * 86400) });
  }

  function stats(link, days) {
    days = Math.min(Math.max(days, 1), 365);
    const since = Date.now() - days * 86_400_000;
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    const top = (col) => db.prepare(
      `SELECT COALESCE(${col}, 'Unknown') AS label, COUNT(*) AS n FROM scans WHERE link_id = ? AND ts >= ? GROUP BY label ORDER BY n DESC LIMIT 8`,
    ).all(link.id, since).map((r) => ({ label: r.label, count: r.n }));
    const perDay = new Map(db.prepare(
      `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS d, COUNT(*) AS n FROM scans WHERE link_id = ? AND ts >= ? GROUP BY d`,
    ).all(link.id, since).map((r) => [r.d, r.n]));
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      series.push({ day: d, count: perDay.get(d) || 0 });
    }
    return {
      days,
      total: one('SELECT COUNT(*) AS n FROM scans WHERE link_id = ?', link.id).n,
      inRange: one('SELECT COUNT(*) AS n FROM scans WHERE link_id = ? AND ts >= ?', link.id, since).n,
      uniqueVisitors: one('SELECT COUNT(DISTINCT ip_hash) AS n FROM scans WHERE link_id = ? AND ts >= ?', link.id, since).n,
      series, devices: top('device'), browsers: top('browser'), os: top('os'), countries: top('country'), referrers: top('referrer'),
      recent: db.prepare('SELECT ts, device, os, browser, country, referrer FROM scans WHERE link_id = ? ORDER BY ts DESC LIMIT 15').all(link.id),
    };
  }

  function exportCsv(res, link) {
    const safe = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const rows = db.prepare('SELECT ts, device, os, browser, country, referrer FROM scans WHERE link_id = ? ORDER BY ts DESC LIMIT 100000').all(link.id);
    const out = ['time,device,os,browser,country,referrer',
      ...rows.map((r) => [new Date(r.ts).toISOString(), r.device, r.os, r.browser, r.country, r.referrer].map(safe).join(','))].join('\n');
    send(res, 200, out, {
      'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="scans-${link.code}.csv"`,
    });
  }

  async function qrImage(res, url) {
    const p = url.searchParams;
    const data = p.get('data') || '';
    if (!data || data.length > 2000) throw bad('data is required (max 2000 characters)');
    const size = Math.min(Math.max(parseInt(p.get('size') || '512', 10) || 512, 64), 2048);
    const fg = HEX.test(p.get('fg') || '') ? p.get('fg') : '#000000';
    const bg = HEX.test(p.get('bg') || '') ? p.get('bg') : '#ffffff';
    const opts = { errorCorrectionLevel: 'H', margin: 2, width: size, color: { dark: fg, light: bg } };
    const format = p.get('format') === 'svg' ? 'svg' : 'png';
    if (format === 'svg') {
      const svg = await QRCode.toString(data, { ...opts, type: 'svg' });
      return send(res, 200, svg, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=3600' });
    }
    const buf = await QRCode.toBuffer(data, { ...opts, type: 'png' });
    return send(res, 200, buf, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' });
  }

  async function handleRedirect(req, res, url) {
    const m = url.pathname.match(/^\/(r|p)\/([0-9A-Za-z]{4,16})$/);
    if (!m || !['GET', 'HEAD', 'POST'].includes(req.method)) return false;
    const [, prefix, code] = m;
    const link = q.linkByCode.get(code);
    const expectedKind = prefix === 'p' ? 'page' : 'link';
    if (!link || link.kind !== expectedKind) { noticePage(res, 404, 'Link not found', 'This link does not exist or was removed.'); return true; }

    const state = linkState(link);
    if (state !== 'ok') {
      const msg = { paused: 'This link has been paused by its owner.', expired: 'This link has expired.', limit: 'This link reached its scan limit.' }[state];
      noticePage(res, 410, 'Link unavailable', msg);
      return true;
    }

    if (link.kind === 'page') {
      html(res, 200, renderLanding(link), { 'Cache-Control': 'no-cache' });
      if (req.method === 'GET') recordScanLater(link, req);
      return true;
    }

    if (link.pass_hash) {
      if (req.method !== 'POST') { passwordPage(res, code); return true; }
      if (!unlockLimit(`unlock:${clientIp(req)}:${code}`)) { noticePage(res, 429, 'Too many attempts', 'Please wait a few minutes and try again.'); return true; }
      const form = new URLSearchParams(await readBody(req, 10_000));
      if (!verifyPassword(form.get('password') || '', link.pass_hash)) { passwordPage(res, code, 'Incorrect password.'); return true; }
    } else if (req.method === 'POST') {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true;
    }

    res.writeHead(302, { Location: link.dest_url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
    if (req.method !== 'HEAD') recordScanLater(link, req);       // the visitor is already on their way
    return true;
  }

  /* ------------------------------ static files ---------------------------- */

  async function serveStatic(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) return false;
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return false; }
    if (rel.includes('\0')) return false;
    const candidates = rel.endsWith('/') ? [`${rel}index.html`] : [rel, `${rel}.html`];
    for (const c of candidates) {
      const full = resolve(join(publicDir, normalize(c)));
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
          ...(isHtml ? { ...pageCsp, 'X-Frame-Options': 'DENY' } : {}),
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

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (await handleRedirect(req, res, url)) return;
      if (await serveStatic(req, res, url)) return;
      const nf = join(publicDir, '404.html');
      try {
        const body = await readFile(nf);
        return send(res, 404, body, { 'Content-Type': MIME['.html'], ...pageCsp });
      } catch {
        return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      console.error(err);
      return json(res, 500, { error: 'Internal server error' });
    }
  });

  return server;
}
