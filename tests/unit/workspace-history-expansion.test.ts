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

describe('paged history expansion', () => {
  test('cursor pages prepend only older rows, preserve live objects, and drain for Find', async () => {
    const current = message('assistant', 'newest', 3)
    const live = message('assistant', 'live update', 4)
    // Equal timestamps do not make disjoint messages duplicates.
    const older = message('assistant', 'older', 3)
    const oldest = message('user', 'oldest', 1)
    const session = {
      agentSessionId: 'current-session',
      run: { provider: 'codex', workingDirectory: '/repo', gitContext: null },
      historyTruncated: true, historyCursor: 'page-1',
      messages: [current], progress: null, sessionChangedFiles: [],
    } as unknown as Session
    const cursors: (string | undefined)[] = []
    const store = new WorkspaceLifecycleStore({
      registry: { sessionFor: () => session },
      settings: { activeAgent: 'codex' }, config: {},
      planStore: { hydrateAnnotations() {} },
      ctxFor: () => ({ session: { sessionId: 'tab-1' } }),
      loadTranscript: async ({ before, turnLimit }) => {
        expect(turnLimit).toBe(20)
        cursors.push(before)
        if (before === 'page-1') {
          session.messages.push(live)
          return { messages: [older], before: 'page-2', truncated: true, progress: null, planIds: [] }
        }
        return { messages: [oldest], before: null, truncated: false, progress: null, planIds: [] }
      },
      rebuildAgentConversations() {},
    } as never)
    await store.expandHistory('tab-1', { full: true })
    expect(cursors).toEqual(['page-1', 'page-2'])
    expect(session.messages).toEqual([oldest, older, current, live])
    expect(session.messages[2]).toBe(current)
    expect(session.messages[3]).toBe(live)
    expect(session.historyTruncated).toBe(false)
    expect(session.historyCursor).toBeNull()
  })

  test('a failed page keeps the cursor and loaded history for retry', async () => {
    const current = message('assistant', 'newest', 3)
    const session = {
      agentSessionId: 'current-session',
      run: { provider: 'codex', workingDirectory: '/repo', gitContext: null },
      historyTruncated: true, historyCursor: 'older', messages: [current],
    } as unknown as Session
    const store = new WorkspaceLifecycleStore({
      registry: { sessionFor: () => session },
      settings: { activeAgent: 'codex' }, config: {},
      ctxFor: () => ({ session: { sessionId: 'tab-1' } }),
      loadTranscript: async () => { throw new Error('Disconnected') },
    } as never)
    await expect(store.expandHistory('tab-1')).rejects.toThrow('Disconnected')
    expect(session.messages).toEqual([current])
    expect(session.historyCursor).toBe('older')
  })
})

describe('releasing older history', () => {
  // WHY: a hidden tab must not keep every page the reader once scrolled into.
  // Release goes back to the restored window and its cursor, so scrolling up
  // reads the same pages again rather than skipping or repeating any.
  function pagedSession(status: Session['status']) {
    const current = message('assistant', 'newest', 3)
    const session = {
      agentSessionId: 'current-session', status,
      run: { provider: 'codex', workingDirectory: '/repo', gitContext: null },
      historyTruncated: true, historyCursor: 'page-1', historyPendingMessages: undefined,
      messages: [current], progress: null, sessionChangedFiles: [],
    } as unknown as Session
    const cursors: (string | undefined)[] = []
    const store = new WorkspaceLifecycleStore({
      registry: { sessionFor: () => session },
      settings: { activeAgent: 'codex' }, config: {},
      planStore: { hydrateAnnotations() {} },
      ctxFor: () => ({ session: { sessionId: 'tab-1' } }),
      loadTranscript: async ({ before }) => {
        cursors.push(before)
        return before === 'page-1'
          ? { messages: [message('user', 'older', 2)], before: 'page-2', truncated: true, progress: null, planIds: [] }
          : { messages: [message('user', 'oldest', 1)], before: null, truncated: false, progress: null, planIds: [] }
      },
      rebuildAgentConversations() {},
    } as never)
    return { session, store, current, cursors }
  }

  test('an idle tab drops back to its restored window and pages the same way again', async () => {
    const { session, store, current, cursors } = pagedSession('idle')
    await store.expandHistory('tab-1', { full: true })
    expect(session.messages).toHaveLength(3)
    session.sessionChangedFiles = ['src/a.ts']

    store.releaseOlderHistory('tab-1')
    expect(session.messages).toEqual([current])
    expect(session.messages[0]).toBe(current)
    expect(session.historyCursor).toBe('page-1')
    expect(session.historyTruncated).toBe(true)
    expect(session.sessionChangedFiles).toEqual(['src/a.ts'])

    await store.expandHistory('tab-1')
    expect(cursors).toEqual(['page-1', 'page-2', 'page-1'])
    expect(session.messages.map((entry) => entry.content)).toEqual(['older', 'newest'])
  })

  test('a running tab keeps everything its turn may reach back to', async () => {
    const { session, store } = pagedSession('running')
    await store.expandHistory('tab-1', { full: true })
    store.releaseOlderHistory('tab-1')
    expect(session.messages).toHaveLength(3)
  })

  test('a tab that never paged has nothing to release', () => {
    const { session, store, current } = pagedSession('idle')
    store.releaseOlderHistory('tab-1')
    expect(session.messages).toEqual([current])
    expect(session.historyCursor).toBe('page-1')
  })
})
