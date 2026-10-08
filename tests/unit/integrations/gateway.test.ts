import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Database } from 'bun:sqlite'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Integration } from '@solus/contracts/integration-types'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { IntegrationGateway } = await import('@solus/server/integrations/gateway')
const { withActingScope } = await import('@solus/server/vault/acting-scope')
const { HOST_IDENTITY, HOST_SCOPE } = await import('@solus/server/execution/seats/acting-identity')
const { InputRequests } = await import('@solus/server/execution/sessions/input-requests')

/**
 * The gateway (docs/plans/mcp-integrations.md §5.1) against a real streamable
 * HTTP MCP server on a loopback port: one upstream session per (integration,
 * person), a cached tool list, and a list the server changes.
 */

const MEMBER_SCOPE = { identity: HOST_IDENTITY, credentialUserId: 'account:member-1' }

/** The fake server: every MCP session it opened, so a test can count and change them. */
const upstream: McpServer[] = []
let httpServer: Server
let integration: Integration

function makeServer(): McpServer {
  const server = new McpServer({ name: 'fake', version: '1.0.0' })
  server.registerTool('echo', {
    description: 'Echo the text.',
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }))
  server.registerTool('delete_all', {
    description: 'Delete everything.',
    annotations: { destructiveHint: true },
  }, async () => ({ content: [{ type: 'text', text: 'deleted' }] }))
  server.registerTool('confirm', { description: 'Ask the person first.' }, async () => {
    const answer = await server.server.elicitInput({
      message: 'Which colour?',
      requestedSchema: { type: 'object', properties: { colour: { type: 'string', enum: ['red', 'blue'] } }, required: ['colour'] },
    })
    return { content: [{ type: 'text', text: `${answer.action}: ${String(answer.content?.colour)}` }] }
  })
  return server
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
}

function context(events: NormalizedEvent[] = [], abortSignal = new AbortController().signal): AgentToolContext {
  return {
    provider: 'claude-code',
    cwd: '/tmp',
    sessionId: () => 'session-1',
    abortSignal,
    parentToolUseId: () => undefined,
    emit: (event) => events.push(event),
  }
}

function gatewayFor(record: Integration) {
  return new IntegrationGateway({ get: (id) => (id === record.id ? record : null), list: () => [record] })
}

beforeAll(async () => {
  const transports = new Map<string, StreamableHTTPServerTransport>()
  httpServer = createServer(async (req, res) => {
    const parsed = req.method === 'POST' ? await body(req) : undefined
    const sessionId = req.headers['mcp-session-id']
    let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined
    if (!transport) {
      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => { transports.set(id, created) },
      })
      const server = makeServer()
      upstream.push(server)
      await server.connect(created)
      transport = created
    }
    await transport.handleRequest(req, res, parsed)
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address() as AddressInfo
  integration = {
    id: 'int-1',
    organizationId: 'local',
    kind: 'mcp',
    slug: 'fake',
    name: 'Fake',
    url: `http://127.0.0.1:${port}/mcp`,
    auth: { kind: 'none' },
    createdBy: null,
    createdAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
  }
})

afterAll(async () => {
  await Promise.all(upstream.map((server) => server.close()))
  httpServer.closeAllConnections()
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
})

