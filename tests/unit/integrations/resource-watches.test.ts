import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { DatabaseSync } from '../helpers/bun-sqlite'
import { resetTestDatabase } from '../helpers/test-db'
import type { Integration } from '@solus/contracts/integration-types'
import type { ResourceWatchChangedEvent } from '@solus/contracts/integrations/resource-watch'
import type { PromptImageRef } from '@solus/contracts/types'
import type { AgentToolContext, AgentToolResult } from '@solus/server/execution/agents/tools/agent-tool'
import type { GatewayClock } from '@solus/server/integrations/stdio-process'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { IntegrationGateway } = await import('@solus/server/integrations/gateway')
const {
  ResourceWatches, MAX_LIVE_WATCHES_PER_SESSION, MAX_LIVE_WATCHES_PER_PERSON, MAX_RESOURCE_WATCH_WAKES,
  RESOURCE_WATCH_GATHER_MS, RESOURCE_WATCH_LIFETIME_MS, RESOURCE_WATCH_MIN_WAKE_INTERVAL_MS, RESOURCE_WATCH_REOPEN_FIRST_MS,
} = await import('@solus/server/integrations/resource-watches')
const { ResourceWatchStore } = await import('@solus/server/integrations/resource-watch-store')
const { resourceAgentTools } = await import('@solus/server/integrations/resource-tools')
const { withActingScope } = await import('@solus/server/vault/acting-scope')
const { HOST_IDENTITY } = await import('@solus/server/execution/seats/acting-identity')
const { adaptClaudeTools } = await import('@solus/server/execution/agents/claude/claude-tool-adapter')
const { adaptCodexTools } = await import('@solus/server/execution/agents/codex/codex-tool-adapter')
const { closeDb } = await import('@solus/server/db')

/**
 * Resource watches (docs/plans/mcp-first-class.md §11.5) against a fake server
 * of revision 2026-07-28 that answers `subscriptions/listen` with a stream, and
 * a legacy server of the v1 SDK that takes `resources/subscribe`. The owner's
 * timers run on a fake clock: a test moves the time, and no test waits for one.
 */

const PERSON = 'local:owner'
const SCOPE = { identity: HOST_IDENTITY, personKey: PERSON }
const SESSION = 'session-1'
const DOC = 'docs://release-notes'

class FakeClock implements GatewayClock {
  time = 1_000_000
  private readonly timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>()
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(() => undefined, 0)
    clearTimeout(handle)
    this.timers.set(handle, { at: this.time + ms, callback })
    return handle
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>): void { this.timers.delete(timer) }
  now(): number { return this.time }
  get pending(): number { return this.timers.size }
  /** Moves the time one due timer at a time, and lets the work each one starts finish. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms
    for (;;) {
      const next = [...this.timers].sort(([, a], [, b]) => a.at - b.at)[0]
      if (!next || next[1].at > end) break
      this.time = Math.max(this.time, next[1].at)
      this.timers.delete(next[0])
      next[1].callback()
      await settle()
    }
    this.time = end
    await settle()
  }
}

/** Requests the owner runs as its person that have not ended. */
let ownerRequests = 0
/** HTTP requests in flight, a listen stream not counted: it stays open. */
let inFlight = 0

/** One turn of the event loop with its I/O: a timer of 0 ms, never a wait for a time. */
function yieldToIo(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** Lets I/O run until nothing is in flight for a few turns of the event loop. It never waits for a time. */
async function settle(): Promise<void> {
  const deadline = Date.now() + 5_000
  let quiet = 0
  while (quiet < 20 && Date.now() < deadline) {
    await yieldToIo()
    quiet = ownerRequests === 0 && inFlight === 0 ? quiet + 1 : 0
  }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check() && Date.now() < deadline) await yieldToIo()
  await settle()
}

// ── The modern fake server ──────────────────────────────────────────────

