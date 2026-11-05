import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { DatabaseSync } from '../helpers/bun-sqlite'
import type { Integration } from '@solus/contracts/integration-types'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'
import type { IntegrationAppCapture } from '@solus/server/integrations/gateway'
import type { Activity } from '@solus/contracts/activity'
import { memberPrincipal, withActor } from '../helpers/actors'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { IntegrationGateway } = await import('@solus/server/integrations/gateway')
const { integrationAgentTools, setIntegrationGateway } = await import('@solus/server/integrations/integration-tools')
const { IntegrationApps } = await import('@solus/server/integrations/mcp-apps')
const { ownerKeyOf } = await import('@solus/server/admission/actor')
const { newActivity, appendActivity } = await import('@solus/server/data/activity/activity')
const { closeDb } = await import('@solus/server/db')
const { closeDatabase } = await import('@solus/server/db/database')
const { upsertSessionRecord } = await import('@solus/server/data/sessions/session-records')

let nextSession = 0
const ctx = withActor({ clientId: 'test', principal: memberPrincipal('alice', 'Alice') })
const other = withActor({ clientId: 'other', principal: memberPrincipal('bob', 'Bob') })
beforeAll(() => { expect(process.env.SOLUS_TEST_DATABASES).toBe('1') })
afterAll(async () => { await closeDatabase(); closeDb() })

