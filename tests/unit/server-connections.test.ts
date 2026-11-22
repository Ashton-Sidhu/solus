import { describe, expect, mock, test } from 'bun:test'
import type { SolusServerTarget } from '@solus/client-core/server-connection'
import { installationIdDecision, type KnownHost } from '@solus/client-core/known-host'
import type { HostCredential } from '@solus/client-core/host-credentials'
import type { HostCatalog } from '@solus/client-core/host-catalog'
import type { HostListing } from '@solus/contracts/host-list'
import { DEFAULT_HOST_RULES, solusApiId, type DirectoryHost } from '@solus/contracts/uplink'
import { catalogOf, fakeDirectory, fakeList, memoryCredentials } from './helpers/host-catalog-world'
import type { WsTransport } from '@solus/client-core/ws-transport'
import type { SolusAPI } from '../../src/preload'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import { dialableRoutes, type HostRoute } from '@solus/contracts/host-routes'
import { identityKeyFor } from './helpers/signing-host'

function preferredRouteUrl(server: { routes: HostRoute[] }, clientOrigin: string): string {
  return dialableRoutes(server.routes, clientOrigin)[0]?.url ?? ''
}

const startedTransports: string[] = []
const destroyedTransports: string[] = []
const switchedUrls: string[] = []
/** Makes a connection's transport blocked on a refused credential, as a host that refused it does. */
const blockTransports = new Map<string, () => void>()
const capabilityLoaders = new Map<string, () => Promise<unknown>>()
const infoLoaders = new Map<string, () => Promise<ConnectionsServerInfo>>()
const identityLoaders = new Map<string, SolusAPI['listProjectIdentities']>()
mock.module('@solus/client-core/device-label', () => ({ defaultDeviceLabel: () => 'Test desktop' }))

// A real transport opens a socket and reads browser lifecycle globals; the
// behavior under test is only when a connection's side effects run.
mock.module('@solus/client-core/server-connection', () => ({
  createSolusConnection: (target: SolusServerTarget, options?: { catalog?: HostCatalog }) => {
    const heldToken = () => options?.catalog?.sessionTokenOf(target.id) ?? ''
    let blockedToken: string | null = null
    blockTransports.set(target.id, () => { blockedToken = heldToken() })
    const transport = {
      events: { subscribe: () => () => {} },
      serverUrl: target.url,
      start: () => {
        blockedToken = null
        startedTransports.push(target.id)
      },
      probe: async () => {},
      attachDialOutcomeReporter: () => {},
      switchServerUrl: (url: string) => {
        transport.serverUrl = url
        switchedUrls.push(`${target.id}:${url}`)
      },
      hasUntriedSessionToken: () => blockedToken !== null && !!heldToken() && heldToken() !== blockedToken,
      destroy: () => destroyedTransports.push(target.id),
    }
    const api = {
      serverGetCapabilities: () => capabilityLoaders.get(target.id)?.() ?? Promise.resolve({}),
      connectionsGetServerInfo: () => infoLoaders.get(target.id)!(),
      listProjectIdentities: () => identityLoaders.get(target.id)!(),
    }
    return { transport: transport as unknown as WsTransport, api: api as unknown as SolusAPI, events: transport.events }
  },
  // As the real one: every fact is read from the catalog when asked; only `url` is the connection's own.
  catalogHostTarget: (catalog: HostCatalog, server: KnownHost): SolusServerTarget => {
    const current = () => catalog.find(server.id) ?? server
    return {
      id: server.id,
      url: server.local ? server.routes[0]?.url ?? '' : preferredRouteUrl(server, ''),
      get label() { return current().label },
      get installationId() { return current().installationId },
      get local() { return !!current().local },
      get routes() { return current().local ? [] : current().routes },
      get uplink() { return current().uplink },
      get identityKey() { return current().identityKey },
    }
  },
  preferredRouteUrl,
}))

const { ServerConnections } = await import('@solus/client-core/server-connections')

/** A catalog that answered: the list, the directory, and this device's credentials (plans/033). */
async function catalogWith(input: { listings?: HostListing[]; credentials?: Record<string, HostCredential>; directory?: DirectoryHost[] }) {
  const directory = fakeDirectory('https://app.solus.test')
  directory.answer(input.directory ?? [])
  const catalog = catalogOf({ credentials: memoryCredentials([], input.credentials), directory })
  await catalog.useListSource(fakeList([], 'account', input.listings ?? []).source)
  await catalog.refreshDirectory()
  return { catalog, directory }
}

