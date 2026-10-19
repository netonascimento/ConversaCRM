// node:sqlite (DatabaseSync) implementado sobre sql.js (SQLite compilado para WebAssembly).
const norm = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  all(...params) {
    const st = this.db.prepare(this.sql);
    try {
      st.bind(norm(params));
      const rows = [];
      while (st.step()) rows.push(st.getAsObject());
      return rows;
    } finally { st.free(); }
  }
  get(...params) { return this.all(...params)[0]; }
  run(...params) {
    const st = this.db.prepare(this.sql);
    try { st.run(norm(params)); } finally { st.free(); }
    const changes = this.db.getRowsModified();
    const lastInsertRowid = this.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    return { changes, lastInsertRowid };
  }
}
export class DatabaseSync {
  constructor() { this.db = new globalThis.__SQL.Database(); }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) { return new Statement(this.db, sql); }
  close() { this.db.close(); }
}
