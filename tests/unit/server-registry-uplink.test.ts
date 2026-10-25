import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { DirectoryHost } from '@solus/contracts/uplink'
import { dialableRoutes } from '@solus/contracts/host-routes'
import { loadServers, pairedAddress, type SavedServer } from '@solus/client-core/server-registry'
import { mergeDirectoryIntoSaved, organizationIdFor, savedServerFromDirectory, withDiscoveredRoutes } from '@solus/client-core/uplink-session'

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
const PAIRED_AT = 'http://192.168.1.42:3000'

function paired(overrides: Partial<SavedServer> = {}): SavedServer {
  return {
    id: 'inst-1', label: 'Studio Mac', sessionToken: 'pairing-token',
    routes: [{ kind: 'lan', url: PAIRED_AT, source: 'pairing', seenAt: 1 }],
    installationId: 'inst-1', lastConnected: 1, ...overrides,
  }
}

function listed(overrides: Partial<DirectoryHost> = {}): DirectoryHost {
  return { hostId: 'abcdefghijklmnop', installationId: 'inst-1', label: 'Studio Mac', os: 'macos', kind: 'personal', category: 'personal', routes: [tunnel], organizationIds: [], ...overrides }
}

/** A route as `<source> <url>`, so an assertion reads which source named which address. */
const named = (server: Pick<SavedServer, 'routes'>) => server.routes.map((route) => `${route.source} ${route.url}`)

describe('saved hosts and their routes', () => {
  test('a saved host decodes with each route and its source', () => {
    store.set(KEY, JSON.stringify([
      paired(),
      paired({ id: 'inst-2', installationId: 'inst-2', sessionToken: '', routes: [{ ...tunnel, source: 'directory', seenAt: 1 }], uplink: { hostId: 'abcdefghijklmnop', directoryUrl: DIRECTORY } }),
    ]))
    const servers = loadServers()
    expect(servers).toHaveLength(2)
    expect(pairedAddress(servers[0]!)).toBe(PAIRED_AT)
    expect(servers[1]!.uplink?.hostId).toBe('abcdefghijklmnop')
    expect(pairedAddress(servers[1]!)).toBeNull()
    expect(named(servers[1]!)).toEqual([`directory ${tunnel.url}`])
  })
})

describe('a scan of this client\'s networks gives every saved host it finds a discovery route (docs/plans/host-routes.md D1)', () => {
  const nearby = { host: '192.168.1.50', port: 7777, name: 'Studio Mac', installationId: 'inst-1', source: 'lan' as const }
  const NEARBY_URL = 'http://192.168.1.50:7777'

  test('a directory host listed with no route gains the address the scan found, and keeps it through directory reads and a later link', () => {
    // WHY: docs/adr/0001-standard-authentication.md §2.2 rule 9 — a registered host
    // that is not linked has no route in the directory; this client reaches it on its network.
    const directoryOnly = mergeDirectoryIntoSaved([], [listed({ routes: [] })], DIRECTORY, 10)
    expect(directoryOnly[0]!.routes).toEqual([])
    const found = withDiscoveredRoutes(directoryOnly, [nearby], 10)
    expect(found && named(found[0]!)).toEqual([`discovery ${NEARBY_URL}`])
    // Nothing new: nothing to save.
    expect(withDiscoveredRoutes(found!, [nearby], 11)).toBeNull()
    const reread = mergeDirectoryIntoSaved(found!, [listed({ routes: [] })], DIRECTORY, 11)
    expect(named(reread[0]!)).toEqual([`discovery ${NEARBY_URL}`])
    // Linked later: the tunnel is added and the found address stays. This changed:
    // the found address used to be dropped. `chooseRoute` now asks every route and
    // needs this host's installation id, so a stale address cannot win.
    const linked = mergeDirectoryIntoSaved(reread, [listed()], DIRECTORY, 12)
    expect(named(linked[0]!)).toEqual([`directory ${tunnel.url}`, `discovery ${NEARBY_URL}`])
    expect(dialableRoutes(linked[0]!.routes, 'http://127.0.0.1:5173').map((route) => route.url)).toEqual([NEARBY_URL, tunnel.url])
  })

  test('a paired host and a linked host also gain the found address, beside the routes they had', () => {
    // This changed: the scan used to skip a paired host and a linked host.
    const pairedFound = withDiscoveredRoutes([paired({ uplink: { hostId: 'abcdefghijklmnop', directoryUrl: DIRECTORY } })], [nearby], 10)
    expect(pairedFound && named(pairedFound[0]!)).toEqual([`discovery ${NEARBY_URL}`, `pairing ${PAIRED_AT}`])
    const linkedFound = withDiscoveredRoutes(mergeDirectoryIntoSaved([], [listed()], DIRECTORY, 10), [nearby], 10)
    expect(linkedFound && named(linkedFound[0]!)).toEqual([`discovery ${NEARBY_URL}`, `directory ${tunnel.url}`])
  })

  test('a host the scan did not find is left as it is', () => {
    expect(withDiscoveredRoutes([paired()], [{ ...nearby, installationId: 'someone-else' }], 10)).toBeNull()
  })

  test('an https page (the account site) shows only hosts it can dial: it cannot dial a local address', () => {
    const notLinked = listed({ routes: [] })
    expect(mergeDirectoryIntoSaved([], [notLinked], DIRECTORY, 10, DIRECTORY)).toEqual([])
    // A row saved before, on this page, goes on the next read.
    const saved = mergeDirectoryIntoSaved([], [notLinked], DIRECTORY, 10, 'app://solus')
    expect(saved).toHaveLength(1)
    expect(mergeDirectoryIntoSaved(saved, [notLinked], DIRECTORY, 11, DIRECTORY)).toEqual([])
    // Linked, it is shown; paired, it is kept; managed and stopped, it can still be started.
    expect(mergeDirectoryIntoSaved([], [listed()], DIRECTORY, 10, DIRECTORY)).toHaveLength(1)
    expect(mergeDirectoryIntoSaved([paired({ routes: [{ kind: 'lan', url: 'https://studio.example.test', source: 'pairing', seenAt: 1 }] })], [notLinked], DIRECTORY, 10, DIRECTORY)).toHaveLength(1)
    const stopped = listed({ routes: [], kind: 'managed', category: 'managed', managedState: 'stopped' })
    expect(mergeDirectoryIntoSaved([], [stopped], DIRECTORY, 10, DIRECTORY)).toHaveLength(1)
  })
})

