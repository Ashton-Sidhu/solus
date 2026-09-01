// Noticing a pull request that stopped being open somewhere other than Solus.
//
// Every write Solus makes announces itself: `prMerge` and `prUpdateLifecycle`
// broadcast `pr.lifecycleChanged`, and the surfaces reading that pull request
// correct on the next frame. A merge pressed on github.com, run through `gh`,
// or made from another machine announces nothing — so the sidebar chip kept
// drawing the pull request open and its task kept sitting in review.
//
// One rule: a pull request a live task links, that the host no longer reports
// open, is news exactly once. Reads go through `PrIndex` like every client
// read, which shares the answer and inherits the `gh` CLI fallback, so a host
// whose OAuth token has expired is still told about the merge.

import type * as Contracts from '@solus/contracts/providers'
import { getDb } from '../db'
import { createLogger } from '../logger'
import { completeTasksForMergedPullRequest } from '../tasks/sync-engine'
import { readActivePrLinkTargets, type PrLinkTarget } from '../tasks/task-links'
import { codeHostFor, type CodeHost } from './code-host'
import { prIndex } from './pr-index'

const log = createLogger('main', 'pr-reconciler')

const POLL_INTERVAL_MS = 60_000

export interface PrReconcilerDeps {
  /** Adapted to the host event by the composition root, which owns transports. */
  announce: (projectRoot: string, detail: Contracts.PullRequest) => void
  /** Overridable so a test can state a watch list and a code host of its own;
   *  the defaults beside them are what runs. */
  watchList?: () => PrLinkTarget[]
  codeHost?: (projectScope: string) => Promise<CodeHost | null>
  intervalMs?: number
}

export class PrReconciler {
  /**
   * The pull requests already reported. A merged or closed pull request cannot
   * change again, so this is both what stops a second announcement and what
   * makes the poll affordable: a project whose linked work is finished asks
   * nothing. Disposable — a restart re-reads, which is also how a merge made
   * while Solus was closed gets noticed.
   */
  private readonly reported = new Set<string>()
  private readonly watchList: () => PrLinkTarget[]
  private readonly codeHost: NonNullable<PrReconcilerDeps['codeHost']>
  private readonly intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private polling: Promise<void> | null = null

  constructor(private readonly deps: PrReconcilerDeps) {
    this.watchList = deps.watchList ?? (() => readActivePrLinkTargets(getDb()))
    this.codeHost = deps.codeHost ?? codeHostFor
    this.intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.poll(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass. A host slower than the interval is asked once, not twice. */
  poll(): Promise<void> {
    if (this.polling) return this.polling
    const pass = this.runPass().finally(() => { this.polling = null })
    this.polling = pass
    return pass
  }

  private async runPass(): Promise<void> {
    for (const target of this.watchList()) {
      const key = `${target.projectScope}\0${target.number}`
      if (this.reported.has(key)) continue
      try {
        if (await this.check(target)) this.reported.add(key)
      } catch (error) {
        // Not fatal: an unreachable host answers nothing this pass and is asked
        // again on the next one, so the key stays out of `reported`.
        log.warn('pr_reconcile_failed', {
          projectRoot: target.projectScope,
          prNumber: target.number,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  /** Whether this pull request was reported, and so needs no asking again. */
  private async check({ projectScope, number }: PrLinkTarget): Promise<boolean> {
    const target = await this.codeHost(projectScope)
    if (!target) return false
    // Fresh: a remembered answer is what every stale surface already has.
    const detail = await prIndex.pullRequest(target.repo, target.provider, number).readFresh()
    if (detail.state === 'open') return false

    log.info('pr_lifecycle_reconciled', { projectRoot: projectScope, prNumber: number, state: detail.state })
    this.deps.announce(projectScope, detail)
    // The in-Solus merge path completes linked tasks itself; a merge made
    // anywhere else has to reach the same place, or the work stays in review
    // with nothing left to review.
    if (detail.state === 'merged') await completeTasksForMergedPullRequest(projectScope, number)
    return true
  }
}
