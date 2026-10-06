import { describe, expect, test } from 'bun:test'
import type { HubNotification } from '@solus/contracts/notification-hub'
import {
  kindsForGroups,
  matchesNotificationQuery,
  notificationHeadline,
  NOTIFICATION_KIND_GROUPS,
  sourceStatusNote,
  unreadCountLabel,
} from '@solus/client-core/notifications/presentation'
import { NOTIFICATION_KINDS } from '@solus/contracts/notification-hub'
import type { HubSourceState } from '@solus/client-core/notifications/hub-client'

// plans/015-notifications-hub.md v2 §6, stage 4: what the hub says. A count never
// claims more certainty than its sources gave; every kind is reachable through a
// filter; a source that cannot answer says why instead of looking empty; and a
// row's headline tells a failure from a success.

const row = (patch: Partial<HubNotification>): HubNotification => ({
  id: 'n', eventId: 'e', organizationId: 'local', facts: { kind: 'task.assigned' }, resource: { kind: 'task', taskId: 't' },
  by: { kind: 'system' }, createdAt: 1, summary: { title: 'Ship the API' }, readAt: null, archivedAt: null, ...patch,
})

describe('notification presentation', () => {
  test('a count is capped, and marked incomplete while a source has not answered', () => {
    expect(unreadCountLabel({ unread: 0, isCapped: false, isComplete: true })).toBeNull()
    expect(unreadCountLabel({ unread: 3, isCapped: false, isComplete: true })).toBe('3')
    expect(unreadCountLabel({ unread: 3, isCapped: false, isComplete: false })).toBe('3+')
    expect(unreadCountLabel({ unread: 0, isCapped: false, isComplete: false })).toBeNull()
    expect(unreadCountLabel({ unread: 100, isCapped: true, isComplete: true })).toBe('99+')
  })

  test('every kind belongs to exactly one filter group', () => {
    const grouped = NOTIFICATION_KIND_GROUPS.flatMap((group) => group.kinds)
    expect([...grouped].sort()).toEqual([...NOTIFICATION_KINDS].sort())
    expect(kindsForGroups(['pull-requests', 'mentions'])).toEqual(['pr.assigned', 'pr.review_requested', 'mention'])
    expect(kindsForGroups([])).toEqual([])
  })

  test('an unreachable or older source says why, rather than looking empty', () => {
    const state = (status: HubSourceState['status']): HubSourceState => ({
      source: { sourceId: 'host:vm', serverId: 'vm', kind: 'host', label: 'VM' }, status, count: null, hasMore: false, oldestLoadedAt: null,
    })
    expect(sourceStatusNote(state('ready'))).toBeNull()
    expect(sourceStatusNote(state('offline'))).toContain('Unreachable')
    expect(sourceStatusNote(state('unsupported'))).toContain('Update Solus')
  })

  test('a headline tells a failure from a success', () => {
    expect(notificationHeadline(row({ facts: { kind: 'automation.finished', status: 'failed' }, resource: { kind: 'automation', automationId: 'a', runId: 'r' } }))).toBe('Automation failed')
    expect(notificationHeadline(row({ facts: { kind: 'review_job.finished', status: 'ready' }, resource: { kind: 'review_job', job: 'lens', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 1 } } }))).toBe('Lens ready')
    expect(notificationHeadline(row({ facts: { kind: 'work.review_decided', decision: 'changes_requested' }, resource: { kind: 'work', workId: 'w' } }))).toBe('Changes requested')
  })

  test('search reads the title, the detail, and the headline', () => {
    expect(matchesNotificationQuery(row({}), 'api')).toBe(true)
    expect(matchesNotificationQuery(row({}), 'assigned')).toBe(true)
    expect(matchesNotificationQuery(row({ summary: { title: 'x', detail: 'acme/api#4' } }), '#4')).toBe(true)
    expect(matchesNotificationQuery(row({}), 'nothing')).toBe(false)
  })
})
