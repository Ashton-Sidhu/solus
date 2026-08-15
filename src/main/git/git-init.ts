import type { GitInitRepositoryResult, GitRepositoryStatus } from '../../shared/types'
import { runAsync } from './exec'
import { resolveRepoRoot } from './git-helpers'

/**
 * The branch a fresh `git init` starts on: the host's configured
 * `init.defaultBranch` when it names a valid ref, else `main`.
 */
export async function resolveInitDefaultBranch(cwd: string): Promise<string> {
  const configured = await runAsync('git', ['config', '--global', '--get', 'init.defaultBranch'], cwd).catch(() => '')
  const trimmed = configured.trim()
  if (!trimmed) return 'main'
  const valid = await runAsync('git', ['check-ref-format', '--branch', trimmed], cwd)
    .then(() => true)
    .catch(() => false)
  return valid ? trimmed : 'main'
}

/** Initializes a Git repository at `cwd`. Never creates a commit. */
export async function initRepository(cwd: string): Promise<GitInitRepositoryResult> {
  const defaultBranch = await resolveInitDefaultBranch(cwd)
  await runAsync('git', ['init', '-b', defaultBranch], cwd)
  return { defaultBranch }
}

/**
 * Whether `cwd` is a Git repository, and if so whether it has any commits and
 * a primary remote. `GitState`/`GitIdentity` collapse "no repository" and "a
 * repository with an unborn HEAD" into the same null answer; this is the
 * distinction the Initialize Git / Publish to GitHub empty states need.
 */
export async function computeGitRepositoryStatus(cwd: string): Promise<GitRepositoryStatus> {
  const repoRoot = await resolveRepoRoot(cwd)
  if (!repoRoot) {
    return { isRepository: false, hasCommits: false, branch: null, primaryRemoteName: null, primaryRemoteUrl: null }
  }
  const [hasCommits, branch, remoteUrl] = await Promise.all([
    runAsync('git', ['rev-parse', '--verify', 'HEAD'], cwd).then(() => true).catch(() => false),
    runAsync('git', ['symbolic-ref', '--short', 'HEAD'], cwd).catch(() => null),
    runAsync('git', ['remote', 'get-url', 'origin'], cwd).catch(() => null),
  ])
  return {
    isRepository: true,
    hasCommits,
    branch,
    primaryRemoteName: remoteUrl ? 'origin' : null,
    primaryRemoteUrl: remoteUrl,
  }
}
