import path from 'path'
import type { BranchChanges, GitIdentity, GitState, GitStateOptions, UncommittedFile } from '@solus/contracts/types'
import type { RepoRef } from '@solus/contracts/providers'
import { createLogger } from '../logger'
import { gitOutputPath, runAsync } from './exec'
import { GitUnavailableError } from './git-availability'
import { getEpisodeNumstat } from './session-snapshots'
import { getDefaultBranchLocal, getExistingPR } from './worktree-manager'
import { isGitOperationInProgress } from './git-operation-state'
import { z } from 'zod'
import { PullRequestHead, USERLESS_SCP_REMOTE, parseRemoteUrls, primaryRemoteUrl, repositoryKeyFromRemoteUrl } from '@solus/contracts/repository-key'

const gitCommandErrorSchema = z.object({
  message: z.string().optional(),
  stderr: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
  signal: z.string().nullable().optional(),
})

const log = createLogger('main', 'git-helpers')

export interface ParsedGitStatus {
  branch: string | null
  upstreamRef: string | null
  aheadCount: number
  behindCount: number
  files: UncommittedFile[]
  hasMoreFiles: boolean
  fileCount: number
}

export function parseStatus(raw: string): ParsedGitStatus {
  let branch: string | null = null
  let upstreamRef: string | null = null
  let aheadCount = 0
  let behindCount = 0
  const files: UncommittedFile[] = []
  let hasMoreFiles = false
  let fileCount = 0

  for (const line of raw.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim()
      branch = value === '(detached)' ? null : value
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      upstreamRef = line.slice('# branch.upstream '.length).trim() || null
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/)
      if (match) {
        aheadCount = Number(match[1])
        behindCount = Number(match[2])
      }
      continue
    }
    if (line.startsWith('#')) continue
    fileCount += 1
    if (files.length >= 200) {
      hasMoreFiles = true
      continue
    }

    const kind = line[0]
    let filePath = ''
    let conflicted = false

    if (kind === '?') {
      filePath = line.slice(2)
    } else if (kind === 'u') {
      filePath = line.split(' ').slice(10).join(' ')
      conflicted = true
    } else if (kind === '1' || kind === '2') {
      filePath = line.split(' ').slice(kind === '2' ? 9 : 8).join(' ')
      if (kind === '2' && filePath.includes('\t')) filePath = filePath.split('\t').pop() ?? filePath
    }

    if (!filePath) continue
    files.push({ path: filePath, conflicted })
  }

  return { branch, upstreamRef, aheadCount, behindCount, files, hasMoreFiles, fileCount }
}

const statusInflight = new Map<string, Promise<GitState | null>>()
const checkoutInflight = new Map<string, Promise<CheckoutRead | null>>()

/** A summary status with the top level of the checkout it was read in. The
 *  identity read answers both, so a checkout refresh needs no extra spawn. */
export interface CheckoutRead {
  status: GitState
  checkoutRoot: string | null
}

/**
 * Compute live branch, file, and conflict state for a working tree. The default
 * path deliberately avoids line statistics and PR discovery because it runs on
 * every watcher fire and completed edit. Visible Git UI opts into those details.
 * Concurrent callers for the same cwd/detail level share one process pipeline.
 */
export function computeGitState(
  cwd: string,
  options: GitStateOptions | null = {},
): Promise<GitState | null> {
  if (!cwd || cwd === '~') return Promise.resolve(null)
  options ??= {}
  if (!options.includeDetails) return readCheckout(cwd).then((read) => read?.status ?? null)

  const existing = statusInflight.get(cwd)
  if (existing) return existing

  const pending = computeGitStateDetails(cwd, options)
    .finally(() => {
      if (statusInflight.get(cwd) === pending) statusInflight.delete(cwd)
    })
  statusInflight.set(cwd, pending)
  return pending
}

/** The summary status of `computeGitState`, with its checkout's top level. */
export function readCheckout(cwd: string): Promise<CheckoutRead | null> {
  if (!cwd || cwd === '~') return Promise.resolve(null)
  const existing = checkoutInflight.get(cwd)
  if (existing) return existing

  const pending = readCheckoutUncached(cwd)
    .finally(() => {
      if (checkoutInflight.get(cwd) === pending) checkoutInflight.delete(cwd)
    })
  checkoutInflight.set(cwd, pending)
  return pending
}

