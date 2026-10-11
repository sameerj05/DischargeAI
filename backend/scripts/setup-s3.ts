/**
 * Idempotent setup of the two team buckets: the PDF bucket of the team contract (`emrpdf-rh`,
 * PDF_BUCKET) and the audio bucket (`emraudio-rh`, AUDIO_BUCKET). For each bucket: HeadBucket; when
 * it does not exist, CreateBucket in AWS_REGION; then block public access, set default server-side
 * encryption (AES256) and make sure a 30-day expiration lifecycle rule exists (an existing 30-day
 * rule such as emraudio-rh's `autodelete` is left alone). Safe to re-run: an existing bucket is
 * described, never recreated; settings already in place are reported as unchanged.
 *   npm run setup-s3                 ensure both buckets
 *   npm run setup-s3 -- --check      report only, never create or write (exit 3 when something is missing)
 *   npm run setup-s3 -- --bucket x   one bucket by name
 * IAM: s3:CreateBucket, ListBucket (HeadBucket), GetBucketLocation, PutPublicAccessBlock, GetPublicAccessBlock,
 *      PutEncryptionConfiguration, GetEncryptionConfiguration, GetLifecycleConfiguration, PutLifecycleConfiguration.
 */
import {
  CreateBucketCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import { loadRuntimeEnv } from "../src/bootstrap.js";
import { loadConfig, LINK_TTL_DAYS } from "../src/config.js";
import { mergeTtlRule, RULE_ID } from "./ensure-s3-lifecycle.js";

export interface BucketReport {
  bucket: string;
  /** null when HeadBucket failed for a reason other than 404 (denied, bad credentials): existence unknown. */
  existed: boolean | null;
  created: boolean;
  publicAccessBlocked: boolean;
  encryption: string | null;
  lifecycle: { rulePresent: boolean; rule: string | null; wrote: boolean; rules: { id?: string; status?: string; expirationDays: number | null; prefix: string }[] };
  changes: string[];
  error?: string;
}

const fail = (err: unknown) => `${(err as { name?: string }).name ?? "Error"}: ${String((err as Error).message ?? err).slice(0, 200)}`;

export async function ensureBucket(s3: S3Client, Bucket: string, region: string, checkOnly: boolean): Promise<BucketReport> {
  const report: BucketReport = { bucket: Bucket, existed: null, created: false, publicAccessBlocked: false, encryption: null, lifecycle: { rulePresent: false, rule: null, wrote: false, rules: [] }, changes: [] };
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
    report.existed = true;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name !== "NotFound" && e?.$metadata?.httpStatusCode !== 404) {
      report.error = fail(err);
      return report;
    }
    report.existed = false;
    if (checkOnly) {
      report.changes.push("bucket missing (not created: --check)");
      return report;
    }
    // Bucket names are global: BucketAlreadyExists means someone else owns the name.
    await s3.send(new CreateBucketCommand({ Bucket, ...(region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: region as "us-west-2" } }) }));
    report.created = true;
    report.changes.push("created");
  }

  // Public access block.
  let blocked = false;
  try {
    const pab = (await s3.send(new GetPublicAccessBlockCommand({ Bucket }))).PublicAccessBlockConfiguration;
    blocked = !!(pab?.BlockPublicAcls && pab?.BlockPublicPolicy && pab?.IgnorePublicAcls && pab?.RestrictPublicBuckets);
  } catch (err) {
    if ((err as { name?: string }).name !== "NoSuchPublicAccessBlockConfiguration") throw err;
  }
  if (!blocked && !checkOnly) {
    await s3.send(new PutPublicAccessBlockCommand({ Bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } }));
    blocked = true;
    report.changes.push("public access blocked");
  }
  report.publicAccessBlocked = blocked;

  // Default encryption (every object is also written with SSE explicitly).
  let encryption: string | null = null;
  try {
    const enc = (await s3.send(new GetBucketEncryptionCommand({ Bucket }))).ServerSideEncryptionConfiguration;
    encryption = enc?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? null;
  } catch (err) {
    if ((err as { name?: string }).name !== "ServerSideEncryptionConfigurationNotFoundError") throw err;
  }
  if (!encryption && !checkOnly) {
    await s3.send(new PutBucketEncryptionCommand({ Bucket, ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" }, BucketKeyEnabled: true }] } }));
    encryption = "AES256";
    report.changes.push("default encryption AES256");
  }
  report.encryption = encryption;

  // 30-day lifecycle rule, merged with whatever rules exist.
  let rules: LifecycleRule[] | undefined;
  try {
    rules = (await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket }))).Rules;
  } catch (err) {
    if ((err as { name?: string }).name !== "NoSuchLifecycleConfiguration") throw err;
    rules = [];
  }
  const merged = mergeTtlRule(rules);
  let wrote = false;
  if (merged.added && !checkOnly) {
    await s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: { Rules: merged.rules } }));
    wrote = true;
    rules = merged.rules;
    report.changes.push(`lifecycle rule ${RULE_ID} (${LINK_TTL_DAYS} days)`);
  }
  report.lifecycle = {
    rulePresent: !merged.added || wrote,
    rule: merged.existing ?? (wrote ? RULE_ID : null),
    wrote,
    rules: (rules ?? []).map((r) => ({ id: r.ID, status: r.Status, expirationDays: r.Expiration?.Days ?? null, prefix: r.Prefix ?? r.Filter?.Prefix ?? "" })),
  };
  return report;
}

const isMain = process.argv[1]?.endsWith("setup-s3.ts");
if (isMain) {
  const args = process.argv.slice(2);
  const usage = "usage: npm run setup-s3 [-- --check] [-- --bucket <name>]";
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    process.exit(0);
  }
  // Anything unrecognised stops here, before any AWS call: a typo must never fall through to write mode.
  const unknown = args.filter((a, i) => a !== "--check" && a !== "--bucket" && args[i - 1] !== "--bucket");
  if (unknown.length || (args.includes("--bucket") && !args[args.indexOf("--bucket") + 1])) {
    console.error(`unrecognised arguments: ${unknown.join(" ") || "--bucket needs a name"}\n${usage}`);
    process.exit(2);
  }
  const checkOnly = args.includes("--check");
  const only = args.includes("--bucket") ? args[args.indexOf("--bucket") + 1] : undefined;
  const { env, secrets } = await loadRuntimeEnv();
  const config = loadConfig(env);
  const buckets = only ? [only] : [...new Set([config.PDF_BUCKET, config.AUDIO_BUCKET])];
  const s3 = new S3Client({ region: config.AWS_REGION });
  const reports: BucketReport[] = [];
  for (const b of buckets) {
    try {
      reports.push(await ensureBucket(s3, b, config.AWS_REGION, checkOnly));
    } catch (err) {
      reports.push({ bucket: b, existed: null, created: false, publicAccessBlocked: false, encryption: null, lifecycle: { rulePresent: false, rule: null, wrote: false, rules: [] }, changes: [], error: fail(err) });
    }
  }
  s3.destroy();
  console.log(JSON.stringify({ region: config.AWS_REGION, configSource: secrets.source, checkOnly, ttlDays: LINK_TTL_DAYS, buckets: reports }, null, 2));
  const missing = reports.some((r) => r.error || (r.existed !== true && !r.created) || !r.lifecycle.rulePresent);
  if (missing) process.exit(checkOnly ? 3 : 2);
}
