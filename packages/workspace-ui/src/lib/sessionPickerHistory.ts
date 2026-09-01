import type { AgentId, IpcContext, SessionMeta, SessionScanEvent } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'
import { stampSessionMetas } from '@solus/client-core/session-meta'
import type { DomainSyncState, Freshness } from '@solus/client-core/freshness'
import type { SessionSnapshotCache } from '@solus/client-core/session-snapshot-cache'

export interface SessionHistorySource {
  id: string
  projectPath: string
  provider?: AgentId
  /** The host that holds this path. Every source names one. */
  serverId: string
  /** Logical repository this path is a checkout of, when known — persisted
   *  with the snapshot so an unreachable host's sources can be re-scoped. */
  repoKey?: string
  /** Render last-known rows without dialling the host: it is unreachable,
   *  and a scan would only wait on a socket that retries forever. */
  cachedOnly?: boolean
}

/** The slice of one host's RPC surface a history scan needs. Resolved per source
 *  so a host that owns no source is never dialled. */
export interface SessionHistoryHost {
  serverId: string
  listSessions: HostApi['listSessions']
  onSessionScan(listener: (event: SessionScanEvent) => void): () => void
}

export interface SessionHistoryLoaderOptions {
  hostFor(serverId: string): SessionHistoryHost
  /** Last-known rows per host. Absent means no cache: failures show nothing. */
  snapshotCache?: SessionSnapshotCache
}

export interface LoadHistoryOptions {
  sources: SessionHistorySource[]
  /** Sources that take a network round trip to discover. They join the same scan
   *  when they arrive, so finding a remote host never delays the local rows. */
  deferredSources?: Promise<SessionHistorySource[]> | Array<Promise<SessionHistorySource[]>>
  ctx: IpcContext
  onBatch: (sessions: SessionMeta[]) => void
  /** Freshness-ladder report per host, as each host's sources settle. */
  onHostState?: (serverId: string, state: DomainSyncState) => void
  limitPerProvider?: number
}

// Every host publishes scan progress to this client on one shared connection, so
// two loaders scanning at once must never mint the same stream id.
let scanStreamCounter = 0

function sessionMetaKey(meta: SessionMeta): string {
  // Two hosts can hold the same provider session id — the same repo, cloned
  // twice — and those are different sessions, not one to collapse.
  return `${meta.serverId ?? ''}:${meta.provider}:${meta.sessionId}`
}

export function sessionHistorySourcesFromRoots(roots: string[], serverId: string): SessionHistorySource[] {
  const sources = new Map<string, SessionHistorySource>()
  for (const root of roots) {
    const projectPath = root.trim()
    if (!projectPath || sources.has(projectPath)) continue
    sources.set(projectPath, { id: projectPath, projectPath, serverId })
  }
  return [...sources.values()]
}

/** The one sort key for history rows, newest first. A row whose timestamp will
 *  not parse sorts last instead of jumping to the top of the picker. */
function historySessionTimestamp(meta: SessionMeta): number {
  const timestamp = new Date(meta.lastTimestamp).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function sortedDedupedHistorySessions(sessions: SessionMeta[]): SessionMeta[] {
  const deduped = new Map<string, SessionMeta>()
  for (const meta of sessions) {
    const key = sessionMetaKey(meta)
    const existing = deduped.get(key)
    if (!existing || historySessionTimestamp(meta) > historySessionTimestamp(existing)) {
      deduped.set(key, meta)
    }
  }
  return [...deduped.values()].sort(
    (a, b) => historySessionTimestamp(b) - historySessionTimestamp(a),
  )
}

/**
 * Keeps a history list newest-first with one row per session while a scan
 * streams into it.
 *
 * A project with a few thousand sessions arrives in a hundred-odd batches. The
 * list they land in is reactive state that the picker's whole derived chain
 * reads, so rebuilding it per batch — re-sorting every row and handing the
 * renderer a new array each time — is the expensive way to fill it. This mirrors
 * the list's identities and sort keys, so each row can be spliced straight into
 * the position it belongs in.
 */
export class HistorySessionOrder {
  #rows: Array<{ key: string; ts: number }> = []
  #timestampByKey = new Map<string, number>()

  /** Adopt an already-ordered list wholesale. */
  reset(sessions: SessionMeta[]): void {
    this.#rows = sessions.map((meta) => ({
      key: sessionMetaKey(meta),
      ts: historySessionTimestamp(meta),
    }))
    this.#timestampByKey = new Map(this.#rows.map(({ key, ts }) => [key, ts]))
  }

  /** Splice a batch into `sessions` — the list this order mirrors. */
  insert(sessions: SessionMeta[], batch: SessionMeta[]): void {
    for (const meta of batch) {
      const key = sessionMetaKey(meta)
      const ts = historySessionTimestamp(meta)
      const heldTs = this.#timestampByKey.get(key)
      if (heldTs !== undefined) {
        // Already listed — from another host's scan, or an earlier batch of
        // this one. Only a newer row for the same session replaces it.
        if (ts <= heldTs) continue
        const heldAt = this.#indexOfKey(key, heldTs)
        if (heldAt >= 0) {
          this.#rows.splice(heldAt, 1)
          sessions.splice(heldAt, 1)
        }
      }
      const at = this.#insertionIndex(ts)
      this.#rows.splice(at, 0, { key, ts })
      sessions.splice(at, 0, meta)
      this.#timestampByKey.set(key, ts)
    }
  }

  /** Where a row with this timestamp belongs. Equal timestamps keep the order
   *  they arrived in, as the sort this replaces did. */
  #insertionIndex(ts: number): number {
    let low = 0
    let high = this.#rows.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.#rows[mid].ts >= ts) low = mid + 1
      else high = mid
    }
    return low
  }

  /** The position of a row already held, found through its known timestamp. */
  #indexOfKey(key: string, ts: number): number {
    for (let at = this.#insertionIndex(ts) - 1; at >= 0 && this.#rows[at].ts === ts; at--) {
      if (this.#rows[at].key === key) return at
    }
    return -1
  }
}

