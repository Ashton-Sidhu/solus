import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createServer, type Server } from 'http'
import { Database } from 'bun:sqlite'
import { io as connect } from 'socket.io-client'
import type { HandshakeCredential } from '@solus/contracts/uplink'
import { fakeAccessTokens, handshake } from './helpers/socket-handshake'

// bun has no node:sqlite; the server modules' import chain reaches the db even though
// these tests never open it, so everything that reaches it loads after the seam.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { resetAuthStateForTests } = await import('@solus/server/admission/auth')
const { createDoors } = await import('@solus/server/admission/doors')
const { SolusServer } = await import('@solus/server/transport/server')
const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
const { attachWebSocketTransport } = await import('@solus/server/transport/websocket')

// docs/plans/personal-uplink.md H3, the proxied-listener rule, on the socket path:
// a WebSocket that arrived through the tunnel listener is loopback on the wire and
// must never be admitted without a credential, whatever the bind policy says. The
// marker is read from the handshake, so the request it rides on must still be
// there when Socket.IO builds that handshake.
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  resetAuthStateForTests()
})

const tokens = fakeAccessTokens()

async function tunnelHost(): Promise<string> {
  const http: Server = createServer()
  const transport = attachWebSocketTransport(http, new SolusServer(), {
    clientEvents: new ClientEventRegistry(),
    requireAuth: () => false,
    isTrustedRequester: async () => true,
    isTunnelRequest: () => true,
    doors: createDoors({ place: 'host', verifyAccessToken: tokens.verify }),
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => { transport.close(); http.close() })
  const address = http.address()
  return `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`
}

function dial(url: string, credential?: HandshakeCredential): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(url, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      auth: handshake(credential, 'test0123456789abcdef'),
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

  test('an access token admits a socket through the tunnel, again on each reconnect while it lives', async () => {
    // WHY: an access token is a bearer credential for its life (ADR 0001); a reconnect presents it again.
    const url = await tunnelHost()
    const token = tokens.mint({ sub: 'user_1', grant_id: 'session_1' })
    expect(await dial(url, { kind: 'access-token', token })).toBe('connected')
    expect(await dial(url, { kind: 'access-token', token })).toBe('connected')
    expect(await dial(url, { kind: 'access-token', token: 'forged.token.value' })).toBe('UNAUTHORIZED')
  })
})
