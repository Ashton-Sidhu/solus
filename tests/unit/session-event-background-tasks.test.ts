import { describe, expect, test } from 'bun:test'
import { proxy } from 'svelte/internal/client'
import type { Session } from '@solus/contracts/types'
import { SessionEventReducer, type SessionEventReducerDeps } from '@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte'

// The session lives in `$state`, so the reducer writes through a Svelte proxy.
// The first background task of a session creates its list: the task must land
// in the list that the background row reads, not in a copy the proxy dropped.

function fixture() {
  const session = proxy({
    status: 'running', run: { serverId: 'host-1', provider: 'claude-code' }, messages: [],
    outboundPrompts: [], currentTurnStartedAt: 1, permissionQueue: [], questionQueue: [], rateLimitInfo: null,
  }) as unknown as Session
  const reducer = new SessionEventReducer({
    registry: { tabIdsBySession: new Map() },
    sessions: { byId: { session } },
    settings: { rateLimitBehavior: 'ask' },
    workStreamTracker: { sweep: () => {} },
    isSessionVisible: () => true,
    publishSessionViewed: () => {},
    playNotificationIfHidden: () => {},
    log: () => {},
  } as unknown as SessionEventReducerDeps)
  return { session, reducer }
}

describe('background tasks of a session', () => {
  test('the first task stays in the list when a later task starts', () => {
    const { session, reducer } = fixture()
    reducer.apply('session', { type: 'background_task_started', taskId: 't1', kind: 'subagent' })
    reducer.apply('session', { type: 'background_task_started', taskId: 't2', kind: 'command' })

    expect(session.backgroundTasks?.map((task) => task.taskId)).toEqual(['t1', 't2'])
  })
})
