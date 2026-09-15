import { describe, expect, test } from 'bun:test'
import { AttentionNotificationTracker } from '@solus/workspace-ui/contexts/notifications/notifications-core'
import type { AttentionEntry } from '@solus/contracts/attention-types'

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

import { BackgroundActivityTracker } from '@solus/workspace-ui/contexts/notifications/notifications-core'

describe('background activity acknowledgement', () => {
  test('counts each host/session once across approval, question, failure and completion', () => {
    const tracker = new BackgroundActivityTracker()
    tracker.applySnapshot('a', [], () => false)
    tracker.applySnapshot('b', [], () => false)
    tracker.applySnapshot('a', [entry('same', 'needs_approval'), entry('same', 'question')], () => false)
    tracker.applySnapshot('b', [entry('same', 'failed'), entry('complete', 'finished')], () => false)
    expect(tracker.count).toBe(3)
    tracker.applySnapshot('a', [entry('same', 'finished')], () => false)
    expect(tracker.count).toBe(3)
  })

  test('focus clears only the client count; replay cannot recreate an acknowledged approval', () => {
    const tracker = new BackgroundActivityTracker()
    const pending = [entry('approval', 'needs_approval')]
    tracker.applySnapshot('a', [], () => false)
    tracker.applySnapshot('a', pending, () => false)
    tracker.acknowledge()
    expect(tracker.count).toBe(0)
    expect(pending[0]?.kind).toBe('needs_approval')
    expect(tracker.applySnapshot('a', pending, () => false)).toEqual([])
    expect(tracker.count).toBe(0)
    tracker.prepareForReconnect('a')
    expect(tracker.applySnapshot('a', pending, () => false)).toEqual([])
    expect(tracker.count).toBe(0)
    tracker.applySnapshot('a', [entry('approval', 'finished')], () => false)
    expect(tracker.count).toBe(1)
  })

  test('recovery is quiet, focused sessions are excluded, resolution and host removal clear counts', () => {
    const tracker = new BackgroundActivityTracker()
    expect(tracker.applySnapshot('a', [entry('old')], () => false)).toEqual([])
    expect(tracker.count).toBe(0)
    tracker.applySnapshot('a', [entry('focused')], () => true)
    expect(tracker.count).toBe(0)
    tracker.applySnapshot('a', [entry('new')], () => false)
    expect(tracker.count).toBe(1)
    tracker.applySnapshot('a', [], () => false)
    expect(tracker.count).toBe(0)
    tracker.applySnapshot('a', [entry('new')], () => false)
    tracker.dropHost('a')
    expect(tracker.count).toBe(0)
  })

  test('native notifications continue to exclude completions', () => {
    const tracker = new AttentionNotificationTracker()
    tracker.applySnapshot('a', [], () => false)
    expect(tracker.applySnapshot('a', [entry('done', 'finished')], () => false)).toEqual([])
  })
})
