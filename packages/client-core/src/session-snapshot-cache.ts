import { z } from 'zod'
import type { SessionMeta } from '@solus/contracts/types'
import { forwardCompatibleArray } from './forward-compat'
import { stampSessionMetas } from './session-meta'

/**
 * Last-known session rows per host (dispatch-client step 2).
 *
 * The aggregated session list includes every catalog host, reachable or not:
 * an offline host renders its cached rows under an explicit `cached` sync
 * state instead of vanishing. Rows are stored naked and stamped with their
 * host on read, the same client-edge rule every live read follows.
 *
 * The schema version lives in the storage key, so a rollback reads its own
 * generation and never trips over a newer build's records. Corrupt records
 * are deleted and treated as misses.
 */

const KEY_PREFIX = 'solus.sessionHistory.v1.'
const MAX_ROWS_PER_SOURCE = 40

// Rows re-enter the same pipeline live rows travel, so the load-bearing
// fields are required and everything else degrades alone.
const cachedSessionSchema = z.looseObject({
  provider: z.enum(['claude-code', 'codex', 'opencode']),
  sessionId: z.string().min(1),
  slug: z.string().nullable().catch(null),
  firstMessage: z.string().nullable().catch(null),
  lastTimestamp: z.string().catch(''),
  size: z.number().catch(0),
  cwd: z.string().catch(''),
  projectPath: z.string().catch(''),
})

const cachedSourceSchema = z.object({
  id: z.string().min(1),
  projectPath: z.string().min(1),
  repoKey: z.string().optional().catch(undefined),
  sessions: forwardCompatibleArray(cachedSessionSchema),
})

const cachedHostHistorySchema = z.object({
  savedAt: z.number().catch(0),
  sources: forwardCompatibleArray(cachedSourceSchema),
})

export interface CachedHistorySource {
  id: string
  projectPath: string
  repoKey?: string
}

export class SessionSnapshotCache {
  /** Replace one source's last-known rows after a successful scan. */
  saveSource(
    serverId: string,
    source: CachedHistorySource,
    sessions: SessionMeta[],
  ): void {
    const record = this.#read(serverId) ?? { savedAt: 0, sources: [] }
    const trimmed = sessions.slice(0, MAX_ROWS_PER_SOURCE).map((meta) => {
      // Rows are stored naked; the host is the storage key's business.
      const { serverId: _stamped, ...naked } = meta
      return naked
    })
    const entry = {
      id: source.id,
      projectPath: source.projectPath,
      repoKey: source.repoKey,
      sessions: trimmed,
    }
    const at = record.sources.findIndex((candidate) => candidate.id === source.id)
    if (at >= 0) record.sources[at] = entry
    else record.sources.push(entry)
    record.savedAt = Date.now()
    try {
      localStorage.setItem(KEY_PREFIX + serverId, JSON.stringify(record))
    } catch {}
  }

  /** One source's last-known rows, stamped with their host. Empty is a miss. */
  cachedSessions(serverId: string, sourceId: string): SessionMeta[] {
    const record = this.#read(serverId)
    const source = record?.sources.find((candidate) => candidate.id === sourceId)
    if (!source) return []
    // SAFETY: Every surviving row passed cachedSessionSchema, whose required
    // fields mirror SessionMeta's; loose keys widen, never narrow.
    return stampSessionMetas(source.sessions as SessionMeta[], serverId)
  }

  /** The sources an unreachable host was last known to hold for these
   *  repositories — what lets its rows render without dialling it. */
  cachedSourcesForRepoKeys(serverId: string, repoKeys: ReadonlySet<string>): CachedHistorySource[] {
    const record = this.#read(serverId)
    if (!record) return []
    return record.sources
      .filter((source) => source.repoKey && repoKeys.has(source.repoKey))
      .map(({ id, projectPath, repoKey }) => ({ id, projectPath, repoKey }))
  }

  /** Forgetting a host is total: its snapshot leaves with it. */
  forgetHost(serverId: string): void {
    try {
      localStorage.removeItem(KEY_PREFIX + serverId)
    } catch {}
  }

  #read(serverId: string): z.output<typeof cachedHostHistorySchema> | null {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(KEY_PREFIX + serverId)
    } catch {
      return null
    }
    if (!raw) return null
    try {
      const decoded = cachedHostHistorySchema.safeParse(JSON.parse(raw))
      if (decoded.success) return decoded.data
    } catch {}
    // Delete-and-miss: a corrupt snapshot must not be re-parsed every load.
    this.forgetHost(serverId)
    return null
  }
}

export const sessionSnapshotCache = new SessionSnapshotCache()
