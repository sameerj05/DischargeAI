import type { Db } from "../index.js";

export type AuditActor = "provider" | "patient" | "system";

export type AuditEvent =
  | "patient.created"
  | "link.created"
  | "job.stage"
  | "email.sent"
  | "email.queued"
  | "summary.viewed"
  | "translation.created"
  | "translation.viewed"
  | "checklist.updated"
  | "link.expired"
  | "link.purged"
  | "key.destroyed"
  | "record.deleted"
  | "audio.stored"
  | "audio.deleted"
  | "record.synthesized"
  | "synthesize.run"
  | "clock.advanced"
  | "purge.run";

/**
 * Deletion receipts: one audit row per thing destroyed at day 30 (a DynamoDB item, an audio object,
 * a data key), each naming what was deleted, where, when and by which job. Never PHI.
 */
export const DELETION_RECEIPT_EVENTS: ReadonlySet<AuditEvent> = new Set<AuditEvent>(["key.destroyed", "record.deleted", "audio.deleted"]);

export interface AuditRow {
  id: number;
  event: AuditEvent;
  link_id_hash: string | null;
  actor: AuditActor;
  at: string;
  details: string;
}

export interface AuditEntry {
  id: number;
  event: AuditEvent;
  linkIdHash: string | null;
  actor: AuditActor;
  at: string;
  details: Record<string, unknown>;
}

/** Keys that must never land in audit details. The repo strips them defensively. */
const PHI_KEYS = new Set(["text", "summary", "email", "to", "firstName", "lastName", "name", "link", "linkId", "body"]);

function scrub(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (PHI_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  async append(input: {
    event: AuditEvent;
    linkIdHash?: string | null;
    actor: AuditActor;
    at: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.run("INSERT INTO audit_log (event, link_id_hash, actor, at, details) VALUES (?, ?, ?, ?, ?)", [
      input.event,
      input.linkIdHash ?? null,
      input.actor,
      input.at,
      JSON.stringify(scrub(input.details ?? {})),
    ]);
  }

  async listForLink(linkIdHash: string): Promise<AuditEntry[]> {
    const rows = await this.db.all<AuditRow>(
      "SELECT * FROM audit_log WHERE link_id_hash = ? ORDER BY id",
      [linkIdHash],
    );
    return rows.map(toEntry);
  }

  /** Every deletion receipt in the log (all links), newest last. */
  async listDeletionReceipts(limit = 500): Promise<AuditEntry[]> {
    const rows = await this.db.all<AuditRow>(
      "SELECT * FROM audit_log WHERE event IN ('key.destroyed', 'record.deleted', 'audio.deleted') ORDER BY id DESC LIMIT ?",
      [limit],
    );
    return rows.map(toEntry).reverse();
  }
}

function toEntry(r: AuditRow): AuditEntry {
  return {
    id: Number(r.id),
    event: r.event,
    linkIdHash: r.link_id_hash,
    actor: r.actor,
    at: r.at,
    details: JSON.parse(r.details) as Record<string, unknown>,
  };
}
