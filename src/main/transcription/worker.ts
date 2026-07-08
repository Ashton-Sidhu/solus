import { existsSync, readFileSync } from 'fs'
import { homedir, cpus } from 'os'
import { join } from 'path'
import * as ort from 'onnxruntime-node'

const MODEL_NAME = 'parakeet-tdt-0.6b-v3-int8'
const PARAKEET_MODEL_DIR = join(homedir(), '.solus', 'models', MODEL_NAME)
const MAX_TOKENS_PER_STEP = 10
const ORT_THREADS = Math.min(4, Math.max(1, cpus().length - 2))
const SESSION_OPTIONS: ort.InferenceSession.SessionOptions = {
  executionMode: 'parallel',
  graphOptimizationLevel: 'all',
  intraOpNumThreads: ORT_THREADS,
  interOpNumThreads: 1,
}

type PhaseMetrics = Record<string, number>

type ParakeetModel = {
  preprocessor: ort.InferenceSession
  encoder: ort.InferenceSession
  decoder: ort.InferenceSession
  vocab: string[]
  blankIndex: number
}

type WorkerRequest =
  | { id: number; type: 'transcribe'; samples: Float32Array }
  | { type: 'warmup' }
  | { type: 'stream-start'; streamId: string }
  | { type: 'stream-audio'; streamId: string; samples: Float32Array }
  | { type: 'stream-end'; streamId: string }
  | { type: 'stream-cancel'; streamId: string }

type WorkerResponse =
  | { id: number; type: 'result'; transcript: string; phaseMs: PhaseMetrics }
  | { id: number; type: 'error'; message: string; phaseMs: PhaseMetrics }
  | { type: 'warmup-done'; ms: number }
  | { type: 'warmup-error'; message: string }
  | { type: 'stream-partial'; streamId: string; textDelta: string; fullText: string }
  | { type: 'stream-final'; streamId: string; transcript: string; phaseMs: PhaseMetrics }
  | { type: 'stream-error'; streamId: string; message: string; phaseMs?: PhaseMetrics }

let modelPromise: Promise<ParakeetModel> | null = null
const streams = new Map<string, StreamingStream>()

function post(message: WorkerResponse): void {
  const parentPort = (process as any).parentPort
  parentPort?.postMessage(message)
}

function findModel(int8Name: string, fp32Name: string): string {
  const int8Path = join(PARAKEET_MODEL_DIR, int8Name)
  if (existsSync(int8Path)) return int8Path
  const fp32Path = join(PARAKEET_MODEL_DIR, fp32Name)
  if (existsSync(fp32Path)) return fp32Path
  throw new Error(`Missing ${int8Name} or ${fp32Name} in ${PARAKEET_MODEL_DIR}`)
}

function loadVocab(): { vocab: string[]; blankIndex: number } {
  const vocab: string[] = []
  for (const line of readFileSync(join(PARAKEET_MODEL_DIR, 'vocab.txt'), 'utf8').trim().split('\n')) {
    const separator = line.lastIndexOf(' ')
    vocab[Number(line.slice(separator + 1))] = line.slice(0, separator).replaceAll('\u2581', ' ')
  }
  const blankIndex = vocab.indexOf('<blk>')
  if (blankIndex < 0) throw new Error('vocab.txt is missing the <blk> token')
  return { vocab, blankIndex }
}

async function loadModel(): Promise<ParakeetModel> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const { vocab, blankIndex } = loadVocab()
      const [preprocessor, encoder, decoder] = await Promise.all([
        ort.InferenceSession.create(join(PARAKEET_MODEL_DIR, 'nemo128.onnx'), SESSION_OPTIONS),
        ort.InferenceSession.create(findModel('encoder-model.int8.onnx', 'encoder-model.onnx'), SESSION_OPTIONS),
        ort.InferenceSession.create(findModel('decoder_joint-model.int8.onnx', 'decoder_joint-model.onnx'), SESSION_OPTIONS),
      ])
      return { preprocessor, encoder, decoder, vocab, blankIndex }
    })().catch((err) => {
      modelPromise = null
      throw err
    })
  }
  return modelPromise
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10
}

