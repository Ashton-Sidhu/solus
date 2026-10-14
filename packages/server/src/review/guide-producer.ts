import type { IpcContext, AgentId } from '@solus/contracts/types'
import { type ReviewContext, type ReviewGuide, type ReviewGuideRequestOptions, type ReviewProgressStep, type ReviewTarget } from '@solus/contracts/review'
import { getDiff, getEpisodeDiff, getSessionSnapshotRange } from '../git/session-snapshots'
import { getHeadCommit } from '../git/worktree-manager'
import { createLogger } from '../logger'
import { resolveReviewContext, reviewCheckout } from './review-context'
import { runReviewAgent } from './review-agent'
import { contextPreferences } from '../execution/agents/run-input'
import { normalizeGuide } from './review-guide-tool'
import { fingerprintReviewPatch, guideKeyForTarget, normalizedReviewTarget, reviewedSessionId } from './review-target'
import type { AgentDispatcher } from '../execution/agents/agent-runner'
import type { SeatResolver } from '../execution/seats/seat-manager'
import { runAsync } from '../git/exec'

const log = createLogger('review', 'guide-producer.ts')

/** Cap on the diff we inline into the review prompt. The diff enters the agent's
 *  context either way — as an inlined patch, or as the tool-result of the
 *  `git diff` the agent would otherwise run — so this isn't about total tokens.
 *  It's the point past which we'd rather the agent selectively scope the change
 *  with `-- <path>` than load it whole. Below it, inlining removes the serial
 *  git round-trips and lets the review run at lower reasoning. ~60KB ≈ a
 *  ~1,500-line diff. */
const MAX_INLINE_DIFF_CHARS = 60_000

export interface GeneratedGuide {
  key: string
  guide: ReviewGuide
  /** True only when this guide was atomically written to its stable target. */
  persisted: boolean
  /** The guide finished, but the change moved on while it was authoring. It is
   * still saved for the content it read. Distinct from a failure: nothing went
   * wrong and the content it describes is no longer the live content. */
  outdated?: boolean
  /** A validated model guide, ready for the job owner to commit. A fallback
   * (nothing to review, agent failure) is shown but never saved. */
  authored?: boolean
}

export type GenerateGuideOptions = ReviewGuideRequestOptions

/** Where a generation reads/writes and what it diffs. Session and stacked
 * walkthroughs suffix their stable key so distinct bases never coalesce.
 * Review lenses resolve the same way, so a lens and a guide for one target
 * always read the same change. */
export interface GuideTarget {
  guideKey: string
  scope: 'working-tree' | 'branch' | 'session' | 'pr'
  target: ReviewTarget
  base: string
  /** Exact captured head for a session target. Other scopes use the live tree. */
  head: string | null
  /** Set only for a session walkthrough — the session whose snapshot is reviewed. */
  sessionId: string | null
  patch: string | null
  changeFingerprint: string
}

function resolveSessionGuideTarget(
  review: ReviewContext,
  target: Extract<ReviewTarget, { kind: 'session' }>,
  sessionId: string | null,
): Omit<GuideTarget, 'patch' | 'changeFingerprint'> {
  const targetSessionId = target.sessionId ?? sessionId
  const sessionRange = targetSessionId ? getSessionSnapshotRange(review.repoRoot, targetSessionId) : null
  const branchBase = review.baseSha && review.baseSha !== 'unknown' ? review.baseSha : 'HEAD'
  return {
    guideKey: guideKeyForTarget(review, target, sessionId),
    scope: 'session',
    target,
    base: sessionRange?.baseSha ?? branchBase,
    head: sessionRange?.headSha ?? null,
    sessionId: targetSessionId,
  }
}

function branchGuideBase(ctx: Pick<IpcContext, 'session'>, review: ReviewContext, target: ReviewTarget): string {
  // PR panes and the batch queue retain branch cache keys. Their prepared PR
  // base is authoritative; local main can be months behind the pull request.
  const prReview = ctx.session.prReview
  if (target.kind === 'branch' && !target.targetBranch
    && prReview?.worktreePath === reviewCheckout(ctx) && prReview.headSha === review.headSha) {
    return prReview.baseSha
  }
  return review.baseSha && review.baseSha !== 'unknown' ? review.baseSha : 'HEAD'
}

