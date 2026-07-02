import type {
  MergeQueueEntry,
  MergeQueueStartItem,
  MergeQueueStartOptions,
  MergeQueueState,
} from '../../shared/types'
import type { Provider, RepoRef } from '../providers/types'
import { createLogger } from '../logger'
import { runAsync } from './exec'
import { computeGitProjectStatus } from './git-helpers'
import { fetchAndCheckoutPr } from './worktree-manager'

const log = createLogger('main', 'merge-queue')

/** How often to re-check a conflicted worktree while waiting for resolution. */
const RESOLUTION_POLL_MS = 3_000

export interface MergeQueueDeps {
  repoRoot: string
  repo: RepoRef
  provider: Provider
  onUpdate: (state: MergeQueueState) => void
}

/**
 * Order PRs so the least-entangled ones merge first: greedily pick the PR whose
 * changed files overlap the fewest files across the PRs still in the pool.
 * Non-overlapping PRs merge cleanly regardless of order, so front-loading them
 * defers (and often shrinks) the conflicts the overlapping tail will hit.
 * Ties keep the caller's order.
 */
export async function computeAutoOrder(
  provider: Provider,
  repo: RepoRef,
  numbers: number[],
): Promise<number[]> {
  const files = await Promise.all(
    numbers.map((n) => provider.review.listPullRequestFiles(repo, n).catch(() => [] as string[])),
  )
  const pool = numbers.map((n, i) => ({ n, files: new Set(files[i]) }))
  const ordered: number[] = []
  while (pool.length > 0) {
    let bestIdx = 0
    let bestScore = Infinity
    for (let i = 0; i < pool.length; i++) {
      let score = 0
      for (const other of pool) {
        if (other === pool[i]) continue
        for (const f of pool[i].files) if (other.files.has(f)) score++
      }
      if (score < bestScore) {
        bestScore = score
        bestIdx = i
      }
    }
    ordered.push(pool.splice(bestIdx, 1)[0].n)
  }
  return ordered
}

/**
 * Sequentially merges a set of PRs, one at a time. Each turn re-reads the PR
 * fresh (earlier merges change every later PR's mergeability):
 *
 *   1. Ask the host to merge. Mergeable → merged, advance.
 *   2. Host refuses → materialize the PR worktree and merge the base branch
 *      into it locally. Clean merge → push the updated head, retry step 1.
 *   3. Conflicts → pause as 'conflicts' and poll the worktree until the merge
 *      concludes (an agent or the user resolves + commits), then push + retry.
 *
 * One queue at a time; state is mirrored to renderers via onUpdate after every
 * transition.
 */
export class MergeQueue {
  private state: MergeQueueState
  private cancelled = false
  private skipRequested = false
  private running: Promise<void> | null = null

  constructor(
    private readonly deps: MergeQueueDeps,
    items: MergeQueueStartItem[],
    private readonly options: MergeQueueStartOptions,
  ) {
    this.state = {
      repoRoot: deps.repoRoot,
      status: 'running',
      method: options.method ?? 'merge',
      entries: items.map((item) => ({ number: item.number, title: item.title, status: 'pending' as const })),
      currentIndex: 0,
    }
  }

  getState(): MergeQueueState {
    return this.state
  }

  isActive(): boolean {
    return this.state.status === 'running' || this.state.status === 'waiting'
  }

  start(): void {
    if (this.running) return
    this.running = this.run().catch((err) => {
      log.error(`merge queue crashed: ${err?.message ?? err}`)
      this.state.status = 'cancelled'
      this.publish()
    })
  }

  cancel(): void {
    this.cancelled = true
  }

  /** Give up on the entry the queue is paused on and move to the next PR. */
  skipCurrent(): void {
    this.skipRequested = true
  }

  private publish(): void {
    // Ship a snapshot, not the live object — it crosses the RPC boundary.
    this.deps.onUpdate(JSON.parse(JSON.stringify(this.state)))
  }

  private async run(): Promise<void> {
    if (this.options.order === 'auto') {
      const ordered = await computeAutoOrder(
        this.deps.provider,
        this.deps.repo,
        this.state.entries.map((e) => e.number),
      )
      this.state.entries.sort((a, b) => ordered.indexOf(a.number) - ordered.indexOf(b.number))
    }
    this.publish()

    for (let i = 0; i < this.state.entries.length; i++) {
      if (this.cancelled) break
      this.state.currentIndex = i
      this.skipRequested = false
      await this.processEntry(this.state.entries[i])
    }

    this.state.currentIndex = -1
    this.state.status = this.cancelled ? 'cancelled' : 'done'
    this.publish()
  }

