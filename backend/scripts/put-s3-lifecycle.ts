/**
 * Installs the "expire audio/ objects after 30 days" lifecycle rule on AUDIO_BUCKET (lane 4: S3
 * lifecycle delete at day 30) and prints the bucket's lifecycle configuration afterwards.
 *   AUDIO_BUCKET=my-bucket AWS_REGION=us-west-2 npm run put-s3-lifecycle
 * Credentials come from the standard AWS chain. Idempotent: the rule is replaced by ID; other rules
 * on the bucket are kept. IAM: s3:GetLifecycleConfiguration, s3:PutLifecycleConfiguration.
 */
import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import { AUDIO_LIFECYCLE_RULE } from "../src/audiostore/s3.js";
import { loadConfig } from "../src/config.js";
import { loadDotEnv } from "../src/dotenv.js";

loadDotEnv();
const config = loadConfig();
const Bucket = config.AUDIO_BUCKET;
if (!Bucket) {
  console.error("AUDIO_BUCKET is required");
  process.exit(2);
}
const s3 = new S3Client({ region: config.AWS_REGION });

let existing: LifecycleRule[] = [];
try {
  const r = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket }));
  existing = r.Rules ?? [];
} catch (err) {
  if ((err as { name?: string }).name !== "NoSuchLifecycleConfiguration") throw err;
}
const Rules = [...existing.filter((r) => r.ID !== AUDIO_LIFECYCLE_RULE.ID), AUDIO_LIFECYCLE_RULE];
await s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: { Rules } }));
const after = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket }));
console.log(JSON.stringify({ bucket: Bucket, region: config.AWS_REGION, rules: after.Rules }, null, 2));
