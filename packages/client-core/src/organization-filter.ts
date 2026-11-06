import { isSolusApiId } from '@solus/contracts/uplink'

/**
 * Which records one window shows (docs/plans/organization-scope.md §2): Local
 * content always, plus the selected organization's. The organization selection
 * is a client filter; it never moves a record. It applies only to records read
 * from a Solus API or a managed host (plans/031 rule 3): a personal host's
 * records are its owner's and show whole, signed in or out.
 *
 * A record from a machine is Local when its organization is absent (a host that
 * predates the field) or `local`; it is the organization's when its organization
 * id names one. A record from the workspace service is that organization's by
 * construction, so the same rule hides it when another organization is selected.
 */

export const LOCAL_ORGANIZATION_ID = 'local'

export function visibleInWindow(organizationId: string | undefined, activeOrganizationId: string | null, usesFilter = true): boolean {
  if (!usesFilter || organizationId === undefined || organizationId === LOCAL_ORGANIZATION_ID) return true
  return organizationId === activeOrganizationId
}

/**
 * Whether records read from `serverId` go through the window filter: a Solus API's
 * and a managed host's do; a personal host's do not. A record whose source is not
 * known keeps the filter.
 */
export function usesWindowFilter(serverId: string | null | undefined, managedHostIds: ReadonlySet<string>): boolean {
  return !serverId || isSolusApiId(serverId) || managedHostIds.has(serverId)
}
