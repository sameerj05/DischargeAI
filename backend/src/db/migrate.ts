import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitStatements, type Db } from "./index.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

/**
 * The migrations are written in portable SQL and rewritten for MariaDB/MySQL here: AUTOINCREMENT ->
 * AUTO_INCREMENT; BLOB -> LONGBLOB; TEXT -> MEDIUMTEXT (JSON blobs); CREATE INDEX IF NOT EXISTS ->
 * CREATE INDEX (MariaDB accepts IF NOT EXISTS, MySQL 8 does not; a duplicate index is ignored instead).
 */
export function toMysql(sql: string): string {
  return sql
    .replace(/\bAUTOINCREMENT\b/g, "AUTO_INCREMENT")
    .replace(/\bBLOB\b/g, "LONGBLOB")
    .replace(/\bTEXT\b/g, "MEDIUMTEXT")
    .replace(/CREATE INDEX IF NOT EXISTS/g, "CREATE INDEX");
}

function isDuplicateIndex(err: unknown): boolean {
  const e = err as { code?: string; errno?: number };
  return e?.code === "ER_DUP_KEYNAME" || e?.errno === 1061;
}

/** MySQL 1091: dropping a foreign key that is not there (a database created by the current 0001). */
function isMissingKey(err: unknown): boolean {
  const e = err as { code?: string; errno?: number };
  return e?.code === "ER_CANT_DROP_FIELD_OR_KEY" || e?.errno === 1091;
}

/** The migration files in name order. The recorded names are what `schema_migrations` holds, so never rename an applied one. */
export function migrationFiles(files: string[]): string[] {
  return files.filter((f) => f.endsWith(".sql")).sort();
}

/** Tables the backend's own schema must have (the patients table is the team's and is checked on its own). */
export const REQUIRED_TABLES = ["activeLinks", "jobs", "audit_log"] as const;

/** The tables the first, pre-contract 0001_init.sql created (all this backend's own), children first. */
export const PRE_CONTRACT_TABLES = ["documents", "jobs", "audit_log", "links", "patients"] as const;
export const PRE_CONTRACT_SUFFIX = "_pre_contract";

export async function tableExists(db: Db, table: string): Promise<boolean> {
  const row = await db.get("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [table]);
  return !!row;
}

/**
 * A database first migrated by the pre-contract backend (before the team's tasks doc) records
 * 0001_init.sql as applied but holds that version's tables: `patients` (with the synthetic patients it
 * seeded), `links`, `jobs`, `audit_log` and `documents`, and no `activeLinks`. Two of those names are
 * reused by the current schema with other columns. So, once: rename every one of them to
 * `<name>_pre_contract` (nothing is deleted; drop them by hand when no longer wanted), forget the old
 * 0001 record, and let the current migrations build the schema. The team's `patientinfo` is never
 * touched. Returns the renamed tables.
 */
export async function setAsidePreContractSchema(db: Db): Promise<string[]> {
  const applied = await db.get("SELECT name FROM schema_migrations WHERE name = ?", ["0001_init.sql"]);
  if (!applied || (await tableExists(db, "activeLinks"))) return [];
  const present: string[] = [];
  for (const t of PRE_CONTRACT_TABLES) if (await tableExists(db, t)) present.push(t);
  for (const t of present) {
    if (await tableExists(db, `${t}${PRE_CONTRACT_SUFFIX}`)) {
      throw new Error(`Cannot set aside the pre-contract table "${t}": "${t}${PRE_CONTRACT_SUFFIX}" already exists. Drop or rename one of them by hand.`);
    }
  }
  for (const t of present) await db.exec(`ALTER TABLE \`${t}\` RENAME TO \`${t}${PRE_CONTRACT_SUFFIX}\``);
  await db.run("DELETE FROM schema_migrations WHERE name = ?", ["0001_init.sql"]);
  return present;
}

/**
 * MySQL/MariaDB (InnoDB) foreign key names are unique per database, and the pre-contract `jobs` table
 * keeps `fk_jobs_link`, the name the current `jobs` uses. Drop the foreign keys of every set-aside
 * table (constraints only, no rows). Idempotent, so it also completes an upgrade that stopped half way
 * (MySQL DDL is not transactional). Returns "table.constraint" for each one dropped.
 */
export async function detachPreContractForeignKeys(db: Db): Promise<string[]> {
  const names = PRE_CONTRACT_TABLES.map((t) => `${t}${PRE_CONTRACT_SUFFIX}`);
  const rows = await db.all<{ t: string; c: string }>(
    `SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS c FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME IN (${names.map(() => "?").join(", ")})`,
    names,
  );
  for (const r of rows) await db.exec(`ALTER TABLE \`${r.t}\` DROP FOREIGN KEY \`${r.c}\``);
  return rows.map((r) => `${r.t}.${r.c}`);
}

/** Applies `migrations/*.sql` in name order, once each, recording them in schema_migrations. */
export async function migrate(db: Db, now: () => string = () => new Date().toISOString(), onSetAside?: (tables: string[]) => void): Promise<string[]> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(120) PRIMARY KEY, applied_at VARCHAR(32) NOT NULL)");
  const setAside = await setAsidePreContractSchema(db);
  const detached = await detachPreContractForeignKeys(db);
  if (setAside.length || detached.length) onSetAside?.([...setAside.map((t) => `${t} -> ${t}${PRE_CONTRACT_SUFFIX}`), ...detached.map((k) => `foreign key ${k} dropped`)]);
  const applied = new Set((await db.all<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const files = migrationFiles(readdirSync(MIGRATIONS_DIR));
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = toMysql(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    for (const statement of splitStatements(sql)) {
      try {
        await db.exec(statement);
      } catch (err) {
        if (/^CREATE INDEX/i.test(statement) && isDuplicateIndex(err)) continue;
        if (/DROP FOREIGN KEY/i.test(statement) && isMissingKey(err)) continue;
        throw err;
      }
    }
    await db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", [file, now()]);
    ran.push(file);
  }
  await assertSchema(db);
  return ran;
}

/** Every table the current schema needs must be there after migrating; say which one is not instead of failing on the first query. */
async function assertSchema(db: Db): Promise<void> {
  for (const table of REQUIRED_TABLES) {
    try {
      await db.get(`SELECT 1 FROM ${table} LIMIT 1`);
    } catch {
      throw new Error(
        `SQL schema is incomplete: table "${table}" is missing after the migrations ran. Check schema_migrations against src/db/migrations/.`,
      );
    }
  }
}
