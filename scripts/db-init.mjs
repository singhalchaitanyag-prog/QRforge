// Creates or upgrades the QRForge tables in your Turso database. Safe to run any number of times.
// Run it once for a new database, and again after an update that changes the schema:
//   npm run db:init
// (The Cloudflare Worker never creates tables itself, so this is the only place the schema is applied there.)
import { initRemote } from '../server/db.js';
import { connectTurso } from '../server/turso.js';

const url = (process.env.TURSO_DATABASE_URL || '').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim();
if (!url || !authToken) {
  console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the .env file first.');
  process.exit(1);
}
const client = connectTurso({ url, authToken });
await initRemote(client);
const rs = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
console.log(`Schema is up to date. Tables in Turso: ${rs.rows.map((r) => r.name).join(', ')}`);
client.close();
