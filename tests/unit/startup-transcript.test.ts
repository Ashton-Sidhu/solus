import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isMobileLayout } from '../../packages/workspace-ui/src/contexts/app/viewport'

const transpiler = new Bun.Transpiler({ loader: 'ts' })
const source = readFileSync(new URL('../../packages/workspace-ui/src/contexts/workspace/startup-transcript.ts', import.meta.url), 'utf8')
const executable = transpiler.transformSync(source.replace(/^import .*\n/gm, '')).replaceAll('export ', '')

function fixture(options: { mobile?: boolean; fork?: boolean; missingHost?: boolean } = {}) {
  const requests: Array<{ host: string; sessionId: string; projectPath: string; deferToolInputs: boolean }> = []
  const marks: string[] = []
  const frames = new Map<number, FrameRequestCallback>()
  const timeouts = new Map<number, () => void>()
  let nextFrame = 0
  const tab = {
    tabId: 'active', serverId: 'old-registry-id', serverInstallationId: 'installation',
    agentSessionId: 'thread', provider: 'codex', workingDirectory: '/repo',
    gitContext: { worktreePath: '/checkout' }, pendingFork: options.fork ? {} : undefined,
  }
  const create = new Function('prefetchSessionHistoryPage', 'RESTORED_TRANSCRIPT_LIMIT',
    'serverConnections', 'loadServers', 'loadPersistedTabs', 'isMobileLayout',
    'window', 'screen', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'document',
    'afterPaint', 'setTimeout', 'clearTimeout',
    `${executable}\nreturn { prefetchStartupTranscript, markStartupTranscriptApplied, observeStartupTranscriptPaint, afterStartupTranscriptPaint };`)
  const api = create(
    (host: string, request: { sessionId: string; projectPath: string; deferToolInputs: boolean }) => {
      requests.push({ host, ...request }); return Promise.resolve({ messages: [], before: null })
    }, 200,
    { apiFor(host: string) { if (options.missingHost) throw new Error('missing host'); return host } },
    () => [{ installationId: 'installation', id: 'repaired-host' }],
    () => ({ activeTabId: 'active', tabs: [tab, { ...tab, tabId: 'inactive', agentSessionId: 'other' }] }),
    isMobileLayout,
    { innerWidth: options.mobile ? 390 : 1200, matchMedia: () => ({ matches: !!options.mobile }) },
    { width: options.mobile ? 390 : 1200, height: 800 },
    { mark(name: string) { marks.push(name) }, getEntriesByName(name: string) { return marks.filter((mark) => mark === name) } },
    (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame },
    (frame: number) => frames.delete(frame), { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    () => Promise.resolve(),
    (callback: () => void) => { timeouts.set(++nextFrame, callback); return nextFrame },
    (timer: number) => timeouts.delete(timer),
  )
  return { api, requests, marks, expire() { for (const callback of timeouts.values()) callback() }, paint() {
    const pending = [...frames.values()]; frames.clear()
    for (const callback of pending) callback(0)
  } }
}

test('background PR reads wait for the restored transcript paint signal', async () => {
  const { api, paint } = fixture()
  await api.prefetchStartupTranscript()
  let released = false
  const background = api.afterStartupTranscriptPaint().then(() => { released = true })
  await Promise.resolve()
  expect(released).toBe(false)
  api.markStartupTranscriptApplied('active')
  api.observeStartupTranscriptPaint('active')
  paint()
  expect(released).toBe(false)
  paint()
  await background
  expect(released).toBe(true)
})

test('an empty or hidden restored transcript cannot block background reads forever', async () => {
  const { api, expire } = fixture()
  await api.prefetchStartupTranscript()
  const background = api.afterStartupTranscriptPaint()
  await Promise.resolve()
  expire()
  await background
})

test('startup selects only the active thread and resolves its repaired host and checkout', () => {
  const { api, requests } = fixture()
  api.prefetchStartupTranscript()
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ host: 'repaired-host', sessionId: 'thread', projectPath: '/checkout', deferToolInputs: false })
})

test('mobile startup requests deferred tool inputs; forks and missing hosts do not block boot', () => {
  const mobile = fixture({ mobile: true })
  mobile.api.prefetchStartupTranscript()
  expect(mobile.requests[0].deferToolInputs).toBe(true)
  for (const options of [{ fork: true }, { missingHost: true }]) {
    const skipped = fixture(options)
    expect(() => skipped.api.prefetchStartupTranscript()).not.toThrow()
    expect(skipped.requests).toHaveLength(0)
  }
})

test('paint timing requires the restored conversation and cancels when it becomes hidden', () => {
  const { api, marks, paint } = fixture()
  api.prefetchStartupTranscript()
  expect(api.observeStartupTranscriptPaint('active')).toBeUndefined()
  api.markStartupTranscriptApplied('active')
  expect(api.observeStartupTranscriptPaint('inactive')).toBeUndefined()
  const cancel = api.observeStartupTranscriptPaint('active')
  paint()
  cancel()
  paint()
  expect(marks).not.toContain('solus.boot.transcript.painted')
  api.observeStartupTranscriptPaint('active')
  paint()
  expect(marks).not.toContain('solus.boot.transcript.painted')
  paint()
  expect(marks).toContain('solus.boot.transcript.painted')
})

