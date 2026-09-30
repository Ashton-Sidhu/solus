import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { DirectoryHost } from '@solus/contracts/uplink'
import { dialableRoutes, loadServers, nextRouteUrl, savedServerRoutes, type SavedServer } from '@solus/client-core/server-registry'
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
  return { hostId: 'abcdefghijklmnop', installationId: 'inst-1', label: 'Studio Mac', os: 'macos', kind: 'personal', category: 'personal', routes: [tunnel], organizationIds: [], ...overrides }
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
    expect(merged[0].uplink).toEqual({ hostId: 'abcdefghijklmnop', directoryUrl: DIRECTORY, kind: 'personal', category: 'personal' })
  })

  test('a host only the directory knows is saved with the tunnel and no pairing', () => {
    const merged = mergeDirectoryIntoSaved([], [listed()], DIRECTORY, 10)
    expect(merged).toEqual([savedServerFromDirectory(listed(), DIRECTORY, 10)])
    expect(merged[0].sessionToken).toBe('')
    expect(merged[0].url).toBe('')
    expect(savedServerRoutes(merged[0])).toEqual([tunnel])
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

  test('the organizations and owner of a shared host ride the merge, so the owner\'s share dialog can add people', () => {
    // WHY: docs/plans/multiplayer-sharing.md §4.1 — the owner connects as `local-owner`
    // and the host never names an organization; the directory row is the only place
    // the client learns which organizations the host is shared with (R15: several at once).
    const shared = listed({ organizationIds: ['org-1', 'org-2'], ownerName: 'Alice', category: 'personal' })
    const merged = mergeDirectoryIntoSaved([paired()], [shared], DIRECTORY, 10)
    expect(merged[0].uplink).toEqual({ hostId: 'abcdefghijklmnop', directoryUrl: DIRECTORY, organizationIds: ['org-1', 'org-2'], category: 'personal', kind: 'personal', ownerName: 'Alice' })
    expect(savedServerFromDirectory(shared, DIRECTORY, 10).uplink?.organizationIds).toEqual(['org-1', 'org-2'])
    // Stop sharing on the website: the next merge forgets the organizations.
    expect(mergeDirectoryIntoSaved(merged, [listed()], DIRECTORY, 11)[0].uplink?.organizationIds).toBeUndefined()

    // The window's organization wins when the host is shared with it; else the first share stands.
    expect(organizationIdFor(null, merged[0].uplink)).toBe('org-1')
    expect(organizationIdFor(null, merged[0].uplink, 'org-2')).toBe('org-2')
    expect(organizationIdFor(null, merged[0].uplink, 'org-9')).toBe('org-1')
    expect(organizationIdFor('org-from-host', merged[0].uplink)).toBe('org-from-host')
    expect(organizationIdFor(null, undefined)).toBeNull()
  })

  test('a managed host carries its kind and lifecycle through the merge, and the next directory read updates them', () => {
    // WHY: docs/plans/managed-hosts.md — the row is the client's only view of the
    // compute; a `stopped` host must read as stopped, not as an offline machine.
    const managed = listed({ installationId: 'managed:h1', hostId: 'managedhost000001', kind: 'managed', category: 'managed', organizationIds: ['org-1'], managedState: 'provisioning' })
    const merged = mergeDirectoryIntoSaved([], [managed], DIRECTORY, 10)
    expect(merged[0].uplink).toEqual({ hostId: 'managedhost000001', directoryUrl: DIRECTORY, organizationIds: ['org-1'], kind: 'managed', category: 'managed', managedState: 'provisioning' })
    const ready = mergeDirectoryIntoSaved(merged, [listed({ ...managed, managedState: 'ready' })], DIRECTORY, 11)
    expect(ready[0].uplink?.managedState).toBe('ready')
    // Saved and reloaded, the fields survive; a value this build does not know is dropped, not fatal.
    store.set(KEY, JSON.stringify([...ready, { ...ready[0], id: 'x', installationId: 'x', uplink: { ...ready[0].uplink, managedState: 'hibernating' } }]))
    const reloaded = loadServers()
    expect(reloaded[0].uplink?.kind).toBe('managed')
    expect(reloaded[1].uplink?.managedState).toBeUndefined()
  })

  test('a host only the directory knows follows its route when it changes, and never keeps the old one', () => {
    // WHY: a managed host is listed at `h-….solus.sh` while it is set up and at its
    // machine's own name once it links. The saved `url` kept the first name, a later
    // merge turned it into a direct route, and a direct route is dialed first: the
    // ready host was dialed at a name with no DNS record, and onboarding waited forever.
    const machine = { kind: 'tunnel' as const, url: 'https://solus-h-1.sprites.test' }
    // Solus Cloud lists a host being set up with no route; an older one listed the name early.
    const provisioning = listed({ installationId: 'managed:h1', kind: 'managed', category: 'managed', managedState: 'provisioning', routes: [] })
    expect(savedServerRoutes(mergeDirectoryIntoSaved([], [provisioning], DIRECTORY, 10)[0])).toEqual([])
    const early = mergeDirectoryIntoSaved([], [{ ...provisioning, routes: [tunnel] }], DIRECTORY, 10)
    const linked = listed({ ...provisioning, managedState: 'ready', routes: [machine] })
    const ready = mergeDirectoryIntoSaved(early, [linked], DIRECTORY, 11)
    const again = mergeDirectoryIntoSaved(ready, [linked], DIRECTORY, 12)
    for (const server of [ready[0], again[0]]) {
      expect(server.url).toBe('')
      expect(savedServerRoutes(server)).toEqual([machine])
    }
    // A saved row the old merge already spoiled heals on the next read.
    const spoiled = { ...again[0], url: tunnel.url, routes: [{ kind: 'direct' as const, url: tunnel.url }, machine] }
    expect(savedServerRoutes(mergeDirectoryIntoSaved([spoiled], [linked], DIRECTORY, 13)[0])).toEqual([machine])
  })

  test('a managed host takes the name members give it on the account site; a personal host keeps its saved one', () => {
    // WHY: a managed host's row reads its own name, and members rename it on Solus Cloud;
    // a rename there must reach every client, not stay frozen at first sight.
    const managed = listed({ installationId: 'managed:h1', hostId: 'managedhost000001', kind: 'managed', category: 'managed', organizationIds: ['org-1'], label: 'Cloud host' })
    const first = mergeDirectoryIntoSaved([], [managed], DIRECTORY, 10)
    const renamed = mergeDirectoryIntoSaved(first, [{ ...managed, label: 'Build box' }], DIRECTORY, 11)
    expect(renamed[0].label).toBe('Build box')
    const personal = mergeDirectoryIntoSaved([paired({ label: 'Studio' })], [listed({ label: 'enrolled-name' })], DIRECTORY, 10)
    expect(personal[0].label).toBe('Studio')
  })

  test('a workspace service saved as a host by an older build is not read as a machine', () => {
    // WHY: a workspace service is a cloud service, never a host. Read as a
    // machine it would be dialed, listed, and offered as a place to run work.
    localStorage.setItem(KEY, JSON.stringify([
      paired(),
      {
        id: 'workspace:org-1', label: 'Acme', url: 'https://ws.example.test', sessionToken: '', installationId: 'workspace:org-1', lastConnected: 1,
        uplink: { hostId: 'workspace:org-1', directoryUrl: DIRECTORY, kind: 'cloud', organizationIds: ['org-1'] },
      },
    ]))
    expect(loadServers().map((server) => server.id)).toEqual(['inst-1'])
  })

  test('hosts from another directory origin are left alone', () => {
    const other = savedServerFromDirectory(listed({ installationId: 'inst-9', hostId: 'zzzzzzzzzzzzzzzz' }), 'https://other.example', 1)
    const merged = mergeDirectoryIntoSaved([other], [], DIRECTORY, 10)
    expect(merged).toEqual([other])
  })
})
