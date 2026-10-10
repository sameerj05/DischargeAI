import type { Db } from "../db/index.js";
import type { DocItem, DocumentStore } from "./types.js";

interface Row {
  uid: string;
  doc: string;
  ciphertext: Buffer | Uint8Array;
  iv: Buffer | Uint8Array;
  tag: Buffer | Uint8Array;
  key_version: number;
  expires_at: number | string;
  created_at: string;
}

function toItem(r: Row): DocItem {
  return {
    uid: r.uid,
    doc: r.doc,
    ciphertext: Buffer.from(r.ciphertext),
    iv: Buffer.from(r.iv),
    tag: Buffer.from(r.tag),
    keyVersion: Number(r.key_version),
    expiresAt: Number(r.expires_at),
    createdAt: r.created_at,
  };
}

/** SQL spelling of the DynamoDB table name `discharge-summaries` (a hyphen is not a bare SQL identifier). */
export const LOCAL_TABLE = "discharge_summaries";

/**
 * The SQL twin of the DynamoDB table `discharge-summaries`: one row per (uid, doc) where DynamoDB
 * has one item per uid with a document attribute per doc. Same hash key (`uid`), same TTL value
 * (`expires_at`, epoch seconds) on every row. Used for local runs and the test suite; the purge job
 * and read-time expiry checks are the real 30-day enforcement in both implementations.
 */
export class LocalDocumentStore implements DocumentStore {
  readonly name = "local" as const;
  readonly tableName = LOCAL_TABLE;
  readonly hashKey = "uid";
  constructor(private readonly db: Db) {}

  async put(item: DocItem): Promise<void> {
    await this.db.upsert(
      LOCAL_TABLE,
      ["uid", "doc"],
      { uid: item.uid, doc: item.doc, ciphertext: item.ciphertext, iv: item.iv, tag: item.tag, key_version: item.keyVersion, expires_at: item.expiresAt, created_at: item.createdAt },
    );
  }

  async get(uid: string, doc: string): Promise<DocItem | null> {
    const row = await this.db.get<Row>(`SELECT * FROM ${LOCAL_TABLE} WHERE uid = ? AND doc = ?`, [uid, doc]);
    return row ? toItem(row) : null;
  }

  async list(uid: string, docPrefix?: string): Promise<DocItem[]> {
    const rows = docPrefix
      ? await this.db.all<Row>(`SELECT * FROM ${LOCAL_TABLE} WHERE uid = ? AND doc LIKE ? ORDER BY doc`, [uid, `${docPrefix}%`])
      : await this.db.all<Row>(`SELECT * FROM ${LOCAL_TABLE} WHERE uid = ? ORDER BY doc`, [uid]);
    return rows.map(toItem);
  }

  async deleteAll(uid: string): Promise<number> {
    const r = await this.db.run(`DELETE FROM ${LOCAL_TABLE} WHERE uid = ?`, [uid]);
    return r.changes;
  }

  async delete(uid: string, doc: string): Promise<void> {
    await this.db.run(`DELETE FROM ${LOCAL_TABLE} WHERE uid = ? AND doc = ?`, [uid, doc]);
  }

  async listExpired(nowEpochSeconds: number, limit = 500): Promise<{ uid: string; docs: string[] }[]> {
    const rows = await this.db.all<{ uid: string; doc: string }>(
      `SELECT uid, doc FROM ${LOCAL_TABLE} WHERE expires_at <= ? ORDER BY expires_at, uid, doc LIMIT ?`,
      [nowEpochSeconds, limit],
    );
    const byUid = new Map<string, string[]>();
    for (const r of rows) byUid.set(r.uid, [...(byUid.get(r.uid) ?? []), r.doc]);
    return [...byUid.entries()].map(([uid, docs]) => ({ uid, docs }));
  }
}
