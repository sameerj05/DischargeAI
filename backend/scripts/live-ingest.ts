/**
 * Live Bedrock run: ingests Example 1 (CHF) through the real pipeline with LLM_PROVIDER=bedrock,
 * translates it to Spanish, reads it back through GET /p/:token, and writes the result (summary
 * JSON, fidelity warnings, back-translation warnings, token usage, latency) to fixtures/live-samples/.
 * AWS credentials come from the shell environment only and are never read, printed or written by
 * this script. With DOC_STORE=dynamo (or the team secret loaded) the record lands on the real
 * discharge-summaries table; the link's documents are deleted again before the script exits unless
 * --keep is passed, so a live run leaves nothing behind.
 *
 *   LLM_PROVIDER=bedrock npm run live-ingest            # default model from BEDROCK_MODEL_ID
 *   BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0 npm run live-ingest
 *   LLM_PROVIDER=bedrock DOC_STORE=dynamo npm run live-ingest -- example-1-chf Spanish --keep
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
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const keep = process.argv.includes("--keep");
const example = args[0] ?? "example-1-chf";
const language = args[1] ?? "Spanish";
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
let contract: Record<string, unknown> | undefined;
if (summaryRes.status === 200) {
  translation = (await (await fetch(`${base}/translate?link=${accepted.linkId}&language=${encodeURIComponent(language)}`)).json()) as Record<string, unknown>;
  const view = (await (await fetch(`${base}/p/${accepted.linkId}`)).json()) as Record<string, unknown>;
  const { meta, ...fixed } = view;
  contract = { keys: Object.keys(fixed), medications: (fixed.medications as unknown[]).length, steps: (fixed.steps as unknown[]).length, warnings: (fixed.warnings as unknown[]).length, meta: { languages: (meta as Record<string, unknown>).languages, safetyChecks: (meta as Record<string, unknown>).safetyChecks, provenance: (meta as Record<string, unknown>).provenance } };
}
const { hashLinkId } = await import("../src/crypto/linkId.js");
const linkIdHash = hashLinkId(accepted.linkId);
const storedDocs = await ctx.secureDocs.listDocs(linkIdHash);
let cleanup: Record<string, unknown> = { kept: true, documents: storedDocs };
if (!keep) {
  const deleted = await ctx.secureDocs.deleteAll(linkIdHash);
  await ctx.audioStore.delete(linkIdHash);
  cleanup = { kept: false, documents: storedDocs, deleted, remaining: await ctx.secureDocs.listDocs(linkIdHash) };
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
  docStore: { name: ctx.docStore.name, table: ctx.docStore.tableName, hashKey: ctx.docStore.hashKey, configSource: ctx.boot.source },
  cleanup,
  wallMs: Date.now() - t0,
  job: { stage: job.stage, warnings: job.warnings, meta: job.meta },
  summary: summaryRes.status === 200 ? summary : { status: summaryRes.status, body: summary },
  translation: translation
    ? { language, fromCache: translation.fromCache, warnings: translation.warnings, verification: translation.verification, summary: translation.summary, medications: translation.medications }
    : undefined,
  patientView: contract,
};
const dir = join(root, "fixtures", "live-samples");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${example}.${provider}.${modelId.replace(/[^A-Za-z0-9.-]+/g, "_")}.${date.slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ file, stage: job.stage, warnings: (job.warnings as unknown[]).length, meta: job.meta, translationWarnings: (translation?.warnings as unknown[] | undefined)?.length, docStore: out.docStore, cleanup }, null, 2));
process.exit(job.stage === "failed" ? 1 : 0);
