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

type WorkerResponse =
  | { id: number; type: 'result'; transcript: string; phaseMs: PhaseMetrics }
  | { id: number; type: 'error'; message: string; phaseMs: PhaseMetrics }
  | { type: 'warmup-done'; ms: number }
  | { type: 'warmup-error'; message: string }

let modelPromise: Promise<ParakeetModel> | null = null

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

const parentPort = (process as any).parentPort
parentPort?.on('message', (event: { data: WorkerRequest } | WorkerRequest) => {
  const request = 'data' in event ? event.data : event
  if (request.type === 'warmup') void handleWarmup()
  else if (request.type === 'transcribe') void handleTranscribe(request)
})
