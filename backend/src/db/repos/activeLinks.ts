import type { Db } from "../index.js";

export type LinkStatus = "pending" | "ready" | "failed" | "expired" | "purged";

/** The team contract's activeLinks row (id auto, sumId, patientID, createdAt, expiresAt, status) plus the backend's bookkeeping columns. */
export interface ActiveLinkRow {
  id: number;
  sumId: string;
  patientID: string;
  createdAt: string;
  expiresAt: string;
  status: LinkStatus;
  pdfKey: string | null;
  audioKey: string | null;
  lastViewedAt: string | null;
  emailedAt: string | null;
}

export interface ActiveLink {
  id: number;
  /** The random path: the link id, the DynamoDB uid and sum-id. Stored as-is. */
  sumId: string;
  patientID: string;
  createdAt: string;
  expiresAt: string;
  status: LinkStatus;
  /** Object key of the PDF in the PDF bucket (emrpdf-rh), when the input was a PDF. */
  pdfKey: string | null;
  /** Object key of the audio clip in the audio bucket (emraudio-rh), when the input was audio. */
  audioKey: string | null;
  lastViewedAt: string | null;
  emailedAt: string | null;
}

function toRecord(r: ActiveLinkRow): ActiveLink {
  return {
    id: Number(r.id),
    sumId: r.sumId,
    patientID: r.patientID,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    status: r.status,
    pdfKey: r.pdfKey,
    audioKey: r.audioKey,
    lastViewedAt: r.lastViewedAt,
    emailedAt: r.emailedAt,
  };
}

export class ActiveLinksRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    sumId: string;
    patientID: string;
    createdAt: string;
    expiresAt: string;
    pdfKey?: string | null;
    audioKey?: string | null;
  }): Promise<ActiveLink> {
    await this.db.run(
      `INSERT INTO activeLinks (sumId, patientID, createdAt, expiresAt, status, pdfKey, audioKey)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [input.sumId, input.patientID, input.createdAt, input.expiresAt, input.pdfKey ?? null, input.audioKey ?? null],
    );
    return (await this.getBySumId(input.sumId))!;
  }

  async getBySumId(sumId: string): Promise<ActiveLink | undefined> {
    const row = await this.db.get<ActiveLinkRow>("SELECT * FROM activeLinks WHERE sumId = ?", [sumId]);
    return row ? toRecord(row) : undefined;
  }

  async setStatus(sumId: string, status: LinkStatus): Promise<void> {
    await this.db.run("UPDATE activeLinks SET status = ? WHERE sumId = ?", [status, sumId]);
  }

  async setPdfKey(sumId: string, pdfKey: string | null): Promise<void> {
    await this.db.run("UPDATE activeLinks SET pdfKey = ? WHERE sumId = ?", [pdfKey, sumId]);
  }

  async setAudioKey(sumId: string, audioKey: string | null): Promise<void> {
    await this.db.run("UPDATE activeLinks SET audioKey = ? WHERE sumId = ?", [audioKey, sumId]);
  }

  async touchViewed(sumId: string, at: string): Promise<void> {
    await this.db.run("UPDATE activeLinks SET lastViewedAt = ? WHERE sumId = ?", [at, sumId]);
  }

  async markEmailed(sumId: string, at: string): Promise<void> {
    await this.db.run("UPDATE activeLinks SET emailedAt = ? WHERE sumId = ?", [at, sumId]);
  }

  /** Links whose expiry has passed and that have not been purged yet. */
  async listExpiredUnpurged(nowIso: string): Promise<ActiveLink[]> {
    const rows = await this.db.all<ActiveLinkRow>("SELECT * FROM activeLinks WHERE expiresAt <= ? AND status <> 'purged' ORDER BY expiresAt", [nowIso]);
    return rows.map(toRecord);
  }

  async listByPatient(patientID: string): Promise<ActiveLink[]> {
    const rows = await this.db.all<ActiveLinkRow>("SELECT * FROM activeLinks WHERE patientID = ? ORDER BY id DESC", [patientID]);
    return rows.map(toRecord);
  }

  /** The patient's newest link that is still alive (not expired or purged), if any. */
  async activeForPatient(patientID: string, nowIso: string): Promise<ActiveLink | undefined> {
    const row = await this.db.get<ActiveLinkRow>(
      "SELECT * FROM activeLinks WHERE patientID = ? AND status NOT IN ('expired', 'purged') AND expiresAt > ? ORDER BY id DESC LIMIT 1",
      [patientID, nowIso],
    );
    return row ? toRecord(row) : undefined;
  }

  async count(): Promise<number> {
    const row = await this.db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM activeLinks");
    return Number(row?.n ?? 0);
  }
}
