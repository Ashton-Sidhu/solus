import { afterAll, afterEach, beforeEach, expect, jest, mock, test } from 'bun:test'
import type { SessionMeta } from '@solus/contracts/types'
import type { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'

// WHY: a click on a listed session read its metadata, a round trip, before the
// open began, though the list already holds what the open needs. And a page
// read only at the click costs a round trip that a rest on the row can hide.

const workspaceUi = '../../packages/workspace-ui/src'
let metaReads = 0
const unopenable: string[] = []
const listedBySession = new Map<string, unknown>()

mock.module('@solus/client-core/session-meta', () => ({
  readSessionMeta: async () => { metaReads++; return null },
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
  const store = Object.create(SidebarStoreClass.prototype) as SessionSidebarStore
  Object.defineProperty(store, 'session', {
    value: {
      opening: {
        resumeSession: (meta: SessionMeta) => { resumed.push(meta); return resume(meta) },
        prefetchFirstPage: (meta: { sessionId: string }, maxAgeMs?: number) => prefetched.push({ sessionId: meta.sessionId, maxAgeMs }),
      },
    },
  })
  const open = (row: SidebarTask) => (store as unknown as { openListedSession(row: SidebarTask): Promise<void> }).openListedSession(row)
  return { store, open, resumed, prefetched }
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

test('a running session is not read on a rest: it changes while the reader decides', () => {
  jest.useFakeTimers()
  listedBySession.set('busy', listed('busy', 'running'))
  const { store, prefetched } = harness()

  store.restOn(row('busy'), true)
  jest.advanceTimersByTime(200)

  expect(prefetched).toEqual([])
})
