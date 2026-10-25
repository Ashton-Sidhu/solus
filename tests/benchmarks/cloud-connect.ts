/**
 * How long a client waits to talk to a cloud host (an Uplink tunnel route).
 *
 * A real host sits behind a TCP proxy that adds a fixed one-way delay, the way
 * the relay adds the distance client → edge → host. The account site that mints
 * host tokens answers after one round trip. Each case dials as production does:
 * through `HostLink`, whose route choice (`chooseRoute`) checks every route at once
 * before each dial. Each case measures, from `start()`, when the socket is accepted
 * and when the first queued RPC is answered.
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
import type { HostLink as HostLinkType } from '@solus/client-core/host-link'
import type { HostRoute } from '@solus/contracts/host-routes'

// The server's websocket module reaches the database module, which imports
// `node:sqlite`; Bun has none, so the same stand-in the unit tests use.
plugin({
  setup(build) {
    build.module('node:sqlite', () => ({ exports: { DatabaseSync: Database }, loader: 'object' }))
  },
})
process.env.SOLUS_DATA_DIR ??= (await import('node:fs')).mkdtempSync(`${(await import('node:os')).tmpdir()}/solus-bench-`)
const { SolusServer } = await import('@solus/server/transport/server')
const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
const { attachWebSocketTransport } = await import('@solus/server/transport/websocket')
const { WsTransport } = await import('@solus/client-core/ws-transport')
const { HostLink, readHostHealth } = await import('@solus/client-core/host-link')
const { asHostApi } = await import('@solus/client-core/host-api')

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
    response.statusCode = 404
    response.end()
  })
  const server = new SolusServer()
  server.register('connectionsGetServerInfo', async () => ({ name: 'Bench host' }) as never)
  server.register('serverGetCapabilities', async () => ({}) as never)
  const transport = attachWebSocketTransport(http, server, {
    clientEvents: new ClientEventRegistry(),
    requireAuth: true,
    // A real host takes a grant in the handshake at every dial while it lives.
    doors: {
      admitCredential: async (credential) => credential.kind === 'access-token' && credential.token.startsWith('grant:')
        ? { ok: true, principal: { kind: 'owner', via: 'grant', userId: 'user_1', deviceId: 'device_1', expiresAt: Date.now() + 600_000, deviceLabel: 'Solus cloud' } }
        : { ok: false, reason: 'token-refused' },
      admitBearer: async () => ({ ok: false, reason: 'not-accepted' }),
    },
  })
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
/** The account site: one round trip for a host token, kept until it ends, as `OAuthSession` keeps it. */
function accountGrants(): () => Promise<string | null> {
  let kept: string | null = null
  return async () => {
    if (kept) return kept
    await sleep(RTT_MS)
    kept = `grant:${++grantCounter}`
    return kept
  }
}

/** Whether a route answers `/health` as the bench host: `ServerConnections.answersAsHost`. */
async function answersAsHost(url: string, signal: AbortSignal): Promise<boolean> {
  return (await readHostHealth(fetch, url, signal))?.installationId === INSTALLATION_ID
}

interface Dial {
  transport: WsTransportType
  link: HostLinkType
}

/** Wires a transport and its link the way `ServerConnections` does. */
function dial(routes: HostRoute[]): Dial {
  let transport!: WsTransportType
  transport = new WsTransport({
    serverUrl: routes[0]!.url,
    serverId: INSTALLATION_ID,
    sessionToken: '',
    grants: { acquire: accountGrants(), isSignedOut: () => false },
    verifyConnectedHost: () => answersAsHost(transport.serverUrl, AbortSignal.timeout(3_000)),
  })
  const link = new HostLink({ hostId: INSTALLATION_ID, transport, api: asHostApi(transport.buildSolusApi()), routes: () => routes, answersAsHost })
  return { transport, link }
}

interface Sample { acceptedMs: number; firstRpcMs: number }

/** Resolves when the link reaches `ready`, with the time it took since `started`. */
function whenConnected(link: HostLinkType, started: number): Promise<number> {
  return new Promise((resolve) => {
    const poll = () => (link.readiness === 'ready' ? resolve(performance.now() - started) : setTimeout(poll, 1))
    poll()
  })
}

async function measure(routes: HostRoute[]): Promise<Sample> {
  const { transport, link } = dial(routes)
  const started = performance.now()
  const firstRpc = transport.invoke('connectionsGetServerInfo', [])
  link.start()
  const accepted = whenConnected(link, started)
  await firstRpc
  const firstRpcMs = performance.now() - started
  const acceptedMs = await accepted
  link.destroy()
  return { acceptedMs, firstRpcMs }
}

async function measureRedial(routes: HostRoute[]): Promise<Sample> {
  const { transport, link } = dial(routes)
  link.start()
  await transport.invoke('connectionsGetServerInfo', [])
  // A network change: the standing socket is gone and the link redials now.
  ;(transport as unknown as { socket: { disconnect(): void } }).socket.disconnect()
  const started = performance.now()
  const firstRpc = transport.invoke('connectionsGetServerInfo', [])
  link.dialNow()
  const accepted = whenConnected(link, started)
  await firstRpc
  const firstRpcMs = performance.now() - started
  const acceptedMs = await accepted
  link.destroy()
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
  report('cold dial, refused direct route first', [await measure([{ kind: 'lan', url: UNREACHABLE_DIRECT }, tunnel])])
  // A LAN address seen from another network: packets go nowhere and nothing answers.
  const silent: TcpServer = createTcpServer(() => {})
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
  const silentAddress = silent.address()
  if (!silentAddress || typeof silentAddress === 'string') throw new Error('expected TCP address')
  report('cold dial, silent direct route first', [await measure([{ kind: 'lan', url: `http://127.0.0.1:${silentAddress.port}` }, tunnel])])
  silent.close()
}

relay.close()
host.close()
process.exit(0)
