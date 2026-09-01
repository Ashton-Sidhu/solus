import type { TaskSidebarPrLink } from '@solus/contracts/task-types'
import { samePullRequest } from '../../components/session/lib/task-list'

export interface PrLinkDiscoveryInput {
  taskId: string
  serverId: string
  projectKey: string
  prNumbers: number[]
  prUrls: string[]
  branches: (string | null)[]
  originSessionId: string | null
}

export interface PrLinkDiscoveryAttemptInput {
  sessionId: string
  branch?: string
  isolatedCheckout?: boolean
  linkedAt: number
}

export interface PrLinkDiscoveryAttempt {
  sessionId: string
  branchName: string | null
  /** The branch above is this session's own worktree, so it may claim a pull
   *  request. False for a shared clone, and false for an attempt nothing can
   *  answer for — an unproven claim is the same as no claim. Only unmounted
   *  attempts are read for this; a mounted tab reports its own checkout. */
  isolatedCheckout: boolean
}

/** Every durable task attempt, newest first. A mounted session's live checkout
 * outranks the branch last projected into the task snapshot. */
export function prLinkDiscoveryAttempts(
  attempts: readonly PrLinkDiscoveryAttemptInput[],
  liveBranchForSession: (sessionId: string) => string | null | undefined,
): PrLinkDiscoveryAttempt[] {
  return attempts
    .toSorted((a, b) => b.linkedAt - a.linkedAt || a.sessionId.localeCompare(b.sessionId))
    .map((attempt) => ({
      sessionId: attempt.sessionId,
      branchName: liveBranchForSession(attempt.sessionId) ?? attempt.branch ?? null,
      isolatedCheckout: attempt.isolatedCheckout ?? false,
    }))
}

/**
 * Whether a checkout's observed pull request still has to be written.
 *
 * Discovery re-runs whenever its inputs change, and the host answers every link
 * write with a fresh task detail payload — which is itself one of those inputs.
 * Re-sending an edge the task already records therefore feeds the pass that
 * sent it, so a link is written only when the task does not hold it yet.
 */
export function needsDiscoveredPrLink(
  links: readonly TaskSidebarPrLink[],
  observed: { number: number; url: string },
): boolean {
  return !links.some((link) =>
    link.number === observed.number && samePullRequest(link.url, observed.url))
}

/** The stable inputs that can change which PR belongs to a sidebar task. */
export function prLinkDiscoveryKey(inputs: PrLinkDiscoveryInput[]): string {
  return JSON.stringify(inputs.toSorted((a, b) =>
    a.serverId.localeCompare(b.serverId)
      || a.projectKey.localeCompare(b.projectKey)
      || a.taskId.localeCompare(b.taskId),
  ))
}
