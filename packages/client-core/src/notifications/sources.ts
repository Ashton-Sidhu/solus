import { solusApiId } from '@solus/contracts/uplink'
import { ambiguousOrganizationIds, type KnownWorkspace } from '../workspace-registry'
import type { NotificationSource } from './hub-client'

export type { NotificationSource }

export interface NotificationHostEntry {
  serverId: string
  label: string
  /** The installation the host proved; two saved entries of one installation are one source. */
  installationId?: string
  /** The host this client runs on. */
  isLocal?: boolean
  /** The address the host is dialed on. */
  url?: string
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
export function notificationSources(hosts: readonly NotificationHostEntry[], workspaces: readonly KnownWorkspace[]): NotificationSourceList {
  const sources: NotificationSource[] = []
  const seenHosts = new Set<string>()
  const distinctHosts: NotificationHostEntry[] = []
  for (const host of hosts) {
    const identity = host.installationId ?? host.serverId
    if (seenHosts.has(identity)) continue
    seenHosts.add(identity)
    distinctHosts.push(host)
  }
  const labelCounts = new Map<string, number>()
  for (const host of distinctHosts) labelCounts.set(host.label, (labelCounts.get(host.label) ?? 0) + 1)
  for (const host of distinctHosts) {
    const identity = host.installationId ?? host.serverId
    const label = (labelCounts.get(host.label) ?? 0) > 1 ? distinctLabel(host) : host.label
    sources.push({ sourceId: `host:${identity}`, serverId: host.serverId, kind: 'host', label })
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

/**
 * Two installations can have one machine name: an old install on the same
 * machine, or two machines with the default name. The page names each source
 * alone, so a label two hosts share says which host it is.
 */
function distinctLabel(host: NotificationHostEntry): string {
  if (host.isLocal) return `${host.label} (this device)`
  const address = addressOf(host.url)
  return address ? `${host.label} (${address})` : host.label
}

function addressOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}
