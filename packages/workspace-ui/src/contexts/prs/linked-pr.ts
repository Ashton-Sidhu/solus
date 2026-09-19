import { parseGitHubPullRequestUrl, type PullRequest } from '@solus/contracts/providers'
import type { TaskLink, TaskPrSnapshot, TaskSidebarPrLink } from '@solus/contracts/task-types'

export type PrLink = TaskLink | TaskSidebarPrLink

export interface LinkedPr {
  key: string
  number: number
  targetScope: string
  title: string
  url: string | null
  pullRequest: PullRequest | TaskPrSnapshot | null
}

/** Resolve identity before accessing a cache. URLs are authoritative; a legacy
 * path remains a scope until the host resolves its Git remote. */
export function linkedPrIdentity(link: PrLink, fallbackScope: string | null): Omit<LinkedPr, 'pullRequest'> | null {
  if ('kind' in link && link.kind !== 'pr') return null
  const parsed = link.url ? parseGitHubPullRequestUrl(link.url) : null
  const number = parsed?.number ?? ('number' in link ? link.number : Number(link.targetKey))
  const targetScope = parsed
    ? `${parsed.baseRepo.host}/${parsed.baseRepo.owner}/${parsed.baseRepo.repo}`.toLowerCase()
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

/** Prefer a newer saved host observation to a stale client response. At equal
 * timestamps the full live record retains viewer-specific review attention. */
export function latestPrObservation(live: PullRequest | TaskPrSnapshot | null | undefined, saved?: PullRequest | TaskPrSnapshot | null): PullRequest | TaskPrSnapshot | null {
  if (!saved) return live ?? null
  if (!live || Date.parse(saved.updatedAt) > Date.parse(live.updatedAt)) return saved
  return live
}
