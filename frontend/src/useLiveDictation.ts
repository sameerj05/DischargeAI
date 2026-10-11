import { useCallback, useEffect, useRef, useState } from "react"
import { dictationSocketUrl } from "./api"
import { DictationTranscript } from "./dictationTranscript"

type Status = "idle" | "connecting" | "recording" | "finishing"
type Capture = { stream?: MediaStream; context?: AudioContext; source?: MediaStreamAudioSourceNode; node?: AudioWorkletNode; socket?: WebSocket; timer?: number; flushTimer?: number }

export function useLiveDictation(key: string, onTranscript: (text: string) => void) {
  const [status, setStatus] = useState<Status>("idle")
  const [error, setError] = useState<string>()
  const capture = useRef<Capture>({})
  const generation = useRef(0)
  const callback = useRef(onTranscript)
  callback.current = onTranscript

  const releaseMicrophone = useCallback(() => {
    const current = capture.current
    current.stream?.getTracks().forEach(track => track.stop())
    current.node?.disconnect(); current.source?.disconnect()
    if (current.context && current.context.state !== "closed") void current.context.close().catch(() => {})
    current.stream = undefined; current.context = undefined; current.node = undefined; current.source = undefined
  }, [])
  const dispose = useCallback(() => {
    generation.current++
    window.clearTimeout(capture.current.timer); window.clearTimeout(capture.current.flushTimer)
    releaseMicrophone()
    const socket = capture.current.socket
    if (socket) { socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close() }
    capture.current = {}
  }, [releaseMicrophone])
  const clear = useCallback(() => { dispose(); setStatus("idle"); setError(undefined) }, [dispose])
  const stop = useCallback(() => {
    const current = capture.current
    if (!current.node || current.socket?.readyState !== WebSocket.OPEN) { clear(); return }
    setStatus("finishing")
    // Flush the worklet's final short packet before ending the AWS stream.
    current.node.port.postMessage("stop")
    current.flushTimer = window.setTimeout(() => {
      current.socket?.send(JSON.stringify({ type: "stop" })); releaseMicrophone()
    }, 500)
  }, [clear, releaseMicrophone])
  const start = useCallback(async () => {
    clear(); setStatus("connecting")
    const version = generation.current
    const active = () => generation.current === version
    const fail = (message: string) => { if (active()) { dispose(); setStatus("idle"); setError(message) } }
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") throw new Error("Live dictation requires Edge, Chrome, or another supported browser over HTTPS or localhost.")
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      if (!active()) { stream.getTracks().forEach(track => track.stop()); return }
      capture.current.stream = stream
      const context = new AudioContext({ sampleRate: 16000 })
      capture.current.context = context
      await context.resume()
      await context.audioWorklet.addModule(new URL("dictation-worklet.js", window.location.origin + import.meta.env.BASE_URL).href)
      if (!active()) return
      const node = new AudioWorkletNode(context, "dictation-processor", { channelCount: 1, channelCountMode: "explicit" })
      capture.current.node = node
      const source = context.createMediaStreamSource(stream)
      capture.current.source = source
      const socket = new WebSocket(dictationSocketUrl())
      capture.current.socket = socket
      const transcript = new DictationTranscript()
      let completed = false
      capture.current.timer = window.setTimeout(() => fail("Could not start live dictation. Check the server connection and try again."), 15_000)
      socket.onopen = () => { if (active()) socket.send(JSON.stringify({ type: "start", key, sampleRate: context.sampleRate })) }
      node.port.onmessage = event => {
        if (!active() || socket.readyState !== WebSocket.OPEN) return
        if (event.data instanceof ArrayBuffer) {
          if (socket.bufferedAmount > 256 * 1024) { fail("The transcription connection is too slow. Your text is saved; try again."); return }
          socket.send(event.data)
        } else if (event.data?.type === "flushed") {
          window.clearTimeout(capture.current.flushTimer)
          socket.send(JSON.stringify({ type: "stop" })); releaseMicrophone()
        }
      }
      socket.onmessage = event => {
        if (!active()) return
        try {
          const message = JSON.parse(event.data)
          if (message.type === "ready") {
            window.clearTimeout(capture.current.timer)
            const mute = context.createGain(); mute.gain.value = 0
            source.connect(node); node.connect(mute); mute.connect(context.destination)
            setStatus("recording")
          } else if (message.type === "transcript") {
            callback.current(transcript.update(message.id, message.text, message.partial))
          } else if (message.type === "done") {
            completed = true; dispose(); setStatus("idle")
          } else if (message.type === "error") fail(message.message)
        } catch { fail("The server returned an invalid transcription response. Your text is saved.") }
      }
      socket.onerror = () => fail("Could not connect to live dictation. Check the server connection and try again.")
      socket.onclose = () => { if (active() && !completed) fail("Live dictation disconnected. Your displayed text is saved; start again to continue.") }
      stream.getTracks().forEach(track => { track.onended = () => fail("Microphone access ended. Your displayed text is saved; allow microphone access and try again.") })
    } catch (err) {
      fail(err instanceof DOMException && err.name === "NotAllowedError"
        ? "Microphone access was denied. Allow microphone access in your browser and try again."
        : err instanceof Error ? err.message : "Microphone unavailable.")
    }
  }, [clear, dispose, key, releaseMicrophone])
  useEffect(() => dispose, [dispose])
  return { status, isRecording: status === "recording", isBusy: status !== "idle", error, start, stop, clear }
}
