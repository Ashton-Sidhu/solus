import { describe, expect, mock, test } from 'bun:test'
import type { SolusServerTarget } from '@solus/client-core/server-connection'
import { installationIdDecision } from '@solus/client-core/server-registry'
import type { WsTransport } from '@solus/client-core/ws-transport'
import type { SolusAPI } from '../../src/preload'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'

const startedTransports: string[] = []
const destroyedTransports: string[] = []
const switchedUrls: string[] = []
const capabilityLoaders = new Map<string, () => Promise<unknown>>()
const infoLoaders = new Map<string, () => Promise<ConnectionsServerInfo>>()
const identityLoaders = new Map<string, SolusAPI['listProjectIdentities']>()

// A real transport opens a socket and reads browser lifecycle globals; the
// behavior under test is only when a connection's side effects run.
mock.module('@solus/client-core/server-connection', () => ({
  createSolusConnection: (target: SolusServerTarget, options: {
    onStatusChange?: (status: string, attempt: number) => void
  }) => {
    const transport = {
      events: { subscribe: () => () => {} },
      start: () => {
        startedTransports.push(target.id)
        options.onStatusChange?.('connecting', 0)
      },
      probe: async () => {},
      attachDialOutcomeReporter: () => {},
      switchServerUrl: (url: string) => switchedUrls.push(`${target.id}:${url}`),
      destroy: () => destroyedTransports.push(target.id),
    }
    const api = {
      serverGetCapabilities: () => capabilityLoaders.get(target.id)?.() ?? Promise.resolve({}),
      connectionsGetServerInfo: () => infoLoaders.get(target.id)!(),
      listProjectIdentities: () => identityLoaders.get(target.id)!(),
    }
    return { transport: transport as unknown as WsTransport, api: api as unknown as SolusAPI, events: transport.events }
  },
  savedServerTarget: (server: { id: string }) => server as SolusServerTarget,
}))

