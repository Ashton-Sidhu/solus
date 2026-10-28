import { solusApiId } from '@solus/contracts/uplink'
import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { savedWorkspaceFor } from '@solus/client-core/workspace-registry'
import { serversStore } from '../connections/servers.store.svelte'

/** The admin methods of an organization's Solus API (docs/plans/webhooks.md §2.7). */
export type WebhookAdminApi = Pick<HostApi, 'webhookAdminList' | 'webhookAdminPause' | 'webhookAdminResume'>

/**
 * The organization's Solus API. The account's directory names it; it is read
 * again only when this client does not know the service yet.
 */
export async function reachWebhookAdmin(organizationId: string): Promise<WebhookAdminApi> {
  const serviceId = solusApiId(organizationId)
  if (!savedWorkspaceFor(serviceId)) await serversStore.refreshDirectory()
  return serverConnections.apiFor(serviceId)
}
