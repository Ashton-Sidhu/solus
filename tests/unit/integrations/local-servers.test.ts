import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from '../helpers/bun-sqlite'
import { resetTestDatabase } from '../helpers/test-db'
import { TEST_HANDLER_CTX } from '../helpers/handler-ctx'
import { startFakeServers } from './fake-servers'
import type { Integration, IntegrationCustomServerNeeded } from '@solus/contracts/integration-types'
import type { RunningServer } from '@solus/contracts/running-servers'
import type { AgentTool, AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { LocalProbeAnswer } from '@solus/server/integrations/local-servers'
import type { RunningServerScan } from '@solus/server/host/running-servers/registry'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { LocalMcpServers, discoverOnLoopback } = await import('@solus/server/integrations/local-servers')
const { FoundServers } = await import('@solus/server/integrations/found-servers')
const { IntegrationStore } = await import('@solus/server/integrations/integration-store')
const { IntegrationGateway } = await import('@solus/server/integrations/gateway')
const { withActingScope } = await import('@solus/server/vault/acting-scope')
const { HOST_SCOPE } = await import('@solus/server/execution/seats/acting-identity')
const { ownerKeyOf } = await import('@solus/server/admission/actor')
const { runtimeInstructions } = await import('@solus/server/execution/agents/runtime-instructions')
const { closeDb } = await import('@solus/server/db')

/**
 * Running local MCP servers (docs/plans/mcp-first-class.md §9). The running-
 * servers registry is a fake that emits scans; the listeners are a fake probe
 * that counts requests, or small loopback servers this test starts. No real
 * port scan runs. The point: a process on the host gets at most the requests
 * the plan allows in its life, nothing is added without the person, and "Not
 * running" is a fact derived from the newest list.
 */

const OWNER = ownerKeyOf(TEST_HANDLER_CTX.actor)!
const ADMIN = TEST_HANDLER_CTX.principal

let clock = 1_000_000
let requests: string[] = []
let answers = new Map<string, LocalProbeAnswer>()

beforeEach(() => {
  clock = 1_000_000
  requests = []
  answers = new Map()
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(process.env.SOLUS_DATA_DIR!, `solus.db${suffix}`), { force: true })
})

afterAll(() => closeDb())

/** The registry as the owner reads it: scans it emits, and `list`, which scans once. */
class FakeRegistry {
  private readonly observers = new Set<(scan: RunningServerScan) => void>()
  servers: RunningServer[] = []
  ports: number[] = []
  lists = 0
  observeScans(observer: (scan: RunningServerScan) => void) {
    this.observers.add(observer)
    return () => { this.observers.delete(observer) }
  }

  async list() {
    this.lists++
    this.scan()
    return this.servers
  }

  /** One scan of what is listening now. */
  scan(servers = this.servers, ports = this.ports) {
    this.servers = servers
    this.ports = ports
    for (const observer of this.observers) observer({ at: clock, servers, listeningPorts: new Set(ports) })
  }

  fail(error: string) {
    for (const observer of this.observers) observer({ at: clock, error })
  }
}

interface RunningOptions {
  path?: string
  contentType?: string | null
  /** Null: the list knows the listener only as TCP. */
  isHttp?: boolean
  address?: string
  startedBy?: RunningServer['startedBy']
}

function running(serverId: string, port: number, options: RunningOptions = {}): RunningServer {
  const address = options.address ?? '127.0.0.1'
  return {
    serverId,
    process: { pid: 4100, name: 'node', workingDirectory: '/work/weather' },
    location: { projectRoot: '/work/weather', worktreePath: '/work/weather', branch: 'main' },
    startedBy: options.startedBy ?? { kind: 'configured' },
    endpoints: [{
      endpointId: options.path ? `http://127.0.0.1:${port}${options.path}` : String(port),
      address,
      port,
      url: `http://${address}:${port}${options.path ?? '/'}`,
      response: options.isHttp === false ? null : { protocol: 'http', statusCode: 200, contentType: options.contentType === undefined ? 'application/json' : options.contentType, pageTitle: null },
    }],
    actions: { canStop: true },
  }
}

async function probe(target: URL): Promise<LocalProbeAnswer> {
  requests.push(target.href)
  return answers.get(target.href) ?? { isMcp: false }
}

