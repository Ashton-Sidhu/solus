import { afterEach, describe, expect, test } from 'bun:test'
import type { Message, Session, Tab, UsageData } from '@solus/contracts/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

async function createReducer() {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
  const parent: Message = {
    id: 'parent-message',
    role: 'tool',
    content: '',
    toolName: 'mcp__solus__codex_subagent',
    toolId: 'parent-tool',
    toolStatus: 'running',
    subMessages: [],
    timestamp: 0,
  }
  const session = {
    status: 'running',
    messages: [parent],
  } as Session
  const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
  const reducer = new SessionEventReducer({
    registry: {
      tabs: { 'tab-1': tab },
      sessions: { 'session-1': session },
      sessionFor: (tabId: string) => tabId === 'tab-1' ? session : undefined,
      tabIdsBySession: new Map([['session-1', ['tab-1']]]),
    },
    settings: { rateLimitBehavior: 'ask' },
    log: () => {},
  } as any)
  return { parent, reducer }
}

describe('SessionEventReducer sub-agent transcript events', () => {
  test('reconciles streamed chunks with assembled messages without doubling', async () => {
    const { parent, reducer } = await createReducer()

    reducer.apply('session-1', { type: 'text_chunk', text: 'Draft ', parentToolUseId: 'parent-tool' })
    reducer.apply('session-1', { type: 'text_chunk', text: 'answer', parentToolUseId: 'parent-tool' })

    expect(parent.subMessages).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Draft answer', isStreaming: true }),
    ])

    reducer.apply('session-1', {
      type: 'assistant_message',
      text: 'Final answer.',
      parentToolUseId: 'parent-tool',
    })

    expect(parent.subMessages).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Final answer.' }),
    ])
    expect(parent.subMessages?.[0].isStreaming).toBeUndefined()

    reducer.apply('session-1', {
      type: 'assistant_message',
      text: 'Final answer.',
      parentToolUseId: 'parent-tool',
    })
    expect(parent.subMessages).toHaveLength(1)

    reducer.apply('session-1', {
      type: 'assistant_message',
      text: 'A distinct follow-up.',
      parentToolUseId: 'parent-tool',
    })
    expect(parent.subMessages?.map((message) => message.content)).toEqual([
      'Final answer.',
      'A distinct follow-up.',
    ])
  })

  test('starts a new streamed block after an interleaved tool call', async () => {
    const { parent, reducer } = await createReducer()

    reducer.apply('session-1', { type: 'text_chunk', text: 'Before tool', parentToolUseId: 'parent-tool' })
    reducer.apply('session-1', {
      type: 'tool_call',
      toolName: 'Read',
      toolId: 'child-tool',
      index: 0,
      toolInput: '{}',
      parentToolUseId: 'parent-tool',
    })
    reducer.apply('session-1', { type: 'text_chunk', text: 'After tool draft', parentToolUseId: 'parent-tool' })
    reducer.apply('session-1', {
      type: 'assistant_message',
      text: 'After tool final',
      parentToolUseId: 'parent-tool',
    })

    expect(parent.subMessages?.map((message) => [message.role, message.content])).toEqual([
      ['assistant', 'Before tool'],
      ['tool', ''],
      ['assistant', 'After tool final'],
    ])
  })

  test('retains a child tool result after the sub-agent finishes', async () => {
    const { parent, reducer } = await createReducer()

    reducer.apply('session-1', {
      type: 'tool_call',
      toolName: 'Read',
      toolId: 'child-tool',
      index: 0,
      toolInput: '{"file_path":"src/a.ts"}',
      parentToolUseId: 'parent-tool',
    })
    reducer.apply('session-1', {
      type: 'tool_result',
      toolUseId: 'child-tool',
      parentToolUseId: 'parent-tool',
      status: 'ok',
      contentBytes: Buffer.byteLength('the complete file contents'),
    })

    expect(parent.subMessages?.[0]).toMatchObject({
      toolName: 'Read',
      toolInput: '{"file_path":"src/a.ts"}',
      contentBytes: Buffer.byteLength('the complete file contents'),
      toolStatus: 'completed',
    })
  })

  test('settles the card only when the child delivers its final answer', async () => {
    const { parent, reducer } = await createReducer()

    reducer.apply('session-1', {
      type: 'assistant_message',
      text: 'Still investigating.',
      parentToolUseId: 'parent-tool',
    })
    expect(parent.toolStatus).toBe('running')

    reducer.apply('session-1', {
      type: 'assistant_message',
      text: 'Investigation complete.',
      parentToolUseId: 'parent-tool',
      isFinal: true,
    })
    expect(parent.toolStatus).toBe('completed')
    // The card freezes elapsed time from this boundary after its live clock stops.
    expect(parent.toolCompletedAt).toBeGreaterThan(parent.timestamp)
  })

  test('settles the card when the child turn fails', async () => {
    const { parent, reducer } = await createReducer()

    reducer.apply('session-1', {
      type: 'subagent_report',
      toolUseId: 'parent-tool',
      text: 'Child process failed',
      isError: true,
    })

    expect(parent).toMatchObject({
      toolStatus: 'error',
      report: 'Child process failed',
    })
  })

  test('stores SDK task progress on the matching sub-agent card', async () => {
    const { parent, reducer } = await createReducer()

    reducer.apply('session-1', {
      type: 'background_task_started',
      taskId: 'task-1',
      toolUseId: 'parent-tool',
    })
    reducer.apply('session-1', {
      type: 'background_task_progress',
      taskId: 'task-1',
      toolUseId: 'parent-tool',
      description: 'Reading src/shared/types.ts',
      toolUses: 3,
      totalTokens: 1200,
      durationMs: 4500,
      lastToolName: 'Read',
    })

    expect(parent.backgroundTaskId).toBe('task-1')
    expect(parent.backgroundTaskProgress).toEqual({
      description: 'Reading src/shared/types.ts',
      toolUses: 3,
      totalTokens: 1200,
      durationMs: 4500,
      lastToolName: 'Read',
    })
  })

  test('records when a background sub-agent settles so its elapsed time does not reset', async () => {
    const { parent, reducer } = await createReducer()

    reducer.apply('session-1', {
      type: 'background_task_started',
      taskId: 'task-1',
      toolUseId: 'parent-tool',
    })
    reducer.apply('session-1', {
      type: 'background_task_settled',
      taskId: 'task-1',
      status: 'completed',
    })

    expect(parent.toolStatus).toBe('completed')
    expect(parent.toolCompletedAt).toBeGreaterThan(parent.timestamp)
  })

  test('records the settle for a backgrounded tool that already answered its call', async () => {
    // WHY: a run_in_background Bash returns its tool_result at launch, so it is
    // never 'running' when the task settles. Dropping the settle left the row
    // saying the session was planning for as long as the command ran, and timed
    // the command by its spawn instead of its finish.
    const { parent, reducer } = await createReducer()
    parent.toolName = 'Bash'
    parent.toolStatus = 'completed'
    parent.toolCompletedAt = 40

    reducer.apply('session-1', {
      type: 'background_task_started',
      taskId: 'b2lrrdn6z',
      toolUseId: 'parent-tool',
    })
    expect(parent.backgroundTaskSettledAt).toBeUndefined()

    reducer.apply('session-1', {
      type: 'background_task_settled',
      taskId: 'b2lrrdn6z',
      status: 'completed',
    })

    expect(parent.backgroundTaskSettledAt).toBeGreaterThan(parent.toolCompletedAt!)
    // The launch outcome stands: only the still-running sub-agent case rewrites it.
    expect(parent.toolStatus).toBe('completed')
    expect(parent.toolCompletedAt).toBe(40)
  })
})

