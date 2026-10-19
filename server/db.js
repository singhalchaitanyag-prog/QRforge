import Database from 'libsql';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Every table QRForge needs. Statements are idempotent, so this can be run against any existing database. */
export const SCHEMA = `
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      pass_hash     TEXT NOT NULL,
      api_key_hash  TEXT UNIQUE,
      api_key_hint  TEXT,
      brand_json    TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS links (
      id            INTEGER PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code          TEXT NOT NULL UNIQUE,
      kind          TEXT NOT NULL DEFAULT 'link',   -- 'link' | 'page'
      name          TEXT NOT NULL,
      dest_url      TEXT,
      page_json     TEXT,
      pass_hash     TEXT,
      expires_at    INTEGER,
      max_scans     INTEGER,
      active        INTEGER NOT NULL DEFAULT 1,
      webhook_url   TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_links_user ON links(user_id);

    CREATE TABLE IF NOT EXISTS scans (
      id       INTEGER PRIMARY KEY,
      link_id  INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      ts       INTEGER NOT NULL,
      device   TEXT,
      browser  TEXT,
      os       TEXT,
      country  TEXT,
      referrer TEXT,
      ip_hash  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scans_link_ts ON scans(link_id, ts);

    -- Short-lived tickets proving the password step passed while the second factor is still pending.
    CREATE TABLE IF NOT EXISTS login_tickets (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0
    );

    -- Attempt counters kept in the database (not in memory) so limits hold across server restarts and across
    -- Cloudflare Worker isolates, which each have their own memory.
    CREATE TABLE IF NOT EXISTS throttle (
      key          TEXT PRIMARY KEY,
      n            INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0
    );

    -- Account security activity shown to the owner.
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ts      INTEGER NOT NULL,
      type    TEXT NOT NULL,
      detail  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_user_ts ON events(user_id, ts);
`;

/** Columns added after the first release. Applied to databases created by earlier versions. */
export const COLUMN_UPGRADES = [
  ['users', 'name', 'TEXT'],
  ['users', 'totp_secret_enc', 'TEXT'],
  ['users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'totp_last_step', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'recovery_hashes', 'TEXT'],
  ['users', 'password_changed_at', 'INTEGER'],
  ['sessions', 'created_at', 'INTEGER'],
  ['sessions', 'user_agent', 'TEXT'],
];

/** Opens a local SQLite file (or ':memory:' for tests) and brings its schema up to date. */
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);

  // libSQL adds a `_metadata` timing field to rows from .get(); drop it so rows look the same as before
  // and can never leak into an API response by accident.
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    const get = stmt.get.bind(stmt);
    stmt.get = (...args) => { const row = get(...args); if (row && typeof row === 'object') delete row._metadata; return row; };
    return stmt;
  };

  for (const pragma of ['PRAGMA journal_mode = WAL', 'PRAGMA foreign_keys = ON']) {
    try { db.exec(pragma); } catch { /* not required for correctness */ }
  }
  db.exec(SCHEMA);
  for (const [table, column, ddl] of COLUMN_UPGRADES) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  return db;
}

/** Same as openDb, for a Turso database reached through @libsql/client. Safe to run repeatedly. */
export async function initRemote(client) {
  await client.executeMultiple(SCHEMA);
  for (const [table, column, ddl] of COLUMN_UPGRADES) {
    const info = await client.execute(`PRAGMA table_info(${table})`);
    if (!info.rows.some((r) => r.name === column)) await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