async function computeGitStateDetails(
  cwd: string,
  options: GitStateOptions,
): Promise<GitState | null> {
  // Reuse an in-flight summary from the watcher/renderer instead of starting
  // a second status pipeline when the visible panel asks for details.
  const status = await computeGitState(cwd)
  if (!status) return null
  const [branchChanges, prUrl, targetAheadCount] = await Promise.all([
    getBranchChanges(cwd, status).catch(() => undefined),
    status.branch && status.branch !== status.targetBranch
      ? getExistingPR(status.branch, cwd, options.bypassCache === true)
      : Promise.resolve(null),
    status.branch && status.branch !== status.targetBranch
      ? runAsync('git', ['rev-list', '--count', `${status.targetBranch}..HEAD`], cwd)
        .then((value) => Number(value) || 0)
        .catch(() => 0)
      : Promise.resolve(0),
  ])
  return {
    ...status,
    branchChanges,
    targetAheadCount,
    prUrl: prUrl ?? undefined,
  }
}

async function readCheckoutUncached(cwd: string): Promise<CheckoutRead | null> {
  // Identity is the same work `computeGitIdentity` does, so run it alongside the
  // working-tree scan rather than duplicating it — the sidebar's earlier
  // identity call is usually still in flight and gets shared.
  const [identityRead, statusRaw, mergeInProgress] = await Promise.all([
    readGitIdentity(cwd),
    // Raw: trimming the output would drop a trailing space from the last path.
    runAsync('git', ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], cwd, { raw: true }).catch(() => null),
    isGitOperationInProgress(cwd),
  ])
  // A null identity is the ordinary "not a repository" answer, so stay quiet;
  // a repo whose status scan failed is worth a warning.
  if (!identityRead) return null
  if (statusRaw === null) {
    log.warn('git_status_failed', { cwd })
    return null
  }

  const status = parseStatus(statusRaw)
  return { checkoutRoot: identityRead.checkoutRoot, status: {
    ...identityRead.identity,
    // `--branch` reports the branch as of this scan; prefer it over identity's
    // separate read so branch and files always describe the same instant.
    branch: status.branch,
    upstreamRef: status.upstreamRef,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    uncommittedChanges: {
      files: status.files,
      hasMoreFiles: status.hasMoreFiles,
      fileCount: status.fileCount,
      mergeInProgress,
    },
  } }
}

/** Count the branch review's change without building its patch: the same base
 *  `resolveReviewContext` gives the review pane, minus the session base it
 *  falls back to on the target branch, because this status is per checkout. */
async function getBranchChanges(cwd: string, status: GitState): Promise<BranchChanges> {
  // Not awaited here: merge-base reads only refs and objects, so it runs while
  // the numstat prepares its throwaway index.
  const base = status.branch && status.branch !== status.targetBranch
    ? runAsync('git', ['merge-base', status.targetBranch, 'HEAD'], cwd)
      .then((sha) => sha.trim() || 'HEAD')
      .catch(() => 'HEAD')
    : 'HEAD'
  const files = await getEpisodeNumstat(cwd, status.repoRoot, base)
  let insertions = 0
  let deletions = 0
  for (const file of files) {
    insertions += file.additions
    deletions += file.deletions
  }
  return { fileCount: files.length, insertions, deletions }
}

interface IdentityRead {
  identity: GitIdentity
  /** The top level of the checkout `cwd` is in; null when git has none (a bare repository). */
  checkoutRoot: string | null
}

const identityInflight = new Map<string, Promise<IdentityRead | null>>()

/**
 * Repo/branch identity only — no working-tree scan. Surfaces that just need to
 * place a session in its project and branch (the session sidebar) use this so
 * they don't sit behind a cold `git status` over a large worktree.
 */
export function computeGitIdentity(cwd: string): Promise<GitIdentity | null> {
  return readGitIdentity(cwd).then((read) => read?.identity ?? null)
}

function readGitIdentity(cwd: string): Promise<IdentityRead | null> {
  if (!cwd || cwd === '~') return Promise.resolve(null)

  const existing = identityInflight.get(cwd)
  if (existing) return existing

  const pending = readGitIdentityUncached(cwd)
    .finally(() => {
      if (identityInflight.get(cwd) === pending) identityInflight.delete(cwd)
    })
  identityInflight.set(cwd, pending)
  return pending
}

