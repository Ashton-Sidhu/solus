import { diffNewPushAttentionEntries } from './notifications/push-service'
import type { AttentionEntry, AttentionKind } from '../shared/attention-types'

const DESKTOP_BADGE_KINDS = new Set<AttentionKind>(['needs_approval', 'question'])

export interface DesktopAttentionSnapshot {
  created: AttentionEntry[]
  nextKeys: Set<string>
  badgeCount: number
}

export function countDesktopAttentionEntries(
  entries: AttentionEntry[],
  isActive: (entry: AttentionEntry) => boolean = () => true,
): number {
  let count = 0
  for (const entry of entries) {
    if (DESKTOP_BADGE_KINDS.has(entry.kind) && isActive(entry)) count += 1
  }
  return count
}

export function diffDesktopAttentionSnapshot(
  previousKeys: ReadonlySet<string>,
  entries: AttentionEntry[],
  isActive?: (entry: AttentionEntry) => boolean,
): DesktopAttentionSnapshot {
  const { created, nextKeys } = diffNewPushAttentionEntries(previousKeys, entries)
  return {
    created,
    nextKeys,
    badgeCount: countDesktopAttentionEntries(entries, isActive),
  }
}
