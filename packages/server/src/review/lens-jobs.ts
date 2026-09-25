import type {
  ReviewContext,
  ReviewLedger,
  ReviewLens,
  ReviewLensAddress,
  ReviewLensChangedEvent,
  ReviewLensCommentChange,
  ReviewLensCommentsResult,
  ReviewLensEditRequest,
  ReviewLensGenerateRequest,
  ReviewLensJob,
  ReviewLensRecord,
  ReviewLensSnapshot,
  ReviewProgressStep,
  ReviewTarget,
} from '@solus/contracts/review'
import type { IpcContext } from '@solus/contracts/types'
import type { AgentDispatcher } from '../agents/agent-runner'
import { createLogger } from '../logger'
import { providerForRepo } from '../providers/registry'
import { prIndex } from '../prs/pr-index'
import { resolvedGuideHead, resolveTarget, resolveTargetBase, type GuideTarget } from './guide-producer'
import { readLedgerByKey, resolveReviewContext, reviewCheckout } from './ledger'
import { runLensAgent, type LensAgentInput } from './lens-agent'
import {
  changeLensComments,
  commitLens,
  lensCommentPostBody,
  markLensCommentPosted,
  readLensRecord,
  restoreLens,
  writeLensRecord,
} from './lens-store'
import { currentPrGuideTarget, prepareReviewGuidePrContext, type PrGuideTarget } from './pr-guide-context'
import { prGuideKey, prGuideRepository } from './pr-guide-store'
import type { LensDraft } from './review-lens-tool'

const log = createLogger('review', 'lens-jobs.ts')

/** Same point as the guide's: past this, the agent scopes the diff itself. */
const MAX_INLINE_DIFF_CHARS = 60_000

type EmitLens = (event: ReviewLensChangedEvent) => void

interface LocatedLens {
  address: ReviewLensAddress
  target: ReviewTarget
}

export interface ResolvedLensChange {
  workTree: string
  review: ReviewContext
  change: GuideTarget
  headSha: string
}

export interface ReviewLensJobDependencies {
  locate: (ctx: IpcContext, target: ReviewTarget) => Promise<LocatedLens | null>
  resolveChange: (ctx: IpcContext, target: ReviewTarget) => Promise<ResolvedLensChange>
  isOutdated: (ctx: IpcContext, target: ReviewTarget, lens: ReviewLens) => Promise<boolean>
  readLedger: (resolved: ResolvedLensChange) => Promise<ReviewLedger | null>
  runAgent: (input: LensAgentInput) => Promise<LensDraft | null>
  read: (address: ReviewLensAddress) => Promise<ReviewLensRecord | null>
  write: (address: ReviewLensAddress, record: ReviewLensRecord, canCommit?: () => boolean) => Promise<boolean>
  postComment: (target: PrGuideTarget, body: string) => Promise<{ id: string; url: string }>
  deleteComment: (target: PrGuideTarget, commentId: string) => Promise<void>
  now: () => number
}

async function locate(ctx: IpcContext, target: ReviewTarget): Promise<LocatedLens | null> {
  // A PR lens belongs to the remote repository, like the PR guide, so every
  // checkout of that repository reads the same one.
  if (target.kind === 'pr') return { address: { repoRoot: prGuideRepository(target), key: prGuideKey(target) }, target }
  const review = await resolveReviewContext(reviewCheckout(ctx), ctx.session.agentSessionId)
  if (!review) return null
  const base = await resolveTargetBase(ctx, review, { target })
  return { address: { repoRoot: review.repoRoot, key: base.guideKey }, target: base.target }
}

/** The exact change a lens run reads. A PR is read from its host-managed
 * checkout at the requested revision, as the PR guide is. */
async function resolveChange(ctx: IpcContext, requested: ReviewTarget): Promise<ResolvedLensChange> {
  let runCtx = ctx
  let target = requested
  if (requested.kind === 'pr') {
    const prepared = await prepareReviewGuidePrContext(ctx, requested)
    runCtx = prepared.ctx
    target = prepared.target
  }
  const review = await resolveReviewContext(reviewCheckout(runCtx), runCtx.session.agentSessionId)
  if (!review) throw new Error('This review has no git checkout.')
  const workTree = reviewCheckout(runCtx) ?? review.repoRoot
  const change = await resolveTarget(runCtx, review, { target })
  return { workTree, review, change, headSha: await resolvedGuideHead(change, workTree, review) }
}

async function isOutdated(ctx: IpcContext, target: ReviewTarget, lens: ReviewLens): Promise<boolean> {
  if (target.kind === 'pr') {
    const current = await currentPrGuideTarget(target)
    return current.headSha !== lens.headSha || current.baseSha !== lens.baseSha
  }
  const review = await resolveReviewContext(reviewCheckout(ctx), ctx.session.agentSessionId)
  if (!review) return false
  const change = await resolveTarget(ctx, review, { target })
  return change.changeFingerprint !== lens.changeFingerprint
}

