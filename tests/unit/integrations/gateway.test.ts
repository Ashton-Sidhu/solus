import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from '../helpers/bun-sqlite'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Integration, IntegrationConnectNeeded } from '@solus/contracts/integration-types'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { IntegrationGateway } = await import('@solus/server/integrations/gateway')
const { withActingScope } = await import('@solus/server/vault/acting-scope')
const { HOST_IDENTITY, HOST_SCOPE } = await import('@solus/server/execution/seats/acting-identity')
const { InputRequests } = await import('@solus/server/execution/sessions/input-requests')
const { integrationAgentTools, setIntegrationGateway } = await import('@solus/server/integrations/integration-tools')
const { HOST_ACTOR } = await import('@solus/server/admission/actor')

/**
 * The gateway (docs/plans/mcp-integrations.md §5.1) against a real streamable
 * HTTP MCP server on a loopback port: one upstream session per (integration,
 * person), a cached tool list, and a list the server changes.
 */

/** The host's owner and a member: each a person with a user key, as `ownerKeyOf` gives it. */
const OWNER_SCOPE = { identity: HOST_IDENTITY, personKey: 'local:owner' }
const MEMBER_SCOPE = { identity: HOST_IDENTITY, personKey: 'member-1' }

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
    _meta: { ui: { resourceUri: 'ui://echo' } },
  }, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }))
  server.registerResource('echo-ui', 'ui://echo', { mimeType: 'text/html;profile=mcp-app' }, async () => ({ contents: [{ uri: 'ui://echo', mimeType: 'text/html;profile=mcp-app', text: '<button>Echo</button>' }] }))
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
    ownerKey: 'local:test',
    kind: 'mcp',
    slug: 'fake',
    name: 'Fake',
    url: `http://127.0.0.1:${port}/mcp`,
    auth: { kind: 'none' },
    disabledTools: [],
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
  test('keeps app metadata and reads its UI on the existing integration connection', async () => {
    const gateway = gatewayFor(integration)
    const captures: string[] = []
    gateway.useAppCapture(async (call) => {
      expect(call.tool._meta).toEqual({ ui: { resourceUri: 'ui://echo' } })
      const resource = await gateway.readAppResource(call.integration.id, 'ui://echo')
      captures.push('text' in resource.contents[0] ? resource.contents[0].text : '')
    })
    try {
      const result = await withActingScope(HOST_SCOPE, () => gateway.call(integration.id, 'echo', { text: 'hi' }, context()))
      expect(result.text).toBe('echo: hi')
      expect(captures).toEqual(['<button>Echo</button>'])
    } finally {
      await gateway.close()
    }
  })

  test('a call that succeeded stays a success when its app cannot be saved', async () => {
    const gateway = gatewayFor(integration)
    gateway.useAppCapture(async () => {})
    spyOn(gateway, 'toolsFor').mockRejectedValue(new Error('tools/list failed'))
    try {
      const result = await withActingScope(HOST_SCOPE, () => gateway.call(integration.id, 'echo', { text: 'hi' }, context()))
      expect(result).toMatchObject({ ok: true, text: 'echo: hi' })
    } finally {
      await gateway.close()
    }
  })
  test('lists the tools once, caches them, and calls one', async () => {
    const gateway = gatewayFor(integration)
    const opened = upstream.length
    const tools = await withActingScope(HOST_SCOPE, () => gateway.tools(integration.id))
    expect(tools.map((tool) => [tool.name, tool.readOnly, tool.destructive])).toEqual([
      ['echo', true, false],
      ['delete_all', false, true],
      ['confirm', false, false],
    ])
    expect(await withActingScope(HOST_SCOPE, () => gateway.tools(integration.id))).toEqual(tools)
    const result = await withActingScope(HOST_SCOPE, () => gateway.call(integration.id, 'echo', { text: 'hi' }, context()))
    expect(result).toEqual({ ok: true, text: 'echo: hi' })
    // WHY: a second list and a call reuse the session the first list opened.
    expect(upstream.length - opened).toBe(1)
    await gateway.close()
  })

  test('a tool the owner turned off leaves the agents\' catalog, and a call to it is refused', async () => {
    // WHY: turning a tool off in Settings must keep agents from using it, also in a run
    // whose tool list was built before the change (docs/plans/mcp-integrations.md §6.1).
    const record: Integration = { ...integration, id: 'int-off', disabledTools: ['delete_all'] }
    const gateway = gatewayFor(record)
    await withActingScope(HOST_SCOPE, () => gateway.tools(record.id))
    setIntegrationGateway(gateway)
    try {
      expect((await integrationAgentTools(HOST_ACTOR)).map((tool) => tool.name).sort()).toEqual(['fake__confirm', 'fake__echo'])
      const refused = await withActingScope(HOST_SCOPE, () => gateway.call(record.id, 'delete_all', {}, context()))
      expect(refused.ok).toBe(false)
      expect(refused.text).toContain('turned off')
      // The list for Settings still names every tool, so the person can turn it on again.
      expect((await withActingScope(HOST_SCOPE, () => gateway.tools(record.id))).map((tool) => tool.name)).toContain('delete_all')
    } finally {
      setIntegrationGateway(null)
      await gateway.close()
    }
  })

  test('two people get two upstream sessions', async () => {
    const gateway = gatewayFor(integration)
    const opened = upstream.length
    await withActingScope(OWNER_SCOPE, () => gateway.call(integration.id, 'echo', { text: 'a' }, context()))
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

describe('integration gateway with sign-in', () => {
  /** Every `Authorization` header the server saw, in order, and the sessions it opened. */
  const seen: Array<string | undefined> = []
  const opened: McpServer[] = []
  let authServer: Server
  let oauthIntegration: Integration

  beforeAll(async () => {
    const transports = new Map<string, StreamableHTTPServerTransport>()
    authServer = createServer(async (req, res) => {
      seen.push(req.headers.authorization)
      if (req.headers.authorization !== 'Bearer good') {
        res.writeHead(401, { 'www-authenticate': 'Bearer' }).end()
        return
      }
      const parsed = req.method === 'POST' ? await body(req) : undefined
      const sessionId = req.headers['mcp-session-id']
      let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined
      if (!transport) {
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => { transports.set(id, created) },
        })
        const server = makeServer()
        opened.push(server)
        await server.connect(created)
        transport = created
      }
      await transport.handleRequest(req, res, parsed)
    })
    await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', resolve))
    const { port } = authServer.address() as AddressInfo
    oauthIntegration = {
      ...integration,
      id: 'int-oauth',
      slug: 'secure',
      name: 'Secure',
      url: `http://127.0.0.1:${port}/mcp`,
      auth: { kind: 'oauth', discover: `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`, registration: 'dynamic' },
    }
  })

  afterAll(async () => {
    await Promise.all(opened.map((server) => server.close()))
    authServer.closeAllConnections()
    await new Promise<void>((resolve) => authServer.close(() => resolve()))
  })

  /** A credentials fake: one header per person, and every `markNeedsSignIn` it received. */
  function credentialsFor(headers: Map<string, string>) {
    const refused: Array<{ integrationId: string, personKey: string }> = []
    const asked: string[] = []
    return {
      refused,
      asked,
      authorizationFor: async (_integrationId: string, personKey: string) => {
        asked.push(personKey)
        return headers.get(personKey) ?? null
      },
      markNeedsSignIn: (integrationId: string, personKey: string) => { refused.push({ integrationId, personKey }) },
    }
  }

  function signedInGateway(headers: Map<string, string>, record: Integration = oauthIntegration) {
    const gateway = gatewayFor(record)
    const credentials = credentialsFor(headers)
    gateway.useCredentials(credentials)
    const raised: IntegrationConnectNeeded[] = []
    gateway.onConnectNeeded((request) => raised.push(request))
    return { gateway, credentials, raised }
  }

  test('a person with a connection calls the tool, and their header reaches the server', async () => {
    const { gateway, raised } = signedInGateway(new Map([['local:owner', 'Bearer good']]))
    seen.length = 0
    const result = await withActingScope(OWNER_SCOPE, () => gateway.call(oauthIntegration.id, 'echo', { text: 'hi' }, context()))
    expect(result).toEqual({ ok: true, text: 'echo: hi' })
    // WHY: the token is sent to the integration's own server on every request (§4.1 rule 4).
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((header) => header === 'Bearer good')).toBe(true)
    expect(raised).toEqual([])
    await gateway.close()
  })

  test('a person with no connection gets CONNECTION_REQUIRED and the connect card', async () => {
    const { gateway, raised } = signedInGateway(new Map())
    seen.length = 0
    const result = await withActingScope(MEMBER_SCOPE, () => gateway.call(oauthIntegration.id, 'echo', { text: 'hi' }, context()))
    expect(result.ok).toBe(false)
    expect(result.text).toBe('CONNECTION_REQUIRED: Sign in to Secure in Settings → MCP, then try again.')
    // WHY: no call is made without a connection (§4.1 rule 2), and the waiting conversation shows the card.
    expect(seen).toEqual([])
    expect(raised).toEqual([{ integrationId: oauthIntegration.id, integrationName: 'Secure', sessionId: 'session-1' }])
    await gateway.close()
  })

  test('a token the server refuses moves the connection to needs-sign-in', async () => {
    const { gateway, credentials, raised } = signedInGateway(new Map([['member-1', 'Bearer bad']]))
    const result = await withActingScope(MEMBER_SCOPE, () => gateway.call(oauthIntegration.id, 'echo', { text: 'hi' }, context()))
    expect(result.text).toStartWith('CONNECTION_REQUIRED:')
    expect(credentials.refused).toEqual([{ integrationId: oauthIntegration.id, personKey: 'member-1' }])
    expect(raised.map((request) => request.sessionId)).toEqual(['session-1'])
    // WHY: the next call asks for the header again instead of reusing the refused one.
    await withActingScope(MEMBER_SCOPE, () => gateway.call(oauthIntegration.id, 'echo', { text: 'again' }, context()))
    expect(credentials.asked).toEqual(['member-1', 'member-1'])
    await gateway.close()
  })

  test('two people get two sessions, each with their own header', async () => {
    const { gateway, credentials } = signedInGateway(new Map([['local:owner', 'Bearer good'], ['member-1', 'Bearer bad']]))
    const sessionsBefore = opened.length
    const owner = await withActingScope(OWNER_SCOPE, () => gateway.call(oauthIntegration.id, 'echo', { text: 'owner' }, context()))
    const member = await withActingScope(MEMBER_SCOPE, () => gateway.call(oauthIntegration.id, 'echo', { text: 'member' }, context()))
    // WHY: the member's refused token never borrows the owner's session (§4.1 rule 1).
    expect(owner).toEqual({ ok: true, text: 'echo: owner' })
    expect(member.text).toStartWith('CONNECTION_REQUIRED:')
    expect(credentials.refused.map((entry) => entry.personKey)).toEqual(['member-1'])
    expect(opened.length - sessionsBefore).toBe(1)
    await gateway.close()
  })

  test('a person with no connection still sees the tools another person listed', async () => {
    const { gateway } = signedInGateway(new Map([['local:owner', 'Bearer good']]))
    await withActingScope(OWNER_SCOPE, () => gateway.tools(oauthIntegration.id))
    const tools = await withActingScope(MEMBER_SCOPE, () => gateway.tools(oauthIntegration.id))
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'delete_all', 'confirm'])
    await gateway.close()
  })

  test('a run lists a member\'s own server with their sign-in, on a host with no owner connection', async () => {
    // WHY: a managed host has no owner. A member's personal server refuses an anonymous
    // list, so its tools must be listed for the run's person when the run starts —
    // not at boot as the host — or a run after a restart gets none of them.
    const personal: Integration = { ...oauthIntegration, id: 'int-personal', ownerKey: 'member-1' }
    const { gateway } = signedInGateway(new Map([['member-1', 'Bearer good']]), personal)
    const memberActor = {
      principal: { kind: 'org-member' as const, userId: 'member-1', organizationId: 'org-1', organizationRole: 'member' as const, teamIds: [], hostKind: 'managed' as const, displayName: 'Member', deviceId: 'member-device', deviceLabel: 'Browser', expiresAt: Date.now() + 300_000 },
      user: { id: { kind: 'account' as const, accountId: 'member-1' }, displayName: 'Member' },
    }
    setIntegrationGateway(gateway)
    try {
      const names = (await integrationAgentTools(memberActor)).map((tool) => tool.name).sort()
      expect(names).toEqual(['secure__confirm', 'secure__delete_all', 'secure__echo'])
      // The host's own work has no person: the server refuses it, and nothing is cached as the member's.
      seen.length = 0
      const fresh = signedInGateway(new Map([['member-1', 'Bearer good']]), personal).gateway
      setIntegrationGateway(fresh)
      expect(await integrationAgentTools(HOST_ACTOR)).toEqual([])
      expect(seen.every((header) => header === undefined)).toBe(true)
      await fresh.close()
    } finally {
      setIntegrationGateway(null)
      await gateway.close()
    }
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