export class SessionHistoryLoader {
  private unsubscribers: (() => void)[] = []
  private loadSeq = 0

  constructor(private readonly options: SessionHistoryLoaderOptions) {}

  cancel() {
    this.loadSeq++
    this.unsubscribe()
  }

  async load({
    sources,
    deferredSources,
    ctx,
    onBatch,
    onHostState,
    limitPerProvider,
  }: LoadHistoryOptions): Promise<SessionMeta[]> {
    const seq = ++this.loadSeq
    this.unsubscribe()
    if (sources.length === 0 && !deferredSources) return []

    // A bounded load reads a fixed number of rows per provider, so it has no
    // progress worth streaming and opens no subscription.
    const streaming = limitPerProvider === undefined
    /** Which host's rows arrive on a stream, so a batch can be stamped with it. */
    const streamOwners = new Map<string, string>()
    const subscribedHosts = new Set<string>()
    const cache = this.options.snapshotCache

    const subscribeHost = (serverId: string) => {
      if (subscribedHosts.has(serverId)) return
      subscribedHosts.add(serverId)
      this.unsubscribers.push(
        this.options.hostFor(serverId).onSessionScan((event: SessionScanEvent) => {
          if (seq !== this.loadSeq || event.type !== 'batch') return
          if (!streamOwners.has(event.streamId)) return
          onBatch(stampSessionMetas(event.sessions, streamOwners.get(event.streamId)!))
        }),
      )
    }

    // The freshness ladder, per host: a host's sources settle independently,
    // and one failed host must cost the list only its own live rows — its
    // last-known snapshot stays, under an explicit `cached` state.
    const hostSources = new Map<string, { pending: number; scannedLive: boolean; showedCachedRows: boolean; error: string | null }>()
    const report = (serverId: string, state: DomainSyncState) => {
      if (seq === this.loadSeq) onHostState?.(serverId, state)
    }
    const beginHostSource = (serverId: string) => {
      const tracked = hostSources.get(serverId)
      if (tracked) {
        tracked.pending += 1
        return
      }
      hostSources.set(serverId, { pending: 1, scannedLive: false, showedCachedRows: false, error: null })
      report(serverId, { freshness: 'synchronizing', error: null })
    }
    const settleHostSource = (serverId: string, outcome: { live?: boolean; cachedRows?: boolean; error?: string }) => {
      const tracked = hostSources.get(serverId)
      if (!tracked) return
      tracked.pending -= 1
      if (outcome.live) tracked.scannedLive = true
      if (outcome.cachedRows) tracked.showedCachedRows = true
      if (outcome.error && !tracked.error) tracked.error = outcome.error
      if (tracked.pending > 0) return
      const freshness: Freshness = tracked.scannedLive
        ? 'live'
        : tracked.showedCachedRows ? 'cached' : 'empty'
      report(serverId, { freshness, error: tracked.error })
    }

    const scan = async (source: SessionHistorySource): Promise<SessionMeta[]> => {
      const host = this.options.hostFor(source.serverId)
      beginHostSource(host.serverId)
      const cachedRows = cache?.cachedSessions(host.serverId, source.id) ?? []
      if (source.cachedOnly) {
        // The host is unreachable: last-known rows render, nothing is dialled.
        settleHostSource(host.serverId, { cachedRows: cachedRows.length > 0 })
        return cachedRows
      }
      // Cached rows render immediately while the scan runs; the newest row per
      // session wins the merge, and the authoritative result replaces them.
      if (streaming && cachedRows.length > 0) onBatch(cachedRows)
      let streamId: string | undefined
      if (streaming) {
        streamId = `scan-${++scanStreamCounter}-${source.id}`
        streamOwners.set(streamId, host.serverId)
        subscribeHost(source.serverId)
      }
      try {
        const sessions = stampSessionMetas(
          await host.listSessions(source.projectPath, ctx, source.provider, streamId, limitPerProvider),
          host.serverId,
        )
        cache?.saveSource(host.serverId, source, sessions)
        settleHostSource(host.serverId, { live: true })
        return sessions
      } catch (error) {
        // The failed sync is the host's error state, never the list's: the
        // source contributes its last-known rows and the ladder says so.
        settleHostSource(host.serverId, {
          cachedRows: cachedRows.length > 0,
          error: error instanceof Error ? error.message : String(error),
        })
        return cachedRows
      }
    }

    try {
      const known = Promise.all(sources.map(scan))
      // A host that never answers must not cost the picker the rows it already
      // has, so a failed discovery resolves to nothing rather than rejecting.
      const discoveries = deferredSources
        ? Array.isArray(deferredSources) ? deferredSources : [deferredSources]
        : []
      const scannedSourceIds = new Set(sources.map((source) => source.id))
      const deferred = Promise.all(discoveries.map((discovery) =>
        discovery
          .then((late) => {
            if (seq !== this.loadSeq) return []
            const fresh = late.filter((source) => {
              if (scannedSourceIds.has(source.id)) return false
              scannedSourceIds.add(source.id)
              return true
            })
            return Promise.all(fresh.map(scan))
          })
          .catch((): SessionMeta[][] => []),
      )).then((batches) => batches.flat())
      const sessions = (await Promise.all([known, deferred])).flat(2)
      if (seq !== this.loadSeq) return []
      return sortedDedupedHistorySessions(sessions)
    } finally {
      if (seq === this.loadSeq) this.unsubscribe()
    }
  }

  private unsubscribe() {
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers = []
  }
}