function disposeTensors(...tensors: Array<ort.Tensor | undefined>): void {
  const seen: ort.Tensor[] = []
  for (const tensor of tensors) {
    if (!tensor || seen.includes(tensor)) continue
    seen.push(tensor)
    tensor.dispose()
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

// Mirrors the renderer's speech gate (voice-recorder.svelte.ts): audio below
// this rms is treated as silence for both the tail short-circuit and segment
// boundaries.
const SPEECH_RMS_THRESHOLD = 0.003
// Trailing silence that closes the active segment. Long enough to sit inside a
// natural pause without splitting mid-phrase.
const SEGMENT_SILENCE_MS = 700
// Pre-roll carried into the next segment so a word onset straddling the
// boundary isn't clipped. 0.25s @ 16kHz — mirrors the renderer's PRE_ROLL_SAMPLES.
const PRE_ROLL_SAMPLES = 4_000

// Streaming here means "re-decode the growing utterance from scratch on every
// pass", not frame-synchronous streaming. The Parakeet ONNX exports are offline
// (the encoder has no cache in/out), so carrying decoder state across
// independently re-encoded windows produces invalid output — it collapses to a
// single leading word.
//
// To keep re-decode cost bounded we split the utterance at silences. A single
// growing buffer would be O(n^2) work (every pass re-encodes everything) and
// makes stop latency proportional to the whole utterance. Instead we run the
// proven batch `transcribe()` over just the *active* segment; when trailing
// silence closes a segment its text is frozen and the active buffer resets to a
// short pre-roll. Total work becomes O(n · segment) and stop latency is
// proportional to the last phrase only. Segmentation is safe with the offline
// export precisely because each segment is an independent batch decode — no
// cross-window decoder state is carried, which is the failure mode above. Only
// one decode runs at a time; audio that arrives mid-decode is folded into the
// next pass, so this self-throttles to the model's speed rather than a timer.
// The full transcript is the frozen segment texts plus the active text joined
// by spaces.
class StreamingStream {
  private frozenTexts: string[] = []
  private audio: Float32Array = new Float32Array()
  private phaseMs: PhaseMetrics = {}
  private cancelled = false
  private lastText = ''
  private lastFullText = ''
  private lastDecodedLength = -1
  private trailingSilenceMs = 0
  private errorMessage: string | null = null
  private decodeLoopPromise: Promise<void> | null = null

  constructor(readonly streamId: string) {}

  addAudio(samples: Float32Array): void {
    if (this.cancelled || samples.length === 0) return
    if (rmsLevel(samples) < SPEECH_RMS_THRESHOLD) this.trailingSilenceMs += samples.length / 16
    else this.trailingSilenceMs = 0
    this.audio = appendSamples(this.audio, samples)
    this.startDecodeLoop()
  }

  async end(): Promise<void> {
    try {
      await this.decodeLoopPromise
      if (this.errorMessage) {
        post({ type: 'stream-error', streamId: this.streamId, message: this.errorMessage, phaseMs: this.phaseMs })
        return
      }
      // The last partial usually already covers the active segment; only re-decode
      // if audio landed after it (e.g. the capture's flushed tail chunk). On an
      // auto-VAD stop that tail is silence, so skip the decode when the
      // not-yet-decoded suffix is below the speech gate.
      let activeText = this.lastText
      if (!this.cancelled && this.audio.length !== this.lastDecodedLength && this.audio.length > 0) {
        const suffix = this.audio.subarray(Math.max(this.lastDecodedLength, 0))
        if (rmsLevel(suffix) >= SPEECH_RMS_THRESHOLD) {
          try {
            activeText = await transcribe(this.audio, this.phaseMs)
          } catch (err: any) {
            post({ type: 'stream-error', streamId: this.streamId, message: err.message ?? String(err), phaseMs: this.phaseMs })
            return
          }
        }
      }
      post({ type: 'stream-final', streamId: this.streamId, transcript: this.combineWith(activeText), phaseMs: this.phaseMs })
    } finally {
      this.dispose()
    }
  }

  dispose(): void {
    this.cancelled = true
    this.audio = new Float32Array()
    this.frozenTexts = []
  }

  private combineWith(activeText: string): string {
    return [...this.frozenTexts, activeText].filter((text) => text.length > 0).join(' ')
  }

  // Close the active segment once it ends in enough silence and the decode has
  // caught up (the caught-up check also guarantees no decode is in flight over
  // the active buffer). Empty segments (pure silence) are never frozen, so a
  // long post-segment pause is a no-op rather than a loop.
  private maybeFreezeSegment(): void {
    if (this.trailingSilenceMs < SEGMENT_SILENCE_MS) return
    if (this.lastDecodedLength !== this.audio.length || this.lastText.length === 0) return
    this.frozenTexts.push(this.lastText)
    // Keep a pre-roll so a word onset straddling the boundary isn't clipped, and
    // mark it decoded so the loop doesn't burn a pass on the silent pre-roll.
    this.audio = this.audio.slice(Math.max(this.audio.length - PRE_ROLL_SAMPLES, 0))
    this.lastText = ''
    this.lastDecodedLength = this.audio.length
  }

  private startDecodeLoop(): void {
    if (this.decodeLoopPromise || this.cancelled) return
    this.decodeLoopPromise = this.decodeLoop().finally(() => { this.decodeLoopPromise = null })
  }

  private async decodeLoop(): Promise<void> {
    while (!this.cancelled && this.audio.length !== this.lastDecodedLength) {
      const snapshot = this.audio
      try {
        const text = await transcribe(snapshot, this.phaseMs)
        this.lastDecodedLength = snapshot.length
        if (this.cancelled) return
        if (text !== this.lastText) {
          this.lastText = text
          const fullText = this.combineWith(text)
          const textDelta = fullText.startsWith(this.lastFullText) ? fullText.slice(this.lastFullText.length) : fullText
          this.lastFullText = fullText
          post({ type: 'stream-partial', streamId: this.streamId, textDelta, fullText })
        }
        this.maybeFreezeSegment()
      } catch (err: any) {
        this.errorMessage = err.message ?? String(err)
        this.cancelled = true
      }
    }
  }
}

async function transcribe(samples: Float32Array, phaseMs: PhaseMetrics): Promise<string> {
  let phaseStartedAt = performance.now()
  const { preprocessor, encoder, decoder, vocab, blankIndex } = await loadModel()
  phaseMs.model_load_ms = elapsedMs(phaseStartedAt)

  const waveforms = new ort.Tensor('float32', samples, [1, samples.length])
  const waveformLengths = new ort.Tensor('int64', BigInt64Array.of(BigInt(samples.length)), [1])
  phaseStartedAt = performance.now()
  const preprocessed = await preprocessor.run({
    waveforms,
    waveforms_lens: waveformLengths,
  }).finally(() => disposeTensors(waveforms, waveformLengths))
  phaseMs.preprocess_ms = elapsedMs(phaseStartedAt)

  phaseStartedAt = performance.now()
  const encoded = await encoder.run({
    audio_signal: preprocessed.features,
    length: preprocessed.features_lens,
  }).finally(() => disposeTensors(...Object.values(preprocessed)))
  phaseMs.encode_ms = elapsedMs(phaseStartedAt)

  try {
    const encoderOutputs = encoded.outputs
    const encodedLengths = encoded.encoded_lengths
    if (!encodedLengths || encodedLengths.type !== 'int64') throw new Error('encoded_lengths is not an int64 tensor')

    const state1Metadata = decoder.inputMetadata.find((input) => input.name === 'input_states_1')
    const state2Metadata = decoder.inputMetadata.find((input) => input.name === 'input_states_2')

    if (!state1Metadata || state1Metadata.isTensor !== true || !state2Metadata || state2Metadata.isTensor !== true) {
      throw new Error('Decoder state metadata is missing')
    }
    const state1Shape = state1Metadata.shape.map((size) => typeof size === 'number' ? size : 1)
    const state2Shape = state2Metadata.shape.map((size) => typeof size === 'number' ? size : 1)
    const [, encoderWidth, encoderSteps] = encoderOutputs.dims
    const validSteps = Number((encodedLengths.data as BigInt64Array)[0])
    const frame = new Float32Array(encoderWidth)
    const target = Int32Array.of(blankIndex)
    const encoderFrame = new ort.Tensor('float32', frame, [1, encoderWidth, 1])
    const targetTensor = new ort.Tensor('int32', target, [1, 1])
    const targetLength = new ort.Tensor('int32', Int32Array.of(1), [1])
    let state1 = new ort.Tensor('float32', new Float32Array(state1Shape.reduce((a, b) => a * b)), state1Shape)
    let state2 = new ort.Tensor('float32', new Float32Array(state2Shape.reduce((a, b) => a * b)), state2Shape)
    const emitted: number[] = []
    let step = 0
    let emittedThisStep = 0

    phaseStartedAt = performance.now()
    try {
      while (step < validSteps) {
        for (let i = 0; i < encoderWidth; i++) frame[i] = encoderOutputs.data[i * encoderSteps + step] as number
        target[0] = emitted.length ? emitted[emitted.length - 1] : blankIndex
        const decoded = await decoder.run({
          encoder_outputs: encoderFrame,
          targets: targetTensor,
          target_length: targetLength,
          input_states_1: state1,
          input_states_2: state2,
        })

        try {
          const logits = decoded.outputs.data
          let token = 0
          for (let i = 1; i < vocab.length; i++) if (logits[i] > logits[token]) token = i
          let duration = 0
          for (let i = vocab.length + 1; i < logits.length; i++) {
            if (logits[i] > logits[vocab.length + duration]) duration = i - vocab.length
          }
          if (token !== blankIndex) {
            const nextState1 = decoded.output_states_1 as ort.TypedTensor<'float32'>
            const nextState2 = decoded.output_states_2 as ort.TypedTensor<'float32'>
            disposeTensors(state1, state2)
            state1 = nextState1
            state2 = nextState2
            emitted.push(token)
            emittedThisStep++
          }
          if (duration > 0) {
            step += duration
            emittedThisStep = 0
          } else if (token === blankIndex || emittedThisStep === MAX_TOKENS_PER_STEP) {
            step++
            emittedThisStep = 0
          }
        } finally {
          disposeTensors(...Object.values(decoded).filter((tensor) => tensor !== state1 && tensor !== state2))
        }
      }
    } finally {
      phaseMs.decode_ms = elapsedMs(phaseStartedAt)
      disposeTensors(encoderFrame, targetTensor, targetLength, state1, state2)
    }

    phaseStartedAt = performance.now()
    // The punctuation head resolves ambiguous audio (onset noise, a truncated
    // first word) as a bare punctuation token, so a decode can open with any
    // mark the vocab carries — ".", "?", "'", "-", "%", even Spanish "¿"/"¡"
    // from the multilingual model. No real transcript starts with punctuation,
    // so strip every leading non-alphanumeric run (Unicode-aware) rather than a
    // fixed set — this is what keeps stray marks off the front of the partial.
    const transcript = emitted.map((token) => vocab[token]).join('')
      .replace(/\s+/g, ' ')
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .trim()
    phaseMs.tokenize_ms = elapsedMs(phaseStartedAt)
    return transcript
  } finally {
    disposeTensors(...Object.values(encoded))
  }
}

async function handleWarmup(): Promise<void> {
  const startedAt = performance.now()
  try {
    await transcribe(new Float32Array(8_000), {})
    post({ type: 'warmup-done', ms: elapsedMs(startedAt) })
  } catch (err: any) {
    post({ type: 'warmup-error', message: err.message ?? String(err) })
  }
}

async function handleTranscribe(request: Extract<WorkerRequest, { type: 'transcribe' }>): Promise<void> {
  const phaseMs: PhaseMetrics = {}
  try {
    const transcript = await transcribe(request.samples, phaseMs)
    post({ id: request.id, type: 'result', transcript, phaseMs })
  } catch (err: any) {
    post({ id: request.id, type: 'error', message: err.message ?? String(err), phaseMs })
  }
}

function handleStreamStart(streamId: string): void {
  streams.get(streamId)?.dispose()
  streams.set(streamId, new StreamingStream(streamId))
}

function handleStreamAudio(streamId: string, samples: Float32Array): void {
  const stream = streams.get(streamId)
  if (!stream) return
  stream.addAudio(samples)
}

function handleStreamEnd(streamId: string): void {
  const stream = streams.get(streamId)
  if (!stream) {
    post({ type: 'stream-error', streamId, message: 'Voice stream is not active' })
    return
  }
  streams.delete(streamId)
  void stream.end()
}

function handleStreamCancel(streamId: string): void {
  const stream = streams.get(streamId)
  streams.delete(streamId)
  stream?.dispose()
}

const parentPort = (process as any).parentPort
parentPort?.on('message', (event: { data: WorkerRequest } | WorkerRequest) => {
  const request = 'data' in event ? event.data : event
  if (request.type === 'warmup') void handleWarmup()
  else if (request.type === 'transcribe') void handleTranscribe(request)
  else if (request.type === 'stream-start') handleStreamStart(request.streamId)
  else if (request.type === 'stream-audio') handleStreamAudio(request.streamId, request.samples)
  else if (request.type === 'stream-end') handleStreamEnd(request.streamId)
  else if (request.type === 'stream-cancel') handleStreamCancel(request.streamId)
})