async function readGitIdentityUncached(cwd: string): Promise<IdentityRead | null> {
  // One spawn answers the repository, the checkout's top level, and HEAD. It
  // fails outside a repository, in a bare one, and before the first commit;
  // those take the separate reads below.
  const [revParse, targetBranch] = await Promise.all([
    runAsync('git', ['rev-parse', '--git-common-dir', '--show-toplevel', 'HEAD', '--abbrev-ref', 'HEAD'], cwd).catch(() => null),
    getDefaultBranchLocal(cwd),
  ])
  // Git before 2.25 prints no top level for a bare repository rather than failing.
  const lines = revParse?.split('\n').map((line) => line.trim())
  if (lines?.length === 4) {
    const [commonDir, topLevel, headSha, headRef] = lines
    return {
      identity: { repoRoot: path.dirname(gitOutputPath(cwd, commonDir)), headSha, branch: branchOfHeadRef(headRef), targetBranch },
      checkoutRoot: gitOutputPath(cwd, topLevel),
    }
  }

  // No repo here is the ordinary null answer; `resolveRepoRoot` already logs it.
  const repoRoot = await resolveRepoRoot(cwd)
  if (!repoRoot) return null
  const [headRaw, topLevel] = await Promise.all([
    runAsync('git', ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], cwd).catch(() => null),
    runAsync('git', ['rev-parse', '--show-toplevel'], cwd).catch(() => null),
  ])
  const checkoutRoot = topLevel ? gitOutputPath(cwd, topLevel) : null
  if (headRaw === null) {
    // A repository before its first commit: HEAD names a branch that has no
    // commit yet. Git works on that branch, so it is a checkout like any other,
    // and it is its own target — the default-branch probe needs a commit.
    const unbornBranch = await runAsync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], cwd).catch(() => null)
    return unbornBranch ? { identity: { repoRoot, headSha: null, branch: unbornBranch, targetBranch: unbornBranch }, checkoutRoot } : null
  }

  const [headSha, headRef] = headRaw.split('\n').map((line) => line.trim())
  if (!headSha) return null
  return { identity: { repoRoot, headSha, branch: branchOfHeadRef(headRef), targetBranch }, checkoutRoot }
}

/** `--abbrev-ref HEAD` prints the literal "HEAD" when detached, matching
 *  `parseStatus`'s `branch: null` convention for the same state. */
function branchOfHeadRef(headRef: string): string | null {
  return headRef === 'HEAD' ? null : headRef
}

/** Resolve the parent repo root from a worktree path (handles linked + main worktrees). */
export async function resolveRepoRoot(workTree: string): Promise<string | null> {
  try {
    const commonDir = await runAsync('git', ['rev-parse', '--git-common-dir'], workTree)
    return path.dirname(gitOutputPath(workTree, commonDir))
  } catch (err: any) {
    // A host without git has no repositories. That is its normal state, not a failure.
    if (err instanceof GitUnavailableError) return null
    const parsedError = gitCommandErrorSchema.safeParse(err)
    const commandError = parsedError.success ? parsedError.data : {}
    log.warn('resolve_repo_root_failed', {
      cwd: workTree,
      error: commandError.message ?? String(err),
      stderr: commandError.stderr?.trim(),
      code: commandError.code,
      signal: commandError.signal,
    })
    return null
  }
}

/**
 * Parse a git remote URL into `{ host, owner, repo }`. Handles the two forms git
 * emits: SCP-style (`git@github.com:owner/repo.git`, `github.com:owner/repo.git`)
 * and URL-style (`https://github.com/owner/repo.git`, `ssh://git@host/owner/repo`). Returns
 * null for shapes we can't confidently parse (so the caller disables provider UI).
 */
export function parseRemoteUrl(remote: string): RepoRef | null {
  const url = remote.trim()
  if (!url) return null

  let host: string
  let pathname: string

  const scp = url.match(/^[^@]+@(\[[^\]\s]+\]|[^:]+):(.+)$/) ?? url.match(USERLESS_SCP_REMOTE)
  if (scp) {
    host = scp[1]
    pathname = scp[2]
  } else {
    try {
      const parsed = new URL(url)
      host = parsed.host
      pathname = parsed.pathname
    } catch {
      return null
    }
  }

  const segments = pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/').filter(Boolean)
  if (segments.length < 2) return null
  // owner/repo are the last two segments (handles GHE subgroup-free paths).
  const repo = segments[segments.length - 1]
  const owner = segments[segments.length - 2]
  if (!host || !owner || !repo) return null
  return { host, owner, repo }
}

const repositoryKeyCache = new Map<string, Promise<string | null>>()

/**
 * The repository key of `cwd`'s project (docs/plans/project-model.md §1): its
 * primary remote — `upstream`, then `origin`, then the first by name — reduced
 * to `host/path`. Null for a folder with no hosted remote. The URLs are read
 * from git config, not `git remote -v`, whose lines carry a partial clone's
 * filter. `safe.directory` admits a checkout another user owns, as on a shared
 * host: reading config runs no hook. Only a key is cached, so a folder that
 * gains a remote, such as a clone in progress, is read again.
 */
