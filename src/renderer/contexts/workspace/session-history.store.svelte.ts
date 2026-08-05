import type { AgentId, IpcContext, SessionMeta, SessionStatus } from '../../../shared/types'
import { serverConnections } from '@client-core/server-connections'
import {
  SessionHistoryLoader,
  sortedDedupedHistorySessions,
  type SessionHistoryLoaderOptions,
  type SessionHistorySource,
} from '../../lib/sessionPickerHistory'

interface SessionHistoryStoreLoadOptions {
  sources: SessionHistorySource[]
  ctx: IpcContext
  scopeKey?: string
  onBatch?: (sessions: SessionMeta[]) => void
  limitPerProvider?: number
}

export function updateSessionHistoryStatus(
  sessions: SessionMeta[],
  sessionId: string,
  status: SessionStatus,
): void {
  const session = sessions.find((candidate) => candidate.sessionId === sessionId)
  if (session) session.status = status
}

function defaultHistoryLoaderOptions(): SessionHistoryLoaderOptions {
  return {
    listSessions: window.solus.listSessions,
    onSessionScan: (listener) => serverConnections.eventsFor().subscribe('session.scanProgressed', listener),
  }
}

export class SessionHistoryStore {
  sessions = $state<SessionMeta[]>([])
  loading = $state(false)

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
    if (options.clear) this.sessions = []
  }

  clear(): void {
    this.sessions = []
  }

  merge(sessions: SessionMeta[]): void {
    this.sessions = sortedDedupedHistorySessions([...this.sessions, ...sessions])
  }

  /** Keep an unmounted session's picker row live without rebuilding history. */
  updateStatus(sessionId: string, status: SessionStatus): void {
    updateSessionHistoryStatus(this.sessions, sessionId, status)
  }

  async load({
    sources,
    ctx,
    scopeKey,
    onBatch,
    limitPerProvider,
  }: SessionHistoryStoreLoadOptions): Promise<SessionMeta[]> {
    const seq = ++this.#loadSeq
    this.#scopeKey = scopeKey ?? null
    this.loading = true

    try {
      const sessions = await this.#loader.load({
        sources,
        ctx,
        limitPerProvider,
        onBatch: (batch) => {
          if (!this.#isCurrent(seq, scopeKey)) return
          this.merge(batch)
          onBatch?.(this.sessions)
        },
      })
      if (!this.#isCurrent(seq, scopeKey)) return []
      this.sessions = sessions
      return sessions
    } catch {
      if (this.#isCurrent(seq, scopeKey)) this.sessions = []
      return []
    } finally {
      if (this.#isCurrent(seq, scopeKey)) this.loading = false
    }
  }

  async findSession(
    sessionId: string,
    source: { projectPath: string; provider?: AgentId },
    ctx: IpcContext,
  ): Promise<SessionMeta | null> {
    const sessions = await this.load({
      sources: [
        {
          id: source.projectPath,
          projectPath: source.projectPath,
          provider: source.provider,
        },
      ],
      ctx,
      scopeKey: `find:${source.provider ?? 'any'}:${source.projectPath}:${sessionId}`,
    })
    return sessions.find((meta) => meta.sessionId === sessionId) ?? null
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
