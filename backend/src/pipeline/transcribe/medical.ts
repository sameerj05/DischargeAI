import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GetMedicalTranscriptionJobCommand,
  StartMedicalTranscriptionJobCommand,
  TranscribeClient,
  type MediaFormat,
} from "@aws-sdk/client-transcribe";
import type { Logger } from "../../logger.js";
import type { SpeechToText, SpeechToTextInput, SpeechToTextResult } from "../types.js";

/**
 * Amazon Transcribe Medical, batch dictation, reading the clip the REST API already stored in the
 * S3 audio bucket ("store audio" -> "audio" -> Speech to text on the diagram).
 * StartMedicalTranscriptionJob (LanguageCode en-US, Specialty PRIMARYCARE, Type DICTATION, Media
 * s3://AUDIO_BUCKET/<audioKey>) -> poll GetMedicalTranscriptionJob -> GetObject the transcript JSON
 * -> results.transcripts[0].transcript. The transcript object lands under transcripts/ in the output
 * bucket (the audio bucket by default), so the 30-day lifecycle rule expires it with the audio.
 * IAM: transcribe:StartMedicalTranscriptionJob, transcribe:GetMedicalTranscriptionJob, s3:GetObject,
 * s3:PutObject on the buckets, and Transcribe needs write access to the output bucket.
 */
export interface TranscribeMedicalOptions {
  region: string;
  audioBucket?: string;
  outputBucket?: string;
  log?: Logger;
  pollIntervalMs?: number;
  timeoutMs?: number;
  s3?: S3Client;
  transcribe?: TranscribeClient;
}

const FORMAT_BY_MIME: Record<string, MediaFormat> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "mp4",
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

export function mediaFormatFor(mimeType: string, fileName?: string): MediaFormat | undefined {
  const byMime = FORMAT_BY_MIME[mimeType.toLowerCase().split(";")[0]];
  if (byMime) return byMime;
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (ext && ["mp3", "mp4", "wav", "flac", "ogg", "amr", "webm", "m4a"].includes(ext)) return ext as MediaFormat;
  return undefined;
}

export class TranscribeMedicalSpeechToText implements SpeechToText {
  readonly name = "transcribe";
  private readonly s3: S3Client;
  private readonly tx: TranscribeClient;

  constructor(private readonly opts: TranscribeMedicalOptions) {
    this.s3 = opts.s3 ?? new S3Client({ region: opts.region });
    this.tx = opts.transcribe ?? new TranscribeClient({ region: opts.region });
  }

  async transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult> {
    const bucket = this.opts.audioBucket;
    const outputBucket = this.opts.outputBucket ?? bucket;
    if (!bucket || !outputBucket) throw new Error("Transcribe Medical needs AUDIO_BUCKET (and optionally TRANSCRIBE_OUTPUT_BUCKET)");
    const t0 = Date.now();
    const jobName = `dischargeai-${randomUUID()}`;
    const format = mediaFormatFor(input.mimeType, input.fileName);

    // The audio store already holds the clip under audioKey; a caller without one gets a scratch upload.
    let key = input.audioKey;
    if (!key) {
      key = `scratch/${jobName}.${format ?? "bin"}`;
      await this.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: input.audio, ContentType: input.mimeType, ServerSideEncryption: "AES256" }));
    }

    await this.tx.send(
      new StartMedicalTranscriptionJobCommand({
        MedicalTranscriptionJobName: jobName,
        LanguageCode: "en-US",
        Specialty: "PRIMARYCARE",
        Type: "DICTATION",
        Media: { MediaFileUri: `s3://${bucket}/${key}` },
        ...(format ? { MediaFormat: format } : {}),
        OutputBucketName: outputBucket,
        OutputKey: `transcripts/${jobName}.json`,
      }),
    );

    const deadline = Date.now() + (this.opts.timeoutMs ?? 10 * 60 * 1000);
    const interval = this.opts.pollIntervalMs ?? 5000;
    for (;;) {
      const { MedicalTranscriptionJob: job } = await this.tx.send(new GetMedicalTranscriptionJobCommand({ MedicalTranscriptionJobName: jobName }));
      const status = job?.TranscriptionJobStatus;
      if (status === "COMPLETED") break;
      if (status === "FAILED") throw new Error(`Transcribe Medical job failed: ${job?.FailureReason ?? "unknown"}`);
      if (Date.now() > deadline) throw new Error("Transcribe Medical job timed out");
      await new Promise((r) => setTimeout(r, interval));
    }

    const obj = await this.s3.send(new GetObjectCommand({ Bucket: outputBucket, Key: `transcripts/${jobName}.json` }));
    const body = await obj.Body?.transformToString("utf8");
    if (!body) throw new Error("Transcribe Medical produced an empty transcript object");
    const parsed = JSON.parse(body) as { results?: { transcripts?: { transcript?: string }[] } };
    const transcript = parsed.results?.transcripts?.[0]?.transcript?.trim() ?? "";
    if (!transcript) throw new Error("Transcribe Medical transcript was empty");
    this.opts.log?.info({ jobName, ms: Date.now() - t0 }, "transcribe medical job completed");
    return { transcript, provider: this.name, jobName, latencyMs: Date.now() - t0 };
  }
}
