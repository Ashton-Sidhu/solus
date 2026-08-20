import { afterEach, describe, expect, test } from 'bun:test'
import type { Message, Session, Tab } from '@solus/contracts/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

async function createReducer(
  messages: Message[],
  isSessionVisible = true,
  refreshSessionBinding: (sessionId: string) => Promise<unknown> = async () => null,
  trackSessionStart: (taskId: string, sessionId: string) => void = () => {},
  linkSession: (...args: unknown[]) => Promise<unknown> = () => new Promise(() => {}),
) {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
  const session = {
    id: 'session-1',
    status: 'running',
    messages,
    outboundPrompts: [],
    permissionQueue: [],
    questionQueue: [],
    run: {},
    task: { kind: 'new' },
  } as unknown as Session
  const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
  const reducer = new SessionEventReducer({
    registry: {
      tabs: { 'tab-1': tab },
      sessions: { 'session-1': session },
      sessionFor: (tabId: string) => tabId === 'tab-1' ? session : undefined,
      tabIdsBySession: new Map([['session-1', ['tab-1']]]),
    },
    settings: { rateLimitBehavior: 'ask' },
    // `linkSession` is the durable write to the task's host; this test is about
    // what the renderer holds while that write is in flight, so it only has to
    // exist and not resolve.
    tasksStore: { refreshSessionBinding, trackSessionStart, linkSession },
    workStreamTracker: { sweep: () => {} },
    onTurnSettled: () => {},
    refreshTurnSnapshots: () => {},
    isSessionVisible: () => isSessionVisible,
    closePlanModal: () => {},
    playNotificationIfHidden: () => {},
    log: () => {},
  } as any)
  return { reducer, session }
}

