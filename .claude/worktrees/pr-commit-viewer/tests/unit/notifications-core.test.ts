import { describe, expect, test } from 'bun:test'
import { AttentionNotificationTracker } from '../../src/renderer/contexts/notifications/notifications-core'
import type { AttentionEntry } from '../../src/shared/attention-types'

function entry(sessionId: string, kind: AttentionEntry['kind'] = 'question'): AttentionEntry {
  return { sessionId, kind, since: 1000, summary: 'Needs attention' }
}

describe('AttentionNotificationTracker', () => {
  test('seeds recovery state and fires once for each new actionable entry', () => {
    const tracker = new AttentionNotificationTracker()
    expect(tracker.applySnapshot('host-a', [entry('existing')], () => false)).toEqual([])

    expect(tracker.applySnapshot('host-a', [entry('existing'), entry('new')], () => false))
      .toEqual([{ serverId: 'host-a', entry: entry('new') }])
    expect(tracker.applySnapshot('host-a', [entry('existing'), entry('new')], () => false)).toEqual([])
  })

  test('seeds the first replay after reconnect without firing again', () => {
    const tracker = new AttentionNotificationTracker()
    tracker.applySnapshot('host-a', [], () => false)
    expect(tracker.applySnapshot('host-a', [entry('question')], () => false)).toHaveLength(1)

    tracker.prepareForReconnect('host-a')
    expect(tracker.applySnapshot('host-a', [entry('question')], () => false)).toEqual([])
  })

  test('suppresses a focused session and a push-delivered key', () => {
    const tracker = new AttentionNotificationTracker()
    tracker.applySnapshot('host-a', [], () => false)
    expect(tracker.applySnapshot('host-a', [entry('focused')], (_host, sessionId) => sessionId === 'focused'))
      .toEqual([])

    tracker.markPushDelivered('host-a', 'pushed:question')
    expect(tracker.applySnapshot('host-a', [entry('focused'), entry('pushed')], () => false)).toEqual([])
  })

  test('keeps identical session shapes isolated by host', () => {
    const tracker = new AttentionNotificationTracker()
    tracker.applySnapshot('host-a', [], () => false)
    tracker.applySnapshot('host-b', [], () => false)

    expect([
      ...tracker.applySnapshot('host-a', [entry('same-session')], () => false),
      ...tracker.applySnapshot('host-b', [entry('same-session')], () => false),
    ].map((candidate) => candidate.serverId)).toEqual(['host-a', 'host-b'])
  })
})
