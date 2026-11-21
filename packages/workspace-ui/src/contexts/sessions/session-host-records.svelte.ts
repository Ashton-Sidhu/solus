import { SvelteMap } from 'svelte/reactivity'
import type { BackgroundKind, BackgroundRecord, SessionRecordTopic } from '@solus/client-core/background-item'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { keepEqual, upsertById } from '@solus/client-core/keep-equal'
import { FollowedSessions } from './followed-sessions'

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
  /** The followed sessions; a row command reaches a session's host with `hostApiOf`. */
  protected readonly sessions: FollowedSessions<T[]>
  private isWatching = false

  constructor(private readonly kind: BackgroundKind<T, Topic>) {
    this.sessions = new FollowedSessions({
      read: (api, sessionId) => kind.list(api, sessionId),
      // An older host has no such method: no row, as for a session without these records.
      apply: (sessionId, next) => {
        if (!next) return
        const previous = this.lists.get(sessionId)
        const kept = previous ? keepEqual(next, previous) : next
        if (kept !== previous) this.lists.set(sessionId, kept)
      },
      isLoaded: (sessionId) => this.lists.has(sessionId),
      drop: (sessionId) => this.lists.delete(sessionId),
    })
  }

  follow(serverId: string, sessionId: string): void {
    this.watch()
    this.sessions.follow(serverId, sessionId)
  }

  recordsOf(sessionId: string | null | undefined): readonly T[] {
    return (sessionId && this.lists.get(sessionId)) || NO_RECORDS
  }

  private watch(): void {
    if (this.isWatching) return
    this.isWatching = true
    subscribeAllHosts(this.kind.topic, (serverId, event) => {
      if (this.sessions.serverIdOf(event.sessionId) !== serverId) return
      const list = this.lists.get(event.sessionId)
      // A list not read yet is read whole, with this change in it.
      if (!list) return void this.sessions.refresh(event.sessionId)
      this.lists.set(event.sessionId, upsertById(list, this.kind.recordOf(event)))
    })
  }
}

const NO_RECORDS: readonly never[] = []
