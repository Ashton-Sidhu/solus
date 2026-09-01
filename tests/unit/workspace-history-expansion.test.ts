import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Message, Session } from '@solus/contracts/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let WorkspaceLifecycleStore: typeof import('@solus/workspace-ui/contexts/workspace/workspace-lifecycle.store.svelte')['WorkspaceLifecycleStore']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  ;({ WorkspaceLifecycleStore } = await import('@solus/workspace-ui/contexts/workspace/workspace-lifecycle.store.svelte'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function message(role: Message['role'], content: string, timestamp: number): Message {
  return { id: `message-${timestamp}`, role, content, timestamp } as Message
}

describe('full history expansion', () => {
  test('keeps handoff lineage and live events that arrive during the RPC', async () => {
    const predecessor = message('user', 'before handoff', 1)
    const current = message('assistant', 'after handoff', 2)
    const live = message('assistant', 'arrived live', 3)
    const session = {
      agentSessionId: 'current-session',
      run: {
        provider: 'codex',
        workingDirectory: '/repo',
        gitContext: null,
      } as Session['run'],
      handoffFrom: { sessionId: 'previous-session', provider: 'claude-code' },
      historyTruncated: true,
      messages: [current],
      progress: null,
      sessionChangedFiles: [],
    } as unknown as Session
    const loaded: string[] = []
    let trackerRebuilds = 0
    const store = new WorkspaceLifecycleStore({
      registry: {
        sessionFor: () => session,
      },
      settings: { activeAgent: 'codex' },
      config: {},
      planStore: { hydrateAnnotations() {} },
      refreshGitState: async () => ({ ok: true }),
      ctxFor: () => ({ session: { sessionId: 'tab-1' } }),
      loadTranscript: async ({ sessionId }) => {
        loaded.push(sessionId)
        if (sessionId === 'previous-session') {
          return { messages: [predecessor], progress: null, planIds: [], truncated: false }
        }
        session.messages.push(live)
        return { messages: [current], progress: null, planIds: [], truncated: false }
      },
      rebuildAgentConversations: () => { trackerRebuilds += 1 },
    } as never)

    await store.expandHistory('tab-1', { full: true })

    expect(loaded).toEqual(['previous-session', 'current-session'])
    expect(session.messages.map((entry) => entry.content)).toEqual([
      'before handoff',
      'after handoff',
      'arrived live',
    ])
    expect(session.historyTruncated).toBe(false)
    expect(trackerRebuilds).toBe(1)
  })
})

describe('paged history expansion', () => {
  test('scrolling widens the window instead of reading the whole session', async () => {
    // A page of tool results can collapse into no new rendered rows, so the
    // window has to grow off the last request. Growing off the message count
    // would repeat the same request and loop the caller forever.
    const only = message('assistant', 'only row', 1)
    const session = {
      agentSessionId: 'current-session',
      run: { provider: 'codex', workingDirectory: '/repo', gitContext: null } as Session['run'],
      historyTruncated: true,
      messages: [only],
      progress: null,
      sessionChangedFiles: [],
    } as unknown as Session
    const requestedLimits: (number | undefined)[] = []
    const store = new WorkspaceLifecycleStore({
      registry: { sessionFor: () => session },
      settings: { activeAgent: 'codex' },
      config: {},
      planStore: { hydrateAnnotations() {} },
      refreshGitState: async () => ({ ok: true }),
      ctxFor: () => ({ session: { sessionId: 'tab-1' } }),
      loadTranscript: async ({ limit }) => {
        requestedLimits.push(limit)
        return { messages: [only], progress: null, planIds: [], truncated: true }
      },
      rebuildAgentConversations: () => {},
    } as never)

    await store.expandHistory('tab-1')
    await store.expandHistory('tab-1')

    expect(requestedLimits).toEqual([400, 600])
    expect(session.historyTruncated).toBe(true)

    // Find and the explicit reveal-all command can still request everything.
    await store.expandHistory('tab-1', { full: true })
    expect(requestedLimits[2]).toBeUndefined()
  })

  test('a page that exhausts the session drops back to an unbounded read', async () => {
    const only = message('assistant', 'only row', 1)
    const session = {
      agentSessionId: 'current-session',
      run: { provider: 'codex', workingDirectory: '/repo', gitContext: null } as Session['run'],
      historyTruncated: true,
      messages: [only],
      progress: null,
      sessionChangedFiles: [],
    } as unknown as Session
    const requestedLimits: (number | undefined)[] = []
    const store = new WorkspaceLifecycleStore({
      registry: { sessionFor: () => session },
      settings: { activeAgent: 'codex' },
      config: {},
      planStore: { hydrateAnnotations() {} },
      refreshGitState: async () => ({ ok: true }),
      ctxFor: () => ({ session: { sessionId: 'tab-1' } }),
      loadTranscript: async ({ limit }) => {
        requestedLimits.push(limit)
        return { messages: [only], progress: null, planIds: [], truncated: false }
      },
      rebuildAgentConversations: () => {},
    } as never)

    await store.expandHistory('tab-1')

    expect(requestedLimits).toEqual([400])
    expect(session.historyTruncated).toBe(false)
  })
})
