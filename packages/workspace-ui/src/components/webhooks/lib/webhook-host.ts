import type { HostCategory } from '@solus/contracts/uplink'
import { serversStore } from '../../../contexts'
import { organizationsStore } from '../../connections/organizations.store.svelte'
import { webhooksStore } from '../../../contexts/webhooks/webhooks.store.svelte'
import { webhookReachabilityText } from './webhook-reachability'
import { LOCAL_ORGANIZATION_ID } from '../../../lib/organization-filter'
import type { WebhookRow } from './webhooks-view'

/** What kind of machine the host is: its standing first, else what the directory recorded. */
export function hostCategoryFor(serverId: string): HostCategory | undefined {
  const standing = organizationsStore.statusFor(serverId)?.category
  if (standing) return standing
  const host = serversStore.hostFor(serverId)
  return host && 'uplink' in host ? host.uplink?.category : undefined
}

export function hostLabelFor(serverId: string): string {
  return webhooksStore.hosts.find((host) => host.serverId === serverId)?.label ?? serversStore.hostFor(serverId)?.label ?? serverId
}

/** The reachability text of one row (docs/plans/webhooks.md §4). */
export function rowReachabilityText(row: WebhookRow): string | null {
  return webhookReachabilityText(row.webhook.urlMode, webhooksStore.hostSettings.get(row.serverId)?.holdWhileOffline, hostCategoryFor(row.serverId))
}

/** An organization's name; `local` is the person's own work. */
export function organizationLabel(organizationId: string): string {
  if (organizationId === LOCAL_ORGANIZATION_ID) return 'Personal'
  return serversStore.organizations.find((organization) => organization.organizationId === organizationId)?.name ?? organizationId
}
