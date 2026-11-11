import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, powerSaveBlocker } from 'electron'
import { voiceTranscriptionOptionsSchema, type VoiceTranscriptionOptions } from '@solus/contracts/voice-dictionary'
import { MAX_VOICE_SAMPLES } from '@solus/contracts/voice-audio'
import { VOICE_WARM_LEASE_MS, type VoiceTranscript, type VoicePartial, type VoiceWarmRequest } from '@solus/contracts/voice-stream'
import { createLogger } from '@solus/server/logger'
import { ensureParakeetModel, getVoiceModelStatus, isParakeetModelReady, PARAKEET_MODEL_FILE } from '@solus/server/model-downloader'
import { recordOtelDuration } from '@solus/server/otel'
import { NativeVoiceWorker } from './native-worker'

const log = createLogger('main', 'transcription/index.ts')
export const TRANSCRIPTION_WORKER_IDLE_MS = 2 * 60_000
const STREAM_IDLE_MS = 30_000
let worker: NativeVoiceWorker | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let batchBusy = false
const warmClients = new Map<string, ReturnType<typeof setTimeout>>()
let warming: { worker: NativeVoiceWorker; promise: Promise<void> } | null = null

type Capture = {
  streamId: string
  owner: string
  worker: NativeVoiceWorker
  samples: number
  feeding: boolean
  finishing: boolean
  timer: ReturnType<typeof setTimeout>
  blocker: number
  onEnd: () => void
}
let capture: Capture | null = null

export function transcriptionRequestTimeoutMs(samplesLength: number): number {
  return Math.max(120_000, Math.min(30 * 60_000, samplesLength / 16 * 2))
}

export function transcriptionBinaryPath(): string {
  const name = process.platform === 'win32' ? 'solus-transcription.exe' : 'solus-transcription'
  return app.isPackaged
    ? join(process.resourcesPath, 'transcription', name)
    : join(app.getAppPath(), 'build', 'transcription', 'bin', name)
}

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdleStop(): void {
  clearIdleTimer()
  if (capture || batchBusy || warmClients.size || !worker) return
  const current = worker
  idleTimer = setTimeout(() => {
    if (worker !== current || capture || batchBusy || warmClients.size) return
    worker = null
    current.stop()
  }, TRANSCRIPTION_WORKER_IDLE_MS)
  idleTimer.unref?.()
}

function ensureWorker(): NativeVoiceWorker {
  clearIdleTimer()
  if (worker && !worker.stopped) return worker
  const binaryPath = transcriptionBinaryPath()
  if (!existsSync(binaryPath)) throw new Error('Voice runtime is missing. Run bun run voice:build before using voice in development.')
  const current = new NativeVoiceWorker(binaryPath, PARAKEET_MODEL_FILE, () => {
    if (worker === current) worker = null
    if (capture?.worker === current) endCapture(capture)
  })
  worker = current
  return current
}

function endCapture(current: Capture): void {
  if (capture !== current) return
  capture = null
  clearTimeout(current.timer)
  if (powerSaveBlocker.isStarted(current.blocker)) powerSaveBlocker.stop(current.blocker)
  current.onEnd()
  scheduleIdleStop()
}

function touchCapture(current: Capture): void {
  clearTimeout(current.timer)
  current.timer = setTimeout(() => {
    if (capture !== current) return
    // A disconnected or discarded renderer must not hold the model or the
    // power assertion. Only stop the child that belongs to this capture.
    current.worker.stop('Voice stream disconnected')
    if (worker === current.worker) worker = null
    endCapture(current)
  }, STREAM_IDLE_MS)
  current.timer.unref?.()
}

function ownedCapture(owner: string, streamId: string, allowFinishing = false): Capture {
  if (!capture || capture.owner !== owner || capture.streamId !== streamId || (capture.finishing && !allowFinishing))
    throw new Error('Voice stream is no longer active')
  return capture
}

function modelNotReadyMessage(): string {
  const status = getVoiceModelStatus()
  if (status.state === 'error') return `Voice model failed to download: ${status.error ?? 'Unknown error'}`
  if (status.state === 'downloading' && status.totalBytes)
    return `Voice model is still downloading (${Math.floor((status.receivedBytes ?? 0) / status.totalBytes * 100)}%)`
  return 'Voice model is still preparing'
}

async function requireModel(): Promise<void> {
  if (await isParakeetModelReady()) return
  void ensureParakeetModel().catch(() => {})
  throw new Error(modelNotReadyMessage())
}

export async function prepareTranscriptionModel(): Promise<void> {
  try { await ensureParakeetModel() }
  catch (error) { log.warn('transcription_model_prepare_failed', { error: String(error) }) }
}

