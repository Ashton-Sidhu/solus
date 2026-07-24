import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { CodexTurnNormalizer } from '../../src/main/agents/codex/codex-event-normalizer'
import { codexItemToMessage } from '../../src/main/agents/codex/codex-utils'
import type { NormalizedEvent } from '../../src/shared/types'

type RawCodexEvent = { method: string; params: any }

function normalizeCodexNotification(method: string, params: any) {
  return new CodexTurnNormalizer({ planMode: false }).push({ method, params })
}

async function readCodexFixture(name: string): Promise<RawCodexEvent[]> {
  const text = await Bun.file(new URL(`./__fixtures__/${name}`, import.meta.url)).text()
  return text.trim().split('\n').map((line) => JSON.parse(line) as RawCodexEvent)
}

async function normalizeCodexFixture(
  name: string,
  opts: { planMode: boolean },
): Promise<{ events: NormalizedEvent[]; normalizer: CodexTurnNormalizer }> {
  const normalizer = new CodexTurnNormalizer(opts)
  const events: NormalizedEvent[] = []
  for (const raw of await readCodexFixture(name)) {
    events.push(...normalizer.push(raw))
  }
  return { events, normalizer }
}

describe('normalizeCodexNotification', () => {
  test('normalizes Codex agent message deltas as text chunks', () => {
    expect(normalizeCodexNotification('item/agentMessage/delta', {
      itemId: 'msg-1',
      delta: 'First thought.',
    })).toEqual([
      { type: 'text_chunk', text: 'First thought.' },
    ])
  })

  test('adds a Markdown paragraph boundary when a Codex agent message item completes', () => {
    expect(normalizeCodexNotification('item/completed', {
      item: { id: 'msg-1', type: 'agentMessage' },
    })).toEqual([
      { type: 'text_chunk', text: '\n\n' },
    ])
  })

  test('normalizes Codex collab agent starts as subagent tool calls', () => {
    expect(normalizeCodexNotification('item/started', {
      item: {
        id: 'agent-1',
        type: 'collabAgentToolCall',
        tool: 'researcher',
        prompt: 'Read auth files and report risks',
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        arguments: {
          description: 'Inspect the auth flow',
        },
      },
    })).toEqual([
      {
        type: 'tool_call',
        toolName: 'researcher',
        toolId: 'agent-1',
        index: 0,
        toolInput: JSON.stringify({
          subagent_type: 'researcher',
          description: 'Inspect the auth flow',
          prompt: 'Read auth files and report risks',
          model: 'gpt-5.5',
          reasoning_effort: 'high',
        }),
        parentToolUseId: undefined,
        isSubagent: true,
        subagentType: 'researcher',
      },
    ])
  })

  test('normalizes the Claude dynamic tool as a subagent card with its input metadata', () => {
    const input = {
      prompt: 'Inspect the auth flow and report risks',
      description: 'Review auth flow',
      model: 'claude-sonnet-5',
      reasoning_effort: 'high',
      read_only: true,
    }

    expect(normalizeCodexNotification('item/started', {
      item: {
        id: 'claude-agent-1',
        type: 'dynamicToolCall',
        namespace: 'solus',
        tool: 'claude_subagent',
        arguments: input,
      },
    })).toEqual([
      {
        type: 'tool_call',
        toolName: 'solus.claude_subagent',
        toolId: 'claude-agent-1',
        index: 0,
        toolInput: JSON.stringify(input),
        parentToolUseId: undefined,
        isSubagent: true,
        subagentType: 'claude',
      },
    ])
  })

  test('drops streamed child agent text and delivers it whole on completion', () => {
    // Sub-agent prose no longer streams; parented deltas are dropped and the full
    // text lands on item/completed as a parented assistant_message.
    expect(normalizeCodexNotification('item/agentMessage/delta', {
      itemId: 'msg-2',
      parentItemId: 'agent-1',
      delta: 'Found the auth handler.',
    })).toEqual([])

    expect(normalizeCodexNotification('item/completed', {
      item: { id: 'msg-2', type: 'agentMessage', text: 'Found the auth handler.' },
      parentItemId: 'agent-1',
    })).toEqual([
      { type: 'assistant_message', text: 'Found the auth handler.', parentToolUseId: 'agent-1' },
    ])
  })

  test('normalizes Codex collab agent completion as a tool result', () => {
    expect(normalizeCodexNotification('item/completed', {
      item: {
        id: 'agent-1',
        type: 'collabAgentToolCall',
        tool: 'researcher',
        result: 'No auth regressions found.',
        status: 'completed',
      },
    })).toEqual([
      { type: 'tool_call_update', toolId: 'agent-1', toolInput: 'No auth regressions found.' },
      { type: 'tool_call_complete', index: 0, toolId: 'agent-1' },
      { type: 'tool_result', toolUseId: 'agent-1', content: 'No auth regressions found.', isError: false },
    ])
  })

  test('settles the Claude dynamic-tool card without overwriting its input', () => {
    expect(normalizeCodexNotification('item/completed', {
      item: {
        id: 'claude-agent-1',
        type: 'dynamicToolCall',
        tool: 'claude_subagent',
        status: 'completed',
        success: true,
        contentItems: [{ type: 'inputText', text: 'No auth regressions found.' }],
      },
    })).toEqual([
      { type: 'tool_call_complete', index: 0, toolId: 'claude-agent-1' },
      {
        type: 'tool_result',
        toolUseId: 'claude-agent-1',
        content: 'No auth regressions found.',
        isError: false,
      },
    ])
  })

  test('associates child-thread results with the collab agent card', () => {
    const normalizer = new CodexTurnNormalizer({ planMode: false })

    expect(normalizer.push({
      method: 'item/started',
      params: {
        threadId: 'parent-thread',
        item: {
          id: 'agent-1',
          type: 'collabAgentToolCall',
          tool: 'spawn_agent',
          receiverThreadIds: ['child-thread'],
          prompt: 'Inspect the auth flow',
        },
      },
    })).toEqual([
      expect.objectContaining({ type: 'tool_call', toolId: 'agent-1', isSubagent: true }),
    ])

    expect(normalizer.push({
      method: 'item/completed',
      params: {
        threadId: 'child-thread',
        item: {
          id: 'child-answer',
          type: 'agentMessage',
          text: 'The auth flow is safe.',
        },
      },
    })).toEqual([
      {
        type: 'assistant_message',
        text: 'The auth flow is safe.',
        parentToolUseId: 'agent-1',
      },
    ])
  })
})

