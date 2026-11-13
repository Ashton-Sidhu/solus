import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { configureUplinkAccountSource } from '@solus/client-core/uplink-account'
import type { UplinkAccountSource } from '@solus/client-core/uplink-session'
import type { AccountResponse } from '@solus/contracts/uplink'

// docs/plans/host-fleet.md D9: the fleet UI manages Solus Cloud machines through one
// store. A new machine is only worth opening once the directory lists it, and an
// action on a host that is not a cloud machine must never reach Solus Cloud.

interface FakeServer { id: string; uplink?: { hostId: string; directoryUrl: string; kind?: 'personal' | 'managed' } }

const toastErrors: string[] = []
const directory = {
  /** What the next directory read lists. */
  listing: (): FakeServer[] => [],
  reads: 0,
  removed: [] as string[],
}
const servers = {
  servers: [] as FakeServer[],
  activeOrganizationId: null as string | null,
  organizations: [] as Array<{ organizationId: string }>,
  refreshDirectory: async () => {
    directory.reads += 1
    servers.servers = directory.listing()
  },
  remove: async (serverId: string) => {
    directory.removed.push(serverId)
    servers.servers = servers.servers.filter((server) => server.id !== serverId)
  },
  startManagedHost: async () => true,
}

mock.module('@solus/workspace-ui/lib/toasts', () => ({ toasts: { error: (message: string) => { toastErrors.push(message) }, success() {}, info() {} } }))
mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({ serversStore: servers }))
const previousState = (globalThis as unknown as { $state?: unknown }).$state
;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value

const { ManagedHostsStore } = await import('@solus/workspace-ui/contexts/connections/managed-hosts.store.svelte')