function setup() {
  const sessionId = `mcp-app-${++nextSession}`
  const integration: Integration = { id: 'charts', organizationId: 'org-1', ownerKey: ownerKeyOf(ctx.actor)!, kind: 'mcp', slug: 'charts', name: 'Charts', url: 'https://example.invalid/mcp', auth: { kind: 'none' }, disabledTools: [], createdBy: null, createdAt: '', updatedAt: '' }
  const gateway = new IntegrationGateway({ get: (id) => id === integration.id ? integration : null, list: () => [integration] })
  const read = spyOn(gateway, 'readAppResource').mockResolvedValue({ contents: [{ uri: 'ui://chart', mimeType: 'text/html;profile=mcp-app', text: '<button>Filter</button>' }] })
  const tools = spyOn(gateway, 'toolsFor').mockResolvedValue([{ name: 'save', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }])
  const call = spyOn(gateway, 'callAppTool').mockResolvedValue({ content: [{ type: 'text', text: 'saved' }] })
  const recorded: Activity[] = []
  const runtime: Pick<SessionRuntime, 'recordActivity' | 'actorOfSession' | 'seatForTurn'> = {
    seatForTurn: async () => null,
    actorOfSession: () => ctx.actor,
    recordActivity: async (subject, _actor, kind) => {
      const activity = newActivity(subject, { kind: 'system' }, kind)
      await appendActivity('org-1', activity)
      recorded.push(activity)
      return activity
    },
  }
  const claude = {
    toolInfo: mock(async () => ({ callable: true, readOnly: true, title: 'refresh' })),
    access: mock(async (): Promise<'allow' | 'ask' | 'deny'> => 'allow'),
    callTool: mock(async () => ({ content: [{ type: 'text', text: 'fresh' }] })),
    readResource: mock(async () => ({ contents: [] })),
  }
  const apps = new IntegrationApps(gateway, runtime, claude)
  const capture: IntegrationAppCapture = { integration, tool: { name: 'chart', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://chart' } } }, input: { region: 'west' }, result: { content: [{ type: 'text', text: '42' }] }, context: { provider: 'codex', cwd: '/fixture', sessionId: () => sessionId, abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {} } }
  return { apps, gateway, capture, recorded, read, tools, call, integration, claude, sessionId, request: () => ({ sessionId, activityId: recorded[0].id }) }
}

test('a compatible completed tool captures an immutable UI and restores its tool data', async () => {
  const s = setup()
  await s.apps.capture(s.capture)
  expect(s.recorded).toHaveLength(1)
  expect(s.recorded[0]).toMatchObject({ kind: 'mcp_app', app: { integrationId: 'charts', resourceUri: 'ui://chart' } })
  const snapshot = await s.apps.read(s.request(), ctx)
  expect(snapshot.html).toBe('<button>Filter</button>')
  expect(JSON.parse(snapshot.toolInputJson)).toEqual({ region: 'west' })
  expect(JSON.parse(snapshot.toolResultJson).content[0].text).toBe('42')
  // The saved page remains viewable without a connection to the integration.
  s.read.mockRejectedValue(new Error('Offline'))
  expect((await s.apps.read(s.request(), ctx)).html).toBe(snapshot.html)
})

test('a missing saved app reads as unavailable, without the host path', async () => {
  const sessionId = `mcp-app-${++nextSession}`
  const missing = newActivity({ kind: 'session', id: sessionId }, { kind: 'system' }, {
    kind: 'mcp_app',
    app: { integrationId: 'charts', title: 'Charts', tool: 'chart', resourceUri: 'ui://chart', assetId: `${'0'.repeat(64)}.json` },
  })
  await appendActivity('org-1', missing)
  await expect(setup().apps.read({ sessionId, activityId: missing.id }, ctx)).rejects.toThrow(/^This app is no longer available\.$/)
})

test('ordinary MCP tools and ordinary HTML resources do not create app cards', async () => {
  const ordinary = setup()
  await ordinary.apps.capture({ ...ordinary.capture, tool: { name: 'echo', inputSchema: { type: 'object' } } })
  expect(ordinary.recorded).toEqual([])
  expect(ordinary.read).not.toHaveBeenCalled()
  const html = setup()
  html.read.mockResolvedValue({ contents: [{ uri: 'ui://chart', mimeType: 'text/html', text: '<p>Not an MCP App</p>' }] })
  await html.apps.capture(html.capture)
  expect(html.recorded).toEqual([])
})

test('an app id cannot be used from another session or with another person’s connection', async () => {
  const s = setup()
  await s.apps.capture(s.capture)
  await expect(s.apps.read({ ...s.request(), sessionId: 'another-session' }, ctx)).rejects.toThrow('no longer available')
  await expect(s.apps.toolInfo({ ...s.request(), name: 'save' }, other)).rejects.toThrow('your own MCP account')
  expect(s.call).not.toHaveBeenCalled()
})

test('writes require approval on the host, including after a tool changes from read-only', async () => {
  const s = setup()
  await s.apps.capture(s.capture)
  await expect(s.apps.callTool({ ...s.request(), name: 'save', argumentsJson: '{}', approved: false }, ctx)).rejects.toThrow('approval')
  expect(s.call).not.toHaveBeenCalled()
  await s.apps.callTool({ ...s.request(), name: 'save', argumentsJson: '{"x":1}', approved: true }, ctx)
  expect(s.call).toHaveBeenCalledWith('charts', 'save', { x: 1 })
})

test('disabled tools and model-only tools stay unavailable to an app', async () => {
  const s = setup()
  await s.apps.capture(s.capture)
  s.integration.disabledTools.push('save')
  expect((await s.apps.toolInfo({ ...s.request(), name: 'save' }, ctx)).callable).toBe(false)
  s.integration.disabledTools.length = 0
  s.tools.mockResolvedValue([{ name: 'save', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['model'] } } }])
  await expect(s.apps.callTool({ ...s.request(), name: 'save', argumentsJson: '{}', approved: true }, ctx)).rejects.toThrow('cannot call')
  expect(s.call).not.toHaveBeenCalled()
})


test('app-only tools stay out of the provider list while model tools remain available', async () => {
  const s = setup()
  s.tools.mockResolvedValue([
    { name: 'visible', inputSchema: { type: 'object' } },
    { name: 'only_model', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['model'] } } },
    { name: 'only_app', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] } } },
  ])
  setIntegrationGateway(s.gateway)
  try {
    const tools = await integrationAgentTools(ctx.actor)
    expect(tools.map((tool) => tool.name)).toEqual(['charts__visible', 'charts__only_model'])
  } finally { setIntegrationGateway(null) }
})

async function claudeSession(sessionId: string, ownerKey = ownerKeyOf(ctx.actor)!) {
  await upsertSessionRecord('org-1', { sessionId, provider: 'claude-code', projectPath: '/fixture', cwd: '/fixture', lastActivityAt: 1 }, { organizationId: 'org-1', ownerKey })
}

