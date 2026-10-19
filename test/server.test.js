import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';

let server, base, db;
const pub = mkdtempSync(join(tmpdir(), 'qrf-'));
writeFileSync(join(pub, 'index.html'), '<h1>home</h1>');

before(async () => {
  db = openDb(':memory:');
  server = createApp({ db, config: { publicDir: pub, secret: 'test', secureCookies: false, trustProxy: false, baseUrl: '' } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const JSON_H = { 'Content-Type': 'application/json' };

async function api(path, { method = 'GET', body, cookie, headers = {}, key } = {}) {
  const h = { ...headers };
  if (body !== undefined) Object.assign(h, JSON_H);
  if (cookie) h.Cookie = cookie;
  if (key) h.Authorization = `Bearer ${key}`;
  const res = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

async function signup(email = `u${Math.random().toString(36).slice(2)}@test.dev`) {
  const r = await api('/api/auth/signup', { method: 'POST', body: { name: 'Test User', email, password: 'correct horse battery', acceptTerms: true } });
  assert.equal(r.status, 201);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return { cookie, email };
}

test('serves static files and health check', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /home/);
  assert.equal((await fetch(base + '/../../etc/passwd')).status, 404);
  assert.equal((await api('/healthz')).data.ok, true);
});

test('signup, session, logout, login', async () => {
  const { cookie, email } = await signup();
  const me = await api('/api/me', { cookie });
  assert.equal(me.data.user.email, email);
  assert.match(String((await api('/api/auth/signup', { method: 'POST', body: { name: 'Test User', email, password: 'correct horse battery', acceptTerms: true } })).data.error), /already exists/);
  await api('/api/auth/logout', { method: 'POST', cookie });
  assert.equal((await api('/api/me', { cookie })).data.user, null);
  const login = await api('/api/auth/login', { method: 'POST', body: { email, password: 'correct horse battery' } });
  assert.equal(login.status, 200);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { email, password: 'nope-nope-nope' } })).status, 401);
});

test('rejects weak input on signup', async () => {
  assert.equal((await api('/api/auth/signup', { method: 'POST', body: { name: 'Test User', email: 'not-an-email', password: 'longenoughpw', acceptTerms: true } })).status, 400);
  assert.equal((await api('/api/auth/signup', { method: 'POST', body: { name: 'Test User', email: 'a@b.co', password: 'short', acceptTerms: true } })).status, 400);
});

