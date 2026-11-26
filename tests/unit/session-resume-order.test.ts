import { beforeEach, expect, mock, test } from 'bun:test'
import type { SessionDescription, SessionMeta } from '@solus/contracts/types'
import { folderLocation } from '@solus/workspace-ui/contexts/workspace/run-location'

// WHY: opening a session waited for its description, a round trip, before its
// tab existed, and only then the rows could show. The tab now opens on the
// facts the caller holds, and the description answers beside the history page.
// The description then changes that tab in place. An open that closed the tab
// and opened the session again doubled every read and mount, and it happened
// for each session whose provider thread id is not its session id.

const workspaceUi = '../../packages/workspace-ui/src'

interface Pending<T> { promise: Promise<T>; resolve: (value: T) => void }
function pending<T>(): Pending<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

let descriptions: Pending<SessionDescription>[] = []
let transcriptReads: { provider: string; sessionId: string; displayCwd: string }[] = []
let pageReads = 0
let watches = 0
let identityReads: string[] = []
const api = {
  describeSession: () => { const description = pending<SessionDescription>(); descriptions.push(description); return description.promise },
  watchSession: async () => { watches++; return { runtime: null, pendingQuestions: [] } },
  loadSessionPage: async () => { pageReads++; return { messages: [], before: null } },
  gitIdentity: async (dir: string) => { identityReads.push(dir); return null },
  sessionFolders: async () => [],
}

mock.module('@solus/client-core/server-connections', () => ({ serverConnections: { apiFor: () => api } }))
mock.module(`${workspaceUi}/contexts/workspace/session-transcript`, () => ({
  loadSessionTranscript: async (_workspace: unknown, args: { provider: string; sessionId: string; displayCwd: string; history?: Promise<unknown> }) => {
    await args.history
    transcriptReads.push({ provider: args.provider, sessionId: args.sessionId, displayCwd: args.displayCwd })
    return { messages: [{ role: 'assistant', content: 'Ready' }], progress: null, truncated: false, before: null, pendingMessages: [], planIds: [], endsInRefusedLogin: false }
  },
  readTranscriptDependencies: () => ({ automations: Promise.resolve(), artifactFileBodies: Promise.resolve(new Map()) }),
}))
mock.module(`${workspaceUi}/lib/inputFocus`, () => ({ requestInputFocus: () => {} }))
mock.module(`${workspaceUi}/contexts/hosts/hosts.svelte`, () => ({
  hosts: { hasExecution: () => true, hasCollaboration: () => true, find: () => null, get: () => null, rolesFor: () => ['collaboration', 'execution'] },
}))
mock.module(`${workspaceUi}/contexts/connections/servers.store.svelte`, () => ({ serversStore: { executionServers: [] } }))
mock.module(`${workspaceUi}/contexts/projects/projects.store.svelte`, () => ({
  projectsStore: { projectKeyFor: (_serverId: string, key: string) => key, checkoutsOf: () => [] },
  CHATS_GROUP_KEY: 'solus:chats',
  groupKeyFor: (_serverId: string, projectKey: string) => projectKey,
}))
mock.module(`${workspaceUi}/lib/toasts`, () => ({ toasts: {} }))
mock.module(`${workspaceUi}/lib/analytics`, () => ({ track: () => {} }))
mock.module(`${workspaceUi}/contexts/workspace/session-draft.svelte`, () => ({ ownedTaskId: () => null }))
mock.module(`${workspaceUi}/contexts/workspace/session-list.store.svelte`, () => ({ sessionListStore: { markOpened: () => {}, noteSessionMeta: () => {} } }))

const { SessionOpening } = await import(`${workspaceUi}/contexts/workspace/session-opening`)
const { SessionUnavailableError } = await import(`${workspaceUi}/contexts/workspace/session-errors`)

/** Answers every call the resume makes around the parts under test. */
const ignored: unknown = new Proxy(() => {}, { get: () => ignored, apply: () => undefined })