interface Listen { id: string; uris: string[]; res: ServerResponse }
const listens = new Map<string, Listen>()
/** Every request and notification the modern server read, by method. */
const seen: Array<{ method: string; params?: { requestId?: string; notifications?: { resourceSubscriptions?: string[] }; uri?: string } }> = []
let docText = 'version 1'
/** The listen filter the server agrees to: a server may honor less than it was asked. */
let honorSubscriptions = true
let modernUrl = ''
let modern: Server

function reply(res: ServerResponse, id: string | number, result: object): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

function sse(res: ServerResponse, message: object): void {
  res.write(`data: ${JSON.stringify(message)}\n\n`)
}

function routeModern(message: { id?: string | number; method: string; params?: (typeof seen)[number]['params'] }, res: ServerResponse): void {
  seen.push({ method: message.method, params: message.params })
  // A cancel of a listen request ends its stream, as the specification asks of a server.
  if (message.method === 'notifications/cancelled') {
    const id = String(message.params?.requestId)
    listens.get(id)?.res.end()
    listens.delete(id)
  }
  if (message.id === undefined) {
    res.writeHead(202)
    res.end()
    return
  }
  switch (message.method) {
    case 'server/discover':
      return reply(res, message.id, { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: { subscribe: true } }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'docs-fake', version: '1.0.0' } } })
    case 'tools/list':
      return reply(res, message.id, { resultType: 'complete', cacheScope: 'private', ttlMs: 60_000, tools: [] })
    case 'resources/list':
      return reply(res, message.id, { resultType: 'complete', cacheScope: 'private', ttlMs: 60_000, resources: [{ uri: DOC, name: 'release-notes', title: 'Release notes', mimeType: 'text/plain' }] })
    case 'resources/templates/list':
      return reply(res, message.id, { resultType: 'complete', cacheScope: 'private', ttlMs: 60_000, resourceTemplates: [] })
    case 'resources/read':
      return reply(res, message.id, { resultType: 'complete', cacheScope: 'private', ttlMs: 0, contents: [{ uri: message.params?.uri ?? DOC, mimeType: 'text/plain', text: docText }] })
    case 'subscriptions/listen': {
      const id = String(message.id)
      const uris = message.params?.notifications?.resourceSubscriptions ?? []
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // A stream stays open: it is not in flight for `settle`.
      inFlight--
      res.on('close', () => { inFlight++; listens.delete(id) })
      listens.set(id, { id, uris, res })
      sse(res, { jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { notifications: honorSubscriptions ? { resourceSubscriptions: uris } : {}, _meta: { 'io.modelcontextprotocol/subscriptionId': id } } })
      return
    }
    default:
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }))
  }
}

/** The server sends a change on each open stream that asked for the URI. */
function changeModern(uri = DOC): void {
  for (const listen of listens.values()) {
    if (listen.uris.includes(uri)) sse(listen.res, { jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri, _meta: { 'io.modelcontextprotocol/subscriptionId': listen.id } } })
  }
}

/** The server ends every stream: what a closed client leaves behind when its abort does not reach the server. */
function endStreams(): void {
  for (const listen of listens.values()) listen.res.end()
  listens.clear()
}

const listensSeen = () => seen.filter((entry) => entry.method === 'subscriptions/listen')
const cancelsSeen = () => seen.filter((entry) => entry.method === 'notifications/cancelled').map((entry) => entry.params?.requestId)

// ── The legacy fake server (revision 2025, the v1 SDK) ─────────────────

const legacyServers: McpServer[] = []
const legacyLog: Array<{ method: string; uri: string }> = []
let legacyUrl = ''
let legacy: Server

function legacyServer(): McpServer {
  const server = new McpServer({ name: 'old-docs', version: '1.0.0' })
  server.registerResource('Release notes', DOC, { mimeType: 'text/plain', title: 'Release notes' }, async () => ({ contents: [{ uri: DOC, mimeType: 'text/plain', text: docText }] }))
  server.server.registerCapabilities({ resources: { subscribe: true } })
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => { legacyLog.push({ method: 'resources/subscribe', uri: request.params.uri }); return {} })
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => { legacyLog.push({ method: 'resources/unsubscribe', uri: request.params.uri }); return {} })
  return server
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

