import { existsSync } from 'fs'
import path from 'path'
import type { GitIdentity, GitState, GitStateOptions, UncommittedFile } from '../../shared/types'
import type { RepoRef } from '../providers/types'
import { createLogger } from '../logger'
import { runAsync } from './exec'
import { getWorkingTreeStats } from './session-snapshots'
import { getDefaultBranchLocal, getExistingPR } from './worktree-manager'

const log = createLogger('main', 'git-helpers')

export function parseStatus(raw: string): { branch: string | null; files: UncommittedFile[]; hasMoreFiles: boolean } {
  let branch: string | null = null
  const files: UncommittedFile[] = []
  let hasMoreFiles = false

  for (const line of raw.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim()
      branch = value === '(detached)' ? null : value
      continue
    }
    if (line.startsWith('#')) continue
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

  return { branch, files, hasMoreFiles }
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
    const [workingTreeStats, prUrl] = await Promise.all([
      getWorkingTreeStats(cwd, status.repoRoot).catch(() => ({ additions: 0, deletions: 0 })),
      status.branch && status.branch !== status.targetBranch
        ? getExistingPR(status.branch, cwd, options.bypassCache === true)
        : Promise.resolve(null),
    ])
    return {
      ...status,
      uncommittedChanges: {
        ...status.uncommittedChanges,
        insertions: workingTreeStats.additions,
        deletions: workingTreeStats.deletions,
      },
      prUrl: prUrl ?? undefined,
    }
  }

  // Identity is the same work `computeGitIdentity` does, so run it alongside the
  // working-tree scan rather than duplicating it — the sidebar's earlier
  // identity call is usually still in flight and gets shared.
  const [identity, statusRaw, inProgressPaths] = await Promise.all([
    computeGitIdentity(cwd),
    runAsync('git', ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], cwd).catch(() => null),
    runAsync('git', ['rev-parse', '--git-path', 'MERGE_HEAD', '--git-path', 'REBASE_HEAD', '--git-path', 'CHERRY_PICK_HEAD'], cwd).catch(() => ''),
  ])
  // A null identity is the ordinary "not a repository" answer, so stay quiet;
  // a repo whose status scan failed is worth a warning.
  if (!identity) return null
  if (statusRaw === null) {
    log.warn(`computeGitState: git status failed for ${cwd}`)
    return null
  }

  const mergeInProgress = inProgressPaths
    .split('\n')
    .some((p) => p.trim() && existsSync(path.resolve(cwd, p.trim())))
  const status = parseStatus(statusRaw)
  return {
    ...identity,
    // `--branch` reports the branch as of this scan; prefer it over identity's
    // separate read so branch and files always describe the same instant.
    branch: status.branch,
    uncommittedChanges: {
      files: status.files,
      hasMoreFiles: status.hasMoreFiles,
      insertions: 0,
      deletions: 0,
      mergeInProgress,
    },
  }
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
    log.warn('resolveRepoRoot failed', {
      cwd: workTree,
      error: err?.message ?? String(err),
      stderr: typeof err?.stderr === 'string' ? err.stderr.trim() : undefined,
      code: err?.code,
      signal: err?.signal,
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
