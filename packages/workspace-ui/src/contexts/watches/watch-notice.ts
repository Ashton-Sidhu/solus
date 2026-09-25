import { isWatchEnded, type Watch } from '@solus/contracts/watch-types'

/** A watch that failed, ran out of wakes, or expired ended without its condition. */
export function watchEndedWithoutCondition(watch: Watch): boolean {
  return watch.status === 'failed' || watch.status === 'exhausted' || watch.status === 'expired'
}

/**
 * What to tell the person when a pushed change ends a watch, or null. A wake
 * already shows in its conversation and a person's own cancel needs no notice;
 * an end nobody sees otherwise does: a notify watch whose condition was met,
 * and a watch that ended without its condition.
 */
export function watchEndNotice(previous: Watch | undefined, next: Watch): string | null {
  if (previous && isWatchEnded(previous.status)) return null
  if (!isWatchEnded(next.status)) return null
  if (next.status === 'done' && next.onMatch === 'notify') return `Watch done: ${next.reason}`
  if (!watchEndedWithoutCondition(next)) return null
  return next.endReason ? `Watch ended: ${next.reason} — ${next.endReason}` : `Watch ended: ${next.reason}`
}
