import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SessionSnapshotCache } from '../../src/client-core/session-snapshot-cache'
import type { SessionMeta } from '../../src/shared/types'

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

function meta(sessionId: string, serverId?: string): SessionMeta {
  return {
    provider: 'codex',
    sessionId,
    slug: null,
    firstMessage: 'hello',
    lastTimestamp: new Date(1_000).toISOString(),
    size: 1,
    cwd: '/repo',
    projectPath: '/repo',
    ...(serverId ? { serverId } : {}),
  }
}

const source = { id: 'host-a:/repo', projectPath: '/repo', repoKey: 'github.com/me/repo' }

describe('session snapshot cache', () => {
  test('rows are stored naked and stamped with their host on read', () => {
    // WHY: dispatch-client step 2 — the cache is the last-known picture an
    // offline host renders under a `cached` state. The host is the key's
    // business, so a row can never carry a stale stamp from another read.
    const cache = new SessionSnapshotCache()
    cache.saveSource('host-a', source, [meta('s1', 'host-a')])

    const rows = cache.cachedSessions('host-a', source.id)

    expect(rows).toHaveLength(1)
    expect(rows[0].sessionId).toBe('s1')
    expect(rows[0].serverId).toBe('host-a')
    expect(store.get('solus.sessionHistory.v1.host-a')).not.toContain('"serverId"')
  })

  test('an unreachable host still names its last-known sources for a repo', () => {
    const cache = new SessionSnapshotCache()
    cache.saveSource('host-a', source, [meta('s1')])
    cache.saveSource('host-a', { id: 'host-a:/other', projectPath: '/other', repoKey: 'github.com/me/other' }, [meta('s2')])

    const sources = cache.cachedSourcesForRepoKeys('host-a', new Set(['github.com/me/repo']))

    expect(sources).toEqual([source])
  })

  test('a corrupt snapshot is deleted and treated as a miss', () => {
    const cache = new SessionSnapshotCache()
    store.set('solus.sessionHistory.v1.host-a', '{not json')

    expect(cache.cachedSessions('host-a', source.id)).toEqual([])
    expect(store.has('solus.sessionHistory.v1.host-a')).toBe(false)
  })

  test('an undecodable row drops alone; unknown fields survive', () => {
    const cache = new SessionSnapshotCache()
    store.set('solus.sessionHistory.v1.host-a', JSON.stringify({
      savedAt: 1,
      sources: [{
        id: source.id,
        projectPath: source.projectPath,
        sessions: [
          { ...meta('good'), futureField: 'kept' },
          { sessionId: 'no-provider' },
        ],
      }],
    }))

    const rows = cache.cachedSessions('host-a', source.id)

    expect(rows.map((row) => row.sessionId)).toEqual(['good'])
    expect((rows[0] as unknown as { futureField?: string }).futureField).toBe('kept')
  })

  test('forgetting a host is total', () => {
    const cache = new SessionSnapshotCache()
    cache.saveSource('host-a', source, [meta('s1')])
    cache.forgetHost('host-a')
    expect(cache.cachedSessions('host-a', source.id)).toEqual([])
  })
})
