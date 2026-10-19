import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { SavedServer } from '@solus/client-core/server-registry'
import type { BrowserSurfaceDriver } from '@solus/server/browser/surface-driver'
import type { NormalizedEvent } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let fixtureRoot = ''
beforeAll(async () => { fixtureRoot = await mkdtemp(join(import.meta.dir, 'platform-fixture-')) })
afterAll(async () => { await rm(fixtureRoot, { recursive: true, force: true }) })

// These are synthetic fixture markers, never copied page or account values.
const passwordMarker = 'synthetic-password-marker'
const cssMarker = 'synthetic-css-mask-marker'
class InputFixture {
  tagName = 'INPUT'
  textContent = ''
  disabled = false
  id = ''
  constructor(readonly type: string, readonly value: string, readonly masked = false) {}
  getAttribute(name: string) { return name === 'type' ? this.type : name === 'placeholder' ? 'Fixture field' : null }
  setAttribute() {}
  removeAttribute() {}
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, bottom: 20, width: 100, height: 20 } }
}
const fixtureInputs = [new InputFixture('password', passwordMarker), new InputFixture('text', cssMarker, true)]
function evaluateFixture(expression: string): string {
  return runInNewContext(expression, {
    document: { title: 'Synthetic form', querySelectorAll: (selector: string) => selector.startsWith('[') ? [] : fixtureInputs },
    location: { href: 'https://fixture.invalid' },
    window: { innerHeight: 600, getComputedStyle: (element: InputFixture) => ({ visibility: 'visible', display: 'block', webkitTextSecurity: element.masked ? 'disc' : 'none' }) },
  })
}
class FixtureDriver implements BrowserSurfaceDriver {
  readonly kind = 'headless' as const
  async applyEmulation() {}
  async navigate() {}
  async captureScreenshot() { return '' }
  async startScreencast() {}
  async stopScreencast() {}
  async evaluate(expression: string) { return expression.includes('const SELECTOR') ? evaluateFixture(expression) : 'null' }
  async clickAt() {}
  async insertText() {}
  async pressKey() {}
  async scrollAt() {}
  async openDevTools() {}
  async dispatchMouse() {}
  async setFileInputFiles() {}
  async answerDialog() { return null }
  dialogs() { return { open: null, last: null } }
  consoleEntries() { return [] }
  networkEntries() { return [] }
  async dispose() {}
}

test('20446: masked values enter raw snapshot RPC data, but ordinary input values are omitted from agent text', async () => {
  const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')
  actAsHostForTests()
  const surface = await import('@solus/server/browser/surface-driver')
  const { initBrowserRegistry } = await import('@solus/server/browser/browser-registry')
  const { browserSnapshotAgentTool } = await import('@solus/server/browser/browser-tools')
  surface.setBrowserHeadlessHost({ open: async () => new FixtureDriver() })
  try {
    const registry = initBrowserRegistry({ pageChanged() {}, pageClosed() {}, surfaceRequested() {} })
    const page = registry.open({ target: { kind: 'url', url: 'https://fixture.invalid' } }, null)
    const snapshot = await registry.snapshot(page.browserPageId, { screenshot: false, vitals: false })
    expect(snapshot.elements.map(element => element.value)).toEqual([passwordMarker, cssMarker])
    const result = await browserSnapshotAgentTool.execute({ browserPageId: page.browserPageId, screenshot: false }, {
      provider: 'claude-code', cwd: fixtureRoot, sessionId: () => 'fixture-session', abortSignal: new AbortController().signal,
      parentToolUseId: () => undefined, emit() {},
    })
    expect(result.ok).toBe(true)
    expect(result.text).not.toContain(passwordMarker)
    expect(result.text).not.toContain(cssMarker)
  } finally { surface.setBrowserHeadlessHost(null) }
})

