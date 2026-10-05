import { attentionEntryKey, isNotifiableAttentionEntry } from '@solus/contracts/notification-types'
import type { AttentionEntry, AttentionKind } from '@solus/contracts/attention-types'

const DESKTOP_BADGE_KINDS = new Set<AttentionKind>(['needs_approval', 'question'])

export interface DesktopAttentionSnapshot {
  created: AttentionEntry[]
  nextKeys: Set<string>
  badgeCount: number
}

interface AttentionDiff {
  created: AttentionEntry[]
  nextKeys: Set<string>
}

function diffNewAttentionEntries(
  previousKeys: ReadonlySet<string>,
  entries: AttentionEntry[],
): AttentionDiff {
  const nextKeys = new Set<string>()
  const created: AttentionEntry[] = []

  for (const entry of entries) {
    const key = attentionEntryKey(entry)
    nextKeys.add(key)

    // Finished entries are useful in the attention inbox but too noisy for a notification.
    if (!isNotifiableAttentionEntry(entry)) continue
    if (!previousKeys.has(key)) created.push(entry)
  }

  return { created, nextKeys }
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
  const { created, nextKeys } = diffNewAttentionEntries(previousKeys, entries)
  return {
    created,
    nextKeys,
    badgeCount: countDesktopAttentionEntries(entries, isActive),
  }
}
