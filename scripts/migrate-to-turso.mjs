// One-time copy of an existing local QRForge database into your Turso database.
//
//   npm run migrate:turso                      (copies data/qrforge.db, or data/legacy-local.db if that is all there is)
//   npm run migrate:turso -- path/to/old.db    (copies a specific file)
//
// Needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env. Safe to run more than once: rows that already exist are
// left alone. Sessions are not copied, so everyone simply logs in again.
import Database from 'libsql';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openDb } from '../server/db.js';
import { migrate, TABLES } from '../server/migrate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (process.env.TURSO_DATABASE_URL || '').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim();
if (!url || !authToken) {
  console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the .env file first.');
  process.exit(1);
}

const sourcePath = process.argv[2] || [join(root, 'data', 'qrforge.db'), join(root, 'data', 'legacy-local.db')].find(existsSync);
if (!sourcePath || !existsSync(sourcePath)) {
  console.error('No local database found to copy. Pass a path: npm run migrate:turso -- path/to/old.db');
  process.exit(1);
}

const src = new Database(sourcePath, { readonly: true });
const cache = join(tmpdir(), 'qrforge', `migrate-${createHash('sha1').update(url).digest('hex').slice(0, 10)}.db`);
const dst = openDb(cache, { url, authToken });   // also creates any missing tables in Turso

console.log(`Copying from ${sourcePath}`);
try {
  migrate(src, dst, console.log);
} catch (err) {
  console.error(`Nothing was copied: ${err.message}.`);
  process.exit(1);
}
dst.sync();
console.log('\nRows now in Turso:', Object.fromEntries(TABLES.map((t) => [t, dst.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n])));
dst.close();
src.close();
