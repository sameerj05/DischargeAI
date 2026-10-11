import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand, type ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import type { SummaryItem, SummaryPatch, SummaryStore } from "./types.js";

export interface DynamoOptions {
  tableName: string;
  /** Hash key attribute name (the secret's dynamodb-table-pk), `uid` on the team table. */
  keyAttribute?: string;
  region: string;
}

export function createDynamoClient(opts: Pick<DynamoOptions, "region">): DynamoDBClient {
  return new DynamoDBClient({ region: opts.region });
}

/** The minimum of DynamoDBDocumentClient the store uses. */
export interface DocClient {
  send(command: PutCommand | GetCommand | UpdateCommand | DeleteCommand | ScanCommand): Promise<unknown>;
}

/**
 * DynamoDB table `discharge-summaries` (account 183815333909, us-west-2): hash key `uid` (S), no
 * sort key, TTL enabled on `expiresAt` (N, epoch seconds). One item per summary, attributes in
 * plain JSON (hyphenated names such as `sum-id`, `raw-text` and `llm-summary` go through
 * ExpressionAttributeNames). The backstop sweep is a filtered scan; at hackathon scale that is fine.
 * `scripts/setup-dynamo.ts` creates the table when missing and enables TTL idempotently.
 * IAM: dynamodb:PutItem, GetItem, UpdateItem, DeleteItem, Scan on the table (DescribeTable,
 * UpdateTimeToLive, DescribeTimeToLive, CreateTable for the setup script).
 */
export class DynamoSummaryStore implements SummaryStore {
  readonly name = "dynamo" as const;
  readonly describe: string;
  private readonly doc: DocClient;
  private readonly table: string;
  private readonly key: string;

  constructor(opts: DynamoOptions, docClient?: DocClient) {
    this.table = opts.tableName;
    this.key = opts.keyAttribute ?? "uid";
    this.describe = `dynamodb:${opts.region}/${this.table} (key=${this.key}, ttl=expiresAt)`;
    this.doc = docClient ?? DynamoDBDocumentClient.from(createDynamoClient(opts), { marshallOptions: { removeUndefinedValues: true } });
  }

  private keyFor(uid: string): Record<string, string> {
    return { [this.key]: uid };
  }

  async put(item: SummaryItem): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...item, [this.key]: item.uid } }));
  }

  async get(uid: string): Promise<SummaryItem | null> {
    const { Item } = (await this.doc.send(new GetCommand({ TableName: this.table, Key: this.keyFor(uid) }))) as { Item?: Record<string, unknown> };
    if (!Item) return null;
    const { [this.key]: _k, ...rest } = Item;
    return { ...(rest as Omit<SummaryItem, "uid">), uid };
  }

  async update(uid: string, patch: SummaryPatch): Promise<void> {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (!entries.length) return;
    const names: Record<string, string> = { "#k": this.key };
    const values: Record<string, unknown> = {};
    const sets: string[] = [];
    entries.forEach(([k, v], i) => {
      names[`#a${i}`] = k;
      values[`:v${i}`] = v;
      sets.push(`#a${i} = :v${i}`);
    });
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: this.keyFor(uid),
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(#k)",
      }),
    );
  }

  async delete(uid: string): Promise<boolean> {
    const r = (await this.doc.send(new DeleteCommand({ TableName: this.table, Key: this.keyFor(uid), ReturnValues: "ALL_OLD" }))) as { Attributes?: Record<string, unknown> };
    return !!r?.Attributes;
  }

  async listExpired(nowEpochSeconds: number, limit = 500): Promise<{ uid: string; expiresAt: number }[]> {
    const out: { uid: string; expiresAt: number }[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = (await this.doc.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "attribute_exists(#s) AND expiresAt <= :now",
          ExpressionAttributeNames: { "#k": this.key, "#s": "sum-id" },
          ExpressionAttributeValues: { ":now": nowEpochSeconds },
          ProjectionExpression: "#k, expiresAt",
          ExclusiveStartKey,
        }),
      )) as ScanCommandOutput;
      for (const it of page.Items ?? []) {
        out.push({ uid: String(it[this.key]), expiresAt: Number(it.expiresAt) });
        if (out.length >= limit) return out;
      }
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }
}