afterAll(() => {
  configureUplinkAccountSource(null)
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const DIRECTORY_URL = 'https://app.solus.test'
const cloudMachine = (hostId: string, serverId: string): FakeServer => ({ id: serverId, uplink: { hostId, directoryUrl: DIRECTORY_URL, kind: 'managed' } })
const laptop: FakeServer = { id: 'laptop', uplink: { hostId: 'host_laptop', directoryUrl: DIRECTORY_URL, kind: 'personal' } }

function accountWith(organizationIds: string[]): AccountResponse {
  return {
    userId: 'u1',
    onboardingCompletedAt: null,
    activeOrganizationId: null,
    organizations: organizationIds.map((organizationId) => ({ organizationId, name: organizationId, role: 'owner', mayCreateManagedHost: true, hostRules: { allowsCloudHosts: true, allowsPersonalHosts: true } })),
  }
}

/** An account source that records each call that would reach Solus Cloud. */
function account(overrides: Partial<UplinkAccountSource> = {}): string[] {
  const calls: string[] = []
  configureUplinkAccountSource({
    listDirectory: async () => null,
    accessToken: async () => null,
    isSignedOut: () => false,
    issueEnrollmentTicket: async () => null,
    loadOrganizationDirectory: async () => null,
    startManagedHost: async (hostId) => { calls.push(`start ${hostId}`); return 'starting' },
    removeHost: async (hostId) => { calls.push(`remove ${hostId}`); return true },
    stopManagedHost: async (hostId) => { calls.push(`stop ${hostId}`); return 'stopping' },
    restartManagedHost: async (hostId) => { calls.push(`restart ${hostId}`); return 'starting' },
    updateManagedHostSpec: async (hostId) => { calls.push(`spec ${hostId}`); return true },
    deleteManagedHost: async (hostId) => { calls.push(`delete ${hostId}`); return true },
    createManagedHost: async (organizationId) => { calls.push(`create ${organizationId}`); return { ok: true, hostId: 'host_new' } },
    readAccount: async () => accountWith(['org_1']),
    ...overrides,
  })
  return calls
}

beforeEach(() => {
  toastErrors.length = 0
  directory.listing = () => []
  directory.reads = 0
  directory.removed = []
  servers.servers = []
  servers.activeOrganizationId = null
  servers.organizations = []
})

describe('the organization a machine is created in', () => {
  test("the window's organization, else the account's only one", async () => {
    account()
    const store = new ManagedHostsStore()
    expect(store.organizationId).toBeNull()
    expect(store.canCreate).toBe(false)

    await store.loadCatalog()
    expect(store.organizationId).toBe('org_1')
    expect(store.canCreate).toBe(true)

    servers.organizations = [{ organizationId: 'org_1' }, { organizationId: 'org_2' }]
    expect(store.organizationId).toBeNull()
    servers.activeOrganizationId = 'org_2'
    expect(store.organizationId).toBe('org_2')
  })
})

describe('creating a cloud machine', () => {
  test('answers the new host only once the directory lists it', async () => {
    const calls = account()
    // The machine appears on the third directory read, as a slow listing would.
    directory.listing = () => (directory.reads >= 3 ? [cloudMachine('host_new', 'install_new')] : [])
    servers.activeOrganizationId = 'org_1'
    const store = new ManagedHostsStore({ listingTimeoutMs: 5_000, listingPollMs: 1 })

    expect(await store.create({ label: 'Build box' })).toBe('install_new')
    expect(calls).toEqual(['create org_1'])
    expect(directory.reads).toBe(3)
    expect(store.busy).toBeNull()
    expect(store.error).toBeNull()
  })

  test('a machine the directory never lists gives no host and says why', async () => {
    account()
    servers.activeOrganizationId = 'org_1'
    const store = new ManagedHostsStore({ listingTimeoutMs: 5, listingPollMs: 1 })

    expect(await store.create({ label: 'Build box' })).toBeNull()
    expect(store.error).not.toBeNull()
    expect(toastErrors).toEqual([store.error!])
  })

  test('a refusal names its reason and still reads the directory', async () => {
    account({ createManagedHost: async () => ({ ok: false, code: 'rate_limited', message: null }) })
    servers.activeOrganizationId = 'org_1'
    const store = new ManagedHostsStore()

    expect(await store.create({ label: 'Build box' })).toBeNull()
    expect(store.error).toBe('Too many tries. Wait a minute and try again.')
    expect(directory.reads).toBe(1)
  })
})

describe('acting on a machine', () => {
  test('a host that is not a cloud machine is refused without a request', async () => {
    const calls = account()
    servers.servers = [laptop]
    const store = new ManagedHostsStore()

    expect(await store.start('laptop')).toBe(false)
    expect(await store.stop('laptop')).toBe(false)
    expect(await store.restart('laptop')).toBe(false)
    expect(await store.updateSetup('laptop', { packages: ['ripgrep'] })).toBe(false)
    expect(await store.delete('laptop')).toBe(false)
    expect(calls).toEqual([])
    expect(directory.removed).toEqual([])
    expect(store.error).toBe('This host is not a Solus Cloud machine.')
  })

  test('stop and restart call Solus Cloud with the machine host id and read the directory again', async () => {
    const calls = account()
    directory.listing = () => [cloudMachine('host_cloud', 'install_cloud')]
    servers.servers = directory.listing()
    const store = new ManagedHostsStore()

    expect(await store.stop('install_cloud')).toBe(true)
    expect(await store.restart('install_cloud')).toBe(true)
    expect(calls).toEqual(['stop host_cloud', 'restart host_cloud'])
    expect(directory.reads).toBe(2)
    expect(store.busy).toBeNull()
  })

  test('a refused stop says why and leaves no action running', async () => {
    account({ stopManagedHost: async () => null })
    servers.servers = [cloudMachine('host_cloud', 'install_cloud')]
    const store = new ManagedHostsStore()

    expect(await store.stop('install_cloud')).toBe(false)
    expect(store.error).toBe('Solus Cloud did not stop the machine.')
    expect(store.busy).toBeNull()
  })

  // A machine keeps the size it was made with: the change type has no size, so none can be sent.
  test('a setup change goes to Solus Cloud with the machine host id', async () => {
    const calls = account()
    servers.servers = [cloudMachine('host_cloud', 'install_cloud')]
    const store = new ManagedHostsStore()

    expect(await store.updateSetup('install_cloud', { packages: ['ripgrep'] })).toBe(true)
    expect(calls).toEqual(['spec host_cloud'])
  })

  test('delete destroys the machine, then the saved host leaves this client', async () => {
    const calls = account()
    servers.servers = [cloudMachine('host_cloud', 'install_cloud')]
    const store = new ManagedHostsStore()

    expect(await store.delete('install_cloud')).toBe(true)
    expect(calls).toEqual(['delete host_cloud'])
    expect(directory.removed).toEqual(['install_cloud'])
  })

  test('a refused delete keeps the host and says why', async () => {
    account({ deleteManagedHost: async () => false })
    servers.servers = [cloudMachine('host_cloud', 'install_cloud')]
    const store = new ManagedHostsStore()

    expect(await store.delete('install_cloud')).toBe(false)
    expect(directory.removed).toEqual([])
    expect(store.error).toContain('did not delete')
  })
})
