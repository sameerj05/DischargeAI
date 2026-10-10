-- DischargeAI backend, initial schema. Portable SQL: TEXT / INTEGER / BLOB only (BLOB -> BYTEA on Postgres).
-- Timestamps are ISO-8601 TEXT produced by the app clock, never by the database.

CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,
  zip_code TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  preferred_language TEXT,
  active_link_id TEXT,
  active_link_expires_at TEXT,
  created_at TEXT NOT NULL
);

-- One row per patient link. Only sha256(linkId) is stored; the raw id lives in the 202 response,
-- the email and patients.active_link_id (cleared at purge). enc_key is the per-link AES-256-GCM data
-- key; purge sets it to NULL (crypto-shredding) so lagging document deletes are already unreadable.
CREATE TABLE IF NOT EXISTS links (
  link_id_hash TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'needs_review', 'failed', 'expired', 'purged')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  enc_key BLOB,
  last_viewed_at TEXT,
  language TEXT,
  caregiver_email TEXT,
  caregiver_approved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS links_expires_at ON links (expires_at);
CREATE INDEX IF NOT EXISTS links_patient_id ON links (patient_id);

-- The ingest pipeline, persisted so status survives restarts.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  link_id_hash TEXT NOT NULL REFERENCES links(link_id_hash),
  stage TEXT NOT NULL,
  input_kind TEXT NOT NULL,
  error TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_link ON jobs (link_id_hash);
CREATE INDEX IF NOT EXISTS jobs_stage ON jobs (stage);

-- Event trail. details is JSON and never carries PHI.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  link_id_hash TEXT,
  actor TEXT NOT NULL CHECK (actor IN ('provider', 'patient', 'system')),
  at TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_link ON audit_log (link_id_hash);

-- Patient check-offs on the generated checklist.
CREATE TABLE IF NOT EXISTS checklist_state (
  link_id_hash TEXT NOT NULL REFERENCES links(link_id_hash),
  item_id TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (link_id_hash, item_id)
);

-- LocalDocumentStore: the SQLite twin of the DynamoDB table (same item shape, expires_at = TTL attribute).
CREATE TABLE IF NOT EXISTS documents (
  pk TEXT NOT NULL,
  sk TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (pk, sk)
);
CREATE INDEX IF NOT EXISTS documents_expires_at ON documents (expires_at);
