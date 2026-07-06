import type { AgentId, IpcContext, SessionMeta, SessionScanEvent } from '../../shared/types'

export interface SessionHistorySource {
  id: string
  projectPath: string
  provider?: AgentId
}

export interface SessionHistoryLoaderOptions {
  listSessions: Window['solus']['listSessions']
  onSessionScan: Window['solus']['onSessionScan']
}

export interface LoadHistoryOptions {
  sources: SessionHistorySource[]
  ctx: IpcContext
  onBatch: (sessions: SessionMeta[]) => void
}

function sessionMetaKey(meta: SessionMeta): string {
  return `${meta.provider}:${meta.sessionId}`
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
  private unsubscribeScan: (() => void) | null = null
  private loadSeq = 0

  constructor(private readonly options: SessionHistoryLoaderOptions) {}

  cancel() {
    this.loadSeq++
    if (this.unsubscribeScan) {
      this.unsubscribeScan()
      this.unsubscribeScan = null
    }
  }

  async load({ sources, ctx, onBatch }: LoadHistoryOptions): Promise<SessionMeta[]> {
    const seq = ++this.loadSeq
    this.unsubscribe()
    if (sources.length === 0) return []

    const streamIds = sources.map(
      (source, index) => `scan-${seq}-${index}-${source.id}-${Date.now()}`,
    )
    const activeStreamIds = new Set(streamIds)

    this.unsubscribeScan = this.options.onSessionScan((event: SessionScanEvent) => {
      if (seq !== this.loadSeq || !activeStreamIds.has(event.streamId)) return
      if (event.type === 'batch') onBatch(event.sessions)
    })

    try {
      const sessions = (
        await Promise.all(
          sources.map((source, index) =>
            this.options.listSessions(
              source.projectPath,
              ctx,
              source.provider,
              streamIds[index],
            ),
          ),
        )
      ).flat()
      if (seq !== this.loadSeq) return []
      return sortedDedupedHistorySessions(sessions)
    } finally {
      if (seq === this.loadSeq) this.unsubscribe()
    }
  }

  private unsubscribe() {
    if (this.unsubscribeScan) {
      this.unsubscribeScan()
      this.unsubscribeScan = null
    }
  }
}
