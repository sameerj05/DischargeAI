-- Patients move to the team's table `patientinfo` (read-only for this backend; GET /patients reads it).
-- MariaDB/MySQL: drop the foreign key from activeLinks to the old `patients` table when a database
-- migrated by the earlier 0001 has it (the migration runner ignores "does not exist"), and create
-- `patientinfo` with the tasks doc's column names only when the database has none. On the team's RDS
-- the table already exists, so nothing about it changes. The old `patients` table, if any, is left
-- untouched and unused; drop it by hand once nothing needs it.
ALTER TABLE activeLinks DROP FOREIGN KEY fk_activeLinks_patient;
CREATE TABLE IF NOT EXISTS patientinfo (
  ID VARCHAR(64) PRIMARY KEY,
  DOB VARCHAR(10),
  FirstName VARCHAR(120),
  LastName VARCHAR(120),
  ZipCode VARCHAR(16),
  email VARCHAR(254),
  phoneNumber VARCHAR(32),
  caregiverEmail VARCHAR(254),
  caregiverName VARCHAR(160),
  preferredLanguage VARCHAR(16)
);
