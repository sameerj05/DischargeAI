import type { Db } from "../index.js";

export type AuditActor = "provider" | "patient" | "system";

export type AuditEvent =
  | "patient.created"
  | "patient.matched"
  | "link.appended"
  | "link.created"
  | "job.stage"
  | "email.sent"
  | "email.queued"
  | "email.skipped"
  | "summary.viewed"
  | "synthesize.run"
  | "link.expired"
  | "link.purged"
  | "purge.run"
  | "deletion.receipt";

export interface AuditRow {
  id: number;
  event: AuditEvent;
  sum_id: string | null;
  actor: AuditActor;
  at: string;
  details: string | null;
}

export interface AuditEntry {
  id: number;
  event: AuditEvent;
  sumId: string | null;
  actor: AuditActor;
  at: string;
  details: Record<string, unknown>;
}

/** Keys that must never land in audit details. The repo strips them defensively. */
const PHI_KEYS = new Set(["text", "summary", "steps", "medications", "email", "to", "firstName", "lastName", "name", "link", "linkId", "token", "body", "output", "transcript", "raw-text", "llm-summary", "translations"]);

function scrub(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (PHI_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function toEntry(r: AuditRow): AuditEntry {
  let details: Record<string, unknown> = {};
  try {
    details = JSON.parse(r.details ?? "{}") as Record<string, unknown>;
  } catch {
    details = {};
  }
  return { id: Number(r.id), event: r.event, sumId: r.sum_id, actor: r.actor, at: r.at, details };
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  async append(input: { event: AuditEvent; sumId?: string | null; actor: AuditActor; at: string; details?: Record<string, unknown> }): Promise<void> {
    await this.db.run("INSERT INTO audit_log (event, sum_id, actor, at, details) VALUES (?, ?, ?, ?, ?)", [
      input.event,
      input.sumId ?? null,
      input.actor,
      input.at,
      JSON.stringify(scrub(input.details ?? {})),
    ]);
  }

  async listForLink(sumId: string): Promise<AuditEntry[]> {
    const rows = await this.db.all<AuditRow>("SELECT * FROM audit_log WHERE sum_id = ? ORDER BY id", [sumId]);
    return rows.map(toEntry);
  }

  async listByEvent(event: AuditEvent, limit = 1000): Promise<AuditEntry[]> {
    const rows = await this.db.all<AuditRow>("SELECT * FROM audit_log WHERE event = ? ORDER BY id DESC LIMIT ?", [event, limit]);
    return rows.map(toEntry).reverse();
  }

  async listRecent(limit = 200): Promise<AuditEntry[]> {
    const rows = await this.db.all<AuditRow>("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", [limit]);
    return rows.map(toEntry).reverse();
  }
}
