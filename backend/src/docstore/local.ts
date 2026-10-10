import type { Db } from "../db/index.js";
import type { DocItem, DocumentStore } from "./types.js";

interface Row {
  pk: string;
  sk: string;
  ciphertext: Buffer | Uint8Array;
  iv: Buffer | Uint8Array;
  tag: Buffer | Uint8Array;
  keyVersion: number;
  expiresAt: number | string;
  createdAt: string;
}

function toItem(r: Row): DocItem {
  return {
    pk: r.pk,
    sk: r.sk,
    ciphertext: Buffer.from(r.ciphertext),
    iv: Buffer.from(r.iv),
    tag: Buffer.from(r.tag),
    keyVersion: Number(r.keyVersion),
    expiresAt: Number(r.expiresAt),
    createdAt: r.createdAt,
  };
}

/** The table name the DynamoDB store uses by default; the SQL twin uses the same name and attributes. */
export const LOCAL_TABLE = "discharge_records";

/**
 * The SQLite (or Postgres) twin of the DynamoDB table `discharge_records`: same item shape, same
 * attribute names (quoted so Postgres keeps the case), `expiresAt` as the TTL attribute. The purge
 * job and read-time expiry checks are the real 30-day enforcement in both implementations.
 */
export class LocalDocumentStore implements DocumentStore {
  readonly name = "local" as const;
  readonly tableName = LOCAL_TABLE;
  constructor(private readonly db: Db) {}

  async put(item: DocItem): Promise<void> {
    await this.db.run(
      `INSERT INTO discharge_records (pk, sk, ciphertext, iv, tag, "keyVersion", "expiresAt", "createdAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (pk, sk) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
         "keyVersion" = excluded."keyVersion", "expiresAt" = excluded."expiresAt", "createdAt" = excluded."createdAt"`,
      [item.pk, item.sk, item.ciphertext, item.iv, item.tag, item.keyVersion, item.expiresAt, item.createdAt],
    );
  }

  async get(pk: string, sk: string): Promise<DocItem | null> {
    const row = await this.db.get<Row>("SELECT * FROM discharge_records WHERE pk = ? AND sk = ?", [pk, sk]);
    return row ? toItem(row) : null;
  }

  async list(pk: string, skPrefix?: string): Promise<DocItem[]> {
    const rows = skPrefix
      ? await this.db.all<Row>("SELECT * FROM discharge_records WHERE pk = ? AND sk LIKE ? ORDER BY sk", [pk, `${skPrefix}%`])
      : await this.db.all<Row>("SELECT * FROM discharge_records WHERE pk = ? ORDER BY sk", [pk]);
    return rows.map(toItem);
  }

  async deleteAll(pk: string): Promise<number> {
    const r = await this.db.run("DELETE FROM discharge_records WHERE pk = ?", [pk]);
    return r.changes;
  }

  async listExpired(nowEpochSeconds: number, limit = 500): Promise<Pick<DocItem, "pk" | "sk">[]> {
    return this.db.all<{ pk: string; sk: string }>(
      `SELECT pk, sk FROM discharge_records WHERE "expiresAt" <= ? ORDER BY "expiresAt" LIMIT ?`,
      [nowEpochSeconds, limit],
    );
  }

  async delete(pk: string, sk: string): Promise<void> {
    await this.db.run("DELETE FROM discharge_records WHERE pk = ? AND sk = ?", [pk, sk]);
  }
}