beforeAll(async () => {
  modern = createServer((req, res) => {
    inFlight++
    res.on('close', () => { inFlight-- })
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    void readBody(req).then((text) => routeModern(JSON.parse(text), res))
  })
  await new Promise<void>((resolve) => modern.listen(0, '127.0.0.1', resolve))
  // SAFETY: a listening TCP server's address is an AddressInfo.
  modernUrl = `http://127.0.0.1:${(modern.address() as AddressInfo).port}/mcp`

  const transports = new Map<string, StreamableHTTPServerTransport>()
  legacy = createServer(async (req, res) => {
    const text = req.method === 'POST' ? await readBody(req) : ''
    const sessionId = req.headers['mcp-session-id']
    let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined
    if (!transport) {
      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (id) => { transports.set(id, created) } })
      const server = legacyServer()
      legacyServers.push(server)
      await server.connect(created)
      transport = created
    }
    await transport.handleRequest(req, res, text ? JSON.parse(text) : undefined)
  })
  await new Promise<void>((resolve) => legacy.listen(0, '127.0.0.1', resolve))
  // SAFETY: as above.
  legacyUrl = `http://127.0.0.1:${(legacy.address() as AddressInfo).port}/mcp`
})

afterAll(async () => {
  await Promise.all(legacyServers.map((server) => server.close()))
  for (const server of [modern, legacy]) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  closeDb()
})

// ── The world of one test ───────────────────────────────────────────────

const gateways: InstanceType<typeof IntegrationGateway>[] = []
const owners: InstanceType<typeof ResourceWatches>[] = []
const attachmentDirs: string[] = []

