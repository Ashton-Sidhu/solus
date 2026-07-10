import { resampleLinear } from './audio-utils'

const SAMPLE_RATE = 16_000
const CHUNK_SAMPLES = SAMPLE_RATE / 2

export type PcmChunk = {
  samples: Float32Array
  rms: number
}

const WORKLET_SOURCE = `
class SolusPcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    const channel = input && input[0]
    if (channel && channel.length) {
      const copy = new Float32Array(channel.length)
      copy.set(channel)
      this.port.postMessage(copy, [copy.buffer])
    }
    return true
  }
}
registerProcessor('solus-pcm-capture', SolusPcmCaptureProcessor)
`

export class PcmCapture {
  private audioCtx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private gain: GainNode | null = null
  private pending = new Float32Array()
  private lastInputRate = SAMPLE_RATE

  constructor(private stream: MediaStream, private onChunk: (chunk: PcmChunk) => void) {}

  async start(): Promise<void> {
    const audioCtx = new AudioContext()
    this.audioCtx = audioCtx
    this.lastInputRate = audioCtx.sampleRate
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
    try {
      await audioCtx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = audioCtx.createMediaStreamSource(this.stream)
    const node = new AudioWorkletNode(audioCtx, 'solus-pcm-capture')
    const gain = audioCtx.createGain()
    gain.gain.value = 0
    node.port.onmessage = (event: MessageEvent<Float32Array>) => this.accept(event.data)
    source.connect(node)
    node.connect(gain)
    gain.connect(audioCtx.destination)
    this.source = source
    this.node = node
    this.gain = gain
  }

  flush(): void {
    if (this.pending.length === 0) return
    this.emit(this.pending)
    this.pending = new Float32Array()
  }

  stop(): void {
    this.flush()
    this.node?.disconnect()
    this.gain?.disconnect()
    this.source?.disconnect()
    this.node = null
    this.gain = null
    this.source = null
    this.stream.getTracks().forEach((track) => track.stop())
    if (this.audioCtx) void this.audioCtx.close()
    this.audioCtx = null
  }

  private accept(input: Float32Array): void {
    const resampled = resampleLinear(input, this.lastInputRate, SAMPLE_RATE)
    this.pending = appendSamples(this.pending, resampled)
    while (this.pending.length >= CHUNK_SAMPLES) {
      const chunk = this.pending.slice(0, CHUNK_SAMPLES)
      this.emit(chunk)
      this.pending = this.pending.slice(CHUNK_SAMPLES)
    }
  }

  private emit(samples: Float32Array): void {
    this.onChunk({ samples, rms: rmsLevel(samples) })
  }
}

function appendSamples(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b
  const out = new Float32Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i]
  return Math.sqrt(sumSq / samples.length)
}
