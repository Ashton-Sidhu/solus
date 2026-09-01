#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'

const SAMPLE_RATE = 16_000
const BYTES_PER_SAMPLE = 2
const DEFAULT_MAX_TOKENS_PER_STEP = 10

// Smaller chunks reduce latency, larger chunks improve stability.
const CHUNK_SECONDS = 0.5
const CHUNK_BYTES = Math.floor(SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_SECONDS)

// Keep a little audio context because the ONNX preprocessor/encoder were exported for chunks,
// not true sample-by-sample streaming.
const CONTEXT_SECONDS = 2
const CONTEXT_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * CONTEXT_SECONDS

type ModelConfig = {
  max_tokens_per_step?: number
}

function usage(): never {
  console.error('Usage: bun run scripts/transcribe-parakeet-streaming.ts <model-dir>')
  console.error('')
  console.error('Install microphone capture first: brew install ffmpeg')
  process.exit(1)
}

function findModel(modelsDir: string, int8Name: string, fp32Name: string): string {
  const int8Path = join(modelsDir, int8Name)
  if (existsSync(int8Path)) return int8Path

  const fp32Path = join(modelsDir, fp32Name)
  if (existsSync(fp32Path)) return fp32Path

  throw new Error(`Missing ${int8Name} or ${fp32Name} in ${modelsDir}`)
}

function loadVocab(path: string): { tokens: string[]; blankIndex: number } {
  const entries = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const separator = line.lastIndexOf(' ')
      return [Number(line.slice(separator + 1)), line.slice(0, separator).replaceAll('\u2581', ' ')] as const
    })

  const tokens: string[] = []
  for (const [index, token] of entries) tokens[index] = token

  const blankIndex = tokens.indexOf('<blk>')
  if (blankIndex < 0) throw new Error('vocab.txt is missing the <blk> token')

  return { tokens, blankIndex }
}

function tensorData(tensor: ort.Tensor): Float32Array | BigInt64Array {
  return tensor.data as Float32Array | BigInt64Array
}

function floatTensor(tensor: ort.Tensor | undefined, name: string): ort.TypedTensor<'float32'> {
  if (!tensor || tensor.type !== 'float32') throw new Error(`${name} is not a float32 tensor`)
  return tensor as ort.TypedTensor<'float32'>
}

function pcm16BufferToFloat32(buffer: Buffer): Float32Array {
  const sampleCount = Math.floor(buffer.length / BYTES_PER_SAMPLE)
  const samples = new Float32Array(sampleCount)

  for (let i = 0; i < sampleCount; i++) {
    samples[i] = buffer.readInt16LE(i * BYTES_PER_SAMPLE) / 0x8000
  }

  return samples
}

function makeZeroState(metadata: ort.InferenceSession.InputMetadata): ort.TypedTensor<'float32'> {
  if (metadata.isTensor !== true) throw new Error('Decoder state metadata is not tensor metadata')
  const shape = metadata.shape.map((size) => typeof size === 'number' ? size : 1)
  return new ort.Tensor('float32', new Float32Array(shape.reduce((a, b) => a * b, 1)), shape)
}

class StreamingParakeetTranscriber {
  private state1: ort.TypedTensor<'float32'>
  private state2: ort.TypedTensor<'float32'>
  private emitted: number[] = []
  private processedEncoderSteps = 0
  private running = false

  constructor(
    private preprocessor: ort.InferenceSession,
    private encoder: ort.InferenceSession,
    private decoder: ort.InferenceSession,
    private vocab: string[],
    private blankIndex: number,
    private maxTokensPerStep: number,
  ) {
    const state1Metadata = decoder.inputMetadata.find((input) => input.name === 'input_states_1')
    const state2Metadata = decoder.inputMetadata.find((input) => input.name === 'input_states_2')

    if (!state1Metadata || !state2Metadata) {
      throw new Error('Decoder state metadata is missing')
    }

    this.state1 = makeZeroState(state1Metadata)
    this.state2 = makeZeroState(state2Metadata)
  }

