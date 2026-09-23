import type { HostIdentity } from '../../../contexts/sharing/shares.store.svelte'

/**
 * Where a host row keeps a person's connections (docs/plans/cloud-service-model.md §26).
 * A host's owner connects on each host, signed in or not, so the row shows the
 * host's own controls. A member of a cloud-managed host points to the account
 * website. Agent seats are a separate section on the selected execution host.
 */
export interface ConnectionsHomeInput {
  /** Who this client is to the host; undefined until the host has answered. */
  identity: HostIdentity | undefined
  /** The account origin the host is listed under; undefined when it has none. */
  directoryUrl: string | undefined
}

/** The cloud page to point at, or null when this row shows the sections itself. */
export function cloudConnectionsPointerUrl({ identity, directoryUrl }: ConnectionsHomeInput): string | null {
  if (identity?.accountConnectionsUrl) return identity.accountConnectionsUrl
  if (!directoryUrl || identity?.principal !== 'org-member') return null
  return new URL('/connections', directoryUrl).toString()
}
