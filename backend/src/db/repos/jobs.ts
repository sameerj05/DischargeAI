import { randomUUID } from "node:crypto";
import type { Db } from "../index.js";
import type { Warning } from "../../agents/types.js";

export type JobStage =
  | "received"
  | "extracting"
  | "transcribing"
  | "simplifying"
  | "checking"
  | "translating"
  | "stored"
  | "emailing"
  | "done"
  | "needs_review"
  | "failed";

export const TERMINAL_STAGES: ReadonlySet<JobStage> = new Set(["done", "needs_review", "failed"]);

export type InputKind = "text" | "pdf" | "audio";

export interface JobRow {
  id: string;
  link_id_hash: string;
  stage: JobStage;
  input_kind: InputKind;
  error: string | null;
  warnings: string;
  meta: string;
  created_at: string;
  updated_at: string;
}

export interface JobRecord {
  id: string;
  linkIdHash: string;
  stage: JobStage;
  inputKind: InputKind;
  error: string | null;
  warnings: Warning[];
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function toRecord(r: JobRow): JobRecord {
  return {
    id: r.id,
    linkIdHash: r.link_id_hash,
    stage: r.stage,
    inputKind: r.input_kind,
    error: r.error,
    warnings: parseJson<Warning[]>(r.warnings, []),
    meta: parseJson<Record<string, unknown>>(r.meta, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class JobsRepo {
  constructor(private readonly db: Db) {}

  async create(input: { linkIdHash: string; inputKind: InputKind; now: string; meta?: Record<string, unknown> }) {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO jobs (id, link_id_hash, stage, input_kind, warnings, meta, created_at, updated_at)
       VALUES (?, ?, 'received', ?, '[]', ?, ?, ?)`,
      [id, input.linkIdHash, input.inputKind, JSON.stringify(input.meta ?? {}), input.now, input.now],
    );
    return (await this.get(id))!;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const row = await this.db.get<JobRow>("SELECT * FROM jobs WHERE id = ?", [id]);
    return row ? toRecord(row) : undefined;
  }

  async latestForLink(linkIdHash: string): Promise<JobRecord | undefined> {
    const row = await this.db.get<JobRow>(
      "SELECT * FROM jobs WHERE link_id_hash = ? ORDER BY created_at DESC LIMIT 1",
      [linkIdHash],
    );
    return row ? toRecord(row) : undefined;
  }

  async setStage(id: string, stage: JobStage, now: string, error?: string | null): Promise<void> {
    await this.db.run("UPDATE jobs SET stage = ?, error = ?, updated_at = ? WHERE id = ?", [
      stage,
      error ?? null,
      now,
      id,
    ]);
  }

  async setWarnings(id: string, warnings: Warning[], now: string): Promise<void> {
    await this.db.run("UPDATE jobs SET warnings = ?, updated_at = ? WHERE id = ?", [JSON.stringify(warnings), now, id]);
  }

  async mergeMeta(id: string, patch: Record<string, unknown>, now: string): Promise<void> {
    const current = await this.get(id);
    const meta = { ...(current?.meta ?? {}), ...patch };
    await this.db.run("UPDATE jobs SET meta = ?, updated_at = ? WHERE id = ?", [JSON.stringify(meta), now, id]);
  }

  async listUnfinished(): Promise<JobRecord[]> {
    const rows = await this.db.all<JobRow>(
      "SELECT * FROM jobs WHERE stage NOT IN ('done', 'needs_review', 'failed') ORDER BY created_at",
    );
    return rows.map(toRecord);
  }
}