export function resolveRepositoryKey(cwd: string): Promise<string | null> {
  const cached = repositoryKeyCache.get(cwd)
  if (cached) return cached
  const pending = (async () => {
    const remoteUrl = await primaryRemoteUrlOf(cwd)
    const repositoryKey = remoteUrl ? repositoryKeyFromRemoteUrl(remoteUrl) : null
    if (!repositoryKey) repositoryKeyCache.delete(cwd)
    return repositoryKey
  })()
  repositoryKeyCache.set(cwd, pending)
  return pending
}

async function remoteUrlsOf(cwd: string): Promise<Map<string, string>> {
  try {
    const output = await runAsync('git', ['-c', 'safe.directory=*', 'config', '--get-regexp', '^remote\\..*\\.url$'], cwd)
    return parseRemoteUrls(output)
  } catch {
    // Exit 1: no remote, or not a repository.
    return new Map()
  }
}

async function primaryRemoteUrlOf(cwd: string): Promise<string | null> {
  return primaryRemoteUrl(await remoteUrlsOf(cwd))
}

/**
 * Where `branch` of the checkout at `cwd` is pushed: the head a pull request
 * from it names (`PullRequestHead`). Git answers with `<branch>@{push}`, which
 * follows `pushRemote`, `push.default`, and a branch that pushes under another
 * name. A branch that was never pushed, or has no upstream under
 * `push.default=simple`, goes where `git push` would send it: its push remote,
 * the default push remote, its remote, then `origin`, under its own name.
 * Null when no remote is known.
 */
export async function resolvePushHead(cwd: string, branch: string): Promise<PullRequestHead | null> {
  const remotes = await remoteUrlsOf(cwd)
  if (!remotes.size) return null
  const git = (args: string[]) => runAsync('git', ['-c', 'safe.directory=*', ...args], cwd).then((out) => out.trim() || null, () => null)
  const pushRef = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{push}`])
  if (pushRef) {
    // `origin/fix`. A remote name may hold a slash, so the longest remote that starts it wins.
    const remote = [...remotes.keys()]
      .filter((name) => pushRef.startsWith(`${name}/`))
      .sort((a, b) => b.length - a.length)[0]
    const repository = remote ? parseRemoteUrl(remotes.get(remote) ?? '') : null
    if (remote && repository) return new PullRequestHead(repository, pushRef.slice(remote.length + 1))
  }
  const remote = await git(['config', '--get', `branch.${branch}.pushRemote`])
    ?? await git(['config', '--get', 'remote.pushDefault'])
    ?? await git(['config', '--get', `branch.${branch}.remote`])
    ?? (remotes.has('origin') ? 'origin' : remotes.size === 1 ? [...remotes.keys()][0]! : null)
  const repository = remote ? parseRemoteUrl(remotes.get(remote) ?? '') : null
  return repository ? new PullRequestHead(repository, branch) : null
}

const primaryRepoRefCache = new Map<string, Promise<RepoRef | null>>()

/**
 * The `{ host, owner, repo }` of `cwd`'s project: the remote the repository
 * key names — `upstream`, then `origin`, then the first by name. Pull requests
 * are read through this, so the project a page lists and the repository its
 * pull requests come from cannot disagree. Unlike the key, it keeps the
 * remote's case, which persisted review targets compare against. Only an
 * answer is cached, so a folder that gains a remote is read again.
 */
export function resolvePrimaryRepoRef(cwd: string): Promise<RepoRef | null> {
  const cached = primaryRepoRefCache.get(cwd)
  if (cached) return cached
  const pending = (async () => {
    const remoteUrl = await primaryRemoteUrlOf(cwd)
    const repo = remoteUrl ? parseRemoteUrl(remoteUrl) : null
    if (!repo) primaryRepoRefCache.delete(cwd)
    return repo
  })()
  primaryRepoRefCache.set(cwd, pending)
  return pending
}

// A cwd's `origin` remote is effectively fixed for the process lifetime, yet
// every PR-review handler resolves it independently — so a single Activity load
// used to spawn `git remote get-url` 4-5× concurrently. Cache the in-flight
// promise per cwd so concurrent callers share one spawn (and later loads skip it
// entirely). Keyed on the resolved promise, so a transient failure isn't cached.
const repoRefCache = new Map<string, Promise<RepoRef | null>>()

/** Derive the `{ host, owner, repo }` for `cwd` from its `origin` remote. */
export function resolveRepoRef(cwd: string): Promise<RepoRef | null> {
  const cached = repoRefCache.get(cwd)
  if (cached) return cached
  const pending = (async () => {
    try {
      const remote = await runAsync('git', ['remote', 'get-url', 'origin'], cwd)
      return parseRemoteUrl(remote)
    } catch {
      // Don't poison the cache with a transient failure (e.g. git not ready).
      repoRefCache.delete(cwd)
      return null
    }
  })()
  repoRefCache.set(cwd, pending)
  return pending
}
