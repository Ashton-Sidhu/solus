import { describe, expect, test } from 'bun:test'
import {
  computeChoices,
  createHostFailureMessage,
  defaultComputeHost,
  machineDetail,
  type ComputeHost,
} from '@solus/workspace-ui/components/onboarding/lib/cloud-compute'
import { managedHostNeedsStart } from '@solus/client-core/server-registry'

// Where a cloud account's agents can run (docs/plans/cloud-onboarding.md §3.1, §7.4).
// The cloud host belongs to the organization; a linked machine is its owner's
// until the owner shares it.

const ACCOUNT = { userId: 'ada', activeOrganizationId: 'org_acme' }
const ORGANIZATION = { organizationId: 'org_acme', name: 'Acme' }

const cloudHost: ComputeHost = {
  id: 'cloud', label: 'Cloud · Acme', status: 'offline',
  uplink: { hostId: 'h_cloud', directoryUrl: 'https://app', kind: 'managed', organizationId: 'org_acme', managedState: 'stopped' },
}
const otherOrganizationHost: ComputeHost = {
  id: 'cloud-2', label: 'Cloud · Other', status: 'online',
  uplink: { hostId: 'h_other', directoryUrl: 'https://app', kind: 'managed', organizationId: 'org_other' },
}
const adaLaptop: ComputeHost = {
  id: 'laptop', label: 'Ada’s Mac', status: 'online',
  uplink: { hostId: 'h_laptop', directoryUrl: 'https://app', ownerUserId: 'ada' },
}
const bobServer: ComputeHost = {
  id: 'bob', label: 'Bob’s server', status: 'online',
  uplink: { hostId: 'h_bob', directoryUrl: 'https://app', ownerUserId: 'bob', ownerName: 'Bob', organizationId: 'org_acme' },
}

describe('cloud onboarding: where agents run', () => {
  test('the organization’s cloud host is chosen first, even while it is stopped, so an invitee sees it chosen', () => {
    const choices = computeChoices([adaLaptop, cloudHost, bobServer], ACCOUNT)
    expect(choices.cloudHost?.id).toBe('cloud')
    expect(defaultComputeHost(choices)?.id).toBe('cloud')
  })

  test('another organization’s cloud host is not this organization’s', () => {
    const choices = computeChoices([otherOrganizationHost, adaLaptop], ACCOUNT)
    expect(choices.cloudHost).toBeNull()
    expect(defaultComputeHost(choices)?.id).toBe('laptop')
  })

  test('machines are split by owner: your own, and those another member shared', () => {
    const choices = computeChoices([adaLaptop, bobServer, cloudHost], ACCOUNT)
    expect(choices.ownMachines.map((server) => server.id)).toEqual(['laptop'])
    expect(choices.sharedMachines.map((server) => server.id)).toEqual(['bob'])
  })

  test('a machine paired to this browser with no owner on record counts as your own', () => {
    const paired: ComputeHost = { id: 'paired', label: 'Studio', status: 'online' }
    expect(computeChoices([paired], ACCOUNT).ownMachines.map((server) => server.id)).toEqual(['paired'])
  })

  test('with nothing up and no cloud host, no machine is chosen', () => {
    const offline = { ...adaLaptop, status: 'offline' }
    expect(defaultComputeHost(computeChoices([offline], ACCOUNT))).toBeNull()
  })

  test('a linked machine says who can see it', () => {
    expect(machineDetail(adaLaptop, ORGANIZATION, true)).toBe('Ready · Only you can see it')
    const shared = { ...adaLaptop, uplink: { ...adaLaptop.uplink!, organizationId: 'org_acme' } }
    expect(machineDetail(shared, ORGANIZATION, true)).toBe('Ready · Shared with Acme')
    expect(machineDetail(bobServer, ORGANIZATION, false)).toBe('Ready · Shared by Bob')
  })
})

describe('Continue on a cloud host', () => {
  test('asks Solus Cloud to start it only when it is stopped or failed, and otherwise only waits', () => {
    // WHY: a start on a host that is ready or still being set up runs a second
    // reconcile beside the first, and made the row say "Starting…" for a host that
    // was up and only not yet reached (2026-09-23).
    expect(managedHostNeedsStart('stopped')).toBe(true)
    expect(managedHostNeedsStart('stopping')).toBe(true)
    expect(managedHostNeedsStart('failed')).toBe(true)
    expect(managedHostNeedsStart('ready')).toBe(false)
    expect(managedHostNeedsStart('provisioning')).toBe(false)
    expect(managedHostNeedsStart('starting')).toBe(false)
    expect(managedHostNeedsStart(undefined)).toBe(false)
  })
})

describe('a create Solus Cloud refused', () => {
  test('names the refusal, so a report says which one it was', () => {
    expect(createHostFailureMessage('managed_provisioning_failed', 'machine: bad request'))
      .toContain('managed_provisioning_failed: machine: bad request')
    expect(createHostFailureMessage('http_502', null)).toContain('http_502')
  })

  test('says "no answer" apart from a refusal, since no answer does not prove no host was made', () => {
    expect(createHostFailureMessage(null, null)).toBe('Solus Cloud did not answer. Check your connection and try again.')
  })
})
