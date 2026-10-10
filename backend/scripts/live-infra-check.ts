/**
 * Exercises the real team infrastructure once from wherever it runs and writes a report with names
 * only (never a secret value, never PHI) to fixtures/live-samples/infra-check.<date>.json:
 *   1. Secrets Manager  GetSecretValue on AWS_SECRET_ARN: which keys exist, which env vars they filled
 *   2. DynamoDB         DescribeTable + DescribeTimeToLive on the table, then put / get / list /
 *                       delete of one probe item (uid probe#<random>, a sealed non-PHI string)
 *   3. S3               HeadBucket + lifecycle rules on AUDIO_BUCKET, then put / head / get / delete
 *                       of one small sealed non-PHI object under audio/<random hash>
 *   4. Bedrock          one Converse call on BEDROCK_MODEL_ID asking for the word "ok"
 *   5. MySQL            a TCP connect attempt to the RDS host (port 3306 is closed to the build
 *                       container, so this is expected to report unreachable there)
 * Every probe item is deleted before the script exits. Exit code 1 when a required check failed.
 *   source <your aws creds> && npm run live-infra-check
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { DescribeTableCommand, DescribeTimeToLiveCommand } from "@aws-sdk/client-dynamodb";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GetBucketLifecycleConfigurationCommand, S3Client } from "@aws-sdk/client-s3";
import { S3AudioStore, probeBucket, ruleCoversAudio } from "../src/audiostore/s3.js";
import { SecureAudio } from "../src/audiostore/secure.js";
import { loadConfig } from "../src/config.js";
import { bootstrapSecrets } from "../src/config/secrets.js";
import { newDataKey } from "../src/crypto/envelope.js";
import { createDynamoClient, DynamoDocumentStore } from "../src/docstore/dynamo.js";
import { SecureDocs } from "../src/docstore/secure.js";
import { DOC } from "../src/docstore/types.js";
import { loadDotEnv } from "../src/dotenv.js";
import { createLogger } from "../src/logger.js";

loadDotEnv();
const log = createLogger(process.env.LOG_LEVEL ?? "warn");
const date = new Date().toISOString();
const report: Record<string, unknown> = { date, note: "names and outcomes only; no secret values, no PHI" };
let failed = false;

async function check(name: string, required: boolean, fn: () => Promise<Record<string, unknown>>) {
  const t0 = Date.now();
  try {
    const out = await fn();
    report[name] = { ok: true, ms: Date.now() - t0, ...out };
    console.log(`${name}: ok (${Date.now() - t0} ms)`);
  } catch (err) {
    const e = err as { name?: string; message?: string };
    report[name] = { ok: false, required, ms: Date.now() - t0, errorName: e?.name, error: String(e?.message ?? err).slice(0, 300) };
    console.log(`${name}: ${required ? "FAILED" : "not reachable (expected here)"}: ${e?.name ?? ""} ${String(e?.message ?? err).slice(0, 200)}`);
    if (required) failed = true;
  }
}

// 1. Secrets Manager
const boot = await bootstrapSecrets(process.env, log);
const { env: bootedEnv, ...bootReport } = boot;
report.secretsManager = { ok: boot.loaded, ...bootReport };
console.log(`secretsManager: ${boot.loaded ? "ok" : `not loaded (${boot.reason})`}`);
if (!boot.loaded) failed = true;
const config = loadConfig(bootedEnv);
report.region = config.AWS_REGION;

// 2. DynamoDB
await check("dynamodb", true, async () => {
  const client = createDynamoClient({ region: config.AWS_REGION, endpoint: config.DYNAMO_ENDPOINT });
  const described = await client.send(new DescribeTableCommand({ TableName: config.DYNAMO_TABLE }));
  const ttl = await client.send(new DescribeTimeToLiveCommand({ TableName: config.DYNAMO_TABLE }));
  const store = new DynamoDocumentStore({ tableName: config.DYNAMO_TABLE, hashKey: config.DYNAMO_PK, region: config.AWS_REGION, endpoint: config.DYNAMO_ENDPOINT });
  const secure = new SecureDocs(store);
  const probeHash = createHash("sha256").update(`probe:${randomBytes(8).toString("hex")}`).digest("hex");
  const key = newDataKey();
  const expiresAt = Math.floor(Date.now() / 1000) + 600; // TTL backstop in case cleanup fails
  await secure.putJson({ linkIdHash: probeHash, doc: DOC.simplified, key, keyVersion: 1, value: { probe: true, text: "non-PHI probe" }, expiresAtEpochSeconds: expiresAt, createdAt: date });
  await secure.putJson({ linkIdHash: probeHash, doc: DOC.translation("es"), key, keyVersion: 1, value: { probe: true }, expiresAtEpochSeconds: expiresAt, createdAt: date });
  const back = await secure.getJson<{ probe: boolean }>({ linkIdHash: probeHash, doc: DOC.simplified, key });
  const docs = await secure.listDocs(probeHash);
  await store.delete(`link#${probeHash}`, DOC.translation("es"));
  const afterOne = await secure.listDocs(probeHash);
  const deleted = await secure.deleteAll(probeHash);
  const gone = await secure.listDocs(probeHash);
  client.destroy();
  if (!back?.probe || docs.length !== 2 || afterOne.length !== 1 || deleted !== 1 || gone.length !== 0) throw new Error(`probe round trip mismatch: ${JSON.stringify({ back, docs, afterOne, deleted, gone })}`);
  return {
    table: config.DYNAMO_TABLE,
    hashKey: config.DYNAMO_PK,
    status: described.Table?.TableStatus,
    keySchema: described.Table?.KeySchema,
    itemCountBefore: described.Table?.ItemCount,
    ttl: ttl.TimeToLiveDescription,
    probe: { uid: `link#${probeHash}`, put: 2, got: true, listed: docs, afterRemoveOne: afterOne, deletedByDeleteAll: deleted, remaining: gone },
  };
});

// 3. S3
await check("s3", true, async () => {
  const bucket = config.AUDIO_BUCKET;
  await probeBucket(bucket, config.AWS_REGION);
  const s3 = new S3Client({ region: config.AWS_REGION });
  let rules: { id?: string; status?: string; prefix: string; expirationDays?: number; coversAudio: boolean }[] = [];
  try {
    const r = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    rules = (r.Rules ?? []).map((x) => ({ id: x.ID, status: x.Status, prefix: x.Filter?.Prefix ?? x.Prefix ?? "", expirationDays: x.Expiration?.Days, coversAudio: ruleCoversAudio(x) }));
  } catch (err) {
    if ((err as { name?: string }).name !== "NoSuchLifecycleConfiguration") throw err;
  }
  const store = new S3AudioStore({ bucket, region: config.AWS_REGION, client: s3 });
  const secure = new SecureAudio(store);
  const probeHash = createHash("sha256").update(`probe:${randomBytes(8).toString("hex")}`).digest("hex");
  const key = newDataKey();
  const body = Buffer.from("RIFF non-PHI probe clip");
  const put = await secure.put({ linkIdHash: probeHash, key, keyVersion: 1, body, contentType: "audio/wav", expiresAt: Math.floor(Date.now() / 1000) + 600, createdAt: date });
  const head = await store.head(probeHash);
  const got = await secure.get({ linkIdHash: probeHash, key });
  const deleted = await store.delete(probeHash);
  const afterDelete = await store.head(probeHash);
  s3.destroy();
  if (!head || !got?.body.equals(body) || !deleted || afterDelete !== null) throw new Error("probe round trip mismatch");
  return { bucket, lifecycle: rules, coveredBy: rules.find((r) => r.coversAudio)?.id ?? null, probe: { key: put.key, bytes: put.bytes, sse: "AES256", headOk: true, getOk: true, deleted: true, afterDelete: null } };
});

// 4. Bedrock
await check("bedrock", true, async () => {
  const client = new BedrockRuntimeClient({ region: config.AWS_REGION });
  const r = await client.send(
    new ConverseCommand({
      modelId: config.BEDROCK_MODEL_ID,
      messages: [{ role: "user", content: [{ text: "Reply with the single word: ok" }] }],
      inferenceConfig: { maxTokens: 8, temperature: 0 },
    }),
  );
  client.destroy();
  const text = (r.output?.message?.content ?? []).map((c) => ("text" in c ? c.text : "")).join("").trim();
  return { modelId: config.BEDROCK_MODEL_ID, stopReason: r.stopReason, usage: r.usage, latencyMs: r.metrics?.latencyMs, reply: text.slice(0, 40) };
});

// 5. MySQL reachability (TCP only; the password never leaves Secrets Manager)
await check("mysqlTcp", false, async () => {
  const host = config.MYSQL_HOST;
  if (!host) throw new Error("MYSQL_HOST not known (secret not loaded)");
  await new Promise<void>((resolve, reject) => {
    const sock = createConnection({ host, port: config.MYSQL_PORT, timeout: 4000 });
    sock.once("connect", () => {
      sock.destroy();
      resolve();
    });
    sock.once("timeout", () => {
      sock.destroy();
      reject(new Error(`TCP connect to ${host}:${config.MYSQL_PORT} timed out`));
    });
    sock.once("error", reject);
  });
  return { host, port: config.MYSQL_PORT, database: config.MYSQL_DATABASE, user: config.MYSQL_USER, tcp: "open" };
});

const dir = join(import.meta.dirname, "..", "fixtures", "live-samples");
mkdirSync(dir, { recursive: true });
const file = join(dir, `infra-check.${date.slice(0, 10)}.json`);
const serialized = JSON.stringify(report, null, 2);
for (const secretValue of [config.MYSQL_PASSWORD, process.env.AWS_SECRET_ACCESS_KEY, process.env.AWS_SESSION_TOKEN, process.env.AWS_ACCESS_KEY_ID]) {
  if (secretValue && serialized.includes(secretValue)) throw new Error("refusing to write a report that contains a secret value");
}
writeFileSync(file, serialized + "\n");
console.log(`report: ${file}`);
process.exit(failed ? 1 : 0);
