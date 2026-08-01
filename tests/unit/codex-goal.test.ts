import { describe, expect, test } from 'bun:test'
import { normalizeThreadGoal } from '../../src/main/agents/codex/codex-event-normalizer'
import { codexSlashCommands } from '../../src/renderer/components/input/slash-commands'
import { GoalSync } from '../../src/renderer/contexts/workspace/goal-sync'
import type { Session, ThreadGoal } from '../../src/shared/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function goal(objective: string, status: ThreadGoal['status'] = 'active'): ThreadGoal {
  return { threadId: 'thread-1', objective, status }
}

function goalSync(api: {
  getThreadGoal?: () => Promise<ThreadGoal | null>
  setThreadGoal?: (request: { objective?: string }) => Promise<ThreadGoal>
  clearThreadGoal?: () => Promise<boolean>
}) {
  const session = {
    provider: 'codex',
    agentSessionId: 'thread-1',
    goal: goal('Original'),
  } as Session
  const sync = new GoalSync({
    sessionFor: () => session,
    apiFor: () => ({
      getThreadGoal: api.getThreadGoal ?? (async () => session.goal ?? null),
      setThreadGoal: api.setThreadGoal ?? (async (request) => goal(request.objective ?? 'Original')),
      clearThreadGoal: api.clearThreadGoal ?? (async () => true),
    }) as any,
    ctxFor: () => ({}) as any,
  })
  return { session, sync }
}

describe('Codex goals', () => {
  test('manually exposes /goal only where provider discovery cannot supply it', () => {
    // WHY: app-server skills discovery omits Codex TUI built-ins. Claude reports
    // its command itself, so manually adding it there would duplicate the row.
    expect(codexSlashCommands('codex', true).map((command) => command.command)).toEqual(['/goal'])
    expect(codexSlashCommands('claude-code', true)).toEqual([])
    expect(codexSlashCommands('codex', false)).toEqual([])
  })

  test('preserves the paused backend state used by goal controls', () => {
    // WHY: dropping this generated app-server status makes pause look like the
    // goal disappeared when the update notification reaches the renderer.
    expect(normalizeThreadGoal({
      threadId: 'thread-1',
      objective: 'Ship the feature',
      status: 'paused',
      tokensUsed: 120,
    })).toEqual({
      threadId: 'thread-1',
      objective: 'Ship the feature',
      status: 'paused',
      tokenBudget: undefined,
      tokensUsed: 120,
      timeUsedSeconds: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    })
  })

  test('does not let a slow refresh overwrite a newer goal update', async () => {
    // WHY: reconnect and `/goal` refreshes can overlap a mid-session edit; the
    // command response is newer even when the earlier read resolves last.
    const read = deferred<ThreadGoal | null>()
    const { session, sync } = goalSync({
      getThreadGoal: () => read.promise,
      setThreadGoal: async () => goal('Replacement'),
    })

    const refreshing = sync.refresh('tab-1')
    await sync.set('tab-1', { objective: 'Replacement', status: 'active' })
    read.resolve(goal('Original'))
    await refreshing

    expect(session.goal).toEqual(goal('Replacement'))
  })

  test('does not let a slow refresh restore a cleared goal', async () => {
    // WHY: a goal cleared while a reconnect read is in flight must stay cleared.
    const read = deferred<ThreadGoal | null>()
    const { session, sync } = goalSync({
      getThreadGoal: () => read.promise,
      clearThreadGoal: async () => true,
    })

    const refreshing = sync.refresh('tab-1')
    await sync.clear('tab-1')
    read.resolve(goal('Original'))
    await refreshing

    expect(session.goal).toBeNull()
  })

  test('serializes overlapping goal mutations in submission order', async () => {
    // WHY: the slash command and project panel are separate entry points and can
    // otherwise race app-server responses for the same persisted thread goal.
    const first = deferred<ThreadGoal>()
    const objectives: Array<string | undefined> = []
    const { session, sync } = goalSync({
      setThreadGoal: async (request) => {
        objectives.push(request.objective)
        return request.objective === 'First' ? first.promise : goal(request.objective ?? '')
      },
    })

    const firstUpdate = sync.set('tab-1', { objective: 'First' })
    const secondUpdate = sync.set('tab-1', { objective: 'Second' })
    await Promise.resolve()
    expect(objectives).toEqual(['First'])

    first.resolve(goal('First'))
    await firstUpdate
    await secondUpdate

    expect(objectives).toEqual(['First', 'Second'])
    expect(session.goal).toEqual(goal('Second'))
  })

  test('refreshes authoritative state when clear reports that nothing was cleared', async () => {
    // WHY: `cleared: false` is not proof that the renderer's snapshot is null.
    const persisted = goal('Persisted', 'complete')
    const { session, sync } = goalSync({
      clearThreadGoal: async () => false,
      getThreadGoal: async () => persisted,
    })

    await sync.clear('tab-1')

    expect(session.goal).toEqual(persisted)
  })

  test('provider notifications invalidate older reads', async () => {
    // WHY: goal completion is pushed independently of renderer RPC responses.
    const read = deferred<ThreadGoal | null>()
    const { session, sync } = goalSync({ getThreadGoal: () => read.promise })
    const refreshing = sync.refresh('tab-1')

    sync.applyUpdated('tab-1', goal('Original', 'complete'))
    read.resolve(goal('Original', 'active'))
    await refreshing

    expect(session.goal).toEqual(goal('Original', 'complete'))
  })
})
