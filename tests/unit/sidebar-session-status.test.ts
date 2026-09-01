import { describe, expect, test } from 'bun:test'
import { SidebarSessionStatusFeed } from '@solus/workspace-ui/components/session/lib/sidebar-session-status'

describe('sidebar session status feed', () => {
  test('keeps provider and stable session aliases on one timer', () => {
    // WHY: create_session rows are keyed by the provider session id, while the
    // global event is addressed by a different Solus session id.
    const feed = new SidebarSessionStatusFeed()

    feed.apply('studio', {
      sessionId: 'solus-session',
      agentSessionId: 'provider-session',
      status: 'running',
      at: 1_000,
    })

    expect(feed.stateFor('studio', 'provider-session')).toEqual({
      attention: 'running',
      runStartedAt: 1_000,
    })
    expect(feed.stateFor('studio', 'solus-session')).toEqual({
      attention: 'running',
      runStartedAt: 1_000,
    })
  })

  test('keeps the same timer start across one busy turn and clears it on settlement', () => {
    // WHY: status changes within a turn must not reset the elapsed timer, and a
    // completed session must stop presenting itself as active.
    const feed = new SidebarSessionStatusFeed()
    const event = { sessionId: 'solus-session', agentSessionId: 'provider-session' }

    feed.apply('studio', { ...event, status: 'running', at: 1_000 })
    feed.apply('studio', { ...event, status: 'awaiting_input', at: 2_000 })
    feed.apply('studio', { ...event, status: 'running', at: 3_000 })
    expect(feed.stateFor('studio', 'provider-session')?.runStartedAt).toBe(1_000)

    feed.apply('studio', { ...event, status: 'completed', at: 4_000 })
    expect(feed.stateFor('studio', 'provider-session')).toBeNull()
    expect(feed.stateFor('studio', 'solus-session')).toBeNull()
  })

  test('clears a provider timer when a handoff settles the stable session', () => {
    // WHY: the provider id becomes null during a handoff. The stable id must
    // still stop the row that has just moved to the handoff identity.
    const feed = new SidebarSessionStatusFeed()
    feed.apply('studio', {
      sessionId: 'solus-session',
      agentSessionId: 'provider-session',
      status: 'running',
      at: 1_000,
    })
    feed.apply('studio', {
      sessionId: 'solus-session',
      agentSessionId: null,
      status: 'idle',
      at: 2_000,
    })

    expect(feed.stateFor('studio', 'solus-session')).toBeNull()
  })

  test('does not mix equal provider session ids from different hosts', () => {
    const feed = new SidebarSessionStatusFeed()

    feed.apply('studio', {
      sessionId: 'one',
      agentSessionId: 'provider-session',
      status: 'running',
      at: 1_000,
    })

    expect(feed.stateFor('laptop', 'provider-session')).toBeNull()
  })

  test('starts a new timer when a failed session runs again', () => {
    const feed = new SidebarSessionStatusFeed()
    const event = { sessionId: 'solus-session', agentSessionId: 'provider-session' }

    feed.apply('studio', { ...event, status: 'failed', at: 1_000 })
    feed.apply('studio', { ...event, status: 'running', at: 5_000 })

    expect(feed.stateFor('studio', 'provider-session')).toEqual({
      attention: 'running',
      runStartedAt: 5_000,
    })
  })

  test('clears every attention status when its tab closes', () => {
    // WHY: A task row summarizes its mounted tabs. Once a tab closes, none of
    // its unread, blocked, failed, or running attention may remain on the task.
    const feed = new SidebarSessionStatusFeed()
    const event = { sessionId: 'solus-session', agentSessionId: 'provider-session' }

    for (const status of ['awaiting_input', 'awaiting_plan', 'rate_limited', 'failed', 'running'] as const) {
      feed.apply('studio', { ...event, status, at: 1_000 })
      feed.clear('studio', ['solus-session', 'provider-session'])
      expect(feed.stateFor('studio', 'solus-session')).toBeNull()
      expect(feed.stateFor('studio', 'provider-session')).toBeNull()
    }
  })
})
