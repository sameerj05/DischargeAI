/**
 * The document store holds only ciphertext. It is the team's DynamoDB table `discharge-summaries`
 * (hash key `uid`, no sort key, TTL on `expiresAt`), with a SQL twin for local runs and tests.
 *
 * Item design, one item per link:
 *   uid        = "link#<sha256(linkId)>"        (the hash, never the raw link id)
 *   expiresAt  = epoch seconds, the TTL attribute, written on every put
 *   createdAt  = ISO timestamp of the first write
 *   <doc>      = { ciphertext, iv, tag, keyVersion, createdAt }   one attribute per document:
 *                "raw" | "simplified" | "translation#<lang>"
 * One item per link means one GetItem serves every language, one DeleteItem is the day-30 purge,
 * and TTL expires everything for a link together. Documents are written with UpdateItem SET and
 * removed with UpdateItem REMOVE, so a translation added later never rewrites the raw text.
 */
export interface DocItem {
  /** The item's hash key: link#<linkIdHash>. */
  uid: string;
  /** Which document on the item: raw | simplified | translation#<lang>. */
  doc: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
  /** Epoch seconds; DynamoDB TTL attribute `expiresAt`. */
  expiresAt: number;
  createdAt: string;
}

export interface DocumentStore {
  readonly name: "local" | "dynamo";
  /** `discharge-summaries` on DynamoDB (env DYNAMO_TABLE); the SQL twin is `discharge_summaries`. */
  readonly tableName: string;
  /** The hash key attribute, `uid` (env DYNAMO_PK). */
  readonly hashKey: string;
  put(item: DocItem): Promise<void>;
  get(uid: string, doc: string): Promise<DocItem | null>;
  /** Every document on the item, optionally only those whose name starts with `docPrefix`. */
  list(uid: string, docPrefix?: string): Promise<DocItem[]>;
  /** Deletes the whole item. Returns how many documents it held. */
  deleteAll(uid: string): Promise<number>;
  /** Removes one document; the item goes with its last document. */
  delete(uid: string, doc: string): Promise<void>;
  /** Items whose TTL has passed, for the purge job's backstop sweep. */
  listExpired(nowEpochSeconds: number, limit?: number): Promise<{ uid: string; docs: string[] }[]>;
}

export const DOC = {
  raw: "raw",
  simplified: "simplified",
  translation: (lang: string) => `translation#${lang}`,
  translationPrefix: "translation#",
} as const;

/** Attributes on the item that are not documents. */
export const ITEM_ATTRIBUTES: ReadonlySet<string> = new Set(["uid", "expiresAt", "createdAt", "updatedAt"]);

/** The hash key value for a link: from the link hash, never the raw id. */
export function uidFor(linkIdHash: string): string {
  return `link#${linkIdHash}`;
}

export function linkIdHashFromUid(uid: string): string {
  return uid.startsWith("link#") ? uid.slice("link#".length) : uid;
}
