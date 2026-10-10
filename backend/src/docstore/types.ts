/**
 * The document store holds only ciphertext. Items are keyed `pk = link#<sha256(linkId)>` and
 * `sk = raw | simplified | translation#<lang>`; `expiresAt` (epoch seconds) is the DynamoDB TTL
 * attribute on every item. Table: `discharge_records` (the lane-4 contract), in DynamoDB and locally.
 */
export interface DocItem {
  pk: string;
  sk: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
  expiresAt: number;
  createdAt: string;
}

export interface DocumentStore {
  readonly name: "local" | "dynamo";
  /** `discharge_records` by default (env DYNAMO_TABLE); the local twin carries the same name. */
  readonly tableName: string;
  put(item: DocItem): Promise<void>;
  get(pk: string, sk: string): Promise<DocItem | null>;
  list(pk: string, skPrefix?: string): Promise<DocItem[]>;
  /** Deletes every item under a partition key. Returns how many were removed. */
  deleteAll(pk: string): Promise<number>;
  /** Items whose TTL has passed, for the purge job's backstop sweep. */
  listExpired(nowEpochSeconds: number, limit?: number): Promise<Pick<DocItem, "pk" | "sk">[]>;
  delete(pk: string, sk: string): Promise<void>;
}

export const SK = {
  raw: "raw",
  simplified: "simplified",
  translation: (lang: string) => `translation#${lang}`,
  translationPrefix: "translation#",
} as const;

/** Partition key from the link hash (never the raw id). */
export function pkFor(linkIdHash: string): string {
  return `link#${linkIdHash}`;
}
