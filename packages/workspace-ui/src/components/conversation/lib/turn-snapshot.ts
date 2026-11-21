import type { TurnSnapshot } from '@solus/contracts/git-types'
import type { Turn } from './turns'

/**
 * The checkpoint a settled turn closed with, so its changed-files card stays
 * with that turn after the next prompt lands.
 *
 * Messages carry no trace id, so the join is by time: a snapshot is written
 * when its turn ends, which is after the turn's prompt and before the next
 * one. Only prompt-led turns own a snapshot; a divider or card between two
 * prompts does not split the window. When a turn ends more than once (a
 * retry), the last snapshot is the one that stands.
 *
 * With `latestOnly`, only the last prompt-led turn shows its card, so the card
 * steps aside when the next prompt lands.
 *
 * A turn diff of a session's cloud copy joins its turn the same way, by when the turn ended.
 */
export function turnSnapshotFor<Snapshot extends Pick<TurnSnapshot, 'timestamp'>>(
  turns: readonly Turn[],
  index: number,
  snapshots: readonly Snapshot[],
  latestOnly = false,
): Snapshot | undefined {
  const turn = turns[index]
  if (!turn || turn.live || turn.lead?.kind !== 'user') return undefined
  let nextStart = Infinity
  for (let i = index + 1; i < turns.length; i++) {
    if (turns[i].lead?.kind === 'user') {
      nextStart = turns[i].startedAt
      break
    }
  }
  if (latestOnly && nextStart !== Infinity) return undefined
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const snapshot = snapshots[i]
    if (snapshot.timestamp >= turn.startedAt && snapshot.timestamp < nextStart) return snapshot
  }
  return undefined
}
