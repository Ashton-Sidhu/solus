import { existsSync, realpathSync, statSync } from 'fs'
import { copyFile, mkdir, stat as fsStat } from 'fs/promises'
import path from 'path'
import { isSolusWorktreePath, worktreeProjectRoot, type GitCheckout, type GitDiscardResult, type GitSyncResult, type WorktreeEntry } from '@solus/contracts/types'
import { createLogger } from '../logger'
import { dispatchStep } from '../observability/session-emitter'
import { git, runAsync } from './exec'
// `git-helpers` imports this module back for the branch and default-branch
// helpers. Both sides only reach across inside function bodies, so the cycle
// resolves at call time.
import { resolveRepoRef } from './git-helpers'
import { worktreeBranchName } from './worktree-branch-name'
import { worktreePathFor } from './worktree-path'

const log = createLogger('WorktreeManager', 'worktree-manager.ts')

const MAX_COMMIT_DIFF_CHARS = 20_000
/** Cap the raw diff spawn so a huge working tree can't blow up memory; we slice to
 *  MAX_COMMIT_DIFF_CHARS afterward anyway, and treat an oversized diff as empty. */
const MAX_COMMIT_DIFF_BYTES = 2_000_000

export const COMMIT_MESSAGE_SYSTEM_PROMPT = [
  'You write concise git commit messages.',
  'Return exactly one commit subject line and nothing else.',
  'Do not include any reasoning, preamble, explanation, or restatement of the task — output only the subject line.',
  'Use conventional commit style when the change clearly fits.',
  'Keep it under 72 characters.',
  'Do not wrap the response in quotes or markdown.',
].join('\n')

export function getHeadCommit(cwd: string): string | null {
  try {
    return git(['rev-parse', 'HEAD'], cwd)
  } catch {
    return null
  }
}

// The default branch is fixed for a repo's lifetime, but resolving it can hit the
// network: a repo not created by `git clone` has no local `origin/HEAD`, so we fall
// back to `git ls-remote`. Cache per cwd — storing the in-flight promise dedupes
// concurrent callers and the resolved value is reused for the process lifetime — so
// the network probe happens at most once. Status summaries still need the target
// branch on every prompt dispatch / watcher fire, so hot callers then pay nothing.
const defaultBranchCache = new Map<string, string | Promise<string>>()

async function resolveDefaultBranch(cwd: string): Promise<string> {
  try {
    const ref = await runAsync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], cwd)
    return ref.replace('origin/', '')
  } catch {}
  try {
    // Lighter than `git remote show origin`: a single symref round-trip.
    const symref = await runAsync('git', ['ls-remote', '--symref', 'origin', 'HEAD'], cwd)
    const match = symref.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)
    if (match?.[1]) return match[1]
  } catch {}
  try {
    await runAsync('git', ['rev-parse', '--verify', 'main'], cwd)
    return 'main'
  } catch {
    return 'master'
  }
}

export function getDefaultBranch(cwd: string): Promise<string> {
  const cached = defaultBranchCache.get(cwd)
  if (cached) return Promise.resolve(cached)
  const pending = resolveDefaultBranch(cwd).then((branch) => {
    defaultBranchCache.set(cwd, branch)
    return branch
  })
  defaultBranchCache.set(cwd, pending)
  return pending
}

/** Local-only default-branch resolution for status refreshes. This deliberately
 * avoids `ls-remote` so opening a project never waits on the network. Local
 * fallbacks are not cached because a later remote-aware lookup may discover a
 * different default branch. */
export async function getDefaultBranchLocal(cwd: string): Promise<string> {
  const cached = defaultBranchCache.get(cwd)
  if (cached && !(cached instanceof Promise)) return cached
  try {
    const ref = await runAsync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], cwd)
    const branch = ref.replace('origin/', '')
    defaultBranchCache.set(cwd, branch)
    return branch
  } catch {}
  try {
    await runAsync('git', ['rev-parse', '--verify', 'main'], cwd)
    return 'main'
  } catch {
    return 'master'
  }
}

/** Synchronous, local-only default-branch resolution for `restoreWorktree`, which
 *  returns a plain value by contract. Reuses a warm cache entry when the async
 *  resolver already ran for this cwd; otherwise reads LOCAL refs only (never the
 *  network) and falls back to main/master. */
