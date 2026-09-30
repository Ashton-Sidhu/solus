import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import {
  reviewGuideTargetId,
  type ReviewLensChangedEvent,
  type ReviewLensCommentChange,
  type ReviewLensCommentsResult,
  type ReviewLensEditRequest,
  type ReviewLensGenerateRequest,
  type ReviewLensJob,
  type ReviewLensSnapshot,
  type ReviewTarget,
} from '@solus/contracts/review'
import type { IpcContext } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { HostApi } from '@solus/client-core/host-api'
import type { ConnectionStatus } from '@solus/client-core/ws-transport'

type ConnectionListener = (serverId: string, status: ConnectionStatus, attempt: number) => void
type LensEventListener = (serverId: string, event: ReviewLensChangedEvent) => void
type PullRequestIdentity = Pick<Extract<ReviewTarget, { kind: 'pr' }>, 'host' | 'owner' | 'repo' | 'number'>

/** Which lens a surface reads. `scopeKey` separates two checkouts that share a
 *  target kind (two worktrees each with a working-tree lens); the host decides
 *  the real storage key and returns it on the snapshot. */
export interface LensSubject {
  api: HostApi
  serverId: string
  ctx: IpcContext
  target: ReviewTarget
  scopeKey: string
}

export interface LensEntry {
  snapshot: ReviewLensSnapshot | null
  /** The host answered at least once. With no snapshot, that answer was "this
   *  review has no checkout", not "still loading". */
  loaded: boolean
  loading: boolean
  error: string | null
  /** The revision the user last saw with the Lens tab open. */
  seenRevision: number
}

function subjectKey(subject: Pick<LensSubject, 'serverId' | 'scopeKey' | 'target'>): string {
  return `${subject.serverId}::${subject.scopeKey}::${reviewGuideTargetId(subject.target)}`
}

/** A PR job is found by the pull request alone: the list row knows the PR, not
 *  the host's storage address, and a new head must not hide a running job. */
function jobKey(serverId: string, event: ReviewLensChangedEvent): string {
  return event.target.kind === 'pr' ? prJobKey(serverId, event.target) : `${serverId}::${event.repoRoot}::${event.key}`
}

function prJobKey(serverId: string, pr: PullRequestIdentity): string {
  return `${serverId}::${reviewGuideTargetId({ kind: 'pr', host: pr.host, owner: pr.owner, repo: pr.repo, number: pr.number })}`
}

function isRunning(job: ReviewLensJob | null | undefined): boolean {
  return job?.status === 'queued' || job?.status === 'generating'
}

/**
 * Lens state shared by every mounted review surface (docs/plans/review-lenses.md).
 * The host owns the job and the record; this store holds the last snapshot per
 * subject and follows `review.lensChanged`. An event never carries HTML: when
 * its revision moves past the snapshot's, the snapshot is read again.
 */
export class ReviewLensStore {
  private entries = new SvelteMap<string, LensEntry>()
  private subjects = new Map<string, LensSubject>()
  private loadSeq = new Map<string, number>()
  private subscribed = new Set<string>()
  private disconnected = new SvelteMap<string, true>()
  private connectionUnsubscribe: (() => void) | null = null
  /** The last job each host announced, for surfaces with no pane open (the PR
   *  list, the ready toast). Live only: a job that ended before this client
   *  connected is not here. */
  private jobs = new SvelteMap<string, ReviewLensJob | null>()
  /** Ready jobs the user opened, as `jobKey::updatedAt`. */
  private seenReadyJobs = new SvelteSet<string>()
  /** The saved-lens revision of each listed PR, by `prJobKey`; 0 means none.
   *  `loadPrRevisions` fills it and `review.lensChanged` keeps it current. */
  private prRevisions = new SvelteMap<string, number>()
  /** PRs `loadPrRevisions` asked about since the host last connected. */
  private probedPrs = new Set<string>()
  private readyListeners = new Set<LensEventListener>()

  constructor(
    private readonly subscribeEvents: (listener: LensEventListener) => () => void = (listener) => subscribeAllHosts('review.lensChanged', listener),
    private readonly watchConnections: (listener: ConnectionListener) => () => void = (listener) => serverConnections.onStatusChange(listener),
  ) {}

  /** Follow `review.lensChanged` on every host. The app shell calls it once;
   *  panes and the PR list read what it records. */
  follow(): () => void {
    return this.subscribeEvents((serverId, event) => this.receive(serverId, event))
  }

