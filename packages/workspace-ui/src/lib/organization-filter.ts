import { usesWindowFilter, visibleInWindow } from '@solus/client-core/organization-filter'
import { hostCatalog } from '@solus/client-core/host-catalog'

export { LOCAL_ORGANIZATION_ID, visibleInWindow } from '@solus/client-core/organization-filter'

/** Whether a record read from `serverId` shows in this window: a personal host's always (plans/031 rule 1). */
export function recordVisibleInWindow(organizationId: string | undefined, activeOrganizationId: string | null, serverId: string | null | undefined): boolean {
  return visibleInWindow(organizationId, activeOrganizationId, usesWindowFilter(serverId, hostCatalog.cloudHostIds()))
}

/**
 * Whether the organization saves the conversations of its sessions in Solus
 * Cloud, as the directory last said (`DirectoryWorkspace.sessionCloudSync`).
 * An organization that the directory does not list, or that gives no value,
 * saves them. False: each machine is the source of its own sessions, and the
 * Solus API of the organization is not (`client-core/session-home.ts`).
 */
export function savesSessionsToCloud(organizationId: string): boolean {
  return hostCatalog.workspaces().find((workspace) => workspace.organizationId === organizationId)?.sessionCloudSync !== false
}
