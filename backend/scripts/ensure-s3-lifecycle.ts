/**
 * Makes sure AUDIO_BUCKET expires audio/ objects within 30 days (lane 4: S3 lifecycle delete at
 * day 30), idempotently:
 *   - an enabled rule that already expires audio/ (or the whole bucket) within 30 days: nothing to
 *     do, it is reported. The team bucket emraudio-rh carries such a rule (`autodelete`, 30 days).
 *   - otherwise: the rule dischargeai-audio-expire-30-days is added; other rules are kept.
 *   AUDIO_BUCKET=emraudio-rh npm run ensure-s3-lifecycle
 * Credentials come from the standard AWS chain. IAM: s3:GetLifecycleConfiguration and, only when a
 * rule has to be added, s3:PutLifecycleConfiguration.
 */
import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import { AUDIO_LIFECYCLE_RULE, ruleCoversAudio } from "../src/audiostore/s3.js";
import { loadConfig } from "../src/config.js";
import { bootstrapSecrets } from "../src/config/secrets.js";
import { loadDotEnv } from "../src/dotenv.js";
import { createLogger } from "../src/logger.js";

loadDotEnv();
const boot = await bootstrapSecrets(process.env, createLogger(process.env.LOG_LEVEL ?? "warn"));
const config = loadConfig(boot.env);
const Bucket = config.AUDIO_BUCKET;
const s3 = new S3Client({ region: config.AWS_REGION });

let existing: LifecycleRule[] = [];
try {
  const r = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket }));
  existing = r.Rules ?? [];
} catch (err) {
  if ((err as { name?: string }).name !== "NoSuchLifecycleConfiguration") throw err;
}
const summarize = (r: LifecycleRule) => ({ id: r.ID, status: r.Status, prefix: r.Filter?.Prefix ?? r.Prefix ?? "", expirationDays: r.Expiration?.Days, abortMultipartDays: r.AbortIncompleteMultipartUpload?.DaysAfterInitiation, coversAudio: ruleCoversAudio(r) });
const covering = existing.find((r) => ruleCoversAudio(r));
let added = false;
if (!covering) {
  const Rules = [...existing.filter((r) => r.ID !== AUDIO_LIFECYCLE_RULE.ID), AUDIO_LIFECYCLE_RULE];
  await s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: { Rules } }));
  added = true;
}
const after = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket }));
console.log(
  JSON.stringify(
    {
      bucket: Bucket,
      region: config.AWS_REGION,
      configSource: boot.source,
      coveredBy: covering ? summarize(covering) : null,
      added: added ? AUDIO_LIFECYCLE_RULE.ID : null,
      rules: (after.Rules ?? []).map(summarize),
    },
    null,
    2,
  ),
);
