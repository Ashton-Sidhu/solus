import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from '../helpers/bun-sqlite'
import type { CatalogEntry, Integration, IntegrationConnection, IntegrationConnectNeeded, IntegrationCreateRequest } from '@solus/contracts/integration-types'

/**
 * `connect_integration` (docs/plans/mcp-integrations.md §13.2): an agent connects
 * the acting person to a service by name. What matters: it reuses the person's
 * own integration, adds a catalog entry only on an exact match and only as that
 * person, and always ends at the connect card, never with a credential in chat.
 */

// The gateway's input requests open the session store, which Bun reads through its own SQLite.
mock.module('node:sqlite', () => ({ DatabaseSync }))

type ToolModule = typeof import('@solus/server/integrations/connect-integration-tool')
type AgentToolModule = typeof import('@solus/server/execution/agents/tools/agent-tool')

let tool: ToolModule
let runTool: AgentToolModule['executeAgentTool']

const MEMBER = 'member-1'
const OTHER = 'member-2'

const integrations: Integration[] = []
const connections = new Map<string, IntegrationConnection>()
const cards: IntegrationConnectNeeded[] = []
const created: { owner: string; request: IntegrationCreateRequest }[] = []
let catalogEntries: CatalogEntry[] = []
let catalogQueries = 0
let probeRefuses = false

function integration(id: string, name: string, url: string, ownerKey: string): Integration {
  return {
    id, organizationId: 'local', ownerKey, kind: 'mcp', slug: name.toLowerCase(), name, url,
    auth: { kind: 'oauth', discover: url, registration: 'dynamic' },
    disabledTools: [], createdBy: null, createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z',
  }
}

function entry(id: string, name: string, url: string): CatalogEntry {
  return { id, kind: 'mcp', slug: id, name, description: `${name} tools`, domain: `${id}.example`, categories: [], popularity: null, url }
}

function contextFor(sessionId: string | undefined) {
  return {
    provider: 'codex' as const,
    cwd: '/tmp',
    sessionId: () => sessionId,
    abortSignal: new AbortController().signal,
    parentToolUseId: () => undefined,
    emit: () => {},
  }
}

const asPerson = async (personKey: string | null) => {
  const { withActingScope } = await import('@solus/server/vault/acting-scope')
  const { HOST_IDENTITY } = await import('@solus/server/execution/seats/acting-identity')
  return <T>(fn: () => T) => withActingScope({ identity: HOST_IDENTITY, personKey }, fn)
}

const connect = async (personKey: string | null, service: string) => {
  const act = await asPerson(personKey)
  return act(() => runTool(tool.connectIntegrationAgentTool, { service }, contextFor('session-c')))
}

beforeAll(async () => {
  tool = await import('@solus/server/integrations/connect-integration-tool')
  ;({ executeAgentTool: runTool } = await import('@solus/server/execution/agents/tools/agent-tool'))
  const { IntegrationGateway } = await import('@solus/server/integrations/gateway')
  const { setIntegrationGateway } = await import('@solus/server/integrations/integration-tools')
  const { IntegrationProbeRefusedError } = await import('@solus/server/integrations/integration-create')
  const gateway = new IntegrationGateway({
    get: (id) => integrations.find((candidate) => candidate.id === id) ?? null,
    list: (_scope, ownerKey) => integrations.filter((candidate) => candidate.ownerKey === ownerKey),
  })
  gateway.useCredentials({
    authorizationFor: async () => null,
    markNeedsSignIn: () => {},
    statusFor: (integrationId, personKey) => connections.get(`${integrationId}:${personKey}`) ?? null,
  })
  gateway.onConnectNeeded((request) => cards.push(request))
  setIntegrationGateway(gateway)
  tool.installConnectIntegrationTool({
    catalog: { list: async () => { catalogQueries += 1; return { entries: catalogEntries, total: catalogEntries.length } } },
    create: async (_principal, owner, request) => {
      if (probeRefuses) throw new IntegrationProbeRefusedError('not_mcp')
      created.push({ owner, request })
      const added = integration(`int-${created.length}`, request.name, request.url, owner)
      integrations.push(added)
      return added
    },
  })
})

afterAll(async () => {
  const { setIntegrationGateway } = await import('@solus/server/integrations/integration-tools')
  setIntegrationGateway(null)
  tool.installConnectIntegrationTool(null)
})

beforeEach(() => {
  integrations.length = 0
  connections.clear()
  cards.length = 0
  created.length = 0
  catalogEntries = []
  catalogQueries = 0
  probeRefuses = false
})

