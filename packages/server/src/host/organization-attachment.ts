import { hostCategory } from './host-category'

/**
 * Whether this machine is attached for organization work (organization-vms §1,
 * §4). A self-hosted server that its owner explicitly attached to an
 * organization, and every managed machine, starts new root sessions, tasks,
 * and works in a client's organization on the Solus API; new personal roots are
 * refused there. Records admitted before the attachment keep their saved home.
 *
 * A person's own computer is never attached: sharing it with an organization
 * lets members run on it, and the owner's scratch stays Local. The attachment is
 * persisted with the link (`UplinkLinkManager`), so a restart keeps it and an
 * unlink resets the machine to personal.
 */

let attachedAtSource: () => number | null = () => null

/** The boot installs where the attachment is stored; tests install their own. */
export function useOrganizationAttachment(read: () => number | null): void {
  attachedAtSource = read
}

/** When the machine was attached; null while it is personal. */
export function organizationAttachedAt(): number | null {
  const category = hostCategory()
  if (category === 'personal') return null
  const attachedAt = attachedAtSource()
  if (category === 'managed') return attachedAt ?? 0
  return attachedAt
}

export function isOrganizationAttached(): boolean {
  return organizationAttachedAt() !== null
}
