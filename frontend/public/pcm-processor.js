class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._inputRate = sampleRate
    this._ratio = sampleRate / 16000
    this._frameCount = 0
    this._maxSeen = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true

    const float32 = input[0]
    this._frameCount++

    // Track max amplitude inside the worklet
    for (let i = 0; i < float32.length; i++) {
      const abs = Math.abs(float32[i])
      if (abs > this._maxSeen) this._maxSeen = abs
    }

    // Report every 200 frames
    if (this._frameCount % 200 === 0) {
      this.port.postMessage({
        type: "debug",
        frameCount: this._frameCount,
        inputChannels: input.length,
        samplesPerFrame: float32.length,
        maxAmplitude: this._maxSeen
      })
      this._maxSeen = 0
    }

    // Downsample and send PCM
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
