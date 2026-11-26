import type { HostRegistration, MachineKind } from '@solus/contracts/uplink'

/**
 * What kind of machine this process is (plans/034-one-cloud-machine-kind.md §2). A
 * registration that names an organization makes it a `cloud` machine of that
 * organization: the control plane made it through a compute provider, or an operator
 * started it with an organization link code. Every other machine is `personal`: the
 * desktop app's host, and a standalone server that a person pairs or links. The kind
 * decides the security and data rules: a cloud machine is nobody's machine, so it has
 * no pairing, no trusted network position, no owner, and no Local work.
 *
 * A cloud machine stays one. Its data is its organization's, so the kind does not go
 * back to `personal` when its registration ends: the boot adopts what the data
 * directory remembers (`readStoredCloudMachine`), and a registration that ends while
 * the process runs changes nothing here.
 */

/** The organization id every unassigned record on a host carries (organization-scope §3). */
export const LOCAL_ORGANIZATION_ID = 'local'

/** What makes a machine a cloud machine: its one organization, and who operates its compute. */
export type CloudMachineFacts = Pick<HostRegistration, 'organizationId' | 'hasManagedCompute'>

let cloudOrganization: string | null = null
let managedCompute = false

/** The boot, and every later registration change, name the machine's registration, or what the data directory remembers of it. */
export function adoptRegistration(registration: CloudMachineFacts | null): void {
  if (!registration?.organizationId) return
  cloudOrganization = registration.organizationId
  managedCompute = registration.hasManagedCompute === true
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
