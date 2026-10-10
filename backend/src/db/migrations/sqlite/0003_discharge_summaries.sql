-- The real team table is DynamoDB `discharge-summaries` with hash key `uid` and TTL attribute
-- `expiresAt`. This SQL twin (`discharge_summaries`, hyphen spelled as underscore) keeps one row per
-- (uid, doc) where DynamoDB keeps one item per uid with one attribute per document. Rows carry over
-- from the earlier discharge_records table (pk -> uid, sk -> doc).

CREATE TABLE IF NOT EXISTS discharge_summaries (
  uid TEXT NOT NULL,
  doc TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (uid, doc)
);
CREATE INDEX IF NOT EXISTS discharge_summaries_expires_at ON discharge_summaries (expires_at);

INSERT INTO discharge_summaries (uid, doc, ciphertext, iv, tag, key_version, expires_at, created_at)
  SELECT pk, sk, ciphertext, iv, tag, "keyVersion", "expiresAt", "createdAt" FROM discharge_records;
DROP TABLE discharge_records;
