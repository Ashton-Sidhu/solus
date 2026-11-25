import { afterEach, expect, test } from 'bun:test'
import { adoptRegistration, cloudOrganizationId, hasManagedCompute, machineKind, resetMachineKindForTests } from '@solus/server/host/machine-kind'

// plans/034-one-cloud-machine-kind.md §2: a machine is `personal` or `cloud`. Only a
// registration that names an organization makes a cloud machine. The kind decides the
// security rules (no pairing, no trusted network position, no owner), so nothing a
// client or an environment says may set it. `hasManagedCompute` is an operation fact
// of a cloud machine: who starts, stops, and updates its compute.

afterEach(resetMachineKindForTests)

test('a machine with no registration is personal', () => {
  expect(machineKind()).toBe('personal')
  expect(cloudOrganizationId()).toBeNull()
  expect(hasManagedCompute()).toBe(false)
  adoptRegistration(null)
  expect(machineKind()).toBe('personal')
})

test('a registration that names an organization makes a cloud machine of that organization; one that names none is personal', () => {
  adoptRegistration({ organizationId: 'org_1' })
  expect(machineKind()).toBe('cloud')
  expect(cloudOrganizationId()).toBe('org_1')
  // A person's desktop or their own standalone server, registered to their account.
  adoptRegistration({})
  expect(machineKind()).toBe('personal')
  expect(cloudOrganizationId()).toBeNull()
})

test('managed compute is a fact of a cloud machine only, and only when its registration says so', () => {
  // A machine its operator started with an organization code: Solus does not run its compute.
  adoptRegistration({ organizationId: 'org_1' })
  expect(hasManagedCompute()).toBe(false)
  adoptRegistration({ organizationId: 'org_1', hasManagedCompute: false })
  expect(hasManagedCompute()).toBe(false)
  adoptRegistration({ organizationId: 'org_1', hasManagedCompute: true })
  expect(hasManagedCompute()).toBe(true)
  expect(machineKind()).toBe('cloud')
  // WHY: the flag never makes a machine a cloud machine, and means nothing without an organization.
  adoptRegistration({ hasManagedCompute: true })
  expect(machineKind()).toBe('personal')
  expect(hasManagedCompute()).toBe(false)
})

test('a registration that ended leaves a personal machine with no managed compute', () => {
  adoptRegistration({ organizationId: 'org_1', hasManagedCompute: true })
  adoptRegistration(null)
  expect(machineKind()).toBe('personal')
  expect(cloudOrganizationId()).toBeNull()
  expect(hasManagedCompute()).toBe(false)
})
