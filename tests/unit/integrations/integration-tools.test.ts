import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { executeAgentTool, type AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import { runToolClient } from '../helpers/run-tool-client'
import { upstreamToolToAgentTool } from '@solus/server/integrations/integration-tools'
import type { UpstreamTool } from '@solus/server/integrations/gateway'

/**
 * The tool bridge (docs/plans/mcp-integrations.md §5.2.1): one upstream MCP tool
 * becomes one Solus agent tool the provider's own loop runs.
 */

const integration = { id: 'int-1', name: 'DeepWiki', slug: 'deepwiki' }

function context(): AgentToolContext {
  return {
    provider: 'claude-code',
    cwd: '/tmp',
    sessionId: () => 'session-1',
    abortSignal: new AbortController().signal,
    parentToolUseId: () => undefined,
    emit: () => {},
  }
}

/** A gateway stand-in that records what reached it. */
function recordingCalls() {
  const calls: Array<{ integrationId: string; tool: string; input: unknown }> = []
  return {
    calls,
    gateway: {
      call: async (integrationId: string, tool: string, input: unknown) => {
        calls.push({ integrationId, tool, input })
        return { ok: true, text: 'done' }
      },
    },
  }
}

const askTool: UpstreamTool = {
  name: 'ask question',
  description: 'Ask about a repository.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'owner/name' },
      depth: { type: 'number' },
      mode: { enum: ['fast', 'deep'] },
    },
    required: ['repo'],
  },
  annotations: { readOnlyHint: true },
}

describe('integration tool bridge', () => {
  test('names the tool by slug, puts the integration name before the description, and defers it', () => {
    const tool = upstreamToolToAgentTool(integration, askTool, recordingCalls().gateway)
    // WHY: the slug prefix keeps two integrations' tools apart, and the name tells the agent whose tool it is.
    expect(tool.name).toBe('deepwiki__ask_question')
    expect(tool.description).toBe('DeepWiki: Ask about a repository.')
    expect(tool.alwaysLoad).toBe(false)
    expect(tool.requiresApproval).toBe(false)
  })

  test('a long description is cut at 1,000 characters', () => {
    const tool = upstreamToolToAgentTool(integration, { ...askTool, description: 'x'.repeat(5000) }, recordingCalls().gateway)
    expect(tool.description.length).toBe(1000)
  })

  test('a tool the server marks destructive asks for approval', () => {
    // WHY: destructiveHint is the only gate of the first release (§6).
    const tool = upstreamToolToAgentTool(integration, { ...askTool, annotations: { destructiveHint: true } }, recordingCalls().gateway)
    expect(tool.requiresApproval).toBe(true)
  })

  test('an object schema becomes Zod fields with its required, optional, and enum fields', async () => {
    const { gateway, calls } = recordingCalls()
    const tool = upstreamToolToAgentTool(integration, askTool, gateway)
    expect(tool.passthroughInput).toBeUndefined()
    expect(Object.keys(tool.inputFields)).toEqual(['repo', 'depth', 'mode'])
    const schema = z.toJSONSchema(z.object(tool.inputFields), { io: 'input' })
    expect(schema.required).toEqual(['repo'])

    expect((await executeAgentTool(tool, { depth: 1 }, context())).ok).toBe(false)
    expect((await executeAgentTool(tool, { repo: 'a/b', mode: 'slow' }, context())).ok).toBe(false)
    const result = await executeAgentTool(tool, { repo: 'a/b', mode: 'deep' }, context())
    expect(result).toEqual({ ok: true, text: 'done' })
    expect(calls).toEqual([{ integrationId: 'int-1', tool: 'ask question', input: { repo: 'a/b', mode: 'deep' } }])
  })

  test('a schema that does not convert passes the raw input through', async () => {
    const { gateway, calls } = recordingCalls()
    const tool = upstreamToolToAgentTool(integration, {
      ...askTool,
      inputSchema: { type: 'object', properties: { doc: { $ref: 'https://example.com/schema.json' } } },
    }, gateway)
    expect(tool.passthroughInput).toBe(true)
    expect(tool.inputFields).toEqual({})
    // WHY: stripping to declared fields would send the server an empty object.
    await executeAgentTool(tool, { doc: { title: 't' }, extra: 2 }, context())
    expect(calls[0]?.input).toEqual({ doc: { title: 't' }, extra: 2 })
    expect((await executeAgentTool(tool, 'not an object', context())).ok).toBe(false)
    // Every harness still sees an object that takes any key.
    const client = await runToolClient([tool], context())
    expect((await client.listTools()).tools[0]?.inputSchema).toEqual({ type: 'object', additionalProperties: true })
    await client.close()
  })

  test('Claude hands a passthrough tool every key the agent sent', async () => {
    const { gateway, calls } = recordingCalls()
    const tool = upstreamToolToAgentTool(integration, { ...askTool, inputSchema: { type: 'object', anyOf: [{ required: ['a'] }] } }, gateway)
    const client = await runToolClient([tool], context())
    // WHY: an MCP server that parses with an empty field map strips the keys it does not name; the upstream server would get nothing.
    await client.callTool({ name: tool.name, arguments: { a: 1, b: 'two' } })
    expect(calls[0]?.input).toEqual({ a: 1, b: 'two' })
    await client.close()
  })

  test('a root schema that is not an object passes through', () => {
    const tool = upstreamToolToAgentTool(integration, {
      ...askTool,
      inputSchema: { type: 'object', anyOf: [{ required: ['a'] }, { required: ['b'] }] },
    }, recordingCalls().gateway)
    expect(tool.passthroughInput).toBe(true)
  })
})
