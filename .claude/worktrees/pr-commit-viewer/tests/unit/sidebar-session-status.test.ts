import { describe, expect, test } from 'bun:test'
import { SidebarSessionStatusFeed } from '../../src/renderer/components/session/lib/sidebar-session-status'

describe('sidebar session status feed', () => {
  test('uses the provider session id for a tool-created unmounted session', () => {
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
    expect(feed.stateFor('studio', 'solus-session')).toBeNull()
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
})