async function readLedger({ review, change }: ResolvedLensChange): Promise<ReviewLedger | null> {
  const ledger = await readLedgerByKey(review.repoRoot, review.key)
  // The branch ledger is shared; a session lens reads that session's records.
  return change.sessionId && ledger
    ? { ...ledger, records: ledger.records.filter((record) => record.sessionId === change.sessionId) }
    : ledger
}

function pullRequestFor(target: PrGuideTarget) {
  const provider = providerForRepo(target)
  if (!provider) throw new Error(`PR review is not supported for ${target.host} yet.`)
  return { provider, pullRequest: prIndex.pullRequest(target, provider, target.number) }
}

async function postComment(target: PrGuideTarget, body: string): Promise<{ id: string; url: string }> {
  const { provider, pullRequest } = pullRequestFor(target)
  const detail = await pullRequest.readFresh()
  if (!detail.viewerPermissions.comment) throw new Error('You do not have permission to comment on this pull request.')
  const posted = await provider.review.addIssueComment(target, target.number, body)
  prIndex.invalidate(target)
  return posted
}

async function deleteComment(target: PrGuideTarget, commentId: string): Promise<void> {
  const { provider, pullRequest } = pullRequestFor(target)
  // Someone may have deleted it on the code host already. Retract must still
  // succeed, or the lens comment could never be deleted.
  const comments = await pullRequest.comments()
  if (comments.some((comment) => comment.id === commentId)) {
    await provider.review.deleteIssueComment(target, commentId)
  }
  prIndex.invalidate(target)
}

function defaultDependencies(dispatcher: AgentDispatcher): ReviewLensJobDependencies {
  return {
    locate,
    resolveChange,
    isOutdated,
    readLedger,
    runAgent: (input) => runLensAgent(dispatcher, input),
    read: readLensRecord,
    write: writeLensRecord,
    postComment,
    deleteComment,
    now: Date.now,
  }
}

interface RunningLens {
  controller: AbortController
}

function addressId(address: ReviewLensAddress): string {
  return `${address.repoRoot}::${address.key}`
}

/**
 * One host-owned lens job per target (docs/plans/review-lenses.md). A new
 * request cancels the running one. A run replaces the lens only when it
 * succeeds. Every read-modify-write of one record runs in order, so a comment
 * added during a run is not lost when the run commits.
 */
export class ReviewLensJobs {
  private readonly running = new Map<string, RunningLens>()
  /** The last job per target, kept after it ends so a reopened tab sees why. */
  private readonly jobs = new Map<string, ReviewLensJob>()
  private readonly revisions = new Map<string, number>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly deps: ReviewLensJobDependencies

  constructor(dispatcher: AgentDispatcher, deps: Partial<ReviewLensJobDependencies> = {}) {
    this.deps = { ...defaultDependencies(dispatcher), ...deps }
  }

  async read(ctx: IpcContext, target: ReviewTarget): Promise<ReviewLensSnapshot | null> {
    const located = await this.deps.locate(ctx, target)
    return located ? this.snapshot(ctx, located) : null
  }

  generate(ctx: IpcContext, request: ReviewLensGenerateRequest, emit: EmitLens): Promise<ReviewLensSnapshot | null> {
    if (!request.source.prompt.trim()) throw new Error('Write a lens prompt first.')
    return this.start(ctx, request.target, 'generate', emit, async () => ({
      source: request.source,
      edits: [],
      edit: undefined,
      appliedCommentIds: null,
      options: request,
    }))
  }

  edit(ctx: IpcContext, request: ReviewLensEditRequest, emit: EmitLens): Promise<ReviewLensSnapshot | null> {
    if (!request.prompt.trim() && request.commentIds.length === 0) throw new Error('Write a change or add a comment first.')
    return this.start(ctx, request.target, 'edit', emit, async (record) => {
      if (!record) throw new Error('There is no lens to edit.')
      const lens = record.current.lens
      const comments = record.current.comments.filter((comment) =>
        request.commentIds.includes(comment.id) && !comment.resolvedAt)
      return {
        source: lens.source,
        edits: [...lens.edits, { prompt: request.prompt.trim() || 'Apply the comments.', at: new Date(this.deps.now()).toISOString() }],
        edit: { html: lens.html, prompt: request.prompt, comments },
        appliedCommentIds: comments.map((comment) => comment.id),
        options: request,
      }
    })
  }

