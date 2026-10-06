import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'
import type { PrInterest, PrSyncChange, PullRequest, RepoRef } from '@solus/contracts/providers'
import { getDatabase } from '../db/database'
import { createLogger } from '../logger'
import { ANY_ORGANIZATION } from '../admission/principal'
import { completeTasksForMergedPullRequest } from '../data/tasks/sync-engine'
import { settledSessionIds, settleIdleSessions, settleSessionsWithEndedPullRequests } from '../data/sessions/session-states'
import { sessionIdOfThread } from '../data/sessions/session-lineage'
import { readPrLinkWatchList, recordPullRequestObservation, type PrLinkWatch } from '../data/tasks/task-links'
import { unfinishedTaskProjects } from '../data/tasks/task-store'
import { taskSessions } from '../data/tasks/task-sessions'
import { recentWorktreeSessions } from '../data/tasks/host-records'
import {
  linkSessionPullRequest,
  readSessionPullRequestWatchList,
  sessionKnowsPullRequest,
} from '../data/sessions/session-pull-requests'
import { attachReviewAttention } from '../transport/handlers/review-attention'
import { GitHubRateLimitedError } from '../providers/github/rate-limit'
import { codeHostFor, type CodeHost } from './code-host'
import { prIndex, repoKeyOf } from './pr-index'

const log = createLogger('main', 'pr-sync')
/** How often the clock looks for a repository that is due. */
const CLOCK_MS = 5_000
/** Cadence of a repository with interest (docs/plans/pr-sync.md §11). The
 *  recent list keeps this cadence; a faster pass for a review pane reads only
 *  check runs. */
const REPOSITORY_MS = 60_000
const REVIEW_MS = 15_000
const CHECKS_IN_FLIGHT_MS = 10_000
const NEEDS_REVIEW_MS = 5 * 60_000
/** Live tasks change slowly; their interest is read from the database this often. */
const TASK_INTEREST_MS = 60_000
/** A repository the code host would not answer for waits this long. */
const FAILURE_BACKOFF_MS = 5 * 60_000
/** A branch is asked about for a session that was active this recently. A
 *  link, once made, is watched until its session is settled. */
const BRANCH_LOOKUP_MS = 30 * 24 * 60 * 60_000

/** What PR sync knows about one pull request. `missing`: the code host says
 *  that it does not exist, which is an answer and is not asked again. */
type PrRecord = { result: 'found'; pullRequest: PullRequest } | { result: 'missing' }

/** A live session that runs in its own worktree on a branch. */
interface LiveCheckout {
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
  /** Numbers live work links whose pull request is not settled. */
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
}

/** Everything wanted from one repository this tick. */
interface Wanted {
  numbers: Set<number>
  review: Set<number>
  needsReview: boolean
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
  watermark: string | null
  /** When a tick last read this repository; 0 before the first. */
  syncedAt: number
  nextAt: number
  /** When the recent list is next read; 0 reads it on the next pass. */
  listAt: number
  /** Check runs last published, as JSON, by number. */
  checks: Map<number, string>
  checksInFlight: boolean
  needsReview: number[] | null
  needsReviewAt: number
}

interface Observation {
  number: number
  pullRequest: PullRequest | null
  /** Clients hold an earlier answer that this one replaces. */
  isNews: boolean
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
}

