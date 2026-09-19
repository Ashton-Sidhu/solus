import type * as Contracts from '@solus/contracts/providers'
import { getDatabase } from '../db/database'
import { createLogger } from '../logger'
import { completeTasksForMergedPullRequest } from '../tasks/sync-engine'
import { emitChanged } from '../tasks/task-store'
import { readActivePrLinkTargets, type PrLinkTarget } from '../tasks/task-links'
import { codeHostFor, type CodeHost } from './code-host'
import { prIndex, repoKeyOf } from './pr-index'
import { PrLinkDiscovery } from './pr-link-discovery'

const log = createLogger('main', 'pr-reconciler')
const POLL_INTERVAL_MS = 60_000
/** How long a pull request's last answer is trusted before the worker asks again. */
const OPEN_RECHECK_MS = 60_000
const SETTLED_RECHECK_MS = 15 * 60_000
const UNREADABLE_RECHECK_MS = 5 * 60_000

/** When each watched pull request is next due, by `scope#number`. Host memory
 *  rather than the worker's own, so replacing the worker does not re-read every
 *  pull request it had just settled; a host restart starts over, as the answers
 *  in `PrIndex` do. */
const nextAttemptAt = new Map<string, number>()

function recheckAfter(state: Contracts.PullRequest['state']): number {
  return state === 'open' ? OPEN_RECHECK_MS : SETTLED_RECHECK_MS
}

export interface PrReconcilerDeps {
  announce: (projectRoot: string, detail: Contracts.PullRequest) => void
  /** Whether a Solus session is still mid-turn; a task under one is not finished yet. */
  isSessionBusy?: (sessionId: string) => boolean
  watchList?: () => PrLinkTarget[] | Promise<PrLinkTarget[]>
  codeHost?: (projectScope: string) => Promise<CodeHost | null>
  intervalMs?: number
  now?: () => number
  discover?: () => Promise<void>
}

/** One host worker, independent of mounted clients. Reads never start this worker.
 * What it reads lands in `PrIndex`, where every surface reads it. */
export class PrReconciler {
  private readonly discovery = new PrLinkDiscovery()
  private readonly watchList: () => PrLinkTarget[] | Promise<PrLinkTarget[]>
  private readonly codeHost: NonNullable<PrReconcilerDeps['codeHost']>
  private readonly isSessionBusy: NonNullable<PrReconcilerDeps['isSessionBusy']>
  private readonly intervalMs: number
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private polling: Promise<void> | null = null

  constructor(private readonly deps: PrReconcilerDeps) {
    this.watchList = deps.watchList ?? (() => readActivePrLinkTargets(getDatabase()))
    this.codeHost = deps.codeHost ?? codeHostFor
    this.isSessionBusy = deps.isSessionBusy ?? (() => false)
    this.intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS
    this.now = deps.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    // No provider work on the server boot path.
    this.timer = setInterval(() => void this.poll(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  poll(): Promise<void> {
    if (this.polling) return this.polling
    const pass = this.runPass().catch((error) => {
      log.warn('pr_reconcile_pass_failed', { error: String(error) })
    }).finally(() => { this.polling = null })
    this.polling = pass
    return pass
  }

  private async runPass(): Promise<void> {
    await (this.deps.discover ?? (() => this.discovery.poll()))()
    let changed = false
    const seen = new Set<string>()
    const hosts = new Map<string, CodeHost | null>()
    for (const { projectScope, number } of await this.watchList()) {
      let scope = projectScope
      let key = `${scope}#${number}`
      try {
        if (!hosts.has(projectScope)) hosts.set(projectScope, await this.codeHost(projectScope))
        const host = hosts.get(projectScope)
        if (!host) continue
        scope = repoKeyOf(host.repo).toLowerCase()
        key = `${scope}#${number}`
        if (seen.has(key)) continue
        seen.add(key)
        const known = prIndex.lastRead(scope, number)
        const due = nextAttemptAt.get(key)
        if (due === undefined && known) {
          // First sight of a pull request something else already read — a
          // review page, branch discovery. That answer is the answer; start
          // the clock from it rather than asking the host again.
          nextAttemptAt.set(key, this.now() + recheckAfter(known.state))
        }
        if ((nextAttemptAt.get(key) ?? 0) > this.now()) {
          // A task skipped last time because its session was busy is asked
          // about again here; a task reopened since is left alone.
          if (known) await this.completeMerged(scope, number, known)
          continue
        }
        const detail = await prIndex.pullRequest(host.repo, host.provider, number).readFresh()
        nextAttemptAt.set(key, this.now() + recheckAfter(detail.state))
        // tasks.invalidated already reaches every client over IPC or WebSocket.
        // Its snapshot handler reads local task data and host memory only.
        changed = true
        this.deps.announce(scope, detail)
        await this.completeMerged(scope, number, detail)
      } catch (error) {
        // An unreadable pull request keeps its last answer until a later read lands.
        nextAttemptAt.set(key, this.now() + UNREADABLE_RECHECK_MS)
        log.warn('pr_reconcile_failed', {
          projectRoot: scope, prNumber: number, error: String(error),
        })
      }
    }
    if (changed) emitChanged()
  }

  private async completeMerged(scope: string, number: number, detail: Contracts.PullRequest): Promise<void> {
    if (detail.state !== 'merged') return
    await completeTasksForMergedPullRequest(scope, number, {
      mergedAt: detail.updatedAt,
      isSessionBusy: this.isSessionBusy,
      isMerged: async (other) => prIndex.lastRead(other.projectScope, other.number)?.state === 'merged',
    })
  }

}
