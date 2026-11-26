import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

type DB = Database.Database;
const g = globalThis as unknown as { __aecDb?: DB; __aecDbPath?: string };

export function dbPath(): string {
  return g.__aecDbPath ?? process.env.AEC_DB_PATH ?? path.join(process.cwd(), "data", "aec.db");
}

/** Point the process at a different database file (used by tests and the seed script). */
export function useDatabase(file: string) {
  if (g.__aecDb) g.__aecDb.close();
  g.__aecDb = undefined;
  g.__aecDbPath = file;
}

export function db(): DB {
  if (!g.__aecDb) {
    const file = dbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = new Database(file);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = ON");
    conn.pragma("busy_timeout = 5000");
    migrate(conn);
    g.__aecDb = conn;
  }
  return g.__aecDb;
}

export function migrate(conn: DB) {
  conn.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const dir = path.join(process.cwd(), "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(conn.prepare("SELECT name FROM schema_migrations").all().map((r) => (r as { name: string }).name));
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    conn.transaction(() => {
      conn.exec(sql);
      conn.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
    })();
  }
}

export const tx = <T>(fn: () => T): T => db().transaction(fn)();
export const one = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => db().prepare(sql).get(...params) as T | undefined;
export const all = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => db().prepare(sql).all(...params) as T[];
export const run = (sql: string, ...params: unknown[]) => db().prepare(sql).run(...params);
export const scalar = <T = number>(sql: string, ...params: unknown[]) => {
  const r = db().prepare(sql).raw().get(...params) as unknown[] | undefined;
  return (r ? r[0] : undefined) as T;
};

export const J = {
  parse<T = unknown>(s: unknown, fallback: T): T {
    if (typeof s !== "string" || !s) return fallback;
    try { return JSON.parse(s) as T; } catch { return fallback; }
  },
  str: (v: unknown) => JSON.stringify(v ?? null),
};