test('link CRUD, redirect and stats', async () => {
  const { cookie } = await signup();
  const created = await api('/api/links', { method: 'POST', cookie, body: { name: 'Menu', destUrl: 'https://example.com/menu' } });
  assert.equal(created.status, 201);
  const link = created.data.link;
  assert.match(link.shortUrl, /\/r\/[0-9A-Za-z]{7}$/);

  const r1 = await fetch(`${base}/r/${link.code}`, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1', Referer: 'https://instagram.com/x' } });
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('location'), 'https://example.com/menu');
  assert.equal(r1.headers.get('cache-control'), 'no-store');
  await fetch(`${base}/r/${link.code}`, { method: 'HEAD', redirect: 'manual' });                       // HEAD is not counted
  await fetch(`${base}/r/${link.code}`, { redirect: 'manual', headers: { 'User-Agent': 'Googlebot/2.1' } }); // bots are not counted

  // edit the destination without changing the code
  const patched = await api(`/api/links/${link.id}`, { method: 'PATCH', cookie, body: { destUrl: 'https://example.com/new' } });
  assert.equal(patched.data.link.destUrl, 'https://example.com/new');
  const r2 = await fetch(`${base}/r/${link.code}`, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537' } });
  assert.equal(r2.headers.get('location'), 'https://example.com/new');

  const st = (await api(`/api/links/${link.id}/stats`, { cookie })).data;
  assert.equal(st.total, 2);
  assert.equal(st.series.length, 30);
  assert.equal(st.series.at(-1).count, 2);
  assert.deepEqual(st.devices.map((d) => d.label).sort(), ['Desktop', 'Mobile']);
  assert.ok(st.referrers.some((r) => r.label === 'instagram.com'));

  const csv = await fetch(`${base}/api/links/${link.id}/export.csv`, { headers: { Cookie: cookie } });
  assert.match(await csv.text(), /^time,device,os,browser,country,referrer/);

  assert.equal((await api(`/api/links/${link.id}`, { method: 'DELETE', cookie })).status, 200);
  assert.equal((await fetch(`${base}/r/${link.code}`, { redirect: 'manual' })).status, 404);
});

test('rejects dangerous or looping destinations', async () => {
  const { cookie } = await signup();
  for (const destUrl of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x.com', 'https://user:pw@example.com', 'not a url', `${base}/r/abcdefg`]) {
    const r = await api('/api/links', { method: 'POST', cookie, body: { destUrl } });
    assert.equal(r.status, 400, destUrl);
  }
});

test('links are private to their owner', async () => {
  const a = await signup(); const b = await signup();
  const { data } = await api('/api/links', { method: 'POST', cookie: a.cookie, body: { destUrl: 'https://example.com' } });
  assert.equal((await api(`/api/links/${data.link.id}`, { cookie: b.cookie })).status, 404);
  assert.equal((await api(`/api/links/${data.link.id}`, { method: 'DELETE', cookie: b.cookie })).status, 404);
  assert.equal((await api('/api/links')).status, 401);
});

test('password, expiry, scan limit and pause', async () => {
  const { cookie } = await signup();
  const mk = async (extra) => (await api('/api/links', { method: 'POST', cookie, body: { destUrl: 'https://example.com', ...extra } })).data.link;

  const locked = await mk({ password: 'sesame' });
  assert.equal(locked.hasPassword, true);
  assert.equal((await fetch(`${base}/r/${locked.code}`, { redirect: 'manual' })).status, 200);       // password form
  const wrong = await fetch(`${base}/r/${locked.code}`, { method: 'POST', body: 'password=nope', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.match(await wrong.text(), /Incorrect password/);
  const right = await fetch(`${base}/r/${locked.code}`, { method: 'POST', body: 'password=sesame', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.equal(right.status, 302);

  const expired = await mk({ expiresAt: Date.now() + 50 });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((await fetch(`${base}/r/${expired.code}`, { redirect: 'manual' })).status, 410);

  const limited = await mk({ maxScans: 1 });
  assert.equal((await fetch(`${base}/r/${limited.code}`, { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(`${base}/r/${limited.code}`, { redirect: 'manual' })).status, 410);

  const paused = await mk({});
  await api(`/api/links/${paused.id}`, { method: 'PATCH', cookie, body: { active: false } });
  assert.equal((await fetch(`${base}/r/${paused.code}`, { redirect: 'manual' })).status, 410);
});

test('landing pages escape user content', async () => {
  const { cookie } = await signup();
  const page = { title: '<script>alert(1)</script>', bio: 'a "quote"', accent: '#112233', links: [{ label: 'Menu', url: 'https://example.com' }] };
  const { data } = await api('/api/links', { method: 'POST', cookie, body: { kind: 'page', page } });
  assert.match(data.link.shortUrl, /\/p\//);
  const html = await (await fetch(`${base}/p/${data.link.code}`)).text();
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
  const badLink = await api('/api/links', { method: 'POST', cookie, body: { kind: 'page', page: { title: 't', links: [{ label: 'x', url: 'javascript:alert(1)' }] } } });
  assert.equal(badLink.status, 400);
});

test('API key auth, QR image endpoint, brand sync', async () => {
  const { cookie } = await signup();
  const { data } = await api('/api/me/apikey', { method: 'POST', cookie });
  assert.match(data.apiKey, /^qrf_live_/);
  const viaKey = await api('/api/v1/links', { key: data.apiKey });
  assert.equal(viaKey.status, 200);
  assert.equal((await api('/api/v1/links', { key: 'qrf_live_wrong' })).status, 401);

  const png = await fetch(`${base}/api/v1/qr?data=https://example.com&size=200`, { headers: { Authorization: `Bearer ${data.apiKey}` } });
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal((await png.arrayBuffer()).byteLength > 200, true);
  const svg = await fetch(`${base}/api/v1/qr?data=hi&format=svg`, { headers: { Authorization: `Bearer ${data.apiKey}` } });
  assert.match(await svg.text(), /<svg/);

  assert.equal((await api('/api/brand', { method: 'PUT', cookie, body: { kits: [{ id: '1', name: 'Mine' }] } })).status, 200);
  assert.equal((await api('/api/brand', { cookie })).data.brand.kits[0].name, 'Mine');
});

test('blocks cross-origin writes made with the session cookie', async () => {
  const { cookie } = await signup();
  const r = await api('/api/links', { method: 'POST', cookie, headers: { Origin: 'https://evil.example' }, body: { destUrl: 'https://example.com' } });
  assert.equal(r.status, 403);
});

test('webhook URLs must be public https', async () => {
  const { cookie } = await signup();
  for (const webhookUrl of ['http://example.com/hook', 'https://127.0.0.1/hook', 'https://localhost/hook']) {
    const r = await api('/api/links', { method: 'POST', cookie, body: { destUrl: 'https://example.com', webhookUrl } });
    assert.equal(r.status, 400, webhookUrl);
  }
});
