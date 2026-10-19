import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { totp, hotp, base32Decode, base32Encode, verifyTotp, newRecoveryCodes, normalizeRecovery } from '../server/totp.js';
import { encrypt, decrypt } from '../server/vault.js';
import { validatePassword } from '../server/password.js';

let server, base;
const pub = mkdtempSync(join(tmpdir(), 'qrf-auth-'));
writeFileSync(join(pub, 'index.html'), 'ok');

before(async () => {
  server = createApp({ db: openDb(':memory:'), config: { publicDir: pub, secret: 'test-secret', secureCookies: false, trustProxy: false, baseUrl: '', authLimitPerMinute: 10_000 } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function api(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

const PW = 'correct horse battery';
let n = 0;
const uniq = () => `auth${Date.now()}${n++}@test.dev`;
async function signup(email = uniq(), password = PW) {
  const r = await api('/api/auth/signup', { method: 'POST', body: { name: 'Asha Rao', email, password, acceptTerms: true } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { email, cookie: r.cookie };
}

/** Turn on two-factor for a freshly created account; returns the secret and recovery codes. */
async function enable2fa(cookie) {
  const setup = await api('/api/me/2fa/setup', { method: 'POST', cookie });
  assert.equal(setup.status, 200);
  assert.match(setup.data.otpauthUrl, /^otpauth:\/\/totp\/QRForge:/);
  const en = await api('/api/me/2fa/enable', { method: 'POST', cookie, body: { code: totp(setup.data.secret) } });
  assert.equal(en.status, 200, JSON.stringify(en.data));
  assert.equal(en.data.recoveryCodes.length, 10);
  return { secret: setup.data.secret, recoveryCodes: en.data.recoveryCodes };
}

// Each later code must come from a newer 30-second step than the last one used (replay protection).
const nextCode = (secret, stepsAhead) => totp(secret, Date.now() + stepsAhead * 30_000);

test('TOTP matches the RFC 6238 test vectors', () => {
  const secret = Buffer.from('12345678901234567890');
  assert.equal(hotp(secret, Math.floor(59 / 30), 8), '94287082');
  assert.equal(hotp(secret, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(hotp(secret, Math.floor(20000000000 / 30), 8), '65353130');
  assert.equal(base32Encode(secret), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), secret);
});

test('verifyTotp allows clock drift, rejects bad and replayed codes', () => {
  const s = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const t = 1_700_000_000_000;
  const step = Math.floor(t / 1000 / 30);
  assert.equal(verifyTotp(s, totp(s, t), { time: t }), step);
  assert.equal(verifyTotp(s, totp(s, t - 30_000), { time: t }), step - 1);       // one step late
  assert.equal(verifyTotp(s, totp(s, t + 90_000), { time: t }), null);            // three steps away
  assert.equal(verifyTotp(s, totp(s, t), { time: t, lastStep: step }), null);     // already used
  assert.equal(verifyTotp(s, '12345', { time: t }), null);
  assert.equal(verifyTotp(s, 'abcdef', { time: t }), null);
});

test('recovery codes and vault', () => {
  const codes = newRecoveryCodes(10);
  assert.equal(new Set(codes).size, 10);
  assert.match(codes[0], /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  assert.equal(normalizeRecovery(codes[0].toLowerCase()), codes[0].replace('-', ''));
  const blob = encrypt('JBSWY3DPEHPK3PXP', 'k1');
  assert.equal(decrypt(blob, 'k1'), 'JBSWY3DPEHPK3PXP');
  assert.throws(() => decrypt(blob, 'other-key'));
  const [iv, tag, ct] = blob.split('.').map((x) => Buffer.from(x, 'base64'));
  ct[0] ^= 1;                                                                           // flip one bit of the ciphertext
  assert.throws(() => decrypt([iv, tag, ct].map((x) => x.toString('base64')).join('.'), 'k1'));
});

test('password policy', () => {
  assert.match(validatePassword('short1'), /at least 10/);
  assert.match(validatePassword('password123'), /at least 10|common/);
  assert.match(validatePassword('Password12345'), /common/);                        // common word plus digits
  assert.match(validatePassword('aaaaaaaaaaaa'), /different characters/);
  assert.match(validatePassword('1234567890'), /common|sequence/);
  assert.match(validatePassword('chaitanya-is-cool', { name: 'Chaitanya Singhal' }), /name/);
  assert.match(validatePassword('xxsinghalchaitanya99xx', { email: 'singhalchaitanya99@gmail.com' }), /email/);
  assert.equal(validatePassword('correct horse battery'), null);
  assert.equal(validatePassword('t0tally-unrelated-phrase'), null);
});

test('signup asks for name, terms and a strong password', async () => {
  const ok = { name: 'Asha Rao', email: uniq(), password: PW, acceptTerms: true };
  const send = (over) => api('/api/auth/signup', { method: 'POST', body: { ...ok, email: uniq(), ...over } });
  assert.match((await send({ name: '' })).data.error, /name/i);
  assert.match((await send({ name: '<script>' })).data.error, /name/i);
  assert.match((await send({ acceptTerms: false })).data.error, /Terms/);
  assert.match((await send({ password: 'qwertyuiop' })).data.error, /common|sequence/);
  assert.match((await send({ password: 'short' })).data.error, /at least 10/);
  assert.equal((await send({ website: 'http://spam.example' })).status, 400);        // honeypot
  const good = await send({});
  assert.equal(good.status, 201);
  assert.equal(good.data.user.name, 'Asha Rao');
  assert.equal(good.data.user.twoFactor, false);
});

test('repeated wrong passwords lock the account, with the same response for unknown emails', async () => {
  const { email } = await signup();
  for (let i = 0; i < 5; i++) assert.equal((await api('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-wrong-wrong' } })).status, 401);
  const locked = await api('/api/auth/login', { method: 'POST', body: { email, password: PW } });     // even the right password is refused
  assert.equal(locked.status, 429);
  assert.match(locked.data.error, /Try again in/);

  const ghost = `ghost${Date.now()}@test.dev`;
  for (let i = 0; i < 5; i++) await api('/api/auth/login', { method: 'POST', body: { email: ghost, password: 'wrong-wrong-wrong' } });
  const ghostLocked = await api('/api/auth/login', { method: 'POST', body: { email: ghost, password: 'wrong-wrong-wrong' } });
  assert.equal(ghostLocked.status, 429);                                                // indistinguishable from a real account
});

test('two-factor: enable, then login needs a code, and replays are refused', async () => {
  const { email, cookie } = await signup();
  const { secret } = await enable2fa(cookie);
  assert.equal((await api('/api/me', { cookie })).data.user.twoFactor, true);
  assert.equal((await api('/api/me/2fa/setup', { method: 'POST', cookie })).status, 409);

  const step1 = await api('/api/auth/login', { method: 'POST', body: { email, password: PW } });
  assert.equal(step1.status, 200);
  assert.equal(step1.data.needs2fa, true);
  assert.ok(step1.data.ticket);
  assert.equal(step1.cookie, '');                                                       // no session before the second factor
  assert.equal(step1.data.user, undefined);

  assert.equal((await api('/api/auth/2fa', { method: 'POST', body: { ticket: step1.data.ticket, code: '000000' } })).status, 401);
  const code = nextCode(secret, 1);
  const done = await api('/api/auth/2fa', { method: 'POST', body: { ticket: step1.data.ticket, code } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.ok(done.cookie.startsWith('qrf_sid='));
  assert.equal((await api('/api/me', { cookie: done.cookie })).data.user.email, email);

  // the ticket is single use, and the same code cannot be replayed on a new ticket
  assert.equal((await api('/api/auth/2fa', { method: 'POST', body: { ticket: step1.data.ticket, code } })).status, 401);
  const again = await api('/api/auth/login', { method: 'POST', body: { email, password: PW } });
  assert.equal((await api('/api/auth/2fa', { method: 'POST', body: { ticket: again.data.ticket, code } })).status, 401);
});

test('two-factor tickets expire after too many wrong codes', async () => {
  const { email, cookie } = await signup();
  const { secret } = await enable2fa(cookie);
  const { data } = await api('/api/auth/login', { method: 'POST', body: { email, password: PW } });
  for (let i = 0; i < 5; i++) assert.equal((await api('/api/auth/2fa', { method: 'POST', body: { ticket: data.ticket, code: '111111' } })).status, 401);
  const blocked = await api('/api/auth/2fa', { method: 'POST', body: { ticket: data.ticket, code: nextCode(secret, 2) } });
  assert.equal(blocked.status, 429);                                                    // even the right code is refused now
  assert.equal((await api('/api/auth/2fa', { method: 'POST', body: { ticket: 'made-up', code: '123456' } })).status, 401);
});

test('recovery codes work once and are counted', async () => {
  const { email, cookie } = await signup();
  const { recoveryCodes } = await enable2fa(cookie);
  const login = () => api('/api/auth/login', { method: 'POST', body: { email, password: PW } });

  const first = await login();
  const ok = await api('/api/auth/2fa', { method: 'POST', body: { ticket: first.data.ticket, code: recoveryCodes[0].toLowerCase() } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.recoveryLeft, 9);

  const second = await login();
  assert.equal((await api('/api/auth/2fa', { method: 'POST', body: { ticket: second.data.ticket, code: recoveryCodes[0] } })).status, 401);   // used up
  assert.equal((await api('/api/me/security', { cookie: ok.cookie })).data.recoveryLeft, 9);
});

test('disabling two-factor needs the password and a code', async () => {
  const { email, cookie } = await signup();
  const { secret } = await enable2fa(cookie);
  assert.equal((await api('/api/me/2fa/disable', { method: 'POST', cookie, body: { password: 'wrong-wrong-wrong', code: nextCode(secret, 1) } })).status, 403);
  assert.equal((await api('/api/me/2fa/disable', { method: 'POST', cookie, body: { password: PW, code: '000000' } })).status, 400);
  assert.equal((await api('/api/me/2fa/disable', { method: 'POST', cookie, body: { password: PW, code: nextCode(secret, 1) } })).status, 200);
  const login = await api('/api/auth/login', { method: 'POST', body: { email, password: PW } });
  assert.ok(login.data.user, 'plain login works again');
});

test('changing the password signs out other sessions', async () => {
  const { email, cookie: first } = await signup();
  const second = (await api('/api/auth/login', { method: 'POST', body: { email, password: PW } })).cookie;
  assert.equal((await api('/api/me', { cookie: second })).data.user.email, email);

  assert.equal((await api('/api/me/password', { method: 'POST', cookie: first, body: { current: 'wrong-wrong-wrong', next: 'a brand new passphrase' } })).status, 403);
  assert.match((await api('/api/me/password', { method: 'POST', cookie: first, body: { current: PW, next: 'password123' } })).data.error, /at least 10|common/);
  assert.equal((await api('/api/me/password', { method: 'POST', cookie: first, body: { current: PW, next: 'a brand new passphrase' } })).status, 200);

  assert.equal((await api('/api/me', { cookie: first })).data.user.email, email);       // this session stays
  assert.equal((await api('/api/me', { cookie: second })).data.user, null);              // the other one is gone
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { email, password: PW } })).status, 401);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { email, password: 'a brand new passphrase' } })).status, 200);
});

test('revoke-others and the security activity log', async () => {
  const { email, cookie: first } = await signup();
  const second = (await api('/api/auth/login', { method: 'POST', body: { email, password: PW } })).cookie;
  assert.equal((await api('/api/me/security', { cookie: first })).data.sessions, 2);
  assert.equal((await api('/api/me/sessions/revoke-others', { method: 'POST', cookie: first })).status, 200);
  assert.equal((await api('/api/me', { cookie: second })).data.user, null);
  const sec = (await api('/api/me/security', { cookie: first })).data;
  assert.equal(sec.sessions, 1);
  const types = sec.events.map((e) => e.type);
  for (const t of ['account_created', 'login', 'other_sessions_revoked']) assert.ok(types.includes(t), t);
  assert.match(sec.events[0].detail, /on /);
  assert.equal(JSON.stringify(sec).includes(PW), false);
});

test('API keys cannot touch account security', async () => {
  const { cookie } = await signup();
  const { data } = await api('/api/me/apikey', { method: 'POST', cookie });
  const viaKey = await fetch(`${base}/api/me/password`, {
    method: 'POST', headers: { Authorization: `Bearer ${data.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: PW, next: 'another long passphrase' }),
  });
  assert.equal(viaKey.status, 403);
});

test('sign-in attempts are rate limited per IP address', async () => {
  const limited = createApp({ db: openDb(':memory:'), config: { publicDir: pub, secret: 's', secureCookies: false, trustProxy: false, baseUrl: '', authLimitPerMinute: 3 } });
  await new Promise((r) => limited.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${limited.address().port}/api/auth/login`;
  const hit = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@y.co', password: 'nope-nope-nope' }) });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await hit()).status);
  limited.close();
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
});

test('an older database is upgraded in place and keeps its users', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(mkdtempSync(join(tmpdir(), 'qrf-old-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, api_key_hash TEXT UNIQUE, api_key_hint TEXT, brand_json TEXT, created_at INTEGER NOT NULL);
            CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);`);
  old.prepare('INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)').run('legacy@test.dev', 'x', 1);
  old.close();

  const db = openDb(file);
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  for (const c of ['name', 'totp_secret_enc', 'totp_enabled', 'recovery_hashes']) assert.ok(cols.includes(c), c);
  assert.equal(db.prepare('SELECT email FROM users').get().email, 'legacy@test.dev');
  db.close();
  openDb(file).close();                                                                 // running the upgrade twice is harmless
});
