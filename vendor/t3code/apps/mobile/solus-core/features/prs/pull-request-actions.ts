// Adapted from T3 Code apps/mobile/src/features/pull-requests/usePullRequestAction.ts and usePullRequestAgentActions.ts (MIT, see UPSTREAM.md).
import type { MergeMethod, PrMergeResult } from '@solus/contracts/types'
import { worktreeProjectRoot, type IpcContext } from '@solus/contracts/types'
import type { PrFilterChoice, PrFilterField, PrLabel, PrMergeMethod, PrReviewerCandidate, PrReviewerKind, PrReviewVerdict, PrStackHead, PrStackMergeResult, PrStateAction, PullRequest, PullRequestUpdate } from '@solus/contracts/providers'
import { mergeFilterChoices } from '@solus/client-core/pr-filter-choices'
import { Listeners } from '../../lib/listeners'
import type { HostConnection } from '../hosts/host-connections'
import { conflictResolutionPrompt, pullRequestAgentPrompt, type PullRequestAgentTask } from './lib/pull-request-agent-tasks'
import { currentReviewComments, draftReview } from './lib/pull-request-review-draft'
import { detailKey, type PullRequestDirectory, type PullRequestRef } from './pull-request-directory'
import { connectedHost } from './pull-request-reads'
import type { PullRequestReviewDrafts } from './pull-request-review-drafts'

/**
 * The writes on a pull request. Each one needs a connected host and refuses
 * with a plain sentence when there is none; the cache never answers a write.
 * After a write the pull request is read again, and the host listing too when
 * the write moves the pull request between lists.
 */

export type PullRequestActionKind =
  | 'merge' | 'auto-merge' | 'update-branch' | 'lifecycle' | 'reviewers' | 'labels' | 'edit'
  | 'review' | 'thread' | 'comment' | 'agent' | 'revert' | 'workflows'

/** How long the viewed marks wait for more taps before they go in one write. */
export const VIEWED_WRITE_DELAY_MS = 600

const NO_MARKS: ReadonlyMap<string, boolean> = new Map()

export interface PullRequestActionsDeps {
  connectionFor(hostId: string): HostConnection | null
  organizationId(): string | null
  directory: PullRequestDirectory
  drafts: PullRequestReviewDrafts
  /** Starts a new session in `workingDirectory` with its first prompt, as the
   *  new-task sheet does, and answers its session id. */
  startSession(hostId: string, workingDirectory: string, prompt: string): string
  /** Timers for the viewed-files batch; tests give manual ones. */
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

/** Viewed marks of one pull request: what shows now, what waits to be sent. */
interface ViewedMarks {
  shown: Map<string, boolean>
  queued: Map<string, boolean>
  timer: ReturnType<typeof setTimeout> | null
  error: string | null
}

export class PullRequestActions {
  readonly changes = new Listeners()
  private readonly running = new Map<string, PullRequestActionKind>()
  private readonly viewedMarks = new Map<string, ViewedMarks>()

  constructor(private readonly deps: PullRequestActionsDeps) {}

  /** The write running on a pull request now, for a busy control. */
  runningOf = (ref: PullRequestRef): PullRequestActionKind | null => this.running.get(detailKey(ref)) ?? null

  /** Merges with `method` on the head the person was shown; a head that
   *  moved since makes the host refuse. */
  async merge(ref: PullRequestRef, method: MergeMethod, expectedHeadSha: string): Promise<PrMergeResult> {
    const result = await this.write(ref, 'merge', true, (api, ctx) => api.prMerge(ctx, ref.number, method, expectedHeadSha))
    if (!result.merged) throw new Error(result.message ?? 'The host did not merge this pull request.')
    return result
  }

  enableAutoMerge(ref: PullRequestRef, method: MergeMethod, expectedHeadSha: string): Promise<PullRequest> {
    return this.write(ref, 'auto-merge', false, (api, ctx) => api.prEnableAutoMerge(ctx, ref.number, method, expectedHeadSha))
  }

