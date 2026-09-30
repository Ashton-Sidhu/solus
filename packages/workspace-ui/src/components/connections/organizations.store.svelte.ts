import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { toasts } from '../../lib/toasts'

/**
 * One machine's standing in its organizations (docs/plans/organization-scope.md
 * §3.1, §6.1), as `hostOrganizations` answers it: its category, the account that
 * linked it, each organization's policy, and the Insights opt-ins made on this
 * host. Read per machine; `host.organizationsChanged` replaces the whole status.
 * The workspace service is never asked: it is not a machine.
 */
class OrganizationsStore {
  readonly statusByServer = new SvelteMap<string, HostOrganizationsStatus>()
  readonly errorByServer = new SvelteMap<string, string>()
  private readonly loadingServerIds = new SvelteSet<string>()
  private readonly busyKeys = new SvelteSet<string>()
  private stopListening: (() => void) | null = null

  statusFor(serverId: string): HostOrganizationsStatus | undefined {
    return this.statusByServer.get(serverId)
  }

  isLoading(serverId: string): boolean {
    return this.loadingServerIds.has(serverId)
  }

  /** Whether the opt-in of one organization on one host is being changed. */
  isBusy(serverId: string, organizationId: string): boolean {
    return this.busyKeys.has(`${serverId}|${organizationId}`)
  }

  /** Subscribe once; every host's snapshot replaces what this store holds for it. */
  listen(): () => void {
    if (this.stopListening) return this.stopListening
    this.stopListening = subscribeAllHosts('host.organizationsChanged', (serverId, status) => {
      this.statusByServer.set(serverId, status)
    })
    return () => {
      this.stopListening?.()
      this.stopListening = null
    }
  }

  async refresh(serverId: string): Promise<void> {
    if (this.loadingServerIds.has(serverId)) return
    this.loadingServerIds.add(serverId)
    try {
      this.statusByServer.set(serverId, await serverConnections.apiFor(serverId).hostOrganizations())
      this.errorByServer.delete(serverId)
    } catch (error) {
      // An older host without the method, or one that is away: the section says so.
      this.errorByServer.set(serverId, error instanceof Error ? error.message : String(error))
    } finally {
      this.loadingServerIds.delete(serverId)
    }
  }

  /** Opts this machine's work for one organization into its Insights while that organization's policy is off (§6.1). */
  async setInsightsOptIn(serverId: string, organizationId: string, enabled: boolean): Promise<void> {
    const key = `${serverId}|${organizationId}`
    if (this.busyKeys.has(key)) return
    this.busyKeys.add(key)
    try {
      this.statusByServer.set(serverId, await serverConnections.apiFor(serverId).hostSetInsightsOptIn(organizationId, enabled))
    } catch (error) {
      toasts.error('Could not change the Insights setting', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      this.busyKeys.delete(key)
    }
  }
}

export const organizationsStore = new OrganizationsStore()
