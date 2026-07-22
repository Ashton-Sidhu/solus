import type { IpcContext, AgentId, ReasoningEffort } from '../../shared/types'
import { reviewGuideKeyForBase, type ReviewContext, type ReviewGuide, type ReviewProgressEvent, type ReviewProgressStep } from '../../shared/review'
import { getEpisodeDiff, getSessionBaseSha, resolvePrDiffBase } from '../git/session-snapshots'
import { getHeadCommit } from '../git/worktree-manager'
import { createLogger } from '../logger'
import { readLedgerByKey, resolveReviewContext, reviewCheckout, writeGuide } from './ledger'
import { runReviewAgent } from './review-agent'
import { normalizeGuide } from './review-guide-tool'
import { guideKeyFor } from './review-target'

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
}

export interface GenerateGuideOptions {
  agent?: AgentId
  model?: string | null
  reasoningEffort?: ReasoningEffort | null
  /** `'session'` scopes the guide to the current session's changes (diffed from
   *  the session base SHA, ledger filtered to this session) and overwrites that
   *  session's stable guide. `'branch'` (default) overwrites the branch guide. */
  scope?: 'branch' | 'session'
  /** Live stacked parent selected by the renderer. Main resolves its merge-base
   *  with the checked-out PR head before diffing. */
  ownDeltaBase?: { parent: number; headSha: string }
}

/** Where a generation reads/writes and what it diffs. Session and stacked
 * walkthroughs suffix their stable key so distinct bases never coalesce. */
interface GuideTarget {
  guideKey: string
  base: string
  /** Set only for a session walkthrough — filters the ledger to this session. */
  sessionId: string | null
}

/** Resolve the target before dedupe/progress so concurrent base variants key
 * apart instead of coalescing onto one run. Session fallback keeps its requested
 * key; stacked generation resolves the parent/child merge-base once, up front. */
async function resolveTarget(ctx: IpcContext, review: ReviewContext, opts: GenerateGuideOptions): Promise<GuideTarget> {
  const sessionId = ctx.session.agentSessionId
  if (opts.scope === 'session' && sessionId) {
    const sessionBase = getSessionBaseSha(review.repoRoot, sessionId)
    const branchBase = review.baseSha && review.baseSha !== 'unknown' ? review.baseSha : 'HEAD'
    return { guideKey: guideKeyFor(review, opts.scope, sessionId), base: sessionBase ?? branchBase, sessionId }
  }
  const branchBase = review.baseSha && review.baseSha !== 'unknown' ? review.baseSha : 'HEAD'
  const baseKey = guideKeyFor(review, opts.scope, sessionId ?? null)
  if (!opts.ownDeltaBase) return { guideKey: baseKey, base: branchBase, sessionId: null }

  const workTree = reviewCheckout(ctx) ?? review.repoRoot
  const base = await resolvePrDiffBase(workTree, review.repoRoot, {
    kind: 'pr',
    baseSha: branchBase,
    ownDeltaBaseSha: opts.ownDeltaBase.headSha,
    parentPr: opts.ownDeltaBase.parent,
  })
  return {
    guideKey: reviewGuideKeyForBase(baseKey, opts.ownDeltaBase.headSha),
    base,
    sessionId: null,
  }
}

/** Emits a phase transition for the in-flight generation. The key is attached by
 *  `generateGuide` once the review context resolves. */
export type EmitProgress = (step: ReviewProgressStep) => void

/**
 * In-flight generations keyed by `repoRoot::key`. A guide takes a full agent run
 * to produce and isn't cached until it finishes, so without this a second caller
 * (re-entering the PR review, another tab, the regenerate button) would see no
 * cache and kick off a duplicate agent run that races to write the same file.
 * Coalescing onto the live promise means concurrent callers share one run.
 */
type InFlightGuide = {
  promise: Promise<GeneratedGuide | null>
  abortController: AbortController
}

const inFlight = new Map<string, InFlightGuide>()

/**
 * The producer. Always reviews the diff; enriches with the ledger when one
 * exists. The review agent authors a structured guide via the
 * `submit_review_guide` tool (no HTML, no template); the producer validates it
 * against the real change (coverage + ledger-ref existence), stamps the identity
 * fields, and overwrites the cached `review/<key>.json`. Returns null only when
 * there is no git episode to review.
 *
 * Deduped per (repoRoot, key): if a generation is already running for the same
 * branch, callers join it instead of starting another.
 */
export async function generateGuide(
  ctx: IpcContext,
  opts: GenerateGuideOptions = {},
  onProgress?: (event: ReviewProgressEvent) => void,
): Promise<GeneratedGuide | null> {
  // Resolve from the actual checkout (the worktree, for PR review / isolation) so
  // the guide is keyed on that branch — matching the key the renderer reads.
  // Storage still re-roots at the main project root (see ReviewContext.repoRoot).
  const review = await resolveReviewContext(reviewCheckout(ctx), ctx.session.agentSessionId)
  if (!review) return null

  const target = await resolveTarget(ctx, review, opts)
  const dedupeKey = `${review.repoRoot}::${target.guideKey}`
  const running = inFlight.get(dedupeKey)
  if (running) {
    log.info(`review generation already in flight for ${target.guideKey}; joining it`)
    return running.promise
  }

  // Stamp the (scope-resolved) key onto every phase event so the renderer can
  // match it to the guide it asked for (events broadcast to all subscribers).
  const emit: EmitProgress | undefined = onProgress
    ? (step) => onProgress({ key: target.guideKey, step })
    : undefined

  const abortController = new AbortController()
  const run = produceGuide(ctx, opts, review, target, abortController.signal, emit).finally(() => inFlight.delete(dedupeKey))
  inFlight.set(dedupeKey, { promise: run, abortController })
  return run
}