/** Resolve the target before dedupe/progress so concurrent base variants key
 * apart instead of coalescing onto one run. Session fallback keeps its requested
 * key; stacked generation resolves the parent/child merge-base once, up front. */
export async function resolveTargetBase(ctx: Pick<IpcContext, 'session'>, review: ReviewContext, opts: GenerateGuideOptions): Promise<Omit<GuideTarget, 'patch' | 'changeFingerprint'>> {
  const sessionId = reviewedSessionId(ctx)
  const target = normalizedReviewTarget(opts, sessionId)
  if (target.kind === 'session') return resolveSessionGuideTarget(review, target, sessionId)
  let branchBase = target.kind === 'working-tree'
    ? 'HEAD'
    : target.kind === 'pr' && target.baseSha
      ? target.baseSha
      : branchGuideBase(ctx, review, target)
  if (target.kind === 'branch' && target.targetBranch) {
    const workTree = reviewCheckout(ctx) ?? review.repoRoot
    // A target branch the user names is not guaranteed to exist locally — it may
    // be unfetched, deleted, or simply mistyped. Let it fall back to the branch
    // divergence point the review context already resolved, the same way the
    // sibling diff path degrades, rather than rejecting the whole review RPC.
    try {
      branchBase = await runAsync('git', ['merge-base', target.targetBranch, 'HEAD'], workTree)
    } catch (error) {
      log.warn('review_merge_base_failed', { targetBranch: target.targetBranch, error: String(error) })
    }
  }
  const baseKey = guideKeyForTarget(review, target, sessionId ?? null)
  if (target.kind === 'pr') return { guideKey: baseKey, scope: 'pr', target, base: branchBase, head: target.headSha ?? null, sessionId: null }
  return { guideKey: baseKey, scope: target.kind, target, base: branchBase, head: null, sessionId: null }
}

/** The live content identity for one base. Split out because a status probe
 * needs exactly this and nothing else: re-resolving the whole target there
 * would redo the branch/session base lookup — including a second
 * `git merge-base` — to arrive at the base it was already handed. */
export async function changeSnapshotFor(
  workTree: string,
  review: ReviewContext,
  target: Pick<GuideTarget, 'base' | 'guideKey' | 'scope' | 'sessionId' | 'head'>,
): Promise<{ patch: string | null; changeFingerprint: string }> {
  try {
    const diff = target.scope === 'pr' && target.head
      ? { patch: await runAsync('git', ['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', target.base, target.head, '--'], workTree, { maxBuffer: 50 * 1024 * 1024 }) }
      : target.scope === 'session' && target.sessionId
      ? await getDiff(null, review.repoRoot, { kind: 'session' }, target.sessionId, [])
      : await getEpisodeDiff(workTree, review.repoRoot, target.base)
    if (!diff) throw new Error('Session snapshot is unavailable.')
    const patch = diff.patch.trim()
    return { patch, changeFingerprint: fingerprintReviewPatch(patch) }
  } catch (error) {
    log.warn('episode_diff_failed', { guideKey: target.guideKey, error: String(error) })
    return {
      patch: null,
      changeFingerprint: fingerprintReviewPatch(`unresolved:${target.base}:${review.headSha}`),
    }
  }
}

export async function resolveTarget(ctx: Pick<IpcContext, 'session'>, review: ReviewContext, opts: GenerateGuideOptions): Promise<GuideTarget> {
  const target = await resolveTargetBase(ctx, review, opts)
  const workTree = reviewCheckout(ctx) ?? review.repoRoot
  return { ...target, ...await changeSnapshotFor(workTree, review, target) }
}

/** Emits a phase transition for the run that is authoring a guide. */
export type EmitProgress = (step: ReviewProgressStep) => void

/**
 * Author a guide for the change `opts` names in `ctx`. It never writes the
 * guide: the job owner (`ReviewGuideJobs`) commits it. `onRead` hears the exact
 * change before the model starts. Null when there is no checkout to review or
 * the run was stopped.
 */
export async function authorGuide(
  dispatcher: AgentDispatcher,
  ctx: IpcContext,
  opts: GenerateGuideOptions,
  signal: AbortSignal,
  emit: EmitProgress,
  seatFor?: SeatResolver,
  onRead?: (target: GuideTarget, review: ReviewContext) => void,
): Promise<GeneratedGuide | null> {
  const review = await resolveReviewContext(reviewCheckout(ctx), reviewedSessionId(ctx))
  if (!review || signal.aborted) return null
  const target = await resolveTarget(ctx, review, opts)
  if (signal.aborted) return null
  onRead?.(target, review)
  return produceGuide(dispatcher, ctx, opts, review, target, signal, seatFor, emit)
}

