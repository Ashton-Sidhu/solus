import { describe, expect, test } from 'bun:test'
import {
  computeChoices,
  createHostFailureMessage,
  defaultComputeHost,
  defaultSize,
  machineTargets,
  newCloudHostLabel,
  newCloudHostRequest,
  reachability,
  sizeSummary,
  type ComputeHost,
} from '@solus/workspace-ui/components/onboarding/lib/cloud-compute'
import { managedHostNeedsStart } from '@solus/client-core/known-host'

// Where a cloud account's agents can run (docs/plans/cloud-onboarding.md §3.1, §7.4).
// The cloud host belongs to the organization; a linked machine is its owner's
// until the owner shares it.

const ACCOUNT = { userId: 'ada', activeOrganizationId: 'org_acme' }
const ORGANIZATION = { organizationId: 'org_acme', name: 'Acme' }

const cloudHost: ComputeHost = {
  id: 'cloud', label: 'Cloud · Acme', readiness: 'unreachable',
  uplink: { hostId: 'h_cloud', directoryUrl: 'https://app', kind: 'cloud', hasManagedCompute: true, organizationIds: ['org_acme'], managedState: 'stopped' },
}
const otherOrganizationHost: ComputeHost = {
  id: 'cloud-2', label: 'Cloud · Other', readiness: 'ready',
  uplink: { hostId: 'h_other', directoryUrl: 'https://app', kind: 'cloud', organizationIds: ['org_other'] },
}
const adaLaptop: ComputeHost = {
  id: 'laptop', label: 'Ada’s Mac', readiness: 'ready',
  uplink: { hostId: 'h_laptop', directoryUrl: 'https://app', ownerUserId: 'ada' },
}
const bobServer: ComputeHost = {
  id: 'bob', label: 'Bob’s server', readiness: 'ready',
  uplink: { hostId: 'h_bob', directoryUrl: 'https://app', ownerUserId: 'bob', ownerName: 'Bob', organizationIds: ['org_other', 'org_acme'] },
}

