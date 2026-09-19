import type { SavedServerUplink } from '@solus/client-core/server-registry'

/**
 * Which name a host row prints.
 *
 * A saved entry's label is a guess frozen at pairing time — the address the user
 * dialed, or whatever the host called itself back then. It never moves again: the
 * account directory records the label the host enrolled with, and `/health`
 * withholds the machine name over a tunnel, so a remote or SaaS client has no
 * other way to notice that the machine has since been renamed. The capability
 * record does: it rides the authenticated connection and reloads on every
 * reconnect.
 *
 * A managed host is "Cloud", one word (docs/plans/managed-hosts.md): its machine
 * name is an identifier nobody chose, and every surface answers "where does this
 * run", not which machine. Which team it serves belongs to Connections.
 *
 * A cloud row is the organization's workspace service
 * (docs/plans/cloud-service-model.md): its label is the organization's name, as
 * the directory said it, and the service reports no machine name worth printing
 * over it. Connections prefixes it with "Solus Cloud"; a list badge says only
 * "Solus Cloud", because the organization is implied by the account.
 *
 * The exception is a name the user typed. Renaming the machine must not rewrite
 * their wording, so `hasUserLabel` outranks the host's own answer.
 */
export const CLOUD_HOST_LABEL = 'Cloud'
export const SOLUS_CLOUD_LABEL = 'Solus Cloud'

export function hostRowLabel(
  saved: { label: string; hasUserLabel?: boolean; uplink?: Pick<SavedServerUplink, 'kind'> },
  reportedName: string | undefined,
): string {
  if (saved.hasUserLabel) return saved.label
  if (saved.uplink?.kind === 'managed') return CLOUD_HOST_LABEL
  if (saved.uplink?.kind === 'cloud') return saved.label
  return reportedName || saved.label
}

/** The Connections row for a workspace service: "Solus Cloud · <organization>". */
export function cloudConnectionsLabel(organizationName: string): string {
  return organizationName ? `${SOLUS_CLOUD_LABEL} · ${organizationName}` : SOLUS_CLOUD_LABEL
}
