import { solusApiId } from '@solus/contracts/uplink'
import { ambiguousOrganizationIds, type SavedWorkspace } from '../workspace-registry'
import type { NotificationSource } from './hub-client'

export type { NotificationSource }

export interface NotificationHostEntry {
  serverId: string
  label: string
  /** The installation the host proved; two saved entries of one installation are one source. */
  installationId?: string
}

export interface NotificationSourceList {
  sources: NotificationSource[]
  /** Organization ids two directories list: no source, because no single service answers for them. */
  conflicts: string[]
}

/**
 * Where the notifications hub reads from (plans/015-notifications-hub.md §6):
 * every host this client reaches and every organization home the account
 * directory lists, whatever organization the window has selected.
 */
export function notificationSources(hosts: readonly NotificationHostEntry[], workspaces: readonly SavedWorkspace[]): NotificationSourceList {
  const sources: NotificationSource[] = []
  const seenHosts = new Set<string>()
  for (const host of hosts) {
    const identity = host.installationId ?? host.serverId
    if (seenHosts.has(identity)) continue
    seenHosts.add(identity)
    sources.push({ sourceId: `host:${identity}`, serverId: host.serverId, kind: 'host', label: host.label })
  }
  const ambiguous = ambiguousOrganizationIds(workspaces)
  const seenOrganizations = new Set<string>()
  for (const workspace of workspaces) {
    if (ambiguous.has(workspace.organizationId) || seenOrganizations.has(workspace.organizationId)) continue
    seenOrganizations.add(workspace.organizationId)
    const serverId = solusApiId(workspace.organizationId)
    sources.push({ sourceId: serverId, serverId, kind: 'organization', label: workspace.label, organizationId: workspace.organizationId })
  }
  return { sources, conflicts: [...ambiguous] }
}
