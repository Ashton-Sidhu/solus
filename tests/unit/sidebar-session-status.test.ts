import { describe, expect, test } from 'bun:test'
import { SidebarSessionStatusFeed } from '@solus/workspace-ui/components/session/lib/sidebar-session-status'

describe('sidebar session status feed', () => {
  test('names a row by its session id, never by its provider thread', () => {
    // WHY: one session id (docs/plans/session-identity.md). A row with no tab
    // reads this feed by the session id its record and task link hold.
    const feed = new SidebarSessionStatusFeed()

    feed.apply('studio', { sessionId: 'solus-session', agentSessionId: 'provider-session', status: 'running', at: 1_000 })

    expect(feed.stateFor('studio', 'solus-session')).toEqual({ attention: 'running', runStartedAt: 1_000 })
    expect(feed.stateFor('studio', 'provider-session')).toBeNull()
  })

  test('a session with no tab still reports a background task after its turn ends', () => {
    // WHY: sidebar rows without a mounted tab read only this feed. A turn left
    // with a log tail running must not read as running, or as simply finished.
    const feed = new SidebarSessionStatusFeed()
    const event = { sessionId: 'solus-session', agentSessionId: 'provider-session' }

    feed.apply('studio', { ...event, status: 'running', at: 1_000 })
    feed.apply('studio', { ...event, status: 'background', at: 2_000 })
    expect(feed.stateFor('studio', 'solus-session')?.attention).toBe('background')

    feed.apply('studio', { ...event, status: 'completed', at: 3_000 })
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
    expect(feed.stateFor('studio', 'solus-session')?.runStartedAt).toBe(1_000)

    feed.apply('studio', { ...event, status: 'completed', at: 4_000 })
    expect(feed.stateFor('studio', 'solus-session')).toBeNull()
  })

  test('a provider switch keeps the row on its session', () => {
    // WHY: the thread goes away during a switch; the session id does not, so
    // the row that was running stops when the session settles.
    const feed = new SidebarSessionStatusFeed()
    feed.apply('studio', { sessionId: 'solus-session', agentSessionId: 'provider-session', status: 'running', at: 1_000 })
    feed.apply('studio', { sessionId: 'solus-session', agentSessionId: null, status: 'idle', at: 2_000 })

    expect(feed.stateFor('studio', 'solus-session')).toBeNull()
  })

  test('a waiting non-blocking question asks for input while running and after the run ends', () => {
    // WHY: a Codex message-mode question does not change the status. A row
    // with no tab must still say the person is needed, as an open tab does,
    // and stop saying so once the question is answered.
    const feed = new SidebarSessionStatusFeed()
    const event = { sessionId: 'solus-session', agentSessionId: 'provider-session' }

    feed.apply('studio', { ...event, status: 'running', at: 1_000, hasPendingQuestion: true })
    expect(feed.stateFor('studio', 'solus-session')?.attention).toBe('awaiting')

    feed.apply('studio', { ...event, status: 'completed', at: 2_000, hasPendingQuestion: true })
    expect(feed.stateFor('studio', 'solus-session')?.attention).toBe('awaiting')

    feed.apply('studio', { ...event, status: 'completed', at: 3_000 })
    expect(feed.stateFor('studio', 'solus-session')).toBeNull()
  })

  test('a list read after a reconnect brings in a question the events missed, and its answer', () => {
    // WHY: on a reconnect the client reads the session list again, but no
    // status event repeats. A question asked while it was away is only in the
    // record; so is its answer, if that came while it was away too.
    let clock = 0
    const feed = new SidebarSessionStatusFeed(() => clock)
    clock = 1
    feed.apply('studio', { sessionId: 'running-session', agentSessionId: null, status: 'running', at: 1_000 })

    clock = 2
    feed.adoptRecord('studio', { sessionId: 'running-session', status: 'running', hasPendingQuestion: true }, 2)
    feed.adoptRecord('studio', { sessionId: 'finished-session', status: 'idle', hasPendingQuestion: true }, 2)
    feed.adoptRecord('studio', { sessionId: 'quiet-session', status: 'idle' }, 2)
    expect(feed.stateFor('studio', 'running-session')).toEqual({ attention: 'awaiting', runStartedAt: 1_000 })
    expect(feed.stateFor('studio', 'finished-session')?.attention).toBe('awaiting')
    expect(feed.stateFor('studio', 'quiet-session')).toBeNull()

    clock = 3
    feed.adoptRecord('studio', { sessionId: 'running-session', status: 'running' }, 3)
    feed.adoptRecord('studio', { sessionId: 'finished-session', status: 'idle' }, 3)
    // The status it last heard stays: the record only knows running or not.
    expect(feed.stateFor('studio', 'running-session')).toEqual({ attention: 'running', runStartedAt: 1_000 })
    expect(feed.stateFor('studio', 'finished-session')).toBeNull()
  })

  test('a turn that ended while the client was away does not stay Working after the reconnect read', () => {
    // WHY: the completion event was sent while this client was disconnected.
    // Only the record read again on reconnect says the run is over.
    let clock = 0
    const feed = new SidebarSessionStatusFeed(() => clock)
    clock = 1
    feed.apply('studio', { sessionId: 'ended', agentSessionId: null, status: 'running', at: 1_000 })
    feed.apply('studio', { sessionId: 'ended-asking', agentSessionId: null, status: 'running', at: 1_000 })
    feed.apply('studio', { sessionId: 'background', agentSessionId: null, status: 'background', at: 1_000 })

    clock = 5
    feed.adoptRecord('studio', { sessionId: 'ended', status: 'idle' }, 5)
    feed.adoptRecord('studio', { sessionId: 'ended-asking', status: 'idle', hasPendingQuestion: true }, 5)
    feed.adoptRecord('studio', { sessionId: 'background', status: 'idle' }, 5)
    expect(feed.stateFor('studio', 'ended')).toBeNull()
    expect(feed.stateFor('studio', 'ended-asking')?.attention).toBe('awaiting')
    // A record lists a background turn as not running; the feed's own word stays.
    expect(feed.stateFor('studio', 'background')?.attention).toBe('background')
  })

  test('a live event heard after the reconnect read began wins over that read', () => {
    // WHY: a list read is in flight while events keep arriving. A record
    // read before a new turn started must not clear the row the event set.
    let clock = 0
    const feed = new SidebarSessionStatusFeed(() => clock)
    clock = 10
    const readStartedAt = clock
    clock = 11
    feed.apply('studio', { sessionId: 'restarted', agentSessionId: null, status: 'running', at: 2_000 })

    feed.adoptRecord('studio', { sessionId: 'restarted', status: 'idle' }, readStartedAt)
    expect(feed.stateFor('studio', 'restarted')).toEqual({ attention: 'running', runStartedAt: 2_000 })
    // A read that began after the event is newer and corrects it.
    clock = 12
    feed.adoptRecord('studio', { sessionId: 'restarted', status: 'idle' }, 12)
    expect(feed.stateFor('studio', 'restarted')).toBeNull()
  })

  test('does not mix equal session ids from different hosts', () => {
    const feed = new SidebarSessionStatusFeed()
    feed.apply('studio', { sessionId: 'one', agentSessionId: 'provider-session', status: 'running', at: 1_000 })
    expect(feed.stateFor('laptop', 'one')).toBeNull()
  })

  test('starts a new timer when a failed session runs again', () => {
    const feed = new SidebarSessionStatusFeed()
    const event = { sessionId: 'solus-session', agentSessionId: 'provider-session' }

    feed.apply('studio', { ...event, status: 'failed', at: 1_000 })
    feed.apply('studio', { ...event, status: 'running', at: 5_000 })

    expect(feed.stateFor('studio', 'solus-session')).toEqual({ attention: 'running', runStartedAt: 5_000 })
  })

  test('clears every attention status when its tab closes', () => {
    // WHY: A task row summarizes its mounted tabs. Once a tab closes, none of
    // its unread, blocked, failed, or running attention may remain on the task.
    const feed = new SidebarSessionStatusFeed()
    const event = { sessionId: 'solus-session', agentSessionId: 'provider-session' }

    for (const status of ['awaiting_input', 'awaiting_plan', 'rate_limited', 'failed', 'running'] as const) {
      feed.apply('studio', { ...event, status, at: 1_000 })
      feed.clear('studio', 'solus-session')
      expect(feed.stateFor('studio', 'solus-session')).toBeNull()
    }
  })
})