afterEach(async () => {
  for (const owner of owners.splice(0)) owner.stop()
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()))
  endStreams()
  seen.length = 0
  legacyLog.length = 0
  docText = 'version 1'
  honorSubscriptions = true
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(process.env.SOLUS_DATA_DIR!, `solus.db${suffix}`), { force: true })
  for (const dir of attachmentDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function record(overrides: Partial<Integration> = {}): Integration {
  return {
    id: 'int-docs', organizationId: 'local', ownerKey: PERSON, kind: 'mcp', slug: 'docs', name: 'Docs', url: modernUrl,
    auth: { kind: 'none' }, disabledTools: [], createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z',
    ...overrides,
  }
}

interface World {
  gateway: InstanceType<typeof IntegrationGateway>
  owner: InstanceType<typeof ResourceWatches>
  store: InstanceType<typeof ResourceWatchStore>
  clock: FakeClock
  wakes: Array<{ sessionId: string; text: string; images: PromptImageRef[] }>
  events: ResourceWatchChangedEvent[]
  busy: Set<string>
  asked: string[]
}

function world(integrations: Integration[] = [record()], clock = new FakeClock(), store = new ResourceWatchStore()): World {
  // The gateway's idle timers run on the real clock: `clock.pending` counts the owner's timers only.
  const gateway = new IntegrationGateway({ get: (id) => integrations.find((entry) => entry.id === id) ?? null, list: () => integrations })
  gateways.push(gateway)
  const wakes: World['wakes'] = []
  const events: ResourceWatchChangedEvent[] = []
  const busy = new Set<string>()
  const asked: string[] = []
  gateway.onConnectNeeded((request) => asked.push(request.integrationName))
  const attachmentsDir = mkdtempSync(join(tmpdir(), 'solus-resource-watch-attachments-'))
  attachmentDirs.push(attachmentsDir)
  const owner = new ResourceWatches({
    store, gateway, clock, attachmentsDir,
    wake: async (sessionId, text, images) => { wakes.push({ sessionId, text, images }) },
    publish: (event) => events.push(event),
    isSessionBusy: (sessionId) => busy.has(sessionId),
    actAs: (_personKey, run) => {
      ownerRequests++
      const out = run()
      const done = () => { ownerRequests-- }
      void Promise.resolve(out).then(done, done)
      return out
    },
  })
  gateway.useResourceWatches(owner)
  owners.push(owner)
  return { gateway, owner, store, clock, wakes, events, busy, asked }
}

function context(sessionId = SESSION): AgentToolContext {
  return { provider: 'claude-code', cwd: '/tmp', sessionId: () => sessionId, abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => undefined }
}

/** The agent's tool, as a run of `integration` gets it. */
function watchTool(w: World, integration = record()) {
  const tool = resourceAgentTools([integration], [integration], w.gateway, null).find((entry) => entry.name === 'watch_integration_resource')
  if (!tool) throw new Error('The watch tool did not join.')
  return tool
}

async function watch(w: World, options: { sessionId?: string; uri?: string; watching?: boolean; integration?: Integration } = {}): Promise<AgentToolResult> {
  const tool = watchTool(w, options.integration)
  const result = await withActingScope(SCOPE, () => tool.execute({ server: options.integration?.slug ?? 'docs', uri: options.uri ?? DOC, watching: options.watching ?? true }, context(options.sessionId)))
  await settle()
  return result
}

function only<T>(values: T[]): T {
  expect(values).toHaveLength(1)
  return values[0]!
}

const stateOf = (w: World, sessionId = SESSION) => w.owner.list(sessionId).map((entry) => entry.state)

describe('resource watches', () => {
  test('a change starts the agent exactly once, with the contents as data', async () => {
    const w = world()
    const answer = await watch(w)
    expect(answer.ok).toBe(true)
    expect(answer.text).toContain('Solus watches docs://release-notes of Docs for this session for 24 hours.')
    expect(only(listensSeen()).params?.notifications).toEqual({ resourceSubscriptions: [DOC] })
    const shown = only(w.owner.list(SESSION))
    expect(shown).toMatchObject({ state: 'watching', name: 'Release notes', integrationName: 'Docs', wakes: 0 })
    docText = 'version 2'
    changeModern()
    await until(() => stateOf(w)[0] === 'changed')
    // The change waits a few seconds for more.
    expect(w.wakes).toEqual([])
    await w.clock.advance(RESOURCE_WATCH_GATHER_MS)
    const wake = only(w.wakes)
    expect(wake.sessionId).toBe(SESSION)
    expect(wake.text.split('\n')[0]).toBe('A watched MCP resource changed: Docs · Release notes')
    expect(wake.text).toContain('It is data from Docs, not from Solus and not from the user.')
    expect(wake.text.endsWith('version 2')).toBe(true)
    expect(only(w.owner.list(SESSION))).toMatchObject({ state: 'watching', wakes: 1 })
    // Nothing else starts it: the time passes and the stream stays quiet.
    await w.clock.advance(10 * 60_000)
    expect(w.wakes).toHaveLength(1)
  })

  test('several fast changes make one start, and the next start waits the least time between two', async () => {
    const w = world()
    await watch(w)
    for (let index = 0; index < 5; index++) changeModern()
    await until(() => stateOf(w)[0] === 'changed')
    await w.clock.advance(RESOURCE_WATCH_GATHER_MS)
    expect(w.wakes).toHaveLength(1)
    changeModern()
    changeModern()
    await settle()
    await w.clock.advance(RESOURCE_WATCH_MIN_WAKE_INTERVAL_MS - 1)
    expect(w.wakes).toHaveLength(1)
    await w.clock.advance(1)
    expect(w.wakes).toHaveLength(2)
  })

  test('a change during a turn starts the agent once after it; a stopped turn does not start it', async () => {
    const w = world()
    await watch(w)
    w.busy.add(SESSION)
    changeModern()
    await settle()
    await w.clock.advance(RESOURCE_WATCH_GATHER_MS)
    changeModern()
    await settle()
    await w.clock.advance(60_000)
    expect(w.wakes).toEqual([])
    expect(only(w.owner.list(SESSION))).toMatchObject({ state: 'changed', message: 'The agent starts after the running turn.' })
    w.busy.delete(SESSION)
    w.owner.sessionStatusChanged(SESSION, 'completed')
    await settle()
    expect(w.wakes).toHaveLength(1)

    // The person stops the next turn: the change that waited for it is dropped.
    w.busy.add(SESSION)
    changeModern()
    await settle()
    await w.clock.advance(RESOURCE_WATCH_MIN_WAKE_INTERVAL_MS)
    w.busy.delete(SESSION)
    w.owner.sessionStatusChanged(SESSION, 'interrupted')
    await settle()
    await w.clock.advance(10 * 60_000)
    expect(w.wakes).toHaveLength(1)
    expect(only(w.owner.list(SESSION))).toMatchObject({ state: 'watching', message: 'A change came while the turn was stopped, so the agent did not start.' })
  })

  test('a watch ends after its maximum number of starts, and the last message says so', async () => {
    const w = world()
    await watch(w)
    for (let index = 0; index < MAX_RESOURCE_WATCH_WAKES; index++) {
      changeModern()
      await settle()
      await w.clock.advance(RESOURCE_WATCH_MIN_WAKE_INTERVAL_MS)
    }
    expect(w.wakes).toHaveLength(MAX_RESOURCE_WATCH_WAKES)
    expect(w.wakes.at(-1)!.text).toContain(`the watch reached its limit of ${MAX_RESOURCE_WATCH_WAKES} starts`)
    expect(w.wakes.at(-2)!.text).not.toContain('limit')
    expect(only(w.owner.list(SESSION))).toMatchObject({ state: 'ended', endReason: 'limit' })
    await until(() => listens.size === 0)
    expect(cancelsSeen()).toHaveLength(1)
    changeModern()
    await w.clock.advance(10 * 60_000)
    expect(w.wakes).toHaveLength(MAX_RESOURCE_WATCH_WAKES)
    expect(w.clock.pending).toBe(0)
  })

  test('a session and a person have a limit of live watches', async () => {
    const w = world()
    for (let index = 0; index < MAX_LIVE_WATCHES_PER_SESSION; index++) expect((await watch(w, { uri: `docs://page-${index}` })).ok).toBe(true)
    const refused = await watch(w, { uri: 'docs://one-more' })
    expect(refused).toEqual({ ok: false, text: `This session already watches ${MAX_LIVE_WATCHES_PER_SESSION} resources. Stop one with watching: false first.` })
    for (let index = 0; index < MAX_LIVE_WATCHES_PER_PERSON - MAX_LIVE_WATCHES_PER_SESSION; index++) {
      expect((await watch(w, { sessionId: 'session-2', uri: `docs://other-${index}` })).ok).toBe(true)
    }
    expect((await watch(w, { sessionId: 'session-3', uri: DOC })).text).toBe(`The user already has ${MAX_LIVE_WATCHES_PER_PERSON} resource watches on this host. One must end first.`)
    // The same resource twice in one session is one watch.
    expect((await watch(w, { uri: 'docs://page-0' })).text).toBe('This session already watches docs://page-0 of Docs.')
  })

  test('a watch ends after its lifetime, and its stream closes', async () => {
    const w = world()
    await watch(w)
    await w.clock.advance(RESOURCE_WATCH_LIFETIME_MS)
    expect(only(w.owner.list(SESSION))).toMatchObject({ state: 'ended', endReason: 'expired' })
    await until(() => listens.size === 0)
    expect(w.clock.pending).toBe(0)
  })

  test("the person's Stop ends the stream and tells the server; the agent's watching: false does the same", async () => {
    const w = world()
    await watch(w)
    const id = only(w.owner.list(SESSION)).id
    const listenId = [...listens.keys()][0]
    expect(w.owner.stopWatch({ sessionId: 'another-session', id })).toBe(false)
    expect(w.owner.stopWatch({ sessionId: SESSION, id })).toBe(true)
    await until(() => listens.size === 0)
    expect(cancelsSeen()).toEqual([listenId])
    expect(w.owner.list(SESSION)[0]).toMatchObject({ state: 'ended', endReason: 'stopped' })
    expect(w.events.at(-1)?.watch).toMatchObject({ id, state: 'ended', endReason: 'stopped' })
    expect(w.clock.pending).toBe(0)
    changeModern()
    await w.clock.advance(10 * 60_000)
    expect(w.wakes).toEqual([])

    await watch(w)
    const stopped = await watch(w, { watching: false })
    expect(stopped).toEqual({ ok: true, text: 'Solus stopped watching docs://release-notes of Docs.' })
    await until(() => listens.size === 0)
    expect(cancelsSeen()).toHaveLength(2)
    expect(w.owner.list(SESSION).map((entry) => entry.endReason)).toEqual(['stopped', 'agent'])
  })

  test('a deleted session leaves no stream and no timer, and nothing is sent', async () => {
    const w = world()
    await watch(w)
    changeModern()
    await until(() => stateOf(w)[0] === 'changed')
    w.owner.sessionDeleted(SESSION)
    await until(() => listens.size === 0)
    expect(cancelsSeen()).toHaveLength(1)
    expect(w.clock.pending).toBe(0)
    expect(w.owner.holdsUpstream({ integrationId: 'int-docs', personKey: PERSON, accountId: 'default' })).toBe(false)
    await w.clock.advance(10 * 60_000)
    expect(w.wakes).toEqual([])
  })

  test('an archived session ends the watches of the person who archived it', async () => {
    const w = world()
    await watch(w)
    w.owner.sessionArchived(SESSION, 'someone-else')
    expect(stateOf(w)).toEqual(['watching'])
    w.owner.sessionArchived(SESSION, PERSON)
    expect(only(w.owner.list(SESSION))).toMatchObject({ state: 'ended', endReason: 'session-archived' })
    await until(() => listens.size === 0)
  })

  test('a dropped stream opens again, and the reconnect alone starts nothing', async () => {
    const w = world()
    await watch(w)
    for (const listen of listens.values()) listen.res.end()
    await until(() => stateOf(w)[0] === 'starting')
    await w.clock.advance(RESOURCE_WATCH_REOPEN_FIRST_MS)
    await until(() => stateOf(w)[0] === 'watching')
    expect(listensSeen()).toHaveLength(2)
    await w.clock.advance(10 * 60_000)
    expect(w.wakes).toEqual([])
    changeModern()
    await settle()
    await w.clock.advance(RESOURCE_WATCH_GATHER_MS)
    expect(w.wakes).toHaveLength(1)
  })

  test('a restart opens a watch of a server at a URL again and sends nothing; a command watch ends', async () => {
    const clock = new FakeClock()
    const store = new ResourceWatchStore()
    const command = record({ id: 'int-cmd', slug: 'cmd', name: 'Command', kind: 'stdio', url: 'stdio:abc' })
    const first = world([record(), command], clock, store)
    await watch(first)
    // A row of a command watch, as a running process would have left it.
    store.insert({
      id: 'watch-cmd', organizationId: 'local', sessionId: SESSION, integrationId: 'int-cmd', personKey: PERSON, accountId: 'default',
      uri: 'file:///notes', name: 'notes', status: 'live', endReason: null, statusMessage: null, wakes: 0, lastWakeAt: null,
      createdAt: clock.now(), updatedAt: clock.now(), expiresAt: clock.now() + RESOURCE_WATCH_LIFETIME_MS,
    })
    // The host stops: the owner first, then the gateway with its streams.
    first.owner.stop()
    await first.gateway.close()
    endStreams()
    const restarted = world([record(), command], clock, store)
    restarted.owner.start()
    expect(restarted.owner.list(SESSION).map((entry) => [entry.integrationName, entry.state, entry.endReason])).toEqual([
      ['Docs', 'starting', undefined],
      ['Command', 'ended', 'host-restarted'],
    ])
    await clock.advance(RESOURCE_WATCH_REOPEN_FIRST_MS)
    await until(() => listens.size === 1)
    expect(restarted.owner.list(SESSION)[0]!.state).toBe('watching')
    await clock.advance(10 * 60_000)
    expect([...first.wakes, ...restarted.wakes]).toEqual([])
  })

  test('a connection that needs sign-in moves the watch to its state and asks the person', async () => {
    const integration = record()
    const w = world([integration])
    await watch(w, { integration })
    // The person's sign-in is gone: the server now needs one, and the stream drops.
    integration.auth = { kind: 'oauth', discover: modernUrl, registration: 'dynamic' }
    for (const listen of listens.values()) listen.res.end()
    await until(() => stateOf(w)[0] === 'starting')
    await w.clock.advance(RESOURCE_WATCH_REOPEN_FIRST_MS)
    expect(stateOf(w)).toEqual(['needs-sign-in'])
    expect(w.asked).toEqual(['Docs'])
    // It tries again, later each time, and asks once.
    await w.clock.advance(60_000)
    expect(w.asked).toEqual(['Docs'])
    integration.auth = { kind: 'none' }
    await w.clock.advance(5 * 60_000)
    expect(stateOf(w)).toEqual(['watching'])
  })

  test('a server that does not honor the subscription refuses the watch', async () => {
    honorSubscriptions = false
    const w = world()
    const answer = await watch(w)
    expect(answer).toEqual({ ok: false, text: 'Docs could not watch docs://release-notes: The server does not send changes of this resource.' })
    expect(only(w.owner.list(SESSION))).toMatchObject({ state: 'ended', endReason: 'refused' })
    expect(w.clock.pending).toBe(0)
  })

  test('a legacy server gets resources/subscribe, sends the change unsolicited, and gets resources/unsubscribe at Stop', async () => {
    const old = record({ id: 'int-old', slug: 'old', name: 'Old docs', url: legacyUrl })
    const w = world([old])
    expect((await watch(w, { integration: old })).ok).toBe(true)
    expect(legacyLog).toEqual([{ method: 'resources/subscribe', uri: DOC }])
    docText = 'legacy version 2'
    await Promise.all(legacyServers.map((server) => server.server.sendResourceUpdated({ uri: DOC }).catch(() => undefined)))
    await until(() => stateOf(w)[0] === 'changed')
    await w.clock.advance(RESOURCE_WATCH_GATHER_MS)
    expect(only(w.wakes).text.endsWith('legacy version 2')).toBe(true)
    w.owner.stopWatch({ sessionId: SESSION, id: only(w.owner.list(SESSION)).id })
    await until(() => legacyLog.length === 2)
    expect(legacyLog[1]).toEqual({ method: 'resources/unsubscribe', uri: DOC })
  })

  test('both providers get the watch tool, only for a server that sends changes', async () => {
    const w = world()
    const integration = record()
    const tools = resourceAgentTools([integration], [integration], w.gateway, null)
    expect(tools.map((tool) => tool.name)).toEqual(['list_integration_resources', 'read_integration_resource', 'watch_integration_resource'])
    expect(resourceAgentTools([integration], [], w.gateway, null).map((tool) => tool.name)).not.toContain('watch_integration_resource')
    expect(adaptCodexTools(tools)[0]?.tools.map((tool) => tool.name)).toContain('watch_integration_resource')
    const { server } = adaptClaudeTools(tools, context(), 'auto')
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    await server.instance.connect(serverSide)
    const client = new LegacyClient({ name: 'test', version: '1.0.0' })
    await client.connect(clientSide)
    const listed = (await client.listTools()).tools.find((tool) => tool.name.endsWith('watch_integration_resource'))
    expect(listed?.inputSchema.required).toEqual(['server', 'uri', 'watching'])
    await client.close()
  })
})
