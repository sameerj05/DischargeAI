import { TranscribeStreamingClient, StartMedicalStreamTranscriptionCommand } from "@aws-sdk/client-transcribe-streaming";

export type DictationResult = { id: string; text: string; partial: boolean };
export interface LiveDictationProvider {
  readonly name: string;
  transcribe(audio: AsyncIterable<Uint8Array>, sampleRate: number, signal: AbortSignal): AsyncIterable<DictationResult>;
}

/** Audio stays in the stream; credentials and AWS signing stay on the server. */
export class MedicalLiveDictation implements LiveDictationProvider {
  readonly name = "transcribe-medical-streaming";
  constructor(private readonly region: string) {}
  async *transcribe(audio: AsyncIterable<Uint8Array>, sampleRate: number, signal: AbortSignal) {
    const client = new TranscribeStreamingClient({ region: this.region, maxAttempts: 1 });
    try {
      const response = await client.send(new StartMedicalStreamTranscriptionCommand({
        LanguageCode: "en-US", Specialty: "PRIMARYCARE", Type: "DICTATION",
        MediaEncoding: "pcm", MediaSampleRateHertz: sampleRate,
        AudioStream: (async function* () {
          for await (const chunk of audio) yield { AudioEvent: { AudioChunk: chunk } };
        })(),
      }), { abortSignal: signal });
      for await (const event of response.TranscriptResultStream ?? []) {
        for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
          const text = result.Alternatives?.[0]?.Transcript;
          if (result.ResultId && text) yield { id: result.ResultId, text, partial: result.IsPartial === true };
        }
      }
    } finally { client.destroy(); }
  }
}

/** Bounded input queue so a slow or disconnected provider cannot retain unlimited audio. */
export class AudioQueue implements AsyncIterable<Uint8Array> {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private ended = false;
  private wake?: () => void;
  push(chunk: Uint8Array) {
    if (this.ended) throw new Error("Dictation has already stopped.");
    if (this.bytes + chunk.length > 256 * 1024) throw new Error("Transcription connection is too slow. Stop and try again.");
    this.chunks.push(chunk); this.bytes += chunk.length; this.wake?.();
  }
  end() { this.ended = true; this.wake?.(); }
  cancel() { this.chunks = []; this.bytes = 0; this.end(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const chunk = this.chunks.shift();
      if (chunk) { this.bytes -= chunk.length; yield chunk; }
      else if (this.ended) return;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}

export function dictationError(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  if (/ExpiredToken|UnrecognizedClient|InvalidSignature/.test(name)) return "AWS speech credentials expired or are invalid. Refresh backend/.env and restart the server.";
  if (/AccessDenied/.test(name)) return "AWS denied live dictation. The server credentials need transcribe:StartMedicalStreamTranscription permission.";
  if (/LimitExceeded|Throttl/.test(name)) return "Live dictation is busy. Please try again shortly.";
  return "Live transcription failed. Your existing text is saved; check the microphone and server connection, then try again.";
}
