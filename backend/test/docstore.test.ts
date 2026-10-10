import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashLinkId } from "../src/crypto/linkId.js";
import { newDataKey } from "../src/crypto/envelope.js";
import { SqliteDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { DynamoDocumentStore } from "../src/docstore/dynamo.js";
import { LocalDocumentStore } from "../src/docstore/local.js";
import { SecureDocs } from "../src/docstore/secure.js";
import { DOC, uidFor, type DocumentStore } from "../src/docstore/types.js";
import { createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

const MIGRATIONS = join(import.meta.dirname, "..", "src", "db", "migrations");

describe("discharge-summaries: the team's DynamoDB table and its SQL twin", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("the local twin is discharge_summaries keyed by uid and every row carries expiresAt = the link's expiry", async () => {
    expect(t.ctx.docStore.tableName).toBe("discharge_summaries");
    expect(t.ctx.docStore.hashKey).toBe("uid");
    const health = await request(t.app).get("/health");
    expect(health.body.providers).toMatchObject({ docTable: "discharge_summaries", docHashKey: "uid" });
    const { linkId, expiresAt } = await ingestText(t, exampleText("example-1-chf"));
    const uid = uidFor(hashLinkId(linkId));
    expect(uid).toBe(`link#${hashLinkId(linkId)}`);
    const items = await t.ctx.docStore.list(uid);
    expect(items.map((i) => i.doc)).toEqual(["raw", "simplified"]);
    for (const it of items) {
      expect(it.uid).toBe(uid);
      expect(it.expiresAt).toBe(Math.floor(new Date(expiresAt).getTime() / 1000));
      expect(it.ciphertext.length).toBeGreaterThan(0);
    }
    const row = await t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discharge_summaries WHERE expires_at IS NULL");
    expect(Number(row?.n)).toBe(0);
  });

  it("migrations 0002 and 0003 carry rows from documents through discharge_records into discharge_summaries", async () => {
    const db = new SqliteDb(":memory:");
    await db.exec(readFileSync(join(MIGRATIONS, "0001_init.sql"), "utf8"));
    await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    await db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", ["0001_init.sql", "2026-10-10T00:00:00.000Z"]);
    await db.run(
      "INSERT INTO documents (pk, sk, ciphertext, iv, tag, key_version, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["link#old", "simplified", Buffer.from("c"), Buffer.alloc(12), Buffer.alloc(16), 1, 1234567890, "2026-10-10T00:00:00.000Z"],
    );
    const ran = await migrate(db);
    expect(ran).toEqual(["0002_discharge_records.sql", "0003_discharge_summaries.sql"]);
    const store = new LocalDocumentStore(db);
    const moved = await store.get("link#old", "simplified");
    expect(moved).toMatchObject({ uid: "link#old", doc: "simplified", keyVersion: 1, expiresAt: 1234567890 });
    await expect(db.get("SELECT 1 FROM documents")).rejects.toThrow();
    await expect(db.get("SELECT 1 FROM discharge_records")).rejects.toThrow();
    const cols = await db.all<{ name: string }>("PRAGMA table_info(links)");
    expect(cols.map((c) => c.name)).toContain("languages");
    await db.close();
  });
});

/**
 * An in-memory stand-in for DynamoDBDocumentClient that understands exactly the commands the store
 * sends (UpdateItem SET / REMOVE with names and values, GetItem with a projection, DeleteItem with
 * ReturnValues, Scan with an expiresAt filter). It checks the request shapes the real table needs:
 * the Key is { uid } only, every write carries expiresAt, and a REMOVE never creates an item.
 */
function fakeDynamo(hashKey = "uid") {
  const items = new Map<string, Record<string, unknown>>();
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const names = (n?: Record<string, string>) => (k: string) => (k.startsWith("#") ? n![k] : k);
  const client = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      const input = cmd.input as {
        TableName: string;
        Key?: Record<string, string>;
        UpdateExpression?: string;
        ConditionExpression?: string;
        ExpressionAttributeNames?: Record<string, string>;
        ExpressionAttributeValues?: Record<string, unknown>;
        ProjectionExpression?: string;
        FilterExpression?: string;
        ReturnValues?: string;
      };
      if (input.Key) {
        expect(Object.keys(input.Key)).toEqual([hashKey]);
      }
      const uid = input.Key?.[hashKey] ?? "";
      const n = names(input.ExpressionAttributeNames);
      switch (cmd.constructor.name) {
        case "UpdateCommand": {
          const existing = items.get(uid);
          if (input.ConditionExpression === `attribute_exists(${Object.keys(input.ExpressionAttributeNames ?? {}).find((k) => input.ExpressionAttributeNames![k] === hashKey)})`) {
            if (!existing) throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
          }
          const item = existing ?? { [hashKey]: uid };
          const expr = input.UpdateExpression!;
          if (expr.startsWith("SET ")) {
            for (const part of expr.slice(4).split(/,(?![^(]*\))/).map((s) => s.trim())) {
              const [lhs, rhs] = part.split("=").map((s) => s.trim());
              const attr = n(lhs);
              const m = /^if_not_exists\((\w+), (:\w+)\)$/.exec(rhs);
              item[attr] = m ? (item[m[1]] ?? input.ExpressionAttributeValues![m[2]]) : input.ExpressionAttributeValues![rhs];
            }
          } else if (expr.startsWith("REMOVE ")) {
            for (const part of expr.slice(7).split(",").map((s) => s.trim())) delete item[n(part)];
          } else {
            throw new Error(`unexpected UpdateExpression ${expr}`);
          }
          items.set(uid, item);
          return input.ReturnValues === "ALL_NEW" ? { Attributes: { ...item } } : {};
        }
        case "GetCommand": {
          const item = items.get(uid);
          if (!item) return {};
          if (!input.ProjectionExpression) return { Item: { ...item } };
          const out: Record<string, unknown> = {};
          for (const p of input.ProjectionExpression.split(",").map((s) => s.trim())) {
            const attr = n(p);
            if (attr in item) out[attr] = item[attr];
          }
          return { Item: out };
        }
        case "DeleteCommand": {
          const item = items.get(uid);
          items.delete(uid);
          return input.ReturnValues === "ALL_OLD" && item ? { Attributes: item } : {};
        }
        case "ScanCommand": {
          expect(input.FilterExpression).toBe("expiresAt <= :now");
          const now = input.ExpressionAttributeValues![":now"] as number;
          return { Items: [...items.values()].filter((i) => Number(i.expiresAt) <= now).map((i) => ({ ...i })) };
        }
        default:
          throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    },
  };
  return { client, items, sent };
}

