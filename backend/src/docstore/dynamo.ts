import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DocItem, DocumentStore } from "./types.js";

export interface DynamoOptions {
  tableName: string;
  region: string;
  /** http://localhost:8000 for DynamoDB Local; undefined for real AWS. */
  endpoint?: string;
}

export function createDynamoClient(opts: DynamoOptions): DynamoDBClient {
  return new DynamoDBClient({
    region: opts.region,
    ...(opts.endpoint
      ? { endpoint: opts.endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } }
      : {}),
  });
}

interface DynamoItem {
  pk: string;
  sk: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  keyVersion: number;
  expiresAt: number;
  createdAt: string;
}

function fromDynamo(i: DynamoItem): DocItem {
  return {
    pk: i.pk,
    sk: i.sk,
    ciphertext: Buffer.from(i.ciphertext),
    iv: Buffer.from(i.iv),
    tag: Buffer.from(i.tag),
    keyVersion: Number(i.keyVersion),
    expiresAt: Number(i.expiresAt),
    createdAt: i.createdAt,
  };
}

/**
 * DynamoDB table `discharge_records` (env DYNAMO_TABLE) with `pk` (HASH) + `sk` (RANGE) and TTL
 * enabled on `expiresAt`, the lane-4 contract. Every item written carries `expiresAt`.
 * `scripts/create-dynamo-table.ts` creates it; `docker-compose.yml` runs DynamoDB Local.
 * TTL deletion lags by up to days on AWS, so the purge job and read-time expiry checks are the
 * real 30-day enforcement and TTL is the backstop.
 */
export class DynamoDocumentStore implements DocumentStore {
  readonly name = "dynamo" as const;
  readonly tableName: string;
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(opts: DynamoOptions, client: DynamoDBClient = createDynamoClient(opts)) {
    this.table = opts.tableName;
    this.tableName = opts.tableName;
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async put(item: DocItem): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async get(pk: string, sk: string): Promise<DocItem | null> {
    const { Item } = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk, sk } }));
    return Item ? fromDynamo(Item as DynamoItem) : null;
  }

  async list(pk: string, skPrefix?: string): Promise<DocItem[]> {
    const { Items } = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: skPrefix ? "pk = :pk AND begins_with(sk, :p)" : "pk = :pk",
        ExpressionAttributeValues: skPrefix ? { ":pk": pk, ":p": skPrefix } : { ":pk": pk },
      }),
    );
    return (Items ?? []).map((i) => fromDynamo(i as DynamoItem));
  }

  async deleteAll(pk: string): Promise<number> {
    const { Items } = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk",
        ProjectionExpression: "pk, sk",
        ExpressionAttributeValues: { ":pk": pk },
      }),
    );
    let n = 0;
    for (const it of Items ?? []) {
      await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: it.pk, sk: it.sk } }));
      n += 1;
    }
    return n;
  }

  async listExpired(nowEpochSeconds: number, limit = 500): Promise<Pick<DocItem, "pk" | "sk">[]> {
    const { Items } = await this.doc.send(
      new ScanCommand({
        TableName: this.table,
        FilterExpression: "expiresAt <= :now",
        ProjectionExpression: "pk, sk",
        ExpressionAttributeValues: { ":now": nowEpochSeconds },
        Limit: limit,
      }),
    );
    return (Items ?? []).map((i) => ({ pk: String(i.pk), sk: String(i.sk) }));
  }

  async delete(pk: string, sk: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk, sk } }));
  }
}
