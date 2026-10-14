import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'
import type { PrInterest, PrSyncChange, PullRequest, RepoRef } from '@solus/contracts/providers'
import { getDatabase } from '../db/database'
import { createLogger } from '../logger'
import { ANY_ORGANIZATION } from '../admission/principal'
import { completeTasksForMergedPullRequest } from '../data/tasks/sync-engine'
import { settledSessionIds, settleSessionsWithEndedPullRequests } from '../data/sessions/session-states'
import { sessionIdOfThread } from '../data/sessions/session-lineage'
import { readPrLinkInterests, recordPullRequestObservation, type PrLinkInterest } from '../data/tasks/task-links'
import { unfinishedTaskProjects } from '../data/tasks/task-store'
import { taskSessions } from '../data/tasks/task-sessions'
import { recentWorktreeSessions, sessionRecordsFor } from '../data/tasks/host-records'
import {
  linkSessionPullRequest,
  readSessionPullRequestInterests,
  sessionKnowsPullRequest,
} from '../data/sessions/session-pull-requests'
import { attachReviewAttention } from '../transport/handlers/review-attention'
import { GitHubRateLimitedError } from '../providers/github/rate-limit'
import { asBackgroundWork } from '../providers/github/request-budget'
import { codeHostFor, type CodeHost } from './code-host'
import { prIndex, repoKeyOf } from './pr-index'
import { withBranchRules } from './pull-request'
import { HOST_SCOPE } from '../execution/seats/acting-identity'
import { requireActingScope, withActingScope, withUserScope, type ActingScope } from '../vault/acting-scope'

const log = createLogger('main', 'pr-sync')
/** How often the clock looks for a repository that is due. */
const CLOCK_MS = 5_000
/** Cadence of a repository with interest (docs/plans/pr-sync.md §11). The
 *  open pull requests it tracks are read by number at this cadence; a faster
 *  pass for a review pane reads only check runs. */
const REPOSITORY_MS = 60_000
/** The closed pull requests it tracks are read by number at this cadence:
 *  a closed pull request can open again. A merged one cannot. */
const CLOSED_MS = 15 * 60_000
const REVIEW_MS = 15_000
const CHECKS_IN_FLIGHT_MS = 10_000
/** Live tasks change slowly; their interest is read from the database this often. */
const TASK_INTEREST_MS = 60_000
/** A repository the code host would not answer for waits this long. */
const FAILURE_BACKOFF_MS = 5 * 60_000
/** A branch is asked about for a session that was active this recently. A
 *  link, once made, is kept fresh until its session is settled. */
const BRANCH_LOOKUP_MS = 30 * 24 * 60 * 60_000

/** What PR sync knows about one pull request. `missing`: the code host says
 *  that it does not exist, which is an answer and is not asked again. */
type PrRecord = { result: 'found'; pullRequest: PullRequest } | { result: 'missing' }

/** A live session that runs in its own worktree on a branch. */
export interface LiveCheckout {
  projectScope: string
  branch: string
  /** The stable Solus session id. */
  sessionId: string
}

/** What live work — tasks and sessions — wants kept fresh in one repository. */
interface TaskInterest {
  host: CodeHost
  /** Every link scope that names this repository: its key, and local paths. */
  scopes: Set<string>
  /** Every number a link names, live or not, so an observation reaches it. */
  linked: Set<number>
  /** Numbers live work links whose pull request is open or closed: a closed
   *  one can open again. */
  open: Set<number>
  /** Numbers live work links that were seen merged, with the merge time. A
   *  task can still be waiting on a busy session. */
  merged: Map<number, string>
  /** The sessions whose own worktree is on each branch, by branch. */
  branches: Map<string, string[]>
}

/** What connected clients want kept fresh in one repository, by connection. */
interface ClientInterest {
  host: CodeHost
  owners: Map<string, PrInterest[]>
  /** Whom the repository is read as: the person who last said what they want from it (plans/019). */
  scope: ActingScope
}


/** Everything wanted from one repository this tick. */
interface Wanted {
  numbers: Set<number>
  review: Set<number>
  needsReview: boolean
  /** Branches with no open pull request whose lookup is due: new in the
   *  interest, or a turn of their session ended. */
  branches: Set<string>
  /** A client holds this repository open, so it hears every change. */
  clientsListening: boolean
}

/** One repository's clock and records (docs/plans/pr-sync.md §3.1). */
interface RepositorySync {
  host: CodeHost
  records: Map<number, PrRecord>
  byBranch: Map<string, number>
  /** Branch owners already linked, as `branch#number`. */
  linkedBranches: Set<string>
  /** When each branch was last looked up on the code host. */
  branchesLookedUpAt: Map<string, number>
  nextAt: number
  /** When the open pull requests are next read by number; 0 reads them on
   *  the next pass. */
  numbersAt: number
  /** When the closed pull requests are next read by number. */
  closedNumbersAt: number
  /** Numbers another read path saw in a new state. The next tick reads them
   *  again itself before it writes a link: that other answer is not trusted. */
  reread: Set<number>
  /** Check runs last published, as JSON, by number. */
  checks: Map<number, string>
  checksInFlight: boolean
  /** The open pull requests waiting on the viewer, from the last answer any
   *  read gave; null until one did. */
  needsReview: number[] | null
}

