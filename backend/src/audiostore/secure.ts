import { IV_BYTES, TAG_BYTES, open, seal } from "../crypto/envelope.js";
import type { AudioObject, AudioStore } from "./types.js";

/**
 * Seals the clip with the link's data key before it reaches the audio store and opens it on the way
 * back. Layout: iv (12) | tag (16) | ciphertext. AAD binds the blob to the link hash and key version,
 * so a blob moved to another link cannot be opened. When the purge job destroys the key, the stored
 * blob is unreadable even if the S3 lifecycle has not deleted it yet.
 */
export class SecureAudio {
  constructor(private readonly store: AudioStore) {}

  get name(): AudioStore["name"] {
    return this.store.name;
  }

  get location(): string {
    return this.store.location;
  }

  async put(input: { linkIdHash: string; key: Buffer; keyVersion: number; body: Buffer; contentType: string; expiresAt: number; createdAt: string }): Promise<AudioObject> {
    const sealed = seal(input.key, input.body, aadForAudio(input.linkIdHash, input.keyVersion));
    const blob = Buffer.concat([sealed.iv, sealed.tag, sealed.ciphertext]);
    return this.store.put({ linkIdHash: input.linkIdHash, body: blob, contentType: input.contentType, keyVersion: input.keyVersion, expiresAt: input.expiresAt, createdAt: input.createdAt });
  }

  /** Returns null when absent; throws when the key is wrong or gone. */
  async get(input: { linkIdHash: string; key: Buffer }): Promise<{ body: Buffer; meta: AudioObject } | null> {
    const stored = await this.store.get(input.linkIdHash);
    if (!stored) return null;
    const blob = stored.body;
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
    return { body: open(input.key, { iv, tag, ciphertext }, aadForAudio(input.linkIdHash, stored.meta.keyVersion)), meta: stored.meta };
  }

  head(linkIdHash: string): Promise<AudioObject | null> {
    return this.store.head(linkIdHash);
  }

  delete(linkIdHash: string): Promise<AudioObject | null> {
    return this.store.delete(linkIdHash);
  }

  listExpired(nowEpochSeconds: number) {
    return this.store.listExpired(nowEpochSeconds);
  }
}

export function aadForAudio(linkIdHash: string, keyVersion: number): Buffer {
  return Buffer.from(`audio|${linkIdHash}|${keyVersion}`, "utf8");
}
