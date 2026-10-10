import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./index.js";

/** Per-dialect migration folders: migrations/sqlite/*.sql and migrations/mysql/*.sql. */
export const MIGRATIONS_ROOT = join(import.meta.dirname, "migrations");

export function migrationsDir(dialect: Db["dialect"]): string {
  return join(MIGRATIONS_ROOT, dialect);
}

const SCHEMA_MIGRATIONS_DDL: Record<Db["dialect"], string> = {
  sqlite: "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  mysql: "CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(120) PRIMARY KEY, applied_at VARCHAR(32) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
};

/** Applies the dialect's `*.sql` files in name order, once each, recording them in schema_migrations. */
export async function migrate(db: Db, now: () => string = () => new Date().toISOString()): Promise<string[]> {
  await db.exec(SCHEMA_MIGRATIONS_DDL[db.dialect]);
  const applied = new Set((await db.all<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const dir = migrationsDir(db.dialect);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    await db.exec(readFileSync(join(dir, file), "utf8"));
    await db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", [file, now()]);
    ran.push(file);
  }
  return ran;
}