export async function warmTranscription(owner: string, request?: VoiceWarmRequest): Promise<void> {
  if (request) {
    const previous = warmClients.get(owner)
    if (previous) clearTimeout(previous)
    warmClients.delete(owner)
    if (!request.keepWarm) {
      scheduleIdleStop()
      return
    }
    clearIdleTimer()
    const expires = setTimeout(() => {
      warmClients.delete(owner)
      scheduleIdleStop()
    }, VOICE_WARM_LEASE_MS)
    expires.unref?.()
    warmClients.set(owner, expires)
  }
  if (batchBusy || capture) return
  await requireModel()
  // A stream or batch may have started while model readiness was checked.
  if (batchBusy || capture) return
  const current = ensureWorker()
  if (warming?.worker === current) return warming.promise
  const promise = current.request('warm').then(result => {
    if (result.error) throw new Error(result.error)
  }).finally(() => {
    if (warming?.worker === current) warming = null
    scheduleIdleStop()
  })
  warming = { worker: current, promise }
  return promise
}

export async function startVoiceStream(owner: string, onEnd: () => void, options?: VoiceTranscriptionOptions): Promise<string> {
  await requireModel()
  if (batchBusy || capture) throw new Error('Voice transcription is already in progress')
  const current = ensureWorker()
  const active: Capture = {
    streamId: randomUUID(), owner, worker: current, samples: 0,
    feeding: false, finishing: false, timer: setTimeout(() => {}, 0),
    blocker: powerSaveBlocker.start('prevent-app-suspension'), onEnd,
  }
  capture = active
  touchCapture(active)
  try {
    const result = await current.request('begin', undefined, undefined, voiceTranscriptionOptionsSchema.optional().parse(options)?.vocabulary)
    if (result.error) throw new Error(result.error)
    if (capture !== active) throw new Error('Voice stream was cancelled')
    touchCapture(active)
    return active.streamId
  } catch (error) {
    endCapture(active)
    throw error
  }
}

export async function feedVoiceStream(owner: string, streamId: string, samples: Float32Array): Promise<VoicePartial> {
  const active = ownedCapture(owner, streamId)
  if (active.feeding) throw new Error('Voice stream is still processing its previous chunk')
  if (active.samples + samples.length > MAX_VOICE_SAMPLES) throw new Error('Voice recording exceeds the 60 minute limit')
  active.samples += samples.length
  active.feeding = true
  touchCapture(active)
  try {
    const result = await active.worker.request('feed', samples)
    if (result.error) throw new Error(result.error)
    return { stable: result.stable, tentative: result.tentative }
  } finally {
    active.feeding = false
    if (capture === active) touchCapture(active)
  }
}

export async function finishVoiceStream(owner: string, streamId: string): Promise<VoiceTranscript> {
  const active = ownedCapture(owner, streamId)
  if (active.feeding) throw new Error('Voice stream is still processing its previous chunk')
  const startedAt = Date.now()
  let success = false
  active.finishing = true
  clearTimeout(active.timer)
  try {
    const result = await active.worker.request('finish', undefined, transcriptionRequestTimeoutMs(active.samples))
    success = !result.error
    return { error: result.error, transcript: result.transcript }
  } finally {
    recordOtelDuration('transcribe_audio', Date.now() - startedAt, { backend: 'Parakeet GGUF Q8', success, source: 'stream' })
    endCapture(active)
  }
}

export function cancelVoiceStream(owner: string, streamId: string): void {
  const active = ownedCapture(owner, streamId, true)
  // Stop immediately, including a native feed currently in progress.
  active.worker.stop()
  if (worker === active.worker) worker = null
  endCapture(active)
}

export async function transcribeAudio(samples: Float32Array, options?: VoiceTranscriptionOptions): Promise<VoiceTranscript> {
  const startedAt = Date.now()
  let success = false
  if (!samples.length) return { error: 'Voice recording contains no audio', transcript: null }
  if (samples.length > MAX_VOICE_SAMPLES) return { error: 'Voice recording exceeds the 60 minute limit', transcript: null }
  if (batchBusy || capture) return { error: 'Voice transcription is already in progress', transcript: null }
  batchBusy = true
  try {
    await requireModel()
    const result = await ensureWorker().request('batch', samples, transcriptionRequestTimeoutMs(samples.length), voiceTranscriptionOptionsSchema.optional().parse(options)?.vocabulary)
    success = !result.error
    return { error: result.error, transcript: result.transcript }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), transcript: null }
  } finally {
    batchBusy = false
    recordOtelDuration('transcribe_audio', Date.now() - startedAt, { backend: 'Parakeet GGUF Q8', success, source: 'offline' })
    scheduleIdleStop()
  }
}

export function disposeTranscription(): void {
  for (const timer of warmClients.values()) clearTimeout(timer)
  warmClients.clear()
  clearIdleTimer()
  worker?.stop()
  worker = null
  if (capture) endCapture(capture)
}

app.once('will-quit', disposeTranscription)
