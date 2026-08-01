import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { CodexTurnNormalizer } from '../../src/main/agents/codex/codex-event-normalizer'
import { codexItemToMessage, codexTurnToMessages, codexTurnsToMessages } from '../../src/main/agents/codex/codex-utils'
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

  test('preserves the final-answer marker for assembled headless messages', () => {
    const normalizer = new CodexTurnNormalizer({
      planMode: false,
      assembledAgentMessages: true,
    })

    expect(normalizer.push({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'msg-1',
          type: 'agentMessage',
          text: 'Finished the requested changes.',
          phase: 'final_answer',
        },
      },
    })).toEqual([
      {
        type: 'assistant_message',
        text: 'Finished the requested changes.',
        isFinal: true,
      },
    ])
  })

  test('normalizes Codex spawn-agent starts as subagent tool calls', () => {
    expect(normalizeCodexNotification('item/started', {
      item: {
        id: 'agent-1',
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
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
        toolName: 'spawnAgent',
        toolId: 'agent-1',
        index: 0,
        toolInput: JSON.stringify({
          subagent_type: 'spawnAgent',
          description: 'Inspect the auth flow',
          prompt: 'Read auth files and report risks',
          model: 'gpt-5.5',
          reasoning_effort: 'high',
        }),
        parentToolUseId: undefined,
        isSubagent: true,
        subagentType: 'codex',
      },
    ])
  })

  test('deduplicates paired sub-agent lifecycle events and parents child events', async () => {
    const { events } = await normalizeCodexFixture('codex-subagent-activity.jsonl', { planMode: false })

    expect(events).toEqual([
      {
        type: 'tool_call',
        toolName: 'spawnAgent',
        toolId: 'call-agent-1',
        index: 0,
        toolInput: JSON.stringify({
          subagent_type: 'codex',
          description: 'investigate split crash',
          agent_thread_id: 'child-thread',
          agent_path: '/root/investigate_split_crash',
        }),
        parentToolUseId: undefined,
        isSubagent: true,
        subagentType: 'codex',
      },
      {
        type: 'assistant_message',
        text: 'The split fix is safe.',
        parentToolUseId: 'call-agent-1',
        isFinal: true,
      },
    ])
  })

  test('settles completed-only interrupted sub-agent activity as an error', () => {
    expect(normalizeCodexNotification('item/completed', {
      item: {
        type: 'subAgentActivity',
        id: 'call-agent-1',
        kind: 'interrupted',
        agentThreadId: 'child-thread',
        agentPath: '/root/investigate_split_crash',
      },
    })).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'call-agent-1',
        content: 'Interrupted',
        isError: true,
        parentToolUseId: undefined,
      },
    ])
  })

  test('normalizes Codex wait operations as ordinary tool calls', () => {
    expect(normalizeCodexNotification('item/started', {
      item: {
        id: 'wait-1',
        type: 'collabAgentToolCall',
        tool: 'wait',
        status: 'inProgress',
        receiverThreadIds: [],
      },
    })).toEqual([
      {
        type: 'tool_call',
        toolName: 'wait',
        toolId: 'wait-1',
        index: 0,
        toolInput: JSON.stringify({
          subagent_type: 'wait',
          description: 'wait',
        }),
        parentToolUseId: undefined,
        isSubagent: false,
        subagentType: undefined,
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

  test('streams child agent text before reconciling the assembled completion', () => {
    expect(normalizeCodexNotification('item/agentMessage/delta', {
      itemId: 'msg-2',
      parentItemId: 'agent-1',
      delta: 'Found the auth handler.',
    })).toEqual([{
      type: 'text_chunk',
      text: 'Found the auth handler.',
      parentToolUseId: 'agent-1',
    }])

    expect(normalizeCodexNotification('item/completed', {
      item: { id: 'msg-2', type: 'agentMessage', text: 'Found the auth handler.' },
      parentItemId: 'agent-1',
    })).toEqual([
      { type: 'assistant_message', text: 'Found the auth handler.', parentToolUseId: 'agent-1' },
    ])
  })

  test('settles a Codex subagent without overwriting its launch metadata', () => {
    expect(normalizeCodexNotification('item/completed', {
      item: {
        id: 'agent-1',
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        result: 'No auth regressions found.',
        status: 'completed',
      },
    })).toEqual([
      { type: 'tool_call_complete', index: 0, toolId: 'agent-1' },
      { type: 'tool_result', toolUseId: 'agent-1', content: 'No auth regressions found.', isError: false },
    ])
  })

  test('completes a Codex wait without replacing its input with the status', () => {
    expect(normalizeCodexNotification('item/completed', {
      item: {
        id: 'wait-1',
        type: 'collabAgentToolCall',
        tool: 'wait',
        status: 'completed',
        receiverThreadIds: [],
      },
    })).toEqual([
      { type: 'tool_call_complete', index: 0, toolId: 'wait-1' },
      { type: 'tool_result', toolUseId: 'wait-1', content: 'completed', isError: false },
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
          tool: 'spawnAgent',
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

  test('streams child-thread text into the subagent card', () => {
    const normalizer = new CodexTurnNormalizer({ planMode: false })

    normalizer.push({
      method: 'item/started',
      params: {
        threadId: 'parent-thread',
        item: {
          type: 'subAgentActivity',
          id: 'agent-1',
          kind: 'started',
          agentThreadId: 'child-thread',
          agentPath: '/root/investigate',
        },
      },
    })

    expect(normalizer.push({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'child-thread',
        delta: 'Still investigating',
      },
    })).toEqual([{
      type: 'text_chunk',
      text: 'Still investigating',
      parentToolUseId: 'agent-1',
    }])
  })
})

describe('CodexTurnNormalizer', () => {
  afterEach(() => setSystemTime())

  test('can emit assembled agent messages for a live headless transcript', () => {
    const normalizer = new CodexTurnNormalizer({ planMode: false, assembledAgentMessages: true })
    expect(normalizer.push({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', delta: 'partial' },
    })).toEqual([{ type: 'text_chunk', text: 'partial' }])
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
      // `last` is the window as it stands; `total` is what the whole thread has
      // spent — the two must not be read as the same number.
      {
        type: 'usage',
        context: {
          usedTokens: 112,
          windowTokens: 200000,
          inputTokens: 60,
          cacheReadTokens: 40,
          outputTokens: 12,
        },
        run: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 50,
          reasoningTokens: undefined,
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
  test('does not convert older turns outside a requested transcript window', () => {
    let olderTurnsRead = 0
    const turns = Array.from({ length: 100 }, (_, index) => {
      const turn = {
        startedAt: index + 1,
        items: [{ type: 'agentMessage', text: `message ${index}` }],
      }
      if (index < 95) {
        Object.defineProperty(turn, 'items', {
          get() {
            olderTurnsRead++
            return [{ type: 'agentMessage', text: `message ${index}` }]
          },
        })
      }
      return turn
    })

    expect(codexTurnsToMessages(turns, 5).map((message) => message.content)).toEqual([
      'message 95',
      'message 96',
      'message 97',
      'message 98',
      'message 99',
    ])
    expect(olderTurnsRead).toBe(0)
  })

  test('rehydrates a failed turn with its terminal error', () => {
    const messages = codexTurnToMessages({
      status: 'failed',
      error: { message: 'API Error: 500 Internal server error' },
      startedAt: 1_000,
      completedAt: 1_060,
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'Inspect it' }] },
        { type: 'commandExecution', command: 'grep failed state' },
      ],
    })

    expect(messages.at(-1)).toEqual({
      role: 'system',
      content: 'Error: API Error: 500 Internal server error',
      timestamp: 1_060_000,
    })
  })

  test('preserves persisted turn duration when rebuilding transcript timestamps', () => {
    const messages = codexTurnToMessages({
      startedAt: 1_000,
      completedAt: 1_090,
      durationMs: 90_000,
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'Fix it' }] },
        { type: 'agentMessage', text: 'Fixed.' },
      ],
    })

    expect(messages.map((message) => message.timestamp)).toEqual([
      1_000_000,
      1_090_000,
    ])
  })

  test('hydrates persisted plans with the same stable id as live plan events', () => {
    expect(codexItemToMessage({
      id: 'plan-item-1',
      type: 'plan',
      text: '# Plan\n\n- Ship it',
    }, 123)).toEqual({
      role: 'plan',
      content: '',
      planContent: '# Plan\n\n- Ship it',
      planToolUseId: 'codex-plan-plan-item-1',
      timestamp: 123,
    })
  })

  test('hydrates started sub-agent activity as a running Codex card', () => {
    expect(codexItemToMessage({
      id: 'call-agent-1',
      type: 'subAgentActivity',
      kind: 'started',
      agentThreadId: 'child-thread',
      agentPath: '/root/investigate_split_crash',
    }, 123)).toEqual({
      role: 'tool',
      content: '',
      toolName: 'spawnAgent',
      toolId: 'call-agent-1',
      toolInput: JSON.stringify({
        subagent_type: 'codex',
        description: 'investigate split crash',
        agent_thread_id: 'child-thread',
        agent_path: '/root/investigate_split_crash',
      }),
      toolStatus: 'running',
      isSubagent: true,
      subagentType: 'codex',
      timestamp: 123,
    })
  })

  test('hydrates interrupted sub-agent activity as an error result', () => {
    expect(codexItemToMessage({
      id: 'call-agent-1',
      type: 'subAgentActivity',
      kind: 'interrupted',
      agentThreadId: 'child-thread',
      agentPath: '/root/investigate_split_crash',
    }, 124)).toEqual({
      role: 'tool_result',
      content: 'Interrupted',
      toolResultForId: 'call-agent-1',
      toolResultIsError: true,
      timestamp: 124,
    })
  })

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