const taskCompleteEvent = () => ({
  type: 'task_complete' as const,
  result: '',
  costUsd: 0,
  durationMs: 0,
  numTurns: 1,
  usage: {} as UsageData,
  sessionId: 'agent-1',
  permissionDenials: [] as { toolName: string; toolUseId: string }[],
})

async function createNotifyReducer() {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
  const session = {
    status: 'running',
    messages: [],
    currentTurnStartedAt: 123,
    currentTurnStart: 123,
    isStreamingText: false,
    isReconnecting: false,
    permissionQueue: [],
    questionQueue: [],
    run: { workingDirectory: null },
  } as unknown as Session
  const tab = { id: 'tab-1', sessionId: 'session-1', hasUnread: false } as Tab
  let notifyCount = 0
  const notificationTriggers: Array<[string, string]> = []
  let sweepCount = 0
  const reducer = new SessionEventReducer({
    registry: {
      tabs: { 'tab-1': tab },
      sessions: { 'session-1': session },
      sessionFor: (tabId: string) => tabId === 'tab-1' ? session : undefined,
      tabIdsBySession: new Map([['session-1', ['tab-1']]]),
    },
    settings: { rateLimitBehavior: 'ask' },
    isSessionVisible: () => false,
    onTurnSettled: () => {},
    refreshTurnSnapshots: () => {},
    workStreamTracker: { sweep: () => { sweepCount++ } },
    playNotificationIfHidden: (sessionId: string, trigger: string) => {
      notifyCount++
      notificationTriggers.push([sessionId, trigger])
    },
    log: () => {},
  } as any)
  return {
    session,
    tab,
    reducer,
    notifyCount: () => notifyCount,
    notificationTriggers,
    sweepCount: () => sweepCount,
  }
}

describe('SessionEventReducer turn-done notification timing', () => {
  test('finalizes only on the authoritative turn settlement', async () => {
    const { session, tab, reducer, notifyCount, notificationTriggers, sweepCount } = await createNotifyReducer()

    // A provider result is content, not the Solus turn boundary.
    reducer.apply('session-1', taskCompleteEvent())
    expect(notifyCount()).toBe(0)
    expect(sweepCount()).toBe(0)
    expect(tab.hasUnread).toBe(false)
    expect(session.currentTurnStartedAt).toBe(123)

    reducer.apply('session-1', {
      type: 'turn_settled',
      turnId: 'turn-1',
      outcome: 'completed',
      settledAt: 456,
    })
    expect(notifyCount()).toBe(1)
    expect(notificationTriggers).toEqual([['session-1', 'turn_settled']])
    expect(sweepCount()).toBe(1)
    expect(tab.hasUnread).toBe(true)
    expect(session.currentTurnStartedAt).toBeNull()

    // A transport retry of the same settlement is idempotent.
    reducer.apply('session-1', {
      type: 'turn_settled',
      turnId: 'turn-1',
      outcome: 'completed',
      settledAt: 456,
    })
    expect(notifyCount()).toBe(1)
    expect(sweepCount()).toBe(1)
  })

  test('does not play the completion sound for a failed settlement', async () => {
    const { reducer, tab, notifyCount } = await createNotifyReducer()

    reducer.apply('session-1', {
      type: 'turn_settled',
      turnId: 'turn-2',
      outcome: 'failed',
      settledAt: 456,
    })
    expect(notifyCount()).toBe(0)
    // WHY: the sidebar must emphasize a failed background session until the
    // user opens it, even though failure does not use the completion sound.
    expect(tab.hasUnread).toBe(true)
  })
})
