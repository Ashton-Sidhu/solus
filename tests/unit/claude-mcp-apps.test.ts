import { expect, mock, test } from 'bun:test'
import type { McpServerStatus, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { appToolResultSchema, cardAccess, ClaudeAppCapture, ClaudeAppProcesses, claudeToolName, type ClaudeMcpApp, type ClaudePermissionRule } from '@solus/server/execution/agents/claude/claude-mcp-apps'

const weatherTools = [
  { name: 'show_weather', annotations: { readOnly: true }, _meta: { ui: { resourceUri: 'ui://weather' } } },
  { name: 'refresh_weather', annotations: { readOnly: true }, _meta: { ui: { resourceUri: 'ui://weather', visibility: ['app'] } } },
  { name: 'save_city', annotations: {}, _meta: { ui: { visibility: ['app'] } } },
  { name: 'model_only', annotations: { readOnly: true }, _meta: { ui: { visibility: ['model'] } } },
]
const weather: McpServerStatus = { name: 'weather', status: 'connected', tools: weatherTools } as McpServerStatus

const CAPABILITIES = ['mcp_tool_ui_meta_v1', 'mcp_read_resource_v1', 'mcp_call_result_not_for_model_v1']
const init = (capabilities: string[]) => ({ type: 'system', subtype: 'init', capabilities }) as unknown as SDKMessage
const toolUse = (name: string, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_use', id: 'call-1', name, input: { city: 'Oslo' } }] },
}) as unknown as SDKMessage
const toolResult = (fields: { is_error?: boolean; tool_use_result?: unknown } = {}) => ({
  type: 'user',
  tool_use_result: fields.tool_use_result ?? { content: 'Oslo 19', structuredContent: { temp: 19 } },
  message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Oslo 19', is_error: fields.is_error }] },
}) as unknown as SDKMessage

function capture(statuses: McpServerStatus[] = [weather]) {
  const saved: ClaudeMcpApp[] = []
  const query = {
    mcpServerStatus: mock(async () => statuses),
    readMcpResource: mock(async () => ({ contents: [{ uri: 'ui://weather', text: '<p>app</p>' }] })),
  }
  const app = new ClaudeAppCapture(query, async (entry) => { saved.push(entry) })
  return { app, query, saved }
}

test('a finished tool of a Claude server that declares an app is captured with its rebuilt result', async () => {
  const { app, saved } = capture()
  app.observe(init(CAPABILITIES))
  app.observe(toolUse('mcp__weather__show_weather'))
  app.observe(toolResult())
  await app.settled()
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({
    server: 'weather',
    resourceUri: 'ui://weather',
    input: { city: 'Oslo' },
    result: { content: [{ type: 'text', text: 'Oslo 19' }], structuredContent: { temp: 19 } },
  })
})

test('a capture does not hold the event stream: observe returns before the server answers', async () => {
  const { app, query, saved } = capture()
  let answer!: (statuses: McpServerStatus[]) => void
  query.mcpServerStatus.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
  app.observe(init(CAPABILITIES))
  app.observe(toolUse('mcp__weather__show_weather'))
  app.observe(toolResult())
  expect(saved).toHaveLength(0)
  answer([weather])
  await app.settled()
  expect(saved).toHaveLength(1)
})

test('nothing is captured from an older CLI, a failed call, a subagent, or Solus tools', async () => {
  const cases: Array<(app: ClaudeAppCapture) => void> = [
    (app) => { app.observe(init([])); app.observe(toolUse('mcp__weather__show_weather')); app.observe(toolResult()) },
    (app) => { app.observe(init(CAPABILITIES)); app.observe(toolUse('mcp__weather__show_weather')); app.observe(toolResult({ is_error: true })) },
    (app) => { app.observe(init(CAPABILITIES)); app.observe(toolUse('mcp__weather__show_weather', 'parent')); app.observe(toolResult()) },
    (app) => { app.observe(init(CAPABILITIES)); app.observe(toolUse('mcp__solus__weather__show_weather')); app.observe(toolResult()) },
  ]
  for (const run of cases) {
    const { app, query, saved } = capture()
    run(app)
    await app.settled()
    expect(saved).toHaveLength(0)
    expect(query.readMcpResource).not.toHaveBeenCalled()
  }
})

test('a tool of an overlapping server prefix does not capture: Claude could route it to the other server', async () => {
  const { app, saved } = capture([weather, { name: 'weather__prod', status: 'connected', tools: [] } as unknown as McpServerStatus])
  app.observe(init(CAPABILITIES))
  app.observe(toolUse('mcp__weather__show_weather'))
  app.observe(toolResult())
  await app.settled()
  expect(saved).toHaveLength(0)
})

test('a tool that declares no app is not captured', async () => {
  const { app, saved } = capture()
  app.observe(init(CAPABILITIES))
  app.observe(toolUse('mcp__weather__save_city'))
  app.observe(toolResult())
  await app.settled()
  expect(saved).toHaveLength(0)
})

const rule = (behavior: ClaudePermissionRule['behavior'], name: string, notInEffect?: boolean): ClaudePermissionRule => ({ behavior, rule: name, notInEffect })

test("Claude's rules decide what a card may do", () => {
  const server = 'mcp__weather__refresh_weather'
  expect(cardAccess([], server)).toBe('allow')
  expect(cardAccess([rule('allow', server)], server)).toBe('allow')
  expect(cardAccess([rule('deny', 'Bash(rm:*)')], server)).toBe('allow')
  expect(cardAccess([rule('deny', server)], server)).toBe('deny')
  expect(cardAccess([rule('ask', 'mcp__weather')], server)).toBe('ask')
  expect(cardAccess([rule('deny', server), rule('ask', server)], server)).toBe('deny')
  // Switched-off rules do not apply.
  expect(cardAccess([rule('deny', server, true)], server)).toBe('allow')
  // An alias of a Claude server is invisible to Solus, so any MCP rule or wildcard may cover it.
  expect(cardAccess([rule('deny', 'mcp__finance__prod')], server)).toBe('deny')
  expect(cardAccess([rule('deny', '*notion*')], server)).toBe('deny')
})

