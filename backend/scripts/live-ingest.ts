/**
 * Live Bedrock run: ingests Example 1 (CHF) through the real pipeline with LLM_PROVIDER=bedrock,
 * translates it to Spanish, and writes the result (summary JSON, fidelity warnings, back-translation
 * warnings, token usage, latency) to fixtures/live-samples/. AWS credentials come from the shell
 * environment only and are never read, printed or written by this script.
 *
 *   LLM_PROVIDER=bedrock npm run live-ingest            # default model from BEDROCK_MODEL_ID
 *   BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0 npm run live-ingest
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app.js";
import { createContext } from "../src/context.js";
import { loadDotEnv } from "../src/dotenv.js";

loadDotEnv();
const provider = process.env.LLM_PROVIDER ?? "bedrock";
if (provider === "offline") {
  console.error("Set LLM_PROVIDER=bedrock (or anthropic) for a live run; offline would only reproduce the fixture.");
  process.exit(2);
}

const root = join(import.meta.dirname, "..");
const example = process.argv[2] ?? "example-1-chf";
const language = process.argv[3] ?? "Spanish";
const text = readFileSync(join(root, "fixtures", "discharge-summaries", `${example}.txt`), "utf8");

const ctx = await createContext({
  env: { ...process.env, DATABASE_FILE: ":memory:", SQL_DRIVER: "sqlite", DOC_STORE: process.env.DOC_STORE ?? "local", EMAIL_TRANSPORT: "console", EMAIL_QUEUE: "none", DEMO_MODE: "true", PURGE_INTERVAL_MS: "0", LOG_LEVEL: process.env.LOG_LEVEL ?? "warn", PROVIDER_API_KEY: "live-run" },
});
const app = buildApp(ctx);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
const key = { "x-provider-key": "live-run" };

const t0 = Date.now();
const patients = (await (await fetch(`${base}/patients`, { headers: key })).json()) as { patients: { id: string }[] };
const form = new FormData();
form.set("patientId", patients.patients[0].id);
form.set("text", text);
const accepted = (await (await fetch(`${base}/ingest`, { method: "POST", headers: key, body: form })).json()) as { jobId: string; linkId: string };
await ctx.queue.onIdle();
const job = (await (await fetch(`${base}/jobs/${accepted.jobId}`, { headers: key })).json()) as Record<string, unknown>;
const summaryRes = await fetch(`${base}/summary?link=${accepted.linkId}`);
const summary = (await summaryRes.json()) as Record<string, unknown>;
let translation: Record<string, unknown> | undefined;
if (summaryRes.status === 200) {
  translation = (await (await fetch(`${base}/translate?link=${accepted.linkId}&language=${encodeURIComponent(language)}`)).json()) as Record<string, unknown>;
}
server.close();
await ctx.close();

const modelId = provider === "bedrock" ? ctx.config.BEDROCK_MODEL_ID : ctx.config.ANTHROPIC_MODEL;
const date = new Date().toISOString();
const out = {
  verified: `live on ${provider}`,
  provider,
  modelId,
  region: provider === "bedrock" ? ctx.config.AWS_REGION : undefined,
  date,
  example,
  wallMs: Date.now() - t0,
  job: { stage: job.stage, warnings: job.warnings, meta: job.meta },
  summary: summaryRes.status === 200 ? summary : { status: summaryRes.status, body: summary },
  translation: translation
    ? { language, fromCache: translation.fromCache, warnings: translation.warnings, verification: translation.verification, summary: translation.summary, medications: translation.medications }
    : undefined,
};
const dir = join(root, "fixtures", "live-samples");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${example}.${provider}.${modelId.replace(/[^A-Za-z0-9.-]+/g, "_")}.${date.slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ file, stage: job.stage, warnings: (job.warnings as unknown[]).length, meta: job.meta, translationWarnings: (translation?.warnings as unknown[] | undefined)?.length }, null, 2));
process.exit(job.stage === "failed" ? 1 : 0);
