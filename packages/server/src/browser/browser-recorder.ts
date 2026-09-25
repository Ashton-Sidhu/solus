import {
  snapshotViewportLabel,
  type BrowserPage,
  type BrowserRecordingRef,
  type BrowserRecordingState,
} from '@solus/contracts/browser-types'
import { MAX_VIDEO_UPLOAD_BYTES } from '@solus/contracts/video'
import { createLogger } from '../logger'
import { writeAssetBytes } from '../server/assets'
import { storedAssetPath } from '../server/asset-paths'
import { recordingScreencastOptions, type BrowserRegistry } from './browser-registry'
import { recordingRetention } from './recording-retention'
import {
  browserRecordingEncoderHost,
  type BrowserRecordingEncoder,
  type BrowserRecordingEncoderHost,
  type BrowserRecordingSize,
} from './surface-driver'

/**
 * Browser recordings: one MP4 of one page, made on the host.
 *
 * A recording is a server-side frame watcher on the page (see
 * `BrowserRegistry.attachRecorder`), so the user, a phone, and an agent all
 * record the same way, and a recording continues when the page moves between
 * hosts. Each frame goes to the recording encoder, a Chromium page that owns
 * `MediaRecorder`. The finished MP4 goes into the asset store, where a task, a
 * pull request, or a prompt can use it.
 */

const log = createLogger('browser', 'browser-recorder.ts')

export const RECORDING_MAX_DURATION_MS = 5 * 60 * 1000

/**
 * The size limit, less room for what the encoder has not reported yet.
 *
 * The encoder reports its size once a second, and stopping flushes the last
 * second. At the encoder's 1.2 Mbit/s ceiling a second is 150 KB; 2 MB is room
 * for rate control overshooting that many times over.
 */
const SIZE_LIMIT_BYTES = MAX_VIDEO_UPLOAD_BYTES - 2 * 1024 * 1024

type StoppedBy = NonNullable<BrowserRecordingRef['stoppedBy']>

interface ActiveRecording {
  browserPageId: string
  /** The live page object. Kept after a close, so the file still names it. */
  page: BrowserPage
  state: BrowserRecordingState
  encoder: BrowserRecordingEncoder
  /** Only the newest frame waits. A frame the encoder is too slow for is
   *  replaced, not queued, so a slow encoder costs smoothness, not memory. */
  pending: Uint8Array | null
  pumping: Promise<void> | null
  cancelLimit: () => void
  stopping: Promise<BrowserRecordingRef> | null
}

export interface BrowserRecorderDeps {
  registry: BrowserRegistry
  encoderHost?: () => BrowserRecordingEncoderHost | null
  store?: (bytes: Buffer) => Promise<{ id: string; size: number }>
  onStored?: (assetId: string, createdAt: number) => Promise<void>
  now?: () => number
  /** Runs `run` after `ms`, and returns how to cancel it. */
  schedule?: (run: () => void, ms: number) => () => void
}

export class BrowserRecorder {
  private readonly active = new Map<string, ActiveRecording>()
  private readonly starting = new Map<string, Promise<BrowserRecordingState>>()
  /** Recordings a limit or a close ended. The next stop returns the file, so
   *  the user or agent who started it still gets it. */
  private readonly ended = new Map<string, Promise<BrowserRecordingRef>>()
  private readonly registry: BrowserRegistry
  private readonly encoderHost: () => BrowserRecordingEncoderHost | null
  private readonly store: (bytes: Buffer) => Promise<{ id: string; size: number }>
  private readonly onStored: (assetId: string, createdAt: number) => Promise<void>
  private readonly now: () => number
  private readonly schedule: (run: () => void, ms: number) => () => void

