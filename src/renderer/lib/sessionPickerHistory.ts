import type { AgentId, IpcContext, SessionMeta, SessionScanEvent } from '../../shared/types'
import type { HostApi } from '@client-core/host-api'
import { stampSessionMetas } from '@client-core/session-meta'

export interface SessionHistorySource {
  id: string
  projectPath: string
  provider?: AgentId
  /** The host that holds this path. Absent means this client's own host. */
  serverId?: string
}

/** The slice of one host's RPC surface a history scan needs. Resolved per source
 *  so a host that owns no source is never dialled. */
export interface SessionHistoryHost {
  serverId: string
  listSessions: HostApi['listSessions']
  onSessionScan(listener: (event: SessionScanEvent) => void): () => void
}

export interface SessionHistoryLoaderOptions {
  hostFor(serverId: string | undefined): SessionHistoryHost
}

export interface LoadHistoryOptions {
  sources: SessionHistorySource[]
  /** Sources that take a network round trip to discover. They join the same scan
   *  when they arrive, so finding a remote host never delays the local rows. */
  deferredSources?: Promise<SessionHistorySource[]> | Array<Promise<SessionHistorySource[]>>
  ctx: IpcContext
  onBatch: (sessions: SessionMeta[]) => void
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

export function sessionHistorySourcesFromRoots(roots: string[]): SessionHistorySource[] {
  const sources = new Map<string, SessionHistorySource>()
  for (const root of roots) {
    const projectPath = root.trim()
    if (!projectPath || sources.has(projectPath)) continue
    sources.set(projectPath, { id: projectPath, projectPath })
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
    const subscribedHosts = new Set<string | undefined>()

    const subscribeHost = (serverId: string | undefined) => {
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

    const scan = (source: SessionHistorySource): Promise<SessionMeta[]> => {
      const host = this.options.hostFor(source.serverId)
      let streamId: string | undefined
      if (streaming) {
        streamId = `scan-${++scanStreamCounter}-${source.id}`
        streamOwners.set(streamId, host.serverId)
        subscribeHost(source.serverId)
      }
      return host
        .listSessions(source.projectPath, ctx, source.provider, streamId, limitPerProvider)
        .then((sessions) => stampSessionMetas(sessions, host.serverId))
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
