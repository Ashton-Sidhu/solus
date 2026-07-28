import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { AgentDispatcher, AgentRun, AgentRunRequest } from '../../src/main/agents/agent-runner'
import type { AgentTool, AgentToolContext } from '../../src/main/agents/tools/agent-tool'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let createClaudeSubagentAgentTool: (dispatcher: AgentDispatcher) => AgentTool
let createCodexSubagentAgentTool: (dispatcher: AgentDispatcher) => AgentTool

beforeAll(async () => {
  ;({ createClaudeSubagentAgentTool } = await import('../../src/main/agents/claude/claude-subagent-tool'))
  ;({ createCodexSubagentAgentTool } = await import('../../src/main/agents/codex/codex-subagent-tool'))
})

class ChildDispatcher implements AgentDispatcher {
  request: AgentRunRequest | null = null

  runAgent(request: AgentRunRequest): AgentRun {
    this.request = request
    return {
      sessionId: Promise.resolve(null),
      done: Promise.resolve({
        sessionId: null,
        output: 'child result',
        toolCallCount: 0,
        permissionDenials: [],
        exitCode: 0,
        signal: null,
      }),
      cancel() {},
      handle: {} as AgentRun['handle'],
    }
  }
}

function context(provider: 'claude-code' | 'codex'): AgentToolContext {
  return {
    provider,
    cwd: '/tmp/project',
    sessionId: () => 'parent',
    abortSignal: new AbortController().signal,
    parentToolUseId: () => 'tool-1',
    emit: () => {},
  }
}

describe('cross-provider subagent control-plane dispatch', () => {
  test.each([
    ['claude-code', () => createClaudeSubagentAgentTool] as const,
    ['codex', () => createCodexSubagentAgentTool] as const,
  ])('%s child explicitly excludes automation and nested subagent tools', async (provider, factory) => {
    const dispatcher = new ChildDispatcher()
    const agentTool = factory()(dispatcher)
    const result = await agentTool.execute({ prompt: 'Inspect the change' }, context(provider))
    const names = dispatcher.request?.tools.map(({ name }) => name) ?? []

    expect(result).toEqual({ ok: true, text: 'child result' })
    expect(dispatcher.request?.provider).toBe(provider)
    expect(dispatcher.request?.persistence).toBe('ephemeral')
    expect(names).not.toContain('create_automation')
    expect(names).not.toContain('run_automation')
    expect(names).not.toContain('claude_subagent')
    expect(names).not.toContain('codex_subagent')
    expect(names).toContain('list_works')
    expect(names).toContain('list_sessions')
  })
})