describe('SessionEventReducer card stream boundaries', () => {
  test('keeps provisional task ownership until the durable session link hydrates', async () => {
    let tracked: [string, string] | null = null
    let finishHydration!: (value: object) => void
    const hydration = new Promise<object>((resolve) => {
      finishHydration = resolve
    })
    const { reducer, session } = await createReducer(
      [],
      true,
      () => hydration,
      (taskId, sessionId) => { tracked = [taskId, sessionId] },
    )
    session.task = { kind: 'existing', taskId: 'subtask-1' }
    session.currentTurnStart = 'fresh'
    session.run.serverId = 'remote-host'
    session.run.taskServerId = 'task-host'

    reducer.apply('session-1', {
      type: 'session_init',
      sessionId: 'agent-session-1',
      model: 'gpt-test',
      skills: [],
    })

    // WHY: clearing this before hydration resolves gives the sidebar one frame
    // where the new subtask is rendered as an unrelated loose session.
    expect(tracked).toEqual(['subtask-1', 'session-1'])
    expect(session.task).toEqual({ kind: 'existing', taskId: 'subtask-1' })

    finishHydration({ id: 'subtask-1' })
    await hydration
    await Promise.resolve()
    // WHY: the durable link is authoritative once it exists, so the mounted
    // session keeps its durable task identity.
    expect(session.task).toEqual({ kind: 'existing', taskId: 'subtask-1' })
  })

  test('links a fresh dispatched session without task-owned branch metadata', async () => {
    let linked: unknown[] | null = null
    const { reducer, session } = await createReducer(
      [],
      true,
      async () => null,
      () => {},
      async (...args) => { linked = args },
    )
    session.task = { kind: 'existing', taskId: 'task-1' }
    session.currentTurnStart = 'fresh'
    session.run.serverId = 'remote-host'
    session.run.taskServerId = 'task-host'
    session.run.provider = 'claude-code'
    session.run.projectGroupPath = '/Users/sidhu/solus'
    session.run.gitContext = {
      branch: 'solus/remote-worktree',
      targetBranch: 'main',
      repoRoot: '/home/sidhu/solus',
      worktreePath: '/home/sidhu/solus/.solus-worktrees/remote-worktree',
    }

    reducer.apply('session-1', {
      type: 'session_init',
      sessionId: 'agent-session-1',
      model: 'claude-test',
      skills: [],
    })
    await Promise.resolve()

    // WHY: the relationship records only the remote execution host. Branch
    // metadata has its own session write and must not travel through this API.
    expect(linked).toEqual([
      'task-host',
      'task-1',
      'session-1',
      {
        serverId: 'remote-host',
        provider: 'claude-code',
        projectRoot: '/Users/sidhu/solus',
      },
    ])
  })

  test('does not rewrite a task binding when a session resumes', async () => {
    let links = 0
    const { reducer, session } = await createReducer(
      [],
      true,
      async () => null,
      () => {},
      async () => { links++ },
    )
    session.task = { kind: 'existing', taskId: 'task-1' }
    session.currentTurnStart = 'follow_up'
    session.run.serverId = 'remote-host'
    session.run.taskServerId = 'task-host'

    reducer.apply('session-1', {
      type: 'session_init',
      sessionId: 'agent-session-1',
      model: 'claude-test',
      skills: [],
    })
    await Promise.resolve()

    expect(links).toBe(0)
  })

  test('advances the visible startup lifecycle from connection to thinking', async () => {
    const { reducer, session } = await createReducer([])
    session.currentActivity = 'Starting session...'
    session.currentTurnStart = 'fresh'

    reducer.apply('session-1', {
      type: 'session_init',
      sessionId: 'agent-session-1',
      model: 'gpt-test',
      skills: [],
    })
    expect(session.currentActivity).toBe('Connecting...')

    reducer.apply('session-1', { type: 'thinking', state: 'start' })
    expect(session.currentActivity).toBe('Thinking...')
  })

  test('adds an interrupt divider immediately and deduplicates the provider confirmation', async () => {
    const { reducer, session } = await createReducer([
      {
        id: 'user-1',
        role: 'user',
        content: 'Do the work',
        timestamp: 1,
      },
    ])
    session.statusCard = {
      id: 'setup-1',
      title: 'Preparing worktree…',
      status: 'active',
      steps: [{ id: 'worktree', label: 'Creating worktree', status: 'active' }],
    }

    reducer.interruptSession('session-1')

    expect(session.status).toBe('interrupted')
    // WHY: a setup card describes work that is currently happening. Once the
    // user interrupts it, leaving the card visible falsely says setup continues.
    expect(session.statusCard).toBeNull()
    expect(session.messages.at(-1)).toMatchObject({
      role: 'system',
      content: '[Request interrupted by user]',
    })

    reducer.apply('session-1', {
      type: 'user_message',
      text: '[Request interrupted by user]',
    })

    expect(session.messages).toHaveLength(2)
  })

  test('stores provider-only interrupt notices as system dividers', async () => {
    const { reducer, session } = await createReducer([])

    reducer.apply('session-1', {
      type: 'user_message',
      text: '[Request cancelled by user]',
    })

    expect(session.messages.at(-1)).toMatchObject({
      role: 'system',
      content: '[Request cancelled by user]',
    })
  })

  test('marks server-confirmed steering messages as live-turn input', async () => {
    const { reducer, session } = await createReducer([])

    reducer.apply('session-1', {
      type: 'user_message',
      text: 'Use the smaller implementation',
      delivery: 'steer',
    })

    expect(session.currentTurnStart).toBe('steer')
    expect(session.currentActivity).toBe('Steering...')
    expect(session.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'Use the smaller implementation',
      delivery: 'steer',
    })
  })

  test('starts elapsed timing before a provider-originated prompt is echoed', async () => {
    const { reducer, session } = await createReducer([])
    session.currentTurnStartedAt = null
    const before = Date.now()

    reducer.apply('session-1', { type: 'status_change', status: 'connecting' })

    // WHY: status commonly arrives before user_message for remote and watched
    // sessions. The sidebar must show its timer from the first running state.
    expect(session.currentTurnStartedAt).toBeGreaterThanOrEqual(before)
    const startedAt = session.currentTurnStartedAt

    reducer.apply('session-1', {
      type: 'user_message',
      text: 'Do the remote work',
    })
    expect(session.currentTurnStartedAt).toBe(startedAt)

    reducer.apply('session-1', { type: 'status_change', status: 'completed' })
    expect(session.currentTurnStartedAt).toBe(startedAt)
    reducer.apply('session-1', {
      type: 'turn_settled',
      turnId: 'turn-1',
      outcome: 'completed',
      settledAt: Date.now(),
    })
    expect(session.currentTurnStartedAt).toBeNull()
  })

  test('reconciles identical outbound prompts by client id and preserves presentation data', async () => {
    const { reducer, session } = await createReducer([])
    session.outboundPrompts.push(
      {
        clientPromptId: 'prompt-a',
        text: 'Same text',
        state: 'steering',
        enqueuedAt: 1,
        attachments: [{ name: 'design.png', dataUrl: 'data:image/png;base64,QQ==', type: 'image' }],
      },
      {
        clientPromptId: 'prompt-b',
        text: 'Same text',
        state: 'steering',
        enqueuedAt: 2,
      },
    )

    reducer.apply('session-1', {
      type: 'prompt_queued',
      clientPromptId: 'prompt-b',
      queueId: 'queue-b',
      text: 'Same text',
      enqueuedAt: 3,
    })

    expect(session.outboundPrompts[0]).toMatchObject({ clientPromptId: 'prompt-a', state: 'steering' })
    expect(session.outboundPrompts[1]).toMatchObject({
      clientPromptId: 'prompt-b',
      queueId: 'queue-b',
      state: 'queued',
    })

    reducer.apply('session-1', {
      type: 'user_message',
      clientPromptId: 'prompt-a',
      text: 'Same text',
      delivery: 'steer',
    })

    expect(session.outboundPrompts).toHaveLength(1)
    expect(session.outboundPrompts[0].clientPromptId).toBe('prompt-b')
    expect(session.messages.at(-1)).toMatchObject({
      id: 'prompt-a',
      delivery: 'steer',
      attachments: [{ name: 'design.png' }],
    })
  })

  test('renders assistant text after an agent-conversation card as a separate message', async () => {
    // WHY: an agent-conversation card is a structured block, not prose — streamed text after
    // it must open its own assistant message instead of gluing onto the card.
    const agentConversationCard: Message = {
      id: 'agent-conversation-card',
      role: 'assistant',
      content: '',
      agentConversationRef: {
        agentSessionId: 'spawned-session',
        provider: 'codex',
        title: 'Investigate the issue',
        cwd: '/project',
        origin: 'created',
        exchanges: [{
          exchangeId: 'x1',
          index: 1,
          prompt: 'Investigate the issue',
          dispatchedAt: 0,
          status: 'dispatched',
        }],
      },
      timestamp: 0,
    }
    const { reducer, session } = await createReducer([agentConversationCard])

    reducer.appendTextChunk('session-1', session, 'I started a separate investigation.')
    reducer.commitPendingStream('session-1')

    expect(session.messages).toHaveLength(2)
    expect(session.messages[0]).toBe(agentConversationCard)
    expect(agentConversationCard.content).toBe('')
    expect(session.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'I started a separate investigation.',
    })
  })

  test('one agent-conversation card per agent per turn: dispatches append, settles land by exchange', async () => {
    const { reducer, session } = await createReducer([])

    // WHY: three exchanges with one agent must produce ONE block, not three
    // disjoint cards — that is the core agent-conversation contract.
    reducer.apply('session-1', {
      type: 'agent_conversation_update',
      update: {
        phase: 'dispatched', agentSessionId: 'agent-1', exchangeId: 'x1', origin: 'prompted',
        prompt: 'First question', provider: 'codex', title: 'Peer', cwd: '/p', dispatchedAt: 1,
      },
    })
    reducer.apply('session-1', {
      type: 'agent_conversation_update',
      update: {
        phase: 'dispatched', agentSessionId: 'agent-1', exchangeId: 'x2', origin: 'prompted',
        prompt: 'Second question', provider: 'codex', title: 'Peer', cwd: '/p', dispatchedAt: 2,
      },
    })
    const agentConversationMessages = session.messages.filter((m) => m.agentConversationRef)
    expect(agentConversationMessages).toHaveLength(1)
    expect(agentConversationMessages[0].agentConversationRef?.exchanges.map((x) => x.index)).toEqual([1, 2])

    // A genuine user turn cuts the boundary; the next dispatch opens a new card…
    reducer.apply('session-1', { type: 'user_message', text: 'carry on' })
    reducer.apply('session-1', {
      type: 'agent_conversation_update',
      update: {
        phase: 'dispatched', agentSessionId: 'agent-1', exchangeId: 'x3', origin: 'prompted',
        prompt: 'Third question', provider: 'codex', title: 'Peer', cwd: '/p', dispatchedAt: 3,
      },
    })
    expect(session.messages.filter((m) => m.agentConversationRef)).toHaveLength(2)

    // …while a settle for an old exchange still lands in the OLD turn's card.
    reducer.apply('session-1', {
      type: 'agent_conversation_update',
      update: {
        phase: 'settled', agentSessionId: 'agent-1', exchangeId: 'x1', status: 'completed',
        replyText: 'First answer', settledAt: 4,
      },
    })
    const first = session.messages.filter((m) => m.agentConversationRef)[0]
    expect(first.agentConversationRef?.exchanges[0]).toMatchObject({ status: 'done', reply: 'First answer' })
  })

  test('suppresses session-report prompts from the transcript entirely', async () => {
    const { reducer, session } = await createReducer([])

    // WHY: the report is turn input for the MODEL; rendering it as a user
    // bubble is the exact failure the agent-conversation card removes.
    reducer.apply('session-1', {
      type: 'user_message',
      text: '[session report] Session abc finished (status: completed). Final reply:\nhello',
      via: 'session-report',
      agentSessionId: 'abc',
      agentExchangeId: 'x1',
    })
    expect(session.messages).toHaveLength(0)

    reducer.apply('session-1', {
      type: 'prompt_queued',
      text: '[session report] …',
      queueId: 'q1',
      enqueuedAt: 1,
      via: 'session-report',
    })
    expect(session.outboundPrompts).toHaveLength(0)
  })

  test('buffers hidden-tab chunks without rebuilding the reactive stream string', async () => {
    const { reducer, session } = await createReducer([], false)

    reducer.appendTextChunk('session-1', session, 'first ')
    reducer.appendTextChunk('session-1', session, 'second')

    expect(reducer.streaming.text['session-1']).toBeUndefined()
    expect(reducer.streamingTextFor('session-1', false)).toBe('')
    expect(reducer.streamingTextFor('session-1', true)).toBe('first second')

    reducer.commitPendingStream('session-1')
    expect(session.messages.at(-1)?.content).toBe('first second')
    expect(reducer.streamingTextFor('session-1', true)).toBe('')
  })

  test('separates consecutive logical assistant messages with a Markdown paragraph', async () => {
    const { reducer, session } = await createReducer([{
      id: 'user-1',
      role: 'user',
      content: 'Run the debate.',
      timestamp: 1,
    }])

    reducer.apply('session-1', { type: 'text_chunk', text: 'The openings are in.' })
    reducer.apply('session-1', { type: 'assistant_message', text: 'The openings are in.' })
    reducer.apply('session-1', { type: 'text_chunk', text: 'Starting the rebuttal round.' })
    reducer.apply('session-1', { type: 'assistant_message', text: 'Starting the rebuttal round.' })

    // WHY: providers can emit multiple prose messages in one turn. They share
    // one assistant surface, but each is a distinct thought and must not render
    // as "in.Starting" (a single newline is only whitespace in Markdown).
    expect(session.messages).toHaveLength(2)
    expect(session.messages[1].content).toBe(
      'The openings are in.\n\nStarting the rebuttal round.',
    )
  })

  test('does not separate chunks committed by unrelated stream events', async () => {
    const { reducer, session } = await createReducer([])

    reducer.apply('session-1', { type: 'text_chunk', text: 'One continuous' })
    reducer.apply('session-1', { type: 'usage', run: { inputTokens: 1, outputTokens: 1 } })
    reducer.apply('session-1', { type: 'text_chunk', text: ' thought.' })
    reducer.commitPendingStream('session-1')

    // WHY: usage and status events can interrupt transport chunks inside one
    // logical message. Only assistant_message is a prose boundary.
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].content).toBe('One continuous thought.')
  })

  test('keeps goal notifications after an interrupted turn', async () => {
    const { reducer, session } = await createReducer([])
    session.status = 'interrupted'
    session.agentSessionId = 'thread-1'

    // WHY: pausing or updating a persistent goal is independent of the last
    // turn's terminal state; dropping the notification leaves the panel stale.
    reducer.apply('session-1', {
      type: 'goal_updated',
      goal: {
        threadId: 'thread-1',
        objective: 'Finish the feature',
        status: 'paused',
      },
    })
    expect(session.goal).toMatchObject({ status: 'paused' })

    reducer.apply('session-1', { type: 'goal_cleared', threadId: 'thread-1' })
    expect(session.goal).toBeNull()
  })
})
