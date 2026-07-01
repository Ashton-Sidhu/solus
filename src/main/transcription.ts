import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import * as ort from 'onnxruntime-node'
import { createLogger } from './logger'
import { ensureParakeetModel, PARAKEET_MODEL_DIR } from './model-downloader'

const log = createLogger('main', 'transcription.ts')
const MAX_TOKENS_PER_STEP = 10
const SESSION_OPTIONS: ort.InferenceSession.SessionOptions = {
  executionMode: 'parallel',
  graphOptimizationLevel: 'all',
}

type PhaseMetrics = Record<string, number>

type ParakeetModel = {
  preprocessor: ort.InferenceSession
  encoder: ort.InferenceSession
  decoder: ort.InferenceSession
  vocab: string[]
  blankIndex: number
}

let modelPromise: Promise<ParakeetModel> | null = null

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
      await ensureParakeetModel()
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

export async function warmupTranscription(): Promise<void> {
  const startedAt = performance.now()
  try {
    await loadModel()
    log.metric('warmup transcription', elapsedMs(startedAt), { success: true })
  } catch (err: any) {
    log.warn(`Transcription warmup failed: ${err.message}`)
  }
}

function readAscii(view: DataView, offset: number, length: number): string {
  let value = ''
  for (let i = 0; i < length; i++) value += String.fromCharCode(view.getUint8(offset + i))
  return value
}

function readWav(buffer: Buffer): Float32Array {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Audio must be a RIFF WAV file')
  }

  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = 0
  let dataLength = 0
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const chunkId = readAscii(view, offset, 4)
    const chunkLength = view.getUint32(offset + 4, true)
    const chunkOffset = offset + 8
    if (chunkId === 'fmt ') {
      channels = view.getUint16(chunkOffset + 2, true)
      sampleRate = view.getUint32(chunkOffset + 4, true)
      bitsPerSample = view.getUint16(chunkOffset + 14, true)
    } else if (chunkId === 'data') {
      dataOffset = chunkOffset
      dataLength = chunkLength
    }
    offset = chunkOffset + chunkLength + (chunkLength % 2)
  }
  if (!dataOffset || channels !== 1 || sampleRate !== 16_000 || bitsPerSample !== 16) {
    throw new Error('Audio must be a 16 kHz mono signed 16-bit PCM WAV')
  }

  const samples = new Float32Array(dataLength / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(dataOffset + i * 2, true) / 0x8000
  return samples
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
    const transcript = emitted.map((token) => vocab[token]).join('').replace(/\s+/g, ' ').trim()
    phaseMs.tokenize_ms = elapsedMs(phaseStartedAt)
    return transcript
  } finally {
    disposeTensors(...Object.values(encoded))
  }
}

export async function transcribeAudio(audioBase64: string): Promise<{ error: string | null; transcript: string | null }> {
  const startedAt = Date.now()
  const phaseMs: PhaseMetrics = {}
  try {
    const wavStartedAt = performance.now()
    const samples = readWav(Buffer.from(audioBase64, 'base64'))
    phaseMs.wav_decode_ms = elapsedMs(wavStartedAt)
    const transcript = await transcribe(samples, phaseMs)
    const durationMs = Date.now() - startedAt
    log.metric('transcribe audio', durationMs, {
      ...phaseMs,
      audio_duration_ms: Math.round(samples.length / 16),
      speedup_x: durationMs > 0 ? Math.round((samples.length / 16) / durationMs * 10) / 10 : null,
      backend: 'Parakeet ONNX INT8',
      success: true,
    })
    return { error: null, transcript }
  } catch (err: any) {
    log.error(`Transcription error: ${err.message}`)
    log.metric('transcribe audio', Date.now() - startedAt, { ...phaseMs, backend: 'Parakeet ONNX INT8', success: false })
    return { error: `Transcription failed: ${err.message}`, transcript: null }
  }
}