  /** Observe a job that finishes while this client watches it run. A cached
   *  read never notifies: reopening Solus must not replay old toasts. */
  onReady(listener: LensEventListener): () => void {
    this.readyListeners.add(listener)
    return () => this.readyListeners.delete(listener)
  }

  /** The job a PR row shows. A ready job the user opened shows nothing. */
  pullRequestJobFor(serverId: string, pr: PullRequestIdentity): ReviewLensJob | null {
    const key = prJobKey(serverId, pr)
    const job = this.jobs.get(key) ?? null
    return job?.status === 'ready' && this.seenReadyJobs.has(`${key}::${job.updatedAt}`) ? null : job
  }

  /** Whether the host has a saved lens for this PR. False until its list row
   *  was probed with `loadPrRevisions`. */
  hasSavedPrLens(serverId: string, pr: PullRequestIdentity): boolean {
    return (this.prRevisions.get(prJobKey(serverId, pr)) ?? 0) > 0
  }

  /**
   * Ask the host about these PRs' saved lenses in one request, once per PR
   * while the host stays connected. A lens made or changed later arrives as
   * `review.lensChanged`. A probe that failed is forgotten, so the next list
   * load asks again.
   */
  async loadPrRevisions(api: HostApi, serverId: string, ctx: IpcContext, prs: readonly PullRequestIdentity[]): Promise<void> {
    this.bind(serverId)
    const fresh = prs.filter((pr) => !this.probedPrs.has(prJobKey(serverId, pr)))
    if (!fresh.length) return
    const keys = fresh.map((pr) => prJobKey(serverId, pr))
    for (const key of keys) this.probedPrs.add(key)
    try {
      const targets = fresh.map(({ host, owner, repo, number }) => ({ kind: 'pr' as const, host, owner, repo, number }))
      const revisions = await api.prLensRevisions(structuredClone($state.snapshot(ctx)), targets)
      // An event that arrived while the probe ran is at least as new.
      keys.forEach((key, index) => this.prRevisions.set(key, Math.max(this.prRevisions.get(key) ?? 0, revisions?.[index] ?? 0)))
    } catch {
      for (const key of keys) this.probedPrs.delete(key)
    }
  }

  entryFor(subject: Pick<LensSubject, 'serverId' | 'scopeKey' | 'target'> | null): LensEntry | null {
    return subject ? this.entries.get(subjectKey(subject)) ?? null : null
  }

  reconnectingFor(serverId: string): boolean {
    return this.disconnected.has(serverId)
  }

  /** A ready lens the user has not looked at yet. */
  isUnread(subject: Pick<LensSubject, 'serverId' | 'scopeKey' | 'target'> | null): boolean {
    const entry = this.entryFor(subject)
    if (!entry?.snapshot?.current) return false
    return entry.snapshot.job?.status === 'ready' && entry.snapshot.revision > entry.seenRevision
  }

  markSeen(subject: Pick<LensSubject, 'serverId' | 'scopeKey' | 'target'> | null): void {
    const entry = this.entryFor(subject)
    if (entry?.snapshot && entry.seenRevision !== entry.snapshot.revision) entry.seenRevision = entry.snapshot.revision
    if (subject?.target.kind !== 'pr') return
    const key = prJobKey(subject.serverId, subject.target)
    const job = this.jobs.get(key)
    if (job?.status === 'ready') this.seenReadyJobs.add(`${key}::${job.updatedAt}`)
  }

  async load(subject: LensSubject): Promise<void> {
    this.bind(subject.serverId)
    const key = subjectKey(subject)
    this.subjects.set(key, subject)
    const entry = this.ensureEntry(key)
    const seq = (this.loadSeq.get(key) ?? 0) + 1
    this.loadSeq.set(key, seq)
    entry.loading = true
    try {
      const snapshot = await subject.api.readReviewLens(subject.ctx, subject.target)
      if (this.loadSeq.get(key) !== seq) return
      this.applySnapshot(entry, snapshot)
      entry.loaded = true
      entry.error = null
    } catch (error) {
      if (this.loadSeq.get(key) === seq) entry.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (this.loadSeq.get(key) === seq) entry.loading = false
    }
  }

  async generate(subject: LensSubject, request: Omit<ReviewLensGenerateRequest, 'target'>): Promise<void> {
    await this.run(subject, () => subject.api.requestReviewLens(subject.ctx, { ...request, target: subject.target }))
  }

