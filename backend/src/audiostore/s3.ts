import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import { AUDIO_KEY_PREFIX, audioKeyFor, type AudioObject, type AudioStore } from "./types.js";

/**
 * The lifecycle rule scripts/ensure-s3-lifecycle.ts installs on AUDIO_BUCKET when no existing rule
 * already expires audio/ objects within 30 days: every object under audio/ expires 30 days after it
 * was written. The team bucket emraudio-rh already carries a bucket-wide 30-day rule (`autodelete`),
 * so there the script only verifies. S3 evaluates lifecycle rules once a day, so the delete lands
 * within about a day of the boundary; the purge job deletes the object at exactly day 30 and the
 * lifecycle is the backstop, like DynamoDB TTL.
 */
export const AUDIO_LIFECYCLE_RULE: LifecycleRule = {
  ID: "dischargeai-audio-expire-30-days",
  Status: "Enabled",
  Filter: { Prefix: AUDIO_KEY_PREFIX },
  Expiration: { Days: 30 },
  AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
};

/** True when an existing, enabled rule already expires every object under audio/ within 30 days. */
export function ruleCoversAudio(rule: LifecycleRule, prefix: string = AUDIO_KEY_PREFIX): boolean {
  if (rule.Status !== "Enabled") return false;
  const days = rule.Expiration?.Days;
  if (!days || days > 30) return false;
  const rulePrefix = rule.Filter?.Prefix ?? rule.Prefix ?? rule.Filter?.And?.Prefix ?? "";
  if (rule.Filter?.Tag || rule.Filter?.And?.Tags?.length || rule.Filter?.ObjectSizeGreaterThan || rule.Filter?.ObjectSizeLessThan) return false;
  return prefix.startsWith(rulePrefix);
}

/** HeadBucket with a short timeout: the reachability probe behind AUDIO_STORE=auto. */
export async function probeBucket(bucket: string, region: string, client?: Sendable, timeoutMs = 5000): Promise<void> {
  const s3 = client ?? new S3Client({ region });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HeadBucket ${bucket} timed out after ${timeoutMs} ms`)), timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([s3.send(new HeadBucketCommand({ Bucket: bucket })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!client) (s3 as S3Client).destroy();
  }
}

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
