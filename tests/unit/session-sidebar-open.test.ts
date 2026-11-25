import { afterAll, afterEach, beforeEach, expect, jest, mock, test } from 'bun:test'
import type { SessionMeta } from '@solus/contracts/types'
import type { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import type { SessionExecution } from '@solus/contracts/session-execution'
import type { OpeningPrefetchLife } from '@solus/workspace-ui/contexts/workspace/session-opening'

// WHY: a click on a listed session read its metadata, a round trip, before the
// open began, though the list already holds what the open needs. And a page
// read only at the click costs a round trip that a rest on the row can hide.

const workspaceUi = '../../packages/workspace-ui/src'
let metaReads = 0
const unopenable: string[] = []
const listedBySession = new Map<string, unknown>()

mock.module('@solus/client-core/session-meta', () => ({
  readSessionMeta: async () => { metaReads++; return null },
  onSessionMetaRead: () => () => {},
}))
mock.module(`${workspaceUi}/contexts/sharing/unopenable-session`, () => ({
  noticeUnopenableSession: (_serverId: string, sessionId: string) => unopenable.push(sessionId),
}))
const realList = await import(`${workspaceUi}/contexts/workspace/session-list.store.svelte`)
mock.module(`${workspaceUi}/contexts/workspace/session-list.store.svelte`, () => ({
  ...realList,
  sessionListStore: { ...realList.sessionListStore, listed: (sessionId: string) => listedBySession.get(sessionId) },
}))

const runes = globalThis as unknown as { $state?: unknown }
const previousState = runes.$state
runes.$state = <T>(value: T) => value
const { SessionSidebarStore: SidebarStoreClass } = await import(`${workspaceUi}/contexts/workspace/session-sidebar.store.svelte`)
const { SessionUnavailableError } = await import(`${workspaceUi}/contexts/workspace/session-errors`)
afterAll(() => {
  if (previousState === undefined) delete runes.$state
  else runes.$state = previousState
})

function listed(sessionId: string, status: 'idle' | 'running' = 'idle') {
  return {
    serverId: 'remote', homeServerId: 'remote', runnerOffline: false, sessionId, title: 'Listed title', projectPath: '/repo',
    createdAt: 1, lastActivityAt: 2, status, branch: null, ownerKey: 'me',
    opensWith: { provider: 'claude-code', projectPath: '-repo', cwd: '/repo' },
  }
}

function harness(resume: (meta: SessionMeta) => Promise<string> = async () => 'tab') {
  const resumed: SessionMeta[] = []
  const prefetched: { sessionId: string; maxAgeMs?: number }[] = []
  const lives: OpeningPrefetchLife[] = []
  const executions = new Map<string, SessionExecution>()
  const store = Object.create(SidebarStoreClass.prototype) as SessionSidebarStore
  Object.defineProperty(store, 'session', {
    value: {
      opening: {
        resumeSession: (meta: SessionMeta) => { resumed.push(meta); return resume(meta) },
        prefetchOpening: (meta: { sessionId: string }, life?: OpeningPrefetchLife) => {
          prefetched.push({ sessionId: meta.sessionId, maxAgeMs: life?.maxAgeMs })
          if (life) lives.push(life)
        },
      },
      sessions: { executionFor: (_serverId: string, sessionId: string) => executions.get(sessionId) },
    },
  })
  const open = (row: SidebarTask) => (store as unknown as { openListedSession(row: SidebarTask): Promise<void> }).openListedSession(row)
  return { store, open, resumed, prefetched, lives, executions }
}

const row = (sessionId: string) => ({ key: sessionId, sessionId, serverId: 'remote', tabIds: [] }) as unknown as SidebarTask

beforeEach(() => {
  metaReads = 0
  unopenable.length = 0
  listedBySession.clear()
})
afterEach(() => jest.useRealTimers())

test('a listed session opens from the list, with no metadata read first', async () => {
  listedBySession.set('session-1', listed('session-1'))
  const { open, resumed } = harness()

  await open(row('session-1'))

  expect(metaReads).toBe(0)
  expect(resumed.map((meta) => [meta.sessionId, meta.provider, meta.cwd, meta.firstMessage])).toEqual([['session-1', 'claude-code', '/repo', 'Listed title']])
})

test('a listed session that is gone says why it does not open', async () => {
  listedBySession.set('session-1', listed('session-1'))
  const { open } = harness(async (meta) => { throw new SessionUnavailableError(meta.sessionId) })

  await open(row('session-1'))

  expect(unopenable).toEqual(['session-1'])
})

test('a row the pointer rests on reads its first page, for a short life; a row passed over does not', () => {
  jest.useFakeTimers()
  listedBySession.set('rested', listed('rested'))
  listedBySession.set('passed', listed('passed'))
  const { store, prefetched } = harness()

  store.restOn(row('passed'), true)
  jest.advanceTimersByTime(50)
  store.restOn(row('passed'), false)
  store.restOn(row('rested'), true)
  jest.advanceTimersByTime(100)

  expect(prefetched).toEqual([{ sessionId: 'rested', maxAgeMs: 10_000 }])
})

test('a running session is read on a rest, and the read serves the click only while that run goes on', () => {
  // WHY: the sessions a person watches are the running ones, and each open of
  // one waited for the host to read its page after the click. The watch at the
  // open replays the run at work, so a page read during that run stays whole;
  // a run that ends or starts before the click leaves the page stale.
  jest.useFakeTimers()
  listedBySession.set('busy', listed('busy', 'running'))
  const { store, prefetched, lives, executions } = harness()
  const working = { revision: 1, current: { runId: 'run-1', phase: 'running' as const, startedAt: 1 }, lastTurn: null }
  executions.set('busy', working)

  store.restOn(row('busy'), true)
  jest.advanceTimersByTime(200)

  expect(prefetched).toEqual([{ sessionId: 'busy', maxAgeMs: 10_000 }])
  const isCurrent = lives[0]!.isCurrent!
  executions.set('busy', { ...working, revision: 2, current: { ...working.current, phase: 'awaiting_input' } })
  expect(isCurrent()).toBe(true)
  executions.set('busy', { revision: 3, current: null, lastTurn: { runId: 'run-1', outcome: 'completed', startedAt: 1, endedAt: 2 } })
  expect(isCurrent()).toBe(false)
})
