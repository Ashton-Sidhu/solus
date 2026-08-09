import type { AgentId, IpcContext, SessionMeta, SessionScanEvent } from '../../shared/types'

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
  listSessions: Window['solus']['listSessions']
  onSessionScan(listener: (event: SessionScanEvent) => void): () => void
}

export interface SessionHistoryLoaderOptions {
  hostFor(serverId: string | undefined): SessionHistoryHost
}

export interface LoadHistoryOptions {
  sources: SessionHistorySource[]
  /** Sources that take a network round trip to discover. They join the same scan
   *  when they arrive, so finding a remote host never delays the local rows. */
  deferredSources?: Promise<SessionHistorySource[]>
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

/** Name the host a row came from. Local rows are left untouched so the common
 *  path allocates nothing. */
function withServerId(sessions: SessionMeta[], serverId: string | undefined): SessionMeta[] {
  if (!serverId) return sessions
  return sessions.map((meta) => ({ ...meta, serverId }))
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

export function sortedDedupedHistorySessions(sessions: SessionMeta[]): SessionMeta[] {
  const deduped = new Map<string, SessionMeta>()
  for (const meta of sessions) {
    const key = sessionMetaKey(meta)
    const existing = deduped.get(key)
    if (
      !existing ||
      new Date(meta.lastTimestamp).getTime() >
        new Date(existing.lastTimestamp).getTime()
    ) {
      deduped.set(key, meta)
    }
  }
  return [...deduped.values()].sort(
    (a, b) =>
      new Date(b.lastTimestamp).getTime() -
      new Date(a.lastTimestamp).getTime(),
  )
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
    const streamOwners = new Map<string, string | undefined>()
    const subscribedHosts = new Set<string | undefined>()

    const subscribeHost = (serverId: string | undefined) => {
      if (subscribedHosts.has(serverId)) return
      subscribedHosts.add(serverId)
      this.unsubscribers.push(
        this.options.hostFor(serverId).onSessionScan((event: SessionScanEvent) => {
          if (seq !== this.loadSeq || event.type !== 'batch') return
          if (!streamOwners.has(event.streamId)) return
          onBatch(withServerId(event.sessions, streamOwners.get(event.streamId)))
        }),
      )
    }

    const scan = (source: SessionHistorySource): Promise<SessionMeta[]> => {
      let streamId: string | undefined
      if (streaming) {
        streamId = `scan-${++scanStreamCounter}-${source.id}`
        streamOwners.set(streamId, source.serverId)
        subscribeHost(source.serverId)
      }
      return this.options
        .hostFor(source.serverId)
        .listSessions(source.projectPath, ctx, source.provider, streamId, limitPerProvider)
        .then((sessions) => withServerId(sessions, source.serverId))
    }

    try {
      const known = Promise.all(sources.map(scan))
      // A host that never answers must not cost the picker the rows it already
      // has, so a failed discovery resolves to nothing rather than rejecting.
      const deferred = deferredSources
        ? deferredSources
            .then((late) => (seq === this.loadSeq ? Promise.all(late.map(scan)) : []))
            .catch(() => [] as SessionMeta[][])
        : Promise.resolve([] as SessionMeta[][])
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
