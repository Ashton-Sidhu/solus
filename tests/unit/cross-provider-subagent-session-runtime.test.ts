import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { AgentDispatcher, AgentRun, AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import type { AgentTool, AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { SeatResolver, TurnSeat } from '@solus/server/execution/seats/seat-manager'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let createClaudeSubagentAgentTool: (dispatcher: AgentDispatcher, seatFor?: SeatResolver) => AgentTool
let createCodexSubagentAgentTool: (dispatcher: AgentDispatcher, seatFor?: SeatResolver) => AgentTool
let SeatRequiredError: typeof import('@solus/server/execution/seats/seat-manager')['SeatRequiredError']

beforeAll(async () => {
  ;({ createClaudeSubagentAgentTool } = await import('@solus/server/execution/agents/claude/claude-subagent-tool'))
  ;({ createCodexSubagentAgentTool } = await import('@solus/server/execution/agents/codex/codex-subagent-tool'))
  ;({ SeatRequiredError } = await import('@solus/server/execution/seats/seat-manager'))
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

function context(provider: 'claude-code' | 'codex', emitted: NormalizedEvent[] = []): AgentToolContext {
  return {
    provider,
    cwd: '/tmp/project',
    sessionId: () => 'parent',
    solusSessionId: () => 'solus-parent',
    abortSignal: new AbortController().signal,
    parentToolUseId: () => 'tool-1',
    emit: (event) => emitted.push(event),
  }
}

describe('cross-provider subagent control-plane dispatch', () => {
  test.each([
    ['claude-code', () => createClaudeSubagentAgentTool] as const,
    ['codex', () => createCodexSubagentAgentTool] as const,
  ])('%s child runs on the turn author\'s own login, and refuses without one', async (provider, factory) => {
    // WHY: on a cloud host a member's login lives in their seat; a child run on
    // the host login would fail, or spend another person's quota.
    const seat: TurnSeat = { seat: { kind: 'user', userId: { kind: 'account', accountId: 'member-1' } }, provider, home: '/seats/member-1' }
    const seated = new ChildDispatcher()
    await factory()(seated, async () => seat).execute({ prompt: 'Inspect the change' }, context(provider))
    expect(seated.request?.seat).toBe(seat)

    const unseated = new ChildDispatcher()
    const refused = await factory()(unseated, async () => { throw new SeatRequiredError(provider, 'none') })
      .execute({ prompt: 'Inspect the change' }, context(provider))
    expect(refused.ok).toBe(false)
    expect(unseated.request).toBeNull()
  })

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
    expect(dispatcher.request?.systemPrompt).toBeUndefined()
    expect(names).not.toContain('create_automation')
    expect(names).not.toContain('run_automation')
    expect(names).not.toContain('claude_subagent')
    expect(names).not.toContain('codex_subagent')
    expect(names).toContain('find_works')
    expect(names).toContain('search_sessions')
  })

  // Plan mode makes Claude answer with a plan and makes Codex refuse to touch
  // anything, and no surface can approve a plan for an unattended child, so a
  // subagent must always run in auto — including when a caller sends a stale
  // read_only argument.
  test.each([
    ['claude-code', () => createClaudeSubagentAgentTool] as const,
    ['codex', () => createCodexSubagentAgentTool] as const,
  ])('%s child always runs in full access', async (provider, factory) => {
    const dispatcher = new ChildDispatcher()
    const agentTool = factory()(dispatcher)

    await agentTool.execute({ prompt: 'Inspect the change' }, context(provider))
    expect(dispatcher.request?.permissionMode).toBe('full-access')

    await agentTool.execute(
      { prompt: 'Inspect the change', read_only: true } as unknown as Parameters<AgentTool['execute']>[0],
      context(provider),
    )
    expect(dispatcher.request?.permissionMode).toBe('full-access')
  })

  test.each([
    ['claude-code', () => createClaudeSubagentAgentTool] as const,
    ['codex', () => createCodexSubagentAgentTool] as const,
  ])('%s child forwards only parented transcript events', async (provider, factory) => {
    const dispatcher = new ChildDispatcher()
    const emitted: NormalizedEvent[] = []
    const agentTool = factory()(dispatcher)

    await agentTool.execute({ prompt: 'Inspect the change' }, context(provider, emitted))
    dispatcher.request?.onEvent?.({ type: 'text_chunk', text: 'Reading files' })
    dispatcher.request?.onEvent?.({
      type: 'progress',
      todos: [{ content: 'Read files', status: 'in_progress' }],
    })
    dispatcher.request?.onEvent?.({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 2 },
    })

    expect(emitted).toEqual([
      { type: 'text_chunk', text: 'Reading files', parentToolUseId: 'tool-1' },
      {
        type: 'progress',
        todos: [{ content: 'Read files', status: 'in_progress' }],
        parentToolUseId: 'tool-1',
      },
    ])
  })
})
