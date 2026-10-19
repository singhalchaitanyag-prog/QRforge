import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync, randomBytes } from 'node:crypto';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { wrapClient } from '../server/dbadapter.js';
import { hashPassword, verifyPassword, needsRehash, assertPublicHost } from '../server/util.js';

const pub = mkdtempSync(join(tmpdir(), 'qrf-port-'));
writeFileSync(join(pub, 'index.html'), 'ok');

async function start(db, extra = {}) {
  const server = createApp({ db, config: { publicDir: pub, secret: 'portable-secret', secureCookies: false, trustProxy: false, baseUrl: '', authLimitPerMinute: 10_000, ...extra } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const PW = 'correct horse battery';

test('password hashes use PBKDF2, verify, and reject wrong or malformed input', async () => {
  const h = await hashPassword(PW, 5000);
  assert.match(h, /^p1\$5000\$/);
  assert.equal(await verifyPassword(PW, h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword(PW, 'p1$5000$not-base64$!!'), false);
  assert.equal(await verifyPassword(PW, 'p1$1$AAAA$AAAA'), false);                 // absurdly low iteration count is refused
  assert.equal(await verifyPassword(PW, 'garbage'), false);
  assert.notEqual(h, await hashPassword(PW, 5000));                                  // salted
  assert.equal(needsRehash(h, 5000), false);
  assert.equal(needsRehash(h, 6000), true);
});

test('old scrypt hashes still verify and are flagged for upgrade', async () => {
  const salt = randomBytes(16);
  const legacy = `s1$${salt.toString('base64')}$${scryptSync(PW, salt, 64).toString('base64')}`;
  assert.equal(await verifyPassword(PW, legacy), true);
  assert.equal(await verifyPassword('nope', legacy), false);
  assert.equal(needsRehash(legacy), true);
});

test('an account with a legacy hash can log in and is upgraded on the spot', async () => {
  const db = openDb(':memory:');
  const salt = randomBytes(16);
  const legacy = `s1$${salt.toString('base64')}$${scryptSync(PW, salt, 64).toString('base64')}`;
  db.prepare('INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, 1)').run('legacy@test.dev', 'Old User', legacy);
  const { server, base } = await start(db);
  try {
    const ok = await post(base, '/api/auth/login', { email: 'legacy@test.dev', password: PW });
    assert.equal(ok.status, 200);
    assert.match(db.prepare('SELECT pass_hash FROM users WHERE email = ?').get('legacy@test.dev').pass_hash, /^p1\$/);
    assert.equal((await post(base, '/api/auth/login', { email: 'legacy@test.dev', password: PW })).status, 200);     // still works afterwards
    assert.equal((await post(base, '/api/auth/login', { email: 'legacy@test.dev', password: 'wrong-wrong-wrong' })).status, 401);
  } finally { server.close(); }
});

test('login lockouts survive a restart and store no readable emails or addresses', async () => {
  const db = openDb(':memory:');
  const first = await start(db);
  const email = 'locked-out@test.dev';
  for (let i = 0; i < 5; i++) await post(first.base, '/api/auth/login', { email, password: 'wrong-wrong-wrong' });
  assert.equal((await post(first.base, '/api/auth/login', { email, password: PW })).status, 429);
  first.server.close();

  const second = await start(db);                                                 // a "restarted" server on the same database
  try {
    assert.equal((await post(second.base, '/api/auth/login', { email, password: PW })).status, 429);
  } finally { second.server.close(); }

  const keys = db.prepare('SELECT key FROM throttle').all().map((r) => r.key).join(' ');
  assert.ok(keys.length > 0);
  assert.ok(!keys.includes('locked-out'), 'email must not be stored in readable form');
  assert.ok(!keys.includes('127.0.0.1'), 'IP address must not be stored in readable form');
});

test('the database adapter returns plain rows and handles bigint ids and undefined arguments', async () => {
  const calls = [];
  const client = {
    async execute({ sql, args }) {
      calls.push({ sql, args });
      if (/INSERT/.test(sql)) return { rows: [], columns: [], rowsAffected: 1, lastInsertRowid: 42n };
      if (/EMPTY/.test(sql)) return { rows: [], columns: ['x'], rowsAffected: 0, lastInsertRowid: undefined };
      return { columns: ['id', 'email'], rows: [[1, 'a@x.co'], [2, 'b@x.co']], rowsAffected: 0 };
    },
  };
  const db = wrapClient(client);
  assert.deepEqual(await db.prepare('SELECT 1').get(), { id: 1, email: 'a@x.co' });
  assert.deepEqual(await db.prepare('SELECT 1').all(), [{ id: 1, email: 'a@x.co' }, { id: 2, email: 'b@x.co' }]);
  assert.equal(await db.prepare('EMPTY').get(), undefined);
  assert.deepEqual(await db.prepare('INSERT x').run('a', undefined), { changes: 1, lastInsertRowid: 42 });
  assert.deepEqual(calls.at(-1).args, ['a', null]);                                // undefined is sent as NULL, not dropped
});

test('webhook guard blocks private addresses, reserved names and names that resolve privately', async () => {
  for (const url of ['https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.9/x', 'https://[::1]/x', 'https://localhost/x', 'https://db.internal/x', 'https://printer.local/x']) {
    await assert.rejects(() => assertPublicHost(url), /private/, url);
  }
  await assert.rejects(() => assertPublicHost('https://evil.example/x', async () => ['10.1.2.3']), /private/);
  await assert.rejects(() => assertPublicHost('https://evil.example/x', async () => []), /private/);
  await assert.doesNotReject(() => assertPublicHost('https://example.com/x', async () => ['93.184.216.34']));
  await assert.doesNotReject(() => assertPublicHost('https://8.8.8.8/x'));
});
