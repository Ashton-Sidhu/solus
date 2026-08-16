import { SvelteMap } from 'svelte/reactivity'
import type { AgentId, IpcContext, SessionMeta, SessionStatus } from '../../../shared/types'
import { serverConnections } from '@client-core/server-connections'
import { onServerRemoving } from '@client-core/server-registry'
import { sessionSnapshotCache } from '@client-core/session-snapshot-cache'
import type { DomainSyncState } from '@client-core/freshness'
import {
  HistorySessionOrder,
  SessionHistoryLoader,
  type SessionHistoryLoaderOptions,
  type SessionHistorySource,
} from '../../lib/sessionPickerHistory'

// Forgetting a host is total: its last-known session snapshot leaves with it.
onServerRemoving((server) => sessionSnapshotCache.forgetHost(server.id))

interface SessionHistoryStoreLoadOptions {
  sources: SessionHistorySource[]
  deferredSources?: Promise<SessionHistorySource[]> | Array<Promise<SessionHistorySource[]>>
  ctx: IpcContext
  scopeKey?: string
  onBatch?: (sessions: SessionMeta[]) => void
  limitPerProvider?: number
}

export function updateSessionHistoryStatus(
  sessions: SessionMeta[],
  serverId: string,
  sessionId: string,
  status: SessionStatus,
): void {
  const session = sessions.find(
    (candidate) =>
      candidate.serverId === serverId && candidate.sessionId === sessionId,
  )
  if (session) session.status = status
}

function defaultHistoryLoaderOptions(): SessionHistoryLoaderOptions {
  return {
    // Every source names its host — there is no primary fallback to inherit.
    hostFor: (serverId) => {
      const resolvedServerId = serverConnections.resolveId(serverId)
      return {
        serverId: resolvedServerId,
        listSessions: serverConnections.apiFor(resolvedServerId).listSessions,
        onSessionScan: (listener) =>
          serverConnections.eventsFor(resolvedServerId).subscribe('session.scanProgressed', listener),
      }
    },
    snapshotCache: sessionSnapshotCache,
  }
}

export class SessionHistoryStore {
  sessions = $state<SessionMeta[]>([])
  loading = $state(false)
  /** The freshness ladder per host in the current scope. A spinner may only
   *  claim `synchronizing`; an offline host's rows render under `cached`. */
  hostStates = new SvelteMap<string, DomainSyncState>()

  #order = new HistorySessionOrder()
  #loader: SessionHistoryLoader
  #loadSeq = 0
  #scopeKey: string | null = null

  constructor(options: SessionHistoryLoaderOptions = defaultHistoryLoaderOptions()) {
    this.#loader = new SessionHistoryLoader(options)
  }

  cancel(options: { clear?: boolean } = {}): void {
    this.#loadSeq++
    this.#loader.cancel()
    this.loading = false
    this.#scopeKey = null
    if (options.clear) {
      this.hostStates.clear()
      this.clear()
    }
  }

  clear(): void {
    this.#replaceAll([])
  }

  /** Fold a scan batch into the list, newest first and one row per session. */
  merge(sessions: SessionMeta[]): void {
    this.#order.insert(this.sessions, sessions)
  }

  /** Keep an unmounted session's picker row live without rebuilding history. */
  updateStatus(serverId: string, sessionId: string, status: SessionStatus): void {
    updateSessionHistoryStatus(this.sessions, serverId, sessionId, status)
  }

  async load({
    sources,
    deferredSources,
    ctx,
    scopeKey,
    onBatch,
    limitPerProvider,
  }: SessionHistoryStoreLoadOptions): Promise<SessionMeta[]> {
    const seq = ++this.#loadSeq
    this.#scopeKey = scopeKey ?? null
    this.loading = true
    this.hostStates.clear()

    try {
      const sessions = await this.#loader.load({
        sources,
        deferredSources,
        ctx,
        limitPerProvider,
        onBatch: (batch) => {
          if (!this.#isCurrent(seq, scopeKey)) return
          this.merge(batch)
          onBatch?.(this.sessions)
        },
        onHostState: (serverId, state) => {
          if (!this.#isCurrent(seq, scopeKey)) return
          this.hostStates.set(serverId, state)
        },
      })
      if (!this.#isCurrent(seq, scopeKey)) return []
      // The request's own result is authoritative: it is the only thing that
      // can drop a row the stream already showed (a deleted session), so it
      // replaces the list rather than merging into it.
      this.#replaceAll(sessions)
      return sessions
    } catch {
      if (this.#isCurrent(seq, scopeKey)) this.clear()
      return []
    } finally {
      if (this.#isCurrent(seq, scopeKey)) this.loading = false
    }
  }

  async findSession(
    sessionId: string,
    source: { projectPath: string; provider?: AgentId; serverId: string },
    ctx: IpcContext,
  ): Promise<SessionMeta | null> {
    const sessions = await this.load({
      sources: [
        {
          id: source.projectPath,
          projectPath: source.projectPath,
          provider: source.provider,
          serverId: source.serverId,
        },
      ],
      ctx,
      scopeKey: `find:${source.provider ?? 'any'}:${source.projectPath}:${sessionId}`,
    })
    return sessions.find((meta) => meta.sessionId === sessionId) ?? null
  }

  /** Take an already-ordered list wholesale. */
  #replaceAll(sessions: SessionMeta[]): void {
    this.sessions = sessions
    this.#order.reset(sessions)
  }

  #isCurrent(seq: number, scopeKey: string | undefined): boolean {
    return (
      seq === this.#loadSeq &&
      (scopeKey === undefined || scopeKey === this.#scopeKey)
    )
  }
}

export function createSessionHistoryStore(
  options?: SessionHistoryLoaderOptions,
): SessionHistoryStore {
  return new SessionHistoryStore(options)
}
