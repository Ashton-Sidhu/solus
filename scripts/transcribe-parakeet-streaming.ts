#!/usr/bin/env bun
// Chunked/streaming Parakeet prototype: encode audio incrementally DURING capture so that
// almost no encoder work remains when recording stops.
//
// Design (overlap-drop chunking, the standard recipe for running an offline conformer
// incrementally):
//   - All commit boundaries are aligned to whole encoder frames (80 ms = 1280 samples:
//     10 ms mel hop x 8x conformer subsampling), so audio positions map 1:1 to frame indices.
//   - Every TICK seconds of new audio we encode the window [committed - LEFT_CTX, now].
//     The re-encoded left context gives boundary frames real acoustic history; those
//     duplicate frames are dropped, not re-committed.
//   - The last HOLDBACK seconds are never committed mid-stream: a conformer frame needs
//     future context to be accurate, so frames near the right edge wait for the next tick
//     (which re-encodes them with more lookahead) before being committed.
//   - Committed frames feed a persistent TDT decoder (LSTM state + last token carry across
//     ticks), which is what makes live partial text essentially free.
//   - On stop, only [committed - LEFT_CTX, end] remains to encode — constant work
//     (~a window) no matter how long the recording was.
//
// Usage:
//   bun run scripts/transcribe-parakeet-streaming.ts <model-dir> <audio-file>
//     Simulated capture: feeds the file as if spoken live, then compares transcript and
//     post-stop latency against the offline single-shot pipeline.
//   bun run scripts/transcribe-parakeet-streaming.ts <model-dir>
//     Live microphone streaming (requires ffmpeg). Prints partial text as you speak;
//     Ctrl+C stops and prints the final transcript + stop latency.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'

const SAMPLE_RATE = 16_000
const BYTES_PER_SAMPLE = 2

// One encoder frame = 80 ms of audio. Everything below is denominated in frames.
const STEP_SAMPLES = 1280
const LEFT_CONTEXT_STEPS = 128 // 10.24 s of re-encoded history per window
const HOLDBACK_STEPS = 32 // 2.56 s of right lookahead before a frame is committed
const TICK_STEPS = 32 // encode every 2.56 s of new audio

// The final window always re-encodes LEFT_CONTEXT, so chunked stop-latency has a
// ~300ms floor. Below this recording length a single offline encode at stop is
// cheaper — don't start ticking until chunking can actually win.
const MIN_STREAM_STEPS = 160 // 12.8 s

const MAX_TOKENS_PER_STEP = 10
const ORT_THREADS = Math.min(4, Math.max(1, cpus().length - 2))
const SESSION_OPTIONS: ort.InferenceSession.SessionOptions = {
  executionMode: 'parallel',
  graphOptimizationLevel: 'all',
  intraOpNumThreads: ORT_THREADS,
  interOpNumThreads: 1,
}

type Model = {
  preprocessor: ort.InferenceSession
  encoder: ort.InferenceSession
  decoder: ort.InferenceSession
  vocab: string[]
  blankIndex: number
}

function usage(): never {
  console.error('Usage: bun run scripts/transcribe-parakeet-streaming.ts <model-dir> [audio-file]')
  console.error('')
  console.error('With an audio file: simulated live capture + comparison vs the offline pipeline.')
  console.error('Without: live microphone streaming (brew install ffmpeg).')
  process.exit(1)
}

function findModel(modelsDir: string, int8Name: string, fp32Name: string): string {
  const int8Path = join(modelsDir, int8Name)
  if (existsSync(int8Path)) return int8Path
  const fp32Path = join(modelsDir, fp32Name)
  if (existsSync(fp32Path)) return fp32Path
  throw new Error(`Missing ${int8Name} or ${fp32Name} in ${modelsDir}`)
}

function loadVocab(path: string): { vocab: string[]; blankIndex: number } {
  const vocab: string[] = []
  for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
    const separator = line.lastIndexOf(' ')
    vocab[Number(line.slice(separator + 1))] = line.slice(0, separator).replaceAll('▁', ' ')
  }
  const blankIndex = vocab.indexOf('<blk>')
  if (blankIndex < 0) throw new Error('vocab.txt is missing the <blk> token')
  return { vocab, blankIndex }
}

