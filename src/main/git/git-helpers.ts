import { existsSync } from 'fs'
import path from 'path'
import type { GitProjectStatus, GitProjectStatusFile, GitProjectStatusOptions } from '../../shared/types'
import type { RepoRef } from '../providers/types'
import { createLogger } from '../logger'
import { runAsync } from './exec'
import { getWorkingTreeStats } from './session-snapshots'
import { getDefaultBranch, getExistingPR } from './worktree-manager'

const log = createLogger('main', 'git-helpers')

export function parseStatus(raw: string): Pick<GitProjectStatus, 'branch' | 'files'> {
  let branch: string | null = null
  const files: GitProjectStatusFile[] = []

  for (const line of raw.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim()
      branch = value === '(detached)' ? null : value
      continue
    }
    if (line.startsWith('#')) continue
    if (files.length >= 200) continue

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

  return { branch, files }
}

const statusInflight = new Map<string, Promise<GitProjectStatus | null>>()

/**
 * Compute live branch, file, and conflict state for a working tree. The default
 * path deliberately avoids line statistics and PR discovery because it runs on
 * every watcher fire and completed edit. Visible Git UI opts into those details.
 * Concurrent callers for the same cwd/detail level share one process pipeline.
 */
export function computeGitProjectStatus(
  cwd: string,
  options: GitProjectStatusOptions = {},
): Promise<GitProjectStatus | null> {
  if (!cwd || cwd === '~') return Promise.resolve(null)

  const key = `${cwd}\0${options.includeDetails ? 'details' : 'summary'}`
  const existing = statusInflight.get(key)
  if (existing) return existing

  const pending = computeGitProjectStatusUncached(cwd, options)
    .finally(() => {
      if (statusInflight.get(key) === pending) statusInflight.delete(key)
    })
  statusInflight.set(key, pending)
  return pending
}

async function computeGitProjectStatusUncached(
  cwd: string,
  options: GitProjectStatusOptions,
): Promise<GitProjectStatus | null> {
  if (options.includeDetails) {
    // Reuse an in-flight summary from the watcher/renderer instead of starting
    // a second status pipeline when the visible panel asks for details.
    const status = await computeGitProjectStatus(cwd)
    if (!status) return null
    const [workingTreeStats, prUrl] = await Promise.all([
      getWorkingTreeStats(cwd, status.repoRoot).catch(() => ({ additions: 0, deletions: 0 })),
      status.branch && status.branch !== status.targetBranch
        ? getExistingPR(status.branch, cwd)
        : Promise.resolve(null),
    ])
    return {
      ...status,
      insertions: workingTreeStats.additions,
      deletions: workingTreeStats.deletions,
      prUrl: prUrl ?? undefined,
    }
  }

  const repoRoot = await resolveRepoRoot(cwd)
  if (!repoRoot) return null

  try {
    const [statusRaw, inProgressPaths, targetBranch] = await Promise.all([
      runAsync('git', ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], cwd),
      runAsync('git', ['rev-parse', '--git-path', 'MERGE_HEAD', '--git-path', 'REBASE_HEAD', '--git-path', 'CHERRY_PICK_HEAD'], cwd).catch(() => ''),
      getDefaultBranch(cwd),
    ])
    const mergeInProgress = inProgressPaths
      .split('\n')
      .some((p) => p.trim() && existsSync(path.resolve(cwd, p.trim())))
    const status = parseStatus(statusRaw)
    return {
      repoRoot,
      ...status,
      targetBranch,
      insertions: 0,
      deletions: 0,
      mergeInProgress,
    }
  } catch (err: any) {
    log.warn(`computeGitProjectStatus failed for ${cwd}: ${err?.message ?? err}`)
    return null
  }
}

/** Resolve the parent repo root from a worktree path (handles linked + main worktrees). */
export async function resolveRepoRoot(workTree: string): Promise<string | null> {
  try {
    const commonDir = await runAsync('git', ['rev-parse', '--git-common-dir'], workTree)
    const absolute = path.isAbsolute(commonDir) ? commonDir : path.resolve(workTree, commonDir)
    return path.dirname(absolute)
  } catch {
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
