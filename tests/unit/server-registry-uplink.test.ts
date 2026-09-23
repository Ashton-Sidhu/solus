import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { DirectoryHost } from '@solus/contracts/uplink'
import { dialableRoutes, isCloudServer, loadServers, nextRouteUrl, savedServerRoutes, type SavedServer } from '@solus/client-core/server-registry'
import { mergeDirectoryIntoSaved, organizationIdFor, savedServerFromDirectory } from '@solus/client-core/uplink-session'

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

  test('the organization and owner of a shared host ride the merge, so the owner\'s share dialog can add people', () => {
    // WHY: docs/plans/multiplayer-sharing.md §4.1 — the owner connects as `local-owner`
    // and the host never names an organization; the directory row is the only place
    // the client learns which organization the host is shared with.
    const shared = listed({ organizationId: 'org-1', ownerName: 'Alice' })
    const merged = mergeDirectoryIntoSaved([paired()], [shared], DIRECTORY, 10)
    expect(merged[0].uplink).toEqual({ hostId: 'abcdefghijklmnop', directoryUrl: DIRECTORY, organizationId: 'org-1', ownerName: 'Alice' })
    expect(savedServerFromDirectory(shared, DIRECTORY, 10).uplink?.organizationId).toBe('org-1')
    // Stop sharing on the website: the next merge forgets the organization.
    expect(mergeDirectoryIntoSaved(merged, [listed()], DIRECTORY, 11)[0].uplink?.organizationId).toBeUndefined()

    expect(organizationIdFor(null, merged[0].uplink)).toBe('org-1')
    expect(organizationIdFor('org-from-host', merged[0].uplink)).toBe('org-from-host')
    expect(organizationIdFor(null, undefined)).toBeNull()
  })

  test('a managed host carries its kind and lifecycle through the merge, and the next directory read updates them', () => {
    // WHY: docs/plans/managed-hosts.md — the row is the client's only view of the
    // compute; a `stopped` host must read as stopped, not as an offline machine.
    const managed = listed({ installationId: 'managed:h1', hostId: 'managedhost000001', kind: 'managed', organizationId: 'org-1', managedState: 'provisioning' })
    const merged = mergeDirectoryIntoSaved([], [managed], DIRECTORY, 10)
    expect(merged[0].uplink).toEqual({ hostId: 'managedhost000001', directoryUrl: DIRECTORY, organizationId: 'org-1', kind: 'managed', managedState: 'provisioning' })
    const ready = mergeDirectoryIntoSaved(merged, [listed({ ...managed, managedState: 'ready' })], DIRECTORY, 11)
    expect(ready[0].uplink?.managedState).toBe('ready')
    // Saved and reloaded, the fields survive; a value this build does not know is dropped, not fatal.
    store.set(KEY, JSON.stringify([...ready, { ...ready[0], id: 'x', installationId: 'x', uplink: { ...ready[0].uplink, managedState: 'hibernating' } }]))
    const reloaded = loadServers()
    expect(reloaded[0].uplink?.kind).toBe('managed')
    expect(reloaded[1].uplink?.managedState).toBeUndefined()
  })

  test('a managed host takes the name members give it on the account site; a personal host keeps its saved one', () => {
    // WHY: a managed host's row reads its own name, and members rename it on Solus Cloud;
    // a rename there must reach every client, not stay frozen at first sight.
    const managed = listed({ installationId: 'managed:h1', hostId: 'managedhost000001', kind: 'managed', organizationId: 'org-1', label: 'Cloud host' })
    const first = mergeDirectoryIntoSaved([], [managed], DIRECTORY, 10)
    const renamed = mergeDirectoryIntoSaved(first, [{ ...managed, label: 'Build box' }], DIRECTORY, 11)
    expect(renamed[0].label).toBe('Build box')
    const personal = mergeDirectoryIntoSaved([paired({ label: 'Studio' })], [listed({ label: 'enrolled-name' })], DIRECTORY, 10)
    expect(personal[0].label).toBe('Studio')
  })

  test('a cloud row is the organization\'s workspace: named by the directory id, labelled by the organization, tunnel only, never paired', () => {
    // WHY: docs/plans/cloud-service-model.md — the workspace service is a host of
    // kind `cloud`. It is not a machine: no LAN route can reach it and no pairing
    // exists for it, so the directory row is its whole registry entry.
    const workspace = listed({
      hostId: 'workspace:org-1', installationId: 'workspace:org-1', label: 'Acme', kind: 'cloud', organizationId: 'org-1',
      os: undefined, routes: [{ kind: 'direct', url: 'http://10.0.0.1:1' }, { kind: 'tunnel', url: 'https://ws.example.test' }],
    })
    const merged = mergeDirectoryIntoSaved([paired()], [listed(), workspace], DIRECTORY, 10)
    const cloud = merged.find((server) => server.id === 'workspace:org-1')
    expect(cloud).toEqual({
      id: 'workspace:org-1', label: 'Acme', url: 'https://ws.example.test', sessionToken: '', installationId: 'workspace:org-1',
      lastConnected: 10, routes: [{ kind: 'tunnel', url: 'https://ws.example.test' }],
      uplink: { hostId: 'workspace:org-1', directoryUrl: DIRECTORY, organizationId: 'org-1', kind: 'cloud' },
    })
    expect(isCloudServer(cloud)).toBe(true)
    expect(isCloudServer(merged[0])).toBe(false)

    // The next read renames the organization and moves the tunnel: the row follows, and never
    // keeps a route or a pairing a stale save may have stamped on it.
    const stale = { ...cloud!, sessionToken: 'never', routes: [{ kind: 'direct' as const, url: 'http://lan' }, ...cloud!.routes] }
    const renamed = mergeDirectoryIntoSaved([stale], [{ ...workspace, label: 'Acme Corp', routes: [{ kind: 'tunnel', url: 'https://ws2.example.test' }] }], DIRECTORY, 11)
    expect(renamed[0]).toMatchObject({ id: 'workspace:org-1', label: 'Acme Corp', url: 'https://ws2.example.test', sessionToken: '', lastConnected: 10 })
    expect(renamed[0].routes).toEqual([{ kind: 'tunnel', url: 'https://ws2.example.test' }])

    // Gone from the directory (the account left the organization): the row goes with it, pairing or not.
    expect(mergeDirectoryIntoSaved([stale], [], DIRECTORY, 12)).toEqual([])
    expect(mergeDirectoryIntoSaved([cloud!, paired()], [], DIRECTORY, 12).map((server) => server.id)).toEqual(['inst-1'])
  })

  test('the directory\'s mark of the organization the account works in follows every read, and is never kept from a stale save', () => {
    // WHY: docs/plans/cloud-service-model.md §15 — the cloud-only boards read the
    // marked workspace alone; the account website moves the mark, so a row must
    // carry exactly what the last directory read said.
    const workspace = (organizationId: string, isActiveWorkspace?: boolean) => listed({
      hostId: `workspace:${organizationId}`, installationId: `workspace:${organizationId}`, label: organizationId, kind: 'cloud', organizationId,
      os: undefined, routes: [{ kind: 'tunnel', url: 'https://ws.example.test' }], ...(isActiveWorkspace ? { isActiveWorkspace } : {}),
    })
    const first = mergeDirectoryIntoSaved([], [workspace('org-a'), workspace('org-b', true)], DIRECTORY, 10)
    expect(first.map((server) => [server.id, server.uplink?.isActiveWorkspace ?? false])).toEqual([['workspace:org-a', false], ['workspace:org-b', true]])
    const switched = mergeDirectoryIntoSaved(first, [workspace('org-a', true), workspace('org-b')], DIRECTORY, 11)
    expect(switched.map((server) => [server.id, server.uplink?.isActiveWorkspace ?? false])).toEqual([['workspace:org-a', true], ['workspace:org-b', false]])
  })

  test('hosts from another directory origin are left alone', () => {
    const other = savedServerFromDirectory(listed({ installationId: 'inst-9', hostId: 'zzzzzzzzzzzzzzzz' }), 'https://other.example', 1)
    const merged = mergeDirectoryIntoSaved([other], [], DIRECTORY, 10)
    expect(merged).toEqual([other])
  })
})