async function loadModel(modelsDir: string): Promise<Model> {
  const { vocab, blankIndex } = loadVocab(join(modelsDir, 'vocab.txt'))
  const [preprocessor, encoder, decoder] = await Promise.all([
    ort.InferenceSession.create(join(modelsDir, 'nemo128.onnx'), SESSION_OPTIONS),
    ort.InferenceSession.create(findModel(modelsDir, 'encoder-model.int8.onnx', 'encoder-model.onnx'), SESSION_OPTIONS),
    ort.InferenceSession.create(findModel(modelsDir, 'decoder_joint-model.int8.onnx', 'decoder_joint-model.onnx'), SESSION_OPTIONS),
  ])
  return { preprocessor, encoder, decoder, vocab, blankIndex }
}

function disposeTensors(...tensors: Array<ort.Tensor | undefined>): void {
  const seen: ort.Tensor[] = []
  for (const tensor of tensors) {
    if (!tensor || seen.includes(tensor)) continue
    seen.push(tensor)
    tensor.dispose()
  }
}

function zeroState(decoder: ort.InferenceSession, name: string): ort.TypedTensor<'float32'> {
  const metadata = decoder.inputMetadata.find((input) => input.name === name)
  if (!metadata || metadata.isTensor !== true) throw new Error(`Decoder metadata for ${name} is missing`)
  const shape = metadata.shape.map((size) => (typeof size === 'number' ? size : 1))
  return new ort.Tensor('float32', new Float32Array(shape.reduce((a, b) => a * b, 1)), shape)
}

function pcm16ToFloat32(buffer: Buffer): Float32Array {
  const sampleCount = Math.floor(buffer.length / BYTES_PER_SAMPLE)
  const samples = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) samples[i] = buffer.readInt16LE(i * BYTES_PER_SAMPLE) / 0x8000
  return samples
}

function joinTokens(vocab: string[], emitted: number[]): string {
  return emitted
    .map((token) => vocab[token])
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()
}

/**
 * Runs preprocessor + encoder over one audio window and returns the frames as
 * individual Float32Arrays (encoder output layout is [1, width, steps]).
 */
async function encodeWindow(model: Model, window: Float32Array): Promise<Float32Array[]> {
  const waveforms = new ort.Tensor('float32', window, [1, window.length])
  const waveformLengths = new ort.Tensor('int64', BigInt64Array.of(BigInt(window.length)), [1])
  const preprocessed = await model.preprocessor
    .run({ waveforms, waveforms_lens: waveformLengths })
    .finally(() => disposeTensors(waveforms, waveformLengths))

  const encoded = await model.encoder
    .run({ audio_signal: preprocessed.features, length: preprocessed.features_lens })
    .finally(() => disposeTensors(...Object.values(preprocessed)))

  try {
    const outputs = encoded.outputs
    const validSteps = Number((encoded.encoded_lengths.data as BigInt64Array)[0])
    const [, width, steps] = outputs.dims
    const data = outputs.data as Float32Array
    const frames: Float32Array[] = []
    for (let step = 0; step < validSteps; step++) {
      const frame = new Float32Array(width)
      for (let i = 0; i < width; i++) frame[i] = data[i * steps + step]
      frames.push(frame)
    }
    return frames
  } finally {
    disposeTensors(...Object.values(encoded))
  }
}

/**
 * Persistent TDT decoder: identical semantics to the offline loop in
 * src/main/transcription/worker.ts, but frames arrive incrementally and the
 * LSTM state / last emitted token survive across calls.
 */
class IncrementalDecoder {
  private state1: ort.TypedTensor<'float32'>
  private state2: ort.TypedTensor<'float32'>
  private emitted: number[] = []
  private step = 0
  private emittedThisStep = 0

  constructor(
    private model: Model,
    private onPiece?: (piece: string) => void,
  ) {
    this.state1 = zeroState(model.decoder, 'input_states_1')
    this.state2 = zeroState(model.decoder, 'input_states_2')
  }

  async decode(frames: Float32Array[]): Promise<void> {
    const { decoder, vocab, blankIndex } = this.model
    while (this.step < frames.length) {
      const frame = frames[this.step]
      const encoderFrame = new ort.Tensor('float32', frame, [1, frame.length, 1])
      const previousToken = this.emitted.length ? this.emitted[this.emitted.length - 1] : blankIndex
      const decoded = await decoder.run({
        encoder_outputs: encoderFrame,
        targets: new ort.Tensor('int32', Int32Array.of(previousToken), [1, 1]),
        target_length: new ort.Tensor('int32', Int32Array.of(1), [1]),
        input_states_1: this.state1,
        input_states_2: this.state2,
      })

      try {
        const logits = decoded.outputs.data as Float32Array
        let token = 0
        for (let i = 1; i < vocab.length; i++) if (logits[i] > logits[token]) token = i
        let duration = 0
        for (let i = vocab.length + 1; i < logits.length; i++) {
          if (logits[i] > logits[vocab.length + duration]) duration = i - vocab.length
        }

        if (token !== blankIndex) {
          disposeTensors(this.state1, this.state2)
          this.state1 = decoded.output_states_1 as ort.TypedTensor<'float32'>
          this.state2 = decoded.output_states_2 as ort.TypedTensor<'float32'>
          this.emitted.push(token)
          this.emittedThisStep++
          this.onPiece?.(vocab[token])
        }

        if (duration > 0) {
          this.step += duration
          this.emittedThisStep = 0
        } else if (token === blankIndex || this.emittedThisStep === MAX_TOKENS_PER_STEP) {
          this.step++
          this.emittedThisStep = 0
        }
      } finally {
        disposeTensors(
          encoderFrame,
          ...Object.values(decoded).filter((tensor) => tensor !== this.state1 && tensor !== this.state2),
        )
      }
    }
  }

