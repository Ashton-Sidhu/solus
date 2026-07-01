import { existsSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcContext } from '../../shared/types'
import { worktreeProjectRoot } from '../../shared/types'
import type { ReviewContext, ReviewGuide, ReviewLedger } from '../../shared/review'
import { createLogger } from '../logger'
import { runAsync } from '../git/exec'
import { resolveRepoRoot } from '../git/git-helpers'
import { getDefaultBranch, getExistingPR, getHeadCommit, getWorkingBranch } from '../git/worktree-manager'
import { getSessionBaseSha } from '../git/session-snapshots'
import { artifactPath, readJson, writeJsonAtomic } from './review-store'

const log = createLogger('review', 'ledger.ts')

const LEDGER_SUBDIR = 'ledger'
const GUIDE_SUBDIR = 'review'
const DECISIONS_SUBDIR = 'decisions'

/** Branch names contain slashes (e.g. `feat/foo`); flatten them so the key is
 *  a single safe path segment. */
export function sanitizeKey(branch: string): string {
  return branch.replace(/\//g, '__')
}

function ledgerPath(repoRoot: string, key: string): string {
  return artifactPath(repoRoot, LEDGER_SUBDIR, key)
}

function guidePath(repoRoot: string, key: string): string {
  return artifactPath(repoRoot, GUIDE_SUBDIR, key)
}

function decisionsPath(repoRoot: string, key: string): string {
  return artifactPath(repoRoot, DECISIONS_SUBDIR, key)
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
export function reviewCheckout(ctx: IpcContext): string | null {
  const dir = ctx.session.gitContext?.worktreePath || ctx.session.workingDirectory || ctx.session.projectPath
  return dir && dir !== '~' ? dir : null
}

/** Storage root for review artifacts — always the main project root (stable
 *  across a worktree's lifecycle), matching `ReviewContext.repoRoot`. Used by
 *  the read/write handlers that already know the key and only need the root. */
export async function reviewRepoRoot(ctx: IpcContext): Promise<string | null> {
  const checkout = reviewCheckout(ctx)
  if (!checkout) return null
  const root = await resolveRepoRoot(checkout)
  return root ? worktreeProjectRoot(root) : null
}

/** Episode base SHA: where the branch diverged from its target. On the default
 *  branch there is no merge-base window, so we use the session's captured base
 *  SHA (stable across commits within the session). */
async function resolveBaseSha(
  checkout: string,
  repoRoot: string,
  branch: string,
  targetBranch: string,
  sessionId: string | null,
): Promise<string> {
  if (branch !== targetBranch) {
    try {
      const sha = await runAsync('git', ['merge-base', targetBranch, 'HEAD'], checkout)
      if (sha) return sha.trim()
    } catch {
      /* fall through */
    }
  }
  // The session sidecar is stored at the main project root, not the checkout.
  if (sessionId) {
    const sessionBase = getSessionBaseSha(repoRoot, sessionId)
    if (sessionBase) return sessionBase
  }
  return getHeadCommit(checkout) ?? 'unknown'
}

/**
 * Resolve the git/episode facts the review companion is keyed on, and
 * opportunistically promote a `main-<sha>` ledger that has since been carried
 * onto a branch (the "work on main, then branch" flow) so context isn't
 * orphaned.
 */
export async function resolveReviewContext(
  cwd: string | null | undefined,
  sessionId: string | null | undefined,
): Promise<ReviewContext | null> {
  if (!cwd || cwd === '~') return null
  const checkoutRoot = await resolveRepoRoot(cwd)
  if (!checkoutRoot) return null

  // Review artifacts (ledger + companion) are stored at the MAIN project root so
  // the cache is stable across a worktree's lifecycle and every reader/writer
  // agrees on one location. The branch/base, however, come from the actual
  // checkout: for a worktree (PR review, isolation) that's the worktree's own
  // branch (e.g. `solus/pr-7`), not whatever the main checkout happens to sit on.
  // Resolving these from the stripped main root is what made the PR companion
  // key as `main-<sha>` while the reader looked up `solus__pr-N` — a permanent
  // cache miss that regenerated the report on every open.
  const repoRoot = worktreeProjectRoot(checkoutRoot)
  const branch = getWorkingBranch(cwd)
  if (!branch) return null
  const targetBranch = getDefaultBranch(cwd)
  const baseSha = await resolveBaseSha(cwd, repoRoot, branch, targetBranch, sessionId ?? null)

  const onDefault = branch === targetBranch
  const key = onDefault ? `main-${baseSha}` : sanitizeKey(branch)

  if (!onDefault) {
    await maybePromoteFromMain(repoRoot, key, baseSha)
  }

  const prUrl = onDefault ? null : await getExistingPR(branch, checkoutRoot).catch(() => null)

  return {
    key,
    branch,
    targetBranch,
    baseSha,
    repoRoot,
    ...(prUrl ? { prUrl } : {}),
  }
}

/** When work started on `main` then moved to a branch, the branch's divergence
 *  point still matches the old `main-<baseSha>` key. Rename that episode's files
 *  to the branch key instead of restarting. */
async function maybePromoteFromMain(repoRoot: string, branchKey: string, baseSha: string): Promise<void> {
  const mainKey = `main-${baseSha}`
  if (mainKey === branchKey) return
  if (existsSync(ledgerPath(repoRoot, branchKey))) return // branch episode already exists
  if (!existsSync(ledgerPath(repoRoot, mainKey))) return

  for (const pathFor of [ledgerPath, guidePath, decisionsPath]) {
    const from = pathFor(repoRoot, mainKey)
    const to = pathFor(repoRoot, branchKey)
    if (!existsSync(from)) continue
    try {
      const dir = join(to, '..')
      if (!existsSync(dir)) await mkdir(dir, { recursive: true })
      await rename(from, to)
    } catch (err) {
      log.warn(`promote ${mainKey} → ${branchKey} failed for ${from}: ${String(err)}`)
    }
  }

  // The promoted ledger still carries the old key internally; realign it.
  const ledger = await readLedgerByKey(repoRoot, branchKey)
  if (ledger && ledger.key !== branchKey) {
    ledger.key = branchKey
    await writeLedger(repoRoot, ledger)
  }
  log.info(`promoted review ledger ${mainKey} → ${branchKey}`)
}

export async function readLedgerByKey(repoRoot: string, key: string): Promise<ReviewLedger | null> {
  return readJson<ReviewLedger>(ledgerPath(repoRoot, key))
}

/** Read the ledger for the current episode (resolves the key from ctx). */
export async function readLedger(ctx: IpcContext): Promise<ReviewLedger | null> {
  const review = await resolveReviewContext(reviewCheckout(ctx), ctx.session.agentSessionId)
  if (!review) return null
  return readLedgerByKey(review.repoRoot, review.key)
}

export async function writeLedger(repoRoot: string, ledger: ReviewLedger): Promise<boolean> {
  return writeJsonAtomic(ledgerPath(repoRoot, ledger.key), ledger, `ledger ${ledger.key}`)
}

/** Read the cached review guide for a key, or null if it hasn't been generated
 *  yet (or the cache is corrupt). Exactly one `<key>.json` exists per episode
 *  (overwritten in place on regeneration), so there is never a stale pile to
 *  disambiguate. */
export async function readGuideByKey(repoRoot: string, key: string): Promise<ReviewGuide | null> {
  return readJson<ReviewGuide>(guidePath(repoRoot, key))
}

/** Overwrite the cached review guide in place (atomic tmp + rename). */
export async function writeGuide(repoRoot: string, guide: ReviewGuide): Promise<boolean> {
  return writeJsonAtomic(guidePath(repoRoot, guide.key), guide, `guide ${guide.key}`)
}