describe("DynamoDocumentStore (one item per link on discharge-summaries, client faked)", () => {
  const sample = (uid: string, doc: string, expiresAt: number) => ({ uid, doc, ciphertext: Buffer.from(`ct:${doc}`), iv: Buffer.alloc(12, 1), tag: Buffer.alloc(16, 2), keyVersion: 1, expiresAt, createdAt: "2026-10-10T00:00:00.000Z" });

  it("writes one attribute per document on the uid item with expiresAt, reads, lists, removes and drops the empty item", async () => {
    const fake = fakeDynamo();
    const store: DocumentStore = new DynamoDocumentStore({ tableName: "discharge-summaries", region: "us-west-2" }, fake.client as never);
    expect(store.tableName).toBe("discharge-summaries");
    expect(store.hashKey).toBe("uid");
    const uid = uidFor("a".repeat(64));

    await store.put(sample(uid, DOC.raw, 1_900_000_000));
    await store.put(sample(uid, DOC.simplified, 1_900_000_000));
    await store.put(sample(uid, DOC.translation("es"), 1_900_000_000));
    expect(fake.items.size).toBe(1);
    const item = fake.items.get(uid)!;
    expect(Object.keys(item).sort()).toEqual(["createdAt", "expiresAt", "raw", "simplified", "translation#es", "uid", "updatedAt"]);
    expect(item.expiresAt).toBe(1_900_000_000);
    expect(fake.sent.filter((s) => s.name === "UpdateCommand").every((s) => String(s.input.UpdateExpression).includes("expiresAt = :exp"))).toBe(true);
    expect(fake.sent[0].input.ExpressionAttributeNames).toEqual({ "#doc": "raw" });

    const got = await store.get(uid, DOC.simplified);
    expect(got).toMatchObject({ uid, doc: "simplified", keyVersion: 1, expiresAt: 1_900_000_000 });
    expect(got!.ciphertext.toString()).toBe("ct:simplified");
    expect(await store.get(uid, DOC.translation("zh"))).toBeNull();
    expect(await store.get("link#nope", DOC.raw)).toBeNull();
    expect((await store.list(uid)).map((d) => d.doc)).toEqual(["raw", "simplified", "translation#es"]);
    expect((await store.list(uid, DOC.translationPrefix)).map((d) => d.doc)).toEqual(["translation#es"]);

    // A put of an existing document overwrites just that attribute.
    await store.put({ ...sample(uid, DOC.simplified, 1_900_000_000), ciphertext: Buffer.from("ct:v2") });
    expect((await store.get(uid, DOC.simplified))!.ciphertext.toString()).toBe("ct:v2");
    expect((await store.get(uid, DOC.raw))!.ciphertext.toString()).toBe("ct:raw");

    await store.delete(uid, DOC.translation("es"));
    expect((await store.list(uid)).map((d) => d.doc)).toEqual(["raw", "simplified"]);
    await store.delete(uid, DOC.raw);
    await store.delete(uid, DOC.simplified);
    expect(fake.items.has(uid)).toBe(false);
    // Removing from a missing item is a no-op and never creates one.
    await store.delete(uid, DOC.raw);
    expect(fake.items.has(uid)).toBe(false);
    expect(fake.sent.filter((s) => s.name === "UpdateCommand" && String(s.input.UpdateExpression).startsWith("REMOVE")).every((s) => s.input.ConditionExpression === "attribute_exists(#pk)")).toBe(true);
  });

  it("deleteAll removes the item and reports its document count; listExpired finds items past their TTL", async () => {
    const fake = fakeDynamo();
    const store = new DynamoDocumentStore({ tableName: "discharge-summaries", region: "us-west-2" }, fake.client as never);
    const fresh = uidFor("b".repeat(64));
    const stale = uidFor("c".repeat(64));
    await store.put(sample(fresh, DOC.raw, 2_000_000_000));
    await store.put(sample(stale, DOC.raw, 1_000));
    await store.put(sample(stale, DOC.simplified, 1_000));
    expect(await store.listExpired(1_500)).toEqual([{ uid: stale, docs: ["raw", "simplified"] }]);
    expect(await store.deleteAll(stale)).toBe(2);
    expect(await store.deleteAll(stale)).toBe(0);
    expect(await store.listExpired(1_500)).toEqual([]);
    expect(fake.items.has(fresh)).toBe(true);
  });

  it("honours a different hash key name from the secret and round-trips through SecureDocs", async () => {
    const fake = fakeDynamo("pk");
    const store = new DynamoDocumentStore({ tableName: "t", hashKey: "pk", region: "us-west-2" }, fake.client as never);
    const secure = new SecureDocs(store);
    const key = newDataKey();
    const linkIdHash = "d".repeat(64);
    await secure.putJson({ linkIdHash, doc: DOC.simplified, key, keyVersion: 1, value: { hello: "world" }, expiresAtEpochSeconds: 1_900_000_000, createdAt: "2026-10-10T00:00:00.000Z" });
    expect(fake.items.get(uidFor(linkIdHash))!.pk).toBe(uidFor(linkIdHash));
    expect(await secure.getJson<{ hello: string }>({ linkIdHash, doc: DOC.simplified, key })).toEqual({ hello: "world" });
    expect(await secure.listDocs(linkIdHash)).toEqual(["simplified"]);
    await expect(secure.getJson({ linkIdHash, doc: DOC.simplified, key: newDataKey() })).rejects.toThrow();
  });
});
