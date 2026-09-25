import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initBrowserRegistry, type BrowserEventSink } from '@solus/server/browser/browser-registry'
import { BrowserFrameChannel } from '@solus/server/browser/browser-frame-channel'
import { BrowserRecorder } from '@solus/server/browser/browser-recorder'
import { RecordingRetention, UNFILED_RECORDING_TTL_MS } from '@solus/server/browser/recording-retention'
import {
  setBrowserWebviewHost,
  type BrowserEmulation,
  type BrowserFrameListener,
  type BrowserRecordingEncoder,
  type BrowserRecordingSize,
  type BrowserScreencastOptions,
  type BrowserSurfaceDriver,
} from '@solus/server/browser/surface-driver'
import type { BrowserConsoleEntry, BrowserNetworkEntry, BrowserPage } from '@solus/contracts/browser-types'
import { MAX_VIDEO_UPLOAD_BYTES } from '@solus/contracts/video'

/**
 * Recordings are a frame watcher the host holds on a page. These tests pin the
 * rules that make that safe: a recording keeps the stream alive when every
 * client leaves, survives the page moving to another host, and is saved — not
 * lost — when a limit or a close ends it.
 */

class FakeDriver implements BrowserSurfaceDriver {
  readonly kind = 'webview' as const
  screencasts: BrowserScreencastOptions[] = []
  screencastStops = 0
  evaluated: string[] = []
  private frameListener: BrowserFrameListener | null = null

  async applyEmulation(_emulation: BrowserEmulation): Promise<void> {}
  async navigate(): Promise<void> {}
  async captureScreenshot(): Promise<string> {
    return 'data:image/png;base64,AAAA'
  }
  async evaluate(expression: string): Promise<string> {
    this.evaluated.push(expression)
    return 'null'
  }
  async clickAt(): Promise<void> {}
  async insertText(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async scrollAt(): Promise<void> {}
  async startScreencast(options: BrowserScreencastOptions, onFrame: BrowserFrameListener): Promise<void> {
    this.screencasts.push(options)
    this.frameListener = onFrame
  }
  async stopScreencast(): Promise<void> {
    this.screencastStops += 1
    this.frameListener = null
  }
  emitFrame(bytes: Uint8Array): void {
    this.frameListener?.(bytes)
  }
  async openDevTools(): Promise<void> {}
  consoleEntries(): BrowserConsoleEntry[] {
    return []
  }
  networkEntries(): BrowserNetworkEntry[] {
    return []
  }
  async dispose(): Promise<void> {}
}

class FakeEncoder implements BrowserRecordingEncoder {
  frames: Uint8Array[] = []
  /** What the encoder reports it has written so far. */
  recordedBytes = 0
  finished = false
  disposed = false

  constructor(readonly size: BrowserRecordingSize) {}

  async frame(jpeg: Uint8Array): Promise<{ recordedBytes: number }> {
    this.frames.push(jpeg)
    return { recordedBytes: this.recordedBytes }
  }
  async finish(): Promise<Uint8Array> {
    this.finished = true
    return new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70, ...this.frames.map((frame) => frame[0] ?? 0)])
  }
  async dispose(): Promise<void> {
    this.disposed = true
  }
}