const { ServerConnections } = await import('@solus/client-core/server-connections')

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
  test('does not connect to a saved alias for the local installation', async () => {
    startedTransports.length = 0
    const previousLocalStorage = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: (key: string) => key === 'solus.servers'
          ? JSON.stringify([{
              id: 'local-installation',
              label: 'This Mac through Uplink',
              url: 'https://local.example',
              sessionToken: '',
              installationId: 'local-installation',
              lastConnected: 1,
            }])
          : null,
      },
    })
    const connections = new ServerConnections()
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
      if (previousLocalStorage === undefined) {
        delete (globalThis as unknown as { localStorage?: Storage }).localStorage
      } else {
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true,
          writable: true,
          value: previousLocalStorage,
        })
      }
    }
  })

  test('dials a managed host only once the directory calls it ready', async () => {
    // WHY: a dial during provisioning looked up a tunnel name that did not resolve
    // yet; the network's resolver kept that "no such name" answer, and the ready host
    // stayed unreachable (Offline) from that network for up to 30 minutes (2026-09-23).
    startedTransports.length = 0
    let managedState = 'provisioning'
    const previousLocalStorage = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: (key: string) => key === 'solus.servers'
          ? JSON.stringify([{
              id: 'cloud',
              label: 'Cloud · Acme',
              url: 'https://h-cloud.solus.test',
              sessionToken: '',
              installationId: 'managed:h_cloud',
              lastConnected: 1,
              uplink: { hostId: 'h_cloud', directoryUrl: 'https://app.solus.test', kind: 'managed', managedState },
            }])
          : null,
      },
    })
    const connections = new ServerConnections()
    try {
      connections.startCatalogSupervisors()
      await Promise.resolve()
      expect(startedTransports).toEqual([])

      managedState = 'ready'
      connections.startCatalogSupervisors()
      await Promise.resolve()
      expect(startedTransports).toEqual(['cloud'])
    } finally {
      if (previousLocalStorage === undefined) {
        delete (globalThis as unknown as { localStorage?: Storage }).localStorage
      } else {
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true,
          writable: true,
          value: previousLocalStorage,
        })
      }
    }
  })

  test('a live connection follows the route the directory gives a managed host once it links', async () => {
    // WHY: a managed host is listed at `h-….solus.sh` while it is set up and at its
    // machine's name once ready. The connection kept the routes it was made with, so
    // onboarding dialed a name with no DNS record until its wait ran out.
    startedTransports.length = 0
    switchedUrls.length = 0
    let saved = {
      id: 'cloud',
      label: 'Cloud · Acme',
      url: 'https://h-cloud.solus.test',
      routes: [{ kind: 'tunnel', url: 'https://h-cloud.solus.test' }],
      sessionToken: '',
      installationId: 'managed:h_cloud',
      lastConnected: 1,
      uplink: { hostId: 'h_cloud', directoryUrl: 'https://app.solus.test', kind: 'managed', managedState: 'provisioning' },
    }
    const previousLocalStorage = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: { getItem: (key: string) => key === 'solus.servers' ? JSON.stringify([saved]) : null },
    })
    const connections = new ServerConnections()
    try {
      connections.startCatalogSupervisors()
      await Promise.resolve()
      expect(switchedUrls).toEqual([])

      const machine = 'https://solus-h-cloud.sprites.test'
      saved = { ...saved, url: machine, routes: [{ kind: 'tunnel', url: machine }], uplink: { ...saved.uplink, managedState: 'ready' } }
      connections.startCatalogSupervisors()
      await Promise.resolve()
      expect(switchedUrls).toEqual([`cloud:${machine}`])
      expect(connections.ensure('cloud').target.url).toBe(machine)
      expect(startedTransports).toEqual(['cloud'])

      // A read that changes nothing does not re-aim the socket.
      connections.startCatalogSupervisors()
      expect(switchedUrls).toHaveLength(1)
    } finally {
      connections.release('cloud')
      if (previousLocalStorage === undefined) {
        delete (globalThis as unknown as { localStorage?: Storage }).localStorage
      } else {
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true,
          writable: true,
          value: previousLocalStorage,
        })
      }
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
    connections.onStatusChange((serverId, status) => statuses.push(`${serverId}:${status}`))
    connections.onConnectionCreated((connection) => created.push(connection.serverId))

    const connection = connections.ensure('remote')
    expect(connection.api).toBeDefined()
    expect(statuses).toEqual([])
    expect(created).toEqual([])

    await Promise.resolve()
    expect(created).toEqual(['remote'])
    expect(statuses).toEqual(['remote:connecting'])
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
      destroy: () => destroyed.push('first'),
      attachDialOutcomeReporter: () => {},
    } as unknown as WsTransport
    const second = {
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
    expect(connections.capability('cap-old', 'assetUrls')).toBe(false)
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

    expect(connections.capability('cap-reconnect', 'attachUpload')).toBeUndefined()
    expect((await connections.capabilitiesFor('cap-reconnect')).attachUpload).toBe(false)

    const supervisor = connections.connectionFor('cap-reconnect')!.supervisor
    supervisor.report({ kind: 'dropped' })
    expect(connections.capability('cap-reconnect', 'attachUpload')).toBeUndefined()

    supervisor.report({ kind: 'accepted', recovered: false })
    expect((await connections.capabilitiesFor('cap-reconnect')).attachUpload).toBe(true)
    expect(calls).toBe(2)
    capabilityLoaders.delete('cap-reconnect')
    connections.release('cap-reconnect')
  })
})

describe('an installation id names a host in every client of it', () => {
  test('resolves to this client’s id for that host, and leaves a host it does not have unchanged', () => {
    // WHY: a task shared to an organization names the machine that runs each of
    // its sessions by installation id (docs/plans/cloud-sharing.md §3a). The owner's
    // desktop calls that machine `local` and their browser calls it by a saved id;
    // both must open the session. A teammate has no such host, so the id must stay
    // unresolved and the task page offers no Open.
    const previousLocalStorage = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: (key: string) => key === 'solus.servers'
          ? JSON.stringify([{
              id: 'studio',
              label: 'Studio',
              url: 'https://studio.example',
              sessionToken: '',
              installationId: 'studio-installation',
              lastConnected: 1,
            }])
          : null,
      },
    })
    const connections = new ServerConnections()
    connections.registerTarget({
      id: 'local',
      label: 'This Mac',
      url: 'http://127.0.0.1:3000',
      sessionToken: 'local-token',
      installationId: 'mac-installation',
      local: true,
    })
    try {
      expect(connections.resolveId('mac-installation')).toBe('local')
      expect(connections.resolveId('studio-installation')).toBe('studio')
      expect(connections.resolveId('local')).toBe('local')
      expect(connections.resolveId('teammate-installation')).toBe('teammate-installation')
    } finally {
      if (previousLocalStorage === undefined) {
        delete (globalThis as unknown as { localStorage?: Storage }).localStorage
      } else {
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true,
          writable: true,
          value: previousLocalStorage,
        })
      }
    }
  })
})