interface FakeSession {
  id: string; messages: unknown[]; run: Record<string, unknown>; title?: string; threadProvider?: string; loadingHistory?: boolean
  agentSessionId?: string | null; handoffPending?: boolean
}

function harness() {
  const created: string[] = []
  const closed: string[] = []
  const sessions: Record<string, FakeSession> = {}
  const tabs: Record<string, { id: string; sessionId?: string }> = {}
  const state = {
    tabs, sessions: { byId: {} }, tabOrder: [] as string[], activeTab: null, activeTabId: null, activeSession: null,
    settings: { activeAgent: 'claude-code' },
    config: { followActiveSessionAgent: () => {}, threadRunFor: (thread: { provider: string; model?: string }) => ({ provider: thread.provider, modelConfig: { model: thread.model } }) },
    createTab: async (_dir: string, opts: { thread: { provider: string } }) => {
      const tabId = `tab-${created.length + 1}`
      created.push(`${tabId}:${opts.thread.provider}`)
      tabs[tabId] = { id: tabId }
      sessions[tabId] = { id: tabId, messages: [], run: { location: folderLocation({ serverId: 'local', path: '/repo' }) } }
      return tabId
    },
    sessionFor: (tabId: string) => sessions[tabId],
    runFor: (tabId: string) => sessions[tabId]?.run,
    apiFor: () => api,
    closeTab: (tabId: string) => { closed.push(tabId); delete tabs[tabId]; delete sessions[tabId] },
    issuesStore: { ensureSessionBinding: async () => null },
  }
  const workspace = new Proxy(state, { get: (target, key) => key in target ? target[key as keyof typeof target] : ignored })
  return { opening: new SessionOpening(workspace), created, closed, sessions }
}

