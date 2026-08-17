import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { loadServers } from '../../src/client-core/server-registry'

const KEY = 'solus.servers'
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

function goodServer(id: string) {
  return {
    id,
    label: 'Dev box',
    url: `http://host-${id}.example`,
    sessionToken: 'token',
    installationId: `installation-${id}`,
    lastConnected: 1,
  }
}

describe('saved-server registry decoding', () => {
  test('an unreadable blob is deleted and treated as a miss', () => {
    // WHY: dispatch-client step 1 skew-safety — a poison blob used to be
    // re-parsed (and re-failed) on every boot, forever, while still holding
    // the key hostage.
    store.set(KEY, '{not json')
    expect(loadServers()).toEqual([])
    expect(store.has(KEY)).toBe(false)

    store.set(KEY, '"a string, not an array"')
    expect(loadServers()).toEqual([])
    expect(store.has(KEY)).toBe(false)
  })

  test('a record missing a load-bearing field drops alone', () => {
    // WHY: one bad record must not route a connection. The URL addresses the
    // host and the installation id proves that address still names that host.
    const broken = { id: 'broken', label: 'No url', sessionToken: 't', lastConnected: 2 }
    store.set(KEY, JSON.stringify([goodServer('a'), broken]))

    const servers = loadServers()

    expect(servers.map((server) => server.id)).toEqual(['a'])
    // Element-level failures do not delete durable credentials from storage.
    expect(store.has(KEY)).toBe(true)
  })

  test('a record from a newer build keeps its unknown fields and degrades bad optionals alone', () => {
    const newer = { ...goodServer('b'), os: 'freebsd', futureField: 'kept' }
    store.set(KEY, JSON.stringify([newer]))

    const [server] = loadServers()

    expect(server.id).toBe('b')
    expect(server.os).toBeUndefined()
    expect((server as unknown as { futureField?: string }).futureField).toBe('kept')
  })
})
