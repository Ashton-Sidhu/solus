import { beforeEach, expect, mock, test } from 'bun:test'
import type { SessionDescription, SessionMeta } from '@solus/contracts/types'
import { folderLocation } from '@solus/workspace-ui/contexts/workspace/run-location'

// WHY: opening a session waited for its description, a round trip, before its
// tab existed, and only then the rows could show. The tab now opens on the
// facts the caller holds, and the description answers beside the history page.

const workspaceUi = '../../packages/workspace-ui/src'

interface Pending<T> { promise: Promise<T>; resolve: (value: T) => void }
function pending<T>(): Pending<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

let descriptions: Pending<SessionDescription>[] = []
let transcriptReads: { provider: string; sessionId: string }[] = []
const api = {
  describeSession: () => { const description = pending<SessionDescription>(); descriptions.push(description); return description.promise },
  watchSession: async () => ({ runtime: null, pendingQuestions: [] }),
  loadSessionPage: async () => ({ messages: [], before: null }),
}

mock.module('@solus/client-core/server-connections', () => ({ serverConnections: { apiFor: () => api } }))
mock.module(`${workspaceUi}/contexts/workspace/session-transcript`, () => ({
  loadSessionTranscript: async (_workspace: unknown, args: { provider: string; sessionId: string }) => {
    transcriptReads.push({ provider: args.provider, sessionId: args.sessionId })
    return { messages: [{ role: 'assistant', content: 'Ready' }], progress: null, truncated: false, before: null, pendingMessages: [], planIds: [], endsInRefusedLogin: false }
  },
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
mock.module(`${workspaceUi}/contexts/workspace/session-list.store.svelte`, () => ({ sessionListStore: { markOpened: () => {} } }))

const { SessionOpening } = await import(`${workspaceUi}/contexts/workspace/session-opening`)
const { SessionUnavailableError } = await import(`${workspaceUi}/contexts/workspace/session-errors`)

/** Answers every call the resume makes around the parts under test. */
const ignored: unknown = new Proxy(() => {}, { get: () => ignored, apply: () => undefined })

interface FakeSession { id: string; messages: unknown[]; run: Record<string, unknown>; title?: string; threadProvider?: string; loadingHistory?: boolean }

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
    tasksStore: { ensureSessionBinding: async () => null },
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
})

test('the tab and the history read start before the description answers; the rows wait for it', async () => {
  const { opening, created, sessions } = harness()
  const resumed = opening.resumeSession(listed)
  await settle()

  expect(created).toEqual(['tab-1:claude-code'])
  expect(transcriptReads).toEqual([{ provider: 'claude-code', sessionId: 'session-1' }])
  // The rows show only the thread the description names.
  expect(sessions['tab-1'].messages).toHaveLength(0)

  descriptions[0].resolve({ lineage: null, meta: { ...listed, customTitle: 'Named', model: 'claude-opus-5-5' } })
  expect(await resumed).toBe('tab-1')
  expect(sessions['tab-1'].messages).toHaveLength(1)
  expect(sessions['tab-1'].title).toBe('Named')
  expect(sessions['tab-1'].run.modelConfig).toEqual({ model: 'claude-opus-5-5' })
})

test('a description that names another active thread opens that thread instead, with no second description', async () => {
  // After a provider handoff the session's active thread is another provider's.
  const { opening, created, closed } = harness()
  const resumed = opening.resumeSession(listed)
  await settle()
  const member = { position: 1, provider: 'codex' as const, providerSessionId: 'thread-2', cwd: '/repo', startedAt: 1, endedAt: null }
  descriptions[0].resolve({ lineage: { sessionId: 'session-1', active: member, members: [member], lineageToken: '1' }, meta: { ...listed, provider: 'codex' } })

  expect(await resumed).toBe('tab-2')
  expect(closed).toEqual(['tab-1'])
  expect(created).toEqual(['tab-1:claude-code', 'tab-2:codex'])
  expect(transcriptReads.at(-1)).toEqual({ provider: 'codex', sessionId: 'session-1' })
  expect(descriptions).toHaveLength(1)
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
