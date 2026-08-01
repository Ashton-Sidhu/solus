import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { adaptClaudeTools } from '../../src/main/agents/claude/claude-tool-adapter'
import { adaptCodexTools, CodexToolDispatcher } from '../../src/main/agents/codex/codex-tool-adapter'
import { assertUniqueAgentTools, executeAgentTool, type AgentTool, type AgentToolContext } from '../../src/main/agents/tools/agent-tool'

const context: AgentToolContext = {
  provider: 'codex',
  cwd: '/tmp/project',
  sessionId: () => 'session-1',
  abortSignal: new AbortController().signal,
  parentToolUseId: () => undefined,
  emit: () => {},
}

function fakeTool(name: string, requiresApproval = false): AgentTool {
  return {
    name,
    description: `${name} description`,
    inputShape: { value: z.string() },
    requiresApproval,
    execute: async ({ value }) => ({ ok: value !== 'fail', text: value }),
  }
}

describe('provider-neutral agent tool adapters', () => {
  test('rejects duplicate selected names before provider startup', () => {
    const duplicate = [fakeTool('read'), fakeTool('read')]
    expect(() => assertUniqueAgentTools(duplicate)).toThrow('Duplicate agent tool name: read')
    expect(() => adaptCodexTools(duplicate)).toThrow('Duplicate agent tool name: read')
  })

  test('validates the canonical Zod shape for every executor', async () => {
    const result = await executeAgentTool(fakeTool('read'), { value: 42 }, context)
    expect(result.ok).toBe(false)
    expect(result.text).toContain('Invalid arguments for read')
  })

  test('Codex exposes and dispatches exactly the selected tools', async () => {
    const selected = [fakeTool('read'), fakeTool('write', true)]
    expect(adaptCodexTools(selected).map(({ name }) => name)).toEqual(['read', 'write'])

    const dispatcher = new CodexToolDispatcher(selected, context)
    await expect(dispatcher.execute('solus.read', { value: 'ok' }, 'tool-1')).resolves.toEqual({
      ok: true,
      text: 'ok',
    })
    await expect(dispatcher.execute('missing', {})).resolves.toEqual({
      ok: false,
      text: 'Unsupported dynamic tool: missing',
    })
    await expect(dispatcher.execute('read', { value: 'fail' })).resolves.toEqual({
      ok: false,
      text: 'fail',
    })
  })

  test('Claude registers the same selection and pre-approves by tool metadata', async () => {
    const selected = [fakeTool('read'), fakeTool('write', true)]
    const ask = adaptClaudeTools(selected, { ...context, provider: 'claude-code' }, 'ask')
    const auto = adaptClaudeTools(selected, { ...context, provider: 'claude-code' }, 'auto')
    const plan = adaptClaudeTools(selected, { ...context, provider: 'claude-code' }, 'plan')
    const registrations = (
      ask.server.instance as unknown as {
        _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ isError?: boolean }> }>
      }
    )._registeredTools
    const registered = Object.keys(registrations)

    expect(registered).toEqual(['read', 'write'])
    expect(adaptCodexTools(selected).map(({ name }) => name)).toEqual(registered)
    expect(ask.allowedTools).toEqual(['mcp__solus__read'])
    expect(auto.allowedTools).toEqual(['mcp__solus__read', 'mcp__solus__write'])

    await expect(registrations.read.handler({ value: 42 })).resolves.toMatchObject({ isError: true })

    const planTools = (
      plan.server.instance as unknown as {
        _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>
      }
    )._registeredTools
    await expect(planTools.write.handler({ value: 'write' })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('Cannot run write in plan mode') }],
    })
  })
})