function getDefaultBranchLocalSync(cwd: string): string {
  const cached = defaultBranchCache.get(cwd)
  if (cached && !(cached instanceof Promise)) return cached
  try {
    const ref = git(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], cwd)
    return ref.replace('origin/', '')
  } catch {}
  try {
    git(['rev-parse', '--verify', 'main'], cwd)
    return 'main'
  } catch {
    return 'master'
  }
}

export function getWorkingBranch(cwd: string): string | null {
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
    return branch === 'HEAD' ? null : branch
  } catch {
    return null
  }
}


export interface CreateWorktreeOptions {
  /** Cancels branch discovery and worktree creation with the owning setup. */
  signal?: AbortSignal
  /** Semantic name produced by the configured text-generation model. */
  generatedName?: string | null
}

/** The linked worktree that currently holds `branch`, excluding `projectPath`
 *  itself. A branch can be checked out in only one worktree, so every checkout
 *  that wants to own a branch consults this first — to reuse the holder, or to
 *  refuse because another worktree already has it. */
export function otherWorktreeHoldingBranch(projectPath: string, branch: string): WorktreeEntry | undefined {
  const projectRealPath = realpathSync(projectPath)
  return listProjectWorktrees(projectPath).find((worktree) => {
    if (worktree.branch !== branch) return false
    try {
      return realpathSync(worktree.path) !== projectRealPath
    } catch {
      return false
    }
  })
}

/** The local branch a PR checks out onto. Same-repository PRs live on their real
 *  head branch so agent commits update the PR; fork PRs get a local
 *  `solus/pr-<n>` review branch the base repo can own. */
export function prCheckoutBranch(prNumber: number, source: PrCheckoutSource): string {
  return source.isFork ? `solus/pr-${prNumber}` : source.headRef
}

/** Resolve a PR's local branch name and fetch its head into the repository.
 *  Shared by the worktree checkout and the current-repository checkout. */
export async function fetchPrHead(
  projectPath: string,
  prNumber: number,
  source: PrCheckoutSource,
): Promise<{ branch: string; headSha: string }> {
  const fetchRef = source.isFork ? `pull/${prNumber}/head` : source.headRef
  await runAsync('git', ['fetch', 'origin', fetchRef], projectPath)
  const headSha = await runAsync('git', ['rev-parse', 'FETCH_HEAD'], projectPath)
  return { branch: prCheckoutBranch(prNumber, source), headSha }
}

/** Materialize one origin branch as the branch of an isolated dispatch
 * worktree. Unlike `createWorktree`, this does not invent a prompt-derived
 * branch: the selected branch is the environment the remote session requested. */
