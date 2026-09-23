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
 * A managed host reads its name as given on the account site, which members can
 * change (docs/plans/managed-hosts.md); the cloud icon beside it says where it runs.
 * Its machine name is an identifier nobody chose, so when the saved label is only
 * that identifier the row says "Cloud host". It never names the organization.
 *
 * The organization's workspace service is not a host row at all
 * (docs/plans/cloud-service-model.md §15): a record that lives there carries
 * the "Solus Cloud" home label, and the organization is implied by the account.
 *
 * The exception is a name the user typed. Renaming the machine must not rewrite
 * their wording, so `hasUserLabel` outranks the host's own answer.
 */
export const CLOUD_HOST_LABEL = 'Cloud host'
export const SOLUS_CLOUD_LABEL = 'Solus Cloud'

export function hostRowLabel(
  saved: { label: string; hasUserLabel?: boolean; uplink?: Pick<SavedServerUplink, 'kind'> },
  reportedName: string | undefined,
): string {
  if (saved.hasUserLabel) return saved.label
  if (saved.uplink?.kind === 'managed') {
    return saved.label && saved.label !== reportedName ? saved.label : CLOUD_HOST_LABEL
  }
  return reportedName || saved.label
}
