import { afterAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { Provider, RepoRef } from '@solus/server/providers/types'
import type { AgentToolContext } from '@solus/server/agents/tools/agent-tool'
import type {
  BrowserEmulation,
  BrowserFrameListener,
  BrowserRecordingEncoder,
  BrowserScreencastOptions,
  BrowserSurfaceDriver,
} from '@solus/server/browser/surface-driver'
import type { BrowserConsoleEntry, BrowserNetworkEntry } from '@solus/contracts/browser-types'

/**
 * The agent's recording verbs, end to end on the host: stop saves an MP4,
 * shows it in the conversation whatever the model writes, and files it where
 * the agent asked. A pull request gets the video as an uploaded attachment on
 * its own line, because that is the only form GitHub plays.
 */

// Evidence reaches the task domain, which opens the production database
// module (node:sqlite is absent under Bun's test runtime).
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'widgets' }
const realGitHelpers = await import('@solus/server/git/git-helpers')
mock.module('@solus/server/git/git-helpers', () => ({ ...realGitHelpers, resolveRepoRef: async () => repo }))

const published: string[] = []
const comments: { number: number; body: string }[] = []
const PUBLISHED_URL = 'https://github.com/user-attachments/assets/0f0e'
const provider = {
  auth: { hasCredential: async () => true },
  review: {
    publishAsset: async (_repo: RepoRef, assetId: string) => {
      published.push(assetId)
      return PUBLISHED_URL
    },
    addIssueComment: async (_repo: RepoRef, number: number, body: string) => {
      comments.push({ number, body })
    },
  },
} as unknown as Provider
const realProviders = await import('@solus/server/providers/registry')
mock.module('@solus/server/providers/registry', () => ({ ...realProviders, providerForRepo: () => provider }))

const dataDir = mkdtempSync(join(tmpdir(), 'solus-recording-tools-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = dataDir

const { initBrowserRegistry } = await import('@solus/server/browser/browser-registry')
const { initBrowserRecorder } = await import('@solus/server/browser/browser-recorder')
const { recordingRetention, UNFILED_RECORDING_TTL_MS } = await import('@solus/server/browser/recording-retention')
const surface = await import('@solus/server/browser/surface-driver')
const tools = await import('@solus/server/browser/browser-tools')

afterAll(() => {
  surface.setBrowserWebviewHost(null)
  surface.setBrowserRecordingEncoderHost(null)
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

class FakeDriver implements BrowserSurfaceDriver {
  readonly kind = 'webview' as const
  private frameListener: BrowserFrameListener | null = null
  async applyEmulation(_emulation: BrowserEmulation): Promise<void> {}
  async navigate(): Promise<void> {}
  async captureScreenshot(): Promise<string> {
    return 'data:image/png;base64,AAAA'
  }
  async evaluate(): Promise<string> {
    return 'null'
  }
  async clickAt(): Promise<void> {}
  async insertText(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async scrollAt(): Promise<void> {}
  async startScreencast(_options: BrowserScreencastOptions, onFrame: BrowserFrameListener): Promise<void> {
    this.frameListener = onFrame
  }
  async stopScreencast(): Promise<void> {
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

let encoderCount = 0
function fakeEncoder(): BrowserRecordingEncoder {
  // A distinct MP4-shaped payload per recording, so each stop stores its own asset.
  const run = ++encoderCount
  return {
    frame: async () => ({ recordedBytes: 0 }),
    finish: async () => new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70, run]),
    dispose: async () => {},
  }
}

function context(emitted: NormalizedEvent[]): AgentToolContext {
  return {
    provider: 'claude-code',
    cwd: '/repo/wt',
    sessionId: () => undefined,
    solusSessionId: () => 'session-1',
    abortSignal: new AbortController().signal,
    parentToolUseId: () => undefined,
    emit: (event) => emitted.push(event),
  }
}

async function recordingPage(): Promise<string> {
  const driver = new FakeDriver()
  surface.setBrowserWebviewHost({ attach: async () => driver })
  surface.setBrowserRecordingEncoderHost({ open: async () => fakeEncoder() })
  const registry = initBrowserRegistry({ pageChanged: () => {}, pageClosed: () => {}, surfaceRequested: () => {} })
  initBrowserRecorder(registry)
  const page = registry.open({ target: { kind: 'url', url: 'http://localhost:5173/' } })
  await registry.attachSurface(page.browserPageId, 1)
  return page.browserPageId
}

describe('browser recording tools', () => {
  test('stop files the recording on a pull request as a playable video and shows it in the conversation', async () => {
    const browserPageId = await recordingPage()
    const emitted: NormalizedEvent[] = []
    const start = await tools.browserRecordStartAgentTool.execute({ browserPageId }, context(emitted))
    expect(start.ok).toBe(true)

    const stop = await tools.browserRecordStopAgentTool.execute(
      { browserPageId, attach_to_pr_number: 42, caption: 'The menu opens' },
      context(emitted),
    )
    expect(stop.ok).toBe(true)

    const captured = emitted.find((event) => event.type === 'browser_recording_captured')
    if (captured?.type !== 'browser_recording_captured') throw new Error('no recording event')
    const { recording } = captured
    expect(recording.assetId).toMatch(/\.mp4$/)
    expect(existsSync(recording.hostPath)).toBe(true)
    // The agent can paste the line to show the video in its reply.
    expect(stop.text).toContain(`![The menu opens](${recording.hostPath})`)

    expect(published).toEqual([recording.assetId])
    // A bare URL on its own line is what GitHub renders as a player.
    expect(comments).toEqual([{ number: 42, body: `${PUBLISHED_URL}\n\nThe menu opens` }])
    expect(stop.text).toContain('Filed on pull request #42')

    // Filed recordings are kept by the retention sweep.
    const deleted = await recordingRetention().sweep(Date.now() + 2 * UNFILED_RECORDING_TTL_MS)
    expect(deleted).not.toContain(recording.assetId)
    expect(existsSync(recording.hostPath)).toBe(true)
  })

  test('a filing failure does not fail the stop, and the recording stays unfiled', async () => {
    const browserPageId = await recordingPage()
    const emitted: NormalizedEvent[] = []
    await tools.browserRecordStartAgentTool.execute({ browserPageId }, context(emitted))
    const failing = provider.review.publishAsset
    provider.review.publishAsset = async () => {
      throw new Error('GitHub refused the video: it is larger than 10 MB')
    }
    try {
      const stop = await tools.browserRecordStopAgentTool.execute(
        { browserPageId, attach_to_pr_number: 7 },
        context(emitted),
      )
      expect(stop.ok).toBe(true)
      expect(stop.text).toContain('stored but not filed: GitHub refused the video')
      const captured = emitted.find((event) => event.type === 'browser_recording_captured')
      if (captured?.type !== 'browser_recording_captured') throw new Error('no recording event')
      const deleted = await recordingRetention().sweep(Date.now() + 2 * UNFILED_RECORDING_TTL_MS)
      expect(deleted).toContain(captured.recording.assetId)
    } finally {
      provider.review.publishAsset = failing
    }
  })
})
