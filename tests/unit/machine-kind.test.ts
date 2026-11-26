import { afterEach, expect, test } from 'bun:test'
import { adoptRegistration, cloudOrganizationId, hasManagedCompute, machineKind, resetMachineKindForTests } from '@solus/server/host/machine-kind'

// plans/034-one-cloud-machine-kind.md §2: a machine is `personal` or `cloud`. Only a
// registration that names an organization makes a cloud machine. The kind decides the
// security rules (no pairing, no trusted network position, no owner), so nothing a
// client or an environment says may set it. `hasManagedCompute` is an operation fact
// of a cloud machine: who starts, stops, and updates its compute.
//
// A cloud machine stays one for the life of its process: its data is its
// organization's, so no later registration change opens a credential-free door on it.
// (`uplink-link.test.ts` and `host-authentication.test.ts` have the record that keeps
// the kind across a restart.)

afterEach(resetMachineKindForTests)

test('a machine with no registration is personal', () => {
  expect(machineKind()).toBe('personal')
  expect(cloudOrganizationId()).toBeNull()
  expect(hasManagedCompute()).toBe(false)
  adoptRegistration(null)
  expect(machineKind()).toBe('personal')
  // A person's desktop or their own standalone server, registered to their account.
  adoptRegistration({})
  expect(machineKind()).toBe('personal')
  expect(cloudOrganizationId()).toBeNull()
})

test('a registration that names an organization makes a cloud machine of that organization', () => {
  adoptRegistration({ organizationId: 'org_1' })
  expect(machineKind()).toBe('cloud')
  expect(cloudOrganizationId()).toBe('org_1')
})

test('managed compute is a fact of a cloud machine only, and only when its registration says so', () => {
  // WHY: the flag never makes a machine a cloud machine, and means nothing without an organization.
  adoptRegistration({ hasManagedCompute: true })
  expect(machineKind()).toBe('personal')
  expect(hasManagedCompute()).toBe(false)
  // A machine its operator started with an organization code: Solus does not run its compute.
  adoptRegistration({ organizationId: 'org_1' })
  expect(hasManagedCompute()).toBe(false)
  adoptRegistration({ organizationId: 'org_1', hasManagedCompute: false })
  expect(hasManagedCompute()).toBe(false)
  adoptRegistration({ organizationId: 'org_1', hasManagedCompute: true })
  expect(hasManagedCompute()).toBe(true)
  expect(machineKind()).toBe('cloud')
})

test.each([
  ['its registration ended', null],
  ['a registration that names no organization', {}],
] as const)('a cloud machine stays a cloud machine of its organization when %s', (_why, next) => {
  // WHY: a deleted machine still holds its organization's sessions. If the kind went back to
  // `personal`, the pairing door and the trusted loopback would open on that data with no restart.
  adoptRegistration({ organizationId: 'org_1', hasManagedCompute: true })
  adoptRegistration(next)
  expect(machineKind()).toBe('cloud')
  expect(cloudOrganizationId()).toBe('org_1')
  expect(hasManagedCompute()).toBe(true)
})
