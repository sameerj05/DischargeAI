import type { Config } from "../config.js";
import { LocalAudioStore } from "./local.js";
import { S3AudioStore } from "./s3.js";
import type { AudioStore } from "./types.js";

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
export { AUDIO_LIFECYCLE_RULE } from "./s3.js";