  async addAudio(samples: Float32Array): Promise<string> {
    // Avoid overlapping decoder runs when microphone chunks arrive faster than inference.
    while (this.running) await delay(1)
    this.running = true

    try {
      const preprocessed = await this.preprocessor.run({
        waveforms: new ort.Tensor('float32', samples, [1, samples.length]),
        waveforms_lens: new ort.Tensor('int64', BigInt64Array.of(BigInt(samples.length)), [1]),
      })

      const features = preprocessed.features
      const featuresLens = preprocessed.features_lens
      if (!features || !featuresLens) throw new Error('nemo128.onnx returned unexpected outputs')

      const encoded = await this.encoder.run({ audio_signal: features, length: featuresLens })
      const encoderOutputs = encoded.outputs
      const encodedLengths = encoded.encoded_lengths
      if (!encoderOutputs || !encodedLengths) throw new Error('Encoder returned unexpected outputs')

      const encoderData = tensorData(encoderOutputs) as Float32Array
      const [, encoderWidth, encoderSteps] = encoderOutputs.dims
      const validSteps = Number((tensorData(encodedLengths) as BigInt64Array)[0])

      // Because we re-run the preprocessor/encoder over a rolling audio window,
      // skip encoder frames we have already consumed.
      let step = Math.min(this.processedEncoderSteps, validSteps)
      let emittedThisStep = 0
      let textDelta = ''

      while (step < validSteps) {
        const frame = new Float32Array(encoderWidth)
        for (let i = 0; i < encoderWidth; i++) frame[i] = encoderData[i * encoderSteps + step]

        const previousToken = this.emitted.length ? this.emitted[this.emitted.length - 1] : this.blankIndex

        const decoded = await this.decoder.run({
          encoder_outputs: new ort.Tensor('float32', frame, [1, encoderWidth, 1]),
          targets: new ort.Tensor('int32', Int32Array.of(previousToken), [1, 1]),
          target_length: new ort.Tensor('int32', Int32Array.of(1), [1]),
          input_states_1: this.state1,
          input_states_2: this.state2,
        })

        const logits = tensorData(decoded.outputs) as Float32Array

        let token = 0
        for (let i = 1; i < this.vocab.length; i++) {
          if (logits[i] > logits[token]) token = i
        }

        let duration = 0
        for (let i = this.vocab.length + 1; i < logits.length; i++) {
          if (logits[i] > logits[this.vocab.length + duration]) {
            duration = i - this.vocab.length
          }
        }

        if (token !== this.blankIndex) {
          this.state1 = floatTensor(decoded.output_states_1, 'output_states_1')
          this.state2 = floatTensor(decoded.output_states_2, 'output_states_2')
          this.emitted.push(token)
          console.log(this.emitted)

          const piece = this.vocab[token]
          textDelta += piece
          process.stdout.write(piece)
          emittedThisStep++
        }

        if (duration > 0) {
          step += duration
          emittedThisStep = 0
        } else if (token === this.blankIndex || emittedThisStep === this.maxTokensPerStep) {
          step++
          emittedThisStep = 0
        }
      }

      this.processedEncoderSteps = validSteps
      return textDelta
    } finally {
      this.running = false
    }
  }

  finalText(): string {
    return this.emitted.map((token) => this.vocab[token]).join('').replace(/\s+/g, ' ').trim()
  }
}

function startMicrophone(): ReturnType<typeof spawn> {
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'avfoundation',
      '-i', ':0',
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-f', 's16le',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let stderr = ''

  ffmpeg.stderr?.setEncoding('utf8')
  ffmpeg.stderr?.on('data', (data) => {
    stderr += data
  })

  ffmpeg.on('error', (error) => {
    throw new Error(
      error.message.includes('ENOENT')
        ? 'FFmpeg is required for microphone capture. Install it with: brew install ffmpeg'
        : error.message,
    )
  })

  ffmpeg.on('close', (code) => {
    if (code !== 0 && code !== 255) {
      console.error(stderr.trim() || `FFmpeg exited with code ${code}`)
    }
  })

  return ffmpeg
}

async function main(): Promise<void> {
  const [, , modelsDir] = process.argv
  if (!modelsDir) usage()

  const preprocessorPath = join(modelsDir, 'nemo128.onnx')
  const vocabPath = join(modelsDir, 'vocab.txt')
  if (!existsSync(preprocessorPath)) throw new Error(`Missing nemo128.onnx in ${modelsDir}`)
  if (!existsSync(vocabPath)) throw new Error(`Missing vocab.txt in ${modelsDir}`)

  const encoderPath = findModel(modelsDir, 'encoder-model.int8.onnx', 'encoder-model.onnx')
  const decoderPath = findModel(modelsDir, 'decoder_joint-model.int8.onnx', 'decoder_joint-model.onnx')
  const configPath = join(modelsDir, 'config.json')
  const config: ModelConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
  const maxTokensPerStep = config.max_tokens_per_step ?? DEFAULT_MAX_TOKENS_PER_STEP

  console.error('Loading model...')
  const [preprocessor, encoder, decoder] = await Promise.all([
    ort.InferenceSession.create(preprocessorPath),
    ort.InferenceSession.create(encoderPath),
    ort.InferenceSession.create(decoderPath),
  ])

  const { tokens: vocab, blankIndex } = loadVocab(vocabPath)
  const transcriber = new StreamingParakeetTranscriber(
    preprocessor,
    encoder,
    decoder,
    vocab,
    blankIndex,
    maxTokensPerStep,
  )

  const ffmpeg = startMicrophone()

  let pcmBuffer = Buffer.alloc(0)
  let rollingContext = Buffer.alloc(0)
  let stopping = false

  console.error('Streaming transcription. Press Ctrl+C to stop.')
  process.stdout.write('\n')

  process.on('SIGINT', () => {
    if (stopping) return
    stopping = true
    ffmpeg.kill('SIGINT')
    process.stdout.write('\n')
    console.error(`\nFinal: ${transcriber.finalText()}`)
    process.exit(0)
  })

  ffmpeg.stdout.on('data', async (chunk: Buffer) => {
    if (stopping) return

    pcmBuffer = Buffer.concat([pcmBuffer, chunk])

    while (pcmBuffer.length >= CHUNK_BYTES) {
      const nextChunk = pcmBuffer.subarray(0, CHUNK_BYTES)
      pcmBuffer = pcmBuffer.subarray(CHUNK_BYTES)

      rollingContext = Buffer.concat([rollingContext, nextChunk])
      if (rollingContext.length > CONTEXT_BYTES) {
        rollingContext = rollingContext.subarray(rollingContext.length - CONTEXT_BYTES)
      }

      const samples = pcm16BufferToFloat32(rollingContext)
      await transcriber.addAudio(samples)
    }
  })
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
