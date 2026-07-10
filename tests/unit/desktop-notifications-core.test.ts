import { describe, expect, test } from 'bun:test'
import { attentionEntryKey } from '../../src/main/notifications/push-service'
import { countDesktopAttentionEntries, diffDesktopAttentionSnapshot } from '../../src/main/desktop-notifications-core'
import type { AttentionEntry } from '../../src/shared/attention-types'

function entry(sessionId: string, kind: AttentionEntry['kind'], summary = 'Needs attention'): AttentionEntry {
  return { sessionId, kind, summary, since: 1000 }
}

describe('desktop attention notification core', () => {
  test('creates notifications only for newly created actionable attention entries', () => {
    let previous = new Set<string>([
      attentionEntryKey(entry('existing', 'needs_approval')),
      attentionEntryKey(entry('done', 'finished')),
    ])

    const first = diffDesktopAttentionSnapshot(previous, [
      entry('existing', 'needs_approval'),
      entry('done', 'finished'),
      entry('new-question', 'question'),
      entry('new-failed', 'failed'),
    ])

    expect(first.created.map((item) => `${item.sessionId}:${item.kind}`)).toEqual([
      'new-question:question',
      'new-failed:failed',
    ])
    expect(first.badgeCount).toBe(3)

    previous = first.nextKeys
    const resolved = diffDesktopAttentionSnapshot(previous, [
      entry('new-question', 'question'),
    ])
    expect(resolved.created).toEqual([])
    expect(resolved.badgeCount).toBe(1)

    const reappeared = diffDesktopAttentionSnapshot(resolved.nextKeys, [
      entry('existing', 'needs_approval'),
      entry('new-question', 'question'),
    ])
    expect(reappeared.created.map((item) => `${item.sessionId}:${item.kind}`)).toEqual([
      'existing:needs_approval',
    ])
    expect(reappeared.badgeCount).toBe(2)
  })

  test('badge count ignores finished entries', () => {
    expect(countDesktopAttentionEntries([
      entry('approval', 'needs_approval'),
      entry('question', 'question'),
      entry('failed', 'failed'),
      entry('finished', 'finished'),
    ])).toBe(3)
  })
})
