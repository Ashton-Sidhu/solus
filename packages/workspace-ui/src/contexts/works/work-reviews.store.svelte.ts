import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import type {
  WorkReview,
  WorkReviewDecide,
  WorkReviewInboxItem,
  WorkReviewRequest,
  WorkReviewsChanged,
  WorkReviewStateEntry,
} from '@solus/contracts/work-review'

/** A host from before work review answers "Unknown method": it has no reviews. */
function isUnsupported(message: string): boolean {
  return /Unknown method|Unknown RPC|not registered/i.test(message)
}

function messageOf(error: Error | string): string {
  return error instanceof Error ? error.message : error
}

/**
 * Work review state for the renderer (docs/plans/work-review-and-live-editing.md,
 * phase 2): the full review of each work a pane has open, the review state of
 * every work for the gallery, and the works that wait for the reader on each
 * host. Every surface (header, gallery, palette, mobile) reads this one store.
 */
export class WorkReviewsStore {
  /** The full review of a work a surface asked for, by work id. */
  readonly reviews = new SvelteMap<string, WorkReview>()
  /** The state and reviewers of every work with reviewers, by work id. */
  readonly summaries = new SvelteMap<string, WorkReviewStateEntry>()
  /** The works that wait for the reader, by host. */
  readonly inboxByHost = new SvelteMap<string, (WorkReviewInboxItem & { serverId: string })[]>()
  readonly errors = new SvelteMap<string, string>()
  /** A command outside the work (gallery menu, palette) asked its header to
   *  open the Review popover; the header takes it once it is on screen. */
  pendingOpen = $state<string | null>(null)
  private readonly tokens = new Map<string, number>()
  private readonly hostTokens = new Map<string, number>()

  constructor(
    private readonly apiForWork: (workId: string) => HostApi,
    private readonly apiForHost: (serverId: string) => HostApi,
    private readonly hostOf: (workId: string) => string | null,
  ) {}

  /** Every work that waits for the reader, newest request first. */
  get inbox(): (WorkReviewInboxItem & { serverId: string })[] {
    return [...this.inboxByHost.values()].flat().sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt))
  }

  inboxItem(workId: string): (WorkReviewInboxItem & { serverId: string }) | undefined {
    for (const items of this.inboxByHost.values()) {
      const item = items.find((candidate) => candidate.workId === workId)
      if (item) return item
    }
    return undefined
  }

  showReview(workId: string): void {
    this.pendingOpen = workId
  }

  /** True once for the header of the work a command asked to review. */
  takePendingOpen(workId: string): boolean {
    if (this.pendingOpen !== workId) return false
    this.pendingOpen = null
    return true
  }

  async load(workId: string): Promise<WorkReview | null> {
    const token = (this.tokens.get(workId) ?? 0) + 1
    this.tokens.set(workId, token)
    try {
      const review = await this.apiForWork(workId).workReviewGet(workId)
      if (this.tokens.get(workId) !== token) return this.reviews.get(workId) ?? null
      this.accept(review)
      this.errors.delete(workId)
      return review
    } catch (error) {
      const message = messageOf(error instanceof Error ? error : String(error))
      if (this.tokens.get(workId) === token && !isUnsupported(message)) this.errors.set(workId, message)
      return null
    }
  }

  /** The reader's inbox and the review states of one host's works. */
  async loadHost(serverId: string): Promise<void> {
    const token = (this.hostTokens.get(serverId) ?? 0) + 1
    this.hostTokens.set(serverId, token)
    try {
      const api = this.apiForHost(serverId)
      const [inbox, states] = await Promise.all([api.workReviewInbox(), api.workReviewStates()])
      if (this.hostTokens.get(serverId) !== token) return
      this.inboxByHost.set(serverId, inbox.map((item) => ({ ...item, serverId })))
      const answered = new Set(states.map((entry) => entry.workId))
      for (const workId of this.summaries.keys()) {
        if (!answered.has(workId) && this.hostOf(workId) === serverId) this.summaries.delete(workId)
      }
      for (const answer of states) {
        // A host from before reviewer lists answers the state alone.
        const entry = { ...answer, reviewers: answer.reviewers ?? [] }
        if (!sameSummary(this.summaries.get(entry.workId), entry)) this.summaries.set(entry.workId, entry)
      }
    } catch (error) {
      const message = messageOf(error instanceof Error ? error : String(error))
      if (!isUnsupported(message)) console.warn('[work-reviews] host load failed', serverId, message)
    }
  }

  async request(workId: string, request: WorkReviewRequest): Promise<WorkReview> {
    const review = await this.apiForWork(workId).workReviewRequest(workId, request)
    this.accept(review)
    return review
  }

  async remove(workId: string, reviewerId: string): Promise<WorkReview> {
    const review = await this.apiForWork(workId).workReviewRemove(workId, reviewerId)
    this.accept(review)
    return review
  }

  async decide(workId: string, decide: WorkReviewDecide): Promise<WorkReview> {
    const review = await this.apiForWork(workId).workReviewDecide(workId, decide)
    this.accept(review)
    const serverId = this.hostOf(workId)
    if (serverId) void this.loadHost(serverId)
    return review
  }

  /**
   * A host said a work's reviewers changed. The review is read again when a
   * surface holds it; the host's inbox and states always are. Answers the
   * review as it is now, for the notice.
   */
  async applyChange(serverId: string, change: WorkReviewsChanged): Promise<WorkReview | null> {
    const [review] = await Promise.all([this.load(change.workId), this.loadHost(serverId)])
    return review
  }

  /** A work the window no longer knows. */
  forget(workId: string): void {
    this.reviews.delete(workId)
    this.summaries.delete(workId)
    this.errors.delete(workId)
    this.tokens.delete(workId)
  }

  private accept(review: WorkReview): void {
    this.reviews.set(review.workId, review)
    if (review.state === 'draft') this.summaries.delete(review.workId)
    else this.summaries.set(review.workId, review)
  }
}

/** Unchanged entries keep their object, so a refresh repaints only the works that changed. */
function sameSummary(current: WorkReviewStateEntry | undefined, next: WorkReviewStateEntry): boolean {
  return !!current && current.state === next.state && current.reviewers.length === next.reviewers.length
    && current.reviewers.every((reviewer, i) => {
      const other = next.reviewers[i]
      return reviewer.reviewerId === other.reviewerId && reviewer.displayName === other.displayName && reviewer.decision === other.decision
        && reviewer.decidedAt === other.decidedAt && reviewer.requestedAt === other.requestedAt && reviewer.isStale === other.isStale && reviewer.isAwaiting === other.isAwaiting
    })
}
