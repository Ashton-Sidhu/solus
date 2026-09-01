import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { AgentTool, AgentToolContext } from '@solus/server/agents/tools/agent-tool'
import { CodexToolDispatcher } from '@solus/server/agents/codex/codex-tool-adapter'

describe('Codex dynamic tool adapter', () => {
  test('returns a terminal failure when a tool throws', async () => {
    const tool: AgentTool = {
      name: 'failing_tool',
      description: 'Fails for the test.',
      inputFields: { value: z.string() },
      requiresApproval: false,
      execute: async () => {
        throw new Error('The review target could not be prepared.')
      },
    }
    const context: AgentToolContext = {
      provider: 'codex',
      cwd: '/repo',
      sessionId: () => 'provider-session',
      solusSessionId: () => 'solus-session',
      parentToolUseId: () => undefined,
      abortSignal: new AbortController().signal,
      emit: () => {},
    }
    const dispatcher = new CodexToolDispatcher([tool], context)

    expect(await dispatcher.execute('failing_tool', { value: 'test' })).toEqual({
      ok: false,
      text: 'The review target could not be prepared.',
    })
  })
})