/** Let the frame pump run. Drains queued work; waits for no clock. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

const TARGET = { kind: 'url', url: 'http://localhost:5173/' } as const
const OVERLAY = '__solusRecordingOverlay'

function harness(options: { frames?: boolean; pageChanged?: (page: BrowserPage) => void; onStored?: () => Promise<void> } = {}) {
  const published: BrowserPage[] = []
  const sink: BrowserEventSink = {
    pageChanged: (page) => {
      published.push(structuredClone(page))
      options.pageChanged?.(page)
    },
    pageClosed: () => {},
    surfaceRequested: () => {},
  }
  const driver = new FakeDriver()
  const otherDriver = new FakeDriver()
  setBrowserWebviewHost({ attach: async (webContentsId) => (webContentsId === 2 ? otherDriver : driver) })
  const frames = options.frames === false ? null : new BrowserFrameChannel()
  const registry = initBrowserRegistry(sink, frames)
  const encoders: FakeEncoder[] = []
  const stored: { id: string; bytes: Buffer }[] = []
  const limits: { run: () => void; ms: number; cancelled: boolean }[] = []
  let clock = 1_000
  const recorder = new BrowserRecorder({
    registry,
    encoderHost: () => ({
      open: async (size) => {
        const encoder = new FakeEncoder(size)
        encoders.push(encoder)
        return encoder
      },
    }),
    store: async (bytes) => {
      const id = `${String(stored.length).padStart(64, 'a')}.mp4`
      stored.push({ id, bytes })
      return { id, size: bytes.length }
    },
    onStored: options.onStored ?? (async () => {}),
    now: () => clock,
    schedule: (run, ms) => {
      const limit = { run, ms, cancelled: false }
      limits.push(limit)
      return () => { limit.cancelled = true }
    },
  })
  return {
    registry,
    recorder,
    driver,
    otherDriver,
    frames,
    published,
    encoders,
    stored,
    limits,
    advance: (ms: number) => { clock += ms },
  }
}

afterEach(() => {
  setBrowserWebviewHost(null)
})

describe('browser recorder', () => {
  test('a stop requested during encoder startup waits and saves that recording', async () => {
    const { registry, recorder, stored } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    const starting = recorder.start(page.browserPageId, 'user')
    const stopping = recorder.stop(page.browserPageId)
    await starting
    await stopping
    expect(stored).toHaveLength(1)
    expect(registry.get(page.browserPageId)?.recording).toBeNull()
  })

  test('an encoder failure releases the page so recording can be retried', async () => {
    const { registry, recorder, encoders } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await recorder.start(page.browserPageId, 'user')
    encoders[0]!.finish = async () => { throw new Error('encoder failed') }
    await expect(recorder.stop(page.browserPageId)).rejects.toThrow('encoder failed')
    expect(encoders[0]!.disposed).toBe(true)
    await recorder.start(page.browserPageId, 'user')
    await recorder.stop(page.browserPageId)
    expect(encoders).toHaveLength(2)
  })

  test('a client collecting the ended recording during pageChanged shares the save', async () => {
    const collected: Promise<unknown>[] = []
    const { registry, recorder, stored, limits } = harness({
      pageChanged: (page) => {
        if (page.recording === null) collected.push(recorder.stop(page.browserPageId))
      },
    })
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await recorder.start(page.browserPageId, 'user')
    limits[0]!.run()
    await settle()
    await Promise.all(collected)
    expect(collected).toHaveLength(1)
    expect(stored).toHaveLength(1)
  })

  test('stop remains available and a new start waits until storage completes', async () => {
    const storage = Promise.withResolvers<void>()
    const { registry, recorder, encoders } = harness({ onStored: () => storage.promise })
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await recorder.start(page.browserPageId, 'user')
    const stopped = recorder.stop(page.browserPageId)
    await settle()
    expect(recorder.stop(page.browserPageId)).toBe(stopped)
    const restarted = recorder.start(page.browserPageId, 'user')
    await settle()
    expect(encoders).toHaveLength(1)
    storage.resolve()
    await stopped
    await restarted
    expect(encoders).toHaveLength(2)
    await recorder.stop(page.browserPageId)
  })

  test('the duration limit stops and saves the recording, and says why', async () => {
    // WHY: five minutes of someone's work must not be discarded because it
    // reached the limit. The file is kept and marked, so the caller can tell.
    const { registry, recorder, driver, encoders, limits, published, advance } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await recorder.start(page.browserPageId, 'user')
    expect(limits[0]?.ms).toBe(5 * 60 * 1000)

    driver.emitFrame(new Uint8Array([7]))
    await settle()
    advance(300_000)
    limits[0]!.run()

    const recording = await recorder.stop(page.browserPageId)
    expect(recording.stoppedBy).toBe('duration-limit')
    expect(recording.durationMs).toBe(300_000)
    expect(encoders[0]!.finished).toBe(true)
    expect(encoders[0]!.frames).toHaveLength(1)
    // Every client learns the recording ended, not only the one that asks.
    expect(published.at(-1)?.recording).toBeNull()
    await expect(recorder.stop(page.browserPageId)).rejects.toThrow(/not recording/)
  })

  test('the size limit stops and saves before the file is too large to upload', async () => {
    const { registry, recorder, driver, encoders } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await recorder.start(page.browserPageId, 'agent')

    encoders[0]!.recordedBytes = MAX_VIDEO_UPLOAD_BYTES - 1024 * 1024
    driver.emitFrame(new Uint8Array([1]))
    await settle()

    expect(registry.get(page.browserPageId)?.recording).toBeNull()
    const recording = await recorder.stop(page.browserPageId)
    expect(recording.stoppedBy).toBe('size-limit')
    expect(encoders[0]!.disposed).toBe(true)
  })

  test('a host migration during a recording continues the same file', async () => {
    // WHY: the user closing the pane moves the page to another host. The
    // recording is of the page, not of the guest that happened to render it.
    const { registry, recorder, driver, otherDriver, encoders, stored } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await recorder.start(page.browserPageId, 'user')
    driver.emitFrame(new Uint8Array([1]))
    await settle()

    await registry.attachSurface(page.browserPageId, 2)
    expect(otherDriver.screencasts.at(-1)?.quality).toBe(80)
    otherDriver.emitFrame(new Uint8Array([2]))
    await settle()

    const recording = await recorder.stop(page.browserPageId)
    expect(encoders).toHaveLength(1)
    expect(encoders[0]!.frames.map((frame) => frame[0])).toEqual([1, 2])
    expect(stored).toHaveLength(1)
    expect(recording.assetId).toBe(stored[0]!.id)
  })

  test('the last client leaving does not stop a recording, and stopping it ends the stream', async () => {
    const { registry, recorder, driver, encoders } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await registry.subscribeFrames(page.browserPageId, 'phone')
    expect(driver.screencasts.at(-1)?.quality).toBe(60)

    await recorder.start(page.browserPageId, 'user')
    // Recording caps while recording: device pixels at a higher quality.
    expect(driver.screencasts.at(-1)?.quality).toBe(80)

    await registry.unsubscribeFrames(page.browserPageId, 'phone')
    expect(driver.screencastStops).toBe(0)
    driver.emitFrame(new Uint8Array([3]))
    await settle()
    expect(encoders[0]!.frames).toHaveLength(1)

    await recorder.stop(page.browserPageId)
    // Nobody watches now, so the page goes back to costing nothing.
    expect(driver.screencastStops).toBe(1)
  })

  test('a client still watching goes back to viewer caps when the recording stops', async () => {
    const { registry, recorder, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await registry.subscribeFrames(page.browserPageId, 'phone')
    await recorder.start(page.browserPageId, 'user')
    await recorder.stop(page.browserPageId)
    await settle()

    expect(driver.screencastStops).toBe(0)
    expect(driver.screencasts.at(-1)?.quality).toBe(60)
  })

  test('a host that cannot stream to clients can still record', async () => {
    const { registry, recorder, driver, encoders } = harness({ frames: false })
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await recorder.start(page.browserPageId, 'agent')
    driver.emitFrame(new Uint8Array([9]))
    await settle()

    await recorder.stop(page.browserPageId)
    expect(encoders[0]!.frames).toHaveLength(1)
  })

  test('starting twice keeps the one recording', async () => {
    // WHY: the user and an agent can both press record. A second recording
    // would need a second stream, which Chromium refuses.
    const { registry, recorder, encoders, published } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    const [first, second] = await Promise.all([
      recorder.start(page.browserPageId, 'user'),
      recorder.start(page.browserPageId, 'agent'),
    ])
    const third = await recorder.start(page.browserPageId, 'agent')

    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(first.startedBy).toBe('user')
    expect(encoders).toHaveLength(1)
    expect(published.at(-1)?.recording).toEqual(first)
  })

  test('closing the page stops and saves its recording', async () => {
    const { registry, recorder, driver, encoders } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await recorder.start(page.browserPageId, 'agent')
    driver.emitFrame(new Uint8Array([4]))
    await settle()

    await registry.close(page.browserPageId, { force: true })

    const recording = await recorder.stop(page.browserPageId)
    expect(recording.stoppedBy).toBe('page-closed')
    expect(recording.url).toBe(TARGET.url)
    expect(encoders[0]!.frames).toHaveLength(1)
    expect(encoders[0]!.disposed).toBe(true)
  })

  test('the input overlay is shown while recording and removed on stop', async () => {
    const { registry, recorder, driver } = harness()
    const page = registry.open({ target: TARGET })
    await registry.attachSurface(page.browserPageId, 1)
    await recorder.start(page.browserPageId, 'user')
    await settle()
    const shown = driver.evaluated.filter((expression) => expression.includes(OVERLAY))
    expect(shown).toHaveLength(1)
    expect(shown[0]).toContain('if (!true)')

    await recorder.stop(page.browserPageId)
    await settle()
    const all = driver.evaluated.filter((expression) => expression.includes(OVERLAY))
    expect(all).toHaveLength(2)
    expect(all[1]).toContain('if (!false)')
  })
})

describe('recording retention', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function asset(assetsDir: string, digit: string): string {
    const id = `${digit.repeat(64)}.mp4`
    writeFileSync(join(assetsDir, id), 'mp4')
    return id
  }

  test('a filed recording survives the sweep and an old unfiled one is deleted', async () => {
    // WHY: 50 MB videos nobody filed must not fill the disk, but a recording
    // on a task or a pull request is the durable evidence it was made to be.
    const root = mkdtempSync(join(tmpdir(), 'solus-recording-retention-'))
    directories.push(root)
    const statePath = join(root, 'state', 'browser-recordings.json')
    const assetsDir = root
    const retention = new RecordingRetention({ statePath, assetsDir })
    const filed = asset(assetsDir, 'a')
    const unfiled = asset(assetsDir, 'b')
    const recent = asset(assetsDir, 'c')
    const image = `${'d'.repeat(64)}.png`
    writeFileSync(join(assetsDir, image), 'png')

    await retention.noteRecording(filed, 0)
    await retention.noteRecording(unfiled, 0)
    await retention.noteRecording(recent, UNFILED_RECORDING_TTL_MS)
    await retention.markFiled(filed)

    const deleted = await retention.sweep(UNFILED_RECORDING_TTL_MS + 1)
    expect(deleted).toEqual([unfiled])
    expect(existsSync(join(assetsDir, unfiled))).toBe(false)
    expect(existsSync(join(assetsDir, filed))).toBe(true)
    expect(existsSync(join(assetsDir, recent))).toBe(true)
    // The sweep deletes only what the index names.
    expect(existsSync(join(assetsDir, image))).toBe(true)

    // The filed mark outlives the process.
    const restarted = new RecordingRetention({ statePath, assetsDir })
    expect(await restarted.sweep(10 * UNFILED_RECORDING_TTL_MS)).toEqual([recent])
    expect(existsSync(join(assetsDir, filed))).toBe(true)
  })

  test('a recording sent in a prompt is kept, and a path outside the asset store is ignored', async () => {
    // WHY: the transcript refers to a recording the user sent, so the sweep
    // must not delete it; a look-alike name elsewhere must not pin anything.
    const root = mkdtempSync(join(tmpdir(), 'solus-recording-retention-'))
    directories.push(root)
    const retention = new RecordingRetention({ statePath: join(root, 'state', 'index.json'), assetsDir: root })
    const sent = asset(root, 'e')
    const lookAlike = asset(root, 'f')
    await retention.noteRecording(sent, 0)
    await retention.noteRecording(lookAlike, 0)

    await retention.keepRecordingsSentIn(
      `[Attached file: ${join(root, sent)}]\n[Attached file: /tmp/elsewhere/${lookAlike}]\n\nWhy does this flicker?`,
    )

    expect(await retention.sweep(UNFILED_RECORDING_TTL_MS + 1)).toEqual([lookAlike])
    expect(existsSync(join(root, sent))).toBe(true)
  })
})
