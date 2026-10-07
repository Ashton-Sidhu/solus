import type { PrConversationItem, PullRequest, ReviewThread } from '@solus/contracts/providers'
import { createLogger } from '../logger'
import {
  endPullRequestWatch,
  onPullRequestWatchesChanged,
  readPullRequestWatches,
  recordPullRequestWatchState,
  type PullRequestWatch,
  type PullRequestWatchState,
} from '../data/sessions/pull-request-watches'
import { recordSessionPullRequestObservation } from '../data/sessions/session-pull-requests'
import { githubRateLimitOf, type GitHubRateLimitedError } from '../providers/github/rate-limit'
import { asBackgroundWork } from '../providers/github/request-budget'
import type { PullRequestWatchFingerprint } from '../providers/types'
import { codeHostFor, type CodeHost } from './code-host'
import { prIndex } from './pr-index'
import { evaluateWatch, wakeText, type WatchEndReason, type WatchRead, type WatchRemark } from './pr-watch-rules'

const log = createLogger('main', 'pr-watcher')

/** How often watched pull requests are looked at (docs/plans/pr-watch.md §11). */
const SWEEP_MS = 2 * 60_000
/** Edits inside review threads are not in the fingerprint, so remarks are
 *  read again this often while nothing else moved. */
const REMARKS_REREAD_MS = 30 * 60_000
/** Reads in a row that failed, for a reason other than a rate limit, before
 *  the watch ends and says so. */
const READ_FAILURE_LIMIT = 8
/** A code host that gave no reset time is asked again after this long. */
const RATE_LIMIT_FALLBACK_MS = 5 * 60_000

export interface PrWatcherDeps {
  /** Queue a prompt on the session, after its running turn. */
  wake: (sessionId: string, text: string) => Promise<void>
  codeHost?: (repository: string) => Promise<CodeHost | null>
  now?: () => number
}

/** What the last read of one pull request saw, shared by every watch of it. */
interface LastRead {
  fingerprint: PullRequestWatchFingerprint | null
  readAt: number
  remarksReadAt: number
  /** A check was running, or mergeability was not known yet: the counts by
   *  state in the fingerprint cannot say which check finished. */
  unsettled: boolean
}

/**
 * Reads watched pull requests in the background and wakes the sessions that
 * watch them when there is news.
 *
 * The watches live in memory: they are read from the database at start and
 * when a change names a session, never on a sweep. A sweep reads one batch of
 * fingerprints per repository, and reads a pull request in full only when its
 * fingerprint moved. Sessions that watch one pull request share its read.
 */
export class PrWatcher {
  private readonly watches = new Map<string, PullRequestWatch>()
  private readonly lastReads = new Map<string, LastRead>()
  private readonly readFailures = new Map<string, number>()
  private readonly pausedUntil = new Map<string, number>()
  private readonly codeHost: NonNullable<PrWatcherDeps['codeHost']>
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private stopListening: (() => void) | null = null
  private running: Promise<void> | null = null
  private rerun = false

  constructor(private readonly deps: PrWatcherDeps) {
    this.codeHost = deps.codeHost ?? codeHostFor
    this.now = deps.now ?? Date.now
  }

  async start(): Promise<void> {
    this.stopListening = onPullRequestWatchesChanged((sessionId) => {
      void this.reloadSession(sessionId).catch((error) => {
        log.warn('pr_watch_reload_failed', { sessionId, error: (error instanceof Error ? error.message : String(error)) })
      })
    })
    for (const watch of await readPullRequestWatches()) this.watches.set(watchKey(watch), watch)
    this.updateClock()
    if (this.watches.size) void this.sweep()
  }

