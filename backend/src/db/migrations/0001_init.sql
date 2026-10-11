-- DischargeAI backend schema (the team contract), MariaDB on the team's RDS instance `patients`,
-- database `dischargeai`. Written in portable SQL (VARCHAR for keyed columns, TEXT for JSON blobs,
-- INTEGER for counters); src/db/migrate.ts rewrites the few MariaDB-specific tokens (AUTOINCREMENT,
-- TEXT sizes). Timestamps are ISO-8601 strings produced by the app clock, never by the database, so
-- expiry is computed in one place. The summaries themselves live in DynamoDB, not here.

-- Patients are NOT created here: they live in the team's own table (`patientinfo`, see
-- 0002_patientinfo.*.sql and src/db/repos/patients.ts), which this backend only reads.

-- The team contract's activeLinks table: POST /ingest generates a random path (sumId), stores it here
-- as-is (teammates join on it) and uses the same value as the DynamoDB uid. status follows the link
-- through its life; expiresAt = createdAt + 30 days. patientID is the id from the patients table. The remaining columns are the backend's own
-- bookkeeping (languages held, object keys in the buckets, view and email timestamps).
CREATE TABLE IF NOT EXISTS activeLinks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sumId VARCHAR(32) NOT NULL,
  patientID VARCHAR(64) NOT NULL,
  createdAt VARCHAR(32) NOT NULL,
  expiresAt VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  language VARCHAR(16) NOT NULL DEFAULT 'en',
  languages VARCHAR(512) NOT NULL DEFAULT '["en"]',
  pdfKey VARCHAR(80),
  audioKey VARCHAR(80),
  lastViewedAt VARCHAR(32),
  emailedAt VARCHAR(32),
  CONSTRAINT uq_activeLinks_sumId UNIQUE (sumId),
  CONSTRAINT ck_activeLinks_status CHECK (status IN ('pending', 'ready', 'needs_review', 'failed', 'expired', 'purged'))
);
CREATE INDEX IF NOT EXISTS activeLinks_expiresAt ON activeLinks (expiresAt);
CREATE INDEX IF NOT EXISTS activeLinks_patientID ON activeLinks (patientID);

-- The ingest pipeline, persisted so the 202 can be followed and a restart does not lose a job.
-- safety = JSON of the deterministic safety-check result (counts, names and doses; no patient data).
CREATE TABLE IF NOT EXISTS jobs (
  id VARCHAR(64) PRIMARY KEY,
  sum_id VARCHAR(32) NOT NULL,
  stage VARCHAR(16) NOT NULL,
  input_kind VARCHAR(8) NOT NULL,
  error VARCHAR(512),
  safety TEXT,
  meta TEXT,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_jobs_link FOREIGN KEY (sum_id) REFERENCES activeLinks (sumId)
);
CREATE INDEX IF NOT EXISTS jobs_sum_id ON jobs (sum_id);
CREATE INDEX IF NOT EXISTS jobs_stage ON jobs (stage);

-- Event trail and deletion receipts. details is JSON and never carries PHI.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event VARCHAR(40) NOT NULL,
  sum_id VARCHAR(32),
  actor VARCHAR(16) NOT NULL,
  at VARCHAR(32) NOT NULL,
  details TEXT,
  CONSTRAINT ck_audit_actor CHECK (actor IN ('provider', 'patient', 'system'))
);
CREATE INDEX IF NOT EXISTS audit_sum_id ON audit_log (sum_id);
CREATE INDEX IF NOT EXISTS audit_event ON audit_log (event);