interface Observation {
  number: number
  pullRequest: PullRequest | null
  /** Clients hold an earlier answer that this one replaces. */
  isNews: boolean
}

/** One repository's reads in one tick. */
interface RepositoryRun {
  key: string
  sync: RepositorySync
  wanted: Wanted
  /** Numbers held before this tick: a change to one of them is news. */
  heldBefore: Set<number>
  /** One tick can see a pull request twice (a branch lookup, then a read by
   *  number); the later sight replaces the first. */
  observations: Map<number, Observation>
  /** Numbers a read of this tick answered, changed or not. */
  seen: Set<number>
  /** Check runs that changed since they were last published. */
  checks: NumberedPrChecksSummary[]
  /** A step failed or was skipped; the later steps do not run. */
  stopped: boolean
}

export interface PrSyncDeps {
  publish: (change: PrSyncChange) => void
  /** Whether a Solus session is still mid-turn; a task under one is not finished yet. */
  isSessionBusy?: (sessionId: string) => boolean
  codeHost?: (projectScope: string) => Promise<CodeHost | null>
  now?: () => number
  /** Every complete answer about the pull requests asking the viewer's attention,
   *  as read: the notifications hub records what is new in it (plans/015 §5). */
  observeNeedingAttention?: (repo: RepoRef, viewer: string, pullRequests: PullRequest[]) => Promise<void>
  /** The branches live sessions work on. A machine reads its own checkouts; the
   *  Solus API reads the session records its runners report
   *  (docs/plans/session-archive.md). */
  liveCheckouts?: (now: number) => Promise<LiveCheckout[]>
  /** The person whose connection reads a repository no client asked about, by
   *  user key. A machine reads as itself; the Solus API, which has no connection
   *  of its own, as a person whose live session works in that repository. */
  repositoryReader?: (repositoryKey: string) => string | null
  /** The checkout a session works in, to find the repository of a turn that
   *  ended. A machine reads its session index. */
  sessionCheckout?: (sessionId: string) => string | null
}

/**
 * The one host service that reads pull request state from the code host.
 *
 * A repository is read only while a live task or a connected client has
 * interest in it. A tick reads the open pull requests that live work and
 * clients name, by number, however many tasks, surfaces and devices want
 * them; the repositories of one account share that request. A closed pull
 * request is read by number less often, because it can open again. A branch
 * with no open pull request is looked up by its name when it first joins the
 * interest, when a turn of its session ends, and on a person's refresh, never
 * on a clock. A merged or missing pull request is not read again by number,
 * and its answer is written to the task and session links, so a restart does
 * not ask again either. The pull requests waiting on the viewer come from
 * every list read's review-requested search; PR sync asks for them only when a
 * client wants them and no read has answered yet. Clients hear changes as
 * `pr.changed` and never poll.
 */
export class PrSync {
  private readonly repositories = new Map<string, RepositorySync>()
  private readonly clientInterests = new Map<string, ClientInterest>()
  /** Code hosts that answered with a rate limit, until when. One account's
   *  quota serves every repository on the host, so none is read before then. */
  private readonly rateLimitedUntil = new Map<string, number>()
  private taskInterests = new Map<string, TaskInterest>()
  private taskInterestsAt = 0
  /** Sessions whose turn ended since the last tick, by stable id. */
  private readonly endedTurns = new Set<string>()
  private readonly codeHost: NonNullable<PrSyncDeps['codeHost']>
  private readonly isSessionBusy: NonNullable<PrSyncDeps['isSessionBusy']>
  private readonly liveCheckouts: NonNullable<PrSyncDeps['liveCheckouts']>
  private readonly sessionCheckout: NonNullable<PrSyncDeps['sessionCheckout']>
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private stopHearingReads: Array<() => void> = []
  private running: Promise<void> | null = null
  private rerun = false

