import { SvelteMap } from 'svelte/reactivity'
import {
  reviewGuideTargetId,
  type ReviewLensChangedEvent,
  type ReviewLensCommentChange,
  type ReviewLensCommentsResult,
  type ReviewLensEditRequest,
  type ReviewLensGenerateRequest,
  type ReviewLensSnapshot,
  type ReviewTarget,
} from '@solus/contracts/review'
import type { IpcContext } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { HostApi } from '@solus/client-core/host-api'
import type { ConnectionStatus } from '@solus/client-core/ws-transport'

type ConnectionListener = (serverId: string, status: ConnectionStatus, attempt: number) => void

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

  constructor(
    private readonly eventsFor: (serverId: string) => HostEventSubscriber = (serverId) => serverConnections.eventsFor(serverId),
    private readonly watchConnections: (listener: ConnectionListener) => () => void = (listener) => serverConnections.onStatusChange(listener),
  ) {}

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
      for (const subject of this.subjects.values()) {
        if (subject.serverId === host) void this.load(subject)
      }
    })
    if (this.subscribed.has(serverId)) return
    this.subscribed.add(serverId)
    this.eventsFor(serverId).subscribe('review.lensChanged', (event) => this.receive(serverId, event))
  }

  private receive(serverId: string, event: ReviewLensChangedEvent): void {
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
