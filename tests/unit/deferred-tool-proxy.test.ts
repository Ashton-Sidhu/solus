import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { AgentTool } from '@solus/server/execution/agents/tools/agent-tool'
import { runToolServer, type RunToolBinding } from '@solus/server/execution/agents/tools/agent-tool-endpoint'
import { MAX_PROXY_RESULT_BYTES, TOOL_CALL, TOOL_SEARCH } from '@solus/server/execution/agents/tools/deferred-tool-proxy'

function makeTool(name: string, options: Partial<AgentTool> = {}): AgentTool {
  return {
    name,
    description: options.description ?? `Run ${name}.`,
    inputFields: options.inputFields ?? { value: z.string().optional() },
    requiresApproval: options.requiresApproval ?? false,
    alwaysLoad: options.alwaysLoad ?? false,
    isOffered: options.isOffered,
    execute: options.execute ?? (async (input) => ({ ok: true, text: JSON.stringify({ called: name, input }), format: 'json' })),
  }
}

async function mcpRequest(binding: RunToolBinding, method: string, params: Record<string, z.core.util.JSONType> = {}) {
  const handler = createMcpHandler(() => runToolServer(binding), { responseMode: 'sse' })
  const response = await handler.fetch(new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }))
  const text = await response.text()
  const jsonLine = text.split('\n').find((line) => line.startsWith('data: '))?.slice('data: '.length) ?? text
  const body = JSON.parse(jsonLine) as { result?: { tools?: Array<{ name: string }>; content?: Array<{ type: string; text?: string; data?: string }>; isError?: boolean; structuredContent?: Record<string, z.core.util.JSONType> }; error?: { code: number; message: string } }
  if (!body.result) throw new Error(`MCP error: ${JSON.stringify(body)}`)
  return body.result
}

function bindingFor(tools: AgentTool[], overrides: Partial<RunToolBinding> = {}): RunToolBinding {
  return {
    tools,
    context: {
      provider: 'antigravity',
      cwd: '/tmp',
      sessionId: () => 'session-1',
      abortSignal: new AbortController().signal,
      emit: () => {},
    },
    permissionMode: () => 'auto',
    approve: async () => true,
    deferProxy: true,
    ...overrides,
  }
}

describe('deferred-proxy MCP tool exposure', () => {
  test('tools/list exposes only alwaysLoad tools plus tool_search and tool_call when deferProxy is enabled', async () => {
    const tools: AgentTool[] = [
      makeTool('render_artifact', { alwaysLoad: true }),
      makeTool('start_sessions', { alwaysLoad: true }),
      ...Array.from({ length: 45 }, (_, index) => makeTool(`paper__tool_${index}`, { description: `Paper tool ${index}` })),
    ]
    const proxied = await mcpRequest(bindingFor(tools, { deferProxy: true }), 'tools/list')
    expect(proxied.tools?.map((tool) => tool.name)).toEqual(['render_artifact', 'start_sessions', TOOL_SEARCH, TOOL_CALL])

    // Harnesses without deferProxy (Claude, Codex) still list all enabled tools directly.
    const direct = await mcpRequest(bindingFor(tools, { deferProxy: false }), 'tools/list')
    expect(direct.tools).toHaveLength(47)
  })

  test('tool_search finds MCP server tools by server slug and exact name within the 8 KB result budget', async () => {
    const bigDescription = 'D'.repeat(600)
    const tools: AgentTool[] = [
      makeTool('read_session', { description: 'Read a Solus session transcript.' }),
      ...Array.from({ length: 25 }, (_, index) => makeTool(`paper__artboard_${index}`, {
        description: `Paper: manage artboard ${index}. ${bigDescription}`,
        inputFields: { artboardId: z.string().describe('Artboard id'), payload: z.string().describe(bigDescription) },
      })),
      makeTool('paper__hidden', { isOffered: () => false }),
    ]
    const result = await mcpRequest(bindingFor(tools), 'tools/call', { name: TOOL_SEARCH, arguments: { query: 'paper' } })
    expect(result.isError).toBeUndefined()
    const rawText = result.content?.[0]?.text ?? ''
    expect(Buffer.byteLength(rawText, 'utf8')).toBeLessThanOrEqual(MAX_PROXY_RESULT_BYTES)
    const parsed = JSON.parse(rawText) as { tools: Array<{ name: string; inputSchema?: object }> }
    expect(parsed.tools.length).toBeGreaterThan(3)
    expect(parsed.tools.every((tool) => tool.name.startsWith('paper__'))).toBe(true)
    expect(parsed.tools.some((tool) => tool.name === 'paper__hidden')).toBe(false)
    // Early matches carry schemas; overflow matches stay compact so more names fit in the budget.
    expect(parsed.tools[0]?.inputSchema).toBeDefined()
    expect(parsed.tools.some((tool) => tool.inputSchema === undefined)).toBe(true)

    // Searching by exact tool name returns its inputSchema.
    const exact = await mcpRequest(bindingFor(tools), 'tools/call', { name: TOOL_SEARCH, arguments: { query: 'paper__artboard_19' } })
    const exactParsed = JSON.parse(exact.content?.[0]?.text ?? '{}') as { tools: Array<{ name: string; inputSchema?: object }> }
    expect(exactParsed.tools[0]).toMatchObject({ name: 'paper__artboard_19', inputSchema: { type: 'object' } })
  })

  test('tool_call executes deferred tools with images and structured JSON, and enforces approval and plan mode', async () => {
    const tools: AgentTool[] = [
      makeTool('paper__screenshot', {
        execute: async (input) => ({
          ok: true,
          text: JSON.stringify({ id: input.value }),
          format: 'json',
          images: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
        }),
      }),
      makeTool('paper__delete_all', { requiresApproval: true }),
    ]

    const screenshot = await mcpRequest(bindingFor(tools), 'tools/call', {
      name: TOOL_CALL,
      arguments: { name: 'paper__screenshot', arguments: { value: 'node-1' } },
    })
    expect(screenshot.isError).toBeUndefined()
    expect(screenshot.structuredContent).toEqual({ id: 'node-1' })
    expect(screenshot.content).toEqual([
      { type: 'text', text: '{"id":"node-1"}' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])

    // Destructive tools are still refused in plan mode through tool_call.
    const blockedInPlan = await mcpRequest(bindingFor(tools, { permissionMode: () => 'plan' }), 'tools/call', {
      name: TOOL_CALL,
      arguments: { name: 'paper__delete_all', arguments: {} },
    })
    expect(blockedInPlan.isError).toBe(true)
    expect(blockedInPlan.content?.[0]?.text).toContain('Cannot run paper__delete_all in plan mode')

    // Recursive calls to tool_call or tool_search are refused.
    const recursive = await mcpRequest(bindingFor(tools), 'tools/call', {
      name: TOOL_CALL,
      arguments: { name: TOOL_CALL, arguments: { name: 'paper__screenshot' } },
    })
    expect(recursive.isError).toBe(true)
  })
})
