import { describe, expect, test } from 'bun:test'
import {
  computeChoices,
  createHostFailureMessage,
  defaultComputeHost,
  defaultRunsOn,
  defaultSize,
  newCloudHostLabel,
  machineDetail,
  runsOnOptions,
  serverIdOf,
  sizeSummary,
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

describe('cloud onboarding: the "Runs on" picker', () => {
  const catalog = {
    sizes: [{ id: 'standard', label: 'Standard', detail: '8 vCPUs; memory grows as the work needs it.' }],
    defaultSize: 'standard',
    supportsPackages: true,
    supportsSetupScript: true,
  }
  const mayCreate = { name: 'Acme', mayCreateManagedHost: true }
  const mayNot = { name: 'Acme', mayCreateManagedHost: false }

  test('an invitee starts on the organization’s cloud host, shown as "Cloud · <its name>", and can still pick a computer', () => {
    const choices = computeChoices([adaLaptop, { ...cloudHost, label: 'Acme' }, bobServer], ACCOUNT)
    expect(defaultRunsOn(choices, mayNot, catalog)).toBe('host:cloud')
    expect(runsOnOptions(choices, mayNot, catalog)).toEqual([
      { value: 'host:cloud', label: 'Cloud · Acme', group: 'Solus Cloud' },
      { value: 'host:laptop', label: 'Ada’s Mac', group: 'Your computers' },
      { value: 'host:bob', label: 'Bob’s server', group: 'Shared with Acme' },
      { value: 'link', label: 'Link a computer', group: 'Your computers' },
    ])
  })

  test('a new organization with no machine starts on a new cloud host of the default size', () => {
    const choices = computeChoices([], ACCOUNT)
    expect(defaultRunsOn(choices, mayCreate, catalog)).toBe('new-cloud')
    // WHY: the new host is named for the organization, so the picker already shows the name it will have.
    expect(runsOnOptions(choices, mayCreate, catalog)[0]).toEqual({ value: 'new-cloud', label: 'Cloud · Acme (new)', group: 'Solus Cloud' })
    expect(newCloudHostLabel(null)).toBe('Cloud host')
    expect(defaultSize(catalog)?.id).toBe('standard')
    expect(sizeSummary(catalog.sizes[0])).toBe('8 vCPUs; memory grows as the work needs it.')
    expect(sizeSummary({ id: 'l', label: 'Large', detail: '', cpus: 8, memoryGb: 32 })).toBe('8 CPU · 32 GB')
  })

  test('with no cloud host to use or make, linking a computer is the choice, never an empty picker', () => {
    const choices = computeChoices([], ACCOUNT)
    // WHY: an older Solus Cloud sends no catalog, and one that cannot make hosts sends no sizes.
    for (const [organization, offered] of [[mayNot, catalog], [mayCreate, undefined], [mayCreate, { sizes: [], defaultSize: null, supportsPackages: false, supportsSetupScript: false }]] as const) {
      expect(defaultRunsOn(choices, organization, offered)).toBe('link')
      expect(runsOnOptions(choices, organization, offered).map((option) => option.value)).toEqual(['link'])
    }
    expect(serverIdOf('host:laptop')).toBe('laptop')
    expect(serverIdOf('new-cloud')).toBeNull()
  })

  test('the organization’s host policy removes what its owners turned off', () => {
    const choices = computeChoices([adaLaptop, { ...cloudHost, label: 'Acme' }, bobServer], ACCOUNT)
    // WHY: an invitee must not be offered a computer the organization will refuse to share.
    const cloudOnly = { ...mayNot, allowsOwnMachines: false }
    expect(runsOnOptions(choices, cloudOnly, catalog).map((option) => option.value)).toEqual(['host:cloud'])
    const ownOnly = { ...mayNot, allowsCloudHosts: false }
    expect(runsOnOptions(choices, ownOnly, catalog).map((option) => option.value)).toEqual([
      'host:laptop',
      'host:bob',
      'link',
    ])
    expect(defaultRunsOn(choices, ownOnly, catalog)).toBe('host:laptop')
    // Cloud only, and no cloud host yet that this member may make: nothing to pick.
    expect(defaultRunsOn(computeChoices([], ACCOUNT), cloudOnly, catalog)).toBeNull()
  })
})
