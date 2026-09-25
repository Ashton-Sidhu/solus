import { isWatchEnded, type Watch } from '@solus/contracts/watch-types'
import { countdown } from '../../automations/lib/automation-format'

const STATUS_WORDS = {
  waiting: 'waiting',
  paused: 'paused',
  woken: 'woken',
  done: 'done',
  exhausted: 'out of wakes',
  expired: 'expired',
  cancelled: 'cancelled',
  failed: 'failed',
} satisfies Record<Watch['status'], string>

/** The card rail: state, wakes used, and when the next check runs. Counts and
 *  time only, so it stays one line. */
export function watchRail(watch: Watch, nowMs = Date.now()): string {
  const parts = [STATUS_WORDS[watch.status], `${watch.wakeCount}/${watch.maxWakes} wakes`]
  if (watch.status === 'waiting') {
    const left = countdown(watch.nextRunAt, nowMs)
    parts.push(left ? `next in ${left}` : 'checking')
  }
  return parts.join(' · ')
}

export function canPauseWatch(watch: Watch): boolean {
  return watch.status === 'waiting' || watch.status === 'woken'
}

export function canCancelWatch(watch: Watch): boolean {
  return !isWatchEnded(watch.status)
}
