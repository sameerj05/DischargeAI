import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ObjectStore, StoredObject } from "../objects.js";

export interface S3ObjectOptions {
  bucket: string;
  region: string;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

/**
 * One S3 bucket (`emrpdf-rh` for PDFs, `emraudio-rh` for audio). Every object is written with
 * server-side encryption (SSE-S3, AES256). The bucket's 30-day lifecycle rule (scripts/setup-s3.ts
 * ensures it) deletes objects on day 30. The purge job also deletes the object explicitly when the
 * link expires, so the lifecycle rule is the backstop.
 * IAM: s3:PutObject, s3:GetObject, s3:DeleteObject on the bucket's objects (HeadObject needs s3:GetObject).
 */
export class S3ObjectStore implements ObjectStore {
  readonly name = "s3" as const;
  private readonly s3: S3Client;

  constructor(private readonly opts: S3ObjectOptions) {
    this.s3 = new S3Client({ region: opts.region });
  }

  async put(input: StoredObject): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: input.key, Body: input.body, ContentType: input.contentType, ServerSideEncryption: "AES256" }));
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const r = (await this.s3.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }))) as { Body?: { transformToByteArray(): Promise<Uint8Array> }; ContentType?: string };
      const bytes = await r.Body?.transformToByteArray();
      return bytes ? { key, body: Buffer.from(bytes), contentType: r.ContentType } : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** HeadObject first so the receipt says whether anything was actually there. */
  async delete(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    return true;
  }

  describe(): string {
    return `s3://${this.opts.bucket}`;
  }
}
