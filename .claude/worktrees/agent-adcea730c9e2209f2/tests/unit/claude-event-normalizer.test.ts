import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { ClaudeTurnNormalizer } from '../../src/main/agents/claude/claude-event-normalizer'
import type { ClaudeEvent } from '../../src/shared/claude-types'
import type { NormalizedEvent } from '../../src/shared/types'

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

  test('routes sub-agent tool activity without promoting nested TodoWrite to progress', async () => {
    const { events, normalizer } = await normalizeClaudeFixture('claude-sub-agent.jsonl')

    expect(events).toEqual([
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
    expect(events.some((event) => event.type === 'progress')).toBe(false)
    expect(normalizer.summary.toolCallCount).toBe(1)
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
