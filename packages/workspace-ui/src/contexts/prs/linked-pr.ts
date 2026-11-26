import { parseGitHubPullRequestUrl, type PullRequest, type RepoRef } from '@solus/contracts/providers'
import { repositoryKeyOf } from '@solus/contracts/repository-key'
import type { IssueLink, IssuePrSnapshot, IssueSidebarPrLink } from '@solus/contracts/task-types'
import type { IpcContext } from '@solus/contracts/types'

export type PrLink = IssueLink | IssueSidebarPrLink

export interface LinkedPr {
  key: string
  number: number
  targetScope: string
  title: string
  url: string | null
  pullRequest: PullRequest | IssuePrSnapshot | null
  /** PR sync found that the code host has no such pull request. */
  missing: boolean
}

/** Resolve identity before accessing a cache. URLs are authoritative; a legacy
 * path remains a scope until the host resolves its Git remote. */
export function linkedPrIdentity(link: PrLink, fallbackScope: string | null): Omit<LinkedPr, 'pullRequest' | 'missing'> | null {
  if ('kind' in link && link.kind !== 'pr') return null
  const parsed = link.url ? parseGitHubPullRequestUrl(link.url) : null
  const number = parsed?.number ?? ('number' in link ? link.number : Number(link.targetKey))
  const targetScope = parsed
    ? repositoryKeyOf(parsed.baseRepo)
    : link.targetScope || fallbackScope
  if (!targetScope || !Number.isSafeInteger(number) || number <= 0) return null
  return {
    key: `pr:${targetScope}:${number}`,
    number,
    targetScope,
    title: link.title || `#${number}`,
    url: parsed?.url ?? link.url ?? null,
  }
}

/** The repository a repository scope names (`host/owner/repo`); null for a
 *  project's folder. */
export function repositoryOfScope(scope: string): RepoRef | null {
  const match = /^([^/.~][^/]*)\/([^/.][^/]*)\/([^/.][^/]*)$/.exec(scope)
  return match ? { host: match[1], owner: match[2], repo: match[3] } : null
}

/** A context that reads one repository's pull requests rather than a
 *  checkout's: the host resolves a `host/owner/repo` scope to the repository. */
export function repositoryContext(ctx: IpcContext, repository: string): IpcContext {
  return { ...ctx, session: { ...ctx.session, projectPath: repository, workingDirectory: repository, gitContext: null } }
}

/** Prefer a newer saved host observation to a stale client response. At equal
 * timestamps the full live record retains viewer-specific review attention. */
export function latestPrObservation(live: PullRequest | IssuePrSnapshot | null | undefined, saved?: PullRequest | IssuePrSnapshot | null): PullRequest | IssuePrSnapshot | null {
  if (!saved) return live ?? null
  if (!live || Date.parse(saved.updatedAt) > Date.parse(live.updatedAt)) return saved
  return live
}