const managedRow = (managedState: DirectoryHost['managedState'], url = 'https://h-cloud.solus.test'): DirectoryHost => ({
  hostId: 'h_cloud', installationId: 'managed:h_cloud', label: 'Cloud · Acme', kind: 'managed', category: 'managed', organizationIds: ['org-1'],
  managedState, routes: [{ kind: 'tunnel', url }],
})

const remoteHost: KnownHost = { id: 'remote', label: 'Remote', installationId: 'remote', sessionToken: 'token', lastConnected: 1, routes: [{ kind: 'tunnel', url: 'https://remote.example' }] }
const localMachine = (installationId: string): KnownHost => ({ id: 'local', label: 'This Mac', installationId, sessionToken: 'local-token', lastConnected: 0, routes: [{ kind: 'lan', url: 'http://127.0.0.1:3000' }], local: true })

/** A registry over its own catalog that knows `hosts` for this page only. */
function connectionsWith(...hosts: KnownHost[]) {
  const catalog = catalogOf({ credentials: memoryCredentials([]), directory: null })
  for (const host of hosts) catalog.addPageHost(host)
  return new ServerConnections(catalog)
}

describe('saved server identity', () => {
  test('distinguishes a match from an address that now reaches another host', () => {
    expect(installationIdDecision('reported', 'reported')).toBe('match')
    expect(installationIdDecision('saved', 'reported')).toBe('mismatch')
  })

  test('a managed host is proven by its grant, not by the id its server made for itself', () => {
    const managed = { hostId: 'bills', directoryUrl: 'https://app.solus.sh', kind: 'managed' as const, category: 'managed' as const, organizationIds: ['org'], managedState: 'ready' as const }
    expect(installationIdDecision('managed:bills', 'a37b55ff', managed)).toBe('match')
    expect(installationIdDecision('inst-a', 'someone-else', { ...managed, kind: 'personal', category: 'personal' })).toBe('mismatch')
  })
})

