import type { ProjectRef } from './project-catalog'

/**
 * Where a new session of a project runs when nobody chose a host
 * (docs/plans/project-model.md §6): the most recently used checkout on a host
 * that is up, else the organization's cloud host, which clones the project. A
 * cloud host that is down is chosen only when it has managed compute: Send starts
 * it first. Null when none is available: the run picker then says so; it never
 * moves the session to some other machine silently.
 */

export interface RunOnHost {
  serverId: string
  online: boolean
  /** A cloud machine of the organization (docs/plans/managed-hosts.md). */
  cloud: boolean
  /** Solus Cloud operates its compute, so a stopped one can be started. */
  hasManagedCompute: boolean
}

export type RunOnChoice =
  /** Run in this checkout on its host. */
  | { serverId: string; path: string }
  /** Run on the cloud host, which has no checkout yet: Send starts its managed
   *  compute when that is stopped, then clones the project. */
  | { serverId: string; path: null }

export function chooseRunOnHost(
  checkoutsMostRecentFirst: readonly ProjectRef[],
  executionHosts: readonly RunOnHost[],
  /** A host the person just named (cloud onboarding's chosen machine), asked
   *  first: a more recent checkout elsewhere must not outrank their choice. */
  preferredServerId?: string,
): RunOnChoice | null {
  const preferred = executionHosts.filter((host) => host.serverId === preferredServerId)
  if (preferred.length > 0) {
    const choice = chooseRunOnHost(checkoutsMostRecentFirst, preferred)
    if (choice) return choice
  }
  const online = new Set(executionHosts.filter((host) => host.online).map((host) => host.serverId))
  const checkout = checkoutsMostRecentFirst.find((entry) => online.has(entry.serverId))
  if (checkout) return { serverId: checkout.serverId, path: checkout.projectRoot }
  const cloudHost = executionHosts.find((host) => host.cloud && host.online)
    ?? executionHosts.find((host) => host.hasManagedCompute)
  return cloudHost ? { serverId: cloudHost.serverId, path: null } : null
}
