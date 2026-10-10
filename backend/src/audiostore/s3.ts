import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import { AUDIO_KEY_PREFIX, audioKeyFor, type AudioObject, type AudioStore } from "./types.js";

/**
 * The lifecycle rule scripts/put-s3-lifecycle.ts installs on AUDIO_BUCKET: every object under
 * audio/ expires 30 days after it was written (S3 evaluates lifecycle rules once a day, so the
 * delete lands within about a day of the boundary; the purge job deletes the object at exactly day 30
 * and the lifecycle is the backstop, like DynamoDB TTL).
 */
export const AUDIO_LIFECYCLE_RULE: LifecycleRule = {
  ID: "dischargeai-audio-expire-30-days",
  Status: "Enabled",
  Filter: { Prefix: AUDIO_KEY_PREFIX },
  Expiration: { Days: 30 },
  AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
};

export interface S3AudioOptions {
  bucket: string;
  region: string;
  client?: S3Client;
}

interface Sendable {
  send(command: unknown): Promise<unknown>;
}

/**
 * S3 audio bucket (the diagram's "stores audio" box). PutObject with server-side encryption
 * (SSE-S3, AES256) on top of the per-link sealing; metadata holds what the local twin keeps in its
 * sidecar file. IAM: s3:PutObject, s3:GetObject, s3:DeleteObject on arn:aws:s3:::AUDIO_BUCKET/audio/*,
 * plus s3:PutLifecycleConfiguration and s3:GetLifecycleConfiguration on the bucket for the script.
 */
export class S3AudioStore implements AudioStore {
  readonly name = "s3" as const;
  readonly location: string;
  private readonly s3: Sendable;

  constructor(private readonly opts: S3AudioOptions) {
    this.location = opts.bucket;
    this.s3 = opts.client ?? new S3Client({ region: opts.region });
  }

  async put(input: { linkIdHash: string; body: Buffer; contentType: string; keyVersion: number; expiresAt: number; createdAt: string }): Promise<AudioObject> {
    const Key = audioKeyFor(input.linkIdHash);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key,
        Body: input.body,
        ContentType: "application/octet-stream",
        ServerSideEncryption: "AES256",
        Metadata: {
          "clip-content-type": input.contentType,
          "key-version": String(input.keyVersion),
          "expires-at": String(input.expiresAt),
          "created-at": input.createdAt,
        },
        Tagging: `expiresAt=${input.expiresAt}`,
      }),
    );
    return { key: Key, bytes: input.body.length, contentType: input.contentType, keyVersion: input.keyVersion, expiresAt: input.expiresAt, createdAt: input.createdAt };
  }

  async head(linkIdHash: string): Promise<AudioObject | null> {
    const Key = audioKeyFor(linkIdHash);
    try {
      const r = (await this.s3.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key }))) as {
        ContentLength?: number;
        Metadata?: Record<string, string>;
        LastModified?: Date;
      };
      const m = r.Metadata ?? {};
      return {
        key: Key,
        bytes: r.ContentLength ?? 0,
        contentType: m["clip-content-type"] ?? "application/octet-stream",
        keyVersion: Number(m["key-version"] ?? 1),
        expiresAt: Number(m["expires-at"] ?? 0),
        createdAt: m["created-at"] ?? r.LastModified?.toISOString() ?? "",
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async get(linkIdHash: string): Promise<{ body: Buffer; meta: AudioObject } | null> {
    const meta = await this.head(linkIdHash);
    if (!meta) return null;
    const r = (await this.s3.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: meta.key }))) as {
      Body?: { transformToByteArray(): Promise<Uint8Array> };
    };
    const bytes = await r.Body?.transformToByteArray();
    if (!bytes) return null;
    return { body: Buffer.from(bytes), meta };
  }

  async delete(linkIdHash: string): Promise<AudioObject | null> {
    const meta = await this.head(linkIdHash);
    if (!meta) return null;
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: meta.key }));
    return meta;
  }

  /** S3 does not list by expiry here; the bucket lifecycle rule is the sweep. */
  async listExpired(): Promise<{ linkIdHash: string; meta: AudioObject }[]> {
    return [];
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}
