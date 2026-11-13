import { startupAccountRead } from '@solus/client-core/cloud-account'
import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import type { UplinkAccountSource } from '@solus/client-core/uplink-session'
import type { AccountResponse, ManagedHostCatalog, ManagedHostSpecChangeRequest, ManagedHostSpecRequest } from '@solus/contracts/uplink'
import { toasts } from '../../lib/toasts'
import { createHostFailureMessage } from '../../components/onboarding/lib/cloud-compute'
import { serversStore } from './servers.store.svelte'

export type ManagedHostAction = 'create' | 'start' | 'stop' | 'restart' | 'resize' | 'delete'

export interface ManagedHostsTiming {
  /** How long `create` waits for the directory to list the new host. */
  listingTimeoutMs: number
  /** How often `create` reads the directory while it waits. */
  listingPollMs: number
}

const DEFAULT_TIMING: ManagedHostsTiming = { listingTimeoutMs: 30_000, listingPollMs: 2_000 }

/**
 * The lifecycle of Solus Cloud machines from this client (docs/plans/host-fleet.md D9):
 * create, start, stop, restart, change the spec of, and delete an organization's
 * managed host, and the size catalog a new one may take. Every call goes through the
 * account source, so desktop (native bridge) and web (account origin) act the same.
 * The machine's state is the directory's: after each call the directory is read
 * again, and `serversStore` rows show the new `uplink.managedState`.
 */
export class ManagedHostsStore {
  /** Sizes a new or resized machine may have; null until read or when the account has none. */
  catalog = $state<ManagedHostCatalog | null>(null)
  /** The machine an action runs on now, and which action; null when idle. */
  busy = $state<{ serverId: string | null; action: ManagedHostAction } | null>(null)
  /** Why the last action failed, in one sentence for the person; null after a success. */
  error = $state<string | null>(null)
  /** The account's organizations at its last read: the fallback before the directory lists any. */
  private accountOrganizationIds = $state<string[]>([])
  private hasReadAccount = false
  private accountRead: Promise<void> | null = null

  constructor(private readonly timing: ManagedHostsTiming = DEFAULT_TIMING) {}

  /** The organization a new cloud machine is created in: the window's active organization, else the account's only one; null when none. */
  get organizationId(): string | null {
    if (serversStore.activeOrganizationId) return serversStore.activeOrganizationId
    const listed = serversStore.organizations.map((organization) => organization.organizationId)
    const known = listed.length > 0 ? listed : this.accountOrganizationIds
    return known.length === 1 ? known[0] : null
  }

  /** True when this client has an account source and an organization to create in. */
  get canCreate(): boolean {
    return uplinkAccountSource() !== null && this.organizationId !== null
  }

  /**
   * Reads the account for the size catalog. The first read on web takes the answer
   * boot already has; each later call reads again. Calls made while a read runs share it,
   * and a failed read keeps the last catalog.
   */
  loadCatalog(): Promise<void> {
    this.accountRead ??= this.readAccount().finally(() => { this.accountRead = null })
    return this.accountRead
  }

  private async readAccount(): Promise<void> {
    const source = uplinkAccountSource()
    if (!source) return
    const startup = this.hasReadAccount ? null : startupAccountRead()
    this.hasReadAccount = true
    const account: AccountResponse | null = await (startup ?? source.readAccount())
    if (!account) return
    this.catalog = account.managedHostCatalog ?? null
    this.accountOrganizationIds = account.organizations.map((organization) => organization.organizationId)
  }

  /**
   * Creates a cloud machine in `organizationId`. The new host's server id once the
   * directory lists it; null when Solus Cloud refused, or the directory did not list it
   * in time (`error` says which). The directory is read whatever the answer: a create
   * that did not answer may still have made a host.
   */
  async create(options: { label: string; spec?: ManagedHostSpecRequest }): Promise<string | null> {
    const source = uplinkAccountSource()
    const organizationId = this.organizationId
    if (this.busy) return null
    if (!source || !organizationId) {
      this.fail(source ? 'Choose an organization before you create a cloud machine.' : 'Sign in to Solus Cloud to create a cloud machine.')
      return null
    }
    this.busy = { serverId: null, action: 'create' }
    this.error = null
    try {
      const outcome = await source.createManagedHost(organizationId, options)
      if (!outcome.ok) {
        await serversStore.refreshDirectory()
        this.fail(createHostFailureMessage(outcome.code, outcome.message))
        return null
      }
      const deadline = Date.now() + this.timing.listingTimeoutMs
      while (true) {
        await serversStore.refreshDirectory()
        const listed = serversStore.servers.find((server) => server.uplink?.hostId === outcome.hostId)
        if (listed) return listed.id
        if (Date.now() >= deadline) break
        await new Promise((resolve) => setTimeout(resolve, this.timing.listingPollMs))
      }
      this.fail('Solus Cloud made the machine, but your host list does not show it yet. Refresh in a minute.')
      return null
    } finally {
      this.busy = null
    }
  }

