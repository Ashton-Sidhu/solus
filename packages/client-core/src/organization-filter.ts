/**
 * Which records one window shows (docs/plans/organization-scope.md §2): Local
 * content always, plus the selected organization's. The organization selection
 * is a client filter; it never moves a record.
 *
 * A record from a machine is Local when its organization is absent (a host that
 * predates the field) or `local`; it is the organization's when its organization
 * id names one. A record from the workspace service is that organization's by
 * construction, so the same rule hides it when another organization is selected.
 */

export const LOCAL_ORGANIZATION_ID = 'local'

export function visibleInWindow(organizationId: string | undefined, activeOrganizationId: string | null): boolean {
  if (organizationId === undefined || organizationId === LOCAL_ORGANIZATION_ID) return true
  return organizationId === activeOrganizationId
}