function loopbackIntegration(id: string, url: string): Integration {
  return { id, organizationId: 'local', ownerKey: OWNER, kind: 'mcp', slug: id, name: `Server ${id}`, url, auth: { kind: 'none' }, disabledTools: [], createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z' }
}

function owner(integrations: Integration[] = [], gateway?: { invalidate: (id: string) => void }) {
  const registry = new FakeRegistry()
  const invalidated: string[] = []
  const factsEvents: string[] = []
  const cards: IntegrationCustomServerNeeded[] = []
  const local = new LocalMcpServers({
    integrations: () => integrations,
    gateway: {
      invalidate: (id) => { invalidated.push(id); gateway?.invalidate(id) },
      askForCustomServer: (request) => { cards.push(request) },
    },
    factsChanged: (id) => { factsEvents.push(id) },
    probe,
    now: () => clock,
  })
  local.follow(registry)
  return { local, registry, invalidated, factsEvents, cards }
}

describe('the requests a listener gets', () => {
  test('a listener the list knows as HTTP gets server/discover at /mcp, then at /, and never again in its life', async () => {
    const { local, registry } = owner()
    registry.scan([running('a', 7001)], [7001])
    await local.runningNow()
    expect(requests).toEqual(['http://127.0.0.1:7001/mcp', 'http://127.0.0.1:7001/'])
    // WHY: the registry scans each 3 seconds; a database or a dev server must not get a POST on each scan.
    for (let scan = 0; scan < 20; scan++) {
      clock += 3000
      registry.scan()
    }
    await local.runningNow()
    expect(requests).toHaveLength(2)
  })

  test('a page whose GET / answered HTML gets no POST to /', async () => {
    const { local, registry } = owner()
    registry.scan([running('a', 7002, { contentType: 'text/html; charset=utf-8' })], [7002])
    await local.runningNow()
    expect(requests).toEqual(['http://127.0.0.1:7002/mcp'])
  })

  test('a Server URL with a path gets one request, to that path', async () => {
    const { local, registry } = owner()
    registry.scan([running('a', 7003, { path: '/api/mcp' })], [7003])
    await local.runningNow()
    expect(requests).toEqual(['http://127.0.0.1:7003/api/mcp'])
  })

  test('the first MCP answer ends the requests of an endpoint', async () => {
    answers.set('http://127.0.0.1:7004/mcp', { isMcp: true })
    const { local, registry } = owner()
    registry.scan([running('a', 7004)], [7004])
    await local.runningNow()
    expect(requests).toEqual(['http://127.0.0.1:7004/mcp'])
  })

  test('a listener the list knows only as TCP, of a process that Solus did not start, gets no request', async () => {
    // WHY: automatic discovery sends no bytes to an unknown service (docs/running-servers.md); a debugger or a database stays untouched.
    const { local, registry } = owner()
    registry.scan([running('a', 5432, { isHttp: false })], [5432])
    expect((await local.runningNow()).servers).toEqual([])
    expect(requests).toEqual([])
  })

  test('a non-loopback address is never probed', async () => {
    const { local, registry } = owner()
    registry.scan([running('a', 7005, { address: '192.168.1.20' })], [7005])
    await local.runningNow()
    expect(requests).toEqual([])
    const fetches = spyOn(globalThis, 'fetch')
    try {
      expect(await discoverOnLoopback(new URL('http://192.168.1.20:7005/mcp'))).toEqual({ isMcp: false })
      expect(await discoverOnLoopback(new URL('http://localhost.example:7005/mcp'))).toEqual({ isMcp: false })
      expect(fetches).not.toHaveBeenCalled()
    } finally {
      fetches.mockRestore()
    }
  })

  test('a new process on the port is checked once, and the answer of the old one goes', async () => {
    answers.set('http://127.0.0.1:7006/mcp', { isMcp: true, serverInfo: { name: 'weather', version: '1.0.0' } })
    const { local, registry } = owner()
    registry.scan([running('old', 7006)], [7006])
    expect((await local.runningNow()).servers.map((server) => server.place.runningServerId)).toEqual(['old'])
    registry.scan([running('new', 7006)], [7006])
    const now = await local.runningNow()
    expect(now.servers.map((server) => server.place.runningServerId)).toEqual(['new'])
    expect(requests).toEqual(['http://127.0.0.1:7006/mcp', 'http://127.0.0.1:7006/mcp'])
  })

  test('a process that lets go of its port loses its answer, and is checked once when it listens again', async () => {
    const { local, registry } = owner()
    registry.scan([running('a', 7007, { contentType: 'text/html' })], [7007])
    await local.runningNow()
    registry.scan([], [])
    registry.scan([running('b', 7007, { contentType: 'text/html' })], [7007])
    registry.scan()
    await local.runningNow()
    expect(requests).toEqual(['http://127.0.0.1:7007/mcp', 'http://127.0.0.1:7007/mcp'])
  })

  test('at most four requests run at one time', async () => {
    let inFlight = 0
    let most = 0
    const release: Array<() => void> = []
    const registry = new FakeRegistry()
    const local = new LocalMcpServers({
      integrations: () => [],
      gateway: { invalidate: () => undefined, askForCustomServer: () => undefined },
      factsChanged: () => undefined,
      probe: async () => {
        most = Math.max(most, ++inFlight)
        await new Promise<void>((resolve) => release.push(resolve))
        inFlight--
        return { isMcp: false }
      },
      now: () => clock,
    })
    local.follow(registry)
    const ports = Array.from({ length: 10 }, (_, index) => 7100 + index)
    registry.scan(ports.map((port) => running(`s${port}`, port, { contentType: 'text/html' })), ports)
    const done = local.runningNow()
    while (release.length || inFlight) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      release.shift()?.()
    }
    await done
    expect(most).toBe(4)
  })
})