describe('connection-owned startup reads', () => {
  const info: ConnectionsServerInfo = {
    host: 'test.invalid', port: 443, allowLan: false, installationId: 'info-host',
    remoteAccess: true, requireAuth: true, trustLocalNetwork: false,
    hostKind: 'personal', roles: ['execution', 'collaboration'], principal: 'remote-owner',
  }

  test('concurrent and later consumers share one info read; explicit refresh and reconnect read again', async () => {
    const connections = new ServerConnections()
    connections.registerTarget({ ...remoteTarget, id: 'info', installationId: 'info-host' })
    let calls = 0
    infoLoaders.set('info', async () => { calls++; return info })
    const first = connections.serverInfoFor('info')
    expect(connections.serverInfoFor('info-host')).toBe(first)
    await first
    connections.updateStatus('info', 'connected')
    expect(await connections.serverInfoFor('info')).toEqual(info)
    expect(calls).toBe(1)
    await Promise.all([connections.serverInfoFor('info', true), connections.serverInfoFor('info', true)])
    expect(calls).toBe(2)
    connections.updateStatus('info', 'disconnected')
    connections.updateStatus('info', 'connected')
    await connections.serverInfoFor('info')
    expect(calls).toBe(3)
    connections.release('info')
    infoLoaders.delete('info')
  })

  test('a late answer from the old connection cannot replace the new identity', async () => {
    const connections = new ServerConnections()
    connections.registerTarget({ ...remoteTarget, id: 'info-stale' })
    let finish!: (value: ConnectionsServerInfo) => void
    infoLoaders.set('info-stale', () => new Promise((resolve) => { finish = resolve }))
    const old = connections.serverInfoFor('info-stale')
    await Promise.resolve()
    connections.updateStatus('info-stale', 'connected')
    connections.updateStatus('info-stale', 'disconnected')
    infoLoaders.set('info-stale', async () => ({ ...info, userId: 'new-person' }))
    connections.updateStatus('info-stale', 'connected')
    await connections.serverInfoFor('info-stale')
    finish({ ...info, userId: 'old-person' })
    await old
    expect((await connections.serverInfoFor('info-stale')).userId).toBe('new-person')
    connections.release('info-stale')
    infoLoaders.delete('info-stale')
  })

  test('failed info reads can retry, and different hosts never share an answer', async () => {
    const connections = new ServerConnections()
    for (const id of ['info-fail', 'info-other']) connections.registerTarget({ ...remoteTarget, id })
    infoLoaders.set('info-fail', async () => { throw new Error('offline') })
    infoLoaders.set('info-other', async () => ({ ...info, installationId: 'other' }))
    await expect(connections.serverInfoFor('info-fail')).rejects.toThrow('offline')
    infoLoaders.set('info-fail', async () => info)
    expect((await connections.serverInfoFor('info-fail')).installationId).toBe('info-host')
    expect((await connections.serverInfoFor('info-other')).installationId).toBe('other')
    for (const id of ['info-fail', 'info-other']) { connections.release(id); infoLoaders.delete(id) }
  })

  test('project identity readers share pending work, including an explicit refresh', async () => {
    const connections = new ServerConnections()
    connections.registerTarget({ ...remoteTarget, id: 'projects' })
    let calls = 0
    identityLoaders.set('projects', async () => { calls++; return [] })
    await Promise.all([connections.projectIdentities('projects'), connections.projectIdentities('projects')])
    expect(calls).toBe(1)
    await connections.projectIdentities('projects')
    expect(calls).toBe(1)
    await Promise.all([connections.projectIdentities('projects', true), connections.projectIdentities('projects', true)])
    expect(calls).toBe(2)
    connections.release('projects')
    identityLoaders.delete('projects')
  })
})
