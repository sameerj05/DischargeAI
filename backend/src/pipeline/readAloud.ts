import type { Config } from "../config.js";
export interface ReadAloudProvider { readonly name: string; synthesize(text: string, language: string): Promise<Buffer> }

export class ElevenLabsReadAloud implements ReadAloudProvider {
  readonly name = "elevenlabs";
  constructor(private readonly config: Config, private readonly transport: typeof fetch = fetch) {}
  async synthesize(text: string, language: string): Promise<Buffer> {
    if (!this.config.ELEVENLABS_API_KEY) throw new Error("ElevenLabs is not configured");
    const response = await this.transport(`https://api.elevenlabs.io/v1/text-to-speech/${this.config.ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`, {
      method: "POST", headers: { "xi-api-key": this.config.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: this.config.ELEVENLABS_MODEL_ID, language_code: language }), signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`ElevenLabs returned HTTP ${response.status}`); }
    if (!response.headers.get("content-type")?.startsWith("audio/")) { await response.body?.cancel(); throw new Error("ElevenLabs returned non-audio content"); }
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length || audio.length > 20 * 1024 * 1024) throw new Error("Invalid ElevenLabs audio response");
    return audio;
  }
}