describe('a TCP listener of a process that Solus started', () => {
  const agent: RunningServer['startedBy'] = { kind: 'agent', sessionId: 'session-9' }
  const terminal: RunningServer['startedBy'] = { kind: 'terminal', terminalId: 'term-1', sessionId: 'session-9' }

  test('gets one POST /mcp in its life, and only after the list has shown it for two seconds', async () => {
    const { local, registry } = owner()
    registry.scan([running('a', 7501, { isHttp: false, startedBy: agent })], [7501])
    await local.runningNow()
    // WHY: a process that has just opened its port may still be starting; a request then can disturb it.
    expect(requests).toEqual([])
    clock += 1000
    registry.scan()
    await local.runningNow()
    expect(requests).toEqual([])
    clock += 2000
    registry.scan()
    await local.runningNow()
    expect(requests).toEqual(['http://127.0.0.1:7501/mcp'])
    // WHY: the registry scans each 3 seconds; a database or a debugger must not get a POST on each scan.
    for (let scan = 0; scan < 20; scan++) {
      clock += 3000
      registry.scan()
    }
    await local.runningNow()
    expect(requests).toEqual(['http://127.0.0.1:7501/mcp'])
  })

  test('a terminal\'s listener is checked too; a listener of another process, or on another address, is not', async () => {
    const { local, registry } = owner()
    const servers = [
      running('term', 7502, { isHttp: false, startedBy: terminal }),
      running('other', 7503, { isHttp: false }),
      running('lan', 7504, { isHttp: false, startedBy: agent, address: '192.168.1.20' }),
    ]
    registry.scan(servers, [7502, 7503, 7504])
    clock += 3000
    registry.scan()
    await local.runningNow()
    expect(requests).toEqual(['http://127.0.0.1:7502/mcp'])
  })

  test('a listener that goes before the wait ends gets no request, and waits again when it comes back', async () => {
    const { local, registry } = owner()
    registry.scan([running('a', 7505, { isHttp: false, startedBy: agent })], [7505])
    clock += 1000
    registry.scan([], [])
    clock += 3000
    registry.scan([running('a', 7505, { isHttp: false, startedBy: agent })], [7505])
    await local.runningNow()
    expect(requests).toEqual([])
    clock += 3000
    registry.scan()
    await local.runningNow()
    expect(requests).toEqual(['http://127.0.0.1:7505/mcp'])
  })

  test('a "not MCP" answer is kept; a new process on the same port is checked again', async () => {
    const { local, registry } = owner()
    registry.scan([running('old', 7506, { isHttp: false, startedBy: agent })], [7506])
    for (let scan = 0; scan < 5; scan++) {
      clock += 3000
      registry.scan()
    }
    expect((await local.runningNow()).servers).toEqual([])
    expect(requests).toEqual(['http://127.0.0.1:7506/mcp'])
    answers.set('http://127.0.0.1:7506/mcp', { isMcp: true })
    registry.scan([running('new', 7506, { isHttp: false, startedBy: agent })], [7506])
    clock += 3000
    registry.scan()
    expect((await local.runningNow()).servers.map((server) => server.place.runningServerId)).toEqual(['new'])
    expect(requests).toEqual(['http://127.0.0.1:7506/mcp', 'http://127.0.0.1:7506/mcp'])
  })

  test('a process whose Server URL was checked gets no second check when the list shows its port as TCP', async () => {
    const { local, registry } = owner()
    registry.scan([running('a', 7507, { path: '/api/mcp', startedBy: agent })], [7507])
    await local.runningNow()
    // The Server URL's GET failed once: the list shows the guessed root address instead.
    for (let scan = 0; scan < 3; scan++) {
      clock += 3000
      registry.scan([running('a', 7507, { isHttp: false, startedBy: agent })], [7507])
    }
    await local.runningNow()
    expect(requests).toEqual(['http://127.0.0.1:7507/api/mcp'])
  })

  test('shows under Found on this host and raises the card in the agent\'s session, with no Server URL', async () => {
    answers.set('http://127.0.0.1:7508/mcp', { isMcp: true, serverInfo: { name: 'notes', title: 'Notes' } })
    const { local, registry, cards } = owner()
    registry.scan([running('a', 7508, { isHttp: false, startedBy: agent })], [7508])
    clock += 3000
    registry.scan()
    const now = await local.runningNow()
    expect(now.servers).toEqual([{ url: 'http://127.0.0.1:7508/mcp', place: { kind: 'port', runningServerId: 'a', endpointId: '7508', port: 7508, processName: 'node', checkout: 'main', serverInfo: { name: 'notes', title: 'Notes' }, startedBySessionId: 'session-9' } }])
    clock += 3000
    registry.scan()
    await local.runningNow()
    expect(cards).toEqual([{ sessionId: 'session-9', name: 'Notes', url: 'http://127.0.0.1:7508/mcp' }])
  })

  test('the owner starts no timer of its own over many scans', async () => {
    const timeouts = spyOn(globalThis, 'setTimeout')
    const intervals = spyOn(globalThis, 'setInterval')
    try {
      const { local, registry } = owner()
      registry.scan([running('a', 7509, { isHttp: false, startedBy: agent })], [7509])
      for (let scan = 0; scan < 5; scan++) {
        clock += 3000
        registry.scan()
      }
      await local.runningNow()
      local.stop()
      // WHY: the checks follow the registry's scans and the clients' leases; no timer of their own runs on the host.
      expect(timeouts).not.toHaveBeenCalled()
      expect(intervals).not.toHaveBeenCalled()
    } finally {
      timeouts.mockRestore()
      intervals.mockRestore()
    }
  })

  describe('with real loopback listeners', () => {
    let mcp: Server
    let raw: TcpServer
    let mcpPort = 0
    let rawPort = 0
    let mcpRequests = 0
    let rawConnections = 0

    beforeEach(async () => {
      mcpRequests = 0
      rawConnections = 0
      mcp = createServer((req, res) => {
        mcpRequests++
        req.resume()
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { supportedVersions: ['2026-07-28'], capabilities: {}, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'scratch', version: '0.1.0' } } } }))
        })
      })
      // A service that does not speak HTTP: it answers with its own bytes and closes, as a database does.
      raw = createTcpServer((socket) => {
        rawConnections++
        socket.once('data', () => socket.end('-ERR unknown protocol\r\n'))
      })
      await new Promise<void>((resolve) => mcp.listen(0, '127.0.0.1', resolve))
      await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve))
      mcpPort = (mcp.address() as AddressInfo).port
      rawPort = (raw.address() as AddressInfo).port
    })

    afterEach(async () => {
      mcp.closeAllConnections()
      await new Promise<void>((resolve) => mcp.close(() => resolve()))
      await new Promise<void>((resolve) => raw.close(() => resolve()))
    })

    test('an MCP server answers the one request; a service that is not HTTP is "not MCP" and gets no second connection', async () => {
      const registry = new FakeRegistry()
      const local = new LocalMcpServers({ integrations: () => [], gateway: { invalidate: () => undefined, askForCustomServer: () => undefined }, factsChanged: () => undefined, now: () => clock })
      local.follow(registry)
      registry.scan([running('mcp', mcpPort, { isHttp: false, startedBy: agent }), running('raw', rawPort, { isHttp: false, startedBy: terminal })], [mcpPort, rawPort])
      for (let scan = 0; scan < 4; scan++) {
        clock += 3000
        registry.scan()
        await local.runningNow()
      }
      const now = await local.runningNow()
      expect(now.servers.map((server) => [server.url, server.place.serverInfo])).toEqual([[`http://127.0.0.1:${mcpPort}/mcp`, { name: 'scratch', version: '0.1.0' }]])
      expect(mcpRequests).toBe(1)
      expect(rawConnections).toBe(1)
      local.stop()
    })
  })
})

