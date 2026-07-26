import { afterEach, describe, expect, test } from 'bun:test'
import type { Message, Session, Tab } from '../../src/shared/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

async function createReducer(messages: Message[]) {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  const { SessionEventReducer } = await import('../../src/renderer/contexts/workspace/session-event-reducer.svelte')
  const session = {
    status: 'running',
    messages,
  } as Session
  const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
  const reducer = new SessionEventReducer({
    registry: {
      tabs: { 'tab-1': tab },
      sessions: { 'session-1': session },
      sessionFor: (tabId: string) => tabId === 'tab-1' ? session : undefined,
    },
  } as any)
  return { reducer, session }
}

describe('SessionEventReducer card stream boundaries', () => {
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
})
