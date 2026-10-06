import path from 'path'
import type { BranchChanges, GitIdentity, GitState, GitStateOptions, UncommittedFile } from '@solus/contracts/types'
import type { RepoRef } from '../providers/types'
import { createLogger } from '../logger'
import { runAsync } from './exec'
import { GitUnavailableError } from './git-availability'
import { getEpisodeNumstat } from './session-snapshots'
import { getDefaultBranchLocal, getExistingPR } from './worktree-manager'
import { isGitOperationInProgress } from './git-operation-state'
import { z } from 'zod'
import { parseRemoteUrls, primaryRemoteUrl, repositoryKeyFromRemoteUrl } from '@solus/contracts/repository-key'

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

  const key = `${cwd}\0${options.includeDetails ? 'details' : 'summary'}`
  const existing = statusInflight.get(key)
  if (existing) return existing

  const pending = computeGitStateUncached(cwd, options)
    .finally(() => {
      if (statusInflight.get(key) === pending) statusInflight.delete(key)
    })
  statusInflight.set(key, pending)
  return pending
}

async function computeGitStateUncached(
  cwd: string,
  options: GitStateOptions,
): Promise<GitState | null> {
  if (options.includeDetails) {
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

  // Identity is the same work `computeGitIdentity` does, so run it alongside the
  // working-tree scan rather than duplicating it — the sidebar's earlier
  // identity call is usually still in flight and gets shared.
  const [identity, statusRaw, mergeInProgress] = await Promise.all([
    computeGitIdentity(cwd),
    runAsync('git', ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], cwd).catch(() => null),
    isGitOperationInProgress(cwd),
  ])
  // A null identity is the ordinary "not a repository" answer, so stay quiet;
  // a repo whose status scan failed is worth a warning.
  if (!identity) return null
  if (statusRaw === null) {
    log.warn('git_status_failed', { cwd })
    return null
  }

  const status = parseStatus(statusRaw)
  return {
    ...identity,
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
  }
}

/** Count the branch review's change without building its patch: the same base
 *  `resolveReviewContext` gives the review pane, minus the session base it
 *  falls back to on the target branch, because this status is per checkout. */
async function getBranchChanges(cwd: string, status: GitState): Promise<BranchChanges> {
  const base = status.branch && status.branch !== status.targetBranch
    ? await runAsync('git', ['merge-base', status.targetBranch, 'HEAD'], cwd)
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

const identityInflight = new Map<string, Promise<GitIdentity | null>>()

/**
 * Repo/branch identity only — no working-tree scan. Surfaces that just need to
 * place a session in its project and branch (the session sidebar) use this so
 * they don't sit behind a cold `git status` over a large worktree.
 */
export function computeGitIdentity(cwd: string): Promise<GitIdentity | null> {
  if (!cwd || cwd === '~') return Promise.resolve(null)

  const existing = identityInflight.get(cwd)
  if (existing) return existing

  const pending = computeGitIdentityUncached(cwd)
    .finally(() => {
      if (identityInflight.get(cwd) === pending) identityInflight.delete(cwd)
    })
  identityInflight.set(cwd, pending)
  return pending
}

async function computeGitIdentityUncached(cwd: string): Promise<GitIdentity | null> {
  const [repoRoot, headRaw, targetBranch] = await Promise.all([
    resolveRepoRoot(cwd),
    runAsync('git', ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], cwd).catch(() => null),
    getDefaultBranchLocal(cwd),
  ])
  // Both null cases are ordinary, not failures: no repo here, or a repo with no
  // commits yet. `resolveRepoRoot` already logs the former.
  if (!repoRoot || headRaw === null) return null

  const [headSha, headRef] = headRaw.split('\n').map((line) => line.trim())
  if (!headSha) return null
  // `--abbrev-ref HEAD` prints the literal "HEAD" when detached, matching
  // `parseStatus`'s `branch: null` convention for the same state.
  return { repoRoot, headSha, branch: headRef === 'HEAD' ? null : headRef, targetBranch }
}

/** Resolve the parent repo root from a worktree path (handles linked + main worktrees). */
export async function resolveRepoRoot(workTree: string): Promise<string | null> {
  try {
    const commonDir = await runAsync('git', ['rev-parse', '--git-common-dir'], workTree)
    const absolute = path.isAbsolute(commonDir) ? commonDir : path.resolve(workTree, commonDir)
    return path.dirname(absolute)
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
 * emits: SCP-style (`git@github.com:owner/repo.git`) and URL-style
 * (`https://github.com/owner/repo.git`, `ssh://git@host/owner/repo`). Returns
 * null for shapes we can't confidently parse (so the caller disables provider UI).
 */
export function parseRemoteUrl(remote: string): RepoRef | null {
  const url = remote.trim()
  if (!url) return null

  let host: string
  let pathname: string

  const scp = url.match(/^[^@]+@([^:]+):(.+)$/)
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

async function primaryRemoteUrlOf(cwd: string): Promise<string | null> {
  try {
    const output = await runAsync('git', ['-c', 'safe.directory=*', 'config', '--get-regexp', '^remote\\..*\\.url$'], cwd)
    return primaryRemoteUrl(parseRemoteUrls(output))
  } catch {
    // Exit 1: no remote, or not a repository.
    return null
  }
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
