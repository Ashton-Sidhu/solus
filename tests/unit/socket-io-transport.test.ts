import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server as HttpServer } from 'http'
import { issueSessionToken, issueWsTicket, resetAuthStateForTests, revokeDevice, verifySessionToken } from '../../src/main/server/auth'
import { io } from 'socket.io-client'
import { SolusServer } from '../../src/main/server/server'
import { ClientEventRegistry } from '../../src/main/events/client-event-registry'
import { HostEventPublisher } from '../../src/main/events/host-event-publisher'
import { attachWebSocketTransport, FRAME_COMPRESSION_OPTIONS, isLoopbackAddress } from '../../src/main/transports/websocket'
import { WsTransport, type ConnectionStatus } from '../../src/client-core/ws-transport'
import { HostSupervisor } from '../../src/client-core/host-supervisor'
import type { SolusAPI } from '../../src/preload'

interface Harness {
  server: SolusServer
  http: HttpServer
  url: string
  events: HostEventPublisher
  transport: ReturnType<typeof attachWebSocketTransport>
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  resetAuthStateForTests()
})

describe('Socket.IO transport', () => {
  test('does not negotiate frame compression for a loopback client', async () => {
    const harness = await createHarness(false)
    const client = createClient(harness.url)
    client.start()
    await waitForStatus(client, 'connected')

    expect(hasServerFrameCompression(harness)).toBe(false)
  })

  test('enables frame compression above the remote payload threshold', () => {
    expect(FRAME_COMPRESSION_OPTIONS).toEqual({ threshold: 1024 })
    expect(isLoopbackAddress('10.10.1.219')).toBe(false)
  })

  test('recognizes IPv4, mapped IPv4, and IPv6 loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.10')).toBe(false)
  })

  test('rejects a long-lived session token in the socket handshake', async () => {
    // WHY: the session token may travel only in the HTTP Authorization header.
    // Accepting it in Socket.IO auth would preserve the dispatch migration's
    // retired credential path and defeat the short-lived ticket boundary.
    const harness = await createHarness(true)
    const sessionToken = issueSessionToken('Legacy browser').token
    const socket = io(harness.url, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: false,
      auth: { token: sessionToken, clientInstanceId: 'legacy_browser_1234' },
    })
    cleanups.push(() => socket.disconnect())

    const error = await new Promise<Error & { data?: { code?: string } }>((resolve, reject) => {
      socket.once('connect', () => reject(new Error('legacy handshake unexpectedly connected')))
      socket.once('connect_error', resolve)
    })
    expect(error.data?.code).toBe('UNAUTHORIZED')
  })

  test('requeues an unanswered RPC across reconnect and runs its handler once', async () => {
    const harness = await createHarness(false)
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    harness.server.register('connectionsGetServerInfo', async () => {
      calls++
      await gate
      return { installationId: 'server-1' }
    })

    const client = createClient(harness.url)
    client.start()
    await waitForStatus(client, 'connected')
    const api = client.buildSolusApi() as Record<string, (...args: unknown[]) => Promise<unknown>>
    const response = api.connectionsGetServerInfo()
    await waitFor(() => calls === 1)

    closeClientEngine(client)
    await waitForStatus(client, 'reconnecting')
    await waitForStatus(client, 'connected')
    release()

    expect(await response).toEqual({ installationId: 'server-1' })
    expect(calls).toBe(1)
  })

  test('surfaces an RPC handler error instead of rejecting its ack envelope', async () => {
    const harness = await createHarness(false)
    harness.server.register('connectionsGetServerInfo', () => {
      throw new Error('snapshot read failed')
    })

    const client = createClient(harness.url)
    client.start()
    await waitForStatus(client, 'connected')
    // SAFETY: buildSolusApi installs every RPC method declared by SolusAPI.
    const api = client.buildSolusApi() as SolusAPI

    await expect(api.connectionsGetServerInfo()).rejects.toThrow('snapshot read failed')
  })

  test('refreshes once after auth rejection, then blocks if that token is revoked', async () => {
    const harness = await createHarness(true)
    const refreshedToken = issueSessionToken('Test browser').token
    let refreshes = 0
    let authFailures = 0
    const statuses: ConnectionStatus[] = []
    const client = createClient(harness.url, {
      sessionToken: 'expired',
      refreshToken: async () => {
        refreshes++
        return { result: 'refreshed', sessionToken: refreshedToken }
      },
      onAuthFailed: () => { authFailures++ },
      onStatusChange: (status) => statuses.push(status),
    })

    client.start()
    await waitForStatus(client, 'connected')
    expect(refreshes).toBe(1)

    const session = verifySessionToken(refreshedToken)
    expect(session).not.toBeNull()
    revokeDevice(session!.deviceId)
    closeClientEngine(client, true)
    await waitFor(() => statuses.at(-1) === 'blocked')

    expect(refreshes).toBe(1)
    expect(authFailures).toBe(1)
  })

  test('replays CSR events without reset and resets after a fresh Socket.IO session', async () => {
    const harness = await createHarness(false)
    const client = createClient(harness.url)
    const taskEvents: unknown[] = []
    let resets = 0
    client.events.subscribe('tasks.invalidated', (payload) => taskEvents.push(payload))
    client.onReset(() => { resets++ })

    client.start()
    await waitForStatus(client, 'connected')
    closeClientEngine(client)
    await waitForStatus(client, 'reconnecting')
    harness.events.broadcast('tasks.invalidated', {})
    await waitForStatus(client, 'connected')
    await waitFor(() => taskEvents.length === 1)

    expect(taskEvents).toEqual([{}])
    expect(resets).toBe(0)

    closeClientEngine(client, true)
    await waitForStatus(client, 'reconnecting')
    await waitForStatus(client, 'connected')
    expect(resets).toBe(1)
  })

  test('delivers targeted events only to sockets in the owning client room', async () => {
    const harness = await createHarness(false)
    const first = createClient(harness.url)
    const second = createClient(harness.url)
    const firstEvents: unknown[] = []
    const secondEvents: unknown[] = []
    first.events.subscribe('session.eventReceived', (payload) => firstEvents.push(payload))
    second.events.subscribe('session.eventReceived', (payload) => secondEvents.push(payload))

    first.start()
    second.start()
    await Promise.all([waitForStatus(first, 'connected'), waitForStatus(second, 'connected')])
    const clientId = `ws:local:${getClientInstanceId(first)}`
    expect(harness.events.publish(clientId, 'session.eventReceived', {
      sessionId: 'session-1',
      event: { type: 'assistant_message', text: 'hello' },
    })).toBe(1)
    await waitFor(() => firstEvents.length === 1)

    expect(firstEvents).toEqual([{ sessionId: 'session-1', event: { type: 'assistant_message', text: 'hello' } }])
    expect(secondEvents).toEqual([])
  })
})

