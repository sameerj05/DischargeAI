-- Sum-ids grow from 22 to 43 characters (256 random bits), because the same value is the AgentCore
-- session id and AgentCore requires at least 33. Widen every column that holds one. The foreign key
-- from jobs to activeLinks is dropped while both sides change and put back afterwards (MariaDB will
-- not change a column a foreign key uses). Rows already there keep their values.
ALTER TABLE jobs DROP FOREIGN KEY fk_jobs_link;
ALTER TABLE activeLinks MODIFY sumId VARCHAR(64) NOT NULL;
ALTER TABLE jobs MODIFY sum_id VARCHAR(64) NOT NULL;
ALTER TABLE audit_log MODIFY sum_id VARCHAR(64);
ALTER TABLE jobs ADD CONSTRAINT fk_jobs_link FOREIGN KEY (sum_id) REFERENCES activeLinks (sumId);
