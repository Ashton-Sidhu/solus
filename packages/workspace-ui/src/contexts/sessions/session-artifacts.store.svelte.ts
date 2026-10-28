import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { allSessionArtifacts, type SessionArtifacts } from '@solus/contracts/session-artifacts'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { keepEqual } from '@solus/client-core/keep-equal'
import { listsSession, newestAddedKey } from './session-artifacts'

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
 * `session.artifactsChanged` that names it or one of the sessions it started.
 * A read that a newer read overtook, or that answered from a connection since
 * replaced, is dropped.
 */
export class SessionArtifactsStore {
  private readonly lists = new SvelteMap<string, SessionArtifacts>()
  /** The last change a read after the first one saw, by session. */
  private readonly changes = new SvelteMap<string, SessionArtifactsChange>()
  /** Sessions whose last read failed. */
  private readonly failures = new SvelteSet<string>()
  /** The host each session asked for is read from. */
  private readonly serverIds = new Map<string, string>()
  private readonly reads = new Map<string, number>()
  private readonly listeners = new Set<(change: SessionArtifactsChange) => void>()
  private stopWatching: (() => void) | null = null

  /** Read a session once; later changes arrive as events. */
  ensure(serverId: string, sessionId: string): void {
    this.watch()
    const known = this.serverIds.get(sessionId)
    this.serverIds.set(sessionId, serverId)
    if (known !== serverId || (!this.lists.has(sessionId) && !this.reads.has(sessionId))) void this.refresh(sessionId)
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
    void this.refresh(sessionId)
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
    this.stopWatching = subscribeAllHosts('session.artifactsChanged', (_serverId, { sessionId }) => {
      for (const owner of this.serverIds.keys()) {
        if (listsSession(owner, this.lists.get(owner), sessionId)) void this.refresh(owner)
      }
    })
  }

  private async refresh(sessionId: string): Promise<void> {
    const serverId = this.serverIds.get(sessionId)
    if (!serverId) return
    const read = (this.reads.get(sessionId) ?? 0) + 1
    this.reads.set(sessionId, read)
    const api = serverConnections.apiFor(serverId)
    const next = await api.sessionArtifactsList(sessionId).catch(() => null)
    if (this.reads.get(sessionId) !== read || serverConnections.apiFor(serverId) !== api) return
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
