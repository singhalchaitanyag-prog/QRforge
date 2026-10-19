import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { migrate } from '../server/migrate.js';
import { wrapSync } from '../server/dbadapter.js';

function seeded() {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO users (id, email, name, pass_hash, created_at) VALUES (1, ?, ?, ?, 1)').run('a@x.co', 'Asha', 'hash-a');
  db.prepare('INSERT INTO users (id, email, pass_hash, created_at) VALUES (2, ?, ?, 1)').run('b@x.co', 'hash-b');
  db.prepare("INSERT INTO links (id, user_id, code, kind, name, dest_url, created_at, updated_at) VALUES (7, 1, 'abc1234', 'link', 'Menu', 'https://x.co', 1, 1)").run();
  db.prepare('INSERT INTO scans (link_id, ts, device) VALUES (7, 100, ?)').run('Mobile');
  db.prepare('INSERT INTO scans (link_id, ts, device) VALUES (7, 200, ?)').run('Desktop');
  db.prepare("INSERT INTO events (user_id, ts, type) VALUES (1, 5, 'login')").run();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 1, 99999999999999)').run('tok');
  return db;
}

test('copies accounts, links, scans and events with their ids, but not sessions', async () => {
  const src = seeded(); const dst = openDb(':memory:');
  const report = await migrate(wrapSync(src), wrapSync(dst));
  assert.deepEqual(report.users, { found: 2, copied: 2, skipped: 0 });
  assert.deepEqual(report.scans, { found: 2, copied: 2, skipped: 0 });
  assert.equal(dst.prepare('SELECT pass_hash FROM users WHERE id = 1').get().pass_hash, 'hash-a');
  assert.equal(dst.prepare('SELECT name FROM users WHERE id = 1').get().name, 'Asha');
  assert.equal(dst.prepare('SELECT dest_url FROM links WHERE id = 7').get().dest_url, 'https://x.co');
  assert.equal(dst.prepare('SELECT COUNT(*) AS n FROM scans WHERE link_id = 7').get().n, 2);
  assert.equal(dst.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('running it twice does not duplicate anything', async () => {
  const src = seeded(); const dst = openDb(':memory:');
  await migrate(wrapSync(src), wrapSync(dst));
  const again = await migrate(wrapSync(src), wrapSync(dst));
  assert.equal(again.users.copied, 0);
  assert.equal(again.links.copied, 0);
  assert.equal(dst.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  assert.equal(dst.prepare('SELECT COUNT(*) AS n FROM links').get().n, 1);
});

test('refuses to merge into a database that holds other accounts, and changes nothing', async () => {
  const src = seeded(); const dst = openDb(':memory:');
  dst.prepare('INSERT INTO users (id, email, pass_hash, created_at) VALUES (1, ?, ?, 1)').run('stranger@x.co', 'h');
  await assert.rejects(() => migrate(wrapSync(src), wrapSync(dst)), /not in the source/);
  assert.equal(dst.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(dst.prepare('SELECT COUNT(*) AS n FROM links').get().n, 0);
});

test('copies only the columns both databases share (older source files)', async () => {
  const src = openDb(':memory:');
  src.exec('DROP TABLE events; CREATE TABLE events (id INTEGER PRIMARY KEY, user_id INTEGER, ts INTEGER, type TEXT, detail TEXT, legacy_only TEXT);');
  src.prepare('INSERT INTO users (id, email, pass_hash, created_at) VALUES (1, ?, ?, 1)').run('a@x.co', 'h');
  src.prepare("INSERT INTO events (user_id, ts, type, legacy_only) VALUES (1, 5, 'login', 'x')").run();
  const dst = openDb(':memory:');
  const report = await migrate(wrapSync(src), wrapSync(dst));
  assert.equal(report.events.copied, 1);
});
