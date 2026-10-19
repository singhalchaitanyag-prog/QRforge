// Copies QRForge data from one database into another (used to move a local file into Turso).
// Parents are copied before children so foreign keys hold. Existing rows are never overwritten.
// Sessions and sign-in tickets are deliberately skipped: everyone just logs in again.
export const TABLES = ['users', 'links', 'scans', 'events'];

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

export function migrate(src, dst, log = () => {}) {
  // Refuse to mix two unrelated databases: every account already in the destination must also be in the source.
  const incoming = new Set(src.prepare('SELECT email FROM users').all().map((r) => r.email));
  const strangers = dst.prepare('SELECT email FROM users').all().map((r) => r.email).filter((e) => !incoming.has(e));
  if (strangers.length) throw new Error(`the destination already contains ${strangers.length} account(s) that are not in the source`);

  const report = {};
  for (const table of TABLES) {
    const dstCols = columns(dst, table);
    const cols = columns(src, table).filter((c) => dstCols.includes(c));
    const rows = src.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all();
    const insert = dst.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    let added = 0;
    for (const row of rows) added += insert.run(...cols.map((c) => row[c])).changes;
    report[table] = { found: rows.length, copied: added, skipped: rows.length - added };
    log(`  ${table}: ${rows.length} found, ${added} copied, ${rows.length - added} already there`);
  }
  return report;
}
