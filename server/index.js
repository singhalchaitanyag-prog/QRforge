import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openDb, initRemote } from './db.js';
import { connectTurso } from './turso.js';
import { wrapClient } from './dbadapter.js';
import { createApp } from './app.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

/* ---- database: a local SQLite file by default, or a Turso database reached over HTTPS ---- */
const tursoUrl = (env.TURSO_DATABASE_URL || '').trim();
const tursoToken = (env.TURSO_AUTH_TOKEN || '').trim();
const useTurso = !!tursoUrl;

function fail(message) {
  console.error(`\nCannot start: ${message}\n`);
  process.exit(1);
}

if (useTurso && !/^(libsql|https?|wss?):\/\//.test(tursoUrl)) fail('TURSO_DATABASE_URL must look like libsql://your-database.turso.io');
if (useTurso && !tursoToken) fail('TURSO_AUTH_TOKEN is empty. Create a token for your database in the Turso dashboard and put it in the .env file.');
if (useTurso && !env.APP_SECRET) {
  // The secret encrypts two-step verification seeds that live in the cloud database. A secret kept on a disk that
  // can be wiped on deploy would make those seeds unreadable, so it must be provided explicitly.
  fail('APP_SECRET is required when using Turso. Set it to a long random string and never change it.');
}

const dbPath = env.DB_PATH || join(root, 'data', 'qrforge.db');          // local-file mode only

/**
 * The app secret encrypts two-factor seeds and salts visitor hashes, so it must survive restarts.
 * Use APP_SECRET when provided; otherwise (local file mode only) create one next to the database.
 */
function loadSecret() {
  if (env.APP_SECRET) return env.APP_SECRET;
  const file = join(dirname(dbPath), 'app.secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dirname(file), { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  console.log(`Generated a new app secret at ${file}. Keep it private and back it up with the database.`);
  return secret;
}

const config = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || '').replace(/\/$/, ''),          // e.g. https://qrforge.example.com
  publicDir: join(root, 'public'),
  secureCookies: env.COOKIE_SECURE === '1' || (env.BASE_URL || '').startsWith('https://'),
  trustProxy: env.TRUST_PROXY === '1',                        // set when behind a reverse proxy / CDN
  secret: loadSecret(),
  authLimitPerMinute: Number(env.AUTH_LIMIT_PER_MINUTE) || undefined,   // sign-in attempts per IP per minute (default 15)
  pbkdf2Iterations: Number(env.PBKDF2_ITERATIONS) || undefined,
};

let app;
let closeDb = () => {};
try {
  if (useTurso) {
    const client = connectTurso({ url: tursoUrl, authToken: tursoToken });
    await initRemote(client);                                  // creates or upgrades tables; also proves the connection works
    app = createApp({ asyncDb: wrapClient(client), config });
    closeDb = () => client.close();
  } else {
    const db = openDb(dbPath);
    app = createApp({ db, config });
    closeDb = () => db.close();
  }
} catch (err) {
  fail(useTurso
    ? `could not connect to Turso (${err.message}). Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.`
    : `could not open the database (${err.message}).`);
}

app.listen(config.port, () => {
  console.log(`QRForge running on ${config.baseUrl || `http://localhost:${config.port}`}`);
  console.log(useTurso ? `Database: Turso (${new URL(tursoUrl.replace(/^libsql:/, 'https:')).host})` : `Database: local file ${dbPath}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => app.close(() => { try { closeDb(); } catch { /* already closed */ } process.exit(0); }));
}