describe('the one request', () => {
  let listener: Server
  let base: string
  let seen: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: string }>
  let reply: (req: IncomingMessage, res: ServerResponse) => void

  beforeEach(async () => {
    seen = []
    listener = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
        reply(req, res)
      })
    })
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    listener.closeAllConnections()
    await new Promise<void>((resolve) => listener.close(() => resolve()))
  })

  test('a server of revision 2025 answers with a JSON-RPC error, which counts as MCP, and no initialize follows', async () => {
    reply = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID provided' }, id: null }))
    }
    expect(await discoverOnLoopback(new URL(`${base}/mcp`))).toEqual({ isMcp: true })
    expect(seen.map((request) => [request.method, request.path, JSON.parse(request.body).method])).toEqual([['POST', '/mcp', 'server/discover']])
    // WHY: any local process can answer; it must never get a credential.
    expect(seen[0]!.headers.authorization).toBeUndefined()
    expect(seen[0]!.headers.cookie).toBeUndefined()
  })

  test('a modern server says its name', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { supportedVersions: ['2026-07-28'], capabilities: {}, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'weather', title: 'Weather', version: '2.1.0' } } } }))
    }
    expect(await discoverOnLoopback(new URL(`${base}/mcp`))).toEqual({ isMcp: true, serverInfo: { name: 'weather', title: 'Weather', version: '2.1.0' } })
  })

  test('an event stream that stays open counts, and the request ends without waiting for it', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 0, result: { supportedVersions: ['2026-07-28'], capabilities: {}, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'stream', version: '1' } } } })}\n\n`)
    }
    const started = Date.now()
    expect(await discoverOnLoopback(new URL(`${base}/mcp`))).toEqual({ isMcp: true, serverInfo: { name: 'stream', version: '1' } })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('a 401 counts only when its challenge names resource_metadata', async () => {
    let challenge = `Bearer resource_metadata="${'http://127.0.0.1/.well-known/oauth-protected-resource'}"`
    reply = (_req, res) => {
      res.writeHead(401, { 'www-authenticate': challenge })
      res.end()
    }
    expect(await discoverOnLoopback(new URL(`${base}/mcp`))).toEqual({ isMcp: true })
    challenge = 'Basic realm="admin"'
    expect(await discoverOnLoopback(new URL(`${base}/mcp`))).toEqual({ isMcp: false })
  })

  test('a web page and a redirect are not MCP, and the redirect is not followed', async () => {
    reply = (req, res) => {
      if (req.url === '/elsewhere') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} }))
        return
      }
      if (req.url === '/mcp') {
        res.writeHead(302, { location: '/elsewhere' })
        res.end()
        return
      }
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<html><title>Not here</title></html>')
    }
    expect(await discoverOnLoopback(new URL(`${base}/`))).toEqual({ isMcp: false })
    expect(await discoverOnLoopback(new URL(`${base}/mcp`))).toEqual({ isMcp: false })
    expect(seen.map((request) => request.path)).toEqual(['/', '/mcp'])
  })
})

describe('the suggestion', () => {
  const store = new IntegrationStore()

  function found(local: InstanceType<typeof LocalMcpServers>) {
    return new FoundServers({
      store,
      events: { broadcast: () => 1 } as never,
      gateway: { forget: () => undefined, invalidate: () => undefined },
      connections: { removeAllFor: () => undefined, submitEnvironment: () => ({}) as never, environmentFor: () => null, submitKey: async () => ({}) as never },
      home: '/nonexistent-home-for-test',
      env: { NODE_ENV: 'test' },
      platform: 'linux',
      local,
    })
  }

  test('a running MCP server is a suggestion with its port, process, and what it said; nothing is added without the add', async () => {
    answers.set('http://127.0.0.1:7201/mcp', { isMcp: true, serverInfo: { name: 'weather', title: 'Weather', version: '2.1.0' } })
    const { local, registry } = owner()
    registry.scan([running('a', 7201)], [7201])
    const list = await found(local).list(ADMIN, OWNER, {})
    expect(list.portScan).toEqual({ state: 'ready' })
    expect(list.servers).toHaveLength(1)
    const server = list.servers[0]!
    expect(server).toMatchObject({ name: 'Weather', state: 'new', transport: { kind: 'http', url: 'http://127.0.0.1:7201/mcp', headerNames: [] } })
    expect(server.foundIn).toEqual([{ kind: 'port', runningServerId: 'a', endpointId: '7201', port: 7201, processName: 'node', checkout: 'main', serverInfo: { name: 'weather', title: 'Weather', version: '2.1.0' } }])
    expect(store.list({ kind: 'organizations', organizationIds: ['local'] } as never, OWNER)).toEqual([])
  })

  test('a server already added under localhost shows as added', async () => {
    answers.set('http://127.0.0.1:7202/mcp', { isMcp: true })
    const added = store.create({ name: 'Mine', url: 'http://localhost:7202/mcp/', slug: 'mine', auth: { kind: 'none' } }, 'local', OWNER)
    const { local, registry } = owner()
    registry.scan([running('a', 7202)], [7202])
    const list = await found(local).list(ADMIN, OWNER, {})
    expect(list.servers.map((server) => [server.state, server.integrationId])).toEqual([['added', added.id]])
  })

  test('the add is the probe and the create of a typed loopback URL; another answer adds nothing', async () => {
    const fake = await startFakeServers()
    try {
      const port = Number(new URL(fake.base).port)
      answers.set(fake.mcpUrl, { isMcp: true })
      const { local, registry } = owner()
      registry.scan([running('a', port)], [port])
      const servers = found(local)
      const [server] = (await servers.list(ADMIN, OWNER, {})).servers
      expect(await servers.add(ADMIN, OWNER, { foundId: server!.foundId, fingerprint: 'another' })).toEqual({ kind: 'found-changed' })
      const result = await servers.add(ADMIN, OWNER, { foundId: server!.foundId, fingerprint: server!.fingerprint })
      expect(result.kind).toBe('saved')
      if (result.kind !== 'saved') return
      // The probe of a typed URL decided the sign-in: this fake server asks for OAuth.
      expect(result.integration).toMatchObject({ kind: 'mcp', url: fake.mcpUrl, name: 'node', auth: { kind: 'oauth' } })
      // The process ended before the add: nothing is added.
      registry.scan([], [])
      expect(await servers.add(ADMIN, OWNER, { foundId: server!.foundId, fingerprint: server!.fingerprint })).toEqual({ kind: 'found-changed' })
    } finally {
      await fake.close()
    }
  })

  test('a host that cannot list its listeners says so, and the files still list', async () => {
    const { local, registry } = owner()
    registry.fail('Cannot read listening processes.')
    // A failed scan is not fresh: the read scans again, and that fails too.
    registry.list = async () => { throw new Error('Cannot read listening processes.') }
    const list = await found(local).list(ADMIN, OWNER, {})
    expect(list.portScan).toEqual({ state: 'unavailable', reason: 'Cannot read listening processes.' })
    expect(list.servers).toEqual([])
    const without = new LocalMcpServers({ integrations: () => [], gateway: { invalidate: () => undefined, askForCustomServer: () => undefined }, factsChanged: () => undefined })
    expect((await without.runningNow()).portScan.state).toBe('unavailable')
  })
})

describe('Not running', () => {
  test('is derived from a fresh list, is unknown without one, and is never written', async () => {
    const integration = loopbackIntegration('int-weather', 'http://localhost:7301/mcp')
    const before = structuredClone(integration)
    const { local, registry, factsEvents } = owner([integration])
    expect(local.reachable(integration)).toBe('unknown')
    registry.scan([], [7301])
    expect(local.reachable(integration)).toBe('running')
    registry.scan([], [])
    expect(local.reachable(integration)).toBe('not-running')
    // WHY: a row never shows "Not running" from an old list.
    clock += 11_000
    expect(local.reachable(integration)).toBe('unknown')
    registry.fail('Cannot read listening processes.')
    expect(local.reachable(integration)).toBe('unknown')
    expect(local.reachable(loopbackIntegration('remote', 'https://mcp.example.com/mcp'))).toBeUndefined()
    expect(local.reachable({ kind: 'stdio', url: 'stdio:abc' })).toBeUndefined()
    // Each change a scan makes tells clients to read the facts again; the record itself is never changed.
    expect(factsEvents).toEqual(['int-weather', 'int-weather'])
    expect(integration).toEqual(before)
  })

  test('a server that starts again gets its tools listed again for the next run', async () => {
    const fake = await startFakeServers()
    const port = Number(new URL(fake.base).port)
    const integration = loopbackIntegration('int-back', fake.modernMcpUrl)
    const gateway = new IntegrationGateway({ get: (id: string) => (id === integration.id ? integration : null), list: () => [integration] } as never)
    try {
      const { registry, invalidated } = owner([integration], gateway)
      await withActingScope(HOST_SCOPE, () => gateway.tools(integration.id))
      registry.scan([], [port])
      await withActingScope(HOST_SCOPE, () => gateway.tools(integration.id))
      // The list is cached while the server keeps running.
      expect(fake.modernToolLists).toBe(1)
      registry.scan([], [])
      registry.scan([], [port])
      expect(invalidated).toEqual([integration.id])
      await withActingScope(HOST_SCOPE, () => gateway.tools(integration.id))
      expect(fake.modernToolLists).toBe(2)
    } finally {
      await gateway.close()
      await fake.close()
    }
  })

  test('another process on the port also drops the old tool list', () => {
    const integration = loopbackIntegration('int-swap', 'http://127.0.0.1:7302/mcp')
    const { registry, invalidated } = owner([integration])
    registry.scan([running('first', 7302, { contentType: 'text/html' })], [7302])
    registry.scan([running('second', 7302, { contentType: 'text/html' })], [7302])
    expect(invalidated).toEqual([integration.id])
  })

  test('a refused call says the server is not running, not the socket error', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const integration = loopbackIntegration('int-down', `http://127.0.0.1:${port}/mcp`)
    const gateway = new IntegrationGateway({ get: (id: string) => (id === integration.id ? integration : null), list: () => [integration] } as never)
    const context: AgentToolContext = { provider: 'claude-code', cwd: '/tmp', sessionId: () => 'session-1', abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => undefined }
    try {
      const result = await withActingScope(HOST_SCOPE, () => gateway.call(integration.id, 'echo', {}, context, null))
      expect(result.ok).toBe(false)
      expect(result.text).toMatch(/^Server int-down is not running on .+\. Start it, then try again\.$/)
    } finally {
      await gateway.close()
    }
  })
})

