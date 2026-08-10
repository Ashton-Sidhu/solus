import { attentionEntryKey, isNotifiableAttentionEntry } from '../../../shared/notification-types'
import type { AttentionEntry } from '../../../shared/attention-types'

interface HostSnapshotState {
  keys: Set<string>
}

export interface AttentionNotificationCandidate {
  serverId: string
  entry: AttentionEntry
}

/** Pure snapshot reducer. A host's first snapshot is recovery state, not a new
 * transition, so it is seeded without producing notifications. */
export class AttentionNotificationTracker {
  private readonly hosts = new Map<string, HostSnapshotState>()
  private readonly delivered = new Set<string>()

  applySnapshot(
    serverId: string,
    entries: AttentionEntry[],
    isSessionFocused: (serverId: string, sessionId: string) => boolean,
  ): AttentionNotificationCandidate[] {
    const nextKeys = new Set(entries.map(attentionEntryKey))
    const previous = this.hosts.get(serverId)
    if (!previous) {
      this.hosts.set(serverId, { keys: nextKeys })
      for (const entry of entries) this.delivered.add(this.scopedKey(serverId, attentionEntryKey(entry)))
      return []
    }

    for (const key of previous.keys) {
      if (!nextKeys.has(key)) this.delivered.delete(this.scopedKey(serverId, key))
    }

    const created: AttentionNotificationCandidate[] = []
    for (const entry of entries) {
      const entryKey = attentionEntryKey(entry)
      if (previous.keys.has(entryKey) || !isNotifiableAttentionEntry(entry)) continue
      const scopedKey = this.scopedKey(serverId, entryKey)
      if (this.delivered.has(scopedKey)) continue
      this.delivered.add(scopedKey)
      if (!isSessionFocused(serverId, entry.sessionId)) created.push({ serverId, entry })
    }

    previous.keys = nextKeys
    return created
  }

  markPushDelivered(serverId: string, entryKey: string): void {
    this.delivered.add(this.scopedKey(serverId, entryKey))
  }

  prepareForReconnect(serverId: string): void {
    this.hosts.delete(serverId)
  }

  dropHost(serverId: string): void {
    this.hosts.delete(serverId)
    const prefix = `${serverId}:`
    for (const key of this.delivered) {
      if (key.startsWith(prefix)) this.delivered.delete(key)
    }
  }

  private scopedKey(serverId: string, entryKey: string): string {
    return `${serverId}:${entryKey}`
  }
}
