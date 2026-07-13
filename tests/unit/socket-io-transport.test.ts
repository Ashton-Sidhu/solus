import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server as HttpServer } from 'http'
import { issueSessionToken, resetAuthStateForTests, revokeDevice, verifySessionToken } from '../../src/main/server/auth'
import { SolusServer } from '../../src/main/server/server'
import { attachWebSocketTransport } from '../../src/main/transports/websocket'
import { WsTransport, type ConnectionStatus } from '../../src/client-core/ws-transport'

interface Harness {
  server: SolusServer
  http: HttpServer
  url: string
  transport: ReturnType<typeof attachWebSocketTransport>
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  resetAuthStateForTests()
})

describe('Socket.IO transport', () => {
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

  test('refreshes once after auth rejection, then blocks if that token is revoked', async () => {
    const harness = await createHarness(true)
    const refreshedToken = issueSessionToken('Test browser')
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
    const api = client.buildSolusApi() as Record<string, unknown>
    const taskEvents: unknown[] = []
    let resets = 0
    ;(api.onTasksChanged as (cb: (...args: unknown[]) => void) => () => void)((...args) => taskEvents.push(args))
    ;(api.onResetRuntime as (cb: () => void) => () => void)(() => { resets++ })

    client.start()
    await waitForStatus(client, 'connected')
    closeClientEngine(client)
    await waitForStatus(client, 'reconnecting')
    harness.server.broadcast('tasks-changed', '/project')
    await waitForStatus(client, 'connected')
    await waitFor(() => taskEvents.length === 1)

    expect(taskEvents).toEqual([['/project']])
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
    const firstApi = first.buildSolusApi() as Record<string, unknown>
    const secondApi = second.buildSolusApi() as Record<string, unknown>
    ;(firstApi.onEvent as (cb: (...args: unknown[]) => void) => () => void)((...args) => firstEvents.push(args))
    ;(secondApi.onEvent as (cb: (...args: unknown[]) => void) => () => void)((...args) => secondEvents.push(args))

    first.start()
    second.start()
    await Promise.all([waitForStatus(first, 'connected'), waitForStatus(second, 'connected')])
    const clientId = `ws:local:${getClientInstanceId(first)}`
    expect(harness.server.sendTargeted(clientId, 'normalized-event', 'tab-1', { type: 'message' })).toBe(true)
    await waitFor(() => firstEvents.length === 1)

    expect(firstEvents).toEqual([['tab-1', { type: 'message' }]])
    expect(secondEvents).toEqual([])
  })
})

async function createHarness(requireAuth: boolean): Promise<Harness> {
  const http = createServer()
  const server = new SolusServer()
  const transport = attachWebSocketTransport(http, server, { requireAuth })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  const harness = { server, http, transport, url: `http://127.0.0.1:${address.port}` }
  cleanups.push(() => transport.close())
  return harness
}

function createClient(url: string, overrides: Partial<ConstructorParameters<typeof WsTransport>[0]> = {}): WsTransport {
  const client = new WsTransport({ serverUrl: url, sessionToken: '', ...overrides })
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
