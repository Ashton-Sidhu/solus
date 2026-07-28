import { afterEach, describe, expect, test } from 'bun:test'
import type { Message, Session, Tab } from '../../src/shared/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

async function createReducer(messages: Message[], isTabVisible = true) {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  const { SessionEventReducer } = await import('../../src/renderer/contexts/workspace/session-event-reducer.svelte')
  const session = {
    status: 'running',
    messages,
    outboundPrompts: [],
  } as Session
  const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
  const reducer = new SessionEventReducer({
    registry: {
      tabs: { 'tab-1': tab },
      sessions: { 'session-1': session },
      sessionFor: (tabId: string) => tabId === 'tab-1' ? session : undefined,
    },
    settings: { rateLimitBehavior: 'ask' },
    isTabVisible: () => isTabVisible,
    log: () => {},
  } as any)
  return { reducer, session }
}

describe('SessionEventReducer card stream boundaries', () => {
  test('marks server-confirmed steering messages as live-turn input', async () => {
    const { reducer, session } = await createReducer([])

    reducer.apply('tab-1', {
      type: 'user_message',
      text: 'Use the smaller implementation',
      delivery: 'steer',
    })

    expect(session.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'Use the smaller implementation',
      delivery: 'steer',
    })
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

    reducer.apply('tab-1', {
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

    reducer.apply('tab-1', {
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

  test('renders assistant text after a created-session card as a separate message', async () => {
    const sessionCard: Message = {
      id: 'session-card',
      role: 'assistant',
      content: '',
      sessionRef: {
        agentSessionId: 'spawned-session',
        title: 'Investigate the issue',
        provider: 'codex',
        cwd: '/project',
        verb: 'Started',
      },
      timestamp: 0,
    }
    const { reducer, session } = await createReducer([sessionCard])

    reducer.appendTextChunk('tab-1', session, 'I started a separate investigation.')
    reducer.commitPendingStream('tab-1')

    expect(session.messages).toHaveLength(2)
    expect(session.messages[0]).toBe(sessionCard)
    expect(sessionCard.content).toBe('')
    expect(session.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'I started a separate investigation.',
    })
  })

  test('buffers hidden-tab chunks without rebuilding the reactive stream string', async () => {
    const { reducer, session } = await createReducer([], false)

    reducer.appendTextChunk('tab-1', session, 'first ')
    reducer.appendTextChunk('tab-1', session, 'second')

    expect(reducer.streaming.text['tab-1']).toBeUndefined()
    expect(reducer.streamingTextFor('tab-1', false)).toBe('')
    expect(reducer.streamingTextFor('tab-1', true)).toBe('first second')

    reducer.commitPendingStream('tab-1')
    expect(session.messages.at(-1)?.content).toBe('first second')
    expect(reducer.streamingTextFor('tab-1', true)).toBe('')
  })
})
