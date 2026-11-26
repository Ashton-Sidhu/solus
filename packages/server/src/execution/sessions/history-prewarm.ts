import { createLogger } from '../../logger'
import { isApiMode } from '../../host/api-mode'
import type { SessionRuntime } from '../session-runtime'

const log = createLogger('SessionRuntime', 'history-prewarm.ts')

/** The turn limits of a client's first page: the mobile app's cold open
 *  (`COLD_HISTORY_TURNS` in its conversation controller) and every other first
 *  page (`INITIAL_HISTORY_TURNS` in client-core). A provider page is cached by
 *  its turn limit, so a prewarm helps only a request with the same limit. */
const FIRST_PAGE_TURN_LIMITS = [5, 10]
/** The most recent sessions of a directory that the host reads ahead. */
const RECENT_SESSIONS = 10
/** Reads that one prewarm runs at the same time. */
const CONCURRENCY = 2
/** The wait after a turn ends before its page is read again: the provider can
 *  still be writing its last lines, and its run handle can still be open. */
const AFTER_TURN_MS = 1000

/**
 * Reads the first history page of resting sessions before a person opens one
 * (docs/plans/session-open-latency.md). The read fills the provider's own page
 * cache (`ProviderHistoryPages`), keyed by the provider file and its revision.
 * Nothing it reads goes to a client: each request still passes its access
 * check and reads its activity, fork, and projection for its own caller.
 */
export class HistoryPrewarm {
  private readonly warming = new Set<string>()

  constructor(private readonly rt: SessionRuntime) {}

  /** Read ahead the first page of the most recent of `sessionIds`, newest first. */
  async warm(sessionIds: readonly string[]): Promise<void> {
    // On the workspace service a page is read from the transcript mirror.
    if (isApiMode()) return
    const queue = sessionIds.slice(0, RECENT_SESSIONS).filter((sessionId) => !this.warming.has(sessionId))
    for (const sessionId of queue) this.warming.add(sessionId)
    const worker = async () => {
      for (let sessionId = queue.shift(); sessionId; sessionId = queue.shift()) {
        // Low priority: let the requests that wait now go first.
        await new Promise((resolve) => setImmediate(resolve))
        try {
          await this.warmSession(sessionId)
        } catch (error) {
          log.warn('history_prewarm_failed', { sessionId, error: error instanceof Error ? error.message : String(error) })
        } finally {
          this.warming.delete(sessionId)
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  }

  /** Read a session's first page again after its turn ends, as its next opening reads it. */
  afterTurn(sessionId: string): void {
    if (isApiMode()) return
    setTimeout(() => void this.warm([sessionId]), AFTER_TURN_MS).unref?.()
  }

  private async warmSession(sessionId: string): Promise<void> {
    const startedAt = performance.now()
    // Only a session this host keeps: a record of another host's session has no provider file here.
    const meta = await this.rt.history.getSessionInfo(sessionId)
    if (!meta) return
    // A running session is read ahead too: people open it the most. Its page stays
    // cached until the run writes again (each write changes the file's revision).
    for (const turnLimit of FIRST_PAGE_TURN_LIMITS) {
      await this.rt.history.loadSessionPage({ sessionId, provider: meta.provider, projectPath: meta.cwd || undefined, turnLimit, knownHistoryBlocks: [] })
    }
    log.info('history_prewarmed', { sessionId, provider: meta.provider, durationMs: performance.now() - startedAt })
  }
}
