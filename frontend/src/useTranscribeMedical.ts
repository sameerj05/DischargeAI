import { useRef, useState, useCallback } from "react"
import {
  TranscribeStreamingClient,
  StartMedicalStreamTranscriptionCommand,
  type AudioStream,
  LanguageCode,
  MedicalContentIdentificationType,
} from "@aws-sdk/client-transcribe-streaming"

const OUTPUT_SAMPLE_RATE = 16000
const CHUNK_SIZE = 8192 // bytes — minimum size Transcribe needs per audio event

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
      // 1. Get mic
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = mediaStream

      // 2. AudioContext at native rate — let the worklet downsample
      const audioContext = new AudioContext()
      audioContextRef.current = audioContext

      // 3. Load worklet processor
      await audioContext.audioWorklet.addModule("/pcm-processor.js")

      const source = audioContext.createMediaStreamSource(mediaStream)
      const workletNode = new AudioWorkletNode(audioContext, "pcm-processor")
      workletNodeRef.current = workletNode

      // 4. Collect PCM chunks from worklet
      let chunkCount = 0
      let maxAmplitude = 0
      workletNode.port.onmessage = (e: MessageEvent<{ type: string; buffer?: ArrayBuffer; frameCount?: number; inputChannels?: number; samplesPerFrame?: number; maxAmplitude?: number }>) => {
        if (e.data.type === "debug") {
          console.log("[Worklet] frames:", e.data.frameCount, "| channels:", e.data.inputChannels, "| samples/frame:", e.data.samplesPerFrame, "| max amplitude:", e.data.maxAmplitude?.toFixed(4))
          return
        }
        if (e.data.type === "pcm" && e.data.buffer) {
          const int16 = new Int16Array(e.data.buffer)
          for (let i = 0; i < int16.length; i++) {
            const abs = Math.abs(int16[i])
            if (abs > maxAmplitude) maxAmplitude = abs
          }
          chunksRef.current.push(new Uint8Array(e.data.buffer))
          chunkCount++
          if (chunkCount % 50 === 0) {
            console.log("[Transcribe] Audio chunks buffered:", chunkCount, "| max amplitude:", maxAmplitude, "/ 32767")
            maxAmplitude = 0
          }
        }
      }

      source.connect(workletNode)
      // Don't connect workletNode to destination — we don't want mic playback

      setIsRecording(true)
      console.log("[Transcribe] Recording started, native sample rate:", audioContext.sampleRate)

      // 5. Async generator that feeds batched chunks to Transcribe
      let sentCount = 0
      async function* audioGenerator(): AsyncGenerator<AudioStream> {
        let buffer = new Uint8Array(0)

        while (!stoppedRef.current || chunksRef.current.length > 0) {
          const chunk = chunksRef.current.shift()
          if (chunk) {
            // Concatenate into buffer
            const merged = new Uint8Array(buffer.length + chunk.length)
            merged.set(buffer)
            merged.set(chunk, buffer.length)
            buffer = merged

            // Only yield once we have a full-sized chunk
            if (buffer.length >= CHUNK_SIZE) {
              sentCount++
              if (sentCount % 10 === 0) console.log("[Transcribe] Batches sent to AWS:", sentCount, "buffer bytes:", buffer.length)
              yield { AudioEvent: { AudioChunk: buffer } }
              buffer = new Uint8Array(0)
            }
          } else {
            // Flush remaining buffer on stop
            if (stoppedRef.current && buffer.length > 0) {
              console.log("[Transcribe] Flushing final buffer, bytes:", buffer.length)
              yield { AudioEvent: { AudioChunk: buffer } }
              buffer = new Uint8Array(0)
            }
            await new Promise<void>((r) => setTimeout(r, 20))
          }
        }
        console.log("[Transcribe] Audio generator finished, total batches sent:", sentCount)
      }

      // 6. Start Transcribe Medical stream
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
      console.log("[Transcribe] Stream started")

      // 7. Consume transcript events
      if (response.TranscriptResultStream) {
        for await (const event of response.TranscriptResultStream) {
          const results = event.TranscriptEvent?.Transcript?.Results
          if (results) {
            for (const result of results) {
              const text = result.Alternatives?.[0]?.Transcript
              if (text) {
                console.log("[Transcribe]", result.IsPartial ? "(partial)" : "(final)", text)
                if (result.IsPartial) {
                  // Show partials live as a preview
                  setTranscript((prev) => {
                    const base = prev.replace(/\s*\[.*\]$/, "") // strip previous partial
                    return base ? base + " [" + text + "]" : "[" + text + "]"
                  })
                } else {
                  // Replace partial with confirmed final
                  setTranscript((prev) => {
                    const base = prev.replace(/\s*\[.*\]$/, "")
                    return base ? base + " " + text : text
                  })
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("[Transcribe] Error:", err)
      setError(err instanceof Error ? err.message : "Transcription failed")
      setIsRecording(false)
    }
  }, [])

  const stop = useCallback(() => {
    stoppedRef.current = true
    workletNodeRef.current?.disconnect()
    workletNodeRef.current = null
    // Delay closing audio context to allow remaining chunks to flush
    setTimeout(() => {
      audioContextRef.current?.close()
      audioContextRef.current = null
    }, 500)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setIsRecording(false)
    console.log("[Transcribe] Recording stopped")
  }, [])

  return { transcript, isRecording, error, start, stop }
}
