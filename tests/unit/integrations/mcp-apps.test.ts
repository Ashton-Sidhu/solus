import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { Integration } from '@solus/contracts/integration-types'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'
import type { IntegrationAppCapture } from '@solus/server/integrations/gateway'
import type { Activity } from '@solus/contracts/activity'
import { memberPrincipal, withActor } from '../helpers/actors'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { IntegrationGateway } = await import('@solus/server/integrations/gateway')
const { integrationAgentTools, setIntegrationGateway } = await import('@solus/server/integrations/integration-tools')
const { IntegrationApps } = await import('@solus/server/integrations/mcp-apps')
const { ownerKeyOf } = await import('@solus/server/admission/actor')
const { newActivity, appendActivity } = await import('@solus/server/data/activity/activity')
const { closeDb } = await import('@solus/server/db')
const { closeDatabase } = await import('@solus/server/db/database')

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
  const runtime: Pick<SessionRuntime, 'recordActivity' | 'actorOfSession'> = {
    actorOfSession: () => ctx.actor,
    recordActivity: async (subject, _actor, kind) => {
      const activity = newActivity(subject, { kind: 'system' }, kind)
      await appendActivity('org-1', activity)
      recorded.push(activity)
      return activity
    },
  }
  const apps = new IntegrationApps(gateway, runtime)
  const capture: IntegrationAppCapture = { integration, tool: { name: 'chart', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://chart' } } }, input: { region: 'west' }, result: { content: [{ type: 'text', text: '42' }] }, context: { provider: 'codex', cwd: '/fixture', sessionId: () => sessionId, abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {} } }
  return { apps, gateway, capture, recorded, read, tools, call, integration, request: () => ({ sessionId, activityId: recorded[0].id }) }
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
