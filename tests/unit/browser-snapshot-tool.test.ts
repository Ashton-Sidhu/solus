import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserConsoleEntry, BrowserNetworkEntry } from '@solus/contracts/browser-types'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { BrowserSurfaceDriver } from '@solus/server/browser/surface-driver'

// WHY: an agent checks a UI change by looking at the page. The screenshot comes
// back in the tool result, so looking takes one call instead of a second Read.
// A capture too large for a tool result must still be there to read, and the
// user's card must name the same stored picture either way.

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''
let screenshot = ''

class FakeDriver implements BrowserSurfaceDriver {
  readonly kind = 'headless' as const
  async applyEmulation(): Promise<void> {}
  async navigate(): Promise<void> {}
  async captureScreenshot(): Promise<string> { return screenshot }
  async startScreencast(): Promise<void> {}
  async stopScreencast(): Promise<void> {}
  async evaluate(): Promise<string> { return 'null' }
  async clickAt(): Promise<void> {}
  async insertText(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async scrollAt(): Promise<void> {}
  async openDevTools(): Promise<void> {}
  async dispatchMouse(): Promise<void> {}
  async setFileInputFiles(): Promise<void> {}
  async answerDialog(): Promise<null> { return null }
  dialogs() { return { open: null, last: null } }
  consoleEntries(): BrowserConsoleEntry[] { return [] }
  networkEntries(): BrowserNetworkEntry[] { return [] }
  async dispose(): Promise<void> {}
}

let tools: typeof import('@solus/server/browser/browser-tools')
let registry: typeof import('@solus/server/browser/browser-registry')
let surface: typeof import('@solus/server/browser/surface-driver')

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-browser-snapshot-'))
  process.env.SOLUS_DATA_DIR = dataDir
  tools = await import('@solus/server/browser/browser-tools')
  registry = await import('@solus/server/browser/browser-registry')
  surface = await import('@solus/server/browser/surface-driver')
})

afterEach(() => surface.setBrowserHeadlessHost(null))

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

async function snapshot() {
  surface.setBrowserHeadlessHost({ open: async () => new FakeDriver() })
  const pages = registry.initBrowserRegistry({ pageChanged: () => {}, pageClosed: () => {}, surfaceRequested: () => {} })
  const page = pages.open({ target: { kind: 'url', url: 'http://localhost:5173/' } })
  const emitted: NormalizedEvent[] = []
  const result = await tools.browserSnapshotAgentTool.execute({ browserPageId: page.browserPageId }, {
    provider: 'claude-code', cwd: dataDir, sessionId: () => 'session-1', abortSignal: new AbortController().signal,
    parentToolUseId: () => undefined, emit: (event) => emitted.push(event),
  })
  const card = emitted.find((event) => event.type === 'browser_snapshot_captured')
  return { result, assetId: card?.type === 'browser_snapshot_captured' ? card.snapshot.assetId : undefined }
}

test('the screenshot is an image in the result, and the card names the same capture', async () => {
  screenshot = `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`
  const { result, assetId } = await snapshot()
  expect(result.ok).toBe(true)
  expect(result.image).toEqual({ mimeType: 'image/png', data: ONE_PIXEL_PNG.toString('base64') })
  expect(result.text).toContain(`screenshot: attached to this result; saved at ${join(dataDir, 'assets', assetId!)}`)
})

test('a screenshot too large for a tool result is a file to read instead', async () => {
  screenshot = `data:image/png;base64,${Buffer.concat([ONE_PIXEL_PNG, Buffer.alloc(6 * 1024 * 1024)]).toString('base64')}`
  const { result, assetId } = await snapshot()
  expect(result.image).toBeUndefined()
  const path = /screenshot: (\S+) {2}\(too large to attach/.exec(result.text)![1]
  expect(path).toBe(join(dataDir, 'assets', assetId!))
  expect(await Bun.file(path).exists()).toBe(true)
})
