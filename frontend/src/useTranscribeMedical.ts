import { useRef, useState, useCallback } from "react"
import {
  TranscribeStreamingClient,
  StartMedicalStreamTranscriptionCommand,
  type AudioStream,
  LanguageCode,
  MedicalContentIdentificationType,
} from "@aws-sdk/client-transcribe-streaming"

const OUTPUT_SAMPLE_RATE = 16000
const CHUNK_SIZE = 8192

// Inline the worklet as a Blob URL to avoid MIME type issues with /public
const WORKLET_CODE = `
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._ratio = sampleRate / 16000
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0] || input[0].length === 0) return true
    const float32 = input[0]
    const outLength = Math.floor(float32.length / this._ratio)
    if (outLength === 0) return true
    const int16 = new Int16Array(outLength)
    for (let i = 0; i < outLength; i++) {
      const srcIndex = Math.min(Math.floor(i * this._ratio), float32.length - 1)
      const clamped = Math.max(-1, Math.min(1, float32[srcIndex]))
      int16[i] = clamped * 32767
    }
    this.port.postMessage({ type: "pcm", buffer: int16.buffer.slice(0) })
    return true
  }
}
registerProcessor("pcm-processor", PcmProcessor)
`

function getWorkletUrl(): string {
  const blob = new Blob([WORKLET_CODE], { type: "application/javascript" })
  return URL.createObjectURL(blob)
}

function createClient() {
  return new TranscribeStreamingClient({
    region: import.meta.env.VITE_AWS_REGION ?? "us-west-2",
    credentials: {
      accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID,
      secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
      sessionToken: import.meta.env.VITE_AWS_SESSION_TOKEN,
    },
  })
}

export function useTranscribeMedical() {
  const [transcript, setTranscript] = useState("")
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const chunksRef = useRef<Uint8Array[]>([])
  const stoppedRef = useRef(false)

  const start = useCallback(async () => {
    setError(null)
    setTranscript("")
    chunksRef.current = []
    stoppedRef.current = false

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = mediaStream

      const audioContext = new AudioContext()
      audioContextRef.current = audioContext

      // Use Blob URL instead of /public path to avoid MIME type issues
      const workletUrl = getWorkletUrl()
      await audioContext.audioWorklet.addModule(workletUrl)
      URL.revokeObjectURL(workletUrl)

      const source = audioContext.createMediaStreamSource(mediaStream)
      const workletNode = new AudioWorkletNode(audioContext, "pcm-processor")
      workletNodeRef.current = workletNode

      workletNode.port.onmessage = (e: MessageEvent<{ type: string; buffer?: ArrayBuffer }>) => {
        if (e.data.type === "pcm" && e.data.buffer) {
          chunksRef.current.push(new Uint8Array(e.data.buffer))
        }
      }

      source.connect(workletNode)
      setIsRecording(true)

      async function* audioGenerator(): AsyncGenerator<AudioStream> {
        let buffer = new Uint8Array(0)
        while (!stoppedRef.current || chunksRef.current.length > 0) {
          const chunk = chunksRef.current.shift()
          if (chunk) {
            const merged = new Uint8Array(buffer.length + chunk.length)
            merged.set(buffer)
            merged.set(chunk, buffer.length)
            buffer = merged
            if (buffer.length >= CHUNK_SIZE) {
              yield { AudioEvent: { AudioChunk: buffer } }
              buffer = new Uint8Array(0)
            }
          } else {
            if (stoppedRef.current && buffer.length > 0) {
              yield { AudioEvent: { AudioChunk: buffer } }
              buffer = new Uint8Array(0)
            }
            await new Promise<void>((r) => setTimeout(r, 20))
          }
        }
      }

      const client = createClient()
      const command = new StartMedicalStreamTranscriptionCommand({
        LanguageCode: LanguageCode.EN_US,
        MediaEncoding: "pcm",
        MediaSampleRateHertz: OUTPUT_SAMPLE_RATE,
        Specialty: "PRIMARYCARE",
        Type: "CONVERSATION",
        ContentIdentificationType: MedicalContentIdentificationType.PHI,
        AudioStream: audioGenerator(),
      })

      const response = await client.send(command)

      if (response.TranscriptResultStream) {
        for await (const event of response.TranscriptResultStream) {
          const results = event.TranscriptEvent?.Transcript?.Results
          if (results) {
            for (const result of results) {
              const text = result.Alternatives?.[0]?.Transcript
              if (text) {
              const text = result.Alternatives?.[0]?.Transcript
              if (text) {
                if (result.IsPartial) {
                  // Replace the last partial with the updated one
                  setTranscript((prev) => prev.replace(/\u00b6.*$/, "") + "\u00b6" + text)
                } else {
                  // Final: strip the partial marker and append confirmed text
                  setTranscript((prev) => {
                    const base = prev.replace(/\u00b6.*$/, "").trimEnd()
                    return base ? base + " " + text : text
                  })
                }
              }
              }
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed")
      setIsRecording(false)
    }
  }, [])

  const stop = useCallback(() => {
    stoppedRef.current = true
    workletNodeRef.current?.disconnect()
    workletNodeRef.current = null
    setTimeout(() => {
      audioContextRef.current?.close()
      audioContextRef.current = null
    }, 500)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setIsRecording(false)
  }, [])

  // Strip internal partial marker before exposing transcript
  const cleanTranscript = transcript.replace(/\u00b6/g, " ").replace(/\s+/g, " ").trim()

  return { transcript: cleanTranscript, isRecording, error, start, stop }
}
