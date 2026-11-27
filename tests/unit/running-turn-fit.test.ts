import { afterEach, expect, mock, test } from 'bun:test'
import type { Message, Session, Tab } from '@solus/contracts/types'
import type { SessionHistoryPageRequest } from '@solus/contracts/session-history'
import { folderLocation } from '@solus/workspace-ui/contexts/workspace/run-location'

// docs/plans/running-turn-open.md: on desktop and web a session opens with its
// history page and a watch read side by side. The watch's replay of the running
// turn must land after the page, and the two must name the same running turn;
// when a turn starts or ends between them, one opening read gives both again.

const previousState = (globalThis as unknown as { $state?: unknown }).$state
afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

async function reducerFor(session: Session) {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
  const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
  // SAFETY: the reducer reads only these dependencies for prompt and tool events.
  return new SessionEventReducer({
    sessions: { byId: { 'session-1': session } },
    registry: { tabs: { 'tab-1': tab }, sessionFor: () => session, tabIdsBySession: new Map([['session-1', ['tab-1']]]) },
    settings: { activeAgent: 'claude-code', rateLimitBehavior: 'ask' },
    workStreamTracker: { beginWorkStream: () => {}, updateStreamingArtifact: () => {}, failArtifact: () => {} },
    closePlanModal: () => {},
    log: () => {},
  } as any)
}

function runningSession(): Session {
  return { id: 'session-1', status: 'running', messages: [], outboundPrompts: [], run: { provider: 'claude-code', location: folderLocation({ serverId: 'local', path: '/repo' }) } } as unknown as Session
}

test('a replay that arrives before the page lands after it, in order', async () => {
  const session = runningSession()
  const reducer = await reducerFor(session)
  reducer.holdEvents('session-1')
  reducer.apply('session-1', { type: 'user_message', text: 'the running prompt', clientPromptId: 'p-1' }, 'epoch.1')
  reducer.apply('session-1', { type: 'tool_call', toolName: 'Read', toolId: 'tool-1', index: 0 }, 'epoch.2')
  expect(session.messages).toEqual([])
  // The page replaces the rows, as an open does.
  const settled: Message = { id: 'history-1', role: 'user', content: 'an earlier turn', timestamp: 1 }
  session.messages.splice(0, session.messages.length, settled)
  reducer.releaseEvents('session-1')
  expect(session.messages.map((message) => message.role === 'tool' ? `tool:${message.toolId}` : message.content))
    .toEqual(['an earlier turn', 'the running prompt', 'tool:tool-1'])
  // A later watch of this session resumes after the last event applied.
  expect(reducer.cursorOf('session-1')).toBe('epoch.2')
})

test('a page and a watch that name another turn are read again in one opening read', async () => {
  const reads: SessionHistoryPageRequest[] = []
  mock.module('@solus/workspace-ui/contexts/workspace/session-transcript', () => ({
    loadSessionTranscript: async (_workspace: unknown, args: { history: Promise<unknown> }) => {
      await args.history
      return { messages: [{ id: 'reread', role: 'user', content: 'settled', timestamp: 1 }], planIds: [], progress: null, truncated: false, before: null }
    },
  }))
  const { fitTranscriptToWatch } = await import('@solus/workspace-ui/contexts/workspace/running-turn-fit')
  const session = runningSession()
  const reducer = await reducerFor(session)
  reducer.holdEvents('session-1')
  reducer.apply('session-1', { type: 'tool_call', toolName: 'Read', toolId: 'replayed-by-the-first-watch', index: 0 })
  const attached: unknown[] = []
  const workspace = {
    eventReducer: reducer,
    sessionFor: () => session,
    apiFor: () => ({
      loadSessionPage: async (request: SessionHistoryPageRequest) => {
        reads.push(request)
        return { messages: [], before: null, resumedWatch: { runtime: null, runningTurnStartedAt: 2_000 }, openingDescription: { lineage: null, meta: null } }
      },
    }),
    applyRuntimeAttach: (_tabId: string, runtime: unknown) => attached.push(runtime),
    applyPendingQuestions: () => {},
  }
  const request = { sessionId: 'session-1', provider: 'claude-code' as const, turnLimit: 10 }
  const args = { sessionId: 'session-1', loadPath: '/repo', displayCwd: '/repo', provider: 'claude-code' as const, ctx: {} as never }

  // The same turn: nothing to read again.
  await fitTranscriptToWatch(workspace as never, 'tab-1', session, { pageTurn: 1_000, watchedTurn: 1_000 }, request, args)
  expect(reads).toEqual([])

  // The page was read before a turn started that the watch then replayed.
  await fitTranscriptToWatch(workspace as never, 'tab-1', session, { pageTurn: undefined, watchedTurn: 1_000 }, request, args)
  expect(reads).toEqual([{ ...request, openSession: true }])
  expect(session.messages.map((message) => message.id)).toEqual(['reread'])
  expect(attached).toEqual([null])
  // The first watch's replay is gone: the opening read's watch replays the turn again.
  reducer.releaseEvents('session-1')
  expect(session.messages.map((message) => message.id)).toEqual(['reread'])
})
