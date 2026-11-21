import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { allSessionArtifacts, type SessionArtifacts } from '@solus/contracts/session-artifacts'
import type { SessionPullRequestLink, SessionPullRequestWatchOutcome } from '@solus/contracts/session-pull-requests'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { keepEqual } from '@solus/client-core/keep-equal'
import { FollowedSessions } from './followed-sessions'
import { listsSession, listsWork, newestAddedKey } from './session-artifacts'

/** What one read of a session's artifacts changed. */
export interface SessionArtifactsChange {
  sessionId: string
  /** The count before this read; null for the first read of the session. */
  previousCount: number | null
  count: number
  /** The newest artifact this read added, or null. */
  newestKey: string | null
  /** When the client saw the change. */
  seenAt: number
}

/**
 * What each session produced or linked (docs/plans/session-artifacts.md), by
 * Solus session id. A surface asks for a session with `ensure`; the store reads
 * it from the host that runs it and reads it again on every
 * `session.artifactsChanged` that names it or one of the sessions it started,
 * and on every `works.changed` for a work it lists, whose pin, time, and
 * preview the Threads row shows.
 */
export class SessionArtifactsStore {
  private readonly lists = new SvelteMap<string, SessionArtifacts>()
  /** The last change a read after the first one saw, by session. */
  private readonly changes = new SvelteMap<string, SessionArtifactsChange>()
  /** Sessions whose last read failed. */
  private readonly failures = new SvelteSet<string>()
  private readonly sessions = new FollowedSessions<SessionArtifacts>({
    read: (api, sessionId) => api.sessionArtifactsList(sessionId),
    apply: (sessionId, next) => this.apply(sessionId, next),
    isLoaded: (sessionId) => this.lists.has(sessionId),
  })
  private readonly listeners = new Set<(change: SessionArtifactsChange) => void>()
  private stopWatching: (() => void)[] | null = null

  /** Read a session once; later changes arrive as events. */
  ensure(serverId: string, sessionId: string): void {
    this.watch()
    this.sessions.follow(serverId, sessionId)
  }

  artifactsFor(sessionId: string | null | undefined): SessionArtifacts | null {
    return sessionId ? this.lists.get(sessionId) ?? null : null
  }

  /** Whether the last read of a session failed. */
  hasFailed(sessionId: string | null | undefined): boolean {
    return !!sessionId && this.failures.has(sessionId)
  }

  /** Read a session again: the retry after a failed read. */
  reload(sessionId: string): void {
    void this.sessions.refresh(sessionId)
  }

  /**
   * Watch one of a session's pull requests, or stop (docs/plans/pr-watch.md).
   * A watch is a record of the host that runs the session, which is the host
   * this list is read from. Answers what the host did once the list shows it.
   */
  async setPullRequestWatch(link: Pick<SessionPullRequestLink, 'sessionId' | 'repository' | 'number'>, watching: boolean): Promise<SessionPullRequestWatchOutcome> {
    const outcome = await this.sessions.hostApiOf(link.sessionId).sessionPullRequestWatch(link.sessionId, link.repository, link.number, watching)
    await this.sessions.refresh(link.sessionId)
    return outcome
  }

  /** Whether the first read of a session has answered. */
  isLoaded(sessionId: string | null | undefined): boolean {
    return !!sessionId && this.lists.has(sessionId)
  }

  countFor(sessionId: string | null | undefined): number {
    const artifacts = this.artifactsFor(sessionId)
    return artifacts ? allSessionArtifacts(artifacts).length : 0
  }

  /** The last change seen after the first read, or null. */
  lastChangeFor(sessionId: string | null | undefined): SessionArtifactsChange | null {
    return sessionId ? this.changes.get(sessionId) ?? null : null
  }

  /** Hear every read, the first one with a null `previousCount`. */
  onChange(listener: (change: SessionArtifactsChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private watch(): void {
    if (this.stopWatching) return
    this.stopWatching = [
      subscribeAllHosts('session.artifactsChanged', (_serverId, { sessionId }) => {
        for (const owner of this.sessions.sessionIds()) {
          if (listsSession(owner, this.lists.get(owner), sessionId)) void this.sessions.refresh(owner)
        }
      }),
      subscribeAllHosts('works.changed', (_serverId, { workId }) => {
        for (const owner of this.sessions.sessionIds()) {
          if (listsWork(this.lists.get(owner), workId)) void this.sessions.refresh(owner)
        }
      }),
    ]
  }

  private apply(sessionId: string, next: SessionArtifacts | null): void {
    if (!next) {
      this.failures.add(sessionId)
      return
    }
    this.failures.delete(sessionId)
    const previous = this.lists.get(sessionId)
    const kept = previous ? keepEqual(next, previous) : next
    if (kept === previous) return
    this.lists.set(sessionId, kept)
    const change: SessionArtifactsChange = {
      sessionId,
      previousCount: previous ? allSessionArtifacts(previous).length : null,
      count: allSessionArtifacts(kept).length,
      newestKey: previous ? newestAddedKey(previous, kept) : null,
      seenAt: Date.now(),
    }
    if (previous) this.changes.set(sessionId, change)
    for (const listener of this.listeners) listener(change)
  }
}

export const sessionArtifactsStore = new SessionArtifactsStore()