const listed: SessionMeta = {
  serverId: 'local', sessionId: 'session-1', provider: 'claude-code', cwd: '/repo', projectPath: '-repo',
  slug: null, firstMessage: 'Listed title', lastTimestamp: '2026-11-17T00:00:00.000Z', size: 0,
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

beforeEach(() => {
  descriptions = []
  transcriptReads = []
  pageReads = 0
  watches = 0
  identityReads = []
})

function lineage(member: { provider: 'claude-code' | 'codex'; providerSessionId: string | null; cwd: string }) {
  const active = { position: 0, startedAt: 1, endedAt: null, ...member }
  return { sessionId: 'session-1', active, members: [active], lineageToken: '1' }
}

test('the tab and the history page start before the description answers; the rows wait for it', async () => {
  const { opening, created, sessions } = harness()
  const resumed = opening.resumeSession(listed)
  await settle()

  expect(created).toEqual(['tab-1:claude-code'])
  expect(pageReads).toBe(1)
  // The rows show only once the description says which thread they are.
  expect(transcriptReads).toEqual([])
  expect(sessions['tab-1'].messages).toHaveLength(0)

  descriptions[0].resolve({ lineage: null, meta: { ...listed, customTitle: 'Named', model: 'claude-opus-5-5' } })
  expect(await resumed).toBe('tab-1')
  expect(sessions['tab-1'].messages).toHaveLength(1)
  expect(sessions['tab-1'].title).toBe('Named')
  expect(sessions['tab-1'].run.modelConfig).toEqual({ model: 'claude-opus-5-5' })
})

test('a session whose provider thread id is not its session id opens once, in the tab it opened', async () => {
  // Every session that Solus starts now has its own id; the provider names the thread.
  const { opening, created, closed, sessions } = harness()
  const resumed = opening.resumeSession(listed)
  await settle()
  descriptions[0].resolve({ lineage: lineage({ provider: 'claude-code', providerSessionId: 'thread-1', cwd: '/repo' }), meta: listed })

  expect(await resumed).toBe('tab-1')
  expect(created).toEqual(['tab-1:claude-code'])
  expect(closed).toEqual([])
  expect(sessions['tab-1'].agentSessionId).toBe('thread-1')
  expect(pageReads).toBe(1)
  expect(transcriptReads).toHaveLength(1)
  expect(watches).toBe(1)
  expect(descriptions).toHaveLength(1)
})

test('a description that names another provider thread changes the tab in place', async () => {
  // After a provider handoff the session's active thread is another provider's.
  const { opening, created, closed, sessions } = harness()
  const resumed = opening.resumeSession(listed)
  await settle()
  descriptions[0].resolve({ lineage: lineage({ provider: 'codex', providerSessionId: 'thread-2', cwd: '/repo' }), meta: { ...listed, provider: 'codex' } })

  expect(await resumed).toBe('tab-1')
  expect(closed).toEqual([])
  expect(created).toEqual(['tab-1:claude-code'])
  expect(sessions['tab-1'].threadProvider).toBe('codex')
  expect(sessions['tab-1'].run.provider).toBe('codex')
  expect(sessions['tab-1'].agentSessionId).toBe('thread-2')
  expect(sessions['tab-1'].handoffPending).toBe(false)
  expect(transcriptReads).toEqual([{ provider: 'codex', sessionId: 'session-1', displayCwd: '/repo' }])
  expect(pageReads).toBe(1)
})

test('a handoff that has no thread yet opens pending, in the same tab', async () => {
  const { opening, closed, sessions } = harness()
  const resumed = opening.resumeSession(listed)
  await settle()
  descriptions[0].resolve({ lineage: lineage({ provider: 'codex', providerSessionId: null, cwd: '/repo' }), meta: null })

  expect(await resumed).toBe('tab-1')
  expect(closed).toEqual([])
  expect(sessions['tab-1'].agentSessionId).toBeNull()
  expect(sessions['tab-1'].handoffPending).toBe(true)
})

test('Git reads the folder the described thread works in, not the folder the list names', async () => {
  // The list names the repository; the thread works in a Solus worktree of it.
  const worktree = '/repo/.git/solus/worktrees/repo-1'
  const { opening } = harness()
  const resumed = opening.resumeSession(listed)
  await settle()
  descriptions[0].resolve({ lineage: lineage({ provider: 'claude-code', providerSessionId: 'thread-1', cwd: worktree }), meta: { ...listed, cwd: worktree } })
  await resumed

  expect(identityReads).toEqual([worktree])
})

test('a session that is gone closes the tab it opened and says it is unavailable', async () => {
  const { opening, closed, sessions } = harness()
  const resumed = opening.resumeSession(listed)
  await settle()
  descriptions[0].resolve({ lineage: null, meta: null })

  await expect(resumed).rejects.toBeInstanceOf(SessionUnavailableError)
  expect(closed).toEqual(['tab-1'])
  expect(sessions['tab-1']).toBeUndefined()
})

test('the open takes the description a rest on the row read: the rows wait for no second round trip', async () => {
  // WHY: with the first page read during the rest, the description was the
  // round trip the rows still waited for after the click.
  const { opening, sessions } = harness()
  opening.prefetchOpening(listed, { maxAgeMs: 10_000 })
  expect(descriptions).toHaveLength(1)
  descriptions[0].resolve({ lineage: null, meta: listed })
  await settle()

  expect(await opening.resumeSession(listed)).toBe('tab-1')
  expect(descriptions).toHaveLength(1)
  expect(sessions['tab-1'].messages).toHaveLength(1)
})

test('a description read during a run that has since ended is read again at the open', async () => {
  const { opening } = harness()
  let sameRun = true
  opening.prefetchOpening(listed, { maxAgeMs: 10_000, isCurrent: () => sameRun })
  sameRun = false
  const resumed = opening.resumeSession(listed)
  await settle()

  expect(descriptions).toHaveLength(2)
  descriptions[1].resolve({ lineage: null, meta: listed })
  expect(await resumed).toBe('tab-1')
})