describe('lazily created connections', () => {
  test('a forgotten host closes its live connection, even while a tab holds it', async () => {
    // WHY: a socket that stayed open after its host was forgotten kept the host in
    // the Run on picker, online, under the name it reports.
    const credentials = memoryCredentials([])
    const catalog = catalogOf({ credentials, directory: null })
    await catalog.useListSource(fakeList([], 'host:local').source)
    await catalog.refreshDirectory()
    const connections = new ServerConnections(catalog)
    connections.startCatalogSupervisors()
    await catalog.pair({ id: 'windows', installationId: 'windows', label: 'Windows', routes: [{ kind: 'lan', url: 'https://windows.test' }], sessionToken: 'token', lastConnected: 1 })
    connections.retain('windows')
    expect(connections.serverIds()).toContain('windows')

    await catalog.forget('windows')

    expect(destroyedTransports).toContain('windows')
    expect(connections.serverIds()).not.toContain('windows')
    expect(connections.connectionFor('windows')?.presence).toBe('gone')
    connections.unretain('windows')
  })

  test('a host a settled read no longer names closes; nothing closes while a read is in progress', async () => {
    // WHY: the catalog is the one answer to which hosts exist. A host that left it must
    // not live on through its socket, but a list moving to another source (a sign-in)
    // names no host until it is read, and must not cut every working session.
    const listing: HostListing = { id: 'studio', label: 'Studio', installationId: 'studio', lastConnected: 1, routes: [{ kind: 'tunnel', url: 'https://studio.test' }] }
    const catalog = catalogOf({ credentials: memoryCredentials([]), directory: null })
    const list = fakeList([], 'host:local', [listing])
    await catalog.useListSource(list.source)
    const connections = new ServerConnections(catalog)
    connections.startCatalogSupervisors()
    expect(connections.connectionFor('studio')?.presence).toBe('present')

    // The directory has not answered yet: the read is not settled.
    list.state.listings.delete('studio')
    await catalog.refreshList()
    expect(connections.connectionFor('studio')?.presence).toBe('present')

    await catalog.refreshDirectory()
    expect(connections.connectionFor('studio')?.presence).toBe('gone')
    expect(connections.serverIds()).not.toContain('studio')
  })

  test('a refused host listed before client pairing dials with the token the pairing saves, on the same connection', async () => {
    // WHY: the transport reads the catalog's token at each dial. A pairing that ends after
    // the connection was made must reach it without a reload, and must not add a second row.
    const row: HostListing = { id: 'windows-live', installationId: 'windows-live', label: 'Windows', routes: [{ kind: 'lan', url: 'https://windows.test' }], lastConnected: 1 }
    const credentials = memoryCredentials([])
    const catalog = catalogOf({ credentials })
    const list = fakeList([], 'host:local')
    await catalog.useListSource(list.source)
    const connections = new ServerConnections(catalog)
    const observedHosts: string[][] = []
    catalog.onChange(() => observedHosts.push(catalog.hosts().map((host) => host.id)))
    connections.startCatalogSupervisors()
    try {
      // The server saved the chat pairing and announced the listing before this device got its token.
      list.state.listings.set(row.id, row)
      list.state.onChange?.()
      await catalog.refreshList()
      await Promise.resolve()
      const connection = connections.connectionFor(row.id)!
      blockTransports.get(row.id)!()

      await catalog.pair({ ...row, sessionToken: 'new-client-token', identityKey: identityKeyFor('windows-live') })

      expect(connections.connectionFor(row.id)).toBe(connection)
      expect(connection.target.identityKey).toBe(identityKeyFor('windows-live'))
      expect(startedTransports.filter((id) => id === row.id)).toHaveLength(2)
      expect(credentials.stored.get(row.id)?.token).toBe('new-client-token')
      expect(list.state.listings.get(row.id)?.identityKey).toBe(identityKeyFor('windows-live'))
      expect(observedHosts.at(-1)).toEqual([row.id])
    } finally { connections.release(row.id) }
  })

  test('a managed connection ignores internal routes even when its target contains them', async () => {
    const serverId = 'managed-internal-route'
    const tunnelUrl = 'https://managed.solus.test'
    const connections = connectionsWith({
      id: serverId, label: 'Managed', installationId: serverId, sessionToken: '', lastConnected: 0,
      routes: [{ kind: 'lan', url: 'http://10.0.0.1:3000', source: 'host' }, { kind: 'tunnel', url: tunnelUrl }],
      uplink: { hostId: 'managed', directoryUrl: 'https://app.solus.test', kind: 'managed', managedState: 'ready' },
    })
    try {
      connections.apiFor(serverId)
      await Promise.resolve()
      expect(connections.connectionFor(serverId)?.transport.serverUrl).toBe(tunnelUrl)
    } finally {
      connections.release(serverId)
    }
  })

  test('does not connect to a known alias for the local installation', async () => {
    startedTransports.length = 0
    const { catalog } = await catalogWith({ directory: [{ hostId: 'h_local', installationId: 'local-installation', label: 'This Mac through Uplink', kind: 'personal', category: 'personal', organizationIds: [], routes: [{ kind: 'tunnel', url: 'https://local.example' }] }] })
    catalog.addPageHost(localMachine('local-installation'))
    const connections = new ServerConnections(catalog)

    try {
      connections.startCatalogSupervisors()
      await Promise.resolve()
      expect(connections.serverIds()).toEqual(['local'])
      expect(startedTransports).toEqual(['local'])
    } finally {
      connections.release('local')
    }
  })

  test('dials a managed host only once the directory calls it ready', async () => {
    // WHY: a dial during provisioning looked up a tunnel name that did not resolve
    // yet; the network's resolver kept that "no such name" answer, and the ready host
    // stayed unreachable (Offline) from that network for up to 30 minutes (2026-09-23).
    startedTransports.length = 0
    const { catalog, directory } = await catalogWith({ directory: [managedRow('provisioning')] })
    const connections = new ServerConnections(catalog)
    connections.startCatalogSupervisors()
    await Promise.resolve()
    expect(startedTransports).toEqual([])

    // The directory read that says `ready` dials it: the connections follow the catalog.
    directory.answer([managedRow('ready')])
    await catalog.refreshDirectory()
    await Promise.resolve()
    expect(startedTransports).toEqual(['managed:h_cloud'])
    connections.release('managed:h_cloud')
  })

  test('a live connection follows the route the directory gives a managed host once it links', async () => {
    // WHY: a managed host is listed at `h-….solus.sh` while it is set up and at its
    // machine's name once ready. The connection kept the routes it was made with, so
    // onboarding dialed a name with no DNS record until its wait ran out.
    startedTransports.length = 0
    switchedUrls.length = 0
    const { catalog, directory } = await catalogWith({ directory: [managedRow('provisioning')] })
    const connections = new ServerConnections(catalog)
    try {
      connections.startCatalogSupervisors()
      await Promise.resolve()
      expect(switchedUrls).toEqual([])

      const machine = 'https://solus-h-cloud.sprites.test'
      directory.answer([managedRow('ready', machine)])
      await catalog.refreshDirectory()
      await Promise.resolve()
      expect(switchedUrls).toEqual([`managed:h_cloud:${machine}`])
      expect(connections.ensure('managed:h_cloud').target.url).toBe(machine)
      expect(startedTransports).toEqual(['managed:h_cloud'])

      // A read that changes nothing does not re-aim the socket.
      await catalog.refreshDirectory()
      expect(switchedUrls).toHaveLength(1)
    } finally {
      connections.release('managed:h_cloud')
    }
  })

  test('a host away from its network is dialed on its tunnel first, not after a dead direct route', async () => {
    // WHY: routes were tried one at a time, so a dead local address cost a ticket
    // timeout on every dial and was sent the credential (T3 Code #15467).
    startedTransports.length = 0
    switchedUrls.length = 0
    const direct = 'http://10.0.0.9:51234'
    const tunnel = 'https://studio.tunnel.solus.test'
    const { catalog } = await catalogWith({
      // The key lets the http route be asked: without it a credential could never go there.
      listings: [{ id: 'studio', label: 'Studio', installationId: 'inst-studio', lastConnected: 1, routes: [], identityKey: identityKeyFor('inst-studio') }],
      directory: [{ hostId: 'h_studio', installationId: 'inst-studio', label: 'Studio', kind: 'personal', category: 'personal', organizationIds: [], routes: [{ kind: 'lan', url: direct }, { kind: 'tunnel', url: tunnel }] }],
    })
    const healthAsked: string[] = []
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      // The http route is asked with a nonce for the host to sign.
      const url = String(input).split('?')[0]!
      healthAsked.push(url)
      if (url !== `${tunnel}/health`) throw new Error('unreachable')
      return new Response(JSON.stringify({ ok: true, installationId: 'inst-studio', name: 'Studio' }), { status: 200 })
    }) as typeof fetch
    const connections = new ServerConnections(catalog)
    try {
      connections.startCatalogSupervisors()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(healthAsked.sort()).toEqual([`${direct}/health`, `${tunnel}/health`])
      expect(switchedUrls).toEqual([`studio:${tunnel}`])
      expect(startedTransports).toEqual(['studio'])
    } finally {
      connections.release('studio')
      globalThis.fetch = previousFetch
    }
  })

  test('defers listeners and the socket out of the caller\'s frame', async () => {
    // `ensure()` is reached from derived renderer state, where writing Svelte
    // state throws. Nothing reactive may fire before the caller's frame ends.
    startedTransports.length = 0
    const connections = connectionsWith(remoteHost)
    const statuses: string[] = []
    const created: string[] = []
    connections.onReadinessChange((serverId, readiness) => statuses.push(`${serverId}:${readiness}`))
    connections.onConnectionCreated((connection) => created.push(connection.serverId))

    const connection = connections.ensure('remote')
    expect(connection.api).toBeDefined()
    expect(statuses).toEqual([])
    expect(created).toEqual([])

    await Promise.resolve()
    expect(created).toEqual(['remote'])
    expect(statuses).toEqual(['remote:checking'])
    connections.release('remote')
  })

  test('never opens a socket for a connection released in that same frame', async () => {
    // WHY: only a service outside the window's organization is borrowed; a borrower's
    // release must not leave a socket nobody owns. Every catalog host stays held.
    startedTransports.length = 0
    destroyedTransports.length = 0
    const directory = fakeDirectory('https://app.solus.test')
    const workspace = (organizationId: string, isActive: boolean) => ({ organizationId, label: organizationId, routes: [{ kind: 'tunnel' as const, url: `https://${organizationId}.solus.test` }], isActive, hostRules: DEFAULT_HOST_RULES })
    directory.answer([], [workspace('org-a', true), workspace('org-b', false)])
    const catalog = catalogOf({ credentials: memoryCredentials([]), directory })
    await catalog.refreshDirectory()
    const connections = new ServerConnections(catalog)
    const borrowed = solusApiId('org-b')

    connections.ensure(borrowed)
    connections.release(borrowed)
    await Promise.resolve()

    expect(startedTransports).toEqual([])
    expect(destroyedTransports).toEqual([borrowed])
  })
})

