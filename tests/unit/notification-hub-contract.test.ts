import { describe, expect, test } from 'bun:test'
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_PAGE_MAX,
  OTHER_PERSON_KINDS,
  notificationListRequestSchema,
  notificationResourceSchema,
  notificationSetArchivedSchema,
  notificationSetReadSchema,
} from '@solus/contracts/notification-hub'

// plans/015-notifications-hub.md v2 §4: a notification's resource is portable
// identity, never a path or a command; pages are bounded; a state write sets a
// fact rather than toggling it; and the kinds a person causes for someone else
// are the only ones suppressed for their own actions.

describe('notification hub contract', () => {
  test('a resource carries portable identity only', () => {
    expect(notificationResourceSchema.parse({ kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 4 }, cwd: '/Users/me/repo' }))
      .toEqual({ kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 4 } })
    expect(() => notificationResourceSchema.parse({ kind: 'command', run: 'rm -rf /' })).toThrow()
  })

  test('a page is bounded and defaults to the unarchived feed', () => {
    expect(notificationListRequestSchema.parse({})).toEqual({ filter: { view: 'all' }, limit: 50 })
    expect(() => notificationListRequestSchema.parse({ limit: NOTIFICATION_PAGE_MAX + 1 })).toThrow()
  })

  test('a state write names the fact it sets, never a toggle', () => {
    expect(() => notificationSetReadSchema.parse({ id: 'n1' })).toThrow()
    expect(notificationSetReadSchema.parse({ id: 'n1', read: false })).toEqual({ id: 'n1', read: false })
    expect(() => notificationSetArchivedSchema.parse({ id: 'n1', read: true })).toThrow()
  })

  test('results a person asked for still reach them; actions toward others do not echo back', () => {
    expect(OTHER_PERSON_KINDS.has('automation.finished')).toBe(false)
    expect(OTHER_PERSON_KINDS.has('review_job.finished')).toBe(false)
    expect(NOTIFICATION_KINDS.filter((kind) => !OTHER_PERSON_KINDS.has(kind))).toEqual(['automation.finished', 'review_job.finished'])
  })
})