test('secondary work yields a paint opportunity and still runs when frames are suspended', async () => {
  const afterPaintSource = transpiler.transformSync(readFileSync(new URL('../../packages/workspace-ui/src/lib/after-paint.ts', import.meta.url), 'utf8')).replaceAll('export ', '')
  for (const suspended of [false, true]) {
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    let timeout: (() => void) | undefined
    const run = new Function('globalThis', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
      `${afterPaintSource}\nreturn afterPaint();`)
    let completed = false
    const pending = run({ requestAnimationFrame: true },
      (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame },
      (frame: number) => frames.delete(frame),
      (callback: () => void) => { timeout = callback; return 1 },
      () => { timeout = undefined },
    ).then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    if (suspended) timeout!()
    else {
      for (let index = 0; index < 2; index++) {
        const callbacks = [...frames.values()]; frames.clear()
        for (const callback of callbacks) callback(0)
      }
    }
    await pending
    expect(completed).toBe(true)
    expect(frames.size).toBe(0)
    expect(timeout).toBeUndefined()
  }
})

test('restored history and live attachment finish before secondary metadata, with a stale-tab guard', async () => {
  const bootstrap = readFileSync(new URL('../../packages/workspace-ui/src/contexts/workspace/session-bootstrap.ts', import.meta.url), 'utf8')
  const hydration = transpiler.transformSync(bootstrap.slice(bootstrap.indexOf('async function hydrateTab(')))
  for (const replaceTab of [false, true]) {
    let paint!: () => void
    const paintPending = new Promise<void>((resolve) => { paint = resolve })
    const events: string[] = []
    const session = { id: 'stable', agentSessionId: 'thread', run: { provider: 'codex' }, messages: [{ content: 'already visible' }], loadingHistory: false }
    let selected = session
    const context = {
      tabs: { tab: { sessionId: 'stable' } }, sessions: { stable: session },
      settings: { activeAgent: 'codex' }, apiFor: () => ({
        resolveSessionLineage: async () => null,
        watchSession: async () => { events.push('watch'); return { sessionId: 'stable', runtime: null } },
      }),
      ctxFor: () => ({}), sessionFor: () => selected,
      eventReducer: { rebuildAgentConversations() {} }, recomputeChangedFiles() {},
      planStore: { hydrateAnnotations() {} }, adoptSessionId() {}, refreshThreadGoal() {},
      environment: { refreshEnvironment: async () => { events.push('git'); return new Promise(() => {}) } },
      tasksStore: { ensureSessionBinding: async () => { events.push('task'); return new Promise(() => {}) } },
    }
    const execute = new Function('afterPaint', 'requestSessionHistoryPage', 'loadRestoredSessionTranscript',
      'replaceHydratedMessages', 'markStartupTranscriptApplied', 'RESTORED_TRANSCRIPT_LIMIT', 'isSessionBusyStatus',
      `${hydration}\nreturn hydrateTab;`)
    const hydrate = execute(() => paintPending, async () => ({ messages: [] }),
      async () => { expect(session.loadingHistory).toBe(false); return { messages: [{ content: 'ready' }], planIds: [] } },
      (target: { messages: Array<{ content: string }> }, messages: Array<{ content: string }>) => { target.messages.push(...messages); events.push('history') },
      () => {}, 200, () => false)
    await hydrate(context, { tabId: 'tab', agentSessionId: 'thread', provider: 'codex', workingDirectory: '/repo' })
    expect(session.loadingHistory).toBe(false)
    expect(events).toEqual(['history', 'watch'])
    if (replaceTab) selected = { ...session, id: 'replacement' }
    paint()
    await Promise.resolve()
    expect(events).toEqual(replaceTab ? ['history', 'watch'] : ['history', 'watch', 'git', 'task'])
  }
})


test('the selected transcript is materialized synchronously before the workspace first renders', () => {
  const source = readFileSync(new URL('../../packages/workspace-ui/src/contexts/workspace/startup-session.ts', import.meta.url), 'utf8')
  const compiled = transpiler.transformSync(source.replace(/^import .*\n/gm, '')).replaceAll('export ', '')
  const page = { messages: [], before: 'older' }
  const messages = [{ role: 'user', content: 'restored transcript' }]
  const session = { run: { workingDirectory: '/repo' }, messages: [], loadingHistory: true, historyCursor: null }
  const marks: string[] = []
  const materialize = new Function('readPrefetchedSessionHistoryPage', 'RESTORED_TRANSCRIPT_LIMIT',
    'materializeSessionTranscript', 'markStartupTranscriptApplied',
    `${compiled}\nreturn materializeStartupTranscript;`)(
      () => page, 200, () => ({ messages, before: 'older', truncated: true }), (tabId: string) => marks.push(tabId),
    )
  const context = {
    activeTabId: 'active', sessionFor: () => session, apiFor: () => ({}), ctxFor: () => ({}),
    eventReducer: { rebuildAgentConversations() {} }, recomputeChangedFiles() {},
  }
  materialize(context, { tabs: [{ tabId: 'active', agentSessionId: 'thread', provider: 'codex' }] })
  expect(session.messages).toEqual(messages)
  expect(session.loadingHistory).toBe(false)
  expect(session.historyCursor).toBe('older')
  expect(marks).toEqual(['active'])
})
