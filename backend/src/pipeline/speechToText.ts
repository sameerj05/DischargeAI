import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { SpeechToText } from "./types.js";

export type { SpeechToText, SpeechToTextInput, SpeechToTextResult } from "./types.js";

/** Amazon Transcribe Medical over the S3 audio bucket. */
export async function createSpeechToText(config: Config, log: Logger): Promise<SpeechToText> {
  const { TranscribeMedicalSpeechToText } = await import("./transcribe/medical.js");
  return new TranscribeMedicalSpeechToText({
    region: config.AWS_REGION,
    audioBucket: config.AUDIO_BUCKET,
    outputBucket: config.TRANSCRIBE_OUTPUT_BUCKET ?? config.AUDIO_BUCKET,
    log,
  });
}
