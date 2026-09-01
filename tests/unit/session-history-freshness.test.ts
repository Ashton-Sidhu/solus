import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { DomainSyncState } from '@solus/client-core/freshness'
import { SessionSnapshotCache } from '@solus/client-core/session-snapshot-cache'
import { SessionHistoryLoader, type SessionHistorySource } from '@solus/workspace-ui/lib/sessionPickerHistory'
import type { SessionMeta } from '@solus/contracts/types'

const previousLocalStorage = globalThis.localStorage
const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  })
})

afterEach(() => {
  if (previousLocalStorage === undefined) {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage
  } else {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: previousLocalStorage,
    })
  }
})

function meta(sessionId: string, index = 1): SessionMeta {
  return {
    provider: 'codex',
    sessionId,
    slug: null,
    firstMessage: sessionId,
    lastTimestamp: new Date(index * 1_000).toISOString(),
    size: index,
    cwd: '/repo',
    projectPath: '/repo',
  }
}

function loaderWith(
  cache: SessionSnapshotCache,
  listFor: (serverId: string) => () => Promise<SessionMeta[]>,
) {
  return new SessionHistoryLoader({
    hostFor: (serverId) => ({
      serverId,
      listSessions: listFor(serverId) as unknown as Window['solus']['listSessions'],
      onSessionScan: () => () => {},
    }),
    snapshotCache: cache,
  })
}

const sourceFor = (serverId: string): SessionHistorySource => ({
  id: `${serverId}:/repo`,
  projectPath: '/repo',
  serverId,
})

describe('session history freshness ladder', () => {
  test('one failed host keeps its cached rows and reports the error; the other host stays live', async () => {
    // WHY: dispatch-client step 2, aggregation decision 4 — connection health
    // and data sync are separate axes. A failed sync is that host's error
    // state, never the list's; cached rows render instead of vanishing.
    const cache = new SessionSnapshotCache()
    cache.saveSource('down', sourceFor('down'), [meta('down-old', 1)])

    const states = new Map<string, DomainSyncState>()
    const loader = loaderWith(cache, (serverId) =>
      serverId === 'down'
        ? async () => {
            throw new Error('socket lost')
          }
        : async () => [meta('up-1', 5)])

    const sessions = await loader.load({
      sources: [sourceFor('up'), sourceFor('down')],
      ctx: {} as never,
      onBatch: () => {},
      onHostState: (serverId, state) => states.set(serverId, state),
      limitPerProvider: 10,
    })

    expect(sessions.map((row) => row.sessionId).sort()).toEqual(['down-old', 'up-1'])
    expect(states.get('up')).toEqual({ freshness: 'live', error: null })
    expect(states.get('down')).toEqual({ freshness: 'cached', error: 'socket lost' })
  })

  test('a failed host with no cache is empty, not silently absent', async () => {
    const states = new Map<string, DomainSyncState>()
    const loader = loaderWith(new SessionSnapshotCache(), () => async () => {
      throw new Error('offline')
    })

    const sessions = await loader.load({
      sources: [sourceFor('down')],
      ctx: {} as never,
      onBatch: () => {},
      onHostState: (serverId, state) => states.set(serverId, state),
      limitPerProvider: 10,
    })

    expect(sessions).toEqual([])
    expect(states.get('down')).toEqual({ freshness: 'empty', error: 'offline' })
  })

  test('a successful scan writes the snapshot a later offline load will render', async () => {
    const cache = new SessionSnapshotCache()
    const loader = loaderWith(cache, () => async () => [meta('s1', 3)])

    await loader.load({
      sources: [sourceFor('host-a')],
      ctx: {} as never,
      onBatch: () => {},
      limitPerProvider: 10,
    })

    const cached = cache.cachedSessions('host-a', 'host-a:/repo')
    expect(cached.map((row) => row.sessionId)).toEqual(['s1'])
    expect(cached[0].serverId).toBe('host-a')
  })

  test('a cachedOnly source renders its snapshot without dialling the host', async () => {
    const cache = new SessionSnapshotCache()
    cache.saveSource('asleep', sourceFor('asleep'), [meta('asleep-1', 2)])

    let dialled = 0
    const states = new Map<string, DomainSyncState>()
    const loader = loaderWith(cache, () => async () => {
      dialled += 1
      return []
    })

    const sessions = await loader.load({
      sources: [{ ...sourceFor('asleep'), cachedOnly: true }],
      ctx: {} as never,
      onBatch: () => {},
      onHostState: (serverId, state) => states.set(serverId, state),
      limitPerProvider: 10,
    })

    expect(dialled).toBe(0)
    expect(sessions.map((row) => row.sessionId)).toEqual(['asleep-1'])
    expect(states.get('asleep')).toEqual({ freshness: 'cached', error: null })
  })
})
