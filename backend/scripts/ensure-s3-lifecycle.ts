/**
 * Idempotent check of a bucket's 30-day lifecycle rule. The audio bucket `emraudio-rh` already has
 * the rule `autodelete` (expire after 30 days, abort incomplete multipart uploads after 30 days), so
 * this script normally only reports it; `scripts/setup-s3.ts` uses the same merge for the PDF bucket.
 * When no 30-day expiration rule exists it adds one named `dischargeai-autodelete-30d`, merged with
 * the existing rules (PutBucketLifecycleConfiguration replaces the whole configuration, so the merge matters).
 *   npm run ensure-s3-lifecycle                       the audio bucket: report, add the rule only when missing
 *   npm run ensure-s3-lifecycle -- --bucket emrpdf-rh another bucket
 *   npm run ensure-s3-lifecycle -- --check            report only, never write (exit 3 when missing)
 * IAM: s3:GetLifecycleConfiguration, s3:PutLifecycleConfiguration on the bucket.
 */
import { GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand, S3Client, type LifecycleRule } from "@aws-sdk/client-s3";
import { loadRuntimeEnv } from "../src/bootstrap.js";
import { loadConfig } from "../src/config.js";
import { LINK_TTL_DAYS } from "../src/config.js";

export const RULE_ID = `dischargeai-autodelete-${LINK_TTL_DAYS}d`;

/** A rule counts when it is enabled, expires objects after exactly LINK_TTL_DAYS days, and applies to the whole bucket. */
export function findTtlRule(rules: LifecycleRule[] | undefined): LifecycleRule | undefined {
  return (rules ?? []).find((r) => {
    if (r.Status !== "Enabled") return false;
    if (r.Expiration?.Days !== LINK_TTL_DAYS) return false;
    const prefix = r.Prefix ?? r.Filter?.Prefix ?? "";
    return prefix === "";
  });
}

/** The configuration to write: every existing rule plus ours, when ours is missing. */
export function mergeTtlRule(rules: LifecycleRule[] | undefined): { rules: LifecycleRule[]; added: boolean; existing?: string } {
  const present = findTtlRule(rules);
  if (present) return { rules: rules ?? [], added: false, existing: present.ID };
  const ours: LifecycleRule = {
    ID: RULE_ID,
    Status: "Enabled",
    Filter: { Prefix: "" },
    Expiration: { Days: LINK_TTL_DAYS },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: LINK_TTL_DAYS },
  };
  return { rules: [...(rules ?? []), ours], added: true };
}

const isMain = process.argv[1]?.endsWith("ensure-s3-lifecycle.ts");
if (isMain) {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const { env, secrets } = await loadRuntimeEnv();
  const config = loadConfig(env);
  const Bucket = args.includes("--bucket") ? args[args.indexOf("--bucket") + 1] : config.AUDIO_BUCKET;
  const s3 = new S3Client({ region: config.AWS_REGION });
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
  }
  s3.destroy();
  const summary = (rules ?? []).map((r) => ({ id: r.ID, status: r.Status, expirationDays: r.Expiration?.Days ?? null, abortMultipartDays: r.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? null, prefix: r.Prefix ?? r.Filter?.Prefix ?? "" }));
  console.log(JSON.stringify({ bucket: Bucket, region: config.AWS_REGION, configSource: secrets.source, ttlDays: LINK_TTL_DAYS, rulePresent: !merged.added || wrote, existingRule: merged.existing ?? (wrote ? RULE_ID : null), wrote, checkOnly, rules: summary }, null, 2));
  if (merged.added && checkOnly) process.exit(3);
}
