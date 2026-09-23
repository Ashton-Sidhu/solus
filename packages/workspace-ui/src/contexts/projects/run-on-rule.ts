import type { ProjectRef } from './project-catalog'

/**
 * Where a new session of a project runs when nobody chose a host
 * (docs/plans/project-model.md §6): the most recently used checkout on a host
 * that is up, else the organization's managed host — started first when it is
 * stopped — which clones the project. Null when neither is available: the run
 * picker then says so; it never moves the session to some other machine
 * silently.
 */

export interface RunOnHost {
  serverId: string
  online: boolean
  /** A host Solus cloud runs for the organization (docs/plans/managed-hosts.md). */
  managed: boolean
}

export type RunOnChoice =
  /** Run in this checkout on its host. */
  | { serverId: string; path: string }
  /** Run on the managed host, which has no checkout yet: Send starts it when
   *  it is stopped, then clones the project. */
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
  const managed = executionHosts.find((host) => host.managed && host.online)
    ?? executionHosts.find((host) => host.managed)
  return managed ? { serverId: managed.serverId, path: null } : null
}