  stop(): void {
    this.stopListening?.()
    this.stopListening = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Look at every watched pull request. A call during a sweep runs once more after it. */
  sweep(): Promise<void> {
    if (this.running) {
      this.rerun = true
      return this.running
    }
    const run = asBackgroundWork(() => this.runSweep()).catch((error) => {
      log.warn('pr_watch_sweep_failed', { error: (error instanceof Error ? error.message : String(error)) })
    }).finally(() => {
      this.running = null
      if (!this.rerun) return
      this.rerun = false
      return this.sweep()
    })
    this.running = run
    return run
  }

  /** The one session the change named: its watches as stored now. A new
   *  watch is read at once rather than at the next sweep. */
  private async reloadSession(sessionId: string): Promise<void> {
    const stored = await readPullRequestWatches([sessionId])
    const started = stored.some((watch) => this.watches.get(watchKey(watch))?.watchId !== watch.watchId)
    for (const [key, watch] of this.watches) if (watch.sessionId === sessionId) this.watches.delete(key)
    for (const watch of stored) this.watches.set(watchKey(watch), watch)
    this.updateClock()
    if (started) void this.sweep()
  }

  /** The clock runs only while something is watched. */
  private updateClock(): void {
    if (this.watches.size && !this.timer) {
      this.timer = setInterval(() => void this.sweep(), SWEEP_MS)
      this.timer.unref?.()
    } else if (!this.watches.size && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async runSweep(): Promise<void> {
    const byRepository = new Map<string, Map<number, PullRequestWatch[]>>()
    for (const watch of this.watches.values()) {
      const numbers = byRepository.get(watch.repository) ?? new Map<number, PullRequestWatch[]>()
      numbers.set(watch.number, [...numbers.get(watch.number) ?? [], watch])
      byRepository.set(watch.repository, numbers)
    }
    for (const key of this.lastReads.keys()) {
      const [repository, number] = splitPullRequestKey(key)
      if (!byRepository.get(repository)?.has(number)) {
        this.lastReads.delete(key)
        this.readFailures.delete(key)
      }
    }
    for (const [repository, numbers] of byRepository) await this.sweepRepository(repository, numbers)
  }

  private async sweepRepository(repository: string, numbers: Map<number, PullRequestWatch[]>): Promise<void> {
    if ((this.pausedUntil.get(repository) ?? 0) > this.now()) return
    const host = await this.codeHost(repository).catch(() => null)
    if (!host) {
      for (const [number, watches] of numbers) await this.readFailed(repository, number, watches, 'no code host')
      return
    }
    let fingerprints: Map<number, PullRequestWatchFingerprint>
    try {
      fingerprints = await host.provider.review.readWatchFingerprints(host.repo, [...numbers.keys()])
    } catch (error) {
      const limited = githubRateLimitOf(error)
      if (limited) return this.pause(repository, limited)
      for (const [number, watches] of numbers) await this.readFailed(repository, number, watches, error instanceof Error ? error.message : String(error))
      return
    }
    for (const [number, watches] of numbers) {
      if (await this.readPullRequest(host, repository, number, watches, fingerprints.get(number) ?? null) === 'paused') return
    }
  }

  /** Read one pull request when its fingerprint says so, and evaluate each
   *  of its watches. 'paused' when the code host rate limited the read. */
  private async readPullRequest(
    host: CodeHost,
    repository: string,
    number: number,
    watches: PullRequestWatch[],
    fingerprint: PullRequestWatchFingerprint | null,
  ): Promise<'paused' | void> {
    const key = pullRequestKey(repository, number)
    const plan = this.planRead(key, fingerprint, watches)
    if (!plan) return
    let answer: { read: WatchRead; pullRequest: PullRequest }
    try {
      answer = await this.read(host, number, plan.remarks)
    } catch (error) {
      const limited = githubRateLimitOf(error)
      if (limited) {
        this.pause(repository, limited)
        return 'paused'
      }
      await this.readFailed(repository, number, watches, error instanceof Error ? error.message : String(error))
      return
    }
    const { read, pullRequest } = answer
    this.readFailures.delete(key)
    const last = this.lastReads.get(key)
    this.lastReads.set(key, {
      fingerprint,
      readAt: this.now(),
      remarksReadAt: plan.remarks ? this.now() : last?.remarksReadAt ?? 0,
      unsettled: read.checks.inFlight || pullRequest.mergeable === null,
    })
    for (const watch of watches) await this.evaluate(watch, read, pullRequest)
  }

  /** Which parts of a pull request this sweep reads, or null for none. */
  private planRead(key: string, fingerprint: PullRequestWatchFingerprint | null, watches: PullRequestWatch[]): { remarks: boolean } | null {
    const last = this.lastReads.get(key)
    // A first look, a watch newer than the last read, or a pull request the
    // fingerprint did not answer for: read everything.
    if (!last || !fingerprint || !last.fingerprint || watches.some((watch) => watch.startedAt > last.readAt)) return { remarks: true }
    const remarks = fingerprint.remarks !== last.fingerprint.remarks || this.now() - last.remarksReadAt >= REMARKS_REREAD_MS
    if (remarks || fingerprint.status !== last.fingerprint.status || last.unsettled) return { remarks }
    return null
  }

  /**
   * A watch read goes through the index PR sync and the clients share
   * (`prIndex`): what it reads reaches every surface that shows the pull
   * request, and a conversation a surface just read is joined, not read again.
   * It is forced, because the fingerprint only moves when the host has news.
   */
  private async read(host: CodeHost, number: number, withRemarks: boolean): Promise<{ read: WatchRead; pullRequest: PullRequest }> {
    const { repo, provider } = host
    const entity = prIndex.pullRequest(repo, provider, number)
    const fetched = (await provider.review.getPullRequests(repo, [number])).get(number)
    if (!fetched) throw new Error(`The code host has no pull request #${number}.`)
    entity.seed(fetched)
    const pullRequest = entity.lastRead() ?? fetched
    const summaries = await provider.review.listChecks(repo, [number])
    prIndex.absorbChecks(repo, provider, summaries)
    const checks = summaries[0]
    if (!checks) throw new Error(`The code host gave no checks for #${number}.`)
    const remarks = withRemarks
      ? remarksOf(await entity.comments({ force: true }), await entity.threads({ force: true }))
      : null
    const viewer = await provider.review.getViewer(repo)
    return { read: { pullRequest, checks: checks.summary, remarks, viewer }, pullRequest }
  }

  private async evaluate(watch: PullRequestWatch, read: WatchRead, pullRequest: PullRequest): Promise<void> {
    const evaluation = evaluateWatch(watch.state, read)
    if (evaluation.end === 'merged') {
      await recordSessionPullRequestObservation(watch.repository, watch.number, pullRequest)
      await this.end(watch, 'merged', null)
      return
    }
    if (evaluation.end) {
      if (evaluation.end === 'closed') await recordSessionPullRequestObservation(watch.repository, watch.number, pullRequest)
      await this.end(watch, evaluation.end, wakeText(pullRequest, evaluation.news, evaluation.end))
      return
    }
    if (!evaluation.news.length) {
      // A new head or a resolved conflict: nothing to tell, but the next
      // read compares with it.
      if (!sameState(evaluation.next, watch.state)) await this.record(watch, evaluation.next)
      return
    }
    // Stored before the wake, so a restart between them cannot tell it twice.
    if (!await this.record(watch, evaluation.next)) return
    log.info('pr_watch_woke', { sessionId: watch.sessionId, repository: watch.repository, number: watch.number, news: evaluation.news.map(({ kind }) => kind) })
    await this.wake(watch, wakeText(pullRequest, evaluation.news, null))
  }

  /** Store the state the agent now knows; false when the watch was stopped
   *  or started over while it was read. */
  private async record(watch: PullRequestWatch, state: PullRequestWatchState): Promise<boolean> {
    if (!await recordPullRequestWatchState(watch, state)) return false
    watch.state = state
    return true
  }

  private async end(watch: PullRequestWatch, reason: WatchEndReason, text: string | null): Promise<void> {
    if (!await endPullRequestWatch(watch)) return
    this.watches.delete(watchKey(watch))
    log.info('pr_watch_ended', {
      sessionId: watch.sessionId, repository: watch.repository, number: watch.number, reason,
      minutes: Math.round((this.now() - watch.startedAt) / 60_000),
    })
    if (text) await this.wake(watch, text)
  }

  private async wake(watch: PullRequestWatch, text: string): Promise<void> {
    try {
      await this.deps.wake(watch.sessionId, text)
    } catch (error) {
      // A session that cannot take a prompt cannot act on news either.
      log.warn('pr_watch_wake_failed', { sessionId: watch.sessionId, number: watch.number, error: (error instanceof Error ? error.message : String(error)) })
      await this.end(watch, 'unwatched', null)
    }
  }

  private async readFailed(repository: string, number: number, watches: PullRequestWatch[], error: string): Promise<void> {
    const key = pullRequestKey(repository, number)
    const failures = (this.readFailures.get(key) ?? 0) + 1
    this.readFailures.set(key, failures)
    log.warn('pr_watch_read_failed', { repository, number, failures, error })
    if (failures < READ_FAILURE_LIMIT) return
    this.readFailures.delete(key)
    for (const watch of watches) {
      await this.end(watch, 'unreadable', wakeText({ number, url: `https://${repository}/pull/${number}`, headSha: '' }, [], 'unreadable'))
    }
  }

  /** A rate limit pauses the repository until the reset; it never counts as
   *  a failed read. */
  private pause(repository: string, limited: GitHubRateLimitedError): void {
    const until = limited.retryAt ?? this.now() + RATE_LIMIT_FALLBACK_MS
    this.pausedUntil.set(repository, until)
    log.warn('pr_watch_rate_limited', { repository, retryAt: new Date(until).toISOString() })
  }
}

/** Comments, review bodies and review thread comments, as the rules read them. */
function remarksOf(conversation: PrConversationItem[], threads: ReviewThread[]): WatchRemark[] {
  const remarks: WatchRemark[] = []
  for (const item of conversation) {
    if (item.kind === 'label') continue
    const remark: WatchRemark = { id: item.id, kind: item.kind, author: item.author, body: item.body, at: item.editedAt ?? item.createdAt }
    if (item.url) remark.url = item.url
    remarks.push(remark)
  }
  for (const thread of threads) {
    for (const comment of thread.comments) {
      remarks.push({
        id: comment.id, kind: 'thread-comment', author: comment.author, body: comment.body,
        at: comment.editedAt ?? comment.createdAt, path: thread.filePath,
      })
    }
  }
  return remarks
}

function watchKey(watch: Pick<PullRequestWatch, 'sessionId' | 'repository' | 'number'>): string {
  return `${watch.sessionId}\0${watch.repository}\0${watch.number}`
}

function pullRequestKey(repository: string, number: number): string {
  return `${repository}\0${number}`
}

function splitPullRequestKey(key: string): [string, number] {
  const [repository, number] = key.split('\0')
  return [repository, Number(number)]
}

function sameState(a: PullRequestWatchState, b: PullRequestWatchState): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

