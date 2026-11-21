import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'

interface FollowedSessionsOptions<T> {
  /** One read of a session's records from the host that runs it. */
  read: (api: HostApi, sessionId: string) => Promise<T>
  /** The answer of a read that no newer read overtook; null when the read failed. */
  apply: (sessionId: string, next: T | null) => void
  /** Whether the store holds an answer for the session. */
  isLoaded: (sessionId: string) => boolean
  /**
   * Given, a session's records go while its host is not ready, so no row shows
   * a state the host may no longer have, and are read again when it is ready.
   */
  drop?: (sessionId: string) => void
}

/**
 * The sessions a per-session store follows, each on the host that runs it, by
 * Solus session id; and the reads of their records from that host. A read
 * that a newer read overtook, or that answered from a connection since
 * replaced, is dropped.
 */
export class FollowedSessions<T> {
  private readonly serverIds = new Map<string, string>()
  private readonly reads = new Map<string, number>()
  private isWatchingReadiness = false

  constructor(private readonly options: FollowedSessionsOptions<T>) {}

  /** Follow a session on its host: read it the first time, and again when it moved to another host. */
  follow(serverId: string, sessionId: string): void {
    this.watchReadiness()
    const known = this.serverIds.get(sessionId)
    this.serverIds.set(sessionId, serverId)
    if (known !== serverId || (!this.options.isLoaded(sessionId) && !this.reads.has(sessionId))) void this.refresh(sessionId)
  }

  serverIdOf(sessionId: string): string | undefined {
    return this.serverIds.get(sessionId)
  }

  sessionIds(): IterableIterator<string> {
    return this.serverIds.keys()
  }

  /** The host that runs a followed session, for a command on one of its records. */
  hostApiOf(sessionId: string): HostApi {
    const serverId = this.serverIds.get(sessionId)
    if (!serverId) throw new Error('This session is not shown here.')
    return serverConnections.apiFor(serverId)
  }

  async refresh(sessionId: string): Promise<void> {
    const serverId = this.serverIds.get(sessionId)
    if (!serverId) return
    const read = (this.reads.get(sessionId) ?? 0) + 1
    this.reads.set(sessionId, read)
    const api = serverConnections.apiFor(serverId)
    const next = await this.options.read(api, sessionId).catch(() => null)
    if (this.reads.get(sessionId) !== read || serverConnections.apiFor(serverId) !== api) return
    this.options.apply(sessionId, next)
  }

  private watchReadiness(): void {
    const { drop } = this.options
    if (!drop || this.isWatchingReadiness) return
    this.isWatchingReadiness = true
    serverConnections.onReadinessChange((serverId, status) => {
      for (const [sessionId, owner] of this.serverIds) {
        if (owner !== serverId) continue
        if (status === 'ready') void this.refresh(sessionId)
        else {
          drop(sessionId)
          this.reads.set(sessionId, (this.reads.get(sessionId) ?? 0) + 1)
        }
      }
    })
  }
}