  disableAutoMerge(ref: PullRequestRef): Promise<PullRequest> {
    return this.write(ref, 'auto-merge', false, (api, ctx) => api.prDisableAutoMerge(ctx, ref.number))
  }

  /** Brings the base branch into the head on the host. */
  updateBranch(ref: PullRequestRef, expectedHeadSha: string): Promise<PullRequest> {
    return this.write(ref, 'update-branch', false, (api, ctx) => api.prUpdateBranch(ctx, ref.number, expectedHeadSha))
  }

  /**
   * Merges this pull request and every open layer below it in its stack, in
   * one host operation. `expectedHeads` are the layer heads the person was
   * shown; a layer that moved makes the host refuse. `queued` means the host
   * put the layers in its merge queue.
   */
  mergeStack(ref: PullRequestRef, input: { stackNumber: number; method: PrMergeMethod; expectedHeads: PrStackHead[] }): Promise<PrStackMergeResult> {
    return this.write(ref, 'merge', true, (api, ctx) => api.prMergeStack(ctx, { number: ref.number, ...input }))
  }

  /** Opens a pull request that reverses a merged one, and answers where it is. */
  async revert(ref: PullRequestRef): Promise<PullRequestRef> {
    const opened = await this.write(ref, 'revert', true, (api, ctx) => api.prRevert(ctx, ref.number))
    return { hostId: ref.hostId, projectPath: ref.projectPath, number: opened.number }
  }

  /** Lets the held workflow runs start. `expectedHeadSha` is the head that
   *  `prPendingWorkflowRuns` named; the host refuses when the head moved. */
  async approveWorkflowRuns(ref: PullRequestRef, expectedHeadSha: string): Promise<number> {
    const result = await this.write(ref, 'workflows', false, (api, ctx) => api.prApproveWorkflowRuns(ctx, ref.number, expectedHeadSha))
    return result.approved
  }

  /** The viewed marks that are not yet in the code host's answer. */
  viewedMarksOf = (ref: PullRequestRef): ReadonlyMap<string, boolean> => this.viewedMarks.get(detailKey(ref))?.shown ?? NO_MARKS

  /** Why the last viewed write failed; null after a later tap. */
  viewedErrorOf = (ref: PullRequestRef): string | null => this.viewedMarks.get(detailKey(ref))?.error ?? null

  /**
   * Marks a file viewed or not viewed on the code host. The mark shows at
   * once; the marks of a short time go in one write, then the viewed state is
   * read again. A failed write takes its marks back and keeps the reason.
   * Refuses at once without a connected host.
   */
  markFileViewed(ref: PullRequestRef, path: string, viewed: boolean): void {
    this.host(ref)
    const key = detailKey(ref)
    const marks = this.viewedMarks.get(key) ?? { shown: new Map(), queued: new Map(), timer: null, error: null }
    this.viewedMarks.set(key, marks)
    marks.shown.set(path, viewed)
    marks.queued.set(path, viewed)
    marks.error = null
    const clear = this.deps.clearTimeoutFn ?? clearTimeout
    if (marks.timer !== null) clear(marks.timer)
    marks.timer = (this.deps.setTimeoutFn ?? setTimeout)(() => void this.sendViewed(ref), VIEWED_WRITE_DELAY_MS)
    this.changes.notify()
  }

  /** Sends the waiting viewed marks. Exposed for a screen that closes, and for tests. */
  async sendViewed(ref: PullRequestRef): Promise<void> {
    const marks = this.viewedMarks.get(detailKey(ref))
    if (!marks || marks.queued.size === 0) return
    if (marks.timer !== null) (this.deps.clearTimeoutFn ?? clearTimeout)(marks.timer)
    marks.timer = null
    const sent = new Map(marks.queued)
    marks.queued.clear()
    // A mark made after this write keeps its own value.
    const settle = () => {
      for (const [path, viewed] of sent) if (marks.shown.get(path) === viewed && !marks.queued.has(path)) marks.shown.delete(path)
    }
    try {
      const connection = this.host(ref)
      await connection.api.prSetFilesViewed(this.context(ref), ref.number, Array.from(sent, ([path, viewed]) => ({ path, viewed })))
    } catch (error) {
      settle()
      marks.error = error instanceof Error ? error.message : 'Could not update the viewed files.'
      this.changes.notify()
      return
    }
    await this.deps.directory.loadViewed(ref)
    // Until the code host's answer is read, the marks stay as the person set them.
    if (this.deps.directory.viewedOf(ref).kind === 'loaded') settle()
    this.changes.notify()
  }

