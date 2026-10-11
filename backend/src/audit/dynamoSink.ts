import { DynamoDBDocumentClient, PutCommand, ScanCommand, type ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "../docstore/dynamo.js";
import { createDynamoClient } from "../docstore/dynamo.js";
import type { AuditSink, DeletionReceipt } from "./receipts.js";

export interface DynamoSinkOptions {
  tableName: string;
  keyAttribute?: string;
  region: string;
}

export const RECEIPT_PREFIX = "receipt#";

/**
 * Receipts as items of the same `discharge-summaries` table, keyed `receipt#<sumId>#<receiptId>`
 * with NO expiresAt and NO sum-id attribute, so TTL never removes them and the summary store's
 * backstop sweep (which filters on sum-id) never sees them: the proof outlives the data without a
 * second table in the team account.
 * IAM: dynamodb:PutItem, Scan.
 */
export class DynamoAuditSink implements AuditSink {
  readonly name = "dynamo" as const;
  private readonly doc: DocClient;
  private readonly key: string;

  constructor(private readonly opts: DynamoSinkOptions, docClient?: DocClient) {
    this.key = opts.keyAttribute ?? "uid";
    this.doc = docClient ?? DynamoDBDocumentClient.from(createDynamoClient(opts), { marshallOptions: { removeUndefinedValues: true } });
  }

  async append(receipt: DeletionReceipt): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.opts.tableName, Item: { [this.key]: `${RECEIPT_PREFIX}${receipt.sumId}#${receipt.receiptId}`, kind: "receipt", ...receipt } }));
  }

  private async scan(prefix: string, limit: number): Promise<DeletionReceipt[]> {
    const out: DeletionReceipt[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = (await this.doc.send(
        new ScanCommand({ TableName: this.opts.tableName, FilterExpression: "begins_with(#k, :p)", ExpressionAttributeNames: { "#k": this.key }, ExpressionAttributeValues: { ":p": prefix }, ExclusiveStartKey }),
      )) as ScanCommandOutput;
      for (const it of page.Items ?? []) {
        const { [this.key]: _uid, kind: _kind, ...receipt } = it as Record<string, unknown>;
        out.push(receipt as unknown as DeletionReceipt);
        if (out.length >= limit) return out;
      }
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  async list(limit = 1000): Promise<DeletionReceipt[]> {
    return this.scan(RECEIPT_PREFIX, limit);
  }

  async findBySumId(sumId: string): Promise<DeletionReceipt[]> {
    return this.scan(`${RECEIPT_PREFIX}${sumId}#`, Number.MAX_SAFE_INTEGER);
  }
}
