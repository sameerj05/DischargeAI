/** Speech to text: audio in (already stored in the audio bucket), transcript out. */
export interface SpeechToTextInput {
  audio: Buffer;
  mimeType: string;
  fileName?: string;
  /** Key of the same bytes in the audio store; Transcribe Medical reads them from S3 by this key. */
  audioKey?: string;
}

export interface SpeechToTextResult {
  transcript: string;
  provider: string;
  /** Transcribe Medical job name, for traceability. */
  jobName?: string;
  latencyMs?: number;
}

export interface SpeechToText {
  readonly name: string;
  transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult>;
}
