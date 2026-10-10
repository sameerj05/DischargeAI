import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { resolveSqlDriver, type Config } from "../config.js";
import type { Logger } from "../logger.js";

export type SqlParam = string | number | bigint | Buffer | Uint8Array | null;

/**
 * A thin, dialect-neutral SQL adapter. SQL is written with `?` placeholders and the subset both
 * engines share; the one statement whose syntax differs (upsert) is a method. Two dialects:
 *   sqlite  better-sqlite3, the default for local runs and the test suite
 *   mysql   mysql2 against the team's RDS MariaDB instance (src/db/mysql.ts)
 * Migrations are per dialect (src/db/migrations/<dialect>/*.sql).
 */
export interface Db {
  readonly dialect: "sqlite" | "mysql";
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number }>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  /** Runs one or more statements (migrations). */
  exec(sql: string): Promise<void>;
  /** Insert or update by the key columns. */
  upsert(table: string, keyColumns: string[], row: Record<string, SqlParam>): Promise<void>;
  close(): Promise<void>;
}

/** `INSERT ... ON CONFLICT (keys) DO UPDATE SET ...` (SQLite). */
export function onConflictUpsertSql(table: string, keyColumns: string[], columns: string[]): string {
  const updates = columns.filter((c) => !keyColumns.includes(c)).map((c) => `${c} = excluded.${c}`);
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
    ON CONFLICT (${keyColumns.join(", ")}) DO UPDATE SET ${updates.join(", ")}`;
}

export class SqliteDb implements Db {
  readonly dialect = "sqlite" as const;
  readonly raw: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.raw = new Database(file);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
  }

  async run(sql: string, params: SqlParam[] = []) {
    const info = this.raw.prepare(sql).run(...params);
    return { changes: info.changes };
  }

  async upsert(table: string, keyColumns: string[], row: Record<string, SqlParam>) {
    const columns = Object.keys(row);
    await this.run(onConflictUpsertSql(table, keyColumns, columns), columns.map((c) => row[c]));
  }

  async get<T>(sql: string, params: SqlParam[] = []) {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  async all<T>(sql: string, params: SqlParam[] = []) {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  async exec(sql: string) {
    this.raw.exec(sql);
  }

  async close() {
    this.raw.close();
  }
}

export interface SqlConnection {
  db: Db;
  /** What SQL_DRIVER resolved to before any fallback. */
  requested: "sqlite" | "mysql";
  /** Set when MySQL was wanted (SQL_DRIVER=auto) but unreachable and SQLite took over. */
  fallback?: { from: "mysql"; reason: string };
  /** For /health and logs: never the password. */
  target: string;
}

/**
 * Opens the SQL database SQL_DRIVER resolves to. `auto` with a known MySQL host tries the team's
 * MariaDB first and, when it is unreachable (the build container cannot reach port 3306, a laptop
 * off the VPC), falls back to SQLite and says so; `SQL_DRIVER=mysql` makes that a hard failure.
 */
export async function connectSql(config: Config, log?: Logger): Promise<SqlConnection> {
  const requested = resolveSqlDriver(config);
  if (requested === "mysql") {
    const { MysqlDb, describeMysqlTarget } = await import("./mysql.js");
    const target = describeMysqlTarget(config);
    try {
      const db = await MysqlDb.connect(config, log);
      log?.info({ sql: "mysql", target }, "SQL: connected to MariaDB/MySQL");
      return { db, requested, target };
    } catch (err) {
      const reason = String((err as Error)?.message ?? err).slice(0, 200);
      if (config.SQL_DRIVER === "mysql") throw new Error(`SQL_DRIVER=mysql but ${target} is unreachable: ${reason}`);
      log?.warn({ sql: "sqlite", wanted: "mysql", target, reason }, "SQL: MySQL unreachable; falling back to SQLite (SQL_DRIVER=auto)");
      return { db: new SqliteDb(config.DATABASE_FILE), requested, fallback: { from: "mysql", reason }, target: config.DATABASE_FILE };
    }
  }
  return { db: new SqliteDb(config.DATABASE_FILE), requested, target: config.DATABASE_FILE };
}

/** SQLite only; scripts and tests that never want MySQL. */
export async function openDb(config: Pick<Config, "DATABASE_FILE">): Promise<Db> {
  return new SqliteDb(config.DATABASE_FILE);
}
