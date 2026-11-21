import { SvelteMap } from 'svelte/reactivity'
import { upsertById, type BackgroundKind, type BackgroundRecord, type SessionRecordTopic } from '@solus/client-core/background-item'
import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'

/**
 * Each session's background records of one kind (docs/plans/mcp-first-class.md
 * §11.5, §12.5), by Solus session id. A conversation asks with `follow`; the
 * store reads the list from the host that runs the session, then follows the
 * kind's change event. While a host is not ready its lists are dropped, so no
 * row shows a state the host may no longer have; when it is ready again they
 * are read before a row shows.
 */
export class SessionHostRecords<T extends BackgroundRecord, Topic extends SessionRecordTopic> {
  private readonly lists = new SvelteMap<string, T[]>()
  private readonly serverIds = new Map<string, string>()
  private readonly reads = new Map<string, number>()
  private isWatching = false

  constructor(private readonly kind: BackgroundKind<T, Topic>) {}

  follow(serverId: string, sessionId: string): void {
    this.watch()
    const known = this.serverIds.get(sessionId)
    this.serverIds.set(sessionId, serverId)
    if (known !== serverId || (!this.lists.has(sessionId) && !this.reads.has(sessionId))) void this.refresh(sessionId)
  }

  recordsOf(sessionId: string | null | undefined): readonly T[] {
    return (sessionId && this.lists.get(sessionId)) || NO_RECORDS
  }

  /** The host that runs a followed session, for a command on one of its records. */
  hostApiOf(sessionId: string): HostApi {
    const serverId = this.serverIds.get(sessionId)
    if (!serverId) throw new Error('This session is not shown here.')
    return serverConnections.apiFor(serverId)
  }

  private watch(): void {
    if (this.isWatching) return
    this.isWatching = true
    subscribeAllHosts(this.kind.topic, (serverId, event) => {
      if (this.serverIds.get(event.sessionId) !== serverId) return
      const list = this.lists.get(event.sessionId)
      // A list not read yet is read whole, with this change in it.
      if (!list) return void this.refresh(event.sessionId)
      this.lists.set(event.sessionId, upsertById(list, this.kind.recordOf(event)))
    })
    serverConnections.onReadinessChange((serverId, status) => {
      for (const [sessionId, owner] of this.serverIds) {
        if (owner !== serverId) continue
        if (status === 'ready') void this.refresh(sessionId)
        else {
          this.lists.delete(sessionId)
          this.reads.set(sessionId, (this.reads.get(sessionId) ?? 0) + 1)
        }
      }
    })
  }

  private async refresh(sessionId: string): Promise<void> {
    const serverId = this.serverIds.get(sessionId)
    if (!serverId) return
    const read = (this.reads.get(sessionId) ?? 0) + 1
    this.reads.set(sessionId, read)
    const api = serverConnections.apiFor(serverId)
    // An older host has no such method: no row, as for a session without these records.
    const next = await this.kind.list(api, sessionId).catch(() => null)
    if (this.reads.get(sessionId) !== read || serverConnections.apiFor(serverId) !== api || !next) return
    this.lists.set(sessionId, next)
  }
}

const NO_RECORDS: readonly never[] = []
