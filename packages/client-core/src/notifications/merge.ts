import type { HubNotification, NotificationFilter } from '@solus/contracts/notification-hub'

/** One notification as the hub holds it: the row and the source it came from. */
export interface HubRow {
  sourceId: string
  notification: HubNotification
}

/** The hub's key for one row: unique across sources, which may reuse ids. */
export function hubRowKey(sourceId: string, notificationId: string): string {
  return `${sourceId}\u0000${notificationId}`
}

/**
 * Display order: newest first, with a stable source and id tie-breaker. Clocks
 * of different sources differ, so this orders a screen, not causality.
 */
export function compareHubRows(a: HubRow, b: HubRow): number {
  return b.notification.createdAt - a.notification.createdAt
    || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)
    || (a.notification.id < b.notification.id ? 1 : a.notification.id > b.notification.id ? -1 : 0)
}

/**
 * The oldest instant every source has loaded through: a source with more pages
 * has not reported what is older than its oldest row. Rows older than this wait
 * until those sources load more, so the merged list never skips one.
 */
export function mergedHorizon(sources: Iterable<{ hasMore: boolean; oldestLoadedAt: number | null }>): number {
  let horizon = -Infinity
  for (const source of sources) {
    if (!source.hasMore || source.oldestLoadedAt === null) continue
    horizon = Math.max(horizon, source.oldestLoadedAt)
  }
  return horizon
}

export function matchesHubFilter(notification: HubNotification, filter: NotificationFilter): boolean {
  if (filter.kinds?.length && !filter.kinds.includes(notification.facts.kind)) return false
  if (filter.view === 'archived') return notification.archivedAt !== null
  if (notification.archivedAt !== null) return false
  return filter.view === 'all' || notification.readAt === null
}
