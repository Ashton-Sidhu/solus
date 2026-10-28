// The code host a project path reads its pull requests through.
//
// PR sync and session orchestration need this without an `IpcContext` to
// resolve it from.

import type { PrUnavailableReason, PullRequest, RepoRef } from '@solus/contracts/providers'
import { isAbsolute } from 'node:path'
import { PullRequestHead } from '@solus/contracts/repository-key'
import { resolvePrimaryRepoRef, resolvePushHead, resolveRepoRoot } from '../git/git-helpers'
import { providerForRepo } from '../providers/registry'
import type { Provider } from '../providers/types'

export interface CodeHost {
  repo: RepoRef
  provider: Provider
}

const LINK_SCOPE = /^([^/.][^/]*)\/([^/.][^/]*)\/([^/.][^/]*)$/

/** Repository links already name a remote; only filesystem scopes need Git. */
export async function repoForScope(projectScope: string): Promise<RepoRef | null> {
  // PR links store host/owner/repo; older links can still name a local path.
  const scope = LINK_SCOPE.exec(projectScope)
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

/** The head of `branch`: where `git push` sends it from the checkout at
 *  `scope`. A scope that is no checkout here, such as a repository link or
 *  the record of a run on another machine, names the branch of `host`'s
 *  repository. */
export async function pushHeadFor(host: CodeHost, scope: string, branch: string): Promise<PullRequestHead> {
  return (isAbsolute(scope) ? await resolvePushHead(scope, branch) : null) ?? new PullRequestHead(host.repo, branch)
}

/** The pull request into `host`'s repository opened from `head`: its open
 *  one, else its newest. */
export async function pullRequestForHead(host: CodeHost, head: PullRequestHead): Promise<PullRequest | undefined> {
  const rows = (await host.provider.review.getPullRequestsByHead(host.repo, [head])).get(head.key) ?? []
  return rows.find(({ state }) => state === 'open') ?? rows[0]
}