  constructor(private readonly deps: PrSyncDeps) {
    this.codeHost = deps.codeHost ?? codeHostFor
    this.isSessionBusy = deps.isSessionBusy ?? (() => false)
    this.liveCheckouts = deps.liveCheckouts ?? liveCheckouts
    this.sessionCheckout = deps.sessionCheckout ?? ((sessionId) => sessionRecordsFor([sessionId]).get(sessionId)?.checkout_path ?? null)
    this.now = deps.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    // Nobody waits on a clock tick, so it leaves GitHub's reserve to people.
    this.timer = setInterval(() => void asBackgroundWork(() => this.tick()), CLOCK_MS)
    this.timer.unref?.()
    this.stopHearingReads = [
      prIndex.onPullRequestRead((repo, pullRequest) => this.hearRead(repo, pullRequest)),
      prIndex.onNeedsReviewRead((repo, viewer, rows) => this.hearNeedsReview(repo, viewer, rows)),
    ]
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const stopHearing of this.stopHearingReads) stopHearing()
    this.stopHearingReads = []
  }

  /**
   * Another read path — a review pane's fresh read, a PR watch — saw a pull
   * request in a state other than the one PR sync holds. Without this, the
   * links, tasks, and sessions waited for the repository's next read by
   * number, up to a minute. The repository is due now, and the tick reads the number
   * again itself; the cost is one read when a state changes.
   */
  private hearRead(repo: RepoRef, pullRequest: PullRequest): void {
    const sync = this.repositories.get(repoKeyOf(repo).toLowerCase())
    const record = sync?.records.get(pullRequest.number)
    if (!sync || record?.result !== 'found' || record.pullRequest.state === pullRequest.state) return
    sync.reread.add(pullRequest.number)
    sync.nextAt = 0
    void this.tick()
  }

  /**
   * A new answer about the pull requests waiting on a viewer: the
   * review-requested search of a list read, or PR sync's own read. The
   * notifications hub records what is new in it. A repository PR sync holds
   * keeps the answer, and its clients hear when it changed.
   */
  private hearNeedsReview(repo: RepoRef, viewer: string, answer: PullRequest[]): void {
    void this.deps.observeNeedingAttention?.(repo, viewer, answer).catch((error) => {
      log.warn('pr_sync_attention_observation_failed', { repo: repoKeyOf(repo), error: error instanceof Error ? error.message : String(error) })
    })
    const sync = this.repositories.get(repoKeyOf(repo).toLowerCase())
    if (sync) this.keepNeedsReview(sync, viewer, answer)
  }

  /** Keep an answer about the pull requests waiting on the viewer, and
   *  publish it when the numbers changed. */
  private keepNeedsReview(sync: RepositorySync, viewer: string, answer: PullRequest[]): void {
    const rows = attachReviewAttention(answer, viewer)
      .filter((pullRequest) => pullRequest.needsMyReview)
      .map((pullRequest) => withHeldBranchRules(sync.host, pullRequest))
    const numbers = rows.map(({ number }) => number).sort((a, b) => a - b)
    if (sync.needsReview && sync.needsReview.join() === numbers.join()) return
    for (const row of rows) sync.records.set(row.number, { result: 'found', pullRequest: row })
    sync.needsReview = numbers
    this.deps.publish({ repo: repoKeyOf(sync.host.repo).toLowerCase(), pullRequests: rows, missing: [], checks: [], needsReview: numbers })
  }

  /** Run every repository that is due. A call during a run runs once more after it. */
  tick(): Promise<void> {
    if (this.running) {
      this.rerun = true
      return this.running
    }
    // The tick's own work is the host's; each repository then runs as whoever wants it.
    const run = withActingScope(HOST_SCOPE, () => this.runTick()).catch((error) => {
      log.warn('pr_sync_tick_failed', { error: String(error) })
    }).finally(() => {
      this.running = null
      if (!this.rerun) return
      this.rerun = false
      // Returned so that everyone waiting on this run also waits for the rerun.
      return this.tick()
    })
    this.running = run
    return run
  }

  /**
   * Replace one connection's interest in a repository, and answer what is
   * known about what it asked for. Anything not known yet makes the
   * repository due now; the answer arrives as `pr.changed`.
   */
  setInterest(ownerId: string, host: CodeHost, interests: PrInterest[]): PrSyncChange {
    const key = repoKeyOf(host.repo).toLowerCase()
    const scope = requireActingScope('pull request sync')
    const entry = this.clientInterests.get(key) ?? { host, owners: new Map<string, PrInterest[]>(), scope }
    entry.scope = scope
    if (interests.length) {
      entry.owners.set(ownerId, interests)
      this.clientInterests.set(key, entry)
    } else {
      entry.owners.delete(ownerId)
      if (!entry.owners.size) this.clientInterests.delete(key)
    }
    const sync = this.syncFor(key, host)
    if (interests.some((interest) => !isAnswered(sync, interest))) {
      sync.nextAt = 0
      void this.tick()
    }
    return snapshotOf(key, sync, interests)
  }

  /**
   * A turn ended in a session. Its agent may have pushed a branch or opened a
   * pull request, so this tick looks up the branches of its checkouts that
   * have no open pull request, and a list that shows its repository reads its
   * first page again (`listChanged`). The answer arrives as `pr.changed`.
   */
  async turnEnded(sessionId: string): Promise<void> {
    this.endedTurns.add(sessionId)
    // A new checkout, or a branch the agent made, joins the interest now.
    this.taskInterestsAt = 0
    void this.tick()
    const checkout = this.sessionCheckout(sessionId)
    const host = checkout ? await this.codeHost(checkout).catch(() => null) : null
    if (!host) return
    // The lists the server holds are older than the turn.
    prIndex.invalidate(host.repo)
    this.deps.publish({ repo: repoKeyOf(host.repo).toLowerCase(), pullRequests: [], missing: [], checks: [], listChanged: true })
  }

  /** Every connection closed at once, as when the transport rebinds. */
  dropClients(): void {
    this.clientInterests.clear()
  }

  /** A closed connection wants nothing, for any of its projects. Owner ids
   *  are the connection id, or `connection#project`. */
  dropConnection(clientId: string): void {
    for (const [key, entry] of this.clientInterests) {
      for (const ownerId of entry.owners.keys()) {
        if (ownerId === clientId || ownerId.startsWith(`${clientId}#`)) entry.owners.delete(ownerId)
      }
      if (!entry.owners.size) this.clientInterests.delete(key)
    }
  }

  /** A person's refresh: forget what was remembered and read the repository
   *  now. The answer arrives as `pr.changed`. */
  refresh(host: CodeHost): void {
    prIndex.invalidate(host.repo)
    const sync = this.syncFor(repoKeyOf(host.repo).toLowerCase(), host)
    sync.needsReview = null
    sync.nextAt = 0
    sync.numbersAt = 0
    sync.closedNumbersAt = 0
    sync.branchesLookedUpAt.clear()
    void this.tick()
  }

  /** A write's answer: the host's word on the pull request it changed. */
  async apply(host: CodeHost, answer: PullRequest): Promise<void> {
    const key = repoKeyOf(host.repo).toLowerCase()
    const pullRequest = withHeldBranchRules(host, answer)
    const sync = this.repositories.get(key)
    sync?.records.set(pullRequest.number, { result: 'found', pullRequest })
    seedIndex(host, pullRequest)
    const scopes = this.taskInterests.get(key)?.scopes ?? new Set([key])
    await recordPullRequestObservation([...scopes], pullRequest.number, pullRequest)
    this.deps.publish({ repo: key, pullRequests: [pullRequest], missing: [], checks: [] })
  }

  private syncFor(key: string, host: CodeHost): RepositorySync {
    let sync = this.repositories.get(key)
    if (!sync) {
      sync = {
        host, records: new Map(), byBranch: new Map(), linkedBranches: new Set(), branchesLookedUpAt: new Map(),
        nextAt: 0, numbersAt: 0, closedNumbersAt: 0, reread: new Set(), checks: new Map(), checksInFlight: false, needsReview: null,
      }
      this.repositories.set(key, sync)
    }
    return sync
  }

  private async runTick(): Promise<void> {
    if (this.now() >= this.taskInterestsAt) {
      this.taskInterests = await this.readTaskInterests()
      this.taskInterestsAt = this.now() + TASK_INTEREST_MS
    }
    const keys = new Set([...this.taskInterests.keys(), ...this.clientInterests.keys()])
    for (const key of this.repositories.keys()) {
      if (!keys.has(key)) this.repositories.delete(key)
    }
    const endedTurns = new Set(this.endedTurns)
    this.endedTurns.clear()
    const runs: RepositoryRun[] = []
    for (const key of keys) {
      const host = this.clientInterests.get(key)?.host ?? this.taskInterests.get(key)?.host
      if (!host) continue
      const sync = this.syncFor(key, host)
      const turnEnded = [...this.taskInterests.get(key)?.branches.values() ?? []].some((owners) => owners.some((id) => endedTurns.has(id)))
      if ((sync.nextAt > this.now() && !turnEnded) || (this.rateLimitedUntil.get(host.repo.host) ?? 0) > this.now()) continue
      runs.push({
        key, sync, wanted: this.wantedIn(key, sync, endedTurns), heldBefore: new Set(sync.records.keys()),
        observations: new Map(), seen: new Set(), checks: [], stopped: false,
      })
    }
    // Each read of every repository goes at once, and the reads of one
    // account share its documents (docs/plans/pr-sync.md §11). A spent quota
    // fails the one document that found it, and every repository in it.
    await Promise.all(runs.map((run) => this.step(run, () => this.readBranches(run))))
    await Promise.all(runs.map((run) => this.step(run, () => this.readNumbers(run))))
    await Promise.all(runs.map((run) => this.step(run, () => this.readChecks(run))))
    for (const run of runs) await this.step(run, () => this.readNeedsReview(run))
    // The records already hold what the reads found, so it is written and
    // published also when a later read of the repository stopped.
    for (const run of runs) await this.finish(run)
    for (const { sync, wanted, stopped } of runs) {
      if (stopped) continue
      sync.nextAt = this.now() + cadenceOf(sync, wanted)
    }
    await this.settleSessions()
  }

  /** One step of one repository's tick, read as its reader. A failure, or a
   *  rate limit on its code host, stops the repository's tick. */
  private async step(run: RepositoryRun, read: () => Promise<void>): Promise<void> {
    const { key, sync } = run
    if (run.stopped || (this.rateLimitedUntil.get(sync.host.repo.host) ?? 0) > this.now()) {
      run.stopped = true
      return
    }
    try {
      await this.readAsItsReader(key, read)
    } catch (error) {
      run.stopped = true
      if (error instanceof GitHubRateLimitedError) {
        sync.nextAt = error.retryAt ?? this.now() + FAILURE_BACKOFF_MS
        this.rateLimitedUntil.set(sync.host.repo.host, sync.nextAt)
        log.warn('pr_sync_rate_limited', { repository: key, retryAt: new Date(sync.nextAt).toISOString() })
        return
      }
      sync.nextAt = this.now() + FAILURE_BACKOFF_MS
      log.warn('pr_sync_repository_failed', { repository: key, error: String(error) })
    }
  }

  /**
   * Each repository is read as the person who wants it, whatever started this
   * tick. One only live work wants is read as the host, as the task sync's own
   * clock is; at the Solus API, which has no connection of its own, as a person
   * whose live session works in it.
   */
  private readAsItsReader(key: string, read: () => Promise<void>): Promise<void> {
    const scope = this.clientInterests.get(key)?.scope
    if (scope) return withActingScope(scope, read)
    const reader = this.deps.repositoryReader?.(key)
    return reader ? withUserScope(reader, read) : withActingScope(HOST_SCOPE, read)
  }

  private wantedIn(key: string, sync: RepositorySync, endedTurns: Set<string>): Wanted {
    const task = this.taskInterests.get(key)
    const clients = this.clientInterests.get(key)
    const wanted: Wanted = {
      numbers: new Set(task?.open),
      review: new Set(),
      needsReview: false,
      branches: new Set(),
      clientsListening: !!clients,
    }
    /** A matched pull request is read by number; a branch with no open one is
     *  looked up when it is new in the interest or its session's turn ended. */
    const wantBranch = (branch: string, turnEnded: boolean): void => {
      const number = sync.byBranch.get(branch)
      const record = number === undefined ? undefined : sync.records.get(number)
      if (number !== undefined) wanted.numbers.add(number)
      if (record?.result === 'found' && record.pullRequest.state === 'open') return
      if (!sync.branchesLookedUpAt.has(branch) || turnEnded) wanted.branches.add(branch)
    }
    for (const [branch, owners] of task?.branches ?? []) wantBranch(branch, owners.some((id) => endedTurns.has(id)))
    for (const interests of clients?.owners.values() ?? []) {
      for (const interest of interests) {
        if (interest.kind === 'pull-request') wanted.numbers.add(interest.number)
        else if (interest.kind === 'review') {
          wanted.numbers.add(interest.number)
          wanted.review.add(interest.number)
        } else if (interest.kind === 'branch') wantBranch(interest.head, false)
        else wanted.needsReview = true
      }
    }
    return wanted
  }

  /** What the reads of this tick found reaches the links, the tasks, and
   *  the clients, one repository at a time. */
  private async finish(run: RepositoryRun): Promise<void> {
    try {
      await this.readAsItsReader(run.key, () => this.finishRepository(run))
    } catch (error) {
      run.stopped = true
      run.sync.nextAt = this.now() + FAILURE_BACKOFF_MS
      log.warn('pr_sync_repository_failed', { repository: run.key, error: String(error) })
    }
  }

  private async finishRepository(run: RepositoryRun): Promise<void> {
    const { key, sync, wanted, checks } = run
    const observations = [...run.observations.values()]
    const task = this.taskInterests.get(key)
    if (task) {
      for (const { number, pullRequest } of observations) {
        if (task.linked.has(number)) await recordPullRequestObservation([...task.scopes], number, pullRequest)
      }
    }
    const published = wanted.clientsListening ? observations : observations.filter(({ isNews }) => isNews)
    if (published.length || checks.length) {
      this.deps.publish({
        repo: key,
        pullRequests: published.flatMap(({ pullRequest }) => pullRequest ? [pullRequest] : []),
        missing: published.flatMap(({ number, pullRequest }) => pullRequest ? [] : [number]),
        checks,
      })
    }
    if (task) {
      await this.linkBranches(sync, task)
      await this.completeMerges(sync, task)
    }
  }

  /**
   * Settle the sessions whose pull requests all ended
   * (docs/plans/session-pull-requests.md). A settled session is no longer
   * live work, so interest is read again.
   */
  private async settleSessions(): Promise<void> {
    const settled = await settleSessionsWithEndedPullRequests(this.isSessionBusy)
    if (!settled.length) return
    log.info('pr_sync_sessions_settled', { count: settled.length })
    this.taskInterestsAt = 0
  }

  /** The pull requests of each branch whose lookup is due. The branch
   *  matches its open pull request, or else its newest one. */
  private async readBranches(run: RepositoryRun): Promise<void> {
    const { sync, wanted } = run
    if (!wanted.branches.size) return
    const { repo, provider } = sync.host
    const heads = [...wanted.branches]
    const found = await provider.review.getPullRequestsByHead(repo, heads)
    for (const head of heads) {
      sync.branchesLookedUpAt.set(head, this.now())
      const rows = found.get(head) ?? []
      const pullRequest = rows.find(({ state }) => state === 'open') ?? rows[0]
      if (!pullRequest) continue
      observe(run, pullRequest.number, pullRequest)
      sync.byBranch.set(head, pullRequest.number)
    }
  }

  /**
   * Numbers never seen, numbers another read path saw change, each
   * `REPOSITORY_MS` the open pull requests that are wanted, and each
   * `CLOSED_MS` the closed ones. A merged or missing one is not read again;
   * nor is one this tick has read.
   */
  private async readNumbers(run: RepositoryRun): Promise<void> {
    const { sync, wanted } = run
    const isDue = this.now() >= sync.numbersAt
    const isClosedDue = this.now() >= sync.closedNumbersAt
    const numbers = [...new Set([...wanted.numbers, ...sync.reread])].filter((number) => {
      if (run.seen.has(number)) return false
      const record = sync.records.get(number)
      if (!record || sync.reread.has(number)) return true
      if (record.result !== 'found') return false
      const { state } = record.pullRequest
      return (isDue && state === 'open') || (isClosedDue && state === 'closed')
    })
    sync.reread.clear()
    if (isDue) sync.numbersAt = this.now() + REPOSITORY_MS
    if (isClosedDue) sync.closedNumbersAt = this.now() + CLOSED_MS
    if (!numbers.length) return
    const { repo, provider } = sync.host
    for (const [number, pullRequest] of await provider.review.getPullRequests(repo, numbers)) observe(run, number, pullRequest)
  }

  /**
   * Check runs of the pull requests an open review pane shows. Only what
   * changed is published. The checks of a merged or closed pull request are
   * read once, and again only when it opens again.
   */
  private async readChecks(run: RepositoryRun): Promise<void> {
    const { sync, wanted } = run
    const numbers = [...wanted.review].filter((number) => {
      const record = sync.records.get(number)
      return record?.result === 'found' && (record.pullRequest.state === 'open' || !sync.checks.has(number))
    })
    if (!numbers.length) {
      sync.checksInFlight = false
      return
    }
    const { repo, provider } = sync.host
    const summaries = await provider.review.listChecks(repo, numbers)
    prIndex.absorbChecks(repo, provider, summaries)
    sync.checksInFlight = summaries.some(({ summary }) => summary.inFlight)
    run.checks = summaries.filter((summary) => {
      const json = JSON.stringify(summary.summary)
      if (sync.checks.get(summary.number) === json) return false
      sync.checks.set(summary.number, json)
      return true
    })
  }

  /**
   * The open pull requests waiting on the viewer, when a client shows that
   * count and no read has answered it yet: a new interest, or a person's
   * refresh. After that, list reads keep it current (`hearNeedsReview`);
   * no clock asks again.
   */
  private async readNeedsReview(run: RepositoryRun): Promise<void> {
    const { sync, wanted } = run
    if (!wanted.needsReview || sync.needsReview !== null) return
    const { repo, provider } = sync.host
    const viewer = await provider.review.getViewer(repo)
    // A new answer reaches `hearNeedsReview` first; a remembered one is kept here.
    this.keepNeedsReview(sync, viewer, await prIndex.listNeedsReview(repo, provider, viewer))
  }

  private async linkBranches(sync: RepositorySync, task: TaskInterest): Promise<void> {
    for (const [branch, owners] of task.branches) {
      const number = sync.byBranch.get(branch)
      const record = number === undefined ? undefined : sync.records.get(number)
      if (record?.result !== 'found' || sync.linkedBranches.has(`${branch}#${number}`)) continue
      await this.linkBranchOwners(record.pullRequest, branch, owners)
      sync.linkedBranches.add(`${branch}#${number}`)
    }
  }

  /** Every merged pull request live work links, asked each tick: a task under
   *  a busy session waits for a later one. This costs no request. */
  private async completeMerges(sync: RepositorySync, task: TaskInterest): Promise<void> {
    const merged = new Map(task.merged)
    for (const number of task.open) {
      const record = sync.records.get(number)
      if (record?.result === 'found' && record.pullRequest.state === 'merged') {
        merged.set(number, record.pullRequest.updatedAt)
      }
    }
    for (const [number, mergedAt] of merged) {
      for (const scope of task.scopes) {
        await completeTasksForMergedPullRequest(ANY_ORGANIZATION, scope, number, {
          mergedAt,
          isSessionBusy: this.isSessionBusy,
        })
      }
    }
  }

  /**
   * Link a pull request found on a branch to each session whose own worktree
   * is on that branch. The session owns the link; its task, when it has one,
   * reads it (docs/plans/session-pull-requests.md). A session that already has
   * a row for the pull request keeps it, a row a person dismissed included.
   */
  private async linkBranchOwners(pullRequest: PullRequest, branch: string, sessionIds: string[]): Promise<void> {
    const repositoryKey = repoKeyOf(pullRequest.baseRepo)
    const live = new Set((await this.liveCheckouts(this.now())).flatMap((checkout) =>
      checkout.branch === branch ? [checkout.sessionId] : []))
    for (const sessionId of sessionIds) {
      if (!live.has(sessionId)) continue
      if (await sessionKnowsPullRequest(sessionId, repositoryKey, pullRequest.number)) continue
      await linkSessionPullRequest(sessionId, {
        url: pullRequest.url, title: pullRequest.title, source: 'branch', by: { kind: 'system' },
      })
    }
  }

  /** Interest from live work: the pull requests that tasks and sessions link,
   *  and the branches of live isolated checkouts. A scope is resolved once per
   *  read. */
  private async readTaskInterests(): Promise<Map<string, TaskInterest>> {
    const hosts = new Map<string, CodeHost | null>()
    const hostFor = async (scope: string): Promise<CodeHost | null> => {
      if (!hosts.has(scope)) {
        hosts.set(scope, await this.codeHost(scope).catch((error) => {
          log.warn('pr_sync_scope_unresolved', { projectRoot: scope, error: String(error) })
          return null
        }))
      }
      return hosts.get(scope) ?? null
    }
    const interests = new Map<string, TaskInterest>()
    const interestFor = (host: CodeHost): TaskInterest => {
      const key = repoKeyOf(host.repo).toLowerCase()
      let interest = interests.get(key)
      if (!interest) {
        interest = { host, scopes: new Set([key]), linked: new Set(), open: new Set(), merged: new Map(), branches: new Map() }
        interests.set(key, interest)
      }
      return interest
    }

    const links = [
      ...await readPrLinkInterests(getDatabase(), ANY_ORGANIZATION),
      ...await sessionLinkInterests(),
    ]
    for (const link of links) {
      if (!link.isActive || link.state === 'missing') continue
      const host = await hostFor(link.projectScope)
      if (!host) continue
      const interest = interestFor(host)
      if (link.state !== 'merged') interest.open.add(link.number)
      else if (link.updatedAt) interest.merged.set(link.number, link.updatedAt)
    }
    for (const { projectScope, branch, sessionId } of await this.liveCheckouts(this.now())) {
      const host = await hostFor(projectScope)
      if (!host) continue
      const owners = interestFor(host).branches
      owners.set(branch, [...owners.get(branch) ?? [], sessionId])
    }
    // Links of finished work make no repository worth a tick, but an answer
    // PR sync reads anyway should still reach them.
    for (const link of links) {
      const host = await hostFor(link.projectScope)
      const interest = host ? interests.get(repoKeyOf(host.repo).toLowerCase()) : undefined
      if (!interest) continue
      interest.scopes.add(link.projectScope)
      interest.linked.add(link.number)
    }
    return interests
  }
}