describe('connect_integration', () => {
  test('the person\'s own integration is used, and the catalog is not read', async () => {
    integrations.push(integration('int-linear', 'Linear', 'https://mcp.linear.app/mcp', MEMBER))
    const result = await connect(MEMBER, 'linear')
    const payload = JSON.parse(result.text) as { integration: string; status: string; askedUser: boolean }
    expect(payload).toMatchObject({ integration: 'linear', status: 'not-connected', askedUser: true })
    expect(cards).toEqual([{ integrationId: 'int-linear', integrationName: 'Linear', sessionId: 'session-c' }])
    // WHY: an installed integration must never be added a second time.
    expect(catalogQueries).toBe(0)
    expect(created).toEqual([])
  })

  test('another person\'s integration does not count, so the service is added for the caller', async () => {
    integrations.push(integration('int-other', 'Linear', 'https://mcp.linear.app/mcp', OTHER))
    catalogEntries = [entry('linear', 'Linear', 'https://mcp.linear.app/mcp')]
    await connect(MEMBER, 'Linear')
    // WHY: integrations are personal (D3); the caller owns what the agent adds for them.
    expect(created).toEqual([{ owner: MEMBER, request: { name: 'Linear', url: 'https://mcp.linear.app/mcp' } }])
  })

  test('an exact catalog match is added and ends at the connect card', async () => {
    catalogEntries = [entry('notion', 'Notion', 'https://mcp.notion.com/mcp'), entry('notion-calendar', 'Notion Calendar', 'https://cal.example/mcp')]
    const result = await connect(MEMBER, 'notion')
    expect(JSON.parse(result.text)).toMatchObject({ integration: 'notion', added: true, status: 'not-connected', askedUser: true })
    expect(created).toEqual([{ owner: MEMBER, request: { name: 'Notion', url: 'https://mcp.notion.com/mcp' } }])
    expect(cards).toEqual([{ integrationId: 'int-1', integrationName: 'Notion', sessionId: 'session-c' }])
    expect(result.text).not.toMatch(/token|password/i)
  })

  test('without an exact match it offers choices and adds nothing', async () => {
    catalogEntries = [entry('zoom', 'Zoom', 'https://mcp.zoom.us/mcp'), entry('zoominfo', 'ZoomInfo', 'https://mcp.zoominfo.com/mcp')]
    const result = await connect(MEMBER, 'zoo')
    const payload = JSON.parse(result.text) as { matches: { service: string }[] }
    expect(payload.matches.map((match) => match.service)).toEqual(['zoom', 'zoominfo'])
    // WHY: a guessed server would be written to the person's integrations without their choice.
    expect(created).toEqual([])
    expect(cards).toEqual([])
  })

  test('the same server under another name is the one the person has', async () => {
    integrations.push(integration('int-mine', 'My Notion', 'https://mcp.notion.com/mcp', MEMBER))
    catalogEntries = [entry('notion', 'Notion', 'https://mcp.notion.com/mcp')]
    await connect(MEMBER, 'Notion')
    expect(created).toEqual([])
    expect(cards.map((card) => card.integrationId)).toEqual(['int-mine'])
  })

  test('a server the probe refuses is reported and nothing is asked', async () => {
    catalogEntries = [entry('broken', 'Broken', 'https://broken.example/mcp')]
    probeRefuses = true
    const result = await connect(MEMBER, 'Broken')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('did not answer as an MCP server')
    // WHY: the agent can find the right address in the vendor's docs instead of stopping (§13.4).
    expect(result.text).toContain('remote MCP server URL')
    expect(cards).toEqual([])
  })

  test('a server that needs an API key comes with the steps to find one, never a request for it', async () => {
    integrations.push({ ...integration('int-keyed', 'Keyed', 'https://keyed.example/mcp', MEMBER), auth: { kind: 'bearer', scheme: 'bearer' } })
    const result = await connect(MEMBER, 'Keyed')
    const payload = JSON.parse(result.text) as { status: string; askedUser: boolean; setup?: string }
    expect(payload.askedUser).toBe(true)
    expect(payload.setup).toContain('API key')
    expect(payload.setup).not.toMatch(/paste|send (me|it)|share/i)
  })

  test('a connected server carries no setup steps', async () => {
    integrations.push({ ...integration('int-done', 'Done', 'https://done.example/mcp', MEMBER), auth: { kind: 'bearer', scheme: 'bearer' } })
    const connected: IntegrationConnection = { integrationId: 'int-done', status: 'connected', source: 'host', label: 'me@example.com', info: null, error: null, updatedAt: '2026-10-22T00:00:00Z' }
    connections.set(`int-done:${MEMBER}`, connected)
    const result = await connect(MEMBER, 'Done')
    expect(JSON.parse(result.text)).not.toHaveProperty('setup')
  })

  test('a turn that acts for no person adds nothing', async () => {
    catalogEntries = [entry('notion', 'Notion', 'https://mcp.notion.com/mcp')]
    const result = await connect(null, 'Notion')
    expect(result.ok).toBe(false)
    expect(created).toEqual([])
  })

  test('it asks for approval, because it can add a server', () => {
    expect(tool.connectIntegrationAgentTool.requiresApproval).toBe(true)
  })
})
