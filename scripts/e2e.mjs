// End-to-end check of a running QRForge (local Node server, `wrangler dev`, or the deployed site).
//
//   node --env-file=.env scripts/e2e.mjs http://localhost:8787
//
// It creates throwaway accounts through the public API, exercises sign-up, login, two-step verification,
// dynamic links, scan counting, landing pages, passwords on links, API keys and lockouts, and prints a PASS/FAIL line
// for each. With TURSO_* variables present it then deletes the accounts it created.
// Against a deployed site, Cloudflare overwrites the visitor address, so shared rate limits may trip: re-run after a minute.
import http from 'node:http';
import { scryptSync, randomBytes } from 'node:crypto';
import { totp } from '../server/totp.js';

const base = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
const PW = 'correct horse battery';
const stamp = Date.now();
let ipCounter = 0;
const results = [];
const emails = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextIp = () => `10.77.${(stamp % 200) + 1}.${(ipCounter++ % 250) + 1}`;   // a fresh "visitor" per section, so shared limits never interfere

async function call(path, { method = 'GET', body, cookie, ip, headers = {}, raw } = {}) {
  const h = { 'cf-connecting-ip': ip || nextIp(), ...headers };
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await fetch(base + path, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' });
  const text = await res.text();
  let data = text; try { data = JSON.parse(text); } catch { /* not JSON */ }
  const setCookie = res.headers.getSetCookie?.()[0]?.split(';')[0] || '';
  return { status: res.status, data, text, headers: res.headers, cookie: setCookie };
}

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

async function newAccount(label) {
  const email = `e2e-${label}-${stamp}@test.dev`;
  emails.push(email);
  const ip = nextIp();
  const r = await call('/api/auth/signup', { method: 'POST', ip, body: { name: 'E2E Tester', email, password: PW, acceptTerms: true } });
  if (r.status !== 201) throw new Error(`sign-up failed (${r.status}): ${JSON.stringify(r.data)}`);
  return { email, cookie: r.cookie, ip };
}

async function main() {
  console.log(`Testing ${base}\n`);

  /* ---- static site ---- */
  const home = await call('/');
  check('home page loads', home.status === 200 && /QRForge/.test(home.text));
  eq('clean URL works (/wifi-qr-code-generator)', (await call('/wifi-qr-code-generator')).status, 200);
  eq('dashboard page loads', (await call('/dashboard')).status, 200);
  eq('CSS asset loads', (await call('/css/app.css')).status, 200);
  const missing = await call('/definitely-not-a-page');
  check('unknown page gives the 404 page', missing.status === 404 && /not found/i.test(missing.text), `status ${missing.status}`);
  check('security headers on pages', /default-src 'self'/.test(home.headers.get('content-security-policy') || '') && home.headers.get('x-content-type-options') === 'nosniff' && home.headers.get('x-frame-options') === 'DENY');
  eq('health check', (await call('/healthz')).data, { ok: true });

  /* ---- sign-up rules ---- */
  eq('weak password refused', (await call('/api/auth/signup', { method: 'POST', body: { name: 'A B', email: `w${stamp}@test.dev`, password: 'password123', acceptTerms: true } })).status, 400);
  eq('terms must be accepted', (await call('/api/auth/signup', { method: 'POST', body: { name: 'A B', email: `t${stamp}@test.dev`, password: PW, acceptTerms: false } })).status, 400);

  /* ---- account, session, links, scans ---- */
  const a = await newAccount('main');
  const me = await call('/api/me', { cookie: a.cookie });
  eq('signed-up user is logged in', me.data.user?.email, a.email);
  eq('duplicate email refused', (await call('/api/auth/signup', { method: 'POST', body: { name: 'E2E Tester', email: a.email, password: PW, acceptTerms: true } })).status, 409);

  const link = (await call('/api/links', { method: 'POST', cookie: a.cookie, body: { name: 'E2E link', destUrl: 'https://example.com/e2e' } })).data.link;
  check('dynamic link created', !!link?.shortUrl && /\/r\/[0-9A-Za-z]{7}$/.test(link.shortUrl), JSON.stringify(link));
  const code = link.code;
  const hit = await call(`/r/${code}`, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1', Referer: 'https://instagram.com/x' } });
  check('scan redirects to the destination', hit.status === 302 && hit.headers.get('location') === 'https://example.com/e2e', `status ${hit.status}, location ${hit.headers.get('location')}`);
  await call(`/r/${code}`, { headers: { 'User-Agent': 'Googlebot/2.1' } });
  await sleep(2500);                                                   // scans are counted just after the redirect
  const st = (await call(`/api/links/${link.id}/stats`, { cookie: a.cookie })).data;
  eq('exactly one human scan counted (bots ignored)', st.total, 1);
  check('scan details recorded', st.devices?.[0]?.label === 'Mobile' && st.referrers?.[0]?.label === 'instagram.com', JSON.stringify([st.devices, st.referrers]));
  const edited = (await call(`/api/links/${link.id}`, { method: 'PATCH', cookie: a.cookie, body: { destUrl: 'https://example.com/changed' } })).data.link;
  eq('destination can be edited later', edited?.destUrl, 'https://example.com/changed');
  eq('redirect follows the new destination', (await call(`/r/${code}`)).headers.get('location'), 'https://example.com/changed');
  const csv = await call(`/api/links/${link.id}/export.csv`, { cookie: a.cookie });
  check('scan export is CSV', csv.status === 200 && /^time,device,os,browser,country,referrer/.test(csv.text));
  for (const bad of ['javascript:alert(1)', 'ftp://x.com', 'not a url']) {
    eq(`dangerous destination refused (${bad})`, (await call('/api/links', { method: 'POST', cookie: a.cookie, body: { destUrl: bad } })).status, 400);
  }
  eq('another visitor cannot read the link', (await call(`/api/links/${link.id}`)).status, 401);

  /* ---- password-protected link, limit, landing page ---- */
  const locked = (await call('/api/links', { method: 'POST', cookie: a.cookie, body: { destUrl: 'https://example.com/secret', password: 'sesame', maxScans: 2 } })).data.link;
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  check('protected link asks for a password', (await call(`/r/${locked.code}`)).text.includes('Password required'));
  check('wrong link password refused', (await call(`/r/${locked.code}`, { method: 'POST', headers: form, raw: 'password=nope', ip: nextIp() })).text.includes('Incorrect password'));
  eq('right link password redirects', (await call(`/r/${locked.code}`, { method: 'POST', headers: form, raw: 'password=sesame', ip: nextIp() })).status, 302);

  const pageRes = await call('/api/links', { method: 'POST', cookie: a.cookie, body: { kind: 'page', page: { title: '<b>Chai & Co</b>', links: [{ label: 'Menu', url: 'https://example.com/menu' }] } } });
  const pageHtml = (await call(pageRes.data.link.shortUrl.replace(/^https?:\/\/[^/]+/, ''))).text;
  check('landing page renders and escapes content', pageHtml.includes('&lt;b&gt;Chai &amp; Co&lt;/b&gt;') && !pageHtml.includes('<b>Chai'));

  /* ---- two-step verification ---- */
  const setup = (await call('/api/me/2fa/setup', { method: 'POST', cookie: a.cookie })).data;
  check('2FA setup returns a secret and an otpauth link', /^[A-Z2-7]{32}$/.test(setup.secret) && setup.otpauthUrl?.startsWith('otpauth://totp/'));
  eq('wrong 2FA code refused at setup', (await call('/api/me/2fa/enable', { method: 'POST', cookie: a.cookie, body: { code: '000000' } })).status, 400);
  const en = await call('/api/me/2fa/enable', { method: 'POST', cookie: a.cookie, body: { code: totp(setup.secret) } });
  eq('2FA enabled with 10 recovery codes', en.data.recoveryCodes?.length, 10);
  const step1 = await call('/api/auth/login', { method: 'POST', body: { email: a.email, password: PW } });
  check('login now needs a second step (no session yet)', step1.data.needs2fa === true && !!step1.data.ticket && step1.cookie === '');
  eq('wrong code refused', (await call('/api/auth/2fa', { method: 'POST', body: { ticket: step1.data.ticket, code: '111111' } })).status, 401);
  const step2 = await call('/api/auth/2fa', { method: 'POST', body: { ticket: step1.data.ticket, code: totp(setup.secret, Date.now() + 30_000) } });
  check('correct authenticator code logs in', step2.status === 200 && !!step2.cookie, JSON.stringify(step2.data));
  const again = await call('/api/auth/login', { method: 'POST', body: { email: a.email, password: PW } });
  eq('the same code cannot be reused', (await call('/api/auth/2fa', { method: 'POST', body: { ticket: again.data.ticket, code: totp(setup.secret, Date.now() + 30_000) } })).status, 401);
  const viaRecovery = await call('/api/auth/2fa', { method: 'POST', body: { ticket: again.data.ticket, code: en.data.recoveryCodes[0].toLowerCase() } });
  check('a recovery code logs in', viaRecovery.status === 200 && viaRecovery.data.recoveryLeft === 9, JSON.stringify(viaRecovery.data));
  const again2 = await call('/api/auth/login', { method: 'POST', body: { email: a.email, password: PW } });
  eq('a recovery code works only once', (await call('/api/auth/2fa', { method: 'POST', body: { ticket: again2.data.ticket, code: en.data.recoveryCodes[0] } })).status, 401);

  /* ---- password change, sessions, API key ---- */
  const other = viaRecovery.cookie;
  eq('weak new password refused', (await call('/api/me/password', { method: 'POST', cookie: step2.cookie, body: { current: PW, next: 'password12345' } })).status, 400);
  eq('wrong current password refused', (await call('/api/me/password', { method: 'POST', cookie: step2.cookie, body: { current: 'wrong-wrong-wrong', next: 'a brand new passphrase' } })).status, 403);
  eq('password changed', (await call('/api/me/password', { method: 'POST', cookie: step2.cookie, body: { current: PW, next: 'a brand new passphrase' } })).status, 200);
  eq('other sessions are signed out by a password change', (await call('/api/me', { cookie: other })).data.user, null);
  eq('this session stays signed in', (await call('/api/me', { cookie: step2.cookie })).data.user?.email, a.email);
  const sec = (await call('/api/me/security', { cookie: step2.cookie })).data;
  check('security activity is logged', ['account_created', 'login', 'password_changed', 'two_factor_enabled'].every((t) => sec.events.some((e) => e.type === t)), JSON.stringify(sec.events.map((e) => e.type)));

  const key = (await call('/api/me/apikey', { method: 'POST', cookie: step2.cookie })).data.apiKey;
  check('API key issued', /^qrf_live_/.test(key || ''));
  const viaKey = await fetch(`${base}/api/v1/links`, { headers: { Authorization: `Bearer ${key}`, 'cf-connecting-ip': nextIp() } });
  eq('API key can list links', viaKey.status, 200);
  const keyChange = await fetch(`${base}/api/me/password`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'cf-connecting-ip': nextIp() }, body: JSON.stringify({ current: 'x', next: 'y' }) });
  eq('API key cannot change the password', keyChange.status, 403);
  const svg = await fetch(`${base}/api/v1/qr?data=https://example.com&format=svg`, { headers: { Authorization: `Bearer ${key}`, 'cf-connecting-ip': nextIp() } });
  check('QR image endpoint returns SVG', svg.status === 200 && /svg/.test(svg.headers.get('content-type')) && (await svg.text()).includes('<svg'));

  /* ---- abuse protection ---- */
  for (const webhookUrl of ['http://example.com/hook', 'https://127.0.0.1/hook', 'https://localhost/hook', 'https://db.internal/hook']) {
    eq(`webhook target refused (${webhookUrl})`, (await call('/api/links', { method: 'POST', cookie: step2.cookie, body: { destUrl: 'https://example.com', webhookUrl } })).status, 400);
  }
  eq('cross-origin writes are blocked', (await call('/api/links', { method: 'POST', cookie: step2.cookie, headers: { Origin: 'https://evil.example' }, body: { destUrl: 'https://example.com' } })).status, 403);

  const victim = await newAccount('lock');
  for (let i = 0; i < 5; i++) await call('/api/auth/login', { method: 'POST', ip: nextIp(), body: { email: victim.email, password: 'wrong-wrong-wrong' } });
  const locked2 = await call('/api/auth/login', { method: 'POST', ip: nextIp(), body: { email: victim.email, password: PW } });
  check('five wrong passwords lock the account (even for the right password)', locked2.status === 429 && /Try again in/.test(locked2.data.error), JSON.stringify(locked2.data));

  /* ---- an older account whose password was hashed with scrypt ---- */
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
    const { connectTurso } = await import('../server/turso.js');
    const { wrapClient } = await import('../server/dbadapter.js');
    const client = connectTurso({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
    const db = wrapClient(client);
    const legacyEmail = `e2e-legacy-${stamp}@test.dev`;
    emails.push(legacyEmail);
    const salt = randomBytes(16);
    await db.prepare('INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(legacyEmail, 'Legacy', `s1$${salt.toString('base64')}$${scryptSync(PW, salt, 64).toString('base64')}`, Date.now());
    const legacy = await call('/api/auth/login', { method: 'POST', body: { email: legacyEmail, password: PW } });
    check('an old scrypt-hashed account can still log in', legacy.status === 200, `${legacy.status} ${JSON.stringify(legacy.data)} (if this fails only on Cloudflare, those users need a password reset)`);
    if (legacy.status === 200) {
      check('...and its password hash was upgraded', /^p1\$/.test((await db.prepare('SELECT pass_hash FROM users WHERE email = ?').get(legacyEmail)).pass_hash));
    }

    /* ---- clean up everything this run created ---- */
    let removed = 0;
    for (const e of emails) removed += (await db.prepare('DELETE FROM users WHERE email = ?').run(e)).changes;
    await db.prepare('DELETE FROM throttle WHERE window_start >= ?').run(stamp - 60_000);
    console.log(`\nCleaned up ${removed} test account(s) and their data.`);
    client.close();
  } else {
    console.log(`\nTest accounts left in place (set TURSO_* to clean them up automatically): ${emails.join(', ')}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(`\nE2E aborted: ${err.message}`); process.exit(2); });
