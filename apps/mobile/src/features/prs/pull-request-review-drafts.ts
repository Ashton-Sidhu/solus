// Adapted from T3 Code apps/mobile/src/features/pull-requests/usePullRequestReviewDraft.ts (MIT, see UPSTREAM.md).
import { Listeners } from '../../lib/listeners'
import { clearSubmittedReview, EMPTY_REVIEW_DRAFT, isReviewDraftEmpty, type PendingReviewComment, type ReviewDraft } from './lib/pull-request-review-draft'
import type { PullRequestCache } from './pull-request-cache'
import { detailKey, type PullRequestRef } from './pull-request-directory'

/**
 * The review draft of each pull request, kept on the device in the pull
 * request cache, so it survives an app restart and a lost connection. Only a
 * submit (what it sent) or a discard removes it.
 */

function draftCacheKey(ref: PullRequestRef): string {
  return `draft:${ref.projectPath}:${ref.number}`
}

export class PullRequestReviewDrafts {
  readonly changes = new Listeners()
  /** Set when the device could not keep a change; the draft still holds it
   *  for this app run. */
  saveError: string | null = null
  private readonly drafts = new Map<string, ReviewDraft>()
  private readonly loads = new Map<string, Promise<void>>()
  /** Drafts changed in this app run: the kept copy no longer replaces them. */
  private readonly edited = new Set<string>()
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly cache: PullRequestCache,
    private readonly uuid: () => string,
  ) {}

  draftOf = (ref: PullRequestRef): ReviewDraft => this.drafts.get(detailKey(ref)) ?? EMPTY_REVIEW_DRAFT

  /** Reads the kept draft once. An edit made before the read lands wins. */
  load(ref: PullRequestRef): Promise<void> {
    const key = detailKey(ref)
    let loading = this.loads.get(key)
    if (!loading) {
      loading = this.cache.readDraft<ReviewDraft>(ref.hostId, draftCacheKey(ref)).then((kept) => {
        if (!kept || this.edited.has(key)) return
        this.drafts.set(key, kept)
        this.changes.notify()
      }, () => undefined)
      this.loads.set(key, loading)
    }
    return loading
  }

  setSummary(ref: PullRequestRef, summary: string): void {
    this.update(ref, (draft) => ({ ...draft, summary }))
  }

  /** Adds an inline comment and answers its id. */
  addComment(ref: PullRequestRef, comment: Omit<PendingReviewComment, 'id'>): string {
    const id = this.uuid()
    this.update(ref, (draft) => ({ ...draft, comments: [...draft.comments, { ...comment, id }] }))
    return id
  }

  editComment(ref: PullRequestRef, id: string, body: string): void {
    this.update(ref, (draft) => ({ ...draft, comments: draft.comments.map((comment) => comment.id === id ? { ...comment, body } : comment) }))
  }

  removeComment(ref: PullRequestRef, id: string): void {
    this.update(ref, (draft) => ({ ...draft, comments: draft.comments.filter((comment) => comment.id !== id) }))
  }

  discard(ref: PullRequestRef): void {
    this.update(ref, () => EMPTY_REVIEW_DRAFT)
  }

  /** After a successful submit: removes what was sent, keeps later edits. */
  clearSubmitted(ref: PullRequestRef, submitted: ReviewDraft): void {
    this.update(ref, (draft) => clearSubmittedReview(draft, submitted))
  }

  /** Resolves when every change so far is on the device. */
  flush(): Promise<void> {
    return this.writes
  }

  /** The kept copies leave with the host's cache (`PullRequestCache.forgetHost`). */
  forgetHost(hostId: string): void {
    for (const key of Array.from(this.drafts.keys())) if (key.startsWith(`${hostId}\u0000`)) this.drafts.delete(key)
    for (const key of Array.from(this.loads.keys())) if (key.startsWith(`${hostId}\u0000`)) this.loads.delete(key)
    for (const key of Array.from(this.edited)) if (key.startsWith(`${hostId}\u0000`)) this.edited.delete(key)
    this.changes.notify()
  }

  private update(ref: PullRequestRef, change: (draft: ReviewDraft) => ReviewDraft): void {
    const key = detailKey(ref)
    const next = change(this.draftOf(ref))
    this.edited.add(key)
    if (isReviewDraftEmpty(next)) this.drafts.delete(key)
    else this.drafts.set(key, next)
    this.changes.notify()
    // Writes run in order, so the last change is the one kept.
    this.writes = this.writes.then(async () => {
      try {
        await this.cache.writeDraft(ref.hostId, draftCacheKey(ref), isReviewDraftEmpty(next) ? null : next)
        if (this.saveError === null) return
        this.saveError = null
      } catch {
        this.saveError = 'The draft is kept while the app is open, but this device could not save it.'
      }
      this.changes.notify()
    })
  }
}