async function produceGuide(
  dispatcher: AgentDispatcher,
  ctx: IpcContext,
  opts: GenerateGuideOptions,
  review: ReviewContext,
  target: GuideTarget,
  abortSignal: AbortSignal,
  seatFor: SeatResolver | undefined,
  emit: EmitProgress,
): Promise<GeneratedGuide | null> {
  emit('preparing')
  // Gate on whether the target has anything to review. Branch-like targets use
  // their base versus the live tree. A session uses its captured base-to-head
  // snapshot, so changes from another session in the shared tree cannot leak in.
  // We also keep the patch for coverage validation and the small-diff prompt.
  const workTree = reviewCheckout(ctx) ?? review.repoRoot
  const base = target.base
  const headSha = await resolvedGuideHead(target, workTree, review)

  // Target resolution computed the exact patch, so every author run is tied to
  // one content fingerprint.
  if (target.patch === null) {
    return { key: target.guideKey, guide: fallbackGuide(target.guideKey, headSha, base, DIFF_FAILED, target.changeFingerprint), persisted: false }
  }
  const patch = target.patch

  const agent: AgentId = opts.agent ?? 'claude-code'

  // Inline the diff we already computed when it's small enough. That lets the
  // agent skip the serial git round-trips (stat → diff → ls-files → reads) and go
  // straight to composing. The resolved patch already includes captured new
  // files, so the inline path needs no git at all. Oversized diffs stay out of
  // the prompt and the agent gathers the exact base/head range itself.
  const inlineDiff = patch.length <= MAX_INLINE_DIFF_CHARS ? patch : null

  if (patch) emit('analyzing')
  const draft = patch
    ? await runReviewAgent(dispatcher, {
      workTree,
      base,
      head: target.head,
      context: review,
      agent,
      model: opts.model ?? null,
      // The guide runs on the requester's own provider login, as their turns do.
      seat: await seatFor?.(agent) ?? undefined,
      reasoningEffort: opts.reasoningEffort ?? null,
      reviewGuideInstructions: ctx.settings.reviewGuideInstructions,
      executionPreferences: contextPreferences(ctx),
      requestInstructions: opts.instructions,
      inlineDiff,
      onProgress: emit,
      abortSignal,
    })
    : null

  if (abortSignal.aborted) return null

  // Only a real guide is cached. Fallbacks (empty branch, agent failure) are
  // returned for display but never persisted — a cached "no changes" / "retry"
  // guide would keep shadowing the branch after it gains real changes, since
  // readers prefer the cache.
  if (!draft) {
    return {
      key: target.guideKey,
      guide: fallbackGuide(target.guideKey, headSha, base, patch ? AGENT_FAILED : NOTHING_TO_REVIEW, target.changeFingerprint),
      persisted: false,
    }
  }

  const guide: ReviewGuide = {
    version: 1,
    key: target.guideKey,
    target: target.target,
    headSha,
    baseSha: base,
    changeFingerprint: target.changeFingerprint,
    generatedAt: new Date().toISOString(),
    ...normalizeGuide(draft, { patch }),
  }

  return { key: target.guideKey, guide, persisted: false, authored: true }
}

export async function resolvedGuideHead(target: GuideTarget, workTree: string, review: ReviewContext): Promise<string> {
  if (target.head) return target.head
  return await getHeadCommit(workTree) ?? review.baseSha
}

const NOTHING_TO_REVIEW = 'No changes to review on this branch yet.'
const AGENT_FAILED = "The review agent didn't return a guide. Regenerate to retry."
const DIFF_FAILED = "Couldn't compute the diff for this change. Regenerate to retry."

/** Minimal guide for the empty / agent-failed cases, so the renderer always has
 *  a well-formed `ReviewGuide` to show. */
function fallbackGuide(key: string, headSha: string, baseSha: string, message: string, changeFingerprint?: string): ReviewGuide {
  return {
    version: 1,
    key,
    headSha,
    baseSha,
    changeFingerprint,
    generatedAt: new Date().toISOString(),
    title: 'Review guide',
    summary: message,
    sections: [],
  }
}
