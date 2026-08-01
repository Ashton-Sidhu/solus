import { describe, expect, test } from 'bun:test'
import { ServerConnections } from '../../src/client-core/server-connections'
import type { SolusServerTarget } from '../../src/client-core/server-connection'
import type { WsTransport } from '../../src/client-core/ws-transport'
import type { SolusAPI } from '../../src/preload'

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
