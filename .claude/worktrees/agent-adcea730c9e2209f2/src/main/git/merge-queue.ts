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
/** Check the host every Nth worktree poll (~30s) — a resolution can also
 *  arrive remotely (push from another checkout, web editor, external merge). */
const REMOTE_CHECK_EVERY = 10

/** How a wait on a conflicted entry ended. */
type ResolutionOutcome =
  /** Merge concluded in the local worktree — push it, then merge on the host. */
  | 'local'
  /** The host reports the PR mergeable again (fixed elsewhere) — just merge. */
  | 'remote'
  /** Merged on the host while we waited. */
  | 'merged'
  /** Closed on the host while we waited. */
  | 'closed'
  /** Cancelled or skipped by the user; entry status already set. */
  | 'stopped'

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
  /** Resolves the current resolution-poll sleep early so skip/cancel take effect
   *  immediately instead of waiting out the poll interval. Null when not sleeping. */
  private wakeResolver: (() => void) | null = null

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
    this.wakeResolver?.()
  }

  /** Give up on the entry the queue is paused on and move to the next PR. */
  skipCurrent(): void {
    this.skipRequested = true
    this.wakeResolver?.()
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

      let mergeError = ''
      const cleanMerge = await runAsync(
        'git',
        ['merge', '--no-edit', `origin/${detail.baseRef}`],
        wt.worktreePath,
      ).then(
        () => true,
        (err) => {
          mergeError = err?.message ?? String(err)
          return false
        },
      )

      let outcome: ResolutionOutcome = 'local'
      if (!cleanMerge) {
        // Only a merge that actually started (MERGE_HEAD / conflict entries) can
        // be resolved. Anything else — dirty worktree, unrelated histories —
        // failed outright; report the git error instead of waiting on a
        // resolution that can never come.
        const status = await computeGitProjectStatus(wt.worktreePath)
        const conflictStarted = status?.mergeInProgress || status?.files.some((f) => f.conflicted)
        if (!conflictStarted) {
          entry.status = 'failed'
          entry.detail = mergeError
          this.publish()
          return
        }

        outcome = await this.waitForResolution(entry, wt.worktreePath)
        if (outcome === 'stopped') return
        if (outcome === 'merged') {
          entry.status = 'merged'
          this.publish()
          return
        }
        if (outcome === 'closed') {
          entry.status = 'skipped'
          entry.detail = 'Pull request was closed while the queue waited'
          this.publish()
          return
        }
        entry.status = 'merging'
        entry.conflictFiles = undefined
        this.publish()
      }

      // Push the merge commit to the PR's head branch (a remote resolution has
      // nothing local to push), then merge for real.
      if (outcome === 'local') {
        await runAsync('git', ['push', 'origin', `HEAD:refs/heads/${detail.headRef}`], wt.worktreePath)
      }
      const second = await this.mergeWithBackoff(entry.number)
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
   * Pause on a conflicted worktree until the entry becomes actionable again.
   * Two signals close the loop: the local merge concluding (MERGE_HEAD gone,
   * no conflicted files — the resolver must commit), or — at a slower cadence —
   * the host reporting the PR mergeable/merged/closed because the resolution
   * happened somewhere else entirely.
   */
  private async waitForResolution(entry: MergeQueueEntry, worktreePath: string): Promise<ResolutionOutcome> {
    const status = await computeGitProjectStatus(worktreePath)
    entry.status = 'conflicts'
    entry.conflictFiles = status?.files.filter((f) => f.conflicted).map((f) => f.path) ?? []
    this.state.status = 'waiting'
    this.publish()

    const finish = (outcome: ResolutionOutcome): ResolutionOutcome => {
      this.state.status = 'running'
      return outcome
    }

    for (let tick = 0; ; tick++) {
      if (this.cancelled || this.skipRequested) {
        entry.status = 'skipped'
        entry.detail = this.cancelled ? 'Queue cancelled during conflict resolution' : 'Skipped while conflicted'
        // Leave the half-merged worktree alone if the user aborts mid-resolution?
        // No — a lingering MERGE_HEAD would poison the next queue run for this
        // PR. Abort the merge so the worktree returns to the PR head.
        await runAsync('git', ['merge', '--abort'], worktreePath).catch(() => {})
        this.publish()
        return finish('stopped')
      }

      const current = await computeGitProjectStatus(worktreePath)
      const conflicted = current?.files.filter((f) => f.conflicted).map((f) => f.path) ?? []
      if (current && !current.mergeInProgress && conflicted.length === 0) {
        return finish('local')
      }

      if (tick > 0 && tick % REMOTE_CHECK_EVERY === 0) {
        const remote = await this.deps.provider.review
          .getPullRequest(this.deps.repo, entry.number)
          .catch(() => null)
        if (remote && (remote.state !== 'open' || remote.mergeable === true)) {
          // Whatever the local worktree holds is now stale — drop its merge.
          await runAsync('git', ['merge', '--abort'], worktreePath).catch(() => {})
          if (remote.state === 'merged') return finish('merged')
          if (remote.state === 'closed') return finish('closed')
          return finish('remote')
        }
      }

      // Keep the renderer's conflict list live as the agent resolves files.
      if (JSON.stringify(conflicted) !== JSON.stringify(entry.conflictFiles)) {
        entry.conflictFiles = conflicted
        this.publish()
      }
      await this.sleep(RESOLUTION_POLL_MS)
    }
  }

  /** Poll-interval sleep that skip/cancel can cut short via `wakeResolver`, so a
   *  user action is observed on the next loop check rather than after the wait. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.wakeResolver = null
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wakeResolver = done
    })
  }

  /**
   * The host recomputes mergeability asynchronously after a push, so a merge
   * attempted right after pushing a resolution can be refused transiently.
   * Retry with backoff before believing the refusal.
   */
  private async mergeWithBackoff(number: number): Promise<{ merged: boolean; message?: string }> {
    const delays = [2_000, 4_000, 8_000]
    let last = await this.deps.provider.review.mergePullRequest(this.deps.repo, number, this.state.method)
    for (const delay of delays) {
      if (last.merged || this.cancelled) break
      await new Promise((resolve) => setTimeout(resolve, delay))
      last = await this.deps.provider.review.mergePullRequest(this.deps.repo, number, this.state.method)
    }
    return last
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
