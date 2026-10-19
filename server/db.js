import Database from 'libsql';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Opens the database.
 *  - Local only (default): a plain SQLite file, or ':memory:' for tests.
 *  - With `remote: { url, authToken }`: the file at `path` becomes an embedded replica of a Turso database.
 *    Reads are served locally; writes are sent to Turso and then appear in the local copy, so the data
 *    survives hosts that wipe their disk on every deploy. Turso stays the source of truth.
 */
export function openDb(path, remote = null) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = remote?.url
    ? new Database(path, { syncUrl: remote.url, authToken: remote.authToken })
    : new Database(path);
  if (remote?.url) db.sync();                      // pull the latest data before serving anything

  // libSQL adds a `_metadata` timing field to rows from .get(); drop it so rows look the same as before
  // and can never leak into an API response by accident.
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    const get = stmt.get.bind(stmt);
    stmt.get = (...args) => { const row = get(...args); if (row && typeof row === 'object') delete row._metadata; return row; };
    return stmt;
  };

  // Not every libSQL mode supports every pragma, and none of them are required for correctness.
  for (const pragma of ['PRAGMA journal_mode = WAL', 'PRAGMA foreign_keys = ON']) {
    try { db.exec(pragma); } catch { /* unsupported in this mode */ }
  }

  db.exec(`
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

    -- Account security activity shown to the owner.
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ts      INTEGER NOT NULL,
      type    TEXT NOT NULL,
      detail  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_user_ts ON events(user_id, ts);
  `);

  // In-place upgrades for databases created by earlier versions.
  const addColumn = (table, column, ddl) => {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  };
  addColumn('users', 'name', 'TEXT');
  addColumn('users', 'totp_secret_enc', 'TEXT');
  addColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'totp_last_step', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'recovery_hashes', 'TEXT');
  addColumn('users', 'password_changed_at', 'INTEGER');
  addColumn('sessions', 'created_at', 'INTEGER');
  addColumn('sessions', 'user_agent', 'TEXT');
  return db;
}
