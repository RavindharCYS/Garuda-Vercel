// utils/db.js — Dual-driver database layer.
//
//   Development (default): SQLite via better-sqlite3, file at ./db/garuda.db
//   Production:            PostgreSQL via `pg`, selected automatically when
//                           DATABASE_URL is set (Railway sets this for you
//                           when you attach a Postgres plugin).
//
// Every consumer in this codebase uses the same small async API instead of
// better-sqlite3's synchronous `db.prepare(sql).get/all/run()`:
//
//   await db.get(sql, [params])   -> single row | undefined
//   await db.all(sql, [params])   -> array of rows
//   await db.run(sql, [params])   -> { changes, lastInsertRowid }
//   await db.exec(sql)            -> run DDL / multi-statement SQL (no params)
//
// SQL is written once, in SQLite dialect (the original dialect this project
// was built in), using `?` placeholders. When running against Postgres,
// `toPgSql()` below transparently rewrites the handful of SQLite-only
// constructs this codebase relies on:
//   - `?` positional placeholders           -> `$1, $2, ...`
//   - `datetime('now')`                     -> `CURRENT_TIMESTAMP`
//   - `datetime('now', '-N hours')`         -> `(CURRENT_TIMESTAMP + INTERVAL '-N hours')`
//   - `datetime('now', ?)`                  -> `(CURRENT_TIMESTAMP + ($n)::interval)`
//   - `datetime(some_column)`               -> `some_column` (already a timestamp in PG)
//   - `INSERT OR IGNORE INTO ...`           -> `INSERT INTO ... ON CONFLICT DO NOTHING`
//   - `INTEGER PRIMARY KEY AUTOINCREMENT`   -> `SERIAL PRIMARY KEY`
// `ON CONFLICT(...) DO UPDATE SET x = excluded.x` upsert syntax already used
// in a few places is valid in both SQLite (3.24+) and Postgres, so it needs
// no rewriting.
'use strict';

const IS_PG = !!process.env.DATABASE_URL;

/** Rewrites SQLite-dialect SQL into Postgres-dialect SQL. No-op when !IS_PG. */
function toPgSql(sql) {
  let out = sql;

  // datetime('now', 'literal offset')  e.g. datetime('now', '-6 hours')
  out = out.replace(/datetime\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi, "(CURRENT_TIMESTAMP + INTERVAL '$1')");
  // datetime('now', ?)  -- offset supplied as a bind parameter
  out = out.replace(/datetime\(\s*'now'\s*,\s*\?\s*\)/gi, "(CURRENT_TIMESTAMP + (?)::interval)");
  // datetime('now')
  out = out.replace(/datetime\(\s*'now'\s*\)/gi, 'CURRENT_TIMESTAMP');
  // datetime(<column>) or datetime(COALESCE(...)) — strip wrapper; PG columns
  // that reach this point are already TIMESTAMPTZ, no normalization needed.
  out = out.replace(/datetime\(\s*(COALESCE\([^()]*\)|[A-Za-z_][A-Za-z0-9_.]*)\s*\)/gi, '$1');

  // DATE('now', 'literal offset')  e.g. DATE('now','-6 days')
  out = out.replace(/date\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi, "(CURRENT_DATE + INTERVAL '$1')");
  // DATE('now', ?)
  out = out.replace(/date\(\s*'now'\s*,\s*\?\s*\)/gi, "(CURRENT_DATE + (?)::interval)");
  // DATE('now')
  out = out.replace(/date\(\s*'now'\s*\)/gi, 'CURRENT_DATE');
  // DATE(<column>) is valid as-is in Postgres (casts a timestamp to a date) — no rewrite needed.

  // INSERT OR IGNORE INTO ... -> INSERT INTO ... ON CONFLICT DO NOTHING
  if (/insert\s+or\s+ignore\s+into/i.test(out)) {
    out = out.replace(/insert\s+or\s+ignore\s+into/i, 'INSERT INTO');
    out = out.replace(/;\s*$/, '');
    out = `${out} ON CONFLICT DO NOTHING`;
  }

  // Schema-only: autoincrement primary keys
  out = out.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');

  // Positional placeholders `?` -> `$1, $2, ...` — MUST be last, since several
  // of the rewrites above look for a literal `?` themselves.
  let i = 0;
  out = out.replace(/\?/g, () => `$${++i}`);

  return out;
}

let impl;

if (IS_PG) {
  const { Pool } = require('pg');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Most managed Postgres providers (Railway included) terminate TLS with a
    // certificate that isn't in Node's default trust store. PGSSL=disable
    // turns this off entirely for local/self-hosted Postgres without TLS.
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    max: parseInt(process.env.PG_POOL_SIZE || '10', 10),
  });

  pool.on('error', (err) => {
    // Idle client errors (dropped connections etc.) must not crash the process.
    console.error('[db] Unexpected Postgres pool error:', err.message);
  });

  impl = {
    dialect: 'postgres',
    isPg: true,
    pool,
    async get(sql, params = []) {
      const res = await pool.query(toPgSql(sql), params);
      return res.rows[0];
    },
    async all(sql, params = []) {
      const res = await pool.query(toPgSql(sql), params);
      return res.rows;
    },
    async run(sql, params = []) {
      const res = await pool.query(toPgSql(sql), params);
      const row0 = res.rows && res.rows[0];
      return {
        changes: res.rowCount || 0,
        lastInsertRowid: row0 && row0.id != null ? row0.id : undefined,
      };
    },
    async exec(sql) {
      await pool.query(toPgSql(sql));
    },
    async close() {
      await pool.end();
    },
  };
} else {
  const Database = require('better-sqlite3');
  const path = require('path');
  const fs = require('fs');

  const DB_DIR = path.join(__dirname, '../db');
  const DB_PATH = process.env.SQLITE_PATH || path.join(DB_DIR, 'garuda.db');
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

  const raw = new Database(DB_PATH);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');

  impl = {
    dialect: 'sqlite',
    isPg: false,
    raw,
    async get(sql, params = []) {
      return raw.prepare(sql).get(...params);
    },
    async all(sql, params = []) {
      return raw.prepare(sql).all(...params);
    },
    async run(sql, params = []) {
      const info = raw.prepare(sql).run(...params);
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
    async exec(sql) {
      raw.exec(sql);
    },
    async close() {
      raw.close();
    },
  };
}

module.exports = impl;
