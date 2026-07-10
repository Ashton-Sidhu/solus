import { diffNewPushAttentionEntries } from './notifications/push-service'
import type { AttentionEntry, AttentionKind } from '../shared/attention-types'

const DESKTOP_NOTIFY_KINDS = new Set<AttentionKind>(['needs_approval', 'question', 'failed'])

export interface DesktopAttentionSnapshot {
  created: AttentionEntry[]
  nextKeys: Set<string>
  badgeCount: number
}

export function countDesktopAttentionEntries(entries: AttentionEntry[]): number {
  let count = 0
  for (const entry of entries) {
    if (DESKTOP_NOTIFY_KINDS.has(entry.kind)) count += 1
  }
  return count
}

export function diffDesktopAttentionSnapshot(
  previousKeys: ReadonlySet<string>,
  entries: AttentionEntry[],
): DesktopAttentionSnapshot {
  const { created, nextKeys } = diffNewPushAttentionEntries(previousKeys, entries)
  return {
    created,
    nextKeys,
    badgeCount: countDesktopAttentionEntries(entries),
  }
}