  /** Close, reopen, mark ready, or convert to draft. */
  setLifecycle(ref: PullRequestRef, action: PrStateAction, expectedHeadSha: string): Promise<PullRequest> {
    return this.write(ref, 'lifecycle', true, (api, ctx) => api.prUpdateLifecycle(ctx, ref.number, action, expectedHeadSha))
  }

  /** People and teams the host can ask for a review. */
  async reviewerCandidates(ref: PullRequestRef): Promise<PrReviewerCandidate[]> {
    return this.host(ref).api.prListReviewerCandidates(this.context(ref), ref.number)
  }

  async requestReviewers(ref: PullRequestRef, logins: string[]): Promise<void> {
    await this.write(ref, 'reviewers', false, (api, ctx) => api.prRequestReviewers(ctx, ref.number, logins))
  }

  async removeReviewer(ref: PullRequestRef, reviewerId: string, kind?: PrReviewerKind): Promise<void> {
    await this.write(ref, 'reviewers', false, (api, ctx) => api.prRemoveRequestedReviewer(ctx, ref.number, reviewerId, kind))
  }

  /** The repository's labels, for the label picker. */
  async labelCandidates(ref: PullRequestRef): Promise<PrLabel[]> {
    return this.host(ref).api.prListLabelCandidates(this.context(ref), ref.number)
  }

  /** The labels, or the people who can be mentioned, that match `query` in
   *  each of these projects, as one list: the list filters' choices beyond the
   *  loaded rows. A project whose host is not connected or cannot answer adds
   *  nothing. */
  async filterOptions(projects: readonly { hostId: string; projectPath: string }[], field: PrFilterField, query: string): Promise<PrFilterChoice[]> {
    const lists = await Promise.all(projects.map(async (project) => {
      const connection = this.deps.connectionFor(project.hostId)
      if (connection?.state.readiness !== 'ready') return []
      return connection.api.prFilterOptions(this.deps.directory.context(project.projectPath), field, query).catch((): PrFilterChoice[] => [])
    }))
    return mergeFilterChoices(lists)
  }

  /** Replaces the whole label set. */
  setLabels(ref: PullRequestRef, names: string[]): Promise<PullRequest> {
    return this.write(ref, 'labels', true, (api, ctx) => api.prSetLabels(ctx, ref.number, names))
  }

  /** Changes the title or the description. The list shows the title, so it is read again too. */
  update(ref: PullRequestRef, patch: PullRequestUpdate): Promise<PullRequest> {
    return this.write(ref, 'edit', true, (api, ctx) => api.prUpdate(ctx, ref.number, patch))
  }

  /**
   * Submits one review: the verdict, `body`, and the draft's inline comments
   * written on `headSha`. After the host accepts it, the draft loses what was
   * sent; edits made while the request ran stay.
   */
  async submitReview(ref: PullRequestRef, input: { verdict: PrReviewVerdict; body: string; headSha: string; baseSha?: string }): Promise<void> {
    const draft = this.deps.drafts.draftOf(ref)
    const submitted = { summary: draft.summary, comments: currentReviewComments(draft, input.headSha) }
    await this.write(ref, 'review', false, async (api, ctx) => {
      await api.prSubmitReview(ctx, ref.number, draftReview({ ...input, comments: submitted.comments }))
      this.deps.drafts.clearSubmitted(ref, submitted)
    })
  }

