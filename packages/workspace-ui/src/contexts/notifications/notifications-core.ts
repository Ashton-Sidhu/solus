import { attentionEntryKey, isNotifiableAttentionEntry } from '@solus/contracts/notification-types'
import type { AttentionEntry } from '@solus/contracts/attention-types'

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
  constructor(private readonly includeFinished = false) {}
  private readonly hosts = new Map<string, HostSnapshotState>()

  applySnapshot(
    serverId: string,
    entries: AttentionEntry[],
    isSessionFocused: (serverId: string, sessionId: string) => boolean,
  ): AttentionNotificationCandidate[] {
    const nextKeys = new Set(entries.map(attentionEntryKey))
    const previous = this.hosts.get(serverId)
    if (!previous) {
      this.hosts.set(serverId, { keys: nextKeys })
      return []
    }

    const created: AttentionNotificationCandidate[] = []
    for (const entry of entries) {
      if (previous.keys.has(attentionEntryKey(entry)) || (!this.includeFinished && !isNotifiableAttentionEntry(entry))) continue
      if (!isSessionFocused(serverId, entry.sessionId)) created.push({ serverId, entry })
    }

    previous.keys = nextKeys
    return created
  }

  prepareForReconnect(serverId: string): void {
    this.hosts.delete(serverId)
  }

  dropHost(serverId: string): void {
    this.hosts.delete(serverId)
  }
}

/** Activity is a client acknowledgement count, independent of durable approvals. */
export class BackgroundActivityTracker {
  private readonly transitions = new AttentionNotificationTracker(true)
  private readonly sessions = new Map<string, Set<string>>()

  applySnapshot(serverId: string, entries: AttentionEntry[], isSessionFocused: (serverId: string, sessionId: string) => boolean): AttentionNotificationCandidate[] {
    const candidates = this.transitions.applySnapshot(serverId, entries, isSessionFocused)
    const pending = this.sessions.get(serverId) ?? new Set<string>()
    const active = new Set(entries.map((entry) => entry.sessionId))
    for (const sessionId of pending) if (!active.has(sessionId)) pending.delete(sessionId)
    for (const { entry } of candidates) pending.add(entry.sessionId)
    this.sessions.set(serverId, pending)
    return candidates
  }

  get sessionKeys(): string[] {
    const keys: string[] = []
    for (const [serverId, sessions] of this.sessions) {
      for (const sessionId of sessions) keys.push(JSON.stringify([serverId, sessionId]))
    }
    return keys
  }

  get count(): number {
    let count = 0
    for (const sessions of this.sessions.values()) count += sessions.size
    return count
  }

  acknowledge(): void { this.sessions.clear() }
  prepareForReconnect(serverId: string): void { this.transitions.prepareForReconnect(serverId) }
  dropHost(serverId: string): void {
    this.transitions.dropHost(serverId)
    this.sessions.delete(serverId)
  }
}
