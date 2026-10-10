import type { Db } from "../index.js";

export type LinkStatus = "pending" | "ready" | "needs_review" | "failed" | "expired" | "purged";

export interface LinkRow {
  link_id_hash: string;
  patient_id: string;
  status: LinkStatus;
  created_at: string;
  expires_at: string;
  key_version: number;
  enc_key: Buffer | Uint8Array | null;
  last_viewed_at: string | null;
  language: string | null;
  languages: string | null;
  caregiver_email: string | null;
  caregiver_approved: number;
}

export interface LinkRecord {
  linkIdHash: string;
  patientId: string;
  status: LinkStatus;
  createdAt: string;
  expiresAt: string;
  keyVersion: number;
  encKey: Buffer | null;
  lastViewedAt: string | null;
  language: string | null;
  /** Languages picked at ingest (BCP-47), translated at synthesis so the toggle is instant. */
  languages: string[];
  caregiverEmail: string | null;
  caregiverApproved: boolean;
}

function parseLanguages(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toRecord(r: LinkRow): LinkRecord {
  return {
    linkIdHash: r.link_id_hash,
    patientId: r.patient_id,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    keyVersion: Number(r.key_version),
    encKey: r.enc_key ? Buffer.from(r.enc_key) : null,
    lastViewedAt: r.last_viewed_at,
    language: r.language,
    languages: parseLanguages(r.languages),
    caregiverEmail: r.caregiver_email,
    caregiverApproved: Number(r.caregiver_approved) === 1,
  };
}

export class LinksRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    linkIdHash: string;
    patientId: string;
    createdAt: string;
    expiresAt: string;
    keyVersion: number;
    encKey: Buffer;
    language?: string | null;
    languages?: string[];
    caregiverEmail?: string | null;
    caregiverApproved?: boolean;
  }): Promise<LinkRecord> {
    await this.db.run(
      `INSERT INTO links (link_id_hash, patient_id, status, created_at, expires_at, key_version, enc_key, language, languages, caregiver_email, caregiver_approved)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.linkIdHash,
        input.patientId,
        input.createdAt,
        input.expiresAt,
        input.keyVersion,
        input.encKey,
        input.language ?? null,
        input.languages?.length ? JSON.stringify(input.languages) : null,
        input.caregiverEmail ?? null,
        input.caregiverApproved ? 1 : 0,
      ],
    );
    return (await this.getByHash(input.linkIdHash))!;
  }

  async setLanguages(hash: string, languages: string[]): Promise<void> {
    await this.db.run("UPDATE links SET languages = ? WHERE link_id_hash = ?", [languages.length ? JSON.stringify(languages) : null, hash]);
  }

  async getByHash(hash: string): Promise<LinkRecord | undefined> {
    const row = await this.db.get<LinkRow>("SELECT * FROM links WHERE link_id_hash = ?", [hash]);
    return row ? toRecord(row) : undefined;
  }

  async setStatus(hash: string, status: LinkStatus): Promise<void> {
    await this.db.run("UPDATE links SET status = ? WHERE link_id_hash = ?", [status, hash]);
  }

  async touchViewed(hash: string, at: string): Promise<void> {
    await this.db.run("UPDATE links SET last_viewed_at = ? WHERE link_id_hash = ?", [at, hash]);
  }

  /** Crypto-shredding: the data key is gone for good. */
  async destroyKey(hash: string): Promise<void> {
    await this.db.run("UPDATE links SET enc_key = NULL WHERE link_id_hash = ?", [hash]);
  }

  /** Links whose expiry has passed and that have not been purged yet. */
  async listExpiredUnpurged(nowIso: string): Promise<LinkRecord[]> {
    const rows = await this.db.all<LinkRow>(
      "SELECT * FROM links WHERE expires_at <= ? AND status <> 'purged' ORDER BY expires_at",
      [nowIso],
    );
    return rows.map(toRecord);
  }

  async listByPatient(patientId: string): Promise<LinkRecord[]> {
    const rows = await this.db.all<LinkRow>("SELECT * FROM links WHERE patient_id = ? ORDER BY created_at DESC", [
      patientId,
    ]);
    return rows.map(toRecord);
  }
}