  async edit(subject: LensSubject, request: Omit<ReviewLensEditRequest, 'target'>): Promise<void> {
    await this.run(subject, () => subject.api.editReviewLens(subject.ctx, { ...request, target: subject.target }))
  }

  async restore(subject: LensSubject): Promise<void> {
    await this.run(subject, () => subject.api.restoreReviewLens(subject.ctx, subject.target))
  }

  async cancel(subject: LensSubject): Promise<void> {
    await subject.api.cancelReviewLens(subject.ctx, subject.target)
  }

  changeComments(subject: LensSubject, change: ReviewLensCommentChange): Promise<void> {
    return this.applyComments(subject, subject.api.updateReviewLensComments(subject.ctx, subject.target, change))
  }

  postComment(subject: LensSubject, commentId: string): Promise<void> {
    return this.applyComments(subject, subject.api.postReviewLensComment(subject.ctx, subject.target, commentId))
  }

  retractComment(subject: LensSubject, commentId: string): Promise<void> {
    return this.applyComments(subject, subject.api.retractReviewLensComment(subject.ctx, subject.target, commentId))
  }

  // ─── internals ───

  private ensureEntry(key: string): LensEntry {
    const existing = this.entries.get(key)
    if (existing) return existing
    const entry: LensEntry = $state({ snapshot: null, loaded: false, loading: false, error: null, seenRevision: 0 })
    this.entries.set(key, entry)
    return entry
  }

  private applySnapshot(entry: LensEntry, snapshot: ReviewLensSnapshot | null): void {
    // A lens that already existed when this client first read it is not news.
    if (!entry.snapshot && snapshot) entry.seenRevision = snapshot.revision
    entry.snapshot = snapshot
  }

  private async run(subject: LensSubject, call: () => Promise<ReviewLensSnapshot | null>): Promise<void> {
    this.bind(subject.serverId)
    const key = subjectKey(subject)
    this.subjects.set(key, subject)
    const entry = this.ensureEntry(key)
    // A response to an older read must not replace what this call returns.
    this.loadSeq.set(key, (this.loadSeq.get(key) ?? 0) + 1)
    const snapshot = await call()
    if (!snapshot) throw new Error('This review has no git checkout.')
    this.applySnapshot(entry, snapshot)
    entry.error = null
  }

  private async applyComments(subject: LensSubject, call: Promise<ReviewLensCommentsResult>): Promise<void> {
    const result = await call
    const entry = this.entries.get(subjectKey(subject))
    const snapshot = entry?.snapshot
    if (!entry || !snapshot?.current || result.revision < snapshot.revision) return
    entry.snapshot = { ...snapshot, current: { ...snapshot.current, comments: result.comments }, revision: result.revision }
  }

  private bind(serverId: string): void {
    this.connectionUnsubscribe ??= this.watchConnections((host, status) => {
      if (!this.subscribed.has(host)) return
      if (status !== 'connected') {
        this.disconnected.set(host, true)
        return
      }
      this.disconnected.delete(host)
      // Events missed while away can hide a new lens, so the list asks again.
      for (const key of this.probedPrs) if (key.startsWith(`${host}::`)) this.probedPrs.delete(key)
      for (const subject of this.subjects.values()) {
        if (subject.serverId === host) void this.load(subject)
      }
    })
    this.subscribed.add(serverId)
  }

  private receive(serverId: string, event: ReviewLensChangedEvent): void {
    const lensJobKey = jobKey(serverId, event)
    // A comment change re-sends the finished job; only a run seen live is news.
    const finished = event.job?.status === 'ready' && isRunning(this.jobs.get(lensJobKey))
    this.jobs.set(lensJobKey, event.job)
    if (event.target.kind === 'pr') this.prRevisions.set(lensJobKey, event.revision)
    if (finished) for (const listener of this.readyListeners) listener(serverId, event)
    for (const [key, subject] of this.subjects) {
      if (subject.serverId !== serverId) continue
      const entry = this.entries.get(key)
      const snapshot = entry?.snapshot
      if (!entry || !snapshot || snapshot.repoRoot !== event.repoRoot || snapshot.key !== event.key) continue
      if (event.revision > snapshot.revision) {
        void this.load(subject)
        continue
      }
      if (!event.job || !snapshot.job || event.job.updatedAt >= snapshot.job.updatedAt) {
        entry.snapshot = { ...snapshot, job: event.job }
      }
    }
  }
}

export const reviewLensStore = new ReviewLensStore()
