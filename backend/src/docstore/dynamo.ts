import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ITEM_ATTRIBUTES, type DocItem, type DocumentStore } from "./types.js";

export interface DynamoOptions {
  tableName: string;
  /** Hash key attribute name, `uid` on the team table. */
  hashKey?: string;
  region: string;
  /** http://localhost:8000 for DynamoDB Local; undefined for real AWS. */
  endpoint?: string;
}

export function createDynamoClient(opts: Pick<DynamoOptions, "region" | "endpoint">): DynamoDBClient {
  return new DynamoDBClient({
    region: opts.region,
    ...(opts.endpoint
      ? { endpoint: opts.endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } }
      : {}),
  });
}

/** What one document attribute holds on the item. */
interface DocAttribute {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  keyVersion: number;
  createdAt: string;
}

interface Sendable {
  send(command: unknown): Promise<unknown>;
}

function isDocAttribute(v: unknown): v is DocAttribute {
  return !!v && typeof v === "object" && "ciphertext" in (v as Record<string, unknown>) && "iv" in (v as Record<string, unknown>);
}

function docNames(item: Record<string, unknown>): string[] {
  return Object.keys(item)
    .filter((k) => !ITEM_ATTRIBUTES.has(k) && isDocAttribute(item[k]))
    .sort();
}

function toDocItem(uid: string, doc: string, item: Record<string, unknown>): DocItem {
  const a = item[doc] as DocAttribute;
  return {
    uid,
    doc,
    ciphertext: Buffer.from(a.ciphertext),
    iv: Buffer.from(a.iv),
    tag: Buffer.from(a.tag),
    keyVersion: Number(a.keyVersion),
    expiresAt: Number(item.expiresAt),
    createdAt: a.createdAt,
  };
}

/**
 * The team's DynamoDB table (`discharge-summaries`, hash key `uid`, TTL on `expiresAt`; names come
 * from Secrets Manager or env). One item per link, one attribute per document (see types.ts).
 *   put        UpdateItem SET #doc = :payload, expiresAt = :exp, createdAt = if_not_exists(...)
 *   get        GetItem with a projection on the one document
 *   list       GetItem, every document attribute
 *   delete     UpdateItem REMOVE #doc (ReturnValues ALL_NEW); DeleteItem when no document is left
 *   deleteAll  DeleteItem
 *   listExpired Scan expiresAt <= now (the purge backstop; TTL does the same on AWS with a lag)
 * `scripts/setup-dynamo.ts` creates the table when missing and enables TTL idempotently.
 * IAM: dynamodb:GetItem, PutItem, UpdateItem, DeleteItem, Scan on the table; DescribeTable,
 * DescribeTimeToLive, UpdateTimeToLive (and CreateTable when it has to create it) for the script.
 */
export class DynamoDocumentStore implements DocumentStore {
  readonly name = "dynamo" as const;
  readonly tableName: string;
  readonly hashKey: string;
  private readonly doc: Sendable;

  constructor(opts: DynamoOptions, client?: Sendable) {
    this.tableName = opts.tableName;
    this.hashKey = opts.hashKey ?? "uid";
    this.doc = client ?? DynamoDBDocumentClient.from(createDynamoClient(opts), { marshallOptions: { removeUndefinedValues: true } });
  }

  private key(uid: string): Record<string, string> {
    return { [this.hashKey]: uid };
  }

  async put(item: DocItem): Promise<void> {
    const payload: DocAttribute = { ciphertext: item.ciphertext, iv: item.iv, tag: item.tag, keyVersion: item.keyVersion, createdAt: item.createdAt };
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: this.key(item.uid),
        UpdateExpression: "SET #doc = :payload, expiresAt = :exp, createdAt = if_not_exists(createdAt, :now), updatedAt = :now",
        ExpressionAttributeNames: { "#doc": item.doc },
        ExpressionAttributeValues: { ":payload": payload, ":exp": item.expiresAt, ":now": item.createdAt },
      }),
    );
  }

  async get(uid: string, doc: string): Promise<DocItem | null> {
    const r = (await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: this.key(uid),
        ProjectionExpression: "#doc, expiresAt",
        ExpressionAttributeNames: { "#doc": doc },
      }),
    )) as { Item?: Record<string, unknown> };
    if (!r.Item || !isDocAttribute(r.Item[doc])) return null;
    return toDocItem(uid, doc, r.Item);
  }

  async list(uid: string, docPrefix?: string): Promise<DocItem[]> {
    const r = (await this.doc.send(new GetCommand({ TableName: this.tableName, Key: this.key(uid) }))) as { Item?: Record<string, unknown> };
    if (!r.Item) return [];
    const item = r.Item;
    return docNames(item)
      .filter((d) => !docPrefix || d.startsWith(docPrefix))
      .map((d) => toDocItem(uid, d, item));
  }

  async deleteAll(uid: string): Promise<number> {
    const r = (await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: this.key(uid), ReturnValues: "ALL_OLD" }),
    )) as { Attributes?: Record<string, unknown> };
    return r.Attributes ? docNames(r.Attributes).length : 0;
  }

  async delete(uid: string, doc: string): Promise<void> {
    let remaining: Record<string, unknown> | undefined;
    try {
      const r = (await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(uid),
          UpdateExpression: "REMOVE #doc",
          ConditionExpression: "attribute_exists(#pk)",
          ExpressionAttributeNames: { "#doc": doc, "#pk": this.hashKey },
          ReturnValues: "ALL_NEW",
        }),
      )) as { Attributes?: Record<string, unknown> };
      remaining = r.Attributes;
    } catch (err) {
      if ((err as { name?: string })?.name === "ConditionalCheckFailedException") return; // no such item: nothing to remove
      throw err;
    }
    if (remaining && docNames(remaining).length === 0) {
      await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: this.key(uid) }));
    }
  }

  async listExpired(nowEpochSeconds: number, limit = 500): Promise<{ uid: string; docs: string[] }[]> {
    const r = (await this.doc.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: "expiresAt <= :now",
        ExpressionAttributeValues: { ":now": nowEpochSeconds },
        Limit: limit,
      }),
    )) as { Items?: Record<string, unknown>[] };
    return (r.Items ?? []).map((item) => ({ uid: String(item[this.hashKey]), docs: docNames(item) }));
  }
}
