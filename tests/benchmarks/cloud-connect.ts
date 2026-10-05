/**
 * How long a client waits to talk to a cloud host (an Uplink tunnel route).
 *
 * A real host sits behind a TCP proxy that adds a fixed one-way delay, the way
 * the relay adds the distance client → edge → host. The account site that mints
 * grants answers after one round trip. Each case measures, from `start()`, when
 * the socket is accepted and when the first queued RPC is answered.
 *
 * Run with: bun tests/benchmarks/cloud-connect.ts [oneWayMs] [--skip-direct]
 *
 * No benchmark touches live Solus data: the host runs in memory on loopback.
 */
import { plugin } from 'bun'
import { Database } from 'bun:sqlite'
import { createServer, type Server as HttpServer } from 'node:http'
import { createServer as createTcpServer, connect as tcpConnect, type Server as TcpServer } from 'node:net'
import type { WsTransport as WsTransportType } from '@solus/client-core/ws-transport'
import type { HostSupervisor as HostSupervisorType } from '@solus/client-core/host-supervisor'
import type { HostRoute } from '@solus/contracts/uplink'

// The server's websocket module reaches the database module, which imports
// `node:sqlite`; Bun has none, so the same stand-in the unit tests use.
plugin({
  setup(build) {
    build.module('node:sqlite', () => ({ exports: { DatabaseSync: Database }, loader: 'object' }))
  },
})
process.env.SOLUS_DATA_DIR ??= (await import('node:fs')).mkdtempSync(`${(await import('node:os')).tmpdir()}/solus-bench-`)
const { issueGrantWsTicket } = await import('@solus/server/admission/auth')
const { SolusServer } = await import('@solus/server/transport/server')
const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
const { attachWebSocketTransport } = await import('@solus/server/transport/websocket')
const { WsTransport } = await import('@solus/client-core/ws-transport')
const { HostSupervisor } = await import('@solus/client-core/host-supervisor')
const { nextRouteUrl } = await import('@solus/client-core/server-registry')
const { keptGrantSource } = await import('@solus/client-core/server-connection')

const ONE_WAY_MS = Number(process.argv[2] ?? 40)
const RTT_MS = ONE_WAY_MS * 2
const ITERATIONS = 5
const INSTALLATION_ID = 'bench-host'
/** A non-routable address: a direct route that a client away from home cannot reach. */
const UNREACHABLE_DIRECT = 'http://10.255.255.1:7777'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function startHost(): Promise<{ url: string; close: () => void }> {
  const http: HttpServer = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.method === 'GET' && request.url === '/health') {
      response.end(JSON.stringify({ ok: true, installationId: INSTALLATION_ID, name: 'Bench host' }))
      return
    }
    if (request.method === 'POST' && request.url === '/auth/ws-ticket') {
      const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
      // A real host accepts a grant at every exchange while it lives.
      const ticket = bearer.startsWith('grant:')
        ? issueGrantWsTicket({ userId: 'user_1', deviceId: 'device_1', expiresAt: Date.now() + 600_000 })
        : null
      response.statusCode = ticket ? 200 : 401
      response.end(JSON.stringify(ticket ? { ticket } : { error: 'unauthorized' }))
      return
    }
    response.statusCode = 404
    response.end()
  })
  const server = new SolusServer()
  server.register('connectionsGetServerInfo', async () => ({ name: 'Bench host' }) as never)
  server.register('serverGetCapabilities', async () => ({}) as never)
  const transport = attachWebSocketTransport(http, server, { clientEvents: new ClientEventRegistry(), requireAuth: true })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return { url: `http://127.0.0.1:${address.port}`, close: () => { transport.close(); http.close() } }
}

/** The relay: every byte reaches the far side `ONE_WAY_MS` later, in order. */
async function startRelay(hostUrl: string): Promise<{ url: string; close: () => void }> {
  const { port } = new URL(hostUrl)
  const relay: TcpServer = createTcpServer((client) => {
    const upstream = tcpConnect(Number(port), '127.0.0.1')
    client.on('data', (chunk) => setTimeout(() => upstream.write(chunk), ONE_WAY_MS))
    upstream.on('data', (chunk) => setTimeout(() => client.write(chunk), ONE_WAY_MS))
    client.on('close', () => setTimeout(() => upstream.destroy(), ONE_WAY_MS))
    upstream.on('close', () => setTimeout(() => client.destroy(), ONE_WAY_MS))
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  const address = relay.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return { url: `http://127.0.0.1:${address.port}`, close: () => relay.close() }
}

let grantCounter = 0
/** The account site: one round trip to mint a grant, kept as a connection keeps it. */
function accountGrants(): (options?: { fresh?: boolean }) => Promise<string | null> {
  return keptGrantSource(async () => {
    await sleep(RTT_MS)
    return { accessToken: `grant:${++grantCounter}`, hostId: INSTALLATION_ID, expiresAt: Date.now() + 8 * 60 * 60 * 1000 }
  }, () => undefined)
}

/** What `ServerConnections.verifySavedServerIdentity` does for a saved host. */
async function verifyByHealth(url: string): Promise<boolean> {
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) })
  const body = await response.json() as { installationId?: string }
  return body.installationId === INSTALLATION_ID
}

