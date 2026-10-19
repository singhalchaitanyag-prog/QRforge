// The QRForge application: accounts, sign-in security, dynamic links, scan analytics, landing pages.
// Written against Web standard Request/Response objects and an async database facade, so the same code runs
// in the Node server (server/app.js) and in the Cloudflare Worker (worker/index.js).
import {
  sha256, token, shortCode, hashPassword, verifyPassword, needsRehash, DEFAULT_PBKDF2_ITERATIONS,
  escapeHtml, cleanUrl, assertPublicHost, parseUA, refHost, rateLimiter,
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
const HEX = /^#[0-9a-fA-F]{6}$/;

export const PAGE_CSP =
  "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
  // connect-src needs data:/blob: because the QR library reads uploaded logos back as data URLs.
  "img-src 'self' data: blob: https:; connect-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

/**
 * config: { secret, baseUrl, secureCookies, pbkdf2Iterations, authLimitPerMinute,
 *           resolveHost(hostname) -> addresses, renderQr({data,size,fg,bg,format}) -> {body,type} }
 * handle(request, { ip, defer }) -> Response, or null when the path is not one of ours (the caller serves static files).
 *   ip: the visitor's address as established by the hosting layer. defer(fn): run fn() after the response is on its way.
 */
export function createCore({ db, config }) {
  const iterations = config.pbkdf2Iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const authPerMinute = config.authLimitPerMinute ?? 15;
  const apiLimit = rateLimiter({ windowMs: 60_000, max: 120 });      // cheap best-effort limiter; see util.js

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    insertUser: db.prepare('INSERT INTO users (email, name, pass_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?)'),
    setPassword: db.prepare('UPDATE users SET pass_hash = ?, password_changed_at = ? WHERE id = ?'),
    rehash: db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?'),
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
    countSessions: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?'),
    insertEvent: db.prepare('INSERT INTO events (user_id, ts, type, detail) VALUES (?, ?, ?, ?)'),
    recentEvents: db.prepare('SELECT ts, type, detail FROM events WHERE user_id = ? ORDER BY ts DESC, id DESC LIMIT 15'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByKey: db.prepare('SELECT * FROM users WHERE api_key_hash = ?'),
    setKey: db.prepare('UPDATE users SET api_key_hash = ?, api_key_hint = ? WHERE id = ?'),
    setBrand: db.prepare('UPDATE users SET brand_json = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, user_agent) VALUES (?, ?, ?, ?, ?)'),
    sessionUser: db.prepare('SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    linkByCode: db.prepare('SELECT * FROM links WHERE code = ?'),
    linkByIdUser: db.prepare('SELECT * FROM links WHERE id = ? AND user_id = ?'),
    linksByUser: db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM scans s WHERE s.link_id = l.id) AS scan_count
                             FROM links l WHERE l.user_id = ? ORDER BY l.created_at DESC`),
    countLinks: db.prepare('SELECT COUNT(*) AS n FROM links WHERE user_id = ?'),
    insertLink: db.prepare(`INSERT INTO links (user_id, code, kind, name, dest_url, page_json, pass_hash, expires_at, max_scans, active, webhook_url, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`),
    updateLink: db.prepare('UPDATE links SET name=?, dest_url=?, page_json=?, pass_hash=?, expires_at=?, max_scans=?, active=?, webhook_url=?, updated_at=? WHERE id=?'),
    deleteLink: db.prepare('DELETE FROM links WHERE id = ?'),
    insertScan: db.prepare('INSERT INTO scans (link_id, ts, device, browser, os, country, referrer, ip_hash) VALUES (?,?,?,?,?,?,?,?)'),
    scanCount: db.prepare('SELECT COUNT(*) AS n FROM scans WHERE link_id = ?'),
    throttleGet: db.prepare('SELECT n, window_start, locked_until FROM throttle WHERE key = ?'),
    throttleSet: db.prepare('INSERT OR REPLACE INTO throttle (key, n, window_start, locked_until) VALUES (?, ?, ?, ?)'),
    throttleBump: db.prepare('UPDATE throttle SET n = n + 1 WHERE key = ?'),
    throttleDel: db.prepare('DELETE FROM throttle WHERE key = ?'),
    throttlePurge: db.prepare('DELETE FROM throttle WHERE window_start < ? AND locked_until < ?'),
  };

  /* ------------------------------ responses ------------------------------ */

  const baseHeaders = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' };
  function respond(status, body, headers = {}, cookieList = []) {
    const h = new Headers({ ...baseHeaders, ...headers });
    for (const ck of cookieList) h.append('Set-Cookie', ck);
    return new Response(body, { status, headers: h });
  }
  const json = (status, obj, headers = {}, cookieList = []) =>
    respond(status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }, cookieList);
  const html = (status, body, headers = {}) =>
    respond(status, body, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': PAGE_CSP, ...headers });

  /* ------------------------------ request helpers ------------------------------ */

  const header = (c, name) => c.req.headers.get(name);
  const baseUrl = (c) => config.baseUrl || `${config.secureCookies ? 'https' : 'http'}://${c.url.host}`;

  async function readBody(c, limit = 1_000_000) {
    if (Number(header(c, 'content-length') || 0) > limit) throw new HttpError(413, 'Request body too large');
    const text = await c.req.text();
    if (text.length > limit) throw new HttpError(413, 'Request body too large');
    return text;
  }
  async function readJson(c, limit) {
    if (!String(header(c, 'content-type') || '').includes('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
    const raw = await readBody(c, limit);
    try { return raw ? JSON.parse(raw) : {}; } catch { throw bad('Invalid JSON'); }
  }

  function cookies(c) {
    const out = {};
    for (const part of String(header(c, 'cookie') || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed cookie */ } }
    }
    return out;
  }
  // The __Host- prefix makes browsers refuse the cookie unless it is Secure, host-only and Path=/.
  const SID = config.secureCookies ? '__Host-qrf_sid' : 'qrf_sid';
  const sessionCookie = (value, maxAge) =>
    `${SID}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;

  /* ------------------------------ throttling ------------------------------ */
  // Counters live in the database so limits survive restarts and apply across Worker isolates.
  // Keys are hashed, so no IP address or email address is stored in readable form.

  const keyFor = (kind, value) => `${kind}:${sha256(`${config.secret}|${value}`).slice(0, 24)}`;

  /** Count one attempt; returns false once more than `max` happen inside `windowMs`. */
  async function allow(key, windowMs, max) {
    const now = Date.now();
    const row = await q.throttleGet.get(key);
    if (!row || now - row.window_start > windowMs) { await q.throttleSet.run(key, 1, now, 0); return true; }
    await q.throttleBump.run(key);
    return row.n + 1 <= max;
  }
  async function lockedFor(key) {
    const row = await q.throttleGet.get(key);
    return row && row.locked_until > Date.now() ? row.locked_until - Date.now() : 0;
  }
  async function recordFail(key) {
    const now = Date.now();
    const row = await q.throttleGet.get(key);
    let n = row && now - row.window_start <= LOGIN_LOCK_MS ? row.n + 1 : 1;
    const start = row && now - row.window_start <= LOGIN_LOCK_MS ? row.window_start : now;
    let lockedUntil = 0;
    if (n >= LOGIN_MAX_FAILS) { lockedUntil = now + LOGIN_LOCK_MS; n = 0; }
    await q.throttleSet.run(key, n, start, lockedUntil);
  }
  const lockMessage = (ms) => `Too many failed attempts. Try again in ${Math.max(1, Math.ceil(ms / 60_000))} minute(s).`;
  const authAllowed = (c, scope = 'auth') => allow(keyFor(scope, c.ip), 60_000, authPerMinute);

  /* ------------------------------ sessions & auth ------------------------------ */

  async function authenticate(c) {
    const authz = String(header(c, 'authorization') || '');
    if (authz.startsWith('Bearer ')) {
      const user = await q.userByKey.get(sha256(authz.slice(7).trim()));
      return user ? { user, via: 'key' } : null;
    }
    const sid = cookies(c)[SID];
    if (!sid) return null;
    const sessionHash = sha256(sid);
    const row = await q.sessionUser.get(sessionHash);
    if (!row || row.session_expires < Date.now()) return null;
    return { user: row, via: 'session', sessionHash };
  }

  async function requireAuth(c) {
    const a = await authenticate(c);
    if (!a) throw new HttpError(401, 'Authentication required');
    if (a.via === 'session' && !['GET', 'HEAD'].includes(c.req.method)) {
      const origin = header(c, 'origin');
      if (origin) {
        let ok = false;
        try { ok = new URL(origin).host === c.url.host; } catch { /* invalid origin */ }
        if (!ok) throw new HttpError(403, 'Cross-origin request blocked');
      }
    }
    return a;
  }

  async function logEvent(userId, type, c, extra = '') {
    const ua = parseUA(header(c, 'user-agent') || '');
    await q.insertEvent.run(userId, Date.now(), type, `${ua.browser} on ${ua.os}${extra ? `, ${extra}` : ''}`);
  }

  /** Accept a 6-digit authenticator code or a single-use recovery code. Returns 'totp', 'recovery' or null. */
  async function checkSecondFactor(user, input) {
    const raw = String(input ?? '').trim();
    if (/^\d{3}\s?\d{3}$/.test(raw) && user.totp_secret_enc) {
      const step = verifyTotp(decrypt(user.totp_secret_enc, config.secret), raw, { lastStep: user.totp_last_step });
      if (step !== null) { await q.setTotpStep.run(step, user.id); return 'totp'; }
      return null;
    }
    const norm = normalizeRecovery(raw);
    if (norm.length === 10 && user.recovery_hashes) {
      const hashes = JSON.parse(user.recovery_hashes);
      const i = hashes.indexOf(sha256(norm));
      if (i >= 0) { hashes.splice(i, 1); await q.setRecovery.run(JSON.stringify(hashes), user.id); return 'recovery'; }
    }
    return null;
  }

  const recoveryLeft = (u) => (u.recovery_hashes ? JSON.parse(u.recovery_hashes).length : 0);
  const hashRecovery = (codes) => JSON.stringify(codes.map((x) => sha256(normalizeRecovery(x))));

  const publicUser = (u) => ({
    id: u.id, email: u.email, name: u.name || '', apiKeyHint: u.api_key_hint || null,
    twoFactor: !!u.totp_enabled, createdAt: u.created_at,
  });

  async function publicLink(l, c) {
    return {
      id: l.id, code: l.code, kind: l.kind, name: l.name,
      shortUrl: `${baseUrl(c)}/${l.kind === 'page' ? 'p' : 'r'}/${l.code}`,
      destUrl: l.dest_url, page: l.page_json ? JSON.parse(l.page_json) : null,
      hasPassword: !!l.pass_hash, expiresAt: l.expires_at, maxScans: l.max_scans,
      active: !!l.active, webhookUrl: l.webhook_url,
      scans: l.scan_count ?? (await q.scanCount.get(l.id)).n,
      createdAt: l.created_at, updatedAt: l.updated_at,
    };
  }

  let dummyHash;
  const getDummyHash = async () => (dummyHash ??= await hashPassword('dummy-password-for-timing', iterations));

  async function startSession(user, status, c, extra = {}) {
    await q.purgeSessions.run(Date.now());
    const t = token();
    const now = Date.now();
    await q.insertSession.run(sha256(t), user.id, now + SESSION_DAYS * 86_400_000, now, String(header(c, 'user-agent') || '').slice(0, 160));
    const fresh = await q.userById.get(user.id);
    return json(status, { user: publicUser(fresh), ...extra }, {}, [sessionCookie(t, SESSION_DAYS * 86400)]);
  }

  /* ----------------------------- validation ----------------------------- */

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

  function sameHostLoop(c, url) {
    try {
      const u = new URL(url);
      return u.host === c.url.host && /^\/(r|p)\//.test(u.pathname);
    } catch { return false; }
  }

  async function validateLinkInput(c, body, existing = null) {
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
        if (sameHostLoop(c, url)) throw bad('destUrl cannot point back to this service');
        next.dest_url = url;
      }
      if (has('password')) {
        if (body.password === null || body.password === '') next.pass_hash = null;
        else {
          const pw = String(body.password);
          if (pw.length < 4 || pw.length > 100) throw bad('password must be 4-100 characters');
          next.pass_hash = await hashPassword(pw, iterations);
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
        try { await assertPublicHost(w, config.resolveHost); } catch { throw bad('webhookUrl must resolve to a public address'); }
        next.webhook_url = w;
      }
    }
    return { kind, next };
  }

  /* ------------------------------ scan logic ----------------------------- */

  async function linkState(l) {
    if (!l.active) return 'paused';
    if (l.expires_at && l.expires_at < Date.now()) return 'expired';
    if (l.max_scans && (await q.scanCount.get(l.id)).n >= l.max_scans) return 'limit';
    return 'ok';
  }

  /** Counts one scan. Runs after the visitor has been redirected, and must never throw. */
  async function recordScan(l, c) {
    try {
      const ua = parseUA(header(c, 'user-agent') || '');
      if (ua.device === 'Bot') return;
      const country = COUNTRY_HEADERS.map((h) => header(c, h)).find((v) => v && v !== 'XX' && v !== 'T1') || 'Unknown';
      const day = new Date().toISOString().slice(0, 10);
      const scan = {
        ts: Date.now(), device: ua.device, browser: ua.browser, os: ua.os,
        country: String(country).slice(0, 2).toUpperCase() === country ? country : String(country).slice(0, 40),
        referrer: refHost(header(c, 'referer')), ipHash: sha256(`${config.secret}|${c.ip}|${day}`).slice(0, 16),
      };
      await q.insertScan.run(l.id, scan.ts, scan.device, scan.browser, scan.os, scan.country, scan.referrer, scan.ipHash);
      if (l.webhook_url) await fireWebhook(l, scan);
    } catch (err) {
      console.error('Could not record scan:', err?.message);
    }
  }

  async function fireWebhook(l, scan) {
    try {
      await assertPublicHost(l.webhook_url, config.resolveHost);
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

  const noticePage = (status, title, msg) =>
    html(status, shell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(msg)}</p><p><a class="btn" href="/">Go to QRForge</a></p>`));

  const passwordPage = (code, error) =>
    html(200, shell('Password required', `<h1>Password required</h1><p>This link is protected.</p>
      ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="/r/${escapeHtml(code)}">
        <label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="off" required autofocus>
        <button class="btn" type="submit" style="margin-top:12px">Continue</button></form>`));

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

  /* ---------------------------- analytics & exports ---------------------------- */

  async function stats(link, days) {
    days = Math.min(Math.max(days, 1), 365);
    const since = Date.now() - days * 86_400_000;
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    const top = async (col) => (await db.prepare(
      `SELECT COALESCE(${col}, 'Unknown') AS label, COUNT(*) AS n FROM scans WHERE link_id = ? AND ts >= ? GROUP BY label ORDER BY n DESC LIMIT 8`,
    ).all(link.id, since)).map((r) => ({ label: r.label, count: r.n }));
    const perDay = new Map((await db.prepare(
      `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS d, COUNT(*) AS n FROM scans WHERE link_id = ? AND ts >= ? GROUP BY d`,
    ).all(link.id, since)).map((r) => [r.d, r.n]));
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      series.push({ day: d, count: perDay.get(d) || 0 });
    }
    return {
      days,
      total: (await one('SELECT COUNT(*) AS n FROM scans WHERE link_id = ?', link.id)).n,
      inRange: (await one('SELECT COUNT(*) AS n FROM scans WHERE link_id = ? AND ts >= ?', link.id, since)).n,
      uniqueVisitors: (await one('SELECT COUNT(DISTINCT ip_hash) AS n FROM scans WHERE link_id = ? AND ts >= ?', link.id, since)).n,
      series, devices: await top('device'), browsers: await top('browser'), os: await top('os'),
      countries: await top('country'), referrers: await top('referrer'),
      recent: await db.prepare('SELECT ts, device, os, browser, country, referrer FROM scans WHERE link_id = ? ORDER BY ts DESC LIMIT 15').all(link.id),
    };
  }

  async function exportCsv(link) {
    const safe = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const rows = await db.prepare('SELECT ts, device, os, browser, country, referrer FROM scans WHERE link_id = ? ORDER BY ts DESC LIMIT 100000').all(link.id);
    const out = ['time,device,os,browser,country,referrer',
      ...rows.map((r) => [new Date(r.ts).toISOString(), r.device, r.os, r.browser, r.country, r.referrer].map(safe).join(','))].join('\n');
    return respond(200, out, {
      'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="scans-${link.code}.csv"`,
    });
  }

  async function qrImage(c) {
    const p = c.url.searchParams;
    const data = p.get('data') || '';
    if (!data || data.length > 2000) throw bad('data is required (max 2000 characters)');
    const size = Math.min(Math.max(parseInt(p.get('size') || '512', 10) || 512, 64), 2048);
    const fg = HEX.test(p.get('fg') || '') ? p.get('fg') : '#000000';
    const bg = HEX.test(p.get('bg') || '') ? p.get('bg') : '#ffffff';
    const format = p.get('format') === 'svg' ? 'svg' : 'png';
    if (!config.renderQr) throw new HttpError(501, 'QR images are not available on this deployment');
    let out;
    try { out = await config.renderQr({ data, size, fg, bg, format }); } catch (err) {
      if (err?.unsupported) throw new HttpError(501, err.message);
      throw err;
    }
    return respond(200, out.body, { 'Content-Type': out.type, 'Cache-Control': 'private, max-age=3600' });
  }

  /* ------------------------------- routes -------------------------------- */

  async function handleApi(c) {
    const path = c.url.pathname.replace(/^\/api\/v1\//, '/api/');
    const m = c.req.method;

    if (!apiLimit(`api:${c.ip}`)) throw new HttpError(429, 'Too many requests');

    if (path === '/api/health' && m === 'GET') return json(200, { ok: true });

    // ---- auth
    if (path === '/api/auth/signup' && m === 'POST') {
      if (!(await authAllowed(c))) throw new HttpError(429, 'Too many attempts, try again in a minute');
      const b = await readJson(c);
      if (b.website) throw bad('Could not create the account.');            // honeypot field: humans never fill it
      const email = String(b.email || '').trim().toLowerCase();
      const name = String(b.name || '').replace(/\s+/g, ' ').trim();
      const password = String(b.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) throw bad('Enter a valid email address');
      if (name.length < 2 || name.length > 80 || /[\u0000-\u001f<>]/.test(name)) throw bad('Enter your name (2 to 80 characters).');
      if (b.acceptTerms !== true) throw bad('Please accept the Terms and the Privacy policy to continue.');
      const weak = validatePassword(password, { email, name });
      if (weak) throw bad(weak);
      if (await q.userByEmail.get(email)) throw new HttpError(409, 'An account with this email already exists');
      const now = Date.now();
      const info = await q.insertUser.run(email, name, await hashPassword(password, iterations), now, now);
      const created = await q.userById.get(info.lastInsertRowid);
      await logEvent(created.id, 'account_created', c);
      return startSession(created, 201, c);
    }

    if (path === '/api/auth/login' && m === 'POST') {
      if (!(await authAllowed(c))) throw new HttpError(429, 'Too many attempts, try again in a minute');
      const b = await readJson(c);
      const email = String(b.email || '').trim().toLowerCase();
      const key = keyFor('login', email);
      const wait = await lockedFor(key);
      if (wait) throw new HttpError(429, lockMessage(wait));
      const user = await q.userByEmail.get(email);
      const ok = await verifyPassword(String(b.password || ''), user ? user.pass_hash : await getDummyHash());
      if (!user || !ok) {
        await recordFail(key);
        if (user) await logEvent(user.id, 'login_failed', c);
        throw new HttpError(401, 'Incorrect email or password');
      }
      if (needsRehash(user.pass_hash, iterations)) await q.rehash.run(await hashPassword(String(b.password), iterations), user.id);
      if (user.totp_enabled) {
        // Password was right; require the second factor before any session exists.
        await q.purgeTickets.run(Date.now());
        const ticket = token();
        await q.insertTicket.run(sha256(ticket), user.id, Date.now() + TICKET_MINUTES * 60_000);
        return json(200, { needs2fa: true, ticket });
      }
      await q.throttleDel.run(key);
      if (Math.random() < 0.02) await q.throttlePurge.run(Date.now() - 86_400_000, Date.now());   // tidy old counters now and then
      await logEvent(user.id, 'login', c);
      return startSession(user, 200, c);
    }

    if (path === '/api/auth/2fa' && m === 'POST') {
      if (!(await authAllowed(c))) throw new HttpError(429, 'Too many attempts, try again in a minute');
      const b = await readJson(c);
      const hash = sha256(String(b.ticket || ''));
      const t = await q.ticketByHash.get(hash);
      if (!t || t.expires_at < Date.now()) throw new HttpError(401, 'Your sign-in expired. Please start again.');
      if (t.attempts >= TICKET_MAX_ATTEMPTS) { await q.delTicket.run(hash); throw new HttpError(429, 'Too many incorrect codes. Please sign in again.'); }
      const user = await q.userById.get(t.user_id);
      const method = user ? await checkSecondFactor(user, b.code) : null;
      if (!method) {
        await q.bumpTicket.run(hash);
        if (user) await logEvent(user.id, 'second_factor_failed', c);
        throw new HttpError(401, 'That code is not correct. Check your authenticator app and try again.');
      }
      await q.delTicket.run(hash);
      await q.throttleDel.run(keyFor('login', user.email));
      await logEvent(user.id, 'login', c, method === 'recovery' ? 'used a recovery code' : '2-step verified');
      return startSession(user, 200, c, method === 'recovery' ? { recoveryLeft: recoveryLeft(await q.userById.get(user.id)) } : {});
    }

    if (path === '/api/auth/logout' && m === 'POST') {
      const sid = cookies(c)[SID];
      if (sid) await q.delSession.run(sha256(sid));
      return json(200, { ok: true }, {}, [sessionCookie('', 0)]);
    }

    // ---- everything below needs auth
    if (path === '/api/me' && m === 'GET') {
      const a = await authenticate(c);
      return json(200, { user: a ? publicUser(a.user) : null });
    }
    const a = await requireAuth(c);
    const user = a.user;

    // ---- account security (browser sessions only; API keys can never change credentials)
    if (path.startsWith('/api/me/') && /^\/api\/me\/(security|password|2fa\/|sessions\/)/.test(path)) {
      if (a.via !== 'session') throw new HttpError(403, 'Manage account security from the dashboard');

      const reauth = async (body) => {
        if (!(await allow(keyFor('reauth', user.id), 60_000, authPerMinute))) throw new HttpError(429, 'Too many attempts, try again in a minute');
        if (!(await verifyPassword(String(body.password || ''), user.pass_hash))) {
          await logEvent(user.id, 'reauth_failed', c);
          throw new HttpError(403, 'Incorrect password');
        }
      };

      if (path === '/api/me/security' && m === 'GET') {
        return json(200, {
          twoFactor: !!user.totp_enabled, recoveryLeft: recoveryLeft(user),
          sessions: (await q.countSessions.get(user.id, Date.now())).n,
          passwordChangedAt: user.password_changed_at || null,
          events: await q.recentEvents.all(user.id),
        });
      }

      if (path === '/api/me/password' && m === 'POST') {
        const b = await readJson(c);
        await reauth({ password: b.current });
        const weak = validatePassword(String(b.next || ''), { email: user.email, name: user.name });
        if (weak) throw bad(weak);
        if (String(b.next) === String(b.current)) throw bad('Choose a password you have not used just now.');
        await q.setPassword.run(await hashPassword(String(b.next), iterations), Date.now(), user.id);
        await q.delOtherSessions.run(user.id, a.sessionHash);        // a stolen session cannot outlive a password change
        await logEvent(user.id, 'password_changed', c);
        return json(200, { ok: true });
      }

      if (path === '/api/me/sessions/revoke-others' && m === 'POST') {
        await q.delOtherSessions.run(user.id, a.sessionHash);
        await logEvent(user.id, 'other_sessions_revoked', c);
        return json(200, { ok: true });
      }

      if (path === '/api/me/2fa/setup' && m === 'POST') {
        if (user.totp_enabled) throw new HttpError(409, 'Two-factor authentication is already on.');
        const secret = newSecret();
        await q.setTotpPending.run(encrypt(secret, config.secret), user.id);
        return json(200, { secret, otpauthUrl: otpauthUrl({ secret, account: user.email }) });
      }

      if (path === '/api/me/2fa/enable' && m === 'POST') {
        const b = await readJson(c);
        if (!(await allow(keyFor('reauth', user.id), 60_000, authPerMinute))) throw new HttpError(429, 'Too many attempts, try again in a minute');
        if (user.totp_enabled || !user.totp_secret_enc) throw bad('Start the setup first.');
        const step = verifyTotp(decrypt(user.totp_secret_enc, config.secret), b.code, {});
        if (step === null) throw bad('That code is not correct. Check the time on your phone and try again.');
        const codes = newRecoveryCodes(10);
        await q.setTotpEnabled.run(step, hashRecovery(codes), user.id);
        await logEvent(user.id, 'two_factor_enabled', c);
        return json(200, { recoveryCodes: codes });
      }

      if (path === '/api/me/2fa/recovery' && m === 'POST') {
        const b = await readJson(c);
        if (!user.totp_enabled) throw bad('Two-factor authentication is off.');
        await reauth(b);
        if ((await checkSecondFactor(user, b.code)) !== 'totp') throw bad('Enter the 6-digit code from your authenticator app.');
        const codes = newRecoveryCodes(10);
        await q.setRecovery.run(hashRecovery(codes), user.id);
        await logEvent(user.id, 'recovery_codes_regenerated', c);
        return json(200, { recoveryCodes: codes });
      }

      if (path === '/api/me/2fa/disable' && m === 'POST') {
        const b = await readJson(c);
        if (!user.totp_enabled) throw bad('Two-factor authentication is already off.');
        await reauth(b);
        if (!(await checkSecondFactor(user, b.code))) throw bad('Enter a current authenticator code or an unused recovery code.');
        await q.clearTotp.run(user.id);
        await q.delOtherSessions.run(user.id, a.sessionHash);
        await logEvent(user.id, 'two_factor_disabled', c);
        return json(200, { ok: true });
      }
    }

    if (path === '/api/me/apikey' && m === 'POST') {
      if (a.via !== 'session') throw new HttpError(403, 'Manage API keys from the dashboard');
      const key = `qrf_live_${token(24)}`;
      await q.setKey.run(sha256(key), key.slice(-4), user.id);
      return json(200, { apiKey: key, hint: key.slice(-4) });
    }
    if (path === '/api/me/apikey' && m === 'DELETE') {
      await q.setKey.run(null, null, user.id);
      return json(200, { ok: true });
    }

    if (path === '/api/brand' && m === 'GET') {
      return json(200, { brand: user.brand_json ? JSON.parse(user.brand_json) : null });
    }
    if (path === '/api/brand' && m === 'PUT') {
      const b = await readJson(c, 4_500_000);
      if (!Array.isArray(b.kits) || b.kits.length > 20) throw bad('kits must be an array of up to 20 items');
      const raw = JSON.stringify({ kits: b.kits });
      if (raw.length > 4_000_000) throw bad('Brand kit is too large');
      await q.setBrand.run(raw, user.id);
      return json(200, { ok: true });
    }

    if (path === '/api/qr' && m === 'GET') return qrImage(c);

    if (path === '/api/links' && m === 'GET') {
      return json(200, { links: await Promise.all((await q.linksByUser.all(user.id)).map((l) => publicLink(l, c))) });
    }
    if (path === '/api/links' && m === 'POST') {
      if ((await q.countLinks.get(user.id)).n >= MAX_LINKS_PER_USER) throw new HttpError(403, 'Link limit reached');
      const body = await readJson(c, 200_000);
      const { kind, next } = await validateLinkInput(c, body);
      let code;
      for (let i = 0; i < 5; i++) {
        code = shortCode(7);
        if (!(await q.linkByCode.get(code))) break;
        code = null;
      }
      if (!code) throw new HttpError(500, 'Could not allocate a short code');
      const now = Date.now();
      const info = await q.insertLink.run(user.id, code, kind, next.name, next.dest_url, next.page_json, next.pass_hash,
        next.expires_at, next.max_scans, next.webhook_url, now, now);
      return json(201, { link: await publicLink(await q.linkByIdUser.get(info.lastInsertRowid, user.id), c) });
    }

    const lm = path.match(/^\/api\/links\/(\d+)(?:\/(stats|export\.csv))?$/);
    if (lm) {
      const link = await q.linkByIdUser.get(Number(lm[1]), user.id);
      if (!link) throw new HttpError(404, 'Link not found');
      if (!lm[2] && m === 'GET') return json(200, { link: await publicLink(link, c) });
      if (!lm[2] && m === 'PATCH') {
        const body = await readJson(c, 200_000);
        const { next } = await validateLinkInput(c, body, link);
        await q.updateLink.run(next.name, next.dest_url, next.page_json, next.pass_hash, next.expires_at, next.max_scans,
          next.active, next.webhook_url, Date.now(), link.id);
        return json(200, { link: await publicLink(await q.linkByIdUser.get(link.id, user.id), c) });
      }
      if (!lm[2] && m === 'DELETE') {
        await q.deleteLink.run(link.id);
        return json(200, { ok: true });
      }
      if (lm[2] === 'stats' && m === 'GET') return json(200, await stats(link, Number(c.url.searchParams.get('days')) || 30));
      if (lm[2] === 'export.csv' && m === 'GET') return exportCsv(link);
    }

    throw new HttpError(404, 'Not found');
  }

  async function handleRedirect(c) {
    const m = c.url.pathname.match(/^\/(r|p)\/([0-9A-Za-z]{4,16})$/);
    const method = c.req.method;
    if (!m || !['GET', 'HEAD', 'POST'].includes(method)) return null;
    const [, prefix, code] = m;
    const link = await q.linkByCode.get(code);
    if (!link || link.kind !== (prefix === 'p' ? 'page' : 'link')) return noticePage(404, 'Link not found', 'This link does not exist or was removed.');

    const state = await linkState(link);
    if (state !== 'ok') {
      const msg = { paused: 'This link has been paused by its owner.', expired: 'This link has expired.', limit: 'This link reached its scan limit.' }[state];
      return noticePage(410, 'Link unavailable', msg);
    }

    if (link.kind === 'page') {
      if (method === 'GET') c.defer(() => recordScan(link, c));
      return html(200, renderLanding(link), { 'Cache-Control': 'no-cache' });
    }

    if (link.pass_hash) {
      if (method !== 'POST') return passwordPage(code);
      if (!(await allow(keyFor('unlock', `${c.ip}:${code}`), 10 * 60_000, 10))) return noticePage(429, 'Too many attempts', 'Please wait a few minutes and try again.');
      const form = new URLSearchParams(await readBody(c, 10_000));
      if (!(await verifyPassword(form.get('password') || '', link.pass_hash))) return passwordPage(code, 'Incorrect password.');
    } else if (method === 'POST') {
      return respond(405, null, { Allow: 'GET, HEAD' });
    }

    if (method !== 'HEAD') c.defer(() => recordScan(link, c));          // counted after the visitor is already on their way
    return respond(302, null, { Location: link.dest_url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  }

  /* -------------------------------- entry point -------------------------------- */

  async function handle(request, { ip = '', defer = (fn) => { fn(); } } = {}) {
    const c = { req: request, url: new URL(request.url), ip, defer };
    try {
      if (c.url.pathname === '/healthz') return json(200, { ok: true });
      if (c.url.pathname.startsWith('/api/')) return await handleApi(c);
      return await handleRedirect(c);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: 'Internal server error' });
    }
  }

  return { handle };
}