async function createHarness(requireAuth: boolean, bindHost = '127.0.0.1', urlHost = bindHost): Promise<Harness> {
  const http = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/auth/ws-ticket') {
      const authorization = request.headers.authorization
      const ticket = authorization?.startsWith('Bearer ')
        ? issueWsTicket(authorization.slice('Bearer '.length))
        : null
      response.statusCode = ticket ? 200 : 401
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(ticket ? { ticket } : { error: 'unauthorized' }))
      return
    }
    response.statusCode = 404
    response.end()
  })
  const server = new SolusServer()
  const clientEvents = new ClientEventRegistry()
  const events = new HostEventPublisher(clientEvents)
  const transport = attachWebSocketTransport(http, server, { clientEvents, requireAuth })
  await new Promise<void>((resolve) => http.listen(0, bindHost, resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  const harness = { server, http, events, transport, url: `http://${urlHost}:${address.port}` }
  cleanups.push(() => transport.close())
  return harness
}

function createClient(url: string, overrides: Partial<ConstructorParameters<typeof WsTransport>[0]> = {}): WsTransport {
  const client = new WsTransport({ serverUrl: url, sessionToken: '', ...overrides })
  // The supervisor is the sole retry owner (dispatch-client step 3): the
  // harness attaches a fast-ladder one so a drop redials the SAME socket —
  // which is exactly what keeps connection-state recovery working.
  const supervisor = new HostSupervisor({
    transport: client,
    setTimeoutFn: ((handler: () => void) => setTimeout(handler, 10)) as typeof setTimeout,
  })
  client.attachDialOutcomeReporter((outcome) => supervisor.report(outcome))
  cleanups.push(() => supervisor.destroy())
  cleanups.push(() => client.destroy())
  return client
}

function getClientSocket(client: WsTransport): { io: { engine: { close: () => void } }; _pid?: string } {
  return (client as unknown as { socket: { io: { engine: { close: () => void } }; _pid?: string } }).socket
}

function closeClientEngine(client: WsTransport, discardRecovery = false): void {
  const socket = getClientSocket(client)
  socket.io.engine.close()
  if (discardRecovery) socket._pid = undefined
}

function getClientInstanceId(client: WsTransport): string {
  return (client as unknown as { clientInstanceId: string }).clientInstanceId
}

function hasServerFrameCompression(harness: Harness): boolean {
  const session = [...harness.transport.sessions.values()][0]
  const raw = (session.socket.conn.transport as unknown as {
    socket?: { extensions?: unknown; _extensions?: { 'permessage-deflate'?: unknown } }
  }).socket
  if (typeof raw?.extensions === 'string') return raw.extensions.includes('permessage-deflate')
  return !!raw?._extensions?.['permessage-deflate']
}


function waitForStatus(client: WsTransport, expected: ConnectionStatus): Promise<void> {
  return waitFor(() => (client as unknown as { status: ConnectionStatus }).status === expected)
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