describe('integration gateway', () => {
  test('lists the tools once, caches them, and calls one', async () => {
    const gateway = gatewayFor(integration)
    const opened = upstream.length
    expect(gateway.cachedTools(integration.id)).toBeUndefined()
    const tools = await withActingScope(HOST_SCOPE, () => gateway.tools(integration.id))
    expect(tools.map((tool) => [tool.name, tool.readOnly, tool.destructive])).toEqual([
      ['echo', true, false],
      ['delete_all', false, true],
      ['confirm', false, false],
    ])
    expect(gateway.cachedTools(integration.id)).toEqual(tools)
    await withActingScope(HOST_SCOPE, () => gateway.tools(integration.id))
    const result = await withActingScope(HOST_SCOPE, () => gateway.call(integration.id, 'echo', { text: 'hi' }, context()))
    expect(result).toEqual({ ok: true, text: 'echo: hi' })
    // WHY: a second list and a call reuse the session the first list opened.
    expect(upstream.length - opened).toBe(1)
    await gateway.close()
  })

  test('two people get two upstream sessions', async () => {
    const gateway = gatewayFor(integration)
    const opened = upstream.length
    await withActingScope(HOST_SCOPE, () => gateway.call(integration.id, 'echo', { text: 'a' }, context()))
    await withActingScope(MEMBER_SCOPE, () => gateway.call(integration.id, 'echo', { text: 'b' }, context()))
    await withActingScope(MEMBER_SCOPE, () => gateway.call(integration.id, 'echo', { text: 'c' }, context()))
    // WHY: a later sign-in puts each person's token on their own session (§4.1).
    expect(upstream.length - opened).toBe(2)
    await gateway.close()
  })

  test('invalidate drops the list and the next list opens a new session', async () => {
    const gateway = gatewayFor(integration)
    await withActingScope(HOST_SCOPE, () => gateway.tools(integration.id))
    const opened = upstream.length
    gateway.invalidate(integration.id)
    expect(gateway.cachedTools(integration.id)).toBeUndefined()
    expect((await withActingScope(HOST_SCOPE, () => gateway.tools(integration.id))).length).toBe(3)
    expect(upstream.length - opened).toBe(1)
    await gateway.close()
  })

  test('tools/list_changed from the server drops the cache and tells the listeners', async () => {
    const gateway = gatewayFor(integration)
    await withActingScope(HOST_SCOPE, () => gateway.tools(integration.id))
    const server = upstream.at(-1)!
    const changed = new Promise<string>((resolve) => gateway.onToolsChanged(resolve))
    server.registerTool('added', { description: 'New.' }, async () => ({ content: [{ type: 'text', text: 'new' }] }))
    expect(await changed).toBe(integration.id)
    expect(gateway.cachedTools(integration.id)).toBeUndefined()
    const names = (await withActingScope(HOST_SCOPE, () => gateway.tools(integration.id))).map((tool) => tool.name)
    expect(names).toContain('added')
    await gateway.close()
  })

  test('an elicitation asks the person, and their answer reaches the server', async () => {
    const gateway = gatewayFor(integration)
    const events: NormalizedEvent[] = []
    const inputRequests = new InputRequests(fakeRuntime(events))
    const call = withActingScope(HOST_SCOPE, () => gateway.call(integration.id, 'confirm', {}, {
      ...context(),
      emit: (event) => {
        events.push(event)
        // The provider-event path files the request on its session, as a provider's would be.
        if (event.type === 'question_request') inputRequests.questionIdToSession.set(event.questionId, 'session-1')
      },
    }))
    const asked = await waitFor(() => events.find((event) => event.type === 'question_request'))
    expect(asked.type === 'question_request' && asked.kind).toBe('mcp_form')
    if (asked.type !== 'question_request') throw new Error('no question')
    // WHY: the answer goes through the same RPC path a Codex elicitation's does.
    expect(await inputRequests.respondToQuestion('session-1', asked.questionId, { colour: 'blue' }, { principal: { kind: 'system' }, user: null })).toBe(true)
    expect(await call).toEqual({ ok: true, text: 'accept: blue' })
    await gateway.close()
  })

  test('an unreachable server fails the call with a short message naming the integration', async () => {
    const gateway = gatewayFor({ ...integration, url: 'http://127.0.0.1:1/mcp' })
    const result = await withActingScope(HOST_SCOPE, () => gateway.call(integration.id, 'echo', { text: 'x' }, context()))
    expect(result.ok).toBe(false)
    expect(result.text).toContain('Fake')
    await gateway.close()
  })
})

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out')
}

/** The parts of the runtime an answer touches: the live session that holds the request. */
function fakeRuntime(events: NormalizedEvent[]): SessionRuntime {
  const session = {
    sessionId: 'session-1',
    backendId: 'claude-code',
    get pendingInputEvents() { return events.filter((event) => event.type === 'question_request') },
    set pendingInputEvents(_next: NormalizedEvent[]) {},
    hasPendingInput: true,
  }
  const runtime = {
    activeSessions: new Map([['session-1', session]]),
    backends: new Map([['claude-code', { permissions: { respondToQuestion: () => false } }]]),
    reportToActiveRun: () => {},
    sessionEmitter: { resolveQuestion: () => {} },
    publish: () => {},
    statuses: { setStatus: () => {}, pendingInputStatus: () => 'running' },
  }
  // SAFETY: the test fake holds every runtime member `respondToQuestion` reads.
  return runtime as unknown as SessionRuntime
}
