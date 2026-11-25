import type { HostRegistration, MachineKind } from '@solus/contracts/uplink'

/**
 * What kind of machine this process is (plans/034-one-cloud-machine-kind.md §2). A
 * registration that names an organization makes it a `cloud` machine of that
 * organization: the control plane made it through a compute provider, or an operator
 * started it with an organization link code. Every other machine is `personal`: the
 * desktop app's host, and a standalone server that a person pairs or links. The kind
 * decides the security and data rules: a cloud machine is nobody's machine, so it has
 * no pairing, no trusted network position, no owner, and no Local work.
 */

/** The organization id every unassigned record on a host carries (organization-scope §3). */
export const LOCAL_ORGANIZATION_ID = 'local'

let cloudOrganization: string | null = null
let managedCompute = false

/** The boot, and every later registration change, name the machine's registration. */
export function adoptRegistration(registration: Pick<HostRegistration, 'organizationId' | 'hasManagedCompute'> | null): void {
  cloudOrganization = registration?.organizationId ?? null
  managedCompute = cloudOrganization !== null && registration?.hasManagedCompute === true
}

export function machineKind(): MachineKind {
  return cloudOrganization ? 'cloud' : 'personal'
}

/** The organization a cloud machine works for; null on a personal machine. Its host-internal records start there. */
export function cloudOrganizationId(): string | null {
  return cloudOrganization
}

/**
 * Whether the control plane operates this machine's compute: it starts, stops, and
 * updates it. False on a personal machine, and on a cloud machine that its operator
 * runs. This decides operation facts only (the activity report, the update source),
 * never a security rule.
 */
export function hasManagedCompute(): boolean {
  return managedCompute
}

/** Tests only. */
export function resetMachineKindForTests(): void {
  cloudOrganization = null
  managedCompute = false
}
