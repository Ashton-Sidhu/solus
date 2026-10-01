import type { InsightPullState } from '@solus/contracts/observability-types'
import type { WorkspaceInsightPage, WorkspaceInsightQuery, WorkspaceInsightTree } from '@solus/contracts/solus-api'
import { insightIdentity } from '../data/insights/api-turns'
import { newestPulledTurnStart, pulledTurnAwaitingTree, writePulledTree, writePulledTurns } from '../data/insights/pulled-turns'
import { createLogger } from '../logger'

const log = createLogger('main', 'insight-pull')

/**
 * Pulls the person's turns that other hosts ran into this host's `metrics.db`
 * (docs/plans/insights-across-hosts.md §3), so Insights reads every host's
 * turns from one database. The list pulls turn rows only; a turn's full tree is
 * pulled when its owner opens it.
 *
 * There is no cursor: each pull asks for the time since the newest pulled turn,
 * less an overlap that catches a turn the cloud received late, and writes
 * nothing it already has. A turn that reaches the cloud later than the overlap
 * is not pulled.
 */

/** How far before the newest pulled turn a pull asks again. */
export const PULL_OVERLAP_MS = 6 * 60 * 60 * 1000
/** The longest window the workspace service answers, and the first pull's reach. */
const FIRST_PULL_MS = 31 * 24 * 60 * 60 * 1000
/** A list read within this long of the last pull reads what that pull wrote. */
const PULL_INTERVAL_MS = 30_000
const PAGE_LIMIT = 200

/** The two Solus API reads a pull makes, as one person in one organization. */
export interface InsightSource {
  listInsights(query: WorkspaceInsightQuery): Promise<WorkspaceInsightPage>
  getInsightSpans(insightId: string): Promise<WorkspaceInsightTree>
}

export interface InsightPullDeps {
  /** The person Insights shows on this host: the linked account; null when signed out. */
  userId: () => string | null
  /** This host's id at the workspace service, so its own turns are not pulled back. */
  hostId: () => string | null
  /** The organizations this host sends Insights to. */
  organizations: () => string[]
  /** The Solus API as the person in the organization, holding their delegation first. */
  source: (userId: string, organizationId: string) => Promise<InsightSource>
  /** A pull started or ended. */
  onChange?: (state: InsightPullState) => void
  now?: () => number
}

export class InsightPull {
  private running: Promise<void> | null = null
  private lastPullAt = 0
  private lastError: string | null = null

  constructor(private readonly deps: InsightPullDeps) {}

  /** Whether a pull runs, and why the last one failed. */
  state(): InsightPullState {
    return { pulling: this.running !== null, error: this.lastError }
  }

  /** Starts a pull unless one runs or one ended recently. Never throws: the list answers from what is here. */
  request(): Promise<void> {
    if (this.running) return this.running
    if (this.now() - this.lastPullAt < PULL_INTERVAL_MS) return Promise.resolve()
    this.running = this.pull().finally(() => {
      this.lastPullAt = this.now()
      this.running = null
      this.deps.onChange?.(this.state())
    })
    this.deps.onChange?.(this.state())
    return this.running
  }

  /** Pulls a pulled turn's full tree, once. Answers whether a tree was written. */
  async fetchTree(traceId: string): Promise<boolean> {
    const userId = this.deps.userId()
    const pulled = pulledTurnAwaitingTree(traceId)
    if (!userId || !pulled) return false
    const api = await this.deps.source(userId, pulled.organizationId)
    const tree = await api.getInsightSpans(insightIdentity(pulled.hostId, traceId))
    writePulledTree(pulled.organizationId, pulled.hostId, tree)
    log.info('insight_tree_pulled', { traceId, hostId: pulled.hostId, spans: tree.spans.length })
    return true
  }

  private async pull(): Promise<void> {
    const userId = this.deps.userId()
    if (!userId) return
    const errors: string[] = []
    for (const organizationId of this.deps.organizations()) {
      try {
        await this.pullOrganization(userId, organizationId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(message)
        log.warn('insight_pull_failed', { organizationId, error: message })
      }
    }
    this.lastError = errors[0] ?? null
  }

  private async pullOrganization(userId: string, organizationId: string): Promise<void> {
    const api = await this.deps.source(userId, organizationId)
    const ownHostId = this.deps.hostId()
    const until = this.now()
    const newest = newestPulledTurnStart(organizationId)
    const since = Math.max(until - FIRST_PULL_MS + 1, newest === null ? 0 : newest - PULL_OVERLAP_MS)
    let cursor: string | undefined
    let written = 0
    do {
      const page = await api.listInsights({ limit: PAGE_LIMIT, userId, since: new Date(since).toISOString(), until: new Date(until).toISOString(), cursor })
      // This host's own turns are already here, complete.
      written += writePulledTurns(organizationId, page.items.filter((turn) => turn.hostId !== ownHostId))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    if (written > 0) log.info('insight_turns_pulled', { organizationId, written })
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
