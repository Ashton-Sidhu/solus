import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { DirectoryHost } from '@solus/contracts/uplink'
import { dialableRoutes, loadServers, nextRouteUrl, savedServerRoutes, type SavedServer } from '@solus/client-core/server-registry'
import { mergeDirectoryIntoSaved, savedServerFromDirectory } from '@solus/client-core/uplink-session'

// docs/plans/personal-uplink.md C1: the account's directory is a fourth source of
// hosts, merged by installation id into what this device already saved. A pairing
// is never lost to the merge, and a host the directory dropped keeps its pairing.

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
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: previousLocalStorage })
  }
})

const DIRECTORY = 'https://app.example.test'
const tunnel = { kind: 'tunnel' as const, url: 'https://h-abc.example.test' }

function paired(overrides: Partial<SavedServer> = {}): SavedServer {
  return {
    id: 'inst-1', label: 'Studio Mac', url: 'http://192.168.1.42:3000', sessionToken: 'pairing-token',
    installationId: 'inst-1', lastConnected: 1, ...overrides,
  }
}

function listed(overrides: Partial<DirectoryHost> = {}): DirectoryHost {
  return { hostId: 'abcdefghijklmnop', installationId: 'inst-1', label: 'Studio Mac', os: 'macos', routes: [tunnel], ...overrides }
}

describe('saved hosts and their routes', () => {
  test('an entry saved before Uplink still has the one route its url names', () => {
    expect(savedServerRoutes(paired())).toEqual([{ kind: 'direct', url: 'http://192.168.1.42:3000' }])
  })

  test('direct routes are dialed before the tunnel, and an https page skips http ones', () => {
    // WHY: docs/plans/personal-uplink.md C3 — LAN traffic never leaves the LAN and an
    // Uplink host stays usable when Solus cloud is down; a browser refuses mixed content.
    const routes = [tunnel, { kind: 'direct' as const, url: 'http://192.168.1.42:3000' }]
    expect(dialableRoutes(routes, 'http://192.168.1.42:3000').map((route) => route.kind)).toEqual(['direct', 'tunnel'])
    expect(dialableRoutes(routes, 'https://app.example.test').map((route) => route.kind)).toEqual(['tunnel'])
  })

  test('after a failed dial the next route is tried, round-robin, so the direct route is found again', () => {
    const routes = [{ kind: 'direct' as const, url: 'http://192.168.1.42:3000' }, tunnel]
    expect(nextRouteUrl(routes, 'http://192.168.1.42:3000', 'http://x')).toBe(tunnel.url)
    expect(nextRouteUrl(routes, tunnel.url, 'http://x')).toBe('http://192.168.1.42:3000')
    expect(nextRouteUrl([tunnel], tunnel.url, 'http://x')).toBeNull()
  })

  test('old and new records decode side by side', () => {
    store.set(KEY, JSON.stringify([
      paired(),
      { ...paired({ id: 'inst-2', installationId: 'inst-2', url: tunnel.url, sessionToken: '' }), routes: [tunnel], uplink: { hostId: 'abcdefghijklmnop', directoryUrl: DIRECTORY } },
    ]))
    const servers = loadServers()
    expect(servers).toHaveLength(2)
    expect(servers[0].routes).toBeUndefined()
    expect(servers[1].uplink?.hostId).toBe('abcdefghijklmnop')
    expect(servers[1].routes).toEqual([tunnel])
  })
})

describe('merging the directory into saved hosts', () => {
  test('a paired host that is also listed keeps its pairing and gains the tunnel', () => {
    const merged = mergeDirectoryIntoSaved([paired()], [listed()], DIRECTORY, 10)
    expect(merged).toHaveLength(1)
    expect(merged[0].sessionToken).toBe('pairing-token')
    expect(merged[0].url).toBe('http://192.168.1.42:3000')
    expect(merged[0].routes?.map((route) => route.kind)).toEqual(['direct', 'tunnel'])
    expect(merged[0].uplink).toEqual({ hostId: 'abcdefghijklmnop', directoryUrl: DIRECTORY })
  })

  test('a host only the directory knows is saved with the tunnel and no pairing', () => {
    const merged = mergeDirectoryIntoSaved([], [listed()], DIRECTORY, 10)
    expect(merged).toEqual([savedServerFromDirectory(listed(), DIRECTORY, 10)])
    expect(merged[0].sessionToken).toBe('')
    expect(merged[0].url).toBe(tunnel.url)
    expect(merged[0].id).toBe('inst-1')
  })

  test('unlinking on the cloud drops the tunnel, and the row too when it was never paired', () => {
    const withPairing = mergeDirectoryIntoSaved([paired()], [listed()], DIRECTORY, 10)
    const afterUnlink = mergeDirectoryIntoSaved(withPairing, [], DIRECTORY, 11)
    expect(afterUnlink).toHaveLength(1)
    expect(afterUnlink[0].uplink).toBeUndefined()
    expect(afterUnlink[0].routes?.map((route) => route.kind)).toEqual(['direct'])
    expect(afterUnlink[0].sessionToken).toBe('pairing-token')

    const directoryOnly = mergeDirectoryIntoSaved([], [listed()], DIRECTORY, 10)
    expect(mergeDirectoryIntoSaved(directoryOnly, [], DIRECTORY, 11)).toEqual([])
  })

  test('hosts from another directory origin are left alone', () => {
    const other = savedServerFromDirectory(listed({ installationId: 'inst-9', hostId: 'zzzzzzzzzzzzzzzz' }), 'https://other.example', 1)
    const merged = mergeDirectoryIntoSaved([other], [], DIRECTORY, 10)
    expect(merged).toEqual([other])
  })
})
