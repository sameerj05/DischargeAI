import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

const { DB_HOST, DB_USER, DB_PASSWORD } = process.env;
const DB_NAME = 'dischargeai';

// Without DB_HOST, mysql2 silently falls back to localhost.
const missing = Object.entries({ DB_HOST, DB_USER, DB_PASSWORD })
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`Database: ${DB_USER}@${DB_HOST}/${DB_NAME}`);

const caBundle = readFileSync(
  new URL('../../certs/global-bundle.pem', import.meta.url),
);

export const pool = mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  connectionLimit: 10,
  ssl: { ca: caBundle, rejectUnauthorized: true },
});
