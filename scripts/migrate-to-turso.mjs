// One-time copy of an existing local QRForge database into your Turso database.
//
//   npm run migrate:turso                      (copies data/qrforge.db)
//   npm run migrate:turso -- path/to/old.db    (copies a specific file)
//
// Needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env. Safe to run more than once: rows that already exist are
// left alone. Sessions are not copied, so everyone simply logs in again.
import Database from 'libsql';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRemote } from '../server/db.js';
import { connectTurso } from '../server/turso.js';
import { wrapClient, wrapSync } from '../server/dbadapter.js';
import { migrate, TABLES } from '../server/migrate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (process.env.TURSO_DATABASE_URL || '').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim();
if (!url || !authToken) {
  console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the .env file first.');
  process.exit(1);
}

const sourcePath = process.argv[2] || join(root, 'data', 'qrforge.db');
if (!existsSync(sourcePath)) {
  console.error(`No local database found at ${sourcePath}. Pass a path: npm run migrate:turso -- path/to/old.db`);
  process.exit(1);
}

const src = new Database(sourcePath, { readonly: true });
const client = connectTurso({ url, authToken });
await initRemote(client);                                   // makes sure every table exists in Turso first
const dst = wrapClient(client);

console.log(`Copying from ${sourcePath}`);
try {
  await migrate(wrapSync(src), dst, console.log);
} catch (err) {
  console.error(`Nothing was copied: ${err.message}.`);
  process.exit(1);
}
const counts = {};
for (const t of TABLES) counts[t] = (await dst.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n;
console.log('\nRows now in Turso:', counts);
client.close();
src.close();
