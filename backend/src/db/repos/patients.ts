import { randomUUID } from "node:crypto";
import type { Db } from "../index.js";

export interface PatientRow {
  id: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  zip_code: string;
  email: string;
  phone: string;
  preferred_language: string | null;
  active_link_id: string | null;
  active_link_expires_at: string | null;
  created_at: string;
}

export interface Patient {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  zipCode: string;
  email: string;
  phone: string;
  preferredLanguage: string | null;
  activeLinkId: string | null;
  activeLinkExpiresAt: string | null;
  createdAt: string;
}

export interface NewPatient {
  id?: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  zipCode: string;
  email: string;
  phone: string;
  preferredLanguage?: string | null;
}

export function toPatient(r: PatientRow): Patient {
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    dateOfBirth: r.date_of_birth,
    zipCode: r.zip_code,
    email: r.email,
    phone: r.phone,
    preferredLanguage: r.preferred_language,
    activeLinkId: r.active_link_id,
    activeLinkExpiresAt: r.active_link_expires_at,
    createdAt: r.created_at,
  };
}

export class PatientsRepo {
  constructor(private readonly db: Db) {}

  async list(q?: string): Promise<Patient[]> {
    if (q && q.trim()) {
      const like = `%${q.trim().toLowerCase()}%`;
      const rows = await this.db.all<PatientRow>(
        `SELECT * FROM patients
         WHERE LOWER(first_name) LIKE ? OR LOWER(last_name) LIKE ? OR LOWER(email) LIKE ? OR phone LIKE ?
            OR LOWER(CONCAT(first_name, ' ', last_name)) LIKE ?
         ORDER BY last_name, first_name`,
        [like, like, like, like, like],
      );
      return rows.map(toPatient);
    }
    const rows = await this.db.all<PatientRow>("SELECT * FROM patients ORDER BY last_name, first_name");
    return rows.map(toPatient);
  }

  async getById(id: string): Promise<Patient | undefined> {
    const row = await this.db.get<PatientRow>("SELECT * FROM patients WHERE id = ?", [id]);
    return row ? toPatient(row) : undefined;
  }

  async count(): Promise<number> {
    const row = await this.db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM patients");
    return Number(row?.n ?? 0);
  }

  async create(p: NewPatient, createdAt: string): Promise<Patient> {
    const id = p.id ?? randomUUID();
    await this.db.run(
      `INSERT INTO patients (id, first_name, last_name, date_of_birth, zip_code, email, phone, preferred_language, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p.firstName, p.lastName, p.dateOfBirth, p.zipCode, p.email, p.phone, p.preferredLanguage ?? null, createdAt],
    );
    return (await this.getById(id))!;
  }

  async setActiveLink(id: string, linkId: string, expiresAt: string): Promise<void> {
    await this.db.run("UPDATE patients SET active_link_id = ?, active_link_expires_at = ? WHERE id = ?", [
      linkId,
      expiresAt,
      id,
    ]);
  }

  /** Clears the active link only if it still points at the given link id (an older link must not clobber a newer one). */
  async clearActiveLink(id: string, linkId: string): Promise<void> {
    await this.db.run(
      "UPDATE patients SET active_link_id = NULL, active_link_expires_at = NULL WHERE id = ? AND active_link_id = ?",
      [id, linkId],
    );
  }
}
