import { describe, expect, mock, test } from 'bun:test'
import type { SolusServerTarget } from '../../src/client-core/server-connection'
import { installationIdDecision } from '../../src/client-core/server-registry'
import type { WsTransport } from '../../src/client-core/ws-transport'
import type { SolusAPI } from '../../src/preload'

const startedTransports: string[] = []
const destroyedTransports: string[] = []
const capabilityLoaders = new Map<string, () => Promise<unknown>>()

// A real transport opens a socket and reads browser lifecycle globals; the
// behavior under test is only when a connection's side effects run.
mock.module('../../src/client-core/server-connection', () => ({
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
      destroy: () => destroyedTransports.push(target.id),
    }
    const api = {
      serverGetCapabilities: () => capabilityLoaders.get(target.id)?.() ?? Promise.resolve({}),
    }
    return { transport: transport as unknown as WsTransport, api: api as unknown as SolusAPI, events: transport.events }
  },
  savedServerTarget: (server: { id: string }) => server as SolusServerTarget,
}))

const { ServerConnections } = await import('../../src/client-core/server-connections')

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
})

describe('lazily created connections', () => {
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
