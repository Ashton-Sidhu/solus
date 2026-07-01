#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'

const SAMPLE_RATE = 16_000
const DEFAULT_MAX_TOKENS_PER_STEP = 10

type ModelConfig = {
  max_tokens_per_step?: number
}

type WavData = {
  samples: Float32Array
  sampleRate: number
}

function usage(): never {
  console.error('Usage: bun run scripts/transcribe-parakeet.ts <model-dir>')
  console.error('')
  console.error('Install microphone capture first: brew install ffmpeg')
  process.exit(1)
}

function recordUtterance(path: string): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('Push-to-talk requires an interactive terminal')

  return new Promise((resolve, reject) => {
    console.error('Press Enter to start recording.')
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    let recording = false
    let ffmpeg: ReturnType<typeof spawn> | null = null

    const cleanup = () => {
      process.stdin.off('data', onKey)
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onKey = (key: string) => {
      if (key === '\u0003') {
        ffmpeg?.kill('SIGINT')
        fail(new Error('Recording cancelled'))
        return
      }
      if (key !== '\r' && key !== '\n') return

      if (!recording) {
        recording = true
        console.error('Recording... press Enter to stop.')
        ffmpeg = spawn(
      'ffmpeg',
          ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', ':0', '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', '-y', path],
          { stdio: ['pipe', 'ignore', 'pipe'] },
        )
        let stderr = ''
        ffmpeg.stderr?.setEncoding('utf8')
        ffmpeg.stderr?.on('data', (data) => { stderr += data })
        ffmpeg.on('error', (error) => fail(new Error(error.message.includes('ENOENT') ? 'FFmpeg is required for microphone capture. Install it with: brew install ffmpeg' : error.message)))
        ffmpeg.on('close', (code) => {
          cleanup()
          if (code === 0 || code === 255) resolve()
          else reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}`))
        })
        return
      }

      process.stdin.off('data', onKey)
      console.error('Stopping recording...')
      ffmpeg?.stdin?.write('q')
      ffmpeg?.stdin?.end()
    }
    process.stdin.on('data', onKey)
  })
}

function findModel(modelsDir: string, int8Name: string, fp32Name: string): string {
  const int8Path = join(modelsDir, int8Name)
  if (existsSync(int8Path)) return int8Path

  const fp32Path = join(modelsDir, fp32Name)
  if (existsSync(fp32Path)) return fp32Path

  throw new Error(`Missing ${int8Name} or ${fp32Name} in ${modelsDir}`)
}

function readAscii(view: DataView, offset: number, length: number): string {
  let value = ''
  for (let i = 0; i < length; i++) value += String.fromCharCode(view.getUint8(offset + i))
  return value
}

function readWav(path: string): WavData {
  const file = readFileSync(path)
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Audio must be a RIFF WAV file')
  }

  let audioFormat = 0
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
      audioFormat = view.getUint16(chunkOffset, true)
      channels = view.getUint16(chunkOffset + 2, true)
      sampleRate = view.getUint32(chunkOffset + 4, true)
      bitsPerSample = view.getUint16(chunkOffset + 14, true)
    } else if (chunkId === 'data') {
      dataOffset = chunkOffset
      dataLength = chunkLength
    }
    offset = chunkOffset + chunkLength + (chunkLength % 2)
  }

  if (!dataOffset || !channels || !sampleRate) throw new Error('WAV is missing fmt or data chunks')
  if (audioFormat !== 1 || bitsPerSample !== 16) {
    throw new Error('WAV must use signed 16-bit PCM samples')
  }

  const frameCount = Math.floor(dataLength / (channels * 2))
  const samples = new Float32Array(frameCount)
  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) {
      sum += view.getInt16(dataOffset + (frame * channels + channel) * 2, true) / 0x8000
    }
    samples[frame] = sum / channels
  }
  return { samples, sampleRate }
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

  const [preprocessor, encoder, decoder] = await Promise.all([
    ort.InferenceSession.create(preprocessorPath),
    ort.InferenceSession.create(encoderPath),
    ort.InferenceSession.create(decoderPath),
  ])
  const { tokens: vocab, blankIndex } = loadVocab(vocabPath)
  const wavPath = join(tmpdir(), `parakeet-${Date.now()}.wav`)

  try {
    await recordUtterance(wavPath)
    console.error('Transcribing...')
    const { samples } = readWav(wavPath)
    const transcribeStartedAt = performance.now()

    const preprocessed = await preprocessor.run({
      waveforms: new ort.Tensor('float32', samples, [1, samples.length]),
      waveforms_lens: new ort.Tensor('int64', BigInt64Array.of(BigInt(samples.length)), [1]),
    })
    const features = preprocessed.features
    const featuresLens = preprocessed.features_lens
    if (!features || !featuresLens) throw new Error('nemo128.onnx returned unexpected outputs')

    const encoded = await encoder.run({ audio_signal: features, length: featuresLens })
    const encoderOutputs = encoded.outputs
    const encodedLengths = encoded.encoded_lengths
    if (!encoderOutputs || !encodedLengths) throw new Error('Encoder returned unexpected outputs')

    const state1Metadata = decoder.inputMetadata.find((input) => input.name === 'input_states_1')
    const state2Metadata = decoder.inputMetadata.find((input) => input.name === 'input_states_2')
    if (!state1Metadata || state1Metadata.isTensor !== true || !state2Metadata || state2Metadata.isTensor !== true) {
      throw new Error('Decoder state metadata is missing')
    }
    const state1Shape = state1Metadata.shape.map((size) => typeof size === 'number' ? size : 1)
    const state2Shape = state2Metadata.shape.map((size) => typeof size === 'number' ? size : 1)

    const encoderData = tensorData(encoderOutputs) as Float32Array
    const [, encoderWidth, encoderSteps] = encoderOutputs.dims
    const validSteps = Number((tensorData(encodedLengths) as BigInt64Array)[0])
    let state1 = new ort.Tensor('float32', new Float32Array(state1Shape.reduce((a, b) => a * b)), state1Shape)
    let state2 = new ort.Tensor('float32', new Float32Array(state2Shape.reduce((a, b) => a * b)), state2Shape)
    const emitted: number[] = []
    let step = 0
    let emittedThisStep = 0

    while (step < validSteps) {
    const frame = new Float32Array(encoderWidth)
    for (let i = 0; i < encoderWidth; i++) frame[i] = encoderData[i * encoderSteps + step]
    const previousToken = emitted.length ? emitted[emitted.length - 1] : blankIndex
    const decoded = await decoder.run({
      encoder_outputs: new ort.Tensor('float32', frame, [1, encoderWidth, 1]),
      targets: new ort.Tensor('int32', Int32Array.of(previousToken), [1, 1]),
      target_length: new ort.Tensor('int32', Int32Array.of(1), [1]),
      input_states_1: state1,
      input_states_2: state2,
    })
    const logits = tensorData(decoded.outputs) as Float32Array
    let token = 0
    for (let i = 1; i < vocab.length; i++) if (logits[i] > logits[token]) token = i

    let duration = 0
    for (let i = vocab.length + 1; i < logits.length; i++) {
      if (logits[i] > logits[vocab.length + duration]) duration = i - vocab.length
    }

    if (token !== blankIndex) {
      state1 = floatTensor(decoded.output_states_1, 'output_states_1')
      state2 = floatTensor(decoded.output_states_2, 'output_states_2')
      emitted.push(token)
      emittedThisStep++
    }
    if (duration > 0) {
      step += duration
      emittedThisStep = 0
    } else if (token === blankIndex || emittedThisStep === maxTokensPerStep) {
      step++
      emittedThisStep = 0
    }
    }

    console.log(emitted.map((token) => vocab[token]).join('').replace(/\s+/g, ' ').trim())
    console.error(`Transcribed in ${Math.round(performance.now() - transcribeStartedAt)} ms`)
  } finally {
    try { unlinkSync(wavPath) } catch {}
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