describe('merging the directory into saved hosts', () => {
  test('a paired host that is also listed keeps its pairing and gains the tunnel', () => {
    const merged = mergeDirectoryIntoSaved([paired()], [listed()], DIRECTORY, 10)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.sessionToken).toBe('pairing-token')
    expect(pairedAddress(merged[0]!)).toBe(PAIRED_AT)
    expect(named(merged[0]!)).toEqual([`directory ${tunnel.url}`, `pairing ${PAIRED_AT}`])
    // The paired address on the local network is dialed before the tunnel.
    expect(dialableRoutes(merged[0]!.routes, 'http://127.0.0.1:5173').map((route) => route.kind)).toEqual(['lan', 'tunnel'])
    expect(merged[0]!.uplink).toEqual({ hostId: 'abcdefghijklmnop', directoryUrl: DIRECTORY, kind: 'personal', category: 'personal' })
  })

  test('a host only the directory knows is saved with the tunnel and no pairing', () => {
    const merged = mergeDirectoryIntoSaved([], [listed()], DIRECTORY, 10)
    expect(merged).toEqual([savedServerFromDirectory(listed(), DIRECTORY, 10)])
    expect(merged[0]!.sessionToken).toBe('')
    expect(pairedAddress(merged[0]!)).toBeNull()
    expect(merged[0]!.routes).toEqual([{ ...tunnel, source: 'directory', seenAt: 10 }])
    expect(merged[0]!.id).toBe('inst-1')
  })

  test('a host the directory stops listing (removed from the account) drops only the directory\'s routes, and the row too when it was never paired', () => {
    const withPairing = withDiscoveredRoutes(mergeDirectoryIntoSaved([paired()], [listed()], DIRECTORY, 10), [{ host: '192.168.1.50', port: 7777, name: 'Studio Mac', installationId: 'inst-1', source: 'lan' }], 10)!
    const afterUnlink = mergeDirectoryIntoSaved(withPairing, [], DIRECTORY, 11)
    expect(afterUnlink).toHaveLength(1)
    expect(afterUnlink[0]!.uplink).toBeUndefined()
    expect(named(afterUnlink[0]!)).toEqual(['discovery http://192.168.1.50:7777', `pairing ${PAIRED_AT}`])
    expect(afterUnlink[0]!.sessionToken).toBe('pairing-token')

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
    // machine's own name once it links. The client kept the first name and dialed it
    // first: the ready host was dialed at a name with no DNS record, and onboarding
    // waited forever. A directory read replaces the directory's earlier routes.
    const machine = { kind: 'tunnel' as const, url: 'https://solus-h-1.sprites.test' }
    // Solus Cloud lists a host being set up with no route; an older one listed the name early.
    const provisioning = listed({ installationId: 'managed:h1', kind: 'managed', category: 'managed', managedState: 'provisioning', routes: [] })
    expect(mergeDirectoryIntoSaved([], [provisioning], DIRECTORY, 10)[0]!.routes).toEqual([])
    const early = mergeDirectoryIntoSaved([], [{ ...provisioning, routes: [tunnel] }], DIRECTORY, 10)
    const linked = listed({ ...provisioning, managedState: 'ready', routes: [machine] })
    const ready = mergeDirectoryIntoSaved(early, [linked], DIRECTORY, 11)
    const again = mergeDirectoryIntoSaved(ready, [linked], DIRECTORY, 12)
    for (const server of [ready[0]!, again[0]!]) {
      expect(pairedAddress(server)).toBeNull()
      expect(server.routes.map((route) => route.url)).toEqual([machine.url])
    }
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

  test('hosts from another directory origin are left alone', () => {
    const other = savedServerFromDirectory(listed({ installationId: 'inst-9', hostId: 'zzzzzzzzzzzzzzzz' }), 'https://other.example', 1)
    const merged = mergeDirectoryIntoSaved([other], [], DIRECTORY, 10)
    expect(merged).toEqual([other])
  })
})
