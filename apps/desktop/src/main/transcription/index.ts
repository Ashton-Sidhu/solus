import { existsSync } from 'fs'
import { join } from 'path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { MAX_VOICE_SAMPLES } from '@solus/contracts/voice-audio'
import { createLogger } from '@solus/server/logger'
import { ensureParakeetModel, getVoiceModelStatus, isParakeetModelReady } from '@solus/server/model-downloader'

const log = createLogger('main', 'transcription/index.ts')
const WORKER_PATH = join(__dirname, 'transcription-worker.js')
const BACKEND = 'Parakeet ONNX INT8'

type PhaseMetrics = Record<string, number>

type WorkerResponse =
  | { id: number; type: 'result'; transcript: string; phaseMs: PhaseMetrics }
  | { id: number; type: 'error'; message: string; phaseMs: PhaseMetrics }

type PendingTranscription = {
  worker: UtilityProcess
  samplesLength: number
  startedAt: number
  timer: ReturnType<typeof setTimeout>
  resolve: (value: { error: string | null; transcript: string | null }) => void
}

let worker: UtilityProcess | null = null
let nextRequestId = 1
let pending = new Map<number, PendingTranscription>()
let workerIdleTimer: ReturnType<typeof setTimeout> | null = null
const idleStoppingWorkers = new Set<UtilityProcess>()

// ONNX keeps roughly the entire model resident inside the utility process.
// Keep it warm across a short dictation burst, then release it instead of
// charging every subsequent idle hour for a feature that may not be used again.
export const TRANSCRIPTION_WORKER_IDLE_MS = 2 * 60_000
const TRANSCRIPTION_TIMEOUT_MIN_MS = 2 * 60_000
const TRANSCRIPTION_TIMEOUT_MAX_MS = 30 * 60_000

export function transcriptionRequestTimeoutMs(samplesLength: number): number {
  const audioDurationMs = samplesLength / 16
  return Math.max(
    TRANSCRIPTION_TIMEOUT_MIN_MS,
    Math.min(TRANSCRIPTION_TIMEOUT_MAX_MS, audioDurationMs * 2),
  )
}

function clearWorkerIdleTimer(): void {
  if (!workerIdleTimer) return
  clearTimeout(workerIdleTimer)
  workerIdleTimer = null
}

function scheduleWorkerIdleStop(): void {
  clearWorkerIdleTimer()
  if (!worker || pending.size > 0) return
  workerIdleTimer = setTimeout(() => {
    workerIdleTimer = null
    if (!worker || pending.size > 0) return
    const idleWorker = worker
    idleStoppingWorkers.add(idleWorker)
    if (!idleWorker.kill()) {
      idleStoppingWorkers.delete(idleWorker)
      log.warn('transcription_worker_idle_stop_failed')
      scheduleWorkerIdleStop()
      return
    }
    // Detach only after the process accepted the stop request. A new request
    // may now start a successor while this generation finishes exiting.
    if (worker === idleWorker) worker = null
    log.info('transcription_worker_stopped_idle')
  }, TRANSCRIPTION_WORKER_IDLE_MS)
  workerIdleTimer.unref?.()
}

function ensureWorker(): UtilityProcess {
  clearWorkerIdleTimer()
  if (worker) return worker
  if (!existsSync(WORKER_PATH)) {
    log.warn('transcription_worker_entry_missing', { workerPath: WORKER_PATH })
  }
  const child = utilityProcess.fork(WORKER_PATH, [], { serviceName: 'solus-transcription' })
  // SAFETY: this utility process runs our worker entry, whose only messages implement WorkerResponse.
  child.on('message', (message) => handleWorkerMessage(child, message as WorkerResponse))
  child.once('exit', (code) => {
    const stoppedForIdle = idleStoppingWorkers.delete(child)
    if (!stoppedForIdle) log.warn('transcription_worker_exited', { code })
    for (const [id, request] of pending) {
      if (request.worker !== child) continue
      pending.delete(id)
      clearTimeout(request.timer)
      log.metric('transcribe_audio', Date.now() - request.startedAt, { backend: BACKEND, success: false })
      request.resolve({ error: `Transcription stopped unexpectedly (exit code ${code})`, transcript: null })
    }
    if (worker === child) {
      clearWorkerIdleTimer()
      worker = null
    }
  })
  worker = child
  return child
}

