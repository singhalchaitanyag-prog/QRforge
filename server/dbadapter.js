// A small async facade so the application code is written once and runs on either database driver:
//   wrapSync(db)     the synchronous libsql file database used by Node (and by the tests)
//   wrapClient(c)    the @libsql/client web client used by the Cloudflare Worker, which talks to Turso over HTTPS
// Both expose db.prepare(sql) -> { get, all, run }, every method returning a Promise.

const nullify = (args) => args.map((a) => (a === undefined ? null : a));

export function wrapSync(db) {
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      return {
        get: async (...a) => st.get(...nullify(a)),
        all: async (...a) => st.all(...nullify(a)),
        run: async (...a) => {
          const r = st.run(...nullify(a));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
      };
    },
  };
}

export function wrapClient(client) {
  const toObject = (rs, row) => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]]));
  return {
    prepare(sql) {
      const exec = (a) => client.execute({ sql, args: nullify(a) });
      return {
        get: async (...a) => { const rs = await exec(a); return rs.rows[0] ? toObject(rs, rs.rows[0]) : undefined; },
        all: async (...a) => { const rs = await exec(a); return rs.rows.map((r) => toObject(rs, r)); },
        run: async (...a) => {
          const rs = await exec(a);
          return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? 0 : Number(rs.lastInsertRowid) };
        },
      };
    },
  };
}