/** The sessions that work under a task that is not finished, and the
 *  isolated checkouts of those sessions. */
async function liveTaskSessions(): Promise<{ checkouts: LiveCheckout[]; sessionIds: Set<string> }> {
  const unfinished = await unfinishedTaskProjects(ANY_ORGANIZATION)
  const sessions = await taskSessions(ANY_ORGANIZATION, [...unfinished.keys()])
  const checkouts: LiveCheckout[] = []
  const sessionIds = new Set<string>()
  for (const [taskId, projectKey] of unfinished) {
    for (const attempt of sessions[taskId] ?? []) {
      if (attempt.role === 'referenced') continue
      sessionIds.add(attempt.sessionId)
      if (projectKey && attempt.isolatedCheckout && attempt.branch) {
        checkouts.push({ projectScope: projectKey, branch: attempt.branch, sessionId: attempt.sessionId })
      }
    }
  }
  return { checkouts, sessionIds }
}

/**
 * The branch of each isolated checkout that live work runs in: the sessions of
 * tasks that are not finished, and the sessions active recently that are not
 * settled. A settled session is not live work.
 */
async function liveCheckouts(now: number): Promise<LiveCheckout[]> {
  const { checkouts } = await liveTaskSessions()
  const seen = new Set(checkouts.map((checkout) => `${checkout.sessionId}\0${checkout.branch}`))
  const recent = recentWorktreeSessions(now - BRANCH_LOOKUP_MS)
    .map((indexed) => ({ ...indexed, sessionId: sessionIdOfThread(indexed.sessionId) }))
  const settled = await settledSessionIds(recent.map((indexed) => indexed.sessionId))
  for (const { sessionId, branch, projectScope } of recent) {
    if (settled.has(sessionId) || seen.has(`${sessionId}\0${branch}`)) continue
    seen.add(`${sessionId}\0${branch}`)
    checkouts.push({ projectScope, branch, sessionId })
  }
  return checkouts
}