describe('CodexTurnNormalizer', () => {
  afterEach(() => setSystemTime())

  test('can emit assembled agent messages for a live headless transcript', () => {
    const normalizer = new CodexTurnNormalizer({ planMode: false, assembledAgentMessages: true })
    expect(normalizer.push({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', delta: 'partial' },
    })).toEqual([])
    expect(normalizer.push({
      method: 'item/completed',
      params: { threadId: 'thread-1', item: { id: 'msg-1', type: 'agentMessage', text: 'Complete answer.' } },
    })).toEqual([{ type: 'assistant_message', text: 'Complete answer.' }])
  })

  test('normalizes a command turn and summarizes tool calls', async () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { events, normalizer } = await normalizeCodexFixture('codex-normal-turn.jsonl', { planMode: false })

    expect(events).toEqual([
      {
        type: 'tool_call',
        toolName: 'exec_command',
        toolId: 'cmd-1',
        index: 0,
        toolInput: 'pwd',
        parentToolUseId: undefined,
        isSubagent: false,
        subagentType: undefined,
      },
      {
        type: 'tool_call_update',
        toolId: 'cmd-1',
        content: '/Users/sidhu/solus\n',
      },
      { type: 'tool_call_complete', index: 0, toolId: 'cmd-1' },
      {
        type: 'usage',
        usage: {
          inputTokens: 60,
          outputTokens: 12,
          cacheReadTokens: 40,
          reasoningTokens: 5,
          contextWindowTokens: 200000,
        },
        sessionUsage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 50,
          reasoningTokens: undefined,
          contextWindowTokens: 200000,
        },
      },
      {
        type: 'task_complete',
        result: '',
        costUsd: 0,
        durationMs: 123,
        numTurns: 1,
        usage: {},
        sessionId: 'thread-1',
      },
    ])
    expect(normalizer.summary).toEqual({
      toolCallCount: 1,
      sawRateLimit: false,
      sawProtocolError: false,
      permissionDenials: [],
    })
  })

  test('emits plan-mode plan events without progress and prefers completed plan text', async () => {
    const { events, normalizer } = await normalizeCodexFixture('codex-plan-mode.jsonl', { planMode: true })

    expect(events).toEqual([
      {
        type: 'plan',
        planContent: '# Plan\n\n- [x] Inspect files\n- (In progress) Patch normalizer',
        planFilePath: '',
        questionId: 'codex-plan-turn-plan-1',
        options: [],
        planToolUseId: 'codex-plan-turn-plan-1',
      },
      { type: 'text_chunk', text: 'Streamed plan text', parentToolUseId: undefined },
      {
        type: 'plan',
        planContent: '# Final Plan\n\nCompleted plan wins.',
        planFilePath: '',
        questionId: 'codex-plan-turn-plan-1',
        options: [],
        planToolUseId: 'codex-plan-plan-item-1',
      },
      {
        type: 'task_complete',
        result: '',
        costUsd: 0,
        durationMs: 10,
        numTurns: 1,
        usage: {},
        sessionId: 'thread-1',
      },
    ])
    expect(events.some((event) => event.type === 'progress')).toBe(false)
    expect(normalizer.summary.toolCallCount).toBe(0)
  })

  test('emits nothing after explicit or self-detected interruption', () => {
    const normalizer = new CodexTurnNormalizer({ planMode: false })
    expect(normalizer.push({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'before' },
    })).toEqual([{ type: 'text_chunk', text: 'before', parentToolUseId: undefined }])

    normalizer.interrupt()
    expect(normalizer.push({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'after' },
    })).toEqual([])

    const selfDetecting = new CodexTurnNormalizer({ planMode: false })
    expect(selfDetecting.push({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turnId: 'turn-2', turn: { id: 'turn-2', status: 'interrupted' } },
    })).toEqual([])
    expect(selfDetecting.push({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-2', delta: 'after' },
    })).toEqual([])
  })

  test('tracks account and failed-turn rate limits in the summary', async () => {
    setSystemTime(new Date('2026-01-01T12:00:00Z'))
    const { events, normalizer } = await normalizeCodexFixture('codex-rate-limit.jsonl', { planMode: false })

    expect(events).toEqual([
      {
        type: 'rate_limit',
        status: 'limited',
        resetsAt: 1767269220,
        rateLimitType: 'Codex 5h',
        usedPercent: 100,
        windowDurationMins: 300,
        isUsingOverage: false,
        deferCurrentRun: true,
      },
      {
        type: 'rate_limit',
        status: 'limited',
        resetsAt: 1767272520,
        rateLimitType: 'usage_limit_exceeded',
        isUsingOverage: false,
      },
      {
        type: 'error',
        message: 'usage limit reached, try again at 1:00 PM',
        isError: true,
        sessionId: 'thread-1',
      },
    ])
    expect(normalizer.summary.sawRateLimit).toBe(true)
    expect(normalizer.summary.sawProtocolError).toBe(true)
  })
})

describe('Codex subagent history', () => {
  test('keeps the Claude dynamic tool input and final answer for card reloads', () => {
    const input = { prompt: 'Inspect auth', description: 'Review auth' }
    expect(codexItemToMessage({
      id: 'claude-agent-1',
      type: 'dynamicToolCall',
      tool: 'claude_subagent',
      arguments: input,
      contentItems: [{ type: 'inputText', text: 'Auth is safe.' }],
      success: true,
    }, 123)).toEqual({
      role: 'tool',
      content: 'Auth is safe.',
      toolName: 'claude_subagent',
      toolInput: JSON.stringify(input),
      timestamp: 123,
    })
  })
})
