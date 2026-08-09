import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { GoalSync } from '../../src/renderer/contexts/workspace/goal-sync'
import type { Session } from '../../src/shared/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let ClaudeGoalStore: typeof import('../../src/main/sessions/claude-goal-store')['ClaudeGoalStore']

beforeAll(async () => {
  ;({ ClaudeGoalStore } = await import('../../src/main/sessions/claude-goal-store'))
})

function goalStore() {
  const values = new Map<string, string>()
  const database = {
    prepare(sql: string) {
      return sql.includes('SELECT')
        ? { get: (key: string) => values.has(key) ? { value: values.get(key) } : undefined }
        : { run: (key: string, value: string) => { values.set(key, value) } }
    },
  }
  let now = 1_000
  return {
    store: new ClaudeGoalStore(() => database as never, () => now),
    advance(ms: number) { now += ms },
  }
}

describe('Claude goals', () => {
  test('persists one immutable goal per Claude session', () => {
    // WHY: Claude has no provider goal record, so Solus must retain the objective
    // without accidentally exposing Codex-only edit semantics.
    const { store } = goalStore()
    const created = store.create({ threadId: 'session-1', objective: 'Ship the feature' })

    expect(store.get('session-1')).toEqual(created)
    expect(() => store.create({ threadId: 'session-1', objective: 'Replace it' })).toThrow(
      'Claude goals cannot be updated after creation',
    )
  })

  test('tracks completed-turn usage and derives completion from session status', () => {
    // WHY: Claude emits ordinary turn usage and status events rather than goal
    // events; those canonical signals are the source of truth for its goal card.
    const { store, advance } = goalStore()
    store.create({ threadId: 'session-1', objective: 'Ship the feature' })
    advance(500)

    const withUsage = store.recordCompletedTurn('session-1', {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
    }, 1_500)
    expect(withUsage).toMatchObject({ tokensUsed: 19, timeUsedSeconds: 1.5, status: 'active' })

    expect(store.applySessionStatus('session-1', 'completed')).toMatchObject({ status: 'complete' })
    expect(store.applySessionStatus('session-1', 'idle')).toBeNull()
    expect(store.get('session-1')?.status).toBe('complete')
    expect(store.applySessionStatus('session-1', 'running')).toMatchObject({ status: 'active' })
    expect(store.applySessionStatus('session-1', 'interrupted')).toMatchObject({ status: 'paused' })
  })

  test('refreshes and creates through the Claude-scoped goal API', async () => {
    // WHY: desktop, web, and mobile all share GoalSync, so provider routing must
    // not silently keep Claude on the old Codex-only refresh path.
    const session = {
      run: {
        provider: 'claude-code',
      } as Session['run'],
      agentSessionId: 'session-1',
      goal: null,
    } as Session
    const providers: string[] = []
    const sync = new GoalSync({
      sessionById: () => session,
      apiForSession: () => ({
        getThreadGoal: async (_threadId, _ctx, provider) => {
          providers.push(provider ?? '')
          return null
        },
        setThreadGoal: async (request, _ctx, provider) => {
          providers.push(provider ?? '')
          return { threadId: request.threadId, objective: request.objective ?? '', status: 'active' }
        },
        clearThreadGoal: async () => false,
      }),
      ctxForSession: () => ({}) as never,
    })

    await sync.refresh('session-1')
    await sync.create('session-1', 'Ship the feature')

    expect(providers).toEqual(['claude-code', 'claude-code'])
    expect(session.goal?.objective).toBe('Ship the feature')
    expect(() => sync.set('session-1', { objective: 'Replace it' })).toThrow(
      'This session has no active Codex thread',
    )
  })
})
