import { describe, expect, test } from 'bun:test'
import type { DirectoryHost } from '@solus/contracts/uplink'
import { dialableRoutes } from '@solus/contracts/host-routes'
import { joinHosts, type CatalogAnswers } from '@solus/client-core/host-catalog'
import type { HostCredential } from '@solus/client-core/host-credentials'
import { pairedAddress, type KnownHost } from '@solus/client-core/known-host'
import { organizationIdFor } from '@solus/client-core/uplink-session'
import type { HostListing } from '@solus/contracts/host-list'
import { catalogOf, fakeDirectory, fakeList, memoryCredentials } from './helpers/host-catalog-world'

// docs/plans/personal-uplink.md C1 and plans/033 §4.1: the account's directory is
// joined by installation id with the person's list and this device's credentials.
// A pairing is never lost to the join, and a host the directory dropped keeps its pairing.

const DIRECTORY = 'https://app.example.test'
const tunnel = { kind: 'tunnel' as const, url: 'https://h-abc.example.test' }
const PAIRED_AT = 'http://192.168.1.42:3000'

const credential: HostCredential = { token: 'pairing-token', routes: [{ kind: 'lan', url: PAIRED_AT, source: 'pairing', seenAt: 1 }] }
const listing: HostListing = { id: 'inst-1', label: 'Studio Mac', installationId: 'inst-1', lastConnected: 1, routes: [{ kind: 'lan', url: PAIRED_AT, source: 'pairing', seenAt: 1 }] }

function listed(overrides: Partial<DirectoryHost> = {}): DirectoryHost {
  return { hostId: 'abcdefghijklmnop', installationId: 'inst-1', label: 'Studio Mac', os: 'macos', kind: 'personal', category: 'personal', routes: [tunnel], organizationIds: [], ...overrides }
}

/** The join with the answers this test names; the rest empty. */
function join(answers: { listings?: HostListing[]; directory?: DirectoryHost[]; credentials?: Record<string, HostCredential> }, now = 10, clientOrigin = ''): KnownHost[] {
  const full: CatalogAnswers = {
    listings: new Map((answers.listings ?? []).map((entry) => [entry.id, entry])),
    listState: 'ready',
    directory: answers.directory ? { directoryUrl: DIRECTORY, hosts: answers.directory, workspaces: [] } : null,
    credentials: new Map(Object.entries(answers.credentials ?? {})),
    learned: new Map(),
  }
  return joinHosts(full, now, clientOrigin)
}

/** A route as `<source> <url>`, so an assertion reads which source named which address. */
const named = (host: Pick<KnownHost, 'routes'>) => host.routes.map((route) => `${route.source} ${route.url}`)

