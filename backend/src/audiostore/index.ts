import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { LocalAudioStore } from "./local.js";
import { S3AudioStore, probeBucket } from "./s3.js";
import type { AudioStore } from "./types.js";

export interface AudioStoreSelection {
  store: AudioStore;
  /** What AUDIO_STORE resolved to before any fallback. */
  requested: "local" | "s3";
  /** Set when the S3 bucket was wanted (AUDIO_STORE=auto) but unreachable and the local directory took over. */
  fallback?: { from: "s3"; bucket: string; reason: string };
}

/**
 * AUDIO_STORE: `s3` = the team bucket (AUDIO_BUCKET, default emraudio-rh), `local` = AUDIO_DIR,
 * `auto` = the bucket when the team secret loaded (credentials present) and HeadBucket succeeds,
 * else the local directory, reported in GET /health. `s3` fails hard when the bucket is unreachable.
 */
export async function selectAudioStore(config: Config, opts: { secretLoaded: boolean; log?: Logger; probe?: (bucket: string, region: string) => Promise<void> } = { secretLoaded: false }): Promise<AudioStoreSelection> {
  const bucket = config.AUDIO_BUCKET;
  const probe = opts.probe ?? probeBucket;
  const wantS3 = config.AUDIO_STORE === "s3" || (config.AUDIO_STORE === "auto" && opts.secretLoaded);
  if (!wantS3) return { store: new LocalAudioStore(config.AUDIO_DIR), requested: "local" };
  if (!bucket) throw new Error("AUDIO_STORE=s3 needs AUDIO_BUCKET");
  try {
    await probe(bucket, config.AWS_REGION);
    opts.log?.info({ audio: "s3", bucket }, "audio store: S3 bucket reachable");
    return { store: new S3AudioStore({ bucket, region: config.AWS_REGION }), requested: "s3" };
  } catch (err) {
    const reason = String((err as Error)?.message ?? err).slice(0, 200);
    if (config.AUDIO_STORE === "s3") throw new Error(`AUDIO_STORE=s3 but bucket ${bucket} is unreachable: ${reason}`);
    opts.log?.warn({ audio: "local", wanted: "s3", bucket, reason }, "audio store: S3 bucket unreachable; using the local directory (AUDIO_STORE=auto)");
    return { store: new LocalAudioStore(config.AUDIO_DIR), requested: "s3", fallback: { from: "s3", bucket, reason } };
  }
}

/** Synchronous, no probe: explicit s3 or local. Scripts and tests that never want the auto path. */
export function createAudioStore(config: Config): AudioStore {
  if (config.AUDIO_STORE === "s3") {
    if (!config.AUDIO_BUCKET) throw new Error("AUDIO_STORE=s3 needs AUDIO_BUCKET");
    return new S3AudioStore({ bucket: config.AUDIO_BUCKET, region: config.AWS_REGION });
  }
  return new LocalAudioStore(config.AUDIO_DIR);
}

export type { AudioObject, AudioStore } from "./types.js";
export { audioKeyFor, AUDIO_KEY_PREFIX } from "./types.js";
export { SecureAudio } from "./secure.js";
export { AUDIO_LIFECYCLE_RULE, ruleCoversAudio } from "./s3.js";