/**
 * The pull requests sessions link, as PR sync's interest reads them. A link is live
 * work until its session is settled; a task that is not finished keeps the
 * links of its sessions live, because the task reads them.
 */
async function sessionLinkInterests(): Promise<PrLinkInterest[]> {
  const { sessionIds: ofLiveTask } = await liveTaskSessions()
  const links = await readSessionPullRequestInterests(ANY_ORGANIZATION)
  const settled = await settledSessionIds([...new Set(links.map((link) => link.sessionId))])
  return links.map((link) => ({
    projectScope: link.repository,
    number: link.number,
    isActive: ofLiveTask.has(link.sessionId) || !settled.has(link.sessionId),
    state: link.state,
    updatedAt: link.updatedAt,
  }))
}

/** One sight of a pull request in a tick. */
function observe(run: RepositoryRun, number: number, row: PullRequest | null): void {
  const { sync } = run
  const pullRequest = row && withHeldBranchRules(sync.host, row)
  const previous = sync.records.get(number)
  run.seen.add(number)
  sync.records.set(number, pullRequest ? { result: 'found', pullRequest } : { result: 'missing' })
  if (pullRequest && (!sync.byBranch.has(pullRequest.headRef) || pullRequest.state === 'open')) {
    sync.byBranch.set(pullRequest.headRef, number)
  }
  if (previous && !recordChanged(previous, pullRequest)) return
  if (pullRequest) seedIndex(sync.host, pullRequest)
  run.observations.set(number, { number, pullRequest, isNews: run.heldBefore.has(number) })
}

