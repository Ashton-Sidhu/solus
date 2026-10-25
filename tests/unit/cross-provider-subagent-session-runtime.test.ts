import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AgentDispatcher, AgentRun, AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import type { AgentTool, AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import { executeAgentTool } from '@solus/server/execution/agents/tools/agent-tool'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { SeatResolver, TurnSeat } from '@solus/server/execution/seats/seat-manager'
import { MODEL_PROFILES } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))

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
  exitCode = 0
  signal: string | null = null
  output = 'child result'
  error: Error | undefined

  runAgent(request: AgentRunRequest): AgentRun {
    this.request = request
    return {
      sessionId: Promise.resolve(null),
      done: this.error ? Promise.reject(this.error) : Promise.resolve({
        sessionId: null,
        output: this.output,
        toolCallCount: 0,
        permissionDenials: [],
        exitCode: this.exitCode,
        signal: this.signal,
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
    sessionId: () => 'solus-parent',
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

  test.each([
    ['claude-code', () => createClaudeSubagentAgentTool] as const,
    ['codex', () => createCodexSubagentAgentTool] as const,
  ])('%s child refuses unsupported explicit models and reasoning without dispatch', async (provider, factory) => {
    const dispatcher = new ChildDispatcher()
    const agentTool = factory()(dispatcher)
    const invalidModel = await agentTool.execute({ prompt: 'Inspect', model: 'unknown-model' }, context(provider))
    expect(invalidModel.ok).toBe(false)
    expect(invalidModel.text).toContain('Unknown model "unknown-model"')
    expect(invalidModel.text).toContain('Valid models:')
    expect(dispatcher.request).toBeNull()

    const model = provider === 'codex' ? 'gpt-6-sol' : 'claude-sonnet-5-5'
    const invalidEffort = await agentTool.execute({ prompt: 'Inspect', model, reasoning_effort: 'none' }, context(provider))
    expect(invalidEffort.ok).toBe(false)
    expect(invalidEffort.text).toContain('does not support reasoning level "none"')
    expect(dispatcher.request).toBeNull()
  })

  test.each([
    ['claude-code', () => createClaudeSubagentAgentTool] as const,
    ['codex', () => createCodexSubagentAgentTool] as const,
  ])('%s child dispatches the advertised model default and its profile reasoning', async (provider, factory) => {
    const dispatcher = new ChildDispatcher()
    const agentTool = factory()(dispatcher)
    await agentTool.execute({ prompt: 'Inspect' }, context(provider))
    const model = dispatcher.request!.model!
    expect(agentTool.inputFields.model.description).toContain(`Defaults to '${model}'`)
    expect(dispatcher.request!.reasoningEffort).toBe(MODEL_PROFILES[provider][model].defaultReasoningEffort)
    expect(agentTool.alwaysLoad).toBe(true)
    expect(agentTool.inputFields).not.toHaveProperty('task')
    expect(agentTool.inputFields).not.toHaveProperty('task_id')
  })

  test('Codex accepts profile-supported max reasoning', async () => {
    const dispatcher = new ChildDispatcher()
    const result = await executeAgentTool(createCodexSubagentAgentTool(dispatcher), { prompt: 'Inspect', model: 'gpt-6-sol', reasoning_effort: 'max' }, context('codex'))
    expect(result.ok).toBe(true)
    expect(dispatcher.request).toMatchObject({ model: 'gpt-6-sol', reasoningEffort: 'max' })
  })

  test.each([
    ['claude-code', () => createClaudeSubagentAgentTool] as const,
    ['codex', () => createCodexSubagentAgentTool] as const,
  ])('%s child labels nonzero exits and signals as failure with partial output', async (provider, factory) => {
    const failed = new ChildDispatcher()
    failed.exitCode = 1
    const failure = await factory()(failed).execute({ prompt: 'Inspect' }, context(provider))
    expect(failure.ok).toBe(false)
    expect(failure.text).toContain('failed with exit code 1')
    expect(failure.text).toContain('Partial output:\nchild result')

    const signaled = new ChildDispatcher()
    signaled.signal = 'SIGTERM'
    const terminated = await factory()(signaled).execute({ prompt: 'Inspect' }, context(provider))
    expect(terminated.ok).toBe(false)
    expect(terminated.text).toContain('failed with signal SIGTERM')
  })

  test.each([
    ['claude-code', () => createClaudeSubagentAgentTool] as const,
    ['codex', () => createCodexSubagentAgentTool] as const,
  ])('%s child reports interruption, rejected startup, and empty successful answers distinctly', async (provider, factory) => {
    const interrupted = new ChildDispatcher()
    interrupted.signal = 'SIGINT'
    const stopped = await factory()(interrupted).execute({ prompt: 'Inspect' }, context(provider))
    expect(stopped.ok).toBe(false)
    expect(stopped.text).toContain('was interrupted')

    const rejected = new ChildDispatcher()
    rejected.error = new Error('Provider unavailable')
    const unavailable = await factory()(rejected).execute({ prompt: 'Inspect' }, context(provider))
    expect(unavailable.ok).toBe(false)
    expect(unavailable.text).toContain('Provider unavailable')

    const empty = new ChildDispatcher()
    empty.output = ''
    const completed = await factory()(empty).execute({ prompt: 'Inspect' }, context(provider))
    expect(completed.ok).toBe(true)
    expect(completed.text).toContain('returned no text')
  })

  test.each([
    ['claude-code', () => createClaudeSubagentAgentTool] as const,
    ['codex', () => createCodexSubagentAgentTool] as const,
  ])('%s child rejects blank prompts and does not report aborted work as success', async (provider, factory) => {
    const dispatcher = new ChildDispatcher()
    const agentTool = factory()(dispatcher)
    const blank = await executeAgentTool(agentTool, { prompt: '   ' }, context(provider))
    expect(blank.ok).toBe(false)
    expect(blank.text).toContain('Prompt must not be empty')
    expect(dispatcher.request).toBeNull()

    const controller = new AbortController()
    controller.abort()
    const stopped = await agentTool.execute({ prompt: 'Inspect' }, { ...context(provider), abortSignal: controller.signal })
    expect(stopped.ok).toBe(false)
    expect(stopped.text).toContain('was interrupted')
  })
})