describe('cloud onboarding: where agents run', () => {
  test('the organization’s cloud host is chosen first, even while it is stopped, so an invitee sees it chosen', () => {
    const choices = computeChoices([adaLaptop, cloudHost, bobServer], ACCOUNT)
    expect(choices.cloudHost?.id).toBe('cloud')
    expect(defaultComputeHost(choices)?.id).toBe('cloud')
  })

  test('a cloud host Solus Cloud calls ready but this client cannot reach gives way to a machine that answers', () => {
    const unreachable = { ...cloudHost, uplink: { ...cloudHost.uplink!, managedState: 'ready' as const } }
    expect(defaultComputeHost(computeChoices([unreachable, adaLaptop], ACCOUNT))?.id).toBe('laptop')
    expect(defaultComputeHost(computeChoices([unreachable, bobServer], ACCOUNT))?.id).toBe('bob')
    // Nothing else answers: the cloud host stays chosen, and Continue tries it again.
    expect(defaultComputeHost(computeChoices([unreachable], ACCOUNT))?.id).toBe('cloud')
  })

  test('a cloud host that its operator runs is the organization’s cloud host, and is not waited for while it is down', () => {
    // WHY: the kind says whose machine it is; only managed compute can be started. Choosing
    // an operator's machine that is down would make Continue wait for a start nobody can make.
    const operatorRun: ComputeHost = { id: 'operator', label: 'Build box', readiness: 'ready', uplink: { hostId: 'h_op', directoryUrl: 'https://app', kind: 'cloud', organizationIds: ['org_acme'] } }
    const choices = computeChoices([adaLaptop, operatorRun], ACCOUNT)
    expect(choices.cloudHost?.id).toBe('operator')
    expect(choices.ownMachines.map((server) => server.id)).toEqual(['laptop'])
    expect(defaultComputeHost(choices)?.id).toBe('operator')
    expect(reachability(operatorRun)).toBe('Ready')
    const down = { ...operatorRun, readiness: 'unreachable' as const }
    expect(defaultComputeHost(computeChoices([adaLaptop, down], ACCOUNT))?.id).toBe('laptop')
    expect(reachability(down)).toBe('Can’t reach it')
  })

  test('a row says whether this client reaches the machine, not only whether it runs', () => {
    const ready = { ...cloudHost, uplink: { ...cloudHost.uplink!, managedState: 'ready' as const } }
    expect(reachability({ ...ready, readiness: 'ready' })).toBe('Ready')
    // WHY: a host not reached yet is being dialed; "Offline" there read as a dead machine.
    expect(reachability({ ...ready, readiness: 'checking' })).toBe('Connecting…')
    expect(reachability({ ...ready, readiness: 'reconnecting' })).toBe('Connecting…')
    expect(reachability({ ...ready, readiness: 'unreachable' })).toBe('Can’t reach it')
    expect(reachability({ ...ready, readiness: 'refused' })).toBe('Can’t reach it')
    expect(reachability(cloudHost)).toBe('Stopped')
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
    const paired: ComputeHost = { id: 'paired', label: 'Studio', readiness: 'ready' }
    expect(computeChoices([paired], ACCOUNT).ownMachines.map((server) => server.id)).toEqual(['paired'])
  })

  test('with nothing up and no cloud host, no machine is chosen', () => {
    const offline: ComputeHost = { ...adaLaptop, readiness: 'unreachable' }
    expect(defaultComputeHost(computeChoices([offline], ACCOUNT))).toBeNull()
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

describe('cloud onboarding: the choices of "Where your agents run"', () => {
  const catalog = {
    sizes: [{ id: 'standard', label: 'Standard', detail: '8 vCPUs; memory grows as the work needs it.' }],
    defaultSize: 'standard',
    supportsPackages: true,
    supportsSetupScript: true,
  }
  const mayCreate = { mayCreateManagedHost: true }
  const mayNot = { mayCreateManagedHost: false }

  test('an invitee is offered the organization’s cloud host, and can still use a computer of their own', () => {
    const choices = computeChoices([adaLaptop, { ...cloudHost, label: 'Acme' }, bobServer], ACCOUNT)
    expect(machineTargets(choices, mayNot, catalog)).toEqual({ cloud: true, own: true })
  })

  test('a new organization may create its cloud host of the default size', () => {
    expect(machineTargets(computeChoices([], ACCOUNT), mayCreate, catalog)).toEqual({ cloud: true, own: true })
    // WHY: the new host is named for the organization, so it reads as its own everywhere.
    expect(newCloudHostLabel(null)).toBe('Cloud host')
    expect(defaultSize(catalog)?.id).toBe('standard')
    expect(sizeSummary(catalog.sizes[0])).toBe('8 vCPUs; memory grows as the work needs it.')
    expect(sizeSummary({ id: 'l', label: 'Large', detail: '', cpus: 8, memoryGb: 32 })).toBe('8 CPU · 32 GB')
  })

  test('with no cloud host to use or make, only a computer of their own is offered', () => {
    const choices = computeChoices([], ACCOUNT)
    // WHY: an older Solus Cloud sends no catalog, and one that cannot make hosts sends no sizes.
    for (const [organization, offered] of [[mayNot, catalog], [mayCreate, undefined], [mayCreate, { sizes: [], defaultSize: null, supportsPackages: false, supportsSetupScript: false }]] as const) {
      expect(machineTargets(choices, organization, offered)).toEqual({ cloud: false, own: true })
    }
  })

  test('the organization’s host rules remove what its owners turned off', () => {
    const choices = computeChoices([adaLaptop, { ...cloudHost, label: 'Acme' }, bobServer], ACCOUNT)
    // WHY: an invitee must not be offered a computer the organization will refuse to share.
    const cloudOnly = { ...mayNot, hostRules: { allowsCloudHosts: true, allowsPersonalHosts: false } }
    expect(machineTargets(choices, cloudOnly, catalog)).toEqual({ cloud: true, own: false })
    const ownOnly = { ...mayNot, hostRules: { allowsCloudHosts: false, allowsPersonalHosts: true } }
    expect(machineTargets(choices, ownOnly, catalog)).toEqual({ cloud: false, own: true })
    // Cloud only, and no cloud host yet that this member may make: nothing to choose.
    expect(machineTargets(computeChoices([], ACCOUNT), cloudOnly, catalog)).toEqual({ cloud: false, own: false })
  })
})

describe('the create request for a new cloud host', () => {
  // WHY: onboarding could not name the cloud host or give it packages; the host came up
  // as "Acme" with nothing on it, and the person had to find its page to fix that.
  const size = { id: 'standard', label: 'Standard', detail: '', cpus: 4, memoryGb: 16 }
  const catalog = { sizes: [size], defaultSize: 'standard', supportsPackages: true, supportsSetupScript: true }
  const form = { name: '', size, packages: '', setupScript: '' }

  test('an empty form is the organization-named default host', () => {
    expect(newCloudHostRequest(form, ORGANIZATION, catalog)).toEqual({ ok: true, label: 'Acme', spec: { size: 'standard' } })
  })

  test('the name, packages, and setup script the person gave are asked for', () => {
    const request = newCloudHostRequest(
      { name: '  Build box ', size, packages: 'ripgrep, postgresql-client\nripgrep', setupScript: '  npm i -g pnpm\n' },
      ORGANIZATION,
      catalog,
    )
    expect(request).toEqual({
      ok: true,
      label: 'Build box',
      spec: { size: 'standard', packages: ['ripgrep', 'postgresql-client'], setupScript: 'npm i -g pnpm' },
    })
  })

  test('a package name Solus Cloud would refuse stops the request and says which', () => {
    const request = newCloudHostRequest({ ...form, packages: 'ripgrep rm;-rf Node' }, ORGANIZATION, catalog)
    expect(request).toEqual({ ok: false, error: 'Not an apt package name: rm;-rf, Node' })
  })

  test('a field the catalog does not offer is never sent', () => {
    const plain = { ...catalog, supportsPackages: false, supportsSetupScript: false }
    const request = newCloudHostRequest({ ...form, packages: 'ripgrep', setupScript: 'echo hi' }, ORGANIZATION, plain)
    expect(request).toEqual({ ok: true, label: 'Acme', spec: { size: 'standard' } })
  })
})
