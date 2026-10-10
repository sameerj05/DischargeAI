/**
 * Where dictated audio lives: the S3 audio bucket from the diagram (lifecycle delete at day 30) or
 * a local directory the purge job sweeps. Both store the clip sealed with the link's data key
 * (src/audiostore/secure.ts), so shredding the key makes the object unreadable before the lifecycle
 * or purge removes it. Objects are addressed by the link hash, never the raw link id, and audio
 * bytes are never logged.
 */
export interface AudioObject {
  /** Object key / file name, derived from the link hash: audio/<linkIdHash>. */
  key: string;
  /** Stored (sealed) size in bytes. */
  bytes: number;
  /** MIME type of the original clip, kept as metadata so a resumed job can transcribe it. */
  contentType: string;
  keyVersion: number;
  /** Epoch seconds; mirrors the record's expiresAt. S3 lifecycle and the purge job both honour day 30. */
  expiresAt: number;
  createdAt: string;
}

export interface AudioStore {
  readonly name: "local" | "s3";
  /** Bucket name (s3) or directory (local), for receipts. */
  readonly location: string;
  put(input: { linkIdHash: string; body: Buffer; contentType: string; keyVersion: number; expiresAt: number; createdAt: string }): Promise<AudioObject>;
  get(linkIdHash: string): Promise<{ body: Buffer; meta: AudioObject } | null>;
  head(linkIdHash: string): Promise<AudioObject | null>;
  /** Removes the object; returns what was removed (for the deletion receipt) or null when absent. */
  delete(linkIdHash: string): Promise<AudioObject | null>;
  /** Objects past their expiry, for the purge job's backstop sweep (S3 relies on the lifecycle rule and returns []). */
  listExpired(nowEpochSeconds: number): Promise<{ linkIdHash: string; meta: AudioObject }[]>;
}

export const AUDIO_KEY_PREFIX = "audio/";

export function audioKeyFor(linkIdHash: string): string {
  return `${AUDIO_KEY_PREFIX}${linkIdHash}`;
}

export function linkIdHashFromAudioKey(key: string): string {
  return key.startsWith(AUDIO_KEY_PREFIX) ? key.slice(AUDIO_KEY_PREFIX.length) : key;
}