  text(): string {
    return joinTokens(this.model.vocab, this.emitted)
  }

  dispose(): void {
    disposeTensors(this.state1, this.state2)
  }
}

class ChunkedTranscriber {
  private chunks: Float32Array[] = []
  private totalSamples = 0
  private committedSamples = 0
  private frames: Float32Array[] = []
  private decoder: IncrementalDecoder
  private queue: Promise<void> = Promise.resolve()
  readonly tickEncodeMs: number[] = []

  constructor(
    private model: Model,
    onPiece?: (piece: string) => void,
  ) {
    this.decoder = new IncrementalDecoder(model, onPiece)
  }

  /** Append captured audio; encodes in the background once a tick's worth is pending. */
  push(samples: Float32Array): Promise<void> {
    this.chunks.push(samples)
    this.totalSamples += samples.length
    if (
      this.totalSamples >= MIN_STREAM_STEPS * STEP_SAMPLES &&
      this.totalSamples - this.committedSamples >= (TICK_STEPS + HOLDBACK_STEPS) * STEP_SAMPLES
    ) {
      this.queue = this.queue.then(() => this.tick(false))
    }
    return this.queue
  }

  /** Encode + decode whatever remains. Returns the final transcript. */
  async finish(): Promise<string> {
    this.queue = this.queue.then(() => this.tick(true))
    await this.queue
    const transcript = this.decoder.text()
    this.decoder.dispose()
    return transcript
  }

  private window(startSample: number): Float32Array {
    const window = new Float32Array(this.totalSamples - startSample)
    let chunkStart = 0
    for (const chunk of this.chunks) {
      const chunkEnd = chunkStart + chunk.length
      if (chunkEnd > startSample) {
        const from = Math.max(0, startSample - chunkStart)
        window.set(chunk.subarray(from), chunkStart + from - startSample)
      }
      chunkStart = chunkEnd
    }
    return window
  }

  private async tick(final: boolean): Promise<void> {
    const windowStart = Math.max(0, this.committedSamples - LEFT_CONTEXT_STEPS * STEP_SAMPLES)
    const commitEndSample = final
      ? this.totalSamples
      : Math.floor((this.totalSamples - HOLDBACK_STEPS * STEP_SAMPLES) / STEP_SAMPLES) * STEP_SAMPLES
    if (commitEndSample <= this.committedSamples && !final) return

    const startedAt = performance.now()
    const windowFrames = await encodeWindow(this.model, this.window(windowStart))
    this.tickEncodeMs.push(Math.round(performance.now() - startedAt))

    const dropSteps = (this.committedSamples - windowStart) / STEP_SAMPLES
    const commitEndStep = final
      ? windowFrames.length
      : Math.min(windowFrames.length, (commitEndSample - windowStart) / STEP_SAMPLES)
    for (let step = dropSteps; step < commitEndStep; step++) this.frames.push(windowFrames[step])
    this.committedSamples = final ? this.totalSamples : windowStart + commitEndStep * STEP_SAMPLES

    await this.decoder.decode(this.frames)
  }
}

async function offlineTranscribe(model: Model, samples: Float32Array): Promise<{ text: string; encodeMs: number; totalMs: number }> {
  const startedAt = performance.now()
  const frames = await encodeWindow(model, samples)
  const encodeMs = Math.round(performance.now() - startedAt)
  const decoder = new IncrementalDecoder(model)
  await decoder.decode(frames)
  const text = decoder.text()
  decoder.dispose()
  return { text, encodeMs, totalMs: Math.round(performance.now() - startedAt) }
}

