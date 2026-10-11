/**
 * Runs the 30-day self-destruct once against the configured stores and prints what it did:
 *   npm run sweep                                  real clock: purges links whose expiry has passed
 *   DEMO_NOW=2026-11-11T00:00:00Z npm run sweep    demo: the clock is pinned 31 days ahead, so links
 *                                                  created today expire now; summary items, PDFs and
 *                                                  audio are deleted and receipts written
 * Uses the same .env / Secrets Manager configuration as the server, so it runs against RDS + DynamoDB +
 * S3 in the team account. One-shot: it never resumes jobs. With DEMO_NOW set it refuses to run unless
 * DEMO_PURGE_ON_AWS=yes (a throwaway account), because the shifted clock would delete recent shared data.
 */
import { loadRuntimeEnv } from "../src/bootstrap.js";
import { createContext } from "../src/context.js";

const { env, secrets } = await loadRuntimeEnv();
const ctx = await createContext({
  env: { ...env, EMAIL_TRANSPORT: "console", EMAIL_QUEUE: "none", PURGE_INTERVAL_MS: "0", LOG_LEVEL: env.LOG_LEVEL ?? "warn" },
  secrets,
  resumeJobs: false,
});
const report = await ctx.purge();
console.log(JSON.stringify({ clock: { now: ctx.clock.nowIso(), demoNow: ctx.clock.demoNow, offsetDays: ctx.clock.offsetDays }, configSource: secrets.source, sql: ctx.db.describe, docStore: ctx.summaries.name, pdfStore: ctx.pdf.describe(), audioStore: ctx.audio.describe(), ...report }, null, 2));
await ctx.close();