describe('joining the directory', () => {
  test('a paired host that is also listed keeps its pairing and gains the tunnel', () => {
    const [host, ...rest] = join({ listings: [listing], directory: [listed()], credentials: { 'inst-1': credential } })
    expect(rest).toEqual([])
    expect(host!.sessionToken).toBe('pairing-token')
    expect(pairedAddress(host!)).toBe(PAIRED_AT)
    expect(named(host!)).toEqual([`directory ${tunnel.url}`, `pairing ${PAIRED_AT}`])
    // The paired address on the local network is dialed before the tunnel.
    expect(dialableRoutes(host!.routes, 'http://127.0.0.1:5173').map((route) => route.kind)).toEqual(['lan', 'tunnel'])
    expect(host!.uplink).toEqual({ hostId: 'abcdefghijklmnop', directoryUrl: DIRECTORY, kind: 'personal', category: 'personal' })
  })

  test('a host only the directory knows has the tunnel and no pairing', () => {
    const [host] = join({ directory: [listed()] })
    expect(host).toMatchObject({ id: 'inst-1', sessionToken: '', os: 'macos' })
    expect(pairedAddress(host!)).toBeNull()
    expect(host!.routes).toEqual([{ ...tunnel, source: 'directory', seenAt: 10 }])
  })

  test('a host the directory stops listing keeps its pairing and loses only the tunnel; one it never paired goes', () => {
    const [host] = join({ listings: [listing], directory: [], credentials: { 'inst-1': credential } })
    expect(host!.uplink).toBeUndefined()
    expect(named(host!)).toEqual([`pairing ${PAIRED_AT}`])
    expect(host!.sessionToken).toBe('pairing-token')
    expect(join({ directory: [] })).toEqual([])
  })

  test('the organizations and owner of a shared host ride the join, so the owner\'s share dialog can add people', () => {
    // WHY: docs/plans/multiplayer-sharing.md §4.1 — the owner connects as `local-owner`
    // and the host never names an organization; the directory row is the only place
    // the client learns which organizations the host is shared with (R15: several at once).
    const shared = listed({ organizationIds: ['org-1', 'org-2'], ownerName: 'Alice' })
    const [host] = join({ listings: [listing], directory: [shared], credentials: { 'inst-1': credential } })
    expect(host!.uplink).toEqual({ hostId: 'abcdefghijklmnop', directoryUrl: DIRECTORY, organizationIds: ['org-1', 'org-2'], category: 'personal', kind: 'personal', ownerName: 'Alice' })
    // Stop sharing on the website: the next join forgets the organizations.
    expect(join({ listings: [listing], directory: [listed()] })[0]!.uplink?.organizationIds).toBeUndefined()

    // The window's organization wins when the host is shared with it; else the first share stands.
    expect(organizationIdFor(null, host!.uplink)).toBe('org-1')
    expect(organizationIdFor(null, host!.uplink, 'org-2')).toBe('org-2')
    expect(organizationIdFor(null, host!.uplink, 'org-9')).toBe('org-1')
    expect(organizationIdFor('org-from-host', host!.uplink)).toBe('org-from-host')
    expect(organizationIdFor(null, undefined)).toBeNull()
  })

  test('a managed host takes its kind, lifecycle, route, and name from each directory read, never an older one', () => {
    // WHY: a managed host is listed with no route while it is set up and at its
    // machine's own name once it links; members rename it on Solus Cloud. Each read replaces the last.
    const machine = { kind: 'tunnel' as const, url: 'https://solus-h-1.sprites.test' }
    const provisioning = listed({ installationId: 'managed:h1', hostId: 'managedhost000001', kind: 'managed', category: 'managed', organizationIds: ['org-1'], managedState: 'provisioning', routes: [], label: 'Cloud host' })
    expect(join({ directory: [provisioning] })[0]).toMatchObject({ routes: [], uplink: { kind: 'managed', managedState: 'provisioning' } })
    const [ready] = join({ directory: [{ ...provisioning, managedState: 'ready', routes: [machine], label: 'Build box' }] })
    expect(ready).toMatchObject({ label: 'Build box', uplink: { managedState: 'ready' } })
    expect(ready!.routes.map((route) => route.url)).toEqual([machine.url])
    // A personal host keeps the name the person's list holds.
    expect(join({ listings: [{ ...listing, label: 'Studio' }], directory: [listed({ label: 'enrolled-name' })] })[0]!.label).toBe('Studio')
  })

  test('an https page (the account site) shows only directory hosts it can dial: it cannot dial a local address', () => {
    const notLinked = listed({ routes: [] })
    expect(join({ directory: [notLinked] }, 10, DIRECTORY)).toEqual([])
    expect(join({ directory: [notLinked] }, 10, 'app://solus')).toHaveLength(1)
    // Linked, it is shown; paired, it is kept; managed and stopped, it can still be started.
    expect(join({ directory: [listed()] }, 10, DIRECTORY)).toHaveLength(1)
    expect(join({ listings: [listing], directory: [notLinked], credentials: { 'inst-1': credential } }, 10, DIRECTORY)).toHaveLength(1)
    expect(join({ directory: [listed({ routes: [], kind: 'managed', category: 'managed', managedState: 'stopped' })] }, 10, DIRECTORY)).toHaveLength(1)
  })
})

describe('a scan of this client\'s networks gives every known host it finds a discovery route (docs/plans/host-routes.md D1)', () => {
  const nearby = { host: '192.168.1.50', port: 7777, name: 'Studio Mac', installationId: 'inst-1', source: 'lan' as const }
  const NEARBY_URL = 'http://192.168.1.50:7777'

  test('a directory host listed with no route gains the address the scan found, and keeps it through directory reads and a later link', async () => {
    // WHY: docs/adr/0001-standard-authentication.md §2.2 rule 9 — a registered host
    // that is not linked has no route in the directory; this client reaches it on its network.
    const directory = fakeDirectory(DIRECTORY)
    directory.answer([listed({ routes: [] })])
    const catalog = catalogOf({ credentials: memoryCredentials([]), directory })
    await catalog.useListSource(fakeList([], 'account').source)
    await catalog.refreshDirectory()
    expect(catalog.find('inst-1')!.routes).toEqual([])
    expect(catalog.applyDiscovered([nearby])).toBe(true)
    expect(named(catalog.find('inst-1')!)).toEqual([`discovery ${NEARBY_URL}`])
    // Nothing new: nothing changes.
    expect(catalog.applyDiscovered([nearby])).toBe(false)
    await catalog.refreshDirectory()
    expect(named(catalog.find('inst-1')!)).toEqual([`discovery ${NEARBY_URL}`])
    // Linked later: the tunnel is added and the found address stays.
    directory.answer([listed()])
    await catalog.refreshDirectory()
    expect(named(catalog.find('inst-1')!)).toEqual([`directory ${tunnel.url}`, `discovery ${NEARBY_URL}`])
  })

  test('a paired host keeps the found address in this device\'s credential, beside its pairing', async () => {
    const credentials = memoryCredentials([], { 'inst-1': credential })
    const catalog = catalogOf({ credentials, directory: null })
    await catalog.useListSource(fakeList([], 'host:local', [listing]).source)
    catalog.applyDiscovered([nearby])
    expect(named(catalog.find('inst-1')!)).toEqual([`discovery ${NEARBY_URL}`, `pairing ${PAIRED_AT}`])
    await Promise.resolve()
    expect(named(credentials.stored.get('inst-1')!)).toEqual([`discovery ${NEARBY_URL}`, `pairing ${PAIRED_AT}`])
    expect(catalog.applyDiscovered([{ ...nearby, installationId: 'someone-else' }])).toBe(false)
  })
})
