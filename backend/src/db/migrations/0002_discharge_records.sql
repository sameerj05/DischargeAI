-- Team data contract (lane 4): the document table is named discharge_records and its TTL attribute is
-- expiresAt, on DynamoDB and in this local twin alike. Quoted identifiers keep the camelCase attribute
-- names on Postgres. Rows carry over from the first schema's `documents` table.

CREATE TABLE IF NOT EXISTS discharge_records (
  pk TEXT NOT NULL,
  sk TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "createdAt" TEXT NOT NULL,
  PRIMARY KEY (pk, sk)
);
CREATE INDEX IF NOT EXISTS discharge_records_expires_at ON discharge_records ("expiresAt");

INSERT INTO discharge_records (pk, sk, ciphertext, iv, tag, "keyVersion", "expiresAt", "createdAt")
  SELECT pk, sk, ciphertext, iv, tag, key_version, expires_at, created_at FROM documents;
DROP TABLE documents;

-- Languages the provider picked at ingest (JSON array of BCP-47 codes); translated at synthesis.
ALTER TABLE links ADD COLUMN languages TEXT;
