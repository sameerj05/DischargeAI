import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { AuditRepo } from "../db/repos/audit.js";

/**
 * Deletion receipts: the audit log's proof that data is gone. A receipt says WHAT was deleted (the
 * summary item, the PDF, the audio object), WHEN, BY WHICH MECHANISM (the purge job) and for which
 * sumId. Never any PHI: no text, no names, no language content. Receipts outlive the data; the sumId
 * they name answers 410 from the moment the item is gone. Items DynamoDB's TTL and the S3 lifecycle
 * rules remove on their own leave no receipt.
 * Sinks: sql (the audit_log table, default) and dynamo (receipt# items in the discharge-summaries
 * table, never expired).
 */
export type DeletedKind = "record" | "pdf" | "audio";
export type DeletionMechanism = "purge_job";
export type ReceiptSource = "purge" | "sweeper";

export interface DeletionReceipt {
  receiptId: string;
  sumId: string;
  deleted: DeletedKind;
  mechanism: DeletionMechanism;
  source: ReceiptSource;
  /** When the receipt was written. */
  at: string;
  /** The summary item's uid (= sumId), for record receipts. */
  uid?: string;
  /** Object key, for PDF, audio and transcript objects. */
  key?: string;
  /** The TTL value the item carried, when known (epoch seconds). */
  expiresAt?: number;
}

const PHI_LIKE = /(text|transcript|steps|medications|name|language|label)\s*[:=]/i;

export function newReceipt(input: Omit<DeletionReceipt, "receiptId" | "at"> & { at?: string }): DeletionReceipt {
  const receipt: DeletionReceipt = { receiptId: randomUUID(), at: input.at ?? new Date().toISOString(), ...input };
  if ((receipt.key && PHI_LIKE.test(receipt.key)) || (receipt.uid && PHI_LIKE.test(receipt.uid))) {
    throw new Error("refusing to write a receipt that looks like it carries content");
  }
  return receipt;
}

export interface AuditSink {
  readonly name: "sql" | "dynamo";
  append(receipt: DeletionReceipt): Promise<void>;
  /** Oldest first. */
  list(limit?: number): Promise<DeletionReceipt[]>;
  findBySumId(sumId: string): Promise<DeletionReceipt[]>;
}

/** The default: receipts are rows of audit_log with event `deletion.receipt`, next to the other events of the link. */
export class SqlAuditSink implements AuditSink {
  readonly name = "sql" as const;

  constructor(private readonly audit: AuditRepo) {}

  async append(receipt: DeletionReceipt): Promise<void> {
    const { sumId, at, ...details } = receipt;
    await this.audit.append({ event: "deletion.receipt", sumId: sumId === "-" ? null : sumId, actor: "system", at, details });
  }

  async list(limit = 1000): Promise<DeletionReceipt[]> {
    return (await this.audit.listByEvent("deletion.receipt", limit)).map((e) => ({ ...(e.details as Omit<DeletionReceipt, "sumId" | "at">), sumId: e.sumId ?? "-", at: e.at }));
  }

  async findBySumId(sumId: string): Promise<DeletionReceipt[]> {
    return (await this.audit.listForLink(sumId)).filter((e) => e.event === "deletion.receipt").map((e) => ({ ...(e.details as Omit<DeletionReceipt, "sumId" | "at">), sumId, at: e.at }));
  }
}

/** The app passes its AuditRepo; a script that has none gets one on a fresh connection. */
export async function createAuditSink(config: Config, deps: { audit?: AuditRepo } = {}): Promise<AuditSink> {
  switch (config.AUDIT_SINK) {
    case "dynamo": {
      const { DynamoAuditSink } = await import("./dynamoSink.js");
      return new DynamoAuditSink({ tableName: config.DYNAMO_TABLE, keyAttribute: config.DYNAMO_PK, region: config.AWS_REGION });
    }
    case "sql":
    default: {
      if (deps.audit) return new SqlAuditSink(deps.audit);
      const { openDb } = await import("../db/index.js");
      const { migrate } = await import("../db/migrate.js");
      const { AuditRepo } = await import("../db/repos/audit.js");
      const db = await openDb(config);
      await migrate(db);
      return new SqlAuditSink(new AuditRepo(db));
    }
  }
}