  /** Starts a stopped machine and waits until this client reaches it (`serversStore.startManagedHost`). */
  start(serverId: string): Promise<boolean> {
    return this.run(serverId, 'start', async () => {
      return (await serversStore.startManagedHost(serverId)) || 'Solus Cloud did not start the machine, or it did not come up in time.'
    })
  }

  /** Stops a machine; it keeps its disk, and `start` brings it back. */
  stop(serverId: string): Promise<boolean> {
    return this.run(serverId, 'stop', async (source, hostId) => {
      return (await source.stopManagedHost(hostId)) !== null || 'Solus Cloud did not stop the machine.'
    })
  }

  /** Restarts a running machine's Solus service. */
  restart(serverId: string): Promise<boolean> {
    return this.run(serverId, 'restart', async (source, hostId) => {
      return (await source.restartManagedHost(hostId)) !== null || 'Solus Cloud did not restart the machine. Only a running machine restarts.'
    })
  }

  /**
   * Changes the machine's packages or setup script; a running machine restarts to take
   * them. Solus Cloud cannot change the size of a machine that exists, so a spec that
   * names a size is refused here, before any request.
   */
  resize(serverId: string, spec: ManagedHostSpecRequest): Promise<boolean> {
    if (spec.size !== undefined) {
      this.fail('Solus Cloud cannot change the size of a cloud machine. Create a new machine with the size you want.')
      return Promise.resolve(false)
    }
    const change: ManagedHostSpecChangeRequest = {}
    if (spec.packages !== undefined) change.packages = spec.packages
    if (spec.setupScript !== undefined) change.setupScript = spec.setupScript
    return this.run(serverId, 'resize', async (source, hostId) => {
      return (await source.updateManagedHostSpec(hostId, change)) !== null || 'Solus Cloud did not change the machine. Only an organization owner can.'
    })
  }

  /**
   * Destroys the machine and its disk, and ends its registration; the saved host goes
   * from this client too. Not "Forget": that ends only a registration
   * (`serversStore.remove`) and leaves a cloud machine running.
   */
  delete(serverId: string): Promise<boolean> {
    return this.run(serverId, 'delete', async (source, hostId) => {
      if (!(await source.deleteManagedHost(hostId))) return 'Solus Cloud did not delete the machine. Only an organization owner can.'
      // The machine is gone, so edits that only it could take are gone with it.
      await serversStore.remove(serverId, { discardUnsent: true })
      return true
    })
  }

  /**
   * One action on one managed host: refused without a request when the server is not
   * a cloud machine or this client has no account. `call` answers true, or the sentence
   * that says why it failed. The directory is read again either way.
   */
  private async run(
    serverId: string,
    action: Exclude<ManagedHostAction, 'create'>,
    call: (source: UplinkAccountSource, hostId: string) => Promise<true | string>,
  ): Promise<boolean> {
    if (this.busy) return false
    const uplink = serversStore.servers.find((server) => server.id === serverId)?.uplink
    const hostId = uplink?.kind === 'managed' ? uplink.hostId : null
    const source = uplinkAccountSource()
    if (!hostId || !source) {
      this.fail(hostId ? 'Sign in to Solus Cloud to manage this machine.' : 'This host is not a Solus Cloud machine.')
      return false
    }
    this.busy = { serverId, action }
    this.error = null
    try {
      const outcome = await call(source, hostId)
      await serversStore.refreshDirectory()
      if (outcome === true) return true
      this.fail(outcome)
      return false
    } finally {
      this.busy = null
    }
  }

  private fail(message: string): void {
    this.error = message
    toasts.error(message)
  }
}

export const managedHostsStore = new ManagedHostsStore()