/**
 * The one host service that reads pull request state from the code host.
 *
 * A repository is read only while a live task or a connected client has
 * interest in it. A tick costs one request, however many tasks, surfaces and
 * devices want the repository: the pull requests updated since the last tick.
 * Numbers never seen are read in one batch. A merged, closed, or missing pull
 * request is not read again by number, and its answer is written to the task
 * and session links, so a restart does not ask again either. Clients hear changes as
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
  private readonly codeHost: NonNullable<PrSyncDeps['codeHost']>
  private readonly isSessionBusy: NonNullable<PrSyncDeps['isSessionBusy']>
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private rerun = false

  constructor(private readonly deps: PrSyncDeps) {
    this.codeHost = deps.codeHost ?? codeHostFor
    this.isSessionBusy = deps.isSessionBusy ?? (() => false)
    this.now = deps.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), CLOCK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Run every repository that is due. A call during a run runs once more after it. */
  tick(): Promise<void> {
    if (this.running) {
      this.rerun = true
      return this.running
    }
    const run = this.runTick().catch((error) => {
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
    const entry = this.clientInterests.get(key) ?? { host, owners: new Map<string, PrInterest[]>() }
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
    sync.needsReviewAt = 0
    sync.nextAt = 0
    sync.listAt = 0
    void this.tick()
  }

  /** A write's answer: the host's word on the pull request it changed. */
  async apply(host: CodeHost, pullRequest: PullRequest): Promise<void> {
    const key = repoKeyOf(host.repo).toLowerCase()
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
        host, records: new Map(), byBranch: new Map(), linkedBranches: new Set(),
        watermark: null, syncedAt: 0, nextAt: 0, listAt: 0, checks: new Map(), checksInFlight: false, needsReview: null, needsReviewAt: 0,
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
    for (const key of keys) {
      const host = this.clientInterests.get(key)?.host ?? this.taskInterests.get(key)?.host
      if (!host) continue
      const sync = this.syncFor(key, host)
      if (sync.nextAt > this.now() || (this.rateLimitedUntil.get(host.repo.host) ?? 0) > this.now()) continue
      const wanted = this.wantedIn(key)
      try {
        await this.syncRepository(key, sync, wanted)
        sync.syncedAt = this.now()
        sync.nextAt = this.now() + cadenceOf(sync, wanted)
      } catch (error) {
        if (error instanceof GitHubRateLimitedError) {
          sync.nextAt = error.retryAt ?? this.now() + FAILURE_BACKOFF_MS
          this.rateLimitedUntil.set(host.repo.host, sync.nextAt)
          log.warn('pr_sync_rate_limited', { repository: key, retryAt: new Date(sync.nextAt).toISOString() })
          continue
        }
        sync.nextAt = this.now() + FAILURE_BACKOFF_MS
        log.warn('pr_sync_repository_failed', { repository: key, error: String(error) })
      }
    }
    await this.settleSessions()
  }

  private wantedIn(key: string): Wanted {
    const task = this.taskInterests.get(key)
    const clients = this.clientInterests.get(key)
    const wanted: Wanted = {
      numbers: new Set(task?.open),
      review: new Set(),
      needsReview: false,
      clientsListening: !!clients,
    }
    for (const interests of clients?.owners.values() ?? []) {
      for (const interest of interests) {
        if (interest.kind === 'pull-request') wanted.numbers.add(interest.number)
        else if (interest.kind === 'review') {
          wanted.numbers.add(interest.number)
          wanted.review.add(interest.number)
        } else if (interest.kind === 'needs-review') wanted.needsReview = true
      }
    }
    return wanted
  }

  private async syncRepository(key: string, sync: RepositorySync, wanted: Wanted): Promise<void> {
    const observations = await this.readChanges(sync, wanted)
    const checks = await this.readChecks(sync, wanted)
    const needsReview = await this.readNeedsReview(sync, wanted, observations)
    const task = this.taskInterests.get(key)
    if (task) {
      for (const { number, pullRequest } of observations) {
        if (task.linked.has(number)) await recordPullRequestObservation([...task.scopes], number, pullRequest)
      }
    }
    const published = wanted.clientsListening ? observations : observations.filter(({ isNews }) => isNews)
    if (published.length || checks.length || needsReview) {
      const change: PrSyncChange = {
        repo: key,
        pullRequests: published.flatMap(({ pullRequest }) => pullRequest ? [pullRequest] : []),
        missing: published.flatMap(({ number, pullRequest }) => pullRequest ? [] : [number]),
        checks,
      }
      if (needsReview) change.needsReview = needsReview
      this.deps.publish(change)
    }
    if (task) {
      await this.linkBranches(sync, task)
      await this.completeMerges(sync, task)
    }
  }

  /**
   * Settle the sessions whose work ended: every pull request of the session
   * is merged or closed, or the session had no prompt for a long time
   * (docs/plans/session-pull-requests.md). A settled session is no longer
   * live work, so interest is read again.
   */
  private async settleSessions(): Promise<void> {
    const settled = [
      ...await settleSessionsWithEndedPullRequests(this.isSessionBusy),
      ...await settleIdleSessions(this.isSessionBusy, this.now()),
    ]
    if (!settled.length) return
    log.info('pr_sync_sessions_settled', { count: settled.length })
    this.taskInterestsAt = 0
  }

  /**
   * One tick's reads: what changed since the last list read, when the list is
   * due, and linked numbers never seen. Branches match these stored rows; an
   * unmatched branch costs no read.
   */
  private async readChanges(sync: RepositorySync, wanted: Wanted): Promise<Observation[]> {
    const { repo, provider } = sync.host
    // News is a change since an earlier tick. One tick can see a pull request
    // twice (a recent-list read, then a numbered read); the later sight replaces it.
    const heldBefore = new Set(sync.records.keys())
    const observations = new Map<number, Observation>()
    const observe = (number: number, pullRequest: PullRequest | null) => {
      const previous = sync.records.get(number)
      sync.records.set(number, pullRequest ? { result: 'found', pullRequest } : { result: 'missing' })
      if (pullRequest && (!sync.byBranch.has(pullRequest.headRef) || pullRequest.state === 'open')) {
        sync.byBranch.set(pullRequest.headRef, number)
      }
      if (previous && !recordChanged(previous, pullRequest)) return
      if (pullRequest) seedIndex(sync.host, pullRequest)
      observations.set(number, { number, pullRequest, isNews: heldBefore.has(number) })
    }

    if (this.now() >= sync.listAt) {
      for (const pullRequest of await provider.review.listRecentPullRequests(repo, sync.watermark)) {
        observe(pullRequest.number, pullRequest)
        if (!sync.watermark || pullRequest.updatedAt > sync.watermark) sync.watermark = pullRequest.updatedAt
      }
      sync.listAt = this.now() + REPOSITORY_MS
    }
    const unknown = [...wanted.numbers].filter((number) => !sync.records.has(number))
    if (unknown.length) {
      for (const [number, pullRequest] of await provider.review.getPullRequests(repo, unknown)) observe(number, pullRequest)
    }
    return [...observations.values()]
  }

  /** Check runs of the pull requests an open review pane shows. Only what changed. */
  private async readChecks(sync: RepositorySync, wanted: Wanted): Promise<NumberedPrChecksSummary[]> {
    if (!wanted.review.size) {
      sync.checksInFlight = false
      return []
    }
    const { repo, provider } = sync.host
    const summaries = await provider.review.listChecks(repo, [...wanted.review])
    prIndex.absorbChecks(repo, provider, summaries)
    sync.checksInFlight = summaries.some(({ summary }) => summary.inFlight)
    return summaries.filter((summary) => {
      const json = JSON.stringify(summary.summary)
      if (sync.checks.get(summary.number) === json) return false
      sync.checks.set(summary.number, json)
      return true
    })
  }

  /** The open pull requests waiting on the viewer, when a client shows that
   *  count. Null when it did not change. */
  private async readNeedsReview(sync: RepositorySync, wanted: Wanted, observations: Observation[]): Promise<number[] | null> {
    if (!wanted.needsReview || sync.needsReviewAt > this.now()) return null
    sync.needsReviewAt = this.now() + NEEDS_REVIEW_MS
    const { repo, provider } = sync.host
    const viewer = await provider.review.getViewer(repo)
    const answer = await prIndex.listNeedsReview(repo, provider, viewer)
    await this.deps.observeNeedingAttention?.(repo, viewer, answer).catch((error) => {
      log.warn('pr_sync_attention_observation_failed', { repo: repoKeyOf(repo), error: error instanceof Error ? error.message : String(error) })
    })
    const rows = attachReviewAttention(answer, viewer).filter((pullRequest) => pullRequest.needsMyReview)
    const known = new Set(observations.map(({ number }) => number))
    for (const row of rows) {
      if (known.has(row.number)) continue
      sync.records.set(row.number, { result: 'found', pullRequest: row })
      observations.push({ number: row.number, pullRequest: row, isNews: false })
    }
    const numbers = rows.map(({ number }) => number).sort((a, b) => a - b)
    if (sync.needsReview && sync.needsReview.join() === numbers.join()) return null
    sync.needsReview = numbers
    return numbers
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
    const live = new Set((await liveCheckouts(this.now())).flatMap((checkout) =>
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
      ...await readPrLinkWatchList(getDatabase(), ANY_ORGANIZATION),
      ...await sessionLinkWatchList(),
    ]
    for (const link of links) {
      if (!link.isActive || link.state === 'closed' || link.state === 'missing') continue
      const host = await hostFor(link.projectScope)
      if (!host) continue
      const interest = interestFor(host)
      if (link.state !== 'merged') interest.open.add(link.number)
      else if (link.updatedAt) interest.merged.set(link.number, link.updatedAt)
    }
    for (const { projectScope, branch, sessionId } of await liveCheckouts(this.now())) {
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
 * The pull requests sessions link, as PR sync watches them. A link is live
 * work until its session is settled; a task that is not finished keeps the
 * links of its sessions live, because the task reads them.
 */
async function sessionLinkWatchList(): Promise<PrLinkWatch[]> {
  const { sessionIds: ofLiveTask } = await liveTaskSessions()
  const links = await readSessionPullRequestWatchList(ANY_ORGANIZATION)
  const settled = await settledSessionIds([...new Set(links.map((link) => link.sessionId))])
  return links.map((link) => ({
    projectScope: link.repository,
    number: link.number,
    isActive: ofLiveTask.has(link.sessionId) || !settled.has(link.sessionId),
    state: link.state,
    updatedAt: link.updatedAt,
  }))
}

function cadenceOf(sync: RepositorySync, wanted: Wanted): number {
  if (!wanted.review.size) return REPOSITORY_MS
  return sync.checksInFlight ? CHECKS_IN_FLIGHT_MS : REVIEW_MS
}

/** Whether PR sync already holds an answer for this interest. */
function isAnswered(sync: RepositorySync, interest: PrInterest): boolean {
  if (interest.kind === 'repository') return sync.syncedAt > 0
  if (interest.kind === 'pull-request') return sync.records.has(interest.number)
  if (interest.kind === 'review') return sync.records.has(interest.number) && sync.checks.has(interest.number)
  if (interest.kind === 'branch') return sync.byBranch.has(interest.head) || sync.syncedAt > 0
  return sync.needsReview !== null
}

/** What is known about what one connection asked for. A repository interest
 *  gets no rows: the list that asked reads its own first page. */
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
    if (record?.result === 'found') change.pullRequests.push(record.pullRequest)
    else if (record?.result === 'missing') change.missing.push(number)
  }
  const review = new Set(interests.flatMap((interest) => interest.kind === 'review' ? [interest.number] : []))
  change.checks = prIndex.checksFor(sync.host.repo, [...review])
  if (sync.needsReview && interests.some((interest) => interest.kind === 'needs-review')) {
    change.needsReview = sync.needsReview
  }
  return change
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