describe('primary server connection ownership', () => {
  test('destroys a displaced transport when reconnecting to the same host', () => {
    const connections = new ServerConnections()
    const destroyed: string[] = []
    const first = {
      events: { subscribe: () => () => {} },
      destroy: () => destroyed.push('first'),
      attachDialOutcomeReporter: () => {},
    } as unknown as WsTransport
    const second = {
      events: { subscribe: () => () => {} },
      destroy: () => destroyed.push('second'),
      attachDialOutcomeReporter: () => {},
    } as unknown as WsTransport
    const api = {} as SolusAPI
    const host: KnownHost = { id: 'server', label: 'Server', installationId: 'server', sessionToken: 'token', lastConnected: 0, routes: [{ kind: 'tunnel', url: 'https://server.example' }] }

    connections.registerPrimary('server', api, first, host)
    connections.registerPrimary('server', api, second, host)

    expect(destroyed).toEqual(['first'])
    expect(connections.connectionFor('server')?.transport).toBe(second)
  })
})

describe('session-scoped host capabilities', () => {
  test('one load answers every caller for the session; unknown keys are dropped', async () => {
    // WHY: dispatch-client step 3 — capabilities are session-scoped. Many
    // mounted surfaces share one load, and no TTL ever refetches behind the
    // session's back.
    let calls = 0
    capabilityLoaders.set('cap-session', async () => {
      calls++
      return { attachUpload: true, futureFlag: true }
    })
    const connections = connectionsWith({ ...remoteHost, id: 'cap-session', installationId: 'cap-session' })

    try {
      expect(await connections.capabilitiesFor('cap-session')).toEqual({ attachUpload: true })
      expect(await connections.capabilitiesFor('cap-session')).toEqual({ attachUpload: true })
      expect(calls).toBe(1)
    } finally {
      capabilityLoaders.delete('cap-session')
      connections.release('cap-session')
    }
  })

  test('treats an older host RPC failure and absent keys as unsupported', async () => {
    // WHY: an older server has no capability RPC. Features must see a stable
    // empty advertisement instead of surfacing its unknown-method error.
    let calls = 0
    capabilityLoaders.set('cap-old', async () => {
      calls++
      throw new Error('Unknown method "serverGetCapabilities"')
    })
    const connections = connectionsWith({ ...remoteHost, id: 'cap-old', installationId: 'cap-old' })

    expect(await connections.capabilitiesFor('cap-old')).toEqual({})
    expect(connections.cachedCapabilitiesFor('cap-old')?.assetUrls === true).toBe(false)
    expect(await connections.capabilitiesFor('cap-old')).toEqual({})
    expect(calls).toBe(1)
    capabilityLoaders.delete('cap-old')
    connections.release('cap-old')
  })

  test('a dropped session clears the record; the next session reloads it', async () => {
    // WHY: the same saved host can restart on a newer Solus build. The
    // capability record belongs to one server session: absent while
    // disconnected (hide, never probe), reloaded when the next session opens.
    let calls = 0
    capabilityLoaders.set('cap-reconnect', async () => ({
      attachUpload: ++calls > 1,
    }))
    const connections = connectionsWith({ ...remoteHost, id: 'cap-reconnect', installationId: 'cap-reconnect' })

    expect(connections.cachedCapabilitiesFor('cap-reconnect')).toBeUndefined()
    expect((await connections.capabilitiesFor('cap-reconnect')).attachUpload).toBe(false)

    const supervisor = connections.connectionFor('cap-reconnect')!.supervisor
    supervisor.report({ kind: 'dropped' })
    expect(connections.cachedCapabilitiesFor('cap-reconnect')).toBeUndefined()

    supervisor.report({ kind: 'accepted', recovered: false })
    expect((await connections.capabilitiesFor('cap-reconnect')).attachUpload).toBe(true)
    expect(calls).toBe(2)
    capabilityLoaders.delete('cap-reconnect')
    connections.release('cap-reconnect')
  })
})

