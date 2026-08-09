import { describe, expect, mock, test } from 'bun:test'
import type { SolusServerTarget } from '../../src/client-core/server-connection'
import type { WsTransport } from '../../src/client-core/ws-transport'
import type { SolusAPI } from '../../src/preload'

const startedTransports: string[] = []
const destroyedTransports: string[] = []

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
      destroy: () => destroyedTransports.push(target.id),
    }
    return { transport: transport as unknown as WsTransport, api: {} as SolusAPI, events: transport.events }
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
    const first = { destroy: () => destroyed.push('first') } as unknown as WsTransport
    const second = { destroy: () => destroyed.push('second') } as unknown as WsTransport
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