interface Dial {
  transport: WsTransportType
  supervisor: HostSupervisorType
}

/** Wires a transport the way `ServerConnections` does, including direct-first route advance. */
function dial(routes: HostRoute[]): Dial {
  let url = routes[0]!.url
  let transport!: WsTransportType
  transport = new WsTransport({
    serverUrl: url,
    serverId: INSTALLATION_ID,
    sessionToken: '',
    acquireGrant: accountGrants(),
    verifyConnectedHost: () => verifyByHealth(transport.serverUrl),
  })
  const supervisor = new HostSupervisor({
    transport,
    onDialFailed: (attempt) => {
      const next = nextRouteUrl(routes, url, '')
      if (!next) return false
      url = next
      transport.switchServerUrl(next)
      return attempt < routes.length
    },
  })
  transport.attachDialOutcomeReporter((outcome) => supervisor.report(outcome))
  return { transport, supervisor }
}

interface Sample { acceptedMs: number; firstRpcMs: number }

async function measure(routes: HostRoute[]): Promise<Sample> {
  const { transport, supervisor } = dial(routes)
  const started = performance.now()
  let acceptedMs = -1
  const accepted = new Promise<void>((resolve) => {
    transport.attachDialOutcomeReporter((outcome) => {
      supervisor.report(outcome)
      if (outcome.kind === 'accepted') { acceptedMs = performance.now() - started; resolve() }
    })
  })
  const firstRpc = transport.invoke('connectionsGetServerInfo', [])
  supervisor.start()
  await firstRpc
  const firstRpcMs = performance.now() - started
  await accepted
  supervisor.destroy()
  transport.destroy()
  return { acceptedMs, firstRpcMs }
}

async function measureRedial(routes: HostRoute[]): Promise<Sample> {
  const { transport, supervisor } = dial(routes)
  supervisor.start()
  await transport.invoke('connectionsGetServerInfo', [])
  let acceptedMs = -1
  let started = 0
  const accepted = new Promise<void>((resolve) => {
    transport.attachDialOutcomeReporter((outcome) => {
      if (outcome.kind === 'accepted' && started) { acceptedMs = performance.now() - started; resolve() }
    })
  })
  // A network change: the standing socket is gone and the supervisor redials now.
  ;(transport as unknown as { socket: { disconnect(): void } }).socket.disconnect()
  started = performance.now()
  const firstRpc = transport.invoke('connectionsGetServerInfo', [])
  supervisor.dialNow()
  transport.start()
  await firstRpc
  const firstRpcMs = performance.now() - started
  await accepted
  supervisor.destroy()
  transport.destroy()
  return { acceptedMs, firstRpcMs }
}

function report(label: string, samples: Sample[]): void {
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!
  const accepted = median(samples.map((sample) => sample.acceptedMs))
  const firstRpc = median(samples.map((sample) => sample.firstRpcMs))
  console.log(`${label.padEnd(44)} accepted ${accepted.toFixed(0).padStart(6)} ms   first RPC ${firstRpc.toFixed(0).padStart(6)} ms   (${(firstRpc / RTT_MS).toFixed(1)} RTT)`)
}

const host = await startHost()
const relay = await startRelay(host.url)
const tunnel: HostRoute = { kind: 'tunnel', url: relay.url }
console.log(`relay round trip ${RTT_MS} ms, account site round trip ${RTT_MS} ms, median of ${ITERATIONS}\n`)

const cold: Sample[] = []
for (let i = 0; i < ITERATIONS; i++) cold.push(await measure([tunnel]))
report('cold dial, tunnel only', cold)

const redial: Sample[] = []
for (let i = 0; i < ITERATIONS; i++) redial.push(await measureRedial([tunnel]))
report('redial after drop, tunnel only', redial)

if (!process.argv.includes('--skip-direct')) {
  report('cold dial, refused direct route first', [await measure([{ kind: 'direct', url: UNREACHABLE_DIRECT }, tunnel])])
  // A LAN address seen from another network: packets go nowhere and nothing answers.
  const silent: TcpServer = createTcpServer(() => {})
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
  const silentAddress = silent.address()
  if (!silentAddress || typeof silentAddress === 'string') throw new Error('expected TCP address')
  report('cold dial, silent direct route first', [await measure([{ kind: 'direct', url: `http://127.0.0.1:${silentAddress.port}` }, tunnel])])
  silent.close()
}

relay.close()
host.close()
process.exit(0)
