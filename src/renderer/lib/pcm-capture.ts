import { StreamingLinearResampler } from './audio-utils'

const SAMPLE_RATE = 16_000
// 250ms keeps live text and end-of-speech feedback responsive without flooding
// the offline model with the ~3ms blocks produced by AudioWorklet.
const CHUNK_SAMPLES = SAMPLE_RATE / 4

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

// One capture context per renderer. Recreating and asynchronously closing an
// AudioContext for every utterance makes Chromium's shared audio service retain
// teardown work across rapid starts and renderer reloads. Reusing the context
// also means the worklet module is compiled only once instead of on every ⌥⇧K.
let captureAudioCtx: AudioContext | null = null
let captureWorkletReady: Promise<void> | null = null

function getCaptureAudioContext(): AudioContext {
  if (!captureAudioCtx || captureAudioCtx.state === 'closed') {
    captureAudioCtx = new AudioContext()
    captureWorkletReady = null
  }
  return captureAudioCtx
}

async function prepareCaptureContext(): Promise<AudioContext> {
  const audioCtx = getCaptureAudioContext()
  if (!captureWorkletReady) {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
    captureWorkletReady = audioCtx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
  }
  try {
    await captureWorkletReady
  } catch (error) {
    // A transient module-load failure must not poison every later recording.
    captureWorkletReady = null
    throw error
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume()
  return audioCtx
}

/** Close renderer-lifetime audio resources before a reload or window close. */
export async function disposePcmCaptureResources(): Promise<void> {
  const audioCtx = captureAudioCtx
  captureAudioCtx = null
  captureWorkletReady = null
  if (audioCtx && audioCtx.state !== 'closed') await audioCtx.close()
}

export class PcmCapture {
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private gain: GainNode | null = null
  private pending = new Float32Array(CHUNK_SAMPLES)
  private pendingLength = 0
  private resampler: StreamingLinearResampler | null = null

  constructor(private stream: MediaStream, private onChunk: (chunk: PcmChunk) => void) {}

  async start(): Promise<void> {
    const audioCtx = await prepareCaptureContext()
    this.resampler = new StreamingLinearResampler(audioCtx.sampleRate, SAMPLE_RATE)
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
    const tail = this.resampler?.flush()
    if (tail?.length) this.acceptResampled(tail)
    if (this.pendingLength === 0) return
    this.emit(this.pending.slice(0, this.pendingLength))
    this.pendingLength = 0
  }

  stop(): void {
    this.flush()
    this.node?.disconnect()
    if (this.node) this.node.port.onmessage = null
    this.gain?.disconnect()
    this.source?.disconnect()
    this.node = null
    this.gain = null
    this.source = null
    this.stream.getTracks().forEach((track) => track.stop())
    this.resampler = null
  }

  private accept(input: Float32Array): void {
    const resampled = this.resampler?.push(input) ?? input
    this.acceptResampled(resampled)
  }

  private acceptResampled(samples: Float32Array): void {
    let offset = 0
    while (offset < samples.length) {
      const copyLength = Math.min(CHUNK_SAMPLES - this.pendingLength, samples.length - offset)
      this.pending.set(samples.subarray(offset, offset + copyLength), this.pendingLength)
      this.pendingLength += copyLength
      offset += copyLength
      if (this.pendingLength === CHUNK_SAMPLES) {
        this.emit(this.pending)
        this.pending = new Float32Array(CHUNK_SAMPLES)
        this.pendingLength = 0
      }
    }
  }

  private emit(samples: Float32Array): void {
    this.onChunk({ samples, rms: rmsLevel(samples) })
  }
}

function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i]
  return Math.sqrt(sumSq / samples.length)
}
