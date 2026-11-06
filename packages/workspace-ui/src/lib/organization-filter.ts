import { usesWindowFilter, visibleInWindow } from '@solus/client-core/organization-filter'
import { managedHostIds } from '@solus/client-core/server-registry'

export { LOCAL_ORGANIZATION_ID, visibleInWindow } from '@solus/client-core/organization-filter'

/** Whether a record read from `serverId` shows in this window: a personal host's always (plans/031 rule 1). */
export function recordVisibleInWindow(organizationId: string | undefined, activeOrganizationId: string | null, serverId: string | null | undefined): boolean {
  return visibleInWindow(organizationId, activeOrganizationId, usesWindowFilter(serverId, managedHostIds()))
}
