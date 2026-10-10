-- DischargeAI backend schema for MariaDB/MySQL (the team's RDS instance `patients`, database
-- `dischargeai` from the secret's mysql-db key). Same tables and columns as the SQLite files, in
-- MySQL types: VARCHAR keys (TEXT cannot be a key), VARBINARY/LONGBLOB for ciphertext, TINYINT
-- booleans, BIGINT epoch seconds. Timestamps are ISO-8601 strings produced by the app clock.
-- Indexes are declared inline so the file runs on MariaDB and MySQL alike.

CREATE TABLE IF NOT EXISTS patients (
  id VARCHAR(64) NOT NULL,
  first_name VARCHAR(120) NOT NULL,
  last_name VARCHAR(120) NOT NULL,
  date_of_birth VARCHAR(10) NOT NULL,
  zip_code VARCHAR(16) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  preferred_language VARCHAR(16) NULL,
  active_link_id VARCHAR(32) NULL,
  active_link_expires_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per patient link. Only sha256(linkId) is stored. enc_key is the per-link AES-256-GCM data
-- key; purge sets it to NULL (crypto-shredding).
CREATE TABLE IF NOT EXISTS links (
  link_id_hash CHAR(64) NOT NULL,
  patient_id VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  enc_key VARBINARY(64) NULL,
  last_viewed_at VARCHAR(32) NULL,
  language VARCHAR(16) NULL,
  languages TEXT NULL,
  caregiver_email VARCHAR(255) NULL,
  caregiver_approved TINYINT NOT NULL DEFAULT 0,
  PRIMARY KEY (link_id_hash),
  INDEX links_expires_at (expires_at),
  INDEX links_patient_id (patient_id),
  CONSTRAINT links_patient_fk FOREIGN KEY (patient_id) REFERENCES patients (id),
  CONSTRAINT links_status_chk CHECK (status IN ('pending', 'ready', 'needs_review', 'failed', 'expired', 'purged'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The ingest pipeline, persisted so status survives restarts.
CREATE TABLE IF NOT EXISTS jobs (
  id VARCHAR(64) NOT NULL,
  link_id_hash CHAR(64) NOT NULL,
  stage VARCHAR(16) NOT NULL,
  input_kind VARCHAR(8) NOT NULL,
  error TEXT NULL,
  warnings MEDIUMTEXT NOT NULL,
  meta MEDIUMTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  INDEX jobs_link (link_id_hash),
  INDEX jobs_stage (stage),
  CONSTRAINT jobs_link_fk FOREIGN KEY (link_id_hash) REFERENCES links (link_id_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Event trail. details is JSON and never carries PHI.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  event VARCHAR(40) NOT NULL,
  link_id_hash CHAR(64) NULL,
  actor VARCHAR(10) NOT NULL,
  at VARCHAR(32) NOT NULL,
  details MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id),
  INDEX audit_link (link_id_hash),
  CONSTRAINT audit_actor_chk CHECK (actor IN ('provider', 'patient', 'system'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Patient check-offs on the generated checklist.
CREATE TABLE IF NOT EXISTS checklist_state (
  link_id_hash CHAR(64) NOT NULL,
  item_id VARCHAR(64) NOT NULL,
  completed TINYINT NOT NULL DEFAULT 0,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (link_id_hash, item_id),
  CONSTRAINT checklist_link_fk FOREIGN KEY (link_id_hash) REFERENCES links (link_id_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- SQL twin of the DynamoDB table discharge-summaries (hash key uid, TTL attribute expiresAt):
-- one row per (uid, doc) where DynamoDB keeps one item per uid with one attribute per document.
CREATE TABLE IF NOT EXISTS discharge_summaries (
  uid VARCHAR(80) NOT NULL,
  doc VARCHAR(40) NOT NULL,
  ciphertext LONGBLOB NOT NULL,
  iv VARBINARY(16) NOT NULL,
  tag VARBINARY(16) NOT NULL,
  key_version INT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (uid, doc),
  INDEX discharge_summaries_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
