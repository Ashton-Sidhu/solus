import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { AgentTool } from '@solus/server/execution/agents/tools/agent-tool'
import { adaptClaudeTools, claudeParentToolUseId } from '@solus/server/execution/agents/claude/claude-tool-adapter'

describe('claudeParentToolUseId', () => {
  test('recovers the streamed tool-use id from the MCP request _meta', () => {
    expect(claudeParentToolUseId({ _meta: { 'claudecode/toolUseId': 'toolu_123' } })).toBe('toolu_123')
  })

  test('degrades to undefined — never throws or blocks — when the CLI omits the id', () => {
    // The meta key is an undocumented CLI internal. If a future CLI drops or
    // renames it, tool execution must proceed (cards just lose nesting).
    expect(claudeParentToolUseId(undefined)).toBeUndefined()
    expect(claudeParentToolUseId({})).toBeUndefined()
    expect(claudeParentToolUseId({ _meta: {} })).toBeUndefined()
    expect(claudeParentToolUseId({ _meta: { 'claudecode/toolUseId': '' } })).toBeUndefined()
    expect(claudeParentToolUseId({ _meta: { 'claudecode/toolUseId': 42 } })).toBeUndefined()
  })
})

// WHY: the Claude SDK validates a call with its own bundled zod before our
// own parse runs, and that copy refused a left-out field with a default, even
// one wrapped in `.optional()`. A start_session call without `report` or
// `wait_seconds` failed with "expected nonoptional" before Solus saw it. Only
// a real call through the SDK's server proves the fields it gets.
describe('the fields Claude validates a call against', () => {
  test('a call can leave a field with a default out, and the tool gets the default', async () => {
    const inputs: object[] = []
    const tool: AgentTool = {
      name: 'start_thing',
      description: 'Start a thing.',
      inputFields: { prompt: z.string(), report: z.boolean().default(true).describe('Report back.'), wait_seconds: z.number().default(0) },
      requiresApproval: false,
      execute: async (input) => { inputs.push(input); return { ok: true, text: 'ok' } },
    }
    const { server } = adaptClaudeTools([tool], {
      provider: 'claude-code', cwd: '/tmp', sessionId: () => 'session-1', abortSignal: new AbortController().signal,
      parentToolUseId: () => undefined, emit: () => {},
    }, 'default')
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    await server.instance.connect(serverSide)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(clientSide)

    const leftOut = await client.callTool({ name: tool.name, arguments: { prompt: 'go' } })
    expect(leftOut.isError).toBeUndefined()
    expect(inputs).toEqual([{ prompt: 'go', report: true, wait_seconds: 0 }])
    // A required field stays required, and a wrong type is still refused.
    expect((await client.callTool({ name: tool.name, arguments: {} })).isError).toBe(true)
    expect((await client.callTool({ name: tool.name, arguments: { prompt: 'go', report: 'yes' } })).isError).toBe(true)
    expect(inputs).toHaveLength(1)
    // The agent still reads what the field means.
    const listed = await client.listTools()
    expect(JSON.stringify(listed.tools[0]?.inputSchema)).toContain('Report back.')
    await client.close()
  })
})

// WHY: device_screenshot parity needs the agent to see the image itself, not
// a host file path it may not be able to read (plan 016, P09).
describe('tool results with an image', () => {
  test('Claude receives the text and then the PNG as an image block', async () => {
    const { claudeToolResponse } = await import('@solus/server/execution/agents/claude/claude-tool-adapter')
    const response = claudeToolResponse({ ok: true, text: 'Screenshot', image: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } })
    expect(response.content).toEqual([
      { type: 'text', text: 'Screenshot' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])
    expect(claudeToolResponse({ ok: false, text: 'no' })).toEqual({ content: [{ type: 'text', text: 'no' }], isError: true })
  })
})
