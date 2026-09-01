import { existsSync } from 'fs'
import { join } from 'path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { createLogger } from '../logger'
import { ensureParakeetModel, getVoiceModelStatus, isParakeetModelReady } from '../model-downloader'

const log = createLogger('main', 'transcription/index.ts')
const WORKER_PATH = join(__dirname, 'transcription-worker.js')
const BACKEND = 'Parakeet ONNX INT8'

type PhaseMetrics = Record<string, number>

type WorkerResponse =
  | { id: number; type: 'result'; transcript: string; phaseMs: PhaseMetrics }
  | { id: number; type: 'error'; message: string; phaseMs: PhaseMetrics }
  | { type: 'warmup-done'; ms: number }
  | { type: 'warmup-error'; message: string }

type PendingTranscription = {
  samplesLength: number
  startedAt: number
  resolve: (value: { error: string | null; transcript: string | null }) => void
}

let worker: UtilityProcess | null = null
let nextRequestId = 1
let warmupResolve: ((value: void) => void) | null = null
let pending = new Map<number, PendingTranscription>()

function ensureWorker(): UtilityProcess {
  if (worker) return worker
  if (!existsSync(WORKER_PATH)) {
    log.warn(`Transcription worker entry not found at ${WORKER_PATH}`)
  }
  const child = utilityProcess.fork(WORKER_PATH, [], { serviceName: 'solus-transcription' })
  child.on('message', (message) => handleWorkerMessage(message as WorkerResponse))
  child.once('exit', (code) => {
    const err = `Transcription worker exited with code ${code}`
    log.warn(err)
    for (const [id, request] of pending) {
      pending.delete(id)
      log.metric('transcribe audio', Date.now() - request.startedAt, { backend: BACKEND, success: false })
      request.resolve({ error: `Transcription failed: ${err}`, transcript: null })
    }
    warmupResolve?.()
    warmupResolve = null
    if (worker === child) worker = null
  })
  worker = child
  return child
}

function handleWorkerMessage(message: WorkerResponse): void {
  if (message.type === 'warmup-done') {
    log.metric('warmup transcription', message.ms, { success: true })
    warmupResolve?.()
    warmupResolve = null
    return
  }
  if (message.type === 'warmup-error') {
    log.warn(`Transcription warmup failed: ${message.message}`)
    warmupResolve?.()
    warmupResolve = null
    return
  }
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  const durationMs = Date.now() - request.startedAt
  const success = message.type === 'result'
  log.metric('transcribe audio', durationMs, {
    ...message.phaseMs,
    audio_duration_ms: Math.round(request.samplesLength / 16),
    speedup_x: durationMs > 0 ? Math.round((request.samplesLength / 16) / durationMs * 10) / 10 : null,
    backend: BACKEND,
    success,
  })
  if (message.type === 'result') {
    request.resolve({ error: null, transcript: message.transcript })
  } else {
    log.error(`Transcription error: ${message.message}`)
    request.resolve({ error: `Transcription failed: ${message.message}`, transcript: null })
  }
}

function modelNotReadyMessage(): string {
  const status = getVoiceModelStatus()
  if (status.state === 'downloading' && status.receivedBytes !== undefined && status.totalBytes) {
    const pct = Math.max(0, Math.min(99, Math.round(status.receivedBytes / status.totalBytes * 100)))
    return `Voice model is still downloading (${pct}%)`
  }
  if (status.state === 'error') return `Voice model failed to download: ${status.error ?? 'Unknown error'}`
  return 'Voice model is still preparing'
}

export async function warmupTranscription(): Promise<void> {
  try {
    await ensureParakeetModel()
    await new Promise<void>((resolve) => {
      warmupResolve = resolve
      ensureWorker().postMessage({ type: 'warmup' })
    })
  } catch (err: any) {
    log.warn(`Transcription warmup failed: ${err.message}`)
  }
}

export async function transcribeAudio(samples: Float32Array): Promise<{ error: string | null; transcript: string | null }> {
  const startedAt = Date.now()
  if (!(await isParakeetModelReady())) {
    void ensureParakeetModel().catch(() => {})
    const error = modelNotReadyMessage()
    log.metric('transcribe audio', Date.now() - startedAt, { backend: BACKEND, success: false })
    return { error, transcript: null }
  }

  await ensureParakeetModel()
  return new Promise((resolve) => {
    const id = nextRequestId++
    pending.set(id, { samplesLength: samples.length, startedAt, resolve })
    ensureWorker().postMessage({ id, type: 'transcribe', samples })
  })
}
