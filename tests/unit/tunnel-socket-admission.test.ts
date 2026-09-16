import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'http'
import { io as connect } from 'socket.io-client'
import { issueGrantWsTicket, resetAuthStateForTests } from '@solus/server/server/auth'
import { SolusServer } from '@solus/server/server/server'
import { ClientEventRegistry } from '@solus/server/events/client-event-registry'
import { attachWebSocketTransport } from '@solus/server/transports/websocket'

// docs/plans/personal-uplink.md H3, the proxied-listener rule, on the socket path:
// a WebSocket that arrived through the tunnel listener is loopback on the wire and
// must never be admitted without a ticket, whatever the bind policy says. The
// marker is read from the handshake, so the request it rides on must still be
// there when Socket.IO builds that handshake.
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  resetAuthStateForTests()
})

async function tunnelHost(): Promise<string> {
  const http: Server = createServer()
  const transport = attachWebSocketTransport(http, new SolusServer(), {
    clientEvents: new ClientEventRegistry(),
    requireAuth: () => false,
    isTrustedRequester: async () => true,
    isTunnelRequest: () => true,
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => { transport.close(); http.close() })
  const address = http.address()
  return `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`
}

function dial(url: string, ticket?: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(url, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      auth: ticket ? { ticket, clientInstanceId: 'test0123456789abcdef' } : { clientInstanceId: 'test0123456789abcdef' },
    })
    cleanups.push(() => socket.disconnect())
    socket.once('connect', () => resolve('connected'))
    socket.once('connect_error', (error: Error & { data?: { code?: string } }) => resolve(error.data?.code ?? error.message))
  })
}

describe('socket admission through the tunnel listener', () => {
  test('an open, trusting host still refuses a credential-free socket from the tunnel', async () => {
    const url = await tunnelHost()
    expect(await dial(url)).toBe('UNAUTHORIZED')
  })

  test('a ticket admits one socket through the tunnel, and only one', async () => {
    const url = await tunnelHost()
    const ticket = issueGrantWsTicket({ userId: 'user_1', deviceId: 'session_1', expiresAt: Date.now() + 60_000 })
    expect(await dial(url, ticket)).toBe('connected')
    expect(await dial(url, ticket)).toBe('UNAUTHORIZED')
  })
})