test('a card in a Claude session obeys a deny rule on its integration tool, with the reason', async () => {
  const s = setup()
  await claudeSession(s.sessionId)
  await s.apps.capture(s.capture)
  s.claude.access.mockResolvedValueOnce('deny')
  s.tools.mockResolvedValue([{ name: 'save', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }])
  await expect(s.apps.callTool({ ...s.request(), name: 'save', argumentsJson: '{}', approved: true }, ctx)).rejects.toThrow('A Claude permission rule may cover save')
  expect(s.claude.access.mock.calls[0]?.[1]).toBe('mcp__solus__charts__save')
  expect(s.call).not.toHaveBeenCalled()
})

test('an ask rule makes a read-only integration tool of a Claude session need approval', async () => {
  const s = setup()
  await claudeSession(s.sessionId)
  await s.apps.capture(s.capture)
  s.claude.access.mockResolvedValue('ask')
  s.tools.mockResolvedValue([{ name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }])
  expect((await s.apps.toolInfo({ ...s.request(), name: 'read' }, ctx)).readOnly).toBe(false)
  await expect(s.apps.callTool({ ...s.request(), name: 'read', argumentsJson: '{}', approved: false }, ctx)).rejects.toThrow('needs your approval')
  await s.apps.callTool({ ...s.request(), name: 'read', argumentsJson: '{}', approved: true }, ctx)
  expect(s.call).toHaveBeenCalledTimes(1)
})

test('rules that cannot be read refuse a card instead of skipping Claude', async () => {
  const s = setup()
  await claudeSession(s.sessionId)
  await s.apps.capture(s.capture)
  s.claude.access.mockRejectedValueOnce(new Error('Claude did not start.'))
  await expect(s.apps.toolInfo({ ...s.request(), name: 'save' }, ctx)).rejects.toThrow('Claude did not start.')
  expect(s.call).not.toHaveBeenCalled()
})

test('a Codex session has no Claude rules to read', async () => {
  const s = setup()
  await s.apps.capture(s.capture)
  await s.apps.toolInfo({ ...s.request(), name: 'save' }, ctx)
  expect(s.claude.access).not.toHaveBeenCalled()
})

const claudeApp = {
  server: 'weather',
  tool: { name: 'show_weather' },
  resourceUri: 'ui://weather',
  input: { city: 'Oslo' },
  result: { content: [{ type: 'text', text: '19' }], structuredContent: { temp: 19 } },
  resource: { contents: [{ uri: 'ui://weather', mimeType: 'text/html;profile=mcp-app', text: '<button>Refresh</button>' }] },
}

test("an app of Claude's own server is saved, reopens with its data, and calls through Claude", async () => {
  const s = setup()
  await claudeSession(s.sessionId)
  await s.apps.captureClaude(s.sessionId, claudeApp)
  expect(s.recorded[0]).toMatchObject({ kind: 'mcp_app', app: { claudeServer: 'weather', tool: 'show_weather', title: 'weather · show_weather' } })
  const saved = await s.apps.read(s.request(), ctx)
  expect(JSON.parse(saved.toolResultJson)).toEqual(claudeApp.result)
  await s.apps.callTool({ ...s.request(), name: 'refresh', argumentsJson: '{"city":"Oslo"}', approved: false }, ctx)
  expect(s.claude.callTool.mock.calls[0]?.slice(1)).toEqual(['weather', 'refresh', { city: 'Oslo' }])
  expect(s.call).not.toHaveBeenCalled()
})

test("only the session's owner reaches a server of Claude's own", async () => {
  const s = setup()
  await claudeSession(s.sessionId, ownerKeyOf(other.actor)!)
  await s.apps.captureClaude(s.sessionId, claudeApp)
  await expect(s.apps.toolInfo({ ...s.request(), name: 'refresh' }, ctx)).rejects.toThrow('Only the person who ran this session')
  expect(s.claude.toolInfo).not.toHaveBeenCalled()
})