describe('a server that an agent started', () => {
  const agent: RunningServer['startedBy'] = { kind: 'agent', sessionId: 'session-7' }

  test('raises one custom server card in its session, with the address filled in', async () => {
    answers.set('http://127.0.0.1:7401/mcp', { isMcp: true, serverInfo: { name: 'notes', title: 'Notes' } })
    const { local, registry, cards } = owner()
    registry.scan([running('a', 7401, { startedBy: agent })], [7401])
    await local.runningNow()
    for (let scan = 0; scan < 5; scan++) registry.scan()
    await local.runningNow()
    expect(cards).toEqual([{ sessionId: 'session-7', name: 'Notes', url: 'http://127.0.0.1:7401/mcp' }])
  })

  test('raises none for a server already added, or one that no agent started', async () => {
    answers.set('http://127.0.0.1:7402/mcp', { isMcp: true })
    answers.set('http://127.0.0.1:7403/mcp', { isMcp: true })
    const { local, registry, cards } = owner([loopbackIntegration('int-notes', 'http://localhost:7402/mcp')])
    registry.scan([running('a', 7402, { startedBy: agent }), running('b', 7403, { startedBy: { kind: 'terminal', terminalId: 't1', sessionId: 'session-7' } })], [7402, 7403])
    await local.runningNow()
    expect(cards).toEqual([])
  })

  test('the agent learns it can offer a server it started, with no client watching', () => {
    const tool = (name: string): AgentTool => ({ name, description: name, inputFields: {}, requiresApproval: false, execute: async () => ({ ok: true, text: '' }) })
    const runtime = { harness: 'Codex' as const, model: 'gpt', reasoningEffort: 'high' }
    const sentence = 'To test an MCP server that you started on this host, call connect_integration with custom: true and its localhost URL.'
    expect(runtimeInstructions(runtime, [tool('connect_integration')])).toContain(sentence)
    expect(runtimeInstructions(runtime, [tool('link')])).not.toContain(sentence)
  })
})
