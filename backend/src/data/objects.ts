import type { Config } from "../config.js";
import { S3ObjectStore } from "./s3/objects.js";

/**
 * The two team buckets, behind one store shape:
 *   emrpdf-rh    the PDF the provider ingested, key `<sumId>.pdf` (the team contract: "push to s3bucket emrpdf-rh")
 *   emraudio-rh  dictated audio, key `<sumId>.<ext>` ("EMR audio", from the diagram)
 * Both carry a 30-day lifecycle rule (scripts/setup-s3.ts ensures it) and every object is written
 * with server-side encryption.
 */
export interface StoredObject {
  key: string;
  body: Buffer;
  contentType?: string;
}

export interface ObjectStore {
  readonly name: "s3";
  put(input: StoredObject): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  /** Returns false when nothing was there. */
  delete(key: string): Promise<boolean>;
  /** Where the bytes live, for logs and the health endpoint (no PHI). */
  describe(): string;
}

export const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/amr": "amr",
};



export function pdfKeyFor(sumId: string): string {
  return `${sumId}.pdf`;
}

export function audioKeyFor(sumId: string, mimeType: string, fileName?: string): string {
  const byMime = EXT_BY_MIME[mimeType.toLowerCase().split(";")[0]];
  const byName = fileName?.split(".").pop()?.toLowerCase();
  const ext = byMime ?? (byName && /^[a-z0-9]{2,5}$/.test(byName) ? byName : "bin");
  return `${sumId}.${ext}`;
}

/** The two stores the app wires: the PDF bucket (contract) and the audio bucket (diagram). */
export function createObjectStores(config: Config): { pdf: ObjectStore; audio: ObjectStore } {
  return {
    pdf: new S3ObjectStore({ bucket: config.PDF_BUCKET, region: config.AWS_REGION }),
    audio: new S3ObjectStore({ bucket: config.AUDIO_BUCKET, region: config.AWS_REGION }),
  };
}
