import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { ClaudeTurnNormalizer } from '@solus/server/agents/claude/claude-event-normalizer'
import type { ClaudeEvent } from '@solus/contracts/claude-types'
import type { NormalizedEvent } from '@solus/contracts/types'

async function readClaudeFixture(name: string): Promise<ClaudeEvent[]> {
  const text = await Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).text()
  return text.trim().split('\n').map((line) => JSON.parse(line) as ClaudeEvent)
}

async function normalizeClaudeFixture(name: string): Promise<{ events: NormalizedEvent[]; normalizer: ClaudeTurnNormalizer }> {
  const normalizer = new ClaudeTurnNormalizer()
  const events: NormalizedEvent[] = []
  for (const raw of await readClaudeFixture(name)) {
    events.push(...normalizer.push(raw))
  }
  return { events, normalizer }
}

describe('ClaudeTurnNormalizer', () => {
  afterEach(() => setSystemTime())

  test('normalizes a main-thread turn without backend bookkeeping', async () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { events, normalizer } = await normalizeClaudeFixture('claude-main-thread.jsonl')

    expect(events).toEqual([
      {
        type: 'session_init',
        sessionId: 'claude-session-1',
        model: 'claude-test',
        skills: [],
      },
      { type: 'text_chunk', text: 'Hello ' },
      { type: 'tool_call', toolName: 'Bash', toolId: 'tool-1', index: 1 },
      { type: 'tool_call_complete', index: 1, toolInput: '{"command":"pwd"}' },
      {
        type: 'task_complete',
        result: 'done',
        costUsd: 0.01,
        durationMs: 42,
        numTurns: 1,
        usage: { inputTokens: 10, outputTokens: 3 },
        sessionId: 'claude-session-1',
      },
    ])
    expect(normalizer.summary).toEqual({
      toolCallCount: 1,
      sawRateLimit: false,
      sawProtocolError: false,
      permissionDenials: [],
    })
  })

  test('does not complete the user turn for a task-notification continuation result', () => {
    const normalizer = new ClaudeTurnNormalizer()

    expect(normalizer.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'One explorer finished; two are still running.',
      origin: { kind: 'task-notification' },
      terminal_reason: 'completed',
      session_id: 'claude-session-1',
    } as ClaudeEvent)).toEqual([])
  })

  test('records Claude compaction only when the provider reports its duration', () => {
    const normalizer = new ClaudeTurnNormalizer()

    expect(normalizer.push({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 12_000, duration_ms: 4_250 },
      uuid: 'compact-1',
      session_id: 'claude-session-1',
    })).toEqual([{
      type: 'context_compaction',
      state: 'stop',
      trigger: 'auto',
      durationMs: 4_250,
    }])
  })

  test('streams parented text into the subagent transcript', () => {
    const normalizer = new ClaudeTurnNormalizer()

    expect(normalizer.push({
      type: 'stream_event',
      parent_tool_use_id: 'agent-parent-1',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Inspecting the auth flow' },
      },
    } as ClaudeEvent)).toEqual([{
      type: 'text_chunk',
      text: 'Inspecting the auth flow',
      parentToolUseId: 'agent-parent-1',
    }])
  })

  // A sub-agent's TodoWrite is its own plan, not the main agent's. It must reach
  // the sub-agent's card tagged with the spawning tool call — an untagged progress
  // event would overwrite the session tracker the top-level agent owns.
  test('tags a nested TodoWrite with its parent instead of driving main progress', async () => {
    const { events, normalizer } = await normalizeClaudeFixture('claude-sub-agent.jsonl')

    expect(events).toEqual([
      {
        type: 'progress',
        todos: [{ content: 'Nested task', status: 'in_progress' }],
        parentToolUseId: 'agent-parent-1',
      },
      {
        type: 'tool_call',
        toolName: 'TodoWrite',
        toolId: 'todo-sub-1',
        index: 0,
        toolInput: '{"todos":[{"content":"Nested task","status":"in_progress"}]}',
        parentToolUseId: 'agent-parent-1',
      },
      {
        type: 'tool_result',
        toolUseId: 'todo-sub-1',
        content: 'Nested task updated',
        isError: false,
        parentToolUseId: 'agent-parent-1',
      },
    ])
    expect(events.every((event) => event.type !== 'progress' || event.parentToolUseId)).toBe(true)
    expect(normalizer.summary.toolCallCount).toBe(1)
  })

  // A backgrounded sub-agent answers its own tool call at launch, so the launch
  // metadata must be marked as such and the task's real outcome must stay
  // traceable to the spawning tool call — otherwise its card reads "Complete"
  // the instant it starts.
  test('marks a backgrounded sub-agent launch and ties its lifecycle to the tool call', async () => {
    const { events } = await normalizeClaudeFixture('claude-async-subagent.jsonl')

    expect(events).toEqual([
      { type: 'tool_call', toolName: 'Task', toolId: 'agent-async-1', index: 2, isSubagent: true, subagentType: 'claude' },
      { type: 'background_task_started', taskId: 'task-async-1', toolUseId: 'agent-async-1' },
      {
        type: 'background_task_progress',
        taskId: 'task-async-1',
        toolUseId: 'agent-async-1',
        description: 'Reading src/shared/types.ts',
        toolUses: 3,
        totalTokens: 1200,
        durationMs: 4500,
        lastToolName: 'Read',
      },
      { type: 'tool_call_complete', index: 2, toolInput: '{"description":"Design plan"}' },
      {
        type: 'tool_result',
        toolUseId: 'agent-async-1',
        content: 'Async agent launched successfully. agentId: task-async-1. The agent is working in the background.',
        isError: undefined,
        parentToolUseId: undefined,
        isAsyncLaunch: true,
      },
      { type: 'background_task_settled', taskId: 'task-async-1', status: 'completed', toolUseId: 'agent-async-1' },
    ])
  })

  // A blocking sub-agent's tool_result IS its answer; flagging it as a launch
  // would strip the card of the result it should show.
  test('does not flag a blocking sub-agent result as an async launch', async () => {
    const { events } = await normalizeClaudeFixture('claude-sub-agent.jsonl')
    const result = events.find((event) => event.type === 'tool_result')

    expect(result).toBeDefined()
    expect((result as { isAsyncLaunch?: boolean }).isAsyncLaunch).toBeUndefined()
  })

  test('synthesizes checkpoints and exposes permission denials in the summary', async () => {
    const { events, normalizer } = await normalizeClaudeFixture('claude-checkpoint-denials.jsonl')

    expect(events[0]).toEqual({ type: 'checkpoint', checkpointId: 'checkpoint-1' })
    expect(events[1]).toEqual({
      type: 'task_complete',
      result: 'done',
      costUsd: 0,
      durationMs: 1,
      numTurns: 1,
      usage: {},
      sessionId: 'claude-session-1',
      permissionDenials: [{ toolName: 'Edit', toolUseId: 'tool-denied-1' }],
    })
    expect(normalizer.summary.permissionDenials).toEqual([
      { tool_name: 'Edit', tool_use_id: 'tool-denied-1' },
    ])
  })

  test('normalizes rate-limit events and records the summary flag', async () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { events, normalizer } = await normalizeClaudeFixture('claude-rate-limit.jsonl')

    expect(events).toEqual([{
      type: 'rate_limit',
      status: 'limited',
      resetsAt: 1767225900,
      rateLimitType: 'Claude',
      isUsingOverage: false,
    }])
    expect(normalizer.summary.sawRateLimit).toBe(true)
  })

  test('normalizes Claude terminal session-limit errors as rate limits', () => {
    setSystemTime(new Date('2026-08-14T19:14:00Z'))
    const normalizer = new ClaudeTurnNormalizer()

    const events = normalizer.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 1,
      num_turns: 1,
      errors: ["You've hit your session limit · resets 4pm (America/Toronto)"],
      total_cost_usd: 0,
      session_id: 'claude-session-1',
      usage: {},
    })

    expect(events[0]).toMatchObject({ type: 'rate_limit', resetsAt: 1786737600 })
    expect(normalizer.summary.sawRateLimit).toBe(true)
  })

  test('emits nothing after interrupt', async () => {
    const [first, second] = await readClaudeFixture('claude-main-thread.jsonl')
    const normalizer = new ClaudeTurnNormalizer()

    expect(normalizer.push(first)).toHaveLength(1)
    normalizer.interrupt()
    expect(normalizer.push(second)).toEqual([])
  })

  test('does not emit assistant_message for an empty assistant message', () => {
    const normalizer = new ClaudeTurnNormalizer()
    expect(normalizer.push({
      type: 'assistant',
      session_id: 'claude-session-1',
      uuid: 'assistant-empty-1',
      parent_tool_use_id: null,
      message: {
        model: 'claude-test',
        id: 'msg-empty',
        role: 'assistant',
        content: [],
        stop_reason: null,
        usage: {},
      },
    })).toEqual([])
  })

  test('collects edited files from Claude write tools without exposing them as events', () => {
    const normalizer = new ClaudeTurnNormalizer()
    expect(normalizer.push({
      type: 'assistant',
      session_id: 'claude-session-1',
      uuid: 'assistant-edit-1',
      parent_tool_use_id: null,
      message: {
        model: 'claude-test',
        id: 'msg-edit',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: 'src/new.ts' } },
          { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: 'src/existing.ts' } },
          { type: 'tool_use', id: 'notebook-1', name: 'NotebookEdit', input: { notebook_path: 'notebooks/demo.ipynb' } },
        ],
        stop_reason: null,
        usage: {},
      },
    })).toEqual([])
    expect(normalizer.editedFiles).toEqual(['src/new.ts', 'src/existing.ts', 'notebooks/demo.ipynb'])
  })
})
