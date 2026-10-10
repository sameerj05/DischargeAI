/** Seeds the six synthetic patients into the configured SQL database. Idempotent; also runs at boot. */
import { createContext } from "../src/context.js";
import { loadDotEnv } from "../src/dotenv.js";

loadDotEnv();
const ctx = await createContext({ env: { ...process.env, LLM_PROVIDER: "offline", TRANSCRIBE_PROVIDER: "offline", PURGE_INTERVAL_MS: "0" } });
const count = await ctx.patients.count();
console.log(JSON.stringify({ sql: ctx.db.dialect, target: ctx.sql.target, fallback: ctx.sql.fallback ?? null, configSource: ctx.boot.source, patients: count }));
await ctx.close();
