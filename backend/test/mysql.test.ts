import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Parser } from "node-sql-parser";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { connectSql, onConflictUpsertSql, SqliteDb } from "../src/db/index.js";
import { migrate, migrationsDir } from "../src/db/migrate.js";
import { MysqlDb, describeMysqlTarget, onDuplicateKeyUpsertSql, poolOptions, resolveBundlePath, splitStatements } from "../src/db/mysql.js";

const localEnv = { SECRETS_BOOTSTRAP: "off", DATABASE_FILE: ":memory:", LOG_LEVEL: "silent" };

describe("MySQL/MariaDB adapter (mysql2); port 3306 is not reachable from the build container, so the pool is faked here", () => {
  it("writes the upsert as ON DUPLICATE KEY UPDATE and SQLite's as ON CONFLICT", () => {
    expect(onDuplicateKeyUpsertSql("checklist_state", ["link_id_hash", "item_id"], ["link_id_hash", "item_id", "completed", "updated_at"]).replace(/\s+/g, " ")).toBe(
      "INSERT INTO checklist_state (link_id_hash, item_id, completed, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE completed = VALUES(completed), updated_at = VALUES(updated_at)",
    );
    expect(onConflictUpsertSql("checklist_state", ["link_id_hash", "item_id"], ["link_id_hash", "item_id", "completed"]).replace(/\s+/g, " ")).toBe(
      "INSERT INTO checklist_state (link_id_hash, item_id, completed) VALUES (?, ?, ?) ON CONFLICT (link_id_hash, item_id) DO UPDATE SET completed = excluded.completed",
    );
  });

  it("splits a migration file into statements, dropping comment lines", () => {
    expect(splitStatements("-- a comment\nCREATE TABLE a (x INT);\n\nINSERT INTO a VALUES (1);\n-- trailing\n")).toEqual(["CREATE TABLE a (x INT)", "INSERT INTO a VALUES (1)"]);
    expect(splitStatements("CREATE TABLE b (\n  s VARCHAR(8) NOT NULL,\n  CHECK (s IN ('a; b', 'c'))\n);")).toEqual(["CREATE TABLE b (\n  s VARCHAR(8) NOT NULL,\n  CHECK (s IN ('a; b', 'c'))\n)"]);
  });

  it("builds the pool with TLS from the committed RDS bundle (AWS connection step 1), never without a host", () => {
    const config = loadConfig({ ...localEnv, MYSQL_HOST: "patients.example.us-west-2.rds.amazonaws.com", MYSQL_USER: "admin", MYSQL_PASSWORD: "s3cret-pw" });
    const opts = poolOptions(config);
    expect(opts).toMatchObject({ host: "patients.example.us-west-2.rds.amazonaws.com", port: 3306, user: "admin", database: "dischargeai", connectionLimit: 5, multipleStatements: false });
    const ssl = opts.ssl as { ca: Buffer; rejectUnauthorized: boolean; minVersion: string };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.minVersion).toBe("TLSv1.2");
    expect(ssl.ca.toString("utf8").startsWith("-----BEGIN CERTIFICATE-----")).toBe(true);
    expect(ssl.ca.toString("utf8").split("-----BEGIN CERTIFICATE-----").length).toBeGreaterThan(50);
    expect(resolveBundlePath("certs/global-bundle.pem")).toBe(join(import.meta.dirname, "..", "certs", "global-bundle.pem"));
    expect(poolOptions(loadConfig({ ...localEnv, MYSQL_HOST: "h", MYSQL_USER: "u", MYSQL_SSL: "off" })).ssl).toBeUndefined();
    expect(() => poolOptions(loadConfig({ ...localEnv, MYSQL_HOST: "h", MYSQL_USER: "u", RDS_CA_BUNDLE: "/nope/bundle.pem" }))).toThrow(/fetch-rds-bundle/);
    expect(() => poolOptions(loadConfig({ ...localEnv, MYSQL_USER: "u" }))).toThrow(/MYSQL_HOST/);
    expect(describeMysqlTarget(config)).toBe("mysql://admin@patients.example.us-west-2.rds.amazonaws.com:3306/dischargeai");
    expect(describeMysqlTarget(config)).not.toContain("s3cret-pw");
  });

  it("the MySQL migration parses as MariaDB DDL and defines the same tables and columns as the SQLite schema", async () => {
    const parser = new Parser();
    const mysqlSql = readFileSync(join(migrationsDir("mysql"), "0001_init.sql"), "utf8");
    const statements = splitStatements(mysqlSql);
    expect(statements.length).toBe(6);
    const tables: Record<string, string[]> = {};
    for (const s of statements) {
      // `status` is a non-reserved word MariaDB accepts as a column name; the parser's grammar does
      // not, so it is renamed for the parse only and mapped back below.
      const ast = parser.astify(s.replace(/\bstatus\b/g, "status_col"), { database: "mariadb" }) as unknown as { type: string; table: { table: string }[]; create_definitions: { resource: string; column?: { column: string } }[] };
      expect(ast.type).toBe("create");
      tables[ast.table[0].table] = ast.create_definitions.filter((d) => d.resource === "column").map((d) => d.column!.column.replace(/^status_col$/, "status"));
    }
    // Same tables and columns as the SQLite twin after all its migrations ran.
    const db = new SqliteDb(":memory:");
    await migrate(db);
    const sqliteTables = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((t) => t.name);
    expect(Object.keys(tables).sort()).toEqual(sqliteTables);
    for (const t of sqliteTables) {
      const cols = (await db.all<{ name: string }>(`PRAGMA table_info(${t})`)).map((c) => c.name);
      // Order differs only where SQLite grew a column by ALTER TABLE (links.languages); the sets must match.
      expect([...tables[t]].sort(), t).toEqual([...cols].sort());
    }
    await db.close();
    expect(readdirSync(migrationsDir("sqlite")).sort()).toEqual(["0001_init.sql", "0002_discharge_records.sql", "0003_discharge_summaries.sql"]);
  });

  it("MysqlDb maps query results, runs migrations statement by statement and upserts (pool faked)", async () => {
    const queries: { sql: string; params?: unknown[] }[] = [];
    const rows = [{ id: "p1", first_name: "Ada" }];
    const fakePool = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        if (/^SELECT/i.test(sql)) return [rows, []];
        return [{ affectedRows: 1 }, undefined];
      },
      async end() {},
    };
    const db = Reflect.construct(MysqlDb, [fakePool]) as MysqlDb;
    expect(db.dialect).toBe("mysql");
    expect(await db.get("SELECT * FROM patients WHERE id = ?", ["p1"])).toEqual(rows[0]);
    expect(await db.all("SELECT * FROM patients")).toEqual(rows);
    expect(await db.run("UPDATE patients SET phone = ? WHERE id = ?", ["1", "p1"])).toEqual({ changes: 1 });
    await db.upsert("checklist_state", ["link_id_hash", "item_id"], { link_id_hash: "h", item_id: "med-1", completed: 1, updated_at: "now" });
    expect(queries.at(-1)).toEqual({ sql: "INSERT INTO checklist_state (link_id_hash, item_id, completed, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE completed = VALUES(completed), updated_at = VALUES(updated_at)", params: ["h", "med-1", 1, "now"] });
    await db.exec("CREATE TABLE a (x INT);\nCREATE TABLE b (y INT);");
    expect(queries.slice(-2).map((q) => q.sql)).toEqual(["CREATE TABLE a (x INT)", "CREATE TABLE b (y INT)"]);
    await migrate(db);
    expect(queries.some((q) => q.sql.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(120)"))).toBe(true);
    expect(queries.some((q) => q.sql.startsWith("CREATE TABLE IF NOT EXISTS discharge_summaries"))).toBe(true);
    expect(queries.at(-1)).toMatchObject({ sql: "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", params: ["0001_init.sql", expect.any(String)] });
    await db.close();
  });

  it("SQL_DRIVER=auto falls back to SQLite when MySQL is unreachable and says so; SQL_DRIVER=mysql fails hard", async () => {
    const unreachable = { ...localEnv, MYSQL_HOST: "127.0.0.1", MYSQL_PORT: "1", MYSQL_USER: "admin", MYSQL_PASSWORD: "x", MYSQL_SSL: "off" };
    const auto = await connectSql(loadConfig(unreachable));
    expect(auto.requested).toBe("mysql");
    expect(auto.db.dialect).toBe("sqlite");
    expect(auto.fallback?.from).toBe("mysql");
    expect(auto.fallback?.reason).toMatch(/ECONNREFUSED|connect|refused/i);
    expect(auto.target).toBe(":memory:");
    await auto.db.close();
    await expect(connectSql(loadConfig({ ...unreachable, SQL_DRIVER: "mysql" }))).rejects.toThrow(/SQL_DRIVER=mysql but mysql:\/\/admin@127\.0\.0\.1:1\/dischargeai is unreachable/);
    const sqlite = await connectSql(loadConfig({ ...localEnv, SQL_DRIVER: "sqlite", MYSQL_HOST: "127.0.0.1" }));
    expect(sqlite).toMatchObject({ requested: "sqlite", target: ":memory:" });
    await sqlite.db.close();
  }, 30_000);
});
