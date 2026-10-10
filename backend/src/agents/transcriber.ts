import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

export interface TranscribeInput {
  audio: Buffer;
  mimeType: string;
  fileName?: string;
}

export interface TranscribeResult {
  text: string;
  provider: string;
  /** Transcribe Medical job name, for traceability. */
  jobName?: string;
  latencyMs?: number;
}

/** Audio dictation in, clinician text out. */
export interface TranscriberAgent {
  readonly name: string;
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}

export async function createTranscriber(config: Config, log: Logger): Promise<TranscriberAgent> {
  if (config.TRANSCRIBE_PROVIDER === "aws") {
    const { AwsMedicalTranscriber } = await import("./aws/transcriber.js");
    return new AwsMedicalTranscriber({
      region: config.AWS_REGION,
      inputBucket: config.TRANSCRIBE_BUCKET ?? config.AUDIO_BUCKET,
      outputBucket: config.TRANSCRIBE_OUTPUT_BUCKET ?? config.TRANSCRIBE_BUCKET ?? config.AUDIO_BUCKET,
      log,
    });
  }
  const { OfflineTranscriber } = await import("./offline/transcriber.js");
  return new OfflineTranscriber();
}
