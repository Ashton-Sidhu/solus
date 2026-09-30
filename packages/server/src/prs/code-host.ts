// The code host a project path reads its pull requests through.
//
// PR sync and session orchestration need this without an `IpcContext` to
// resolve it from. Both go through `PrIndex`, so they share an answer with
// whoever asks next and inherit the `gh` CLI fallback.

import type { PullRequest, RepoRef } from '@solus/contracts/providers'
import { resolveRepoRef } from '../git/git-helpers'
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
    : await resolveRepoRef(projectScope)
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