function decodeAudioFile(path: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', path,
      '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', '-',
    ])
    const chunks: Buffer[] = []
    let stderr = ''
    ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    ffmpeg.stderr.setEncoding('utf8')
    ffmpeg.stderr.on('data', (data: string) => (stderr += data))
    ffmpeg.on('error', reject)
    ffmpeg.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`))
      else resolve(pcm16ToFloat32(Buffer.concat(chunks)))
    })
  })
}

async function runFileSimulation(model: Model, audioPath: string): Promise<void> {
  const samples = await decodeAudioFile(audioPath)
  const audioSeconds = samples.length / SAMPLE_RATE
  console.log(`Audio: ${audioSeconds.toFixed(1)}s (${audioPath})`)

  // Warm all three sessions so first-run graph initialization doesn't skew either timing.
  await offlineTranscribe(model, new Float32Array(SAMPLE_RATE))

  console.log('\n--- Offline (current pipeline: encode everything after stop) ---')
  const offline = await offlineTranscribe(model, samples)
  console.log(`post-stop wait: ${offline.totalMs}ms (encode ${offline.encodeMs}ms)`)

  console.log('\n--- Chunked (encode during capture) ---')
  const chunked = new ChunkedTranscriber(model)
  // Feed 100ms capture chunks; encoding ticks happen inline as they would during recording.
  const captureChunk = SAMPLE_RATE / 10
  let liveEncodeMs = 0
  for (let offset = 0; offset < samples.length; offset += captureChunk) {
    const before = performance.now()
    await chunked.push(samples.subarray(offset, Math.min(offset + captureChunk, samples.length)))
    liveEncodeMs += performance.now() - before
  }
  const stopStartedAt = performance.now()
  const chunkedText = await chunked.finish()
  const stopMs = Math.round(performance.now() - stopStartedAt)

  const ticks = chunked.tickEncodeMs
  console.log(`post-stop wait: ${stopMs}ms`)
  console.log(
    `work during capture: ${Math.round(liveEncodeMs)}ms total across ${ticks.length} ticks ` +
      `(avg ${Math.round(ticks.reduce((a, b) => a + b, 0) / Math.max(1, ticks.length))}ms/tick, ` +
      `${((liveEncodeMs / 1000 / audioSeconds) * 100).toFixed(1)}% of capture time)`,
  )

  console.log('\n--- Transcripts ---')
  console.log(`offline: ${offline.text}`)
  console.log(`chunked: ${chunkedText}`)
  const offlineWords = offline.text.toLowerCase().split(/\s+/)
  const chunkedWords = chunkedText.toLowerCase().split(/\s+/)
  const mismatches =
    Math.abs(offlineWords.length - chunkedWords.length) +
    offlineWords.filter((word, i) => chunkedWords[i] !== word).length
  console.log(
    mismatches === 0
      ? '\nTranscripts match exactly.'
      : `\n${mismatches} word position(s) differ out of ${offlineWords.length}.`,
  )
  console.log(`\nStop-latency: offline ${offline.totalMs}ms -> chunked ${stopMs}ms`)
}

async function runMicrophone(model: Model): Promise<void> {
  const chunked = new ChunkedTranscriber(model, (piece) => process.stdout.write(piece))
  const ffmpeg = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', ':0', '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', '-'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stderr = ''
  ffmpeg.stderr?.setEncoding('utf8')
  ffmpeg.stderr?.on('data', (data: string) => (stderr += data))
  ffmpeg.on('error', (error: Error) => {
    console.error(
      error.message.includes('ENOENT')
        ? 'FFmpeg is required for microphone capture. Install it with: brew install ffmpeg'
        : error.message,
    )
    process.exit(1)
  })
  ffmpeg.on('close', (code) => {
    if (code !== 0 && code !== 255) console.error(stderr.trim() || `FFmpeg exited with code ${code}`)
  })

  console.error('Streaming transcription. Press Ctrl+C to stop.\n')

  let stopping = false
  process.on('SIGINT', () => {
    if (stopping) return
    stopping = true
    ffmpeg.kill('SIGINT')
    const stopStartedAt = performance.now()
    void chunked.finish().then((transcript) => {
      const stopMs = Math.round(performance.now() - stopStartedAt)
      console.log(`\n\nFinal (${stopMs}ms after stop): ${transcript}`)
      process.exit(0)
    })
  })

  ffmpeg.stdout?.on('data', (chunk: Buffer) => {
    if (!stopping) void chunked.push(pcm16ToFloat32(chunk))
  })
}

async function main(): Promise<void> {
  const [, , modelsDir, audioPath] = process.argv
  if (!modelsDir) usage()

  console.error('Loading model...')
  const model = await loadModel(modelsDir)

  if (audioPath) await runFileSimulation(model, audioPath)
  else await runMicrophone(model)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