export async function cancelGenerateGuide(
  ctx: IpcContext,
  opts: Pick<GenerateGuideOptions, 'scope' | 'ownDeltaBase'> = {},
): Promise<boolean> {
  const review = await resolveReviewContext(reviewCheckout(ctx), ctx.session.agentSessionId)
  if (!review) return false
  const target = await resolveTarget(ctx, review, opts)
  const dedupeKey = `${review.repoRoot}::${target.guideKey}`
  const running = inFlight.get(dedupeKey)
  if (!running) return false
  running.abortController.abort()
  inFlight.delete(dedupeKey)
  return true
}

async function produceGuide(
  ctx: IpcContext,
  opts: GenerateGuideOptions,
  review: ReviewContext,
  target: GuideTarget,
  abortSignal: AbortSignal,
  emit?: EmitProgress,
): Promise<GeneratedGuide | null> {
  emit?.('preparing')
  // Gate on whether the episode has anything to review — `target.base` (branch
  // divergence point, or the session base for a session walkthrough) vs the live
  // working tree, so committed-on-branch work, uncommitted edits, and untracked
  // files are all in scope. The agent re-derives the diff itself from
  // `base`/`workTree`; we only need the patch here to decide "review" vs "nothing
  // to review" and to validate coverage.
  const workTree = reviewCheckout(ctx) ?? review.repoRoot
  const base = target.base
  const headSha = getHeadCommit(workTree) ?? review.baseSha

  // A diff *failure* (unreachable base after a rebase, oversized patch) is not
  // an *empty* diff — surface it as a retryable fallback, never as "nothing to
  // review", and never cache it.
  let patch: string
  try {
    const diff = await getEpisodeDiff(workTree, review.repoRoot, base)
    patch = diff?.patch?.trim() ?? ''
  } catch (err) {
    log.warn(`episode diff failed for ${target.guideKey}: ${String(err)}`)
    return { key: target.guideKey, guide: fallbackGuide(target.guideKey, headSha, base, DIFF_FAILED), persisted: false }
  }

  // Ledger is optional enrichment. The branch ledger is shared across sessions, so
  // a session walkthrough filters it to the records this session authored.
  const fullLedger = await readLedgerByKey(review.repoRoot, review.key)
  const ledger = target.sessionId && fullLedger
    ? { ...fullLedger, records: fullLedger.records.filter((r) => r.sessionId === target.sessionId) }
    : fullLedger
  const agent: AgentId = opts.agent ?? 'claude-code'

  // Inline the diff we already computed when it's small enough. That lets the
  // agent skip the serial git round-trips (stat → diff → ls-files → reads) and go
  // straight to composing. The patch already includes untracked/new files
  // (getEpisodeDiff stages them intent-to-add), so the inline path needs no git at
  // all. Oversized diffs stay out of the prompt and the agent gathers (and
  // selectively scopes) them itself. (Reasoning effort is settings-driven and
  // independent of this — see resolveReviewAgent.)
  const inlineDiff = patch.length <= MAX_INLINE_DIFF_CHARS ? patch : null

  if (patch) emit?.('analyzing')
  const draft = patch
    ? await runReviewAgent({ workTree, base, ledger, context: review, agent, model: opts.model ?? null, reasoningEffort: opts.reasoningEffort ?? null, inlineDiff, onProgress: emit, abortSignal })
    : null

  if (abortSignal.aborted) return null

  // Only a real guide is cached. Fallbacks (empty branch, agent failure) are
  // returned for display but never persisted — a cached "no changes" / "retry"
  // guide would keep shadowing the branch after it gains real changes, since
  // readers prefer the cache.
  if (!draft) {
    return {
      key: target.guideKey,
      guide: fallbackGuide(target.guideKey, headSha, base, patch ? AGENT_FAILED : NOTHING_TO_REVIEW),
      persisted: false,
    }
  }

  const guide: ReviewGuide = {
    version: 1,
    key: target.guideKey,
    headSha,
    baseSha: base,
    generatedAt: new Date().toISOString(),
    ...normalizeGuide(draft, {
      changedFiles: changedFilesFromPatch(patch),
      ledgerIds: (ledger?.records ?? []).map((r) => r.id),
    }),
  }

  const ok = await writeGuide(review.repoRoot, guide)
  if (!ok) log.warn(`failed to cache review guide for ${target.guideKey}`)
  return { key: target.guideKey, guide, persisted: ok }
}

const NOTHING_TO_REVIEW = 'No changes to review on this branch yet.'
const AGENT_FAILED = "The review agent didn't return a guide. Regenerate to retry."
const DIFF_FAILED = "Couldn't compute the diff for this change. Regenerate to retry."

/** Minimal guide for the empty / agent-failed cases, so the renderer always has
 *  a well-formed `ReviewGuide` to show. */
function fallbackGuide(key: string, headSha: string, baseSha: string, message: string): ReviewGuide {
  return {
    version: 1,
    key,
    headSha,
    baseSha,
    generatedAt: new Date().toISOString(),
    title: 'Review guide',
    summary: message,
    sections: [],
  }
}

/** Post-image paths of every file in a unified diff (the paths the agent
 *  references in the guide). Parsed from the `diff --git a/… b/…` headers, which
 *  every changed file — tracked, untracked, or renamed — produces exactly one
 *  of. (quotepath is off upstream, so paths are unquoted.) */
function changedFilesFromPatch(patch: string): string[] {
  const files = new Set<string>()
  for (const line of patch.split('\n')) {
    const m = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (m) files.add(m[2])
  }
  return [...files]
}
