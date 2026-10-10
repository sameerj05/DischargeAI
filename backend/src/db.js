import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

const caBundle = readFileSync(
  new URL('../../certs/global-bundle.pem', import.meta.url),
);

export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: 'dischargeai',
  connectionLimit: 10,
  ssl: { ca: caBundle, rejectUnauthorized: true },
});
