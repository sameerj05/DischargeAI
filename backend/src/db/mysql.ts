import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Pool, PoolOptions, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Db, SqlParam } from "./index.js";

export const BACKEND_ROOT = join(import.meta.dirname, "..", "..");

/**
 * MariaDB/MySQL over mysql2 (promise API, connection pool), the team's production database:
 * RDS instance `patients` (MariaDB, IAM auth enabled; the backend uses the admin password from
 * Secrets Manager). TLS follows the AWS "connection steps": the global CA bundle from step 1
 * (`scripts/fetch-rds-bundle.sh`, committed at backend/certs/global-bundle.pem, env RDS_CA_BUNDLE)
 * goes in `ssl.ca`, so the server certificate is verified (the `--ssl-verify-server-cert` of step 2).
 * The database named by MYSQL_DATABASE (secret key `mysql-db`) is created when missing, then used.
 * Queries use `pool.query` with `?` placeholders (client-side escaping), the same SQL as SQLite
 * except the upsert, which is `ON DUPLICATE KEY UPDATE` here.
 */
export class MysqlDb implements Db {
  readonly dialect = "mysql" as const;

  private constructor(private readonly pool: Pool) {}

  static async connect(config: Config, log?: Logger): Promise<MysqlDb> {
    const mysql = await import("mysql2/promise");
    const base = poolOptions(config);
    // 1. Make sure the database exists (needs CREATE on the server; the admin user has it).
    const admin = mysql.createPool({ ...base, database: undefined, connectionLimit: 1 });
    try {
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${escapeIdent(config.MYSQL_DATABASE)}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } catch (err) {
      // Without the privilege the database must already exist; the probe below tells.
      log?.warn({ database: config.MYSQL_DATABASE, err: { message: (err as Error).message } }, "SQL: could not CREATE DATABASE; assuming it exists");
    } finally {
      await admin.end().catch(() => undefined);
    }
    // 2. The real pool on that database, probed once so a bad host fails here, not on the first request.
    const pool = mysql.createPool(base);
    try {
      await pool.query("SELECT 1");
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw err;
    }
    return new MysqlDb(pool);
  }

  async run(sql: string, params: SqlParam[] = []) {
    const [r] = await this.pool.query<ResultSetHeader>(sql, params);
    return { changes: r.affectedRows ?? 0 };
  }

  async get<T>(sql: string, params: SqlParam[] = []) {
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    return rows[0] as T | undefined;
  }

  async all<T>(sql: string, params: SqlParam[] = []) {
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    return rows as T[];
  }

  async exec(sql: string) {
    for (const statement of splitStatements(sql)) await this.pool.query(statement);
  }

  async upsert(table: string, keyColumns: string[], row: Record<string, SqlParam>) {
    const columns = Object.keys(row);
    await this.run(onDuplicateKeyUpsertSql(table, keyColumns, columns), columns.map((c) => row[c]));
  }

  async close() {
    await this.pool.end();
  }
}

/** `INSERT ... ON DUPLICATE KEY UPDATE col = VALUES(col)` (MySQL and MariaDB). */
export function onDuplicateKeyUpsertSql(table: string, keyColumns: string[], columns: string[]): string {
  const updates = columns.filter((c) => !keyColumns.includes(c)).map((c) => `${c} = VALUES(${c})`);
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
    ON DUPLICATE KEY UPDATE ${updates.length ? updates.join(", ") : `${keyColumns[0]} = ${keyColumns[0]}`}`;
}

/** Splits a migration file into statements: `--` comment lines dropped, split on `;` at end of line. */
export function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function resolveBundlePath(configured: string): string {
  if (isAbsolute(configured)) return configured;
  const underBackend = join(BACKEND_ROOT, configured);
  if (existsSync(underBackend)) return underBackend;
  return join(process.cwd(), configured);
}

/** Host:port/database for logs and /health; never the password. */
export function describeMysqlTarget(config: Pick<Config, "MYSQL_HOST" | "MYSQL_PORT" | "MYSQL_DATABASE" | "MYSQL_USER">): string {
  return `mysql://${config.MYSQL_USER ?? "?"}@${config.MYSQL_HOST ?? "?"}:${config.MYSQL_PORT}/${config.MYSQL_DATABASE}`;
}

export function poolOptions(config: Config): PoolOptions {
  if (!config.MYSQL_HOST) throw new Error("MYSQL_HOST is not set (env, DATABASE_URL=mysql://..., or the Secrets Manager secret)");
  if (!config.MYSQL_USER) throw new Error("MYSQL_USER is not set");
  let ssl: PoolOptions["ssl"];
  if (config.MYSQL_SSL === "required") {
    const bundle = resolveBundlePath(config.RDS_CA_BUNDLE);
    if (!existsSync(bundle)) {
      throw new Error(`RDS CA bundle not found at ${bundle}; run scripts/fetch-rds-bundle.sh (AWS connection step 1) or set RDS_CA_BUNDLE`);
    }
    ssl = { ca: readFileSync(bundle), rejectUnauthorized: true, minVersion: "TLSv1.2" };
  }
  return {
    host: config.MYSQL_HOST,
    port: config.MYSQL_PORT,
    user: config.MYSQL_USER,
    password: config.MYSQL_PASSWORD,
    database: config.MYSQL_DATABASE,
    ssl,
    waitForConnections: true,
    connectionLimit: 5,
    maxIdle: 5,
    idleTimeout: 60_000,
    connectTimeout: 5_000,
    enableKeepAlive: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: true,
    multipleStatements: false,
    charset: "utf8mb4",
  };
}

function escapeIdent(name: string): string {
  return name.replace(/`/g, "``");
}
