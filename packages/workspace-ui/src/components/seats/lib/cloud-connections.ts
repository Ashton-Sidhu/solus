import { organizationConnectionsUrl } from '../../../contexts/connections/host-routes'
import type { HostIdentity } from '../../../contexts/sharing/shares.store.svelte'

/**
 * Where a host row keeps a person's connections (docs/plans/cloud-service-model.md).
 * A cloud row holds them itself, so it shows the sections. A runner linked to an
 * organization points a member at the cloud page instead, so the member never
 * overwrites the host's own connections. The host's owner, a guest, and a
 * signed-out client keep the host's sections: they have no cloud page to go to.
 */
export interface ConnectionsHomeInput {
  isCloudHost: boolean
  /** Who this client is to the host; undefined until the host has answered. */
  identity: HostIdentity | undefined
  /** The account origin the host is listed under; undefined when it has none. */
  directoryUrl: string | undefined
}

/** The cloud page to point at, or null when this row shows the sections itself. */
export function cloudConnectionsPointerUrl({ isCloudHost, identity, directoryUrl }: ConnectionsHomeInput): string | null {
  if (isCloudHost || identity?.principal !== 'org-member' || !identity.organizationId || !directoryUrl) return null
  return organizationConnectionsUrl(directoryUrl, identity.organizationId)
}
