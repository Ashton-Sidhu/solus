import type { IpcContext, AgentId, ReasoningEffort } from '../../shared/types'
import type { ReviewContext, ReviewGuide, ReviewProgressEvent, ReviewProgressStep } from '../../shared/review'
import { getEpisodeDiff, getSessionBaseSha } from '../git/session-snapshots'
import { getHeadCommit } from '../git/worktree-manager'
import { createLogger } from '../logger'
import { readLedgerByKey, resolveReviewContext, reviewCheckout, writeGuide } from './ledger'
import { runReviewAgent } from './review-agent'
import { normalizeGuide } from './review-guide-tool'

const log = createLogger('review', 'guide-producer.ts')

export interface GeneratedGuide {
  key: string
  guide: ReviewGuide
}

export interface GenerateGuideOptions {
  agent?: AgentId
  model?: string | null
  reasoningEffort?: ReasoningEffort | null
  /** `'session'` scopes the guide to the current session's changes (diffed from
   *  the session base SHA, ledger filtered to this session) and caches it under a
   *  session-suffixed key. `'branch'` (default) is the full-branch walkthrough. */
  scope?: 'branch' | 'session'
}

/** Where a generation reads/writes and what it diffs. A session walkthrough
 *  points the same episode machinery at the session base SHA under a suffixed
 *  key; a branch walkthrough uses the branch merge-base under the plain key. */
interface GuideTarget {
  guideKey: string
  base: string
  /** Set only for a session walkthrough — filters the ledger to this session. */
  sessionId: string | null
}

/** Resolve the target before dedupe/progress so concurrent session + branch
 *  generations key apart instead of coalescing onto one run. Falls back to the
 *  branch base (but keeps the session key) when no session base is captured, so
 *  the key never drifts from what the renderer asked for. */
function resolveTarget(ctx: IpcContext, review: ReviewContext, opts: GenerateGuideOptions): GuideTarget {
  const sessionId = ctx.session.agentSessionId
  if (opts.scope === 'session' && sessionId) {
    const sessionBase = getSessionBaseSha(review.repoRoot, sessionId)
    const branchBase = review.baseSha && review.baseSha !== 'unknown' ? review.baseSha : 'HEAD'
    return { guideKey: `${review.key}__session-${sessionId}`, base: sessionBase ?? branchBase, sessionId }
  }
  const base = review.baseSha && review.baseSha !== 'unknown' ? review.baseSha : 'HEAD'
  return { guideKey: review.key, base, sessionId: null }
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
const inFlight = new Map<string, Promise<GeneratedGuide | null>>()

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

  const target = resolveTarget(ctx, review, opts)
  const dedupeKey = `${review.repoRoot}::${target.guideKey}`
  const running = inFlight.get(dedupeKey)
  if (running) {
    log.info(`review generation already in flight for ${target.guideKey}; joining it`)
    return running
  }

  // Stamp the (scope-resolved) key onto every phase event so the renderer can
  // match it to the guide it asked for (events broadcast to all subscribers).
  const emit: EmitProgress | undefined = onProgress
    ? (step) => onProgress({ key: target.guideKey, step })
    : undefined

  const run = produceGuide(ctx, opts, review, target, emit).finally(() => inFlight.delete(dedupeKey))
  inFlight.set(dedupeKey, run)
  return run
}

async function produceGuide(
  ctx: IpcContext,
  opts: GenerateGuideOptions,
  review: ReviewContext,
  target: GuideTarget,
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
  const diff = await getEpisodeDiff(workTree, review.repoRoot, base).catch(() => null)
  const patch = diff?.patch?.trim() ?? ''
  const headSha = getHeadCommit(workTree) ?? review.baseSha

  // Ledger is optional enrichment. The branch ledger is shared across sessions, so
  // a session walkthrough filters it to the records this session authored.
  const fullLedger = await readLedgerByKey(review.repoRoot, review.key)
  const ledger = target.sessionId && fullLedger
    ? { ...fullLedger, records: fullLedger.records.filter((r) => r.sessionId === target.sessionId) }
    : fullLedger
  const agent: AgentId = opts.agent ?? 'claude-code'

  if (patch) emit?.('analyzing')
  const draft = patch
    ? await runReviewAgent({ workTree, base, ledger, context: review, agent, model: opts.model ?? null, reasoningEffort: opts.reasoningEffort ?? null, onProgress: emit })
    : null

  const guide: ReviewGuide = draft
    ? {
        version: 1,
        key: target.guideKey,
        headSha,
        baseSha: base,
        ...normalizeGuide(draft, {
          changedFiles: changedFilesFromPatch(patch),
          ledgerIds: (ledger?.records ?? []).map((r) => r.id),
        }),
      }
    : fallbackGuide(target.guideKey, headSha, base, patch ? AGENT_FAILED : NOTHING_TO_REVIEW)

  const ok = await writeGuide(review.repoRoot, guide)
  if (!ok) log.warn(`failed to cache review guide for ${target.guideKey}`)
  return { key: target.guideKey, guide }
}

const NOTHING_TO_REVIEW = 'No changes to review on this branch yet.'
const AGENT_FAILED = "The review agent didn't return a guide. Regenerate to retry."

/** Minimal guide for the empty / agent-failed cases, so the renderer always has
 *  a well-formed `ReviewGuide` to show. */
function fallbackGuide(key: string, headSha: string, baseSha: string, message: string): ReviewGuide {
  return {
    version: 1,
    key,
    headSha,
    baseSha,
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
