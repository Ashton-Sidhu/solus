import { INITIAL_HISTORY_TURNS, loadSessionHistoryPage } from '@solus/client-core/session-history-page'
import { sessionFeedHistoryOptions } from '@solus/contracts/session-feed-item'
import type { SessionHistoryPage, SessionHistoryPageRequest } from '@solus/contracts/session-history'
import type { SessionRecord } from '@solus/contracts/types'
import type { HostConnection } from '../hosts/host-connections'
import type { MobileSessionCache } from './session-cache'

/** The rows at the top of a host's list whose first page is read when the list loads. */
export const PREFETCH_ROWS = 8
/** How many of those reads go at the same time. */
const PREFETCH_READS = 2
/** A session this large opens on a page of fewer turns (`ConversationController`), so it is not read ahead. */
export const LARGE_SESSION_BYTES = 16 * 1024 * 1024
/** How long a read ahead waits for the saved page, to send the blocks it holds. */
const SAVED_PAGE_WAIT_MS = 50

type RecordSource = Pick<SessionRecord, 'sessionId' | 'projectPath' | 'cwd' | 'provider'>

/**
 * The first page that the open of a saved session reads, without its open
 * fields: the same source, window, and options. So the answer the host keeps
 * and the page this device saves are the ones the open asks for.
 */
export function openingHistoryRequest(record: RecordSource): SessionHistoryPageRequest {
  return {
    sessionId: record.sessionId,
    projectPath: record.projectPath || record.cwd || undefined,
    provider: record.provider,
    turnLimit: INITIAL_HISTORY_TURNS,
    ...sessionFeedHistoryOptions,
  }
}

export interface HistoryPrefetchDeps {
  cache: MobileSessionCache
  connection(hostId: string): HostConnection | null
  /** False while the app is in the background. */
  inForeground(): boolean
}

/**
 * Reads the first history page of a session before it opens and saves it, so
 * that the open paints from the device and confirms with a small answer. A
 * press on a row reads that session; a host's list read reads its top rows.
 * Each read goes on a ready connection while the app is in front. A read whose
 * account scope or connection changed is not kept.
 */
export class HistoryPrefetch {
  private readonly runs = new Map<string, symbol>()

  constructor(private readonly deps: HistoryPrefetchDeps) {}

  /** Starts the read of one session; an open of the session takes this read. Null when it does not start. */
  prefetch(hostId: string, record: RecordSource & Pick<SessionRecord, 'size'>): Promise<SessionHistoryPage | null> | null {
    const connection = this.deps.connection(hostId)
    if (!connection || !this.ready(connection) || (record.size ?? 0) >= LARGE_SESSION_BYTES) return null
    const generation = connection.state.sessionGeneration
    const request = openingHistoryRequest(record)
    return this.deps.cache.forHost(hostId).prefetchHistory(record.sessionId,
      saved => loadSessionHistoryPage(connection.api, request, saved, SAVED_PAGE_WAIT_MS),
      () => this.deps.connection(hostId) === connection && connection.state.sessionGeneration === generation)
  }

  /**
   * Reads the first page of the top rows of a host's list. A row whose saved
   * page was written after its last activity is skipped. A later warm of the
   * host, `cancel`, a scope change, a new connection, or the background stops
   * the reads that did not start.
   */
  async warm(hostId: string, records: readonly (RecordSource & Pick<SessionRecord, 'size' | 'lastActivityAt'>)[]): Promise<void> {
    const connection = this.deps.connection(hostId)
    if (!connection || !this.ready(connection)) return
    const run = Symbol('warm')
    this.runs.set(hostId, run)
    const scope = this.deps.cache.scope()
    const generation = connection.state.sessionGeneration
    const cache = this.deps.cache.forHost(hostId)
    await cache.readKeys()
    const isCurrent = () => this.runs.get(hostId) === run && this.deps.cache.scope() === scope &&
      this.deps.connection(hostId) === connection && connection.state.sessionGeneration === generation && this.ready(connection)
    const queue = records.slice(0, PREFETCH_ROWS).filter(record => {
      const savedAt = cache.historySavedAt(record.sessionId)
      return savedAt === undefined || savedAt < record.lastActivityAt
    })
    const reader = async () => {
      for (let record = queue.shift(); record && isCurrent(); record = queue.shift()) await this.prefetch(hostId, record)
    }
    await Promise.all(Array.from({ length: PREFETCH_READS }, reader))
    if (this.runs.get(hostId) === run) this.runs.delete(hostId)
  }

  /** Stops the reads of a host's warm that did not start. */
  cancel(hostId: string): void {
    this.runs.delete(hostId)
  }

  private ready(connection: HostConnection): boolean {
    return connection.state.readiness === 'ready' && this.deps.inForeground()
  }
}