export async function ensureBranchWorktree(
  projectPath: string,
  branch: string,
): Promise<GitCheckout> {
  await runAsync('git', ['check-ref-format', '--branch', branch], projectPath)
  const existing = otherWorktreeHoldingBranch(projectPath, branch)
  if (existing) {
    return {
      repoRoot: projectPath,
      branch,
      targetBranch: branch,
      worktreePath: existing.path,
    }
  }

  const remoteRef = `origin/${branch}`
  await runAsync('git', ['fetch', 'origin', branch], projectPath)
  await runAsync('git', ['rev-parse', '--verify', remoteRef], projectPath)

  // The dispatch checkout is an internal staging checkout. If it currently
  // holds the requested branch, release that branch before assigning it to the
  // isolated worktree where the session will run.
  if (getWorkingBranch(projectPath) === branch) {
    await runAsync('git', ['checkout', '--detach'], projectPath)
  }

  const worktreePath = worktreePathFor(projectPath, branch.replace(/\//g, '-'))
  const hasLocalBranch = await runAsync(
    'git',
    ['show-ref', '--verify', `refs/heads/${branch}`],
    projectPath,
  ).then(() => true, () => false)
  if (hasLocalBranch) {
    // No worktree owns this local branch (the reuse check above proved that),
    // so make the origin selection exact rather than starting from stale state.
    await runAsync('git', ['branch', '--force', branch, remoteRef], projectPath)
    await runAsync('git', ['worktree', 'add', worktreePath, branch], projectPath)
  } else {
    await runAsync(
      'git',
      ['worktree', 'add', '--track', '-b', branch, worktreePath, remoteRef],
      projectPath,
    )
  }
  await copyIncludedWorktreeFiles(projectPath, worktreePath)
  log.info('dispatch_branch_worktree_ready', { branch, worktreePath, remoteRef })
  return { repoRoot: projectPath, branch, targetBranch: branch, worktreePath }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error('Interrupted')
}

async function resolveWorktreeStartPoint(
  projectPath: string,
  targetBranch: string,
  signal?: AbortSignal,
): Promise<string> {
  const remoteRef = `origin/${targetBranch}`
  try {
    await runAsync('git', ['fetch', 'origin', targetBranch], projectPath, { signal })
    await runAsync('git', ['rev-parse', '--verify', remoteRef], projectPath, { signal })
    return remoteRef
  } catch (e) {
    throwIfAborted(signal)
    log.warn('worktree_start_point_fallback_local', { targetBranch, error: e instanceof Error ? e.message : String(e) })
    return targetBranch
  }
}

export async function createWorktree(
  projectPath: string,
  prompt: string,
  baseBranch?: string,
  options: CreateWorktreeOptions = {},
): Promise<GitCheckout> {
  // The same four intervals this function has always timed for `dev.log`. When
  // it is called inside a turn's dispatch they are also spans, so a slow
  // dispatch names the git command that cost the time instead of one opaque
  // setup bar. Outside one, every call below is a pass-through.
  const startedAt = Date.now()
  throwIfAborted(options.signal)
  const targetBranchStartedAt = Date.now()
  const targetBranch = baseBranch || await dispatchStep<string>(
    'default_branch',
    { projectPath, fn: 'getDefaultBranch', file: 'worktree-manager.ts' },
    async (annotate) => {
      const resolved = await getDefaultBranch(projectPath)
      annotate({ defaultBranch: resolved })
      return resolved
    },
  )
  const targetBranchMs = Date.now() - targetBranchStartedAt
  throwIfAborted(options.signal)
  const startPointStartedAt = Date.now()
  const startPoint = await dispatchStep<string>(
    'start_point',
    { projectPath, targetBranch, fn: 'resolveWorktreeStartPoint', file: 'worktree-manager.ts' },
    async (annotate) => {
      const resolved = await resolveWorktreeStartPoint(projectPath, targetBranch, options.signal)
      annotate({ startPoint: resolved })
      return resolved
    },
  )
  const startPointMs = Date.now() - startPointStartedAt
  const branch = worktreeBranchName(prompt, options.generatedName)
  const worktreePath = worktreePathFor(projectPath, branch.replace(/\//g, '-'))

  log.info('worktree_creating', { branch, worktreePath, startPoint })
  const checkoutStartedAt = Date.now()
  const checkoutArgs = ['worktree', 'add', '-b', branch, worktreePath, startPoint]
  await dispatchStep<string>(
    'git_worktree_add',
    {
      argv: `git ${checkoutArgs.join(' ')}`,
      cwd: projectPath,
      branch,
      worktreePath,
      startPoint,
      fn: 'runAsync',
      file: 'worktree-manager.ts',
    },
    () => runAsync('git', checkoutArgs, projectPath, { signal: options.signal }),
  )
  const checkoutMs = Date.now() - checkoutStartedAt
  const copyStartedAt = Date.now()
  await dispatchStep<void>(
    'copy_included_files',
    { projectPath, worktreePath, fn: 'copyIncludedWorktreeFiles', file: 'worktree-manager.ts' },
    async (annotate) => {
      annotate({ copiedFileCount: await copyIncludedWorktreeFiles(projectPath, worktreePath, options.signal) })
    },
  )
  const copyMs = Date.now() - copyStartedAt

  log.info('worktree_create_completed', {
    branch,
    worktreePath,
    targetBranchMs,
    startPointMs,
    checkoutMs,
    copyMs,
    totalMs: Date.now() - startedAt,
  })

  return { branch, targetBranch, worktreePath, repoRoot: projectPath }
}

/** Returns how many files were copied — the one fact that explains why this
 *  step took the time it did. */
async function copyIncludedWorktreeFiles(
  projectPath: string,
  worktreePath: string,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal)
  const includePath = path.join(projectPath, '.worktreeinclude')
  if (!existsSync(includePath)) return 0

  const ignoredFiles = (await runAsync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], projectPath, { signal }))
    .split('\0')
    .filter(Boolean)
  if (ignoredFiles.length === 0) return 0

  const ignoredFileSet = new Set(ignoredFiles)
  const matchedFiles = (await runAsync('git', ['ls-files', '--others', '--ignored', `--exclude-from=${includePath}`, '-z'], projectPath, { signal }))
    .split('\0')
    .filter((relativePath) => relativePath && ignoredFileSet.has(relativePath))

  let copied = 0
  for (const relativePath of matchedFiles) {
    throwIfAborted(signal)
    const source = path.join(projectPath, relativePath)
    const target = path.join(worktreePath, relativePath)
    if (!(await fsStat(source)).isFile()) continue

    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(source, target)
    copied += 1
  }
  return copied
}

/** A full unified diff can be enormous; cap the buffer and treat an oversized diff
 *  as empty (status + --stat still inform the message) rather than throwing. */
async function safeCommitDiff(args: string[], cwd: string): Promise<string> {
  try {
    return await runAsync('git', args, cwd, { maxBuffer: MAX_COMMIT_DIFF_BYTES })
  } catch (err: any) {
    if (err?.code === 'ENOBUFS') return ''
    throw err
  }
}

export async function buildCommitMessagePrompt(cwd: string): Promise<string> {
  const status = await runAsync('git', ['status', '--porcelain'], cwd)
  const stat = await runAsync('git', ['diff', '--stat'], cwd)
  const stagedStat = await runAsync('git', ['diff', '--cached', '--stat'], cwd)
  const diff = [
    await safeCommitDiff(['diff', '--no-ext-diff', '--unified=3'], cwd),
    await safeCommitDiff(['diff', '--cached', '--no-ext-diff', '--unified=3'], cwd),
  ].filter(Boolean).join('\n\n').slice(0, MAX_COMMIT_DIFF_CHARS)

  return [
    COMMIT_MESSAGE_SYSTEM_PROMPT,
    '',
    'Git status:',
    status || '(clean)',
    '',
    'Diff stat:',
    [stat, stagedStat].filter(Boolean).join('\n') || '(none)',
    '',
    'Diff:',
    diff || '(none)',
  ].join('\n')
}

/** Throw away everything uncommitted: tracked files back to HEAD, untracked
 *  files removed. `clean` stays off `-x` so ignored build output and installed
 *  dependencies survive — this discards work, not the checkout. */
export async function discardChanges(
  gitContext: GitCheckout,
  workingDirectory: string,
): Promise<GitDiscardResult> {
  const cwd = gitContext.worktreePath || workingDirectory

  try {
    const status = await runAsync('git', ['status', '--porcelain'], cwd)
    const discarded = status ? status.split('\n').filter(Boolean).length : 0
    if (discarded === 0) return { success: true, discarded: 0 }
    await runAsync('git', ['reset', '--hard', 'HEAD'], cwd)
    await runAsync('git', ['clean', '-fd'], cwd)
    log.info('uncommitted_changes_discarded', { discarded, cwd })
    return { success: true, discarded }
  } catch (e: any) {
    return { success: false, discarded: 0, error: String(e.message || e) }
  }
}

export async function syncWithOrigin(
  gitContext: GitCheckout,
  workingDirectory: string,
): Promise<GitSyncResult> {
  const cwd = gitContext.worktreePath || workingDirectory

  try {
    if (gitContext.worktreePath) {
      await runAsync('git', ['pull', '--no-edit', 'origin', gitContext.targetBranch], cwd)
      log.info('worktree_synced_with_origin', { targetBranch: gitContext.targetBranch })
    } else {
      await runAsync('git', ['pull', '--no-edit'], cwd)
      log.info('checkout_synced_with_origin', { branch: gitContext.branch })
    }

    return { success: true, outcome: 'synced' }
  } catch (e: any) {
    const conflicted = await runAsync('git', ['diff', '--name-only', '--diff-filter=U'], cwd).catch(() => '')
    return { success: false, outcome: conflicted ? 'conflicted' : 'failed', error: String(e.message || e) }
  }
}

const EXISTING_PR_TTL_MS = 60_000
const existingPrCache = new Map<string, { at: number; url: Promise<string | null> }>()

/**
 * Which pull request this branch has, if any.
 *
 * Asked of the provider rather than of `gh` directly: the provider answers
 * through the same API with the first credential that can see the repository,
 * including the gh credential, so this is one question with one answer instead
 * of a third implementation beside the index and the task's own links.
 */
async function queryExistingPR(branch: string, cwd: string): Promise<string | null> {
  try {
    // The provider registry stays lazy: it pulls in every code-host client and
    // only a branch that already has a pull request needs one.
    const { providerForRepo } = await import('../providers/registry')
    const repo = await resolveRepoRef(cwd)
    const provider = repo ? providerForRepo(repo) : null
    if (!repo || !provider) return null
    const page = await provider.review.listPullRequestsPage(repo, { state: 'all', head: branch }, 1, 1)
    return page.items.find((pullRequest) => pullRequest.headRef === branch)?.url ?? null
  } catch {
    return null
  }
}

/** Pull request discovery is a network call used by detailed status consumers. TTL-cache
 *  the result per (cwd, branch) for both hits and misses, and share the in-flight
 *  promise so multiple visible clients collapse to a single spawn. */
export function getExistingPR(branch: string, cwd: string, bypassCache = false): Promise<string | null> {
  const key = `${cwd}\0${branch}`
  if (bypassCache) existingPrCache.delete(key)
  const cached = existingPrCache.get(key)
  if (cached && Date.now() - cached.at < EXISTING_PR_TTL_MS) return cached.url
  const url = queryExistingPR(branch, cwd)
  existingPrCache.set(key, { at: Date.now(), url })
  return url
}

export function restoreWorktree(worktreePath: string): GitCheckout | null {
  if (!isSolusWorktreePath(worktreePath)) return null

  try {
    const branch = getWorkingBranch(worktreePath)
    if (!branch) return null

    const projectPath = worktreeProjectRoot(worktreePath)
    const targetBranch = getDefaultBranchLocalSync(projectPath)
    log.info('worktree_restored', { branch, worktreePath })
    return { branch, targetBranch, worktreePath, repoRoot: projectPath }
  } catch (e) {
    log.error('worktree_restore_failed', { worktreePath, error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

export function listBranches(projectPath: string, options: { remoteOnly?: boolean } = {}): string[] {
  try {
    const output = git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], projectPath)
    const branches = new Set<string>()
    for (const ref of output.split('\n').filter(Boolean)) {
      if (ref.startsWith('refs/heads/')) {
        if (!options.remoteOnly) branches.add(ref.slice('refs/heads/'.length))
        continue
      }
      if (!ref.startsWith('refs/remotes/')) continue
      const remoteBranch = ref.slice('refs/remotes/'.length)
      if (remoteBranch.endsWith('/HEAD')) continue
      branches.add(remoteBranch.replace(/^[^/]+\//, ''))
    }
    return Array.from(branches)
  } catch {
    return []
  }
}

export interface PrWorktree {
  worktreePath: string
  /** The PR head branch for same-repository PRs; a local review branch for forks. */
  branch: string
  /** merge-base(base, head) — diff base + companion episode base. */
  baseSha: string
  /** PR head commit now checked out — the comment anchor. */
  headSha: string
  /** Whether an existing deterministic PR checkout supplied the result. */
  reused: boolean
}

export interface PrCheckoutSource {
  headRef: string
  isFork: boolean
}

/**
 * Fetch a PR's head and report the merge-base the diff/companion anchor to.
 * Same-repository PRs use their real head branch so agent commits update the PR
 * instead of creating a parallel `solus/pr-N` branch. If that branch is already
 * checked out, that checkout is the source of truth and is reused. Fork PRs stay
 * on a local review-only branch because the current repository cannot own their
 * contributor branch. Clean reused checkouts are fast-forwarded. Dirty or
 * locally advanced checkouts are reused as-is and skip synchronization.
 */
export async function fetchAndCheckoutPr(
  projectPath: string,
  prNumber: number,
  baseRef: string,
  source: PrCheckoutSource,
): Promise<PrWorktree> {
  const { branch, headSha } = await fetchPrHead(projectPath, prNumber, source)
  const worktreePath = worktreePathFor(projectPath, `pr-${prNumber}`)

  const worktrees = listProjectWorktrees(projectPath)
  const existing = worktrees.find((worktree) => worktree.branch === branch)
    ?? worktrees.find((worktree) => worktree.path === worktreePath)
  // A previous or concurrent open may have already created the checkout without
  // it appearing in `git worktree list` yet. The PR path is deterministic, so an
  // existing directory is already the requested outcome; do not fail by trying
  // to add the same worktree again.
  const existingWorktreePath = existing?.path ?? (existsSync(worktreePath) ? worktreePath : null)
  let resolvedBranch = branch
  let syncSkipped = false
  if (existingWorktreePath) {
    log.info('pr_worktree_reused', { branch, worktreePath: existingWorktreePath })
    const status = await runAsync('git', ['status', '--porcelain'], existingWorktreePath)
    const existingBranch = getWorkingBranch(existingWorktreePath)
    const existingHead = await runAsync('git', ['rev-parse', 'HEAD'], existingWorktreePath)
    resolvedBranch = existingBranch ?? branch
    // The checkout is the user's source of truth once it contains work. Do not
    // block Ask Solus and do not mutate it merely to match the remote PR head.
    if (status) {
      syncSkipped = true
    } else if (existingBranch !== branch) {
      if (existingHead !== headSha) syncSkipped = true
      const branchExists = await runAsync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], projectPath).then(
        () => true,
        () => false,
      )
      if (!syncSkipped && branchExists) {
        const branchHead = await runAsync('git', ['rev-parse', `refs/heads/${branch}`], projectPath)
        if (branchHead !== headSha) {
          const canFastForward = await runAsync('git', ['merge-base', '--is-ancestor', branchHead, headSha], projectPath).then(
            () => true,
            () => false,
          )
          if (canFastForward) await runAsync('git', ['branch', '-f', branch, headSha], projectPath)
          else syncSkipped = true
        }
        if (!syncSkipped) await runAsync('git', ['checkout', branch], existingWorktreePath)
      } else if (!syncSkipped) {
        await runAsync('git', ['checkout', '-b', branch, headSha], existingWorktreePath)
      }
      if (!syncSkipped) resolvedBranch = branch
    } else {
      if (existingHead !== headSha) {
        const canFastForward = await runAsync('git', ['merge-base', '--is-ancestor', existingHead, headSha], projectPath).then(
          () => true,
          () => false,
        )
        if (canFastForward) await runAsync('git', ['merge', '--ff-only', 'FETCH_HEAD'], existingWorktreePath)
        else syncSkipped = true
      }
    }
    if (syncSkipped) {
      log.info('pr_worktree_sync_skipped', {
        branch: resolvedBranch,
        hasUncommittedChanges: !!status,
        prNumber,
        worktreePath: existingWorktreePath,
      })
    }
  } else {
    log.info('pr_worktree_creating', { branch, worktreePath })
    const branchExists = await runAsync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], projectPath).then(
      () => true,
      () => false,
    )
    try {
      if (branchExists) {
        await runAsync('git', ['worktree', 'add', worktreePath, branch], projectPath)
        await runAsync('git', ['merge', '--ff-only', 'FETCH_HEAD'], worktreePath).catch(() => {})
      } else {
        await runAsync('git', ['worktree', 'add', '-b', branch, worktreePath, 'FETCH_HEAD'], projectPath)
      }
    } catch (error) {
      // Another open can win between the existence check and `worktree add`.
      // Once the deterministic path exists, creation has reached the desired state.
      if (!existsSync(worktreePath)) throw error
    }
    await copyIncludedWorktreeFiles(projectPath, worktreePath)
  }

  const resolvedWorktreePath = existingWorktreePath ?? worktreePath
  const checkedOutHead = await runAsync('git', ['rev-parse', 'HEAD'], resolvedWorktreePath)
  if (!syncSkipped && checkedOutHead !== headSha) {
    throw new Error(`The existing checkout for PR #${prNumber} has local commits. They were left untouched.`)
  }

  // Ensure the base ref is present locally, then anchor the diff at the divergence point.
  await runAsync('git', ['fetch', 'origin', baseRef], projectPath).catch(() => {})
  const baseSha = await runAsync('git', ['merge-base', headSha, `origin/${baseRef}`], projectPath).catch(
    () => headSha,
  )

  return { worktreePath: resolvedWorktreePath, branch: resolvedBranch, baseSha, headSha, reused: !!existingWorktreePath }
}

export function listProjectWorktrees(projectPath: string): WorktreeEntry[] {
  try {
    const output = git(['worktree', 'list', '--porcelain'], projectPath)
    interface ParsedWorktree {
      path?: string
      branch?: string
      isBare?: boolean
    }
    const entries: ParsedWorktree[] = []
    let current: ParsedWorktree = {}

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) entries.push(current)
        current = { path: line.slice(9), branch: '', isBare: false }
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '')
      } else if (line === 'bare') {
        current.isBare = true
      } else if (line === '') {
        if (current.path) entries.push(current)
        current = {}
      }
    }
    if (current.path) entries.push(current)

    return entries
      .filter((e): e is { path: string; branch: string; isBare: boolean } => !e.isBare && !!e.branch && !!e.path && existsSync(e.path))
      .map(e => {
        let lastModified: number | undefined
        try { lastModified = statSync(e.path).mtimeMs } catch { /* ignore */ }
        return { path: e.path, branch: e.branch, lastModified }
      })
      .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
  } catch {
    return []
  }
}
