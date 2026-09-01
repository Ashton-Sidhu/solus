// The code host a project path reads its pull requests through.
//
// Two callers need this without an `IpcContext` to resolve it from: the
// reconciler, which polls on nobody's behalf, and task completion, which asks
// what became of a task's other pull requests. Both go through `PrIndex`, so
// they share an answer with whoever asks next and inherit the `gh` CLI
// fallback.

import type { RepoRef } from '@solus/contracts/providers'
import { resolveRepoRef } from '../git/git-helpers'
import { providerForRepo } from '../providers/registry'
import type { Provider } from '../providers/types'
import { prIndex } from './pr-index'

export interface CodeHost {
  repo: RepoRef
  provider: Provider
}

/** Null for a folder with no recognizable remote, or a host Solus cannot read. */
export async function codeHostFor(projectScope: string): Promise<CodeHost | null> {
  const repo = await resolveRepoRef(projectScope)
  if (!repo) return null
  const provider = providerForRepo(repo)
  return provider ? { repo, provider } : null
}

/**
 * Whether the host reports this pull request merged.
 *
 * False when it cannot be read at all, because the question is asked to decide
 * whether work is finished — and an unreadable pull request is not evidence
 * that it is.
 */
export async function pullRequestIsMerged(projectScope: string, number: number): Promise<boolean> {
  const host = await codeHostFor(projectScope)
  if (!host) return false
  try {
    const detail = await prIndex.pullRequest(host.repo, host.provider, number).read()
    return detail.state === 'merged'
  } catch {
    return false
  }
}
