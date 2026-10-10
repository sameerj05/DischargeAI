import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashLinkId } from "../src/crypto/linkId.js";
import { SqliteDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { LocalDocumentStore } from "../src/docstore/local.js";
import { pkFor } from "../src/docstore/types.js";
import { createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

const MIGRATIONS = join(import.meta.dirname, "..", "src", "db", "migrations");

describe("discharge_records: the lane-4 data contract", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("the local twin is named discharge_records and every item carries expiresAt = the link's expiry", async () => {
    expect(t.ctx.docStore.tableName).toBe("discharge_records");
    const health = await request(t.app).get("/health");
    expect(health.body.providers.docTable).toBe("discharge_records");
    const { linkId, expiresAt } = await ingestText(t, exampleText("example-1-chf"));
    const items = await t.ctx.docStore.list(pkFor(hashLinkId(linkId)));
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const it of items) {
      expect(it.expiresAt).toBe(Math.floor(new Date(expiresAt).getTime() / 1000));
      expect(it.ciphertext.length).toBeGreaterThan(0);
    }
    const row = await t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM discharge_records WHERE "expiresAt" IS NULL`);
    expect(Number(row?.n)).toBe(0);
  });

  it("migration 0002 carries rows from the first schema's documents table into discharge_records", async () => {
    const db = new SqliteDb(":memory:");
    await db.exec(readFileSync(join(MIGRATIONS, "0001_init.sql"), "utf8"));
    await db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", ["0001_init.sql", "2026-10-10T00:00:00.000Z"]).catch(async () => {
      await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
      await db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", ["0001_init.sql", "2026-10-10T00:00:00.000Z"]);
    });
    await db.run(
      "INSERT INTO documents (pk, sk, ciphertext, iv, tag, key_version, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["link#old", "simplified", Buffer.from("c"), Buffer.alloc(12), Buffer.alloc(16), 1, 1234567890, "2026-10-10T00:00:00.000Z"],
    );
    const ran = await migrate(db);
    expect(ran).toContain("0002_discharge_records.sql");
    const store = new LocalDocumentStore(db);
    const moved = await store.get("link#old", "simplified");
    expect(moved).toMatchObject({ pk: "link#old", sk: "simplified", keyVersion: 1, expiresAt: 1234567890 });
    await expect(db.get("SELECT 1 FROM documents")).rejects.toThrow();
    const cols = await db.all<{ name: string }>("PRAGMA table_info(links)");
    expect(cols.map((c) => c.name)).toContain("languages");
    await db.close();
  });
});
