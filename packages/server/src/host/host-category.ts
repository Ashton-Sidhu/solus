import type { EnrollHostCategory, HostCategory, UplinkLinkConfig } from '@solus/contracts/uplink'

/**
 * What kind of machine this process is (organization-scope §3.1). The desktop
 * app's own execution host is `personal`; the standalone server is
 * `self-hosted`; a machine the control plane provisioned is `managed`. The boot
 * declares the first two. The third is a fact of the machine's link: a link that
 * names an owning organization is one Solus provisioned for that organization
 * (managed-hosts.md §2), whether it arrived in the environment at first boot or
 * was stored since. The category is what the host tells the control plane when
 * it enrolls, and what decides provisioning facts: no pairing and no trusted
 * network position on a machine nobody owns.
 */

/** The organization id every unassigned record on a host carries (organization-scope §3). */
export const LOCAL_ORGANIZATION_ID = 'local'

let declared: EnrollHostCategory = 'personal'
let provisionedOrganization: string | null = null

export function applyHostCategory(category: EnrollHostCategory): void {
  declared = category
}

/** The boot, and every later link change, name the machine's link; one that names an owning organization makes the host managed. */
export function adoptProvisionedLink(link: Pick<UplinkLinkConfig, 'organizationId'> | null): void {
  provisionedOrganization = link?.organizationId ?? null
}

export function hostCategory(): HostCategory {
  return provisionedOrganization ? 'managed' : declared
}

/** The organization a managed machine was provisioned for; null on every other machine. Its host-internal records start there. */
export function provisionedOrganizationId(): string | null {
  return provisionedOrganization
}

/** Tests only. */
export function resetHostCategoryForTests(): void {
  declared = 'personal'
  provisionedOrganization = null
}