  async cancel(ctx: IpcContext, target: ReviewTarget, emit: EmitLens): Promise<boolean> {
    const located = await this.deps.locate(ctx, target)
    if (!located) return false
    const id = addressId(located.address)
    const running = this.running.get(id)
    if (!running) return false
    running.controller.abort()
    this.running.delete(id)
    const kind = this.jobs.get(id)?.kind ?? 'generate'
    this.setJob(located.address, { kind, status: 'cancelled', updatedAt: this.deps.now() }, emit)
    return true
  }

  async restore(ctx: IpcContext, target: ReviewTarget, emit: EmitLens): Promise<ReviewLensSnapshot | null> {
    const located = await this.deps.locate(ctx, target)
    if (!located) return null
    await this.mutate(located.address, emit, (record) => {
      const restored = restoreLens(record, this.deps.now())
      if (!restored) throw new Error('There is no previous lens to restore.')
      return restored
    })
    return this.snapshot(ctx, located)
  }

  async changeComments(ctx: IpcContext, target: ReviewTarget, change: ReviewLensCommentChange, emit: EmitLens): Promise<ReviewLensCommentsResult> {
    const address = await this.requireAddress(ctx, target)
    const record = await this.mutate(address, emit, (current) => changeLensComments(current, change, this.deps.now()))
    return { comments: record.current.comments, revision: record.updatedAt }
  }

  async postComment(ctx: IpcContext, target: ReviewTarget, commentId: string, emit: EmitLens): Promise<ReviewLensCommentsResult> {
    if (target.kind !== 'pr') throw new Error('Only a pull-request lens can post comments.')
    const address = await this.requireAddress(ctx, target)
    const record = await this.mutate(address, emit, async (current) => {
      const comment = current.current.comments.find((item) => item.id === commentId)
      if (!comment) throw new Error('This lens comment no longer exists.')
      if (comment.posted) throw new Error('This comment is already on the pull request.')
      const posted = await this.deps.postComment(target, lensCommentPostBody(comment, current.current.lens.title))
      log.info('review_lens_comment_posted', { prNumber: target.number, commentId })
      return markLensCommentPosted(current, commentId, { kind: 'conversation', commentId: posted.id, url: posted.url }, this.deps.now())
    })
    return { comments: record.current.comments, revision: record.updatedAt }
  }

  async retractComment(ctx: IpcContext, target: ReviewTarget, commentId: string, emit: EmitLens): Promise<ReviewLensCommentsResult> {
    if (target.kind !== 'pr') throw new Error('Only a pull-request lens can post comments.')
    const address = await this.requireAddress(ctx, target)
    const record = await this.mutate(address, emit, async (current) => {
      const posted = current.current.comments.find((item) => item.id === commentId)?.posted
      if (posted?.kind !== 'conversation') throw new Error('This comment is not on the pull request.')
      await this.deps.deleteComment(target, posted.commentId)
      return markLensCommentPosted(current, commentId, null, this.deps.now())
    })
    return { comments: record.current.comments, revision: record.updatedAt }
  }

  // ─── internals ───

  private async requireAddress(ctx: IpcContext, target: ReviewTarget): Promise<ReviewLensAddress> {
    const located = await this.deps.locate(ctx, target)
    if (!located) throw new Error('This review has no git checkout.')
    return located.address
  }

  private async snapshot(ctx: IpcContext, located: LocatedLens): Promise<ReviewLensSnapshot> {
    const id = addressId(located.address)
    const record = await this.deps.read(located.address)
    const revision = record?.updatedAt ?? 0
    this.revisions.set(id, revision)
    const outdated = record
      ? await this.deps.isOutdated(ctx, located.target, record.current.lens).catch((error) => {
          log.warn('review_lens_outdated_check_failed', { key: located.address.key, error: String(error) })
          return false
        })
      : false
    return {
      ...located.address,
      target: located.target,
      current: record?.current ?? null,
      hasPrevious: !!record?.previous,
      outdated,
      job: this.jobs.get(id) ?? null,
      revision,
    }
  }

  private setJob(address: ReviewLensAddress, job: ReviewLensJob, emit: EmitLens): void {
    const id = addressId(address)
    this.jobs.set(id, job)
    emit({ ...address, job, revision: this.revisions.get(id) ?? 0 })
  }