  private async processEntry(entry: MergeQueueEntry): Promise<void> {
    const { provider, repo, repoRoot } = this.deps
    entry.status = 'merging'
    this.publish()

    try {
      const detail = await provider.review.getPullRequest(repo, entry.number)
      if (detail.state !== 'open') {
        entry.status = 'skipped'
        entry.detail = `Pull request is already ${detail.state}`
        this.publish()
        return
      }
      entry.baseRef = detail.baseRef

      const first = await provider.review.mergePullRequest(repo, entry.number, this.state.method)
      if (first.merged) {
        entry.status = 'merged'
        this.publish()
        return
      }

      if (detail.headRepo.isFork) {
        entry.status = 'skipped'
        entry.detail = 'Head branch lives in a fork — resolve conflicts on the contributor side'
        this.publish()
        return
      }

      // Local path: merge the (freshly fetched) base into the PR head in its
      // dedicated worktree, so conflicts land where an agent session can work.
      const wt = await fetchAndCheckoutPr(repoRoot, entry.number, detail.baseRef)
      entry.worktreePath = wt.worktreePath
      entry.branch = wt.branch
      await runAsync('git', ['fetch', 'origin', detail.baseRef], wt.worktreePath)

      const cleanMerge = await runAsync(
        'git',
        ['merge', '--no-edit', `origin/${detail.baseRef}`],
        wt.worktreePath,
      ).then(() => true, () => false)

      if (!cleanMerge) {
        const resolved = await this.waitForResolution(entry, wt.worktreePath)
        if (!resolved) return // cancelled or skipped — status already set
        entry.status = 'merging'
        entry.conflictFiles = undefined
        this.publish()
      }

      // Push the merge commit to the PR's head branch, then merge for real.
      await runAsync('git', ['push', 'origin', `HEAD:refs/heads/${detail.headRef}`], wt.worktreePath)
      const second = await provider.review.mergePullRequest(repo, entry.number, this.state.method)
      if (second.merged) {
        entry.status = 'merged'
      } else {
        entry.status = 'failed'
        entry.detail = second.message ?? 'GitHub still refused the merge after resolving conflicts'
      }
    } catch (err: any) {
      entry.status = 'failed'
      entry.detail = err?.message ?? String(err)
    }
    this.publish()
  }

  /**
   * Pause on a conflicted worktree until its merge concludes: MERGE_HEAD gone
   * and no conflicted files left (the resolver must commit the merge). Returns
   * false when the wait ended via cancel/skip instead of resolution.
   */
  private async waitForResolution(entry: MergeQueueEntry, worktreePath: string): Promise<boolean> {
    const status = await computeGitProjectStatus(worktreePath)
    entry.status = 'conflicts'
    entry.conflictFiles = status?.files.filter((f) => f.conflicted).map((f) => f.path) ?? []
    this.state.status = 'waiting'
    this.publish()

    for (;;) {
      if (this.cancelled || this.skipRequested) {
        entry.status = 'skipped'
        entry.detail = this.cancelled ? 'Queue cancelled during conflict resolution' : 'Skipped while conflicted'
        // Leave the half-merged worktree alone if the user aborts mid-resolution?
        // No — a lingering MERGE_HEAD would poison the next queue run for this
        // PR. Abort the merge so the worktree returns to the PR head.
        await runAsync('git', ['merge', '--abort'], worktreePath).catch(() => {})
        this.state.status = 'running'
        this.publish()
        return false
      }

      const current = await computeGitProjectStatus(worktreePath)
      const conflicted = current?.files.filter((f) => f.conflicted).map((f) => f.path) ?? []
      if (current && !current.mergeInProgress && conflicted.length === 0) {
        this.state.status = 'running'
        return true
      }
      // Keep the renderer's conflict list live as the agent resolves files.
      if (JSON.stringify(conflicted) !== JSON.stringify(entry.conflictFiles)) {
        entry.conflictFiles = conflicted
        this.publish()
      }
      await new Promise((resolve) => setTimeout(resolve, RESOLUTION_POLL_MS))
    }
  }
}

// ─── Singleton wiring ─────────────────────────────────────────────────────────
// One queue per app. Starting a new queue while one is active is an error the
// handler surfaces to the renderer.

let activeQueue: MergeQueue | null = null

export function getActiveMergeQueue(): MergeQueue | null {
  return activeQueue
}

export function startMergeQueue(
  deps: MergeQueueDeps,
  items: MergeQueueStartItem[],
  options: MergeQueueStartOptions,
): MergeQueue {
  if (activeQueue?.isActive()) throw new Error('A merge queue is already running')
  activeQueue = new MergeQueue(deps, items, options)
  activeQueue.start()
  return activeQueue
}