/** A review pane of a merged or closed pull request keeps the minute: its
 *  checks are not polled. */
function cadenceOf(sync: RepositorySync, wanted: Wanted): number {
  const openReview = [...wanted.review].some((number) => {
    const record = sync.records.get(number)
    return record?.result === 'found' && record.pullRequest.state === 'open'
  })
  if (!openReview) return REPOSITORY_MS
  return sync.checksInFlight ? CHECKS_IN_FLIGHT_MS : REVIEW_MS
}

/** Whether PR sync already holds an answer for this interest. */
function isAnswered(sync: RepositorySync, interest: PrInterest): boolean {
  if (interest.kind === 'pull-request') return sync.records.has(interest.number)
  if (interest.kind === 'review') return sync.records.has(interest.number) && sync.checks.has(interest.number)
  if (interest.kind === 'branch') return sync.byBranch.has(interest.head) || sync.branchesLookedUpAt.has(interest.head)
  return sync.needsReview !== null
}

/** What is known about what one connection asked for. */
function snapshotOf(key: string, sync: RepositorySync, interests: PrInterest[]): PrSyncChange {
  const numbers = new Set<number>()
  for (const interest of interests) {
    if (interest.kind === 'pull-request' || interest.kind === 'review') numbers.add(interest.number)
    else if (interest.kind === 'branch') {
      const number = sync.byBranch.get(interest.head)
      if (number !== undefined) numbers.add(number)
    } else if (interest.kind === 'needs-review') for (const number of sync.needsReview ?? []) numbers.add(number)
  }
  const change: PrSyncChange = { repo: key, pullRequests: [], missing: [], checks: [] }
  for (const number of numbers) {
    const record = sync.records.get(number)
    if (record?.result === 'found') change.pullRequests.push(withHeldBranchRules(sync.host, record.pullRequest))
    else if (record?.result === 'missing') change.missing.push(number)
  }
  const review = new Set(interests.flatMap((interest) => interest.kind === 'review' ? [interest.number] : []))
  change.checks = prIndex.checksFor(sync.host.repo, [...review])
  if (sync.needsReview && interests.some((interest) => interest.kind === 'needs-review')) {
    change.needsReview = sync.needsReview
  }
  return change
}

/** A row with the base branch rules of the detail this server holds for
 *  its pull request. Without one, no client shows a detail of it from this
 *  server, so the row's repository-level merge methods widen nothing. */
function withHeldBranchRules({ repo }: CodeHost, row: PullRequest): PullRequest {
  return withBranchRules(row, prIndex.lastRead(repoKeyOf(repo), row.number))
}

/** Share a row with other readers of the pull request, unless one of them
 *  already holds a newer answer. */
function seedIndex({ repo, provider }: CodeHost, pullRequest: PullRequest): void {
  const entity = prIndex.pullRequest(repo, provider, pullRequest.number)
  const known = entity.lastRead()
  if (!known || Date.parse(pullRequest.updatedAt) > Date.parse(known.updatedAt)) entity.seed(pullRequest)
}

function recordChanged(previous: PrRecord, next: PullRequest | null): boolean {
  if (previous.result === 'missing' || !next) return previous.result !== (next ? 'found' : 'missing')
  return previous.pullRequest.updatedAt !== next.updatedAt || previous.pullRequest.state !== next.state
}
