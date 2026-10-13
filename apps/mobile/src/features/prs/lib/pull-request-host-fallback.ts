// Adapted from T3 Code apps/mobile/src/features/pull-requests/pullRequestEnvironmentFallback.ts (MIT, see UPSTREAM.md).
import type { PullRequestRef } from '../pull-request-directory'

/** One host's checkout of a project, as the thread directory lists it. */
export interface PullRequestCheckout {
  readonly hostId: string
  readonly projectPath: string
  /** Lowercase `host/owner/repo`; null for a folder with no hosted remote. */
  readonly repositoryKey: string | null
}

/**
 * Another connected host with a checkout of the pull request's repository,
 * for when the host it was opened on cannot be reached. The repository is
 * `repositoryKey` (from the device copy of the pull request) or, without
 * one, the repository of the route's own checkout. Null while the route's
 * host is connected or no other checkout exists.
 */
export function pullRequestFallbackHost(
  ref: PullRequestRef,
  repositoryKey: string | null,
  checkouts: readonly PullRequestCheckout[],
  connectedHostIds: ReadonlySet<string>,
): { hostId: string; projectPath: string } | null {
  if (connectedHostIds.has(ref.hostId)) return null
  const key = repositoryKey
    ?? checkouts.find((checkout) => checkout.hostId === ref.hostId && checkout.projectPath === ref.projectPath)?.repositoryKey
  if (!key) return null
  const copy = checkouts.find((checkout) =>
    checkout.hostId !== ref.hostId
    && connectedHostIds.has(checkout.hostId)
    && checkout.repositoryKey?.toLowerCase() === key.toLowerCase())
  return copy ? { hostId: copy.hostId, projectPath: copy.projectPath } : null
}
