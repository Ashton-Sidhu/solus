import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { AgentTool, AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import { bindRunTools, callToolUseId, mcpToolResult, setAgentToolEndpointUrl, type RunToolAccess } from '@solus/server/execution/agents/tools/agent-tool-endpoint'
import { serveMcp } from '@solus/server/transport/mcp-endpoint'
import { runToolClient } from './helpers/run-tool-client'

const context: Omit<AgentToolContext, 'parentToolUseId'> = {
  provider: 'claude-code', cwd: '/tmp', sessionId: () => 'session-1', abortSignal: new AbortController().signal, emit: () => {},
}

function echoTool(seen: Array<string | undefined>, requiresApproval = false): AgentTool {
  return {
    name: 'echo', description: 'Echo the text.', inputFields: { text: z.string() }, requiresApproval,
    execute: async (input, toolContext) => { seen.push(toolContext.parentToolUseId()); return { ok: true, text: String(input.text) } },
  }
}

beforeAll(() => setAgentToolEndpointUrl('http://127.0.0.1:1/mcp'))
const bound: RunToolAccess[] = []
afterEach(() => { for (const access of bound.splice(0)) access.release() })

/** A harness's MCP client over HTTP, through the host's real `/mcp` handler. */
async function httpClient(authorization: string | null): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
    fetch: (url, init) => serveMcp(new Request(url, init)),
    requestInit: authorization ? { headers: { Authorization: authorization } } : {},
  })
  const client = new Client({ name: 'harness', version: '1.0.0' })
  await client.connect(transport)
  return client
}

// WHY: every harness reaches its run's tools at one URL with the run's token
// (plans/035 §3-§4). The token is the run's only credential: without it, or
// after the run, the endpoint answers nothing.
describe('the MCP endpoint', () => {
  test("a run's token lists and calls the run's tools", async () => {
    const seen: Array<string | undefined> = []
    const access = bindRunTools({ tools: [echoTool(seen)], context, permissionMode: () => 'supervised', approve: async () => true })
    bound.push(access)
    const client = await httpClient(access.authorization)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo'])
    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' }, _meta: { 'claudecode/toolUseId': 'toolu_1' } })
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }])
    // The call id names the provider's tool-use block, so a tool's cards nest under it.
    expect(seen).toEqual(['toolu_1'])
    await client.close()
  })

  test('no token, an unknown token, or a token of an ended run is refused', async () => {
    expect((await serveMcp(new Request('http://127.0.0.1/mcp', { method: 'POST' }))).status).toBe(401)
    expect((await serveMcp(new Request('http://127.0.0.1/mcp', { method: 'POST', headers: { Authorization: 'Bearer nope' } }))).status).toBe(401)
    const access = bindRunTools({ tools: [echoTool([])], context, permissionMode: () => 'supervised', approve: async () => true })
    access.release()
    expect((await serveMcp(new Request('http://127.0.0.1/mcp', { method: 'POST', headers: { Authorization: access.authorization } }))).status).toBe(401)
  })

  test('a browser page cannot call it', async () => {
    const access = bindRunTools({ tools: [echoTool([])], context, permissionMode: () => 'supervised', approve: async () => true })
    bound.push(access)
    const response = await serveMcp(new Request('http://127.0.0.1/mcp', { method: 'POST', headers: { Authorization: access.authorization, Origin: 'https://evil.example' } }))
    expect(response.status).toBe(403)
  })
})

describe('approval', () => {
  test('a tool that needs approval runs only when the person allows it', async () => {
    const seen: Array<string | undefined> = []
    const declined = await runToolClient([echoTool(seen, true)], context, { approve: async () => false })
    expect((await declined.callTool({ name: 'echo', arguments: { text: 'x' } })).isError).toBe(true)
    const allowed = await runToolClient([echoTool(seen, true)], context, { approve: async () => true })
    expect((await allowed.callTool({ name: 'echo', arguments: { text: 'x' } })).isError).toBeFalsy()
    expect(seen).toHaveLength(1)
  })

  test('plan mode refuses a tool that needs approval', async () => {
    const seen: Array<string | undefined> = []
    const client = await runToolClient([echoTool(seen, true)], context, { permissionMode: () => 'plan' })
    const result = await client.callTool({ name: 'echo', arguments: { text: 'x' } })
    expect(result.isError).toBe(true)
    expect(seen).toEqual([])
  })
})

describe('callToolUseId', () => {
  test('degrades to undefined — never throws or blocks — when the harness omits the id', () => {
    // The meta key is an undocumented CLI internal. If a future CLI drops or
    // renames it, tool execution must proceed (cards just lose nesting).
    expect(callToolUseId(undefined)).toBeUndefined()
    expect(callToolUseId({})).toBeUndefined()
    expect(callToolUseId({ 'claudecode/toolUseId': '' })).toBeUndefined()
    expect(callToolUseId({ 'claudecode/toolUseId': 42 })).toBeUndefined()
  })
})

// WHY: a harness's MCP client may check a call against the listed schema
// before Solus sees it. A call that leaves out a field with a default must
// still reach the tool, which gets the default.
describe('the fields a call is checked against', () => {
  test('a call can leave a field with a default out, and the tool gets the default', async () => {
    const inputs: object[] = []
    const tool: AgentTool = {
      name: 'start_thing',
      description: 'Start a thing.',
      inputFields: { prompt: z.string(), report: z.boolean().default(true).describe('Report back.'), wait_seconds: z.number().default(0) },
      requiresApproval: false,
      execute: async (input) => { inputs.push(input); return { ok: true, text: 'ok' } },
    }
    const client = await runToolClient([tool], context)
    const leftOut = await client.callTool({ name: tool.name, arguments: { prompt: 'go' } })
    expect(leftOut.isError).toBeFalsy()
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
  test('the harness receives the text and then the PNG as an image block', () => {
    const response = mcpToolResult({ ok: true, text: 'Screenshot', images: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }] })
    expect(response.content).toEqual([
      { type: 'text', text: 'Screenshot' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])
    expect(mcpToolResult({ ok: false, text: 'no' })).toEqual({ content: [{ type: 'text', text: 'no' }], isError: true })
  })
})
