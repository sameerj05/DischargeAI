import { randomUUID } from "node:crypto";
import type { InputKind } from "../../docstore/types.js";
import type { Db } from "../index.js";

export type JobStage =
  | "received"
  | "transcribing"
  | "simplifying"
  | "stored"
  | "emailing"
  | "done"
  | "failed";

export const TERMINAL_STAGES: ReadonlySet<JobStage> = new Set(["done", "failed"]);

export type { InputKind };

export interface JobRow {
  id: string;
  sum_id: string;
  stage: JobStage;
  input_kind: InputKind;
  error: string | null;
  meta: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobRecord {
  id: string;
  sumId: string;
  stage: JobStage;
  inputKind: InputKind;
  error: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function toRecord(r: JobRow): JobRecord {
  return {
    id: r.id,
    sumId: r.sum_id,
    stage: r.stage,
    inputKind: r.input_kind,
    error: r.error,
    meta: parseJson<Record<string, unknown>>(r.meta, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class JobsRepo {
  constructor(private readonly db: Db) {}

  async create(input: { sumId: string; inputKind: InputKind; now: string; meta?: Record<string, unknown> }) {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO jobs (id, sum_id, stage, input_kind, meta, created_at, updated_at)
       VALUES (?, ?, 'received', ?, ?, ?, ?)`,
      [id, input.sumId, input.inputKind, JSON.stringify(input.meta ?? {}), input.now, input.now],
    );
    return (await this.get(id))!;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const row = await this.db.get<JobRow>("SELECT * FROM jobs WHERE id = ?", [id]);
    return row ? toRecord(row) : undefined;
  }

  async latestForLink(sumId: string): Promise<JobRecord | undefined> {
    const row = await this.db.get<JobRow>("SELECT * FROM jobs WHERE sum_id = ? ORDER BY created_at DESC LIMIT 1", [sumId]);
    return row ? toRecord(row) : undefined;
  }

  async setStage(id: string, stage: JobStage, now: string, error?: string | null): Promise<void> {
    await this.db.run("UPDATE jobs SET stage = ?, error = ?, updated_at = ? WHERE id = ?", [stage, error ?? null, now, id]);
  }

  async mergeMeta(id: string, patch: Record<string, unknown>, now: string): Promise<void> {
    const current = await this.get(id);
    const meta = { ...(current?.meta ?? {}), ...patch };
    await this.db.run("UPDATE jobs SET meta = ?, updated_at = ? WHERE id = ?", [JSON.stringify(meta), now, id]);
  }

  async listUnfinished(): Promise<JobRecord[]> {
    // needs_review is a terminal stage older versions wrote; such jobs are never resumed.
    const rows = await this.db.all<JobRow>("SELECT * FROM jobs WHERE stage NOT IN ('done', 'needs_review', 'failed') ORDER BY created_at");
    return rows.map(toRecord);
  }
}