test('the Solus server has no aliases, so rules on other servers leave its tools alone', () => {
  const tool = 'mcp__solus__charts__save'
  expect(cardAccess([rule('deny', 'mcp__github__delete_issue')], tool)).toBe('allow')
  expect(cardAccess([rule('deny', tool)], tool)).toBe('deny')
  expect(cardAccess([rule('ask', 'mcp__solus')], tool)).toBe('ask')
  expect(cardAccess([rule('deny', 'mcp__solus__*')], tool)).toBe('deny')
})

test('tool names follow Claude Code', () => {
  expect(claudeToolName('weather', 'refresh.weather')).toBe('mcp__weather__refresh_weather')
  expect(claudeToolName('claude.ai My  Docs', 'read')).toBe('mcp__claude_ai_My_Docs__read')
})

test('a flattened text result becomes content, and an app result stays exact', () => {
  expect(appToolResultSchema.parse('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }] })
  expect(appToolResultSchema.parse({ content: [{ type: 'text', text: 'a' }], isError: true, _meta: { x: 1 } }))
    .toEqual({ content: [{ type: 'text', text: 'a' }], isError: true, _meta: { x: 1 } })
})

function processes(responses: { rules?: unknown; statuses?: McpServerStatus[] } = {}) {
  const request = mock(async (input: { subtype: string }) => ({
    response: input.subtype === 'list_permission_rules' ? 'rules' in responses ? responses.rules : { state: { rules: [] } } : { content: 'ok' },
  }))
  const session = {
    mcpServerStatus: mock(async () => responses.statuses ?? [weather]),
    readMcpResource: mock(async () => ({ contents: [] })),
    request,
  } as unknown as Query
  const close = mock(async () => {})
  const open = mock(async () => ({ session, close }))
  return { apps: new ClaudeAppProcesses(open), request, open, close }
}

const place = { cwd: '/fixture' }

test('a card tool follows the server and the rules it can read', async () => {
  const { apps } = processes()
  expect(await apps.toolInfo(place, 'weather', 'refresh_weather')).toMatchObject({ callable: true, readOnly: true })
  expect(await apps.toolInfo(place, 'weather', 'save_city')).toMatchObject({ callable: true, readOnly: false })
  expect(await apps.toolInfo(place, 'weather', 'model_only')).toMatchObject({ callable: false })
  expect(await apps.toolInfo(place, 'weather', 'gone')).toMatchObject({ callable: false })
  await apps.closeAll()
})

test('an ask rule takes away read-only, and a deny rule refuses with the reason', async () => {
  const asks = processes({ rules: { state: { rules: [rule('ask', 'mcp__weather__refresh_weather')] } } })
  expect(await asks.apps.toolInfo(place, 'weather', 'refresh_weather')).toMatchObject({ callable: true, readOnly: false })
  const denies = processes({ rules: { state: { rules: [rule('deny', 'mcp__weather__refresh_weather')] } } })
  const info = await denies.apps.toolInfo(place, 'weather', 'refresh_weather')
  expect(info.callable).toBe(false)
  expect(info.refusal).toContain('permission rule')
  await asks.apps.closeAll()
  await denies.apps.closeAll()
})

test('rules Claude could not read, or a settings file it skipped, refuse the card', async () => {
  for (const rules of [undefined, { state: { rules: [], errors: [{ path: '/bad.json' }] } }]) {
    const { apps } = processes({ rules })
    expect((await apps.toolInfo(place, 'weather', 'refresh_weather')).callable).toBe(false)
    await apps.closeAll()
  }
})

test('two tools that reach Claude under one name are refused', async () => {
  const twin = { ...weather, tools: [...weatherTools, { name: 'refresh.weather', annotations: { readOnly: true }, _meta: {} }] } as McpServerStatus
  const { apps } = processes({ statuses: [twin] })
  expect(await apps.toolInfo(place, 'weather', 'refresh_weather')).toMatchObject({ callable: false })
  await apps.closeAll()
})

test('an app call asks Claude for the raw result, on one process per place', async () => {
  const { apps, request, open, close } = processes()
  await apps.callTool(place, 'weather', 'refresh_weather', { city: 'Oslo' })
  await apps.toolInfo(place, 'weather', 'refresh_weather')
  expect(open).toHaveBeenCalledTimes(1)
  expect(request.mock.calls[0]?.[0]).toEqual({ subtype: 'mcp_call', tool: 'mcp__weather__refresh_weather', arguments: { city: 'Oslo' }, result_not_for_model: true })
  await apps.closeAll()
  expect(close).toHaveBeenCalledTimes(1)
})

test('a server that failed to connect gives its reason instead of a hung card', async () => {
  const { apps } = processes({ statuses: [{ ...weather, status: 'failed' }] })
  await expect(apps.readResource(place, 'weather', 'ui://weather')).rejects.toThrow('not connected')
})

test('a failed request does not leave a broken process for the next one', async () => {
  const { apps, request, open } = processes()
  request.mockRejectedValueOnce(new Error('gone'))
  await expect(apps.callTool(place, 'weather', 'refresh_weather', {})).rejects.toThrow('gone')
  await apps.callTool(place, 'weather', 'refresh_weather', {})
  expect(open).toHaveBeenCalledTimes(2)
  await apps.closeAll()
})
