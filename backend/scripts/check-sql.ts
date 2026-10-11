/**
 * Opens the configured SQL database, applies the migrations and prints what it found. Use it from a
 * host that can reach RDS on port 3306 (the team's EC2 box) to prove the MariaDB path:
 *   npm run check-sql                                   the Secrets Manager values (AWS credentials in the shell)
 *   DATABASE_URL='mysql://admin:<password>@patients.cleqcmkoulma.us-west-2.rds.amazonaws.com:3306/dischargeai' npm run check-sql
 * It also reads the team's patients table (PATIENTS_TABLE, default patientinfo): its real column names,
 * how they map to the GET /patients keys, and its row count. Never values. The password is never
 * printed. Pass it through the environment, not on a shared command line.
 */
import { loadRuntimeEnv } from "../src/bootstrap.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { migrate, REQUIRED_TABLES } from "../src/db/migrate.js";
import { PatientsRepo } from "../src/db/repos/patients.js";

const { env, secrets } = await loadRuntimeEnv();
const config = loadConfig(env);
const t0 = Date.now();
const db = await openDb(config);
let setAside: string[] = [];
const ran = await migrate(db, undefined, (renamed) => (setAside = renamed));
const counts: Record<string, number> = {};
for (const t of [...REQUIRED_TABLES, "schema_migrations"]) counts[t] = Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${t}`))?.n ?? 0);
const patientsRepo = new PatientsRepo(db, config.PATIENTS_TABLE);
let patients: Record<string, unknown>;
try {
  const info = await patientsRepo.init();
  patients = { ...info, rows: await patientsRepo.count() };
} catch (err) {
  patients = { table: config.PATIENTS_TABLE, error: (err as Error).message };
}
const version = (await db.get<{ v: string }>("SELECT VERSION() AS v"))?.v;
await db.close();
console.log(JSON.stringify({ ok: true, connection: db.describe, serverVersion: version, configSource: secrets.source, fromSecret: secrets.applied, migrationsApplied: ran, preContractTablesSetAside: setAside, counts, patients, ms: Date.now() - t0 }, null, 2));
