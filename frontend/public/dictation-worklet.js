// Capture mono signed 16-bit little-endian PCM in 100 ms packets.
class DictationProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = new Float32Array(Math.round(sampleRate / 10))
    this.offset = 0
    this.stopped = false
    this.port.onmessage = () => {
      this.flush()
      this.stopped = true
      this.port.postMessage({ type: "flushed" })
    }
  }
  flush() {
    if (!this.offset) return
    const pcm = new ArrayBuffer(this.offset * 2)
    const view = new DataView(pcm)
    for (let i = 0; i < this.offset; i++) {
      const value = Math.max(-1, Math.min(1, this.samples[i]))
      view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
    }
    this.port.postMessage(pcm, [pcm])
    this.offset = 0
  }
  process(inputs) {
    if (this.stopped) return false
    const channel = inputs[0]?.[0]
    if (channel) for (const value of channel) {
      this.samples[this.offset++] = value
      if (this.offset === this.samples.length) this.flush()
    }
    return true
  }
}
registerProcessor("dictation-processor", DictationProcessor)