function handleWorkerMessage(sourceWorker: UtilityProcess, message: WorkerResponse): void {
  const request = pending.get(message.id)
  if (!request || request.worker !== sourceWorker) return
  pending.delete(message.id)
  clearTimeout(request.timer)
  const durationMs = Date.now() - request.startedAt
  const success = message.type === 'result'
  log.metric('transcribe_audio', durationMs, {
    ...message.phaseMs,
    audio_duration_ms: Math.round(request.samplesLength / 16),
    speedup_x: durationMs > 0 ? Math.round((request.samplesLength / 16) / durationMs * 10) / 10 : null,
    backend: BACKEND,
    success,
  })
  if (message.type === 'result') {
    request.resolve({ error: null, transcript: message.transcript })
  } else {
    log.error('transcription_failed', { error: message.message })
    request.resolve({ error: `Transcription failed: ${message.message}`, transcript: null })
  }
  scheduleWorkerIdleStop()
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

/** Prepare/download the model without loading ONNX sessions into memory. */
export async function prepareTranscriptionModel(): Promise<void> {
  try {
    await ensureParakeetModel()
  } catch (err: any) {
    log.warn('transcription_model_prepare_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Fork the worker and load its ONNX sessions ahead of the transcription that
 * follows a recording. Called at record start so the ~1s model load overlaps
 * the recording instead of adding to post-stop latency.
 */
export async function warmTranscription(): Promise<void> {
  if (pending.size > 0) return
  if (!(await isParakeetModelReady())) {
    void ensureParakeetModel().catch(() => {})
    return
  }
  const transcriptionWorker = ensureWorker()
  try {
    transcriptionWorker.postMessage({ id: 0, type: 'warm' })
  } catch {
    return
  }
  log.info('transcription_worker_warmed')
  scheduleWorkerIdleStop()
}

export async function transcribeAudio(samples: Float32Array): Promise<{ error: string | null; transcript: string | null }> {
  const startedAt = Date.now()
  if (samples.length === 0) {
    return { error: 'Voice recording contains no audio', transcript: null }
  }
  if (samples.length > MAX_VOICE_SAMPLES) {
    return { error: 'Voice recording exceeds the 60 minute limit', transcript: null }
  }
  if (!(await isParakeetModelReady())) {
    void ensureParakeetModel().catch(() => {})
    const error = modelNotReadyMessage()
    log.metric('transcribe_audio', Date.now() - startedAt, { backend: BACKEND, success: false })
    return { error, transcript: null }
  }

  await ensureParakeetModel()
  if (pending.size > 0) {
    return { error: 'Voice transcription is already in progress', transcript: null }
  }
  return new Promise((resolve) => {
    const id = nextRequestId++
    const transcriptionWorker = ensureWorker()
    const timer = setTimeout(() => {
      const request = pending.get(id)
      if (!request || request.worker !== transcriptionWorker) return
      pending.delete(id)
      log.metric('transcribe_audio', Date.now() - request.startedAt, {
        backend: BACKEND,
        success: false,
        timeout: true,
      })
      request.resolve({ error: 'Transcription timed out', transcript: null })
      if (worker === transcriptionWorker) {
        clearWorkerIdleTimer()
        if (transcriptionWorker.kill()) worker = null
        else {
          log.warn('transcription_worker_timeout_stop_failed')
          scheduleWorkerIdleStop()
        }
      }
    }, transcriptionRequestTimeoutMs(samples.length))
    timer.unref?.()
    pending.set(id, { worker: transcriptionWorker, samplesLength: samples.length, startedAt, timer, resolve })
    try {
      transcriptionWorker.postMessage({ id, type: 'transcribe', samples })
    } catch (err) {
      pending.delete(id)
      clearTimeout(timer)
      scheduleWorkerIdleStop()
      resolve({
        error: `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
        transcript: null,
      })
    }
  })
}