  /** Run `task` after every earlier write to the same record. */
  private serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    this.queues.set(id, next)
    void next.catch(() => undefined).finally(() => {
      if (this.queues.get(id) === next) this.queues.delete(id)
    })
    return next
  }

  private mutate(
    address: ReviewLensAddress,
    emit: EmitLens,
    apply: (record: ReviewLensRecord) => ReviewLensRecord | Promise<ReviewLensRecord>,
  ): Promise<ReviewLensRecord> {
    const id = addressId(address)
    return this.serialize(id, async () => {
      const record = await this.deps.read(address)
      if (!record) throw new Error('There is no lens for this change.')
      const next = await apply(record)
      if (!await this.deps.write(address, next)) throw new Error("Couldn't save the lens.")
      this.revisions.set(id, next.updatedAt)
      emit({ ...address, job: this.jobs.get(id) ?? null, revision: next.updatedAt })
      return next
    })
  }

  private async start(
    ctx: IpcContext,
    target: ReviewTarget,
    kind: ReviewLensJob['kind'],
    emit: EmitLens,
    plan: (record: ReviewLensRecord | null) => Promise<LensRunPlan>,
  ): Promise<ReviewLensSnapshot | null> {
    const located = await this.deps.locate(ctx, target)
    if (!located) return null
    const { address } = located
    const id = addressId(address)
    // Fail fast on a plan that cannot run (an edit with no lens) before the
    // running job for this target is cancelled.
    await plan(await this.deps.read(address))

    this.running.get(id)?.controller.abort()
    const running: RunningLens = { controller: new AbortController() }
    this.running.set(id, running)
    this.setJob(address, { kind, status: 'queued', updatedAt: this.deps.now() }, emit)
    void this.run(ctx, located, kind, running, emit, plan)
    return this.snapshot(ctx, located)
  }

  private async run(
    ctx: IpcContext,
    { address, target }: LocatedLens,
    kind: ReviewLensJob['kind'],
    running: RunningLens,
    emit: EmitLens,
    plan: (record: ReviewLensRecord | null) => Promise<LensRunPlan>,
  ): Promise<void> {
    const id = addressId(address)
    const signal = running.controller.signal
    const isCurrent = () => this.running.get(id) === running && !signal.aborted
    const step = (value: ReviewProgressStep) => {
      if (isCurrent()) this.setJob(address, { kind, status: 'generating', step: value, updatedAt: this.deps.now() }, emit)
    }
    try {
      step('preparing')
      const resolved = await this.deps.resolveChange(ctx, target)
      if (!isCurrent()) return
      const { change } = resolved
      if (change.patch === null) throw new Error("Couldn't compute the diff for this change.")
      if (!change.patch) throw new Error('There are no changes to review yet.')
      // Plan again against the record as it is now: the lens being edited is
      // the one the user sees when the run starts, not when it was queued.
      const runPlan = await plan(await this.deps.read(address))
      step('analyzing')
      const draft = await this.deps.runAgent({
        workTree: resolved.workTree,
        base: change.base,
        head: change.head,
        inlineDiff: change.patch.length <= MAX_INLINE_DIFF_CHARS ? change.patch : null,
        ledger: await this.deps.readLedger(resolved),
        prompt: runPlan.source.prompt,
        edit: runPlan.edit,
        agent: runPlan.options.agent ?? 'claude-code',
        model: runPlan.options.model ?? null,
        reasoningEffort: runPlan.options.reasoningEffort ?? null,
        onWriting: () => step('writing'),
        abortSignal: signal,
      })
      if (!isCurrent()) return
      if (!draft) throw new Error("The agent didn't return a lens. Try again.")
      const now = this.deps.now()
      const lens: ReviewLens = {
        version: 1,
        key: address.key,
        target: change.target,
        headSha: resolved.headSha,
        baseSha: change.base,
        changeFingerprint: change.changeFingerprint,
        generatedAt: new Date(now).toISOString(),
        source: runPlan.source,
        edits: runPlan.edits,
        title: draft.title,
        html: draft.html,
      }
      const committed = await this.serialize(id, async () => {
        if (!isCurrent()) return null
        const next = commitLens(await this.deps.read(address), lens, this.deps.now(), runPlan.appliedCommentIds)
        if (!await this.deps.write(address, next, isCurrent)) {
          if (!isCurrent()) return null
          throw new Error("Couldn't save the lens.")
        }
        return next
      })
      if (!committed || !isCurrent()) return
      this.running.delete(id)
      this.revisions.set(id, committed.updatedAt)
      this.setJob(address, { kind, status: 'ready', updatedAt: this.deps.now() }, emit)
      log.info('review_lens_ready', { key: address.key, kind })
    } catch (error) {
      if (!isCurrent()) return
      this.running.delete(id)
      const message = error instanceof Error ? error.message : String(error)
      log.warn('review_lens_failed', { key: address.key, kind, error: message })
      this.setJob(address, { kind, status: 'failed', error: message, updatedAt: this.deps.now() }, emit)
    }
  }
}

interface LensRunPlan {
  source: ReviewLens['source']
  edits: ReviewLens['edits']
  edit: LensAgentInput['edit']
  appliedCommentIds: string[] | null
  options: ReviewLensGenerateRequest | ReviewLensEditRequest
}