describe('an installation id names a host in every client of it', () => {
  test('resolves to this client’s id for that host, and leaves a host it does not have unchanged', async () => {
    // WHY: a task shared to an organization names the machine that runs each of
    // its sessions by installation id (docs/plans/cloud-sharing.md §3a). The owner's
    // desktop calls that machine `local` and their browser calls it by its listed id;
    // both must open the session. A teammate has no such host, so the id must stay
    // unresolved and the task page offers no Open.
    const { catalog } = await catalogWith({ listings: [{ id: 'studio', label: 'Studio', installationId: 'studio-installation', lastConnected: 1, routes: [{ kind: 'tunnel', url: 'https://studio.example' }] }] })
    catalog.addPageHost(localMachine('mac-installation'))
    const connections = new ServerConnections(catalog)
    expect(connections.resolveId('mac-installation')).toBe('local')
    expect(connections.resolveId('studio-installation')).toBe('studio')
    expect(connections.resolveId('local')).toBe('local')
    expect(connections.resolveId('teammate-installation')).toBe('teammate-installation')
  })
})

// docs/plans/desktop-remote-only.md. WHY: the app must connect only to saved hosts,
// and a person with none must still reach a workspace that can add one.
describe('a desktop window with its local host off', () => {
  const listingOf = (id: string): HostListing => ({ id, label: id, installationId: id, lastConnected: 1, routes: [{ kind: 'lan', url: `http://${id}.test:3000`, source: 'pairing', seenAt: 1 }] })

  function withActiveServer(activeId: string | null, run: () => Promise<void>): Promise<void> {
    const previous = globalThis.localStorage
    const storage = new Map<string, string>(activeId ? [['solus.activeServerId', activeId]] : [])
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    })
    return run().finally(() => {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: previous })
    })
  }

  test('opens on the active known host and has no device host', () => withActiveServer('second', async () => {
    const { catalog } = await catalogWith({ listings: [listingOf('first'), listingOf('second')] })
    const connections = new ServerConnections(catalog)

    const primary = connections.openWithoutLocalHost()

    expect(primary.presence).toBe('present')
    expect(connections.defaultServerId()).toBe('second')
    expect(connections.localServerId()).toBeNull()
    expect(connections.localHostApi()).toBeNull()
    expect(connections.deviceHostId()).toBeNull()
  }))

  test('falls to the first known host when the remembered active host is this computer', () => withActiveServer(null, async () => {
    const { catalog } = await catalogWith({ listings: [listingOf('first')] })
    expect(new ServerConnections(catalog).openWithoutLocalHost().serverId).toBe('first')
  }))

  test('with no known host the window waits on a gone primary, and the first host the catalog learns of takes over', () => withActiveServer(null, async () => {
    const journal: string[] = []
    const catalog = catalogOf({ credentials: memoryCredentials(journal), directory: null })
    const list = fakeList(journal, 'host:local')
    await catalog.useListSource(list.source)
    const connections = new ServerConnections(catalog)

    expect(connections.openWithoutLocalHost().presence).toBe('gone')
    // Settings lists these as hosts: a window with none must list none.
    expect(connections.serverIds()).toEqual([])
    connections.startCatalogSupervisors()

    // Pairing adds one host; the connections follow the catalog with no other call.
    await catalog.pair({ ...listingOf('paired'), sessionToken: 'token' })

    expect(connections.defaultServerId()).toBe('paired')
    expect(connections.presenceOf('paired')).toBe('present')
  }))

  test('a window that booted on its local host never treats that host as turned off', () => {
    expect(new ServerConnections().isLocalHostOff()).toBe(false)
  })

  test('only the local host reads as turned off: a removed host is still removed', () => withActiveServer(null, async () => {
    const connections = new ServerConnections((await catalogWith({})).catalog)
    connections.openWithoutLocalHost()

    expect(connections.isLocalHostOff()).toBe(true)
    expect(connections.isLocalHostOff('local')).toBe(true)
    expect(connections.isLocalHostOff('managed:deleted')).toBe(false)
  }))
})
