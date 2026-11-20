import { describe, expect, mock, test } from 'bun:test'
import type { SolusServerTarget } from '@solus/client-core/server-connection'
import { installationIdDecision } from '@solus/client-core/known-host'
import type { HostCredential } from '@solus/client-core/host-credentials'
import type { HostListing } from '@solus/contracts/host-list'
import type { DirectoryHost } from '@solus/contracts/uplink'
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
const capabilityLoaders = new Map<string, () => Promise<unknown>>()
const infoLoaders = new Map<string, () => Promise<ConnectionsServerInfo>>()
const identityLoaders = new Map<string, SolusAPI['listProjectIdentities']>()

// A real transport opens a socket and reads browser lifecycle globals; the
// behavior under test is only when a connection's side effects run.
mock.module('@solus/client-core/server-connection', () => ({
  createSolusConnection: (target: SolusServerTarget) => {
    const transport = {
      events: { subscribe: () => () => {} },
      serverUrl: target.url,
      start: () => { startedTransports.push(target.id) },
      probe: async () => {},
      attachDialOutcomeReporter: () => {},
      switchServerUrl: (url: string) => {
        transport.serverUrl = url
        switchedUrls.push(`${target.id}:${url}`)
      },
      destroy: () => destroyedTransports.push(target.id),
    }
    const api = {
      serverGetCapabilities: () => capabilityLoaders.get(target.id)?.() ?? Promise.resolve({}),
      connectionsGetServerInfo: () => infoLoaders.get(target.id)!(),
      listProjectIdentities: () => identityLoaders.get(target.id)!(),
    }
    return { transport: transport as unknown as WsTransport, api: api as unknown as SolusAPI, events: transport.events }
  },
  knownHostTarget: (server: { id: string; routes: HostRoute[] }) => ({ ...server, url: preferredRouteUrl(server, ''), local: false }) as SolusServerTarget,
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

const remoteTarget: SolusServerTarget = {
  id: 'remote',
  label: 'Remote',
  url: 'https://remote.example',
  sessionToken: 'token',
  local: false,
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
  test('a managed connection ignores internal routes even when its target contains them', async () => {
    const connections = new ServerConnections()
    const serverId = 'managed-internal-route'
    const tunnelUrl = 'https://managed.solus.test'
    connections.registerTarget({
      id: serverId, label: 'Managed', local: false, sessionToken: '',
      url: 'http://10.0.0.1:3000',
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
    const connections = new ServerConnections(catalog)
    connections.registerTarget({
      id: 'local',
      label: 'This Mac',
      url: 'http://127.0.0.1:3000',
      sessionToken: 'local-token',
      installationId: 'local-installation',
      local: true,
    })

    try {
      connections.startCatalogSupervisors()
      await Promise.resolve()
      expect(connections.connectedServerIds()).toEqual(['local'])
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
    const connections = new ServerConnections()
    connections.registerTarget(remoteTarget)
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
    startedTransports.length = 0
    destroyedTransports.length = 0
    const connections = new ServerConnections()
    connections.registerTarget(remoteTarget)

    connections.ensure('remote')
    connections.release('remote')
    await Promise.resolve()

    expect(startedTransports).toEqual([])
    expect(destroyedTransports).toEqual(['remote'])
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
    const target: SolusServerTarget = {
      id: 'server',
      label: 'Server',
      url: 'https://server.example',
      sessionToken: 'token',
      local: false,
    }

    connections.registerPrimary('server', api, first, target)
    connections.registerPrimary('server', api, second, target)

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
    const connections = new ServerConnections()
    connections.registerTarget({ ...remoteTarget, id: 'cap-session' })

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
    const connections = new ServerConnections()
    connections.registerTarget({ ...remoteTarget, id: 'cap-old' })

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
    const connections = new ServerConnections()
    connections.registerTarget({ ...remoteTarget, id: 'cap-reconnect' })

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
    const connections = new ServerConnections(catalog)
    connections.registerTarget({
      id: 'local',
      label: 'This Mac',
      url: 'http://127.0.0.1:3000',
      sessionToken: 'local-token',
      installationId: 'mac-installation',
      local: true,
    })
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
    expect(connections.connectedServerIds()).toEqual([])
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
