import { describe, expect, test } from 'bun:test'
import type { RateLimitInfo, Session, SessionStatus, Tab } from '@solus/contracts/types'
import {
  attentionLabel,
  getAttentionIcon,
  getAttentionState,
  getStatusGroupKey,
  sessionLimitResetsAt,
} from '@solus/workspace-ui/lib/sessionUtils'
import { SidebarSessionStatusFeed } from '@solus/workspace-ui/components/session/lib/sidebar-session-status'
import { resolveSidebarRowMark, taskStatusFor } from '@solus/workspace-ui/components/session/lib/task-list'
import { limitResetSnoozeUntil } from '@solus/workspace-ui/components/session/lib/task-snooze'

const NOW = Date.parse('2026-10-03T12:00:00')
const RESET_MS = Date.parse('2026-10-03T15:40:00')

function limitedSession(resetsAtSeconds: number | null, status: SessionStatus = 'rate_limited'): Session {
  const rateLimitInfo: RateLimitInfo = {
    resetsAt: resetsAtSeconds,
    rateLimitType: 'five_hour',
    prompt: 'go on',
    queuedPrompt: '',
  }
  return {
    status,
    rateLimitInfo,
    permissionQueue: [],
    questionQueue: [],
    messages: [],
  } as unknown as Session
}

const tab = { hasUnread: false } as Tab

describe('rate-limited attention', () => {
  test('a rate-limited session is limited, not queued', () => {
    // WHY: the provider holds this turn. It must not read like a prompt that
    // waits in the queue, or the user cannot tell the two apart.
    const session = limitedSession(RESET_MS / 1000)
    expect(getAttentionState(session, tab)).toBe('limited')
    expect(getStatusGroupKey(session, tab)).toBe('rate-limited')
    expect(taskStatusFor('limited')).toBe('limit')
  })

  test('a session with no tab reads limited from the host status feed', () => {
    const feed = new SidebarSessionStatusFeed()
    feed.apply('host', { sessionId: 's1', agentSessionId: null, status: 'rate_limited', at: NOW })
    expect(feed.stateFor('host', 's1')?.attention).toBe('limited')
  })

  test('limited has its own mark, apart from a request for the user', () => {
    const limited = getAttentionIcon('limited')
    const awaiting = getAttentionIcon('awaiting')
    expect(limited).not.toBeNull()
    expect(limited?.component).not.toBe(awaiting?.component)
    expect(limited?.color).not.toBe(awaiting?.color)
  })

  test('the working clock does not count while the session is limited', () => {
    // WHY: a limited turn does no work, so the row must not report elapsed time.
    const mark = resolveSidebarRowMark({
      status: taskStatusFor('limited'),
      unread: false,
      woke: false,
      reviewGuide: null,
      lifecycle: 'active',
      runStartedAt: NOW - 60_000,
      manyRunning: false,
      completedAt: 0,
      snoozedUntil: 0,
      now: NOW,
    })
    expect(mark?.kind).toBe('glyph')
  })

  test('the label says when the limit resets only when the provider said so', () => {
    expect(attentionLabel('limited')).toBe('rate limited')
    expect(attentionLabel('limited', null)).toBe('rate limited')
    expect(attentionLabel('limited', RESET_MS)).toStartWith('rate limited, resets ')
  })

  test('the reset time comes from the provider, in milliseconds, and only while limited', () => {
    expect(sessionLimitResetsAt(limitedSession(RESET_MS / 1000))).toBe(RESET_MS)
    expect(sessionLimitResetsAt(limitedSession(null))).toBeNull()
    expect(sessionLimitResetsAt(limitedSession(RESET_MS / 1000, 'running'))).toBeNull()
  })
})

describe('snooze until the limit resets', () => {
  test('wakes the session at the reset time', () => {
    expect(limitResetSnoozeUntil(RESET_MS, NOW)).toBe(RESET_MS)
  })

  test('is not offered when the reset time is unknown', () => {
    // WHY: a reset time is never guessed.
    expect(limitResetSnoozeUntil(undefined, NOW)).toBeNull()
    expect(limitResetSnoozeUntil(null, NOW)).toBeNull()
    expect(limitResetSnoozeUntil(sessionLimitResetsAt(limitedSession(null)), NOW)).toBeNull()
  })

  test('is not offered once the window has reopened', () => {
    expect(limitResetSnoozeUntil(NOW - 1, NOW)).toBeNull()
  })
})
