import { stat } from 'node:fs/promises'
import type { IpcContext } from '@solus/contracts/types'
import { worktreeProjectRoot } from '@solus/contracts/types'
import type { ReviewContext, ReviewGuide } from '@solus/contracts/review'
import { createLogger } from '../logger'
import { gitCommitExists, runAsync } from '../git/exec'
import { resolveRepoRoot } from '../git/git-helpers'
import { getDefaultBranch, getHeadCommit, getWorkingBranch } from '../git/worktree-manager'
import { getSessionBaseSha } from '../git/session-snapshots'
import { readJson, reviewGuidePath, writeJsonAtomic } from './review-store'

const log = createLogger('review', 'review-context.ts')

/** Branch names contain slashes (e.g. `feat/foo`); flatten them so the key is
 *  a single safe path segment. */
export function sanitizeKey(branch: string): string {
  return branch.replace(/\//g, '__')
}

/**
 * The checkout a review call resolves against. For PR-review and worktree-
 * isolation sessions the branch under review lives in the worktree, so that
 * path wins; otherwise it's the session's own directory. This is the same
 * checkout the agent runs in, which is what keeps the companion keyed on the
 * branch the user is actually reviewing. Every review entry point funnels
 * through here so the callers can't drift apart — that drift is what kept
 * keying PR companions as `main-<sha>` while the reader looked up `solus__pr-N`.
 */
export function reviewCheckout(ctx: Pick<IpcContext, 'session'>): string | null {
  const dir = ctx.session.gitContext?.worktreePath || ctx.session.workingDirectory || ctx.session.projectPath
  return dir && dir !== '~' ? dir : null
}

/** Repository identity for review artifacts — always the main project root
 *  (stable across a worktree's lifecycle), matching `ReviewContext.repoRoot`.
 *  Guides use this identity under the host data directory; review state
 *  remains project-local. */
export async function reviewRepoRoot(ctx: IpcContext): Promise<string | null> {
  const checkout = reviewCheckout(ctx)
  if (!checkout) return null
  const root = await resolveRepoRoot(checkout)
  return root ? worktreeProjectRoot(root) : null
}

/** What one checkout answers the same for every session in it. A batch of
 *  probes over many sessions of one project resolves this once instead of
 *  spawning the same four git reads per session. */
interface CheckoutFacts {
  repoRoot: string
  branch: string
  targetBranch: string
  headSha: string | null
  /** Where the branch diverged from its target; null on the default branch or
   *  when the merge-base cannot be resolved. */
  branchBase: string | null
}

/** Shared by the callers of one batch. Keyed by checkout path; holds the
 *  in-flight promise so concurrent probes of one checkout coalesce. */
export type CheckoutFactsCache = Map<string, Promise<CheckoutFacts | null>>

async function resolveCheckoutFacts(cwd: string): Promise<CheckoutFacts | null> {
  const checkoutRoot = await resolveRepoRoot(cwd)
  if (!checkoutRoot) return null
  // The MAIN project root is the stable repository identity for host-stored
  // guides and project-local review state. The branch/base, however, come from the
  // actual checkout: for a worktree (PR review, isolation) that's the worktree's
  // own branch (e.g. `solus/pr-7`), not whatever the main checkout happens to
  // sit on. Resolving these from the stripped main root is what made the PR
  // companion key as `main-<sha>` while the reader looked up `solus__pr-N` — a
  // permanent cache miss that regenerated the report on every open.
  const repoRoot = worktreeProjectRoot(checkoutRoot)
  const branch = await getWorkingBranch(cwd)
  if (!branch) return null
  const targetBranch = await getDefaultBranch(cwd)
  let branchBase: string | null = null
  if (branch !== targetBranch) {
    try {
      branchBase = (await runAsync('git', ['merge-base', targetBranch, 'HEAD'], cwd)).trim() || null
    } catch {
      /* fall through to the session base */
    }
  }
  return { repoRoot, branch, targetBranch, headSha: await getHeadCommit(cwd), branchBase }
}

/** Episode base SHA: where the branch diverged from its target. On the default
 *  branch there is no merge-base window, so we use the session's captured base
 *  SHA (stable across commits within the session). */
async function resolveBaseSha(checkout: string, facts: CheckoutFacts, sessionId: string | null): Promise<string> {
  if (facts.branchBase) return facts.branchBase
  // The session sidecar is stored at the main project root, not the checkout.
  if (sessionId) {
    const sessionBase = getSessionBaseSha(facts.repoRoot, sessionId)
    if (sessionBase) {
      if (await gitCommitExists(checkout, sessionBase)) return sessionBase
      log.warn('review_session_base_unavailable', { sessionId, baseSha: sessionBase })
    }
  }
  return facts.headSha ?? 'unknown'
}

/** Resolve the git/episode facts the review companion is keyed on. */
export async function resolveReviewContext(
  cwd: string | null | undefined,
  sessionId: string | null | undefined,
  factsCache?: CheckoutFactsCache,
): Promise<ReviewContext | null> {
  if (!cwd || cwd === '~') return null
  let pending = factsCache?.get(cwd)
  if (!pending) {
    pending = resolveCheckoutFacts(cwd)
    factsCache?.set(cwd, pending)
  }
  const facts = await pending
  if (!facts) return null
  const { repoRoot, branch, targetBranch } = facts
  const baseSha = await resolveBaseSha(cwd, facts, sessionId ?? null)

  const key = branch === targetBranch ? `main-${baseSha}` : sanitizeKey(branch)

  // Deliberately local-only. This resolves the base the review pane's diff is
  // computed against, so every await here sits between the click and the first
  // painted hunk — a provider lookup for the branch's pull request belongs to
  // the Git status, which already reports it, and not on this path.
  return {
    key,
    branch,
    targetBranch,
    baseSha,
    headSha: facts.headSha ?? baseSha,
    repoRoot,
  }
}

/** Read the cached review guide for a key, or null if it hasn't been generated
 *  yet (or the cache is corrupt). Exactly one `<key>.json` exists per episode
 *  (overwritten in place on regeneration), so there is never a stale pile to
 *  disambiguate. */
export async function readGuideByKey(repoRoot: string, key: string): Promise<ReviewGuide | null> {
  const path = reviewGuidePath(repoRoot, key)
  const guide = await readJson<ReviewGuide>(path)
  if (!guide || guide.generatedAt) return guide
  try {
    return { ...guide, generatedAt: (await stat(path)).mtime.toISOString() }
  } catch {
    return guide
  }
}

/** Overwrite the cached review guide in host storage (atomic tmp + rename).
 *  Nothing is written when `canCommit` says no at the last moment. */
export async function writeGuide(
  repoRoot: string,
  guide: ReviewGuide,
  canCommit?: () => boolean,
): Promise<boolean> {
  return writeJsonAtomic(reviewGuidePath(repoRoot, guide.key), guide, `guide ${guide.key}`, canCommit)
}