test('20449: a project-relative create follows an intermediate symlink outside the project', async () => {
  const { applyProjectFileMutation } = await import('@solus/server/files/project-mutations')
  const project = join(fixtureRoot, 'project')
  const outside = join(fixtureRoot, 'sibling')
  await mkdir(project); await mkdir(outside)
  await symlink(outside, join(project, 'linked-folder'))
  const created = await applyProjectFileMutation(project, { op: 'createFile', path: 'linked-folder/new.txt' })
  expect(created).toEqual({ ok: true, path: 'linked-folder/new.txt' })
  expect(await readFile(join(outside, 'new.txt'), 'utf8')).toBe('')
  await writeFile(join(outside, 'keep.txt'), 'synthetic file')
  const deleted = await applyProjectFileMutation(project, { op: 'delete', path: 'linked-folder/keep.txt' })
  expect(deleted.ok).toBe(true)
  expect(await Bun.file(join(outside, 'keep.txt')).exists()).toBe(false)
})

test('20445: a secure paired host does not borrow a new discovered plain-HTTP route', async () => {
  const { withNearbyRoutes } = await import('@solus/client-core/uplink-session')
  const saved: SavedServer = { id: 'fixture-host', installationId: 'fixture-host', url: 'https://fixture.invalid', sessionToken: 'synthetic-token', label: 'Fixture', lastConnected: 0, uplink: { hostId: 'fixture-host', directoryUrl: 'https://directory.invalid' } }
  const discovered = { host: '192.0.2.9', port: 7777, name: 'Fixture', installationId: 'fixture-host', source: 'lan' as const }
  expect(withNearbyRoutes([saved], [discovered])).toBeNull()
})

type CodexProbe = {
  activeRuns: Map<string, unknown>
  rememberSessionRouting(params: unknown, sessionId: string): void
  sessionIdFor(params: unknown): string | null
  onNotification(message: { method: string; params: unknown }, client: unknown): void
  finishCompletedTurn(handle: unknown, normalized: NormalizedEvent[], partial: boolean, exitCode: 0 | 1 | null, signal: 'SIGINT' | null, turnId: string): Promise<void>
}

test('21366: failed root exits immediately, but its still-running child loses live delivery', async () => {
  const { CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend')
  const backend = new CodexBackend()
  const probe = backend as unknown as CodexProbe
  const { CodexTurnNormalizer } = await import('@solus/server/execution/agents/codex/codex-event-normalizer')
  const normalizer = new CodexTurnNormalizer({ planMode: false })
  const handle = { agentSessionId: 'parent', persistent: false, normalizer, _resolveRun() {} }
  probe.activeRuns.set('parent', handle)
  const spawn = { threadId: 'parent', item: { type: 'subAgentActivity', id: 'spawn-fixture', kind: 'started', agentThreadId: 'child-fixture' } }
  probe.rememberSessionRouting(spawn, 'parent')
  normalizer.push({ method: 'item/completed', params: spawn })
  expect(probe.sessionIdFor({ threadId: 'child-fixture' })).toBe('parent')
  const emitted: string[] = []
  backend.on('normalized', (_id: string, event: NormalizedEvent) => emitted.push(event.type))
  backend.on('exit', (_id: string, code: number) => emitted.push(`exit:${code}`))
  await probe.finishCompletedTurn(handle, [], false, 1, null, 'parent-turn')
  expect(emitted).toEqual(['exit:1'])
  expect(probe.activeRuns.has('parent')).toBe(false)
  expect(probe.sessionIdFor({ threadId: 'child-fixture' })).toBeNull()
  const childComplete = { method: 'turn/completed', params: { threadId: 'child-fixture', turn: { status: 'completed', items: [{ type: 'agentMessage', text: 'Synthetic child report' }] } } }
  probe.onNotification(childComplete, {})
  expect(emitted).toEqual(['exit:1'])
  // The event itself is meaningful: the retained normalizer can still produce the report.
  expect(normalizer.push(childComplete).some(event => event.type === 'tool_result')).toBe(true)
})
