// The code host a project path reads its pull requests through.
//
// PR sync and session orchestration need this without an `IpcContext` to
// resolve it from. Both go through `PrIndex`, so they share an answer with
// whoever asks next and inherit the `gh` CLI fallback.

import type { PrUnavailableReason, PullRequest, RepoRef } from '@solus/contracts/providers'
import { resolvePrimaryRepoRef, resolveRepoRoot } from '../git/git-helpers'
import { providerForRepo } from '../providers/registry'
import type { Provider } from '../providers/types'
import { prIndex } from './pr-index'

export interface CodeHost {
  repo: RepoRef
  provider: Provider
}

/** Repository links already name a remote; only filesystem scopes need Git. */
export async function repoForScope(projectScope: string): Promise<RepoRef | null> {
  // PR links store host/owner/repo; older links can still name a local path.
  const scope = /^([^/.][^/]*)\/([^/.][^/]*)\/([^/.][^/]*)$/.exec(projectScope)
  return scope
    ? { host: scope[1], owner: scope[2], repo: scope[3] }
    : await resolvePrimaryRepoRef(projectScope)
}

/** A project that has no pull requests to read, and why. Not a failure: the
 *  pages show it as a state, so it crosses the wire as its reason. */
export class PrUnavailableError extends Error {
  constructor(readonly reason: PrUnavailableReason, message: string) {
    super(message)
  }
}

/** Why `projectScope` has no repository to read: only asked once there is no
 *  remote, so the ordinary read spends no extra spawn. */
export async function noRemoteError(projectScope: string): Promise<PrUnavailableError> {
  return projectScope && await resolveRepoRoot(projectScope)
    ? new PrUnavailableError('no-remote', 'This repository has no git remote to read pull requests from.')
    : new PrUnavailableError('not-a-repository', 'This folder is not a git repository.')
}

/** Null for a folder with no recognizable remote, or a host Solus cannot read. */
export async function codeHostFor(projectScope: string): Promise<CodeHost | null> {
  const repo = await repoForScope(projectScope)
  if (!repo) return null
  const provider = providerForRepo(repo)
  return provider ? { repo, provider } : null
}

/** The pull request opened from this branch, if the code host has one. */
export async function pullRequestForBranch(host: CodeHost, branch: string): Promise<PullRequest | undefined> {
  const page = await prIndex.list(host.repo, host.provider, '', { state: 'all', head: branch }, 1)
  return page.items.find((candidate) => candidate.headRef === branch)
}
