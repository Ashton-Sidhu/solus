/**
 * What the notifications hub says, shared by the web and desktop page and the
 * native screen (plans/015-notifications-hub.md §6). Plain functions, no UI.
 */

import type { HubNotification, NotificationKind } from '@solus/contracts/notification-hub'
import type { HubSourceState } from './hub-client'

/** What happened, in a few words, for one row. */
export function notificationHeadline(notification: HubNotification): string {
  const facts = notification.facts
  switch (facts.kind) {
    case 'work.review_requested': return 'Review requested'
    case 'work.review_decided':
      return facts.decision === 'approved' ? 'Approved' : facts.decision === 'changes_requested' ? 'Changes requested' : 'Review comment'
    case 'task.assigned': return 'Assigned to you'
    case 'pr.assigned': return 'Pull request assigned'
    case 'pr.review_requested': return 'Pull request review requested'
    case 'automation.finished':
      return facts.status === 'succeeded' ? 'Automation finished' : facts.status === 'failed' ? 'Automation failed' : 'Automation cancelled'
    case 'review_job.finished': {
      const job = notification.resource.kind === 'review_job' && notification.resource.job === 'lens' ? 'Lens' : 'Guide'
      return facts.status === 'ready' ? `${job} ready` : `${job} failed`
    }
    case 'mention': return 'Mentioned you'
  }
}

/** A failure the row should say aloud, when its kind carries one. */
export function notificationError(notification: HubNotification): string | null {
  return notification.facts.kind === 'review_job.finished' ? notification.facts.error ?? null : null
}

export type NotificationKindGroup = 'reviews' | 'tasks' | 'pull-requests' | 'automations' | 'guides' | 'mentions'

/** The kind filter's choices: each names the kinds it shows. */
export const NOTIFICATION_KIND_GROUPS: readonly { value: NotificationKindGroup; label: string; kinds: readonly NotificationKind[] }[] = [
  { value: 'reviews', label: 'Work reviews', kinds: ['work.review_requested', 'work.review_decided'] },
  { value: 'tasks', label: 'Tasks', kinds: ['task.assigned'] },
  { value: 'pull-requests', label: 'Pull requests', kinds: ['pr.assigned', 'pr.review_requested'] },
  { value: 'automations', label: 'Automations', kinds: ['automation.finished'] },
  { value: 'guides', label: 'Guides and lenses', kinds: ['review_job.finished'] },
  { value: 'mentions', label: 'Mentions', kinds: ['mention'] },
]

export function kindsForGroups(groups: readonly NotificationKindGroup[]): NotificationKind[] {
  return NOTIFICATION_KIND_GROUPS.filter((group) => groups.includes(group.value)).flatMap((group) => group.kinds)
}

/**
 * The unread count as a label that does not overstate what is known: capped at
 * 99, and marked with `+` when a source has not answered.
 */
export function unreadCountLabel(count: { unread: number; isCapped: boolean; isComplete: boolean }): string | null {
  if (count.unread === 0 && count.isComplete) return null
  if (count.isCapped || count.unread > 99) return '99+'
  return count.isComplete ? String(count.unread) : `${count.unread}+`
}

/** Why a source shows no fresh rows, for the source strip. Null when it is fine. */
export function sourceStatusNote(state: HubSourceState): string | null {
  switch (state.status) {
    case 'ready': return null
    case 'loading': return 'Loading…'
    case 'offline': return 'Unreachable — showing what was loaded'
    case 'unsupported': return 'This host has no notifications yet. Update Solus on it.'
  }
}

/** Short relative time for a row: "now", "5m", "3h", "2d", else the date. */
export function notificationAge(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - createdAt) / 1000))
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`
  return new Date(createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Whether a loaded row's title, detail, or headline contains the query. Search reads only what is loaded. */
export function matchesNotificationQuery(notification: HubNotification, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [notification.summary.title, notification.summary.detail ?? '', notificationHeadline(notification)]
    .some((text) => text.toLowerCase().includes(needle))
}