  async replyToThread(ref: PullRequestRef, threadId: string, body: string): Promise<void> {
    await this.write(ref, 'thread', false, (api, ctx) => api.prReplyThread(ctx, ref.number, threadId, body.trim()))
  }

  async setThreadResolved(ref: PullRequestRef, threadId: string, resolved: boolean): Promise<void> {
    await this.write(ref, 'thread', false, (api, ctx) => resolved
      ? api.prResolveThread(ctx, ref.number, threadId)
      : api.prUnresolveThread(ctx, ref.number, threadId))
  }

  /** A comment on the pull request's conversation. */
  async comment(ref: PullRequestRef, body: string): Promise<void> {
    await this.write(ref, 'comment', false, (api, ctx) => api.prAddIssueComment(ctx, ref.number, body.trim()))
  }

  /** Deletes a conversation comment the person wrote. */
  async deleteComment(ref: PullRequestRef, commentId: string): Promise<void> {
    await this.write(ref, 'comment', false, (api, ctx) => api.prDeleteIssueComment(ctx, ref.number, commentId))
  }

  /**
   * Starts agent work on the pull request in a new session, as the web
   * client does: the host prepares a checkout of the head (for conflicts, a
   * worktree with the base merged in), and the session runs there.
   * `question` is the person's words; `ask` needs it.
   */
  async startAgentWork(ref: PullRequestRef, task: PullRequestAgentTask, pr: PullRequest, question = ''): Promise<{ hostId: string; sessionId: string }> {
    if (task === 'ask' && !question.trim()) throw new Error('Write your question first.')
    const { workingDirectory, prompt } = await this.write(ref, 'agent', false, async (api, ctx) => {
      if (task === 'conflicts') {
        const prepared = await api.prPrepareConflictResolution(ctx, ref.number)
        if (!prepared.success || !prepared.review) throw new Error(prepared.error ?? 'The host could not prepare the conflict worktree.')
        const { review } = prepared
        return {
          workingDirectory: worktreeProjectRoot(review.worktreePath),
          prompt: conflictResolutionPrompt({ number: review.number, title: review.title, baseRef: review.baseRef, headRef: prepared.headRef, conflictFiles: prepared.conflictFiles }),
        }
      }
      const target = await api.prOpenReview(ctx, ref.number)
      const checkout = await api.prPrepareCheckout(ctx, target)
      if (checkout.headSha !== target.headSha) throw new Error('The pull request changed while its checkout was made. Try again.')
      return { workingDirectory: worktreeProjectRoot(checkout.worktreePath), prompt: pullRequestAgentPrompt(task, pr, question) }
    }, { refresh: false })
    return { hostId: ref.hostId, sessionId: this.deps.startSession(ref.hostId, workingDirectory, prompt) }
  }

  private host(ref: PullRequestRef): HostConnection {
    return connectedHost(this.deps.connectionFor(ref.hostId))
  }

  private context(ref: PullRequestRef): IpcContext {
    return this.deps.directory.context(ref.projectPath)
  }

  /** Runs one write, marks the pull request busy while it runs, then reads
   *  the pull request again (and the host listing when `listChanges`). */
  private async write<T>(
    ref: PullRequestRef,
    kind: PullRequestActionKind,
    listChanges: boolean,
    run: (api: HostConnection['api'], ctx: IpcContext) => Promise<T>,
    options: { refresh: boolean } = { refresh: true },
  ): Promise<T> {
    const connection = this.host(ref)
    const key = detailKey(ref)
    this.running.set(key, kind)
    this.changes.notify()
    try {
      return await run(connection.api, this.context(ref))
    } finally {
      if (this.running.get(key) === kind) this.running.delete(key)
      this.changes.notify()
      if (options.refresh) {
        // A failed write can still have changed the pull request; read it again either way.
        await Promise.all([
          // Forced: a read on the wire began before the write.
          this.deps.directory.loadDetail(ref, { force: true }),
          listChanges ? this.deps.directory.loadHost(ref.hostId) : undefined,
        ])
      }
    }
  }
}
