import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Config } from "../config.js";

export type SqlParam = string | number | bigint | Buffer | Uint8Array | null;

/**
 * A thin, dialect-neutral SQL adapter. SQL is written with `?` placeholders and portable types
 * (TEXT, INTEGER, BLOB); the Postgres adapter rewrites placeholders to `$n` and BLOB to BYTEA.
 * Everything is async so both drivers share one interface.
 */
export interface Db {
  readonly dialect: "sqlite" | "pg";
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number }>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** Insert or update by the key columns; the one statement whose syntax differs per dialect. */
  upsert(table: string, keyColumns: string[], row: Record<string, SqlParam>): Promise<void>;
  close(): Promise<void>;
}

/** `INSERT ... ON CONFLICT (keys) DO UPDATE SET ...` for SQLite and Postgres. */
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

/** Postgres adapter over `pg`. Loaded lazily so SQLite-only installs never import the driver. */
export class PgDb implements Db {
  readonly dialect = "pg" as const;
  private constructor(private readonly pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>; end: () => Promise<void> }) {}

  static async connect(connectionString: string): Promise<PgDb> {
    const pg = await import("pg");
    const Pool = (pg.default ?? pg).Pool;
    const pool = new Pool({ connectionString });
    return new PgDb(pool);
  }

  private translate(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`).replace(/\bBLOB\b/g, "BYTEA");
  }

  async run(sql: string, params: SqlParam[] = []) {
    const r = await this.pool.query(this.translate(sql), params);
    return { changes: r.rowCount ?? 0 };
  }

  async upsert(table: string, keyColumns: string[], row: Record<string, SqlParam>) {
    const columns = Object.keys(row);
    await this.run(onConflictUpsertSql(table, keyColumns, columns), columns.map((c) => row[c]));
  }

  async get<T>(sql: string, params: SqlParam[] = []) {
    const r = await this.pool.query(this.translate(sql), params);
    return r.rows[0] as T | undefined;
  }

  async all<T>(sql: string, params: SqlParam[] = []) {
    const r = await this.pool.query(this.translate(sql), params);
    return r.rows as T[];
  }

  async exec(sql: string) {
    await this.pool.query(this.translate(sql));
  }

  async close() {
    await this.pool.end();
  }
}

export async function openDb(config: Pick<Config, "DATABASE_URL" | "DATABASE_FILE">): Promise<Db> {
  if (config.DATABASE_URL) return PgDb.connect(config.DATABASE_URL);
  return new SqliteDb(config.DATABASE_FILE);
}