  constructor(deps: BrowserRecorderDeps) {
    this.registry = deps.registry
    this.encoderHost = deps.encoderHost ?? browserRecordingEncoderHost
    this.store = deps.store ?? ((bytes) => writeAssetBytes(bytes, 'mp4'))
    this.onStored = deps.onStored ?? ((assetId, createdAt) => recordingRetention().noteRecording(assetId, createdAt))
    this.now = deps.now ?? Date.now
    this.schedule = deps.schedule ?? ((run, ms) => {
      const timer = setTimeout(run, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
  }

  /** Start recording a page. Idempotent: a page already recording keeps its
   *  recording, and the caller gets its state. */
  async start(browserPageId: string, startedBy: BrowserRecordingState['startedBy']): Promise<BrowserRecordingState> {
    const pending = this.starting.get(browserPageId)
    if (pending) return pending
    const existing = this.active.get(browserPageId)
    if (existing && !existing.stopping) return existing.state
    const starting = this.begin(browserPageId, startedBy, existing?.stopping ?? null)
    this.starting.set(browserPageId, starting)
    try {
      return await starting
    } finally {
      this.starting.delete(browserPageId)
    }
  }

  private async begin(
    browserPageId: string,
    startedBy: BrowserRecordingState['startedBy'],
    previous: Promise<BrowserRecordingRef> | null,
  ): Promise<BrowserRecordingState> {
    // The last recording of this page is still being saved. A new one starts
    // after it, so the two never share the page's stream.
    if (previous) await previous.catch(() => {})
    const page = this.registry.get(browserPageId)
    if (!page) throw new Error(`No browser page ${browserPageId}`)
    const host = this.encoderHost()
    if (!host) {
      throw new Error(
        'This host cannot record browser pages: it has no Chromium for the recording encoder. '
        + 'Install the browser runtime on this host.',
      )
    }
    const encoder = await host.open(recordingSize(page))
    const state: BrowserRecordingState = { startedAt: this.now(), startedBy }
    const recording: ActiveRecording = {
      browserPageId,
      page,
      state,
      encoder,
      pending: null,
      pumping: null,
      cancelLimit: () => {},
      stopping: null,
    }
    this.active.set(browserPageId, recording)
    this.ended.delete(browserPageId)
    try {
      await this.registry.attachRecorder(browserPageId, state, {
        frame: (jpeg) => this.onFrame(recording, jpeg),
        pageClosing: () => { this.stopForLimit(recording, 'page-closed') },
      })
    } catch (error) {
      this.active.delete(browserPageId)
      await encoder.dispose().catch(() => {})
      throw error
    }
    if (!recording.stopping) {
      recording.cancelLimit = this.schedule(
        () => this.stopForLimit(recording, 'duration-limit'),
        RECORDING_MAX_DURATION_MS,
      )
    }
    log.info('browser_recording_started', { browserPageId, startedBy })
    return state
  }

  /**
   * Stop and save. A page whose recording a limit or a close already ended
   * answers with that recording, once.
   */
  stop(browserPageId: string): Promise<BrowserRecordingRef> {
    const recording = this.active.get(browserPageId)
    if (recording) {
      // A limit that is still saving answers here, so it is not answered twice.
      this.ended.delete(browserPageId)
      // Publish the promise before detach emits pageChanged. A listener may
      // request the result from inside that event.
      recording.stopping ??= Promise.resolve().then(() => this.finish(recording, undefined))
      return recording.stopping
    }
    const ended = this.ended.get(browserPageId)
    if (ended) {
      this.ended.delete(browserPageId)
      return ended
    }
    const starting = this.starting.get(browserPageId)
    if (starting) return starting.then(() => this.stop(browserPageId))
    return Promise.reject(new Error(`Browser page ${browserPageId} is not recording.`))
  }

  private stopForLimit(recording: ActiveRecording, stoppedBy: StoppedBy): void {
    if (recording.stopping) return
    const stopping = Promise.resolve().then(() => this.finish(recording, stoppedBy))
    recording.stopping = stopping
    this.ended.set(recording.browserPageId, stopping)
    stopping.catch((error) => {
      log.warn('browser_recording_save_failed', {
        browserPageId: recording.browserPageId,
        stoppedBy,
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private onFrame(recording: ActiveRecording, jpeg: Uint8Array): void {
    if (recording.stopping) return
    recording.pending = jpeg
    recording.pumping ??= this.pump(recording)
  }

  private async pump(recording: ActiveRecording): Promise<void> {
    try {
      while (recording.pending && !recording.stopping) {
        const jpeg = recording.pending
        recording.pending = null
        try {
          const { recordedBytes } = await recording.encoder.frame(jpeg)
          if (recordedBytes >= SIZE_LIMIT_BYTES) this.stopForLimit(recording, 'size-limit')
        } catch (error) {
          // One frame that did not decode is a skipped frame, not a failed
          // recording.
          log.warn('browser_recording_frame_failed', {
            browserPageId: recording.browserPageId,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      recording.pumping = null
    }
  }

  private async finish(recording: ActiveRecording, stoppedBy: StoppedBy | undefined): Promise<BrowserRecordingRef> {
    const { browserPageId, page } = recording
    recording.cancelLimit()
    const endedAt = this.now()
    try {
      await this.registry.detachRecorder(browserPageId).catch((error) => {
        log.warn('browser_recording_detach_failed', {
          browserPageId,
          message: error instanceof Error ? error.message : String(error),
        })
      })
      await recording.pumping
      const bytes = await recording.encoder.finish()
      const stored = await this.store(Buffer.from(bytes))
      await this.onStored(stored.id, endedAt).catch((error) => {
        log.warn('browser_recording_index_failed', {
          browserPageId,
          message: error instanceof Error ? error.message : String(error),
        })
      })
      const ref: BrowserRecordingRef = {
        browserPageId,
        assetId: stored.id,
        hostPath: storedAssetPath(stored.id),
        url: page.url,
        title: page.title,
        viewport: snapshotViewportLabel(page.viewport),
        durationMs: endedAt - recording.state.startedAt,
        sizeBytes: stored.size,
        capturedAt: endedAt,
      }
      if (stoppedBy) ref.stoppedBy = stoppedBy
      log.info('browser_recording_saved', {
        browserPageId,
        assetId: stored.id,
        durationMs: ref.durationMs,
        sizeBytes: ref.sizeBytes,
        stoppedBy: stoppedBy ?? 'stop',
      })
      return ref
    } finally {
      await recording.encoder.dispose().catch(() => {})
      this.active.delete(browserPageId)
    }
  }
}

/** The encoder canvas: the recording caps, rounded to even numbers. */
function recordingSize(page: BrowserPage): BrowserRecordingSize {
  const caps = recordingScreencastOptions(page.viewport)
  return {
    width: Math.max(2, Math.round(caps.maxWidth / 2) * 2),
    height: Math.max(2, Math.round(caps.maxHeight / 2) * 2),
  }
}

let recorder: BrowserRecorder | null = null

/** One recorder per host, beside the one registry. */
export function initBrowserRecorder(registry: BrowserRegistry): BrowserRecorder {
  recorder = new BrowserRecorder({ registry })
  return recorder
}

export function browserRecorder(): BrowserRecorder {
  if (!recorder) throw new Error('Browser recording is not available on this host.')
  return recorder
}
