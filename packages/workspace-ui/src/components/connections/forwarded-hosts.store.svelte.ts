import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { loadServers, saveServers, withForwardedRoutes } from '@solus/client-core/server-registry'
import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import type { ForwardedHost } from '@solus/contracts/remote-machines'
import { hosts, serversStore } from '../../contexts'
import { messageFor } from '../servers/lib/setup-rpc'

interface Watcher {
  count: number
  stop: () => void
}

/**
 * The machines a host reaches through an SSH forward it holds (docs/plans/host-routes.md
 * D7, D9), per host. Read with `hostsListForwarded` and kept current by
 * `host.forwardedHostsChanged`. On the machine that holds the forwards (the desktop's
 * own host), the saved routes of those hosts follow the forwards, so a forward that
 * opens again on a new port is still dialed.
 */
class ForwardedHostsStore {
  /** Absent until the host answers; an older host without the method stays absent. */
  readonly hostsByServer = new SvelteMap<string, ForwardedHost[]>()
  /** The forwarded host an action runs on now, by installation id. */
  busyInstallationId = $state<string | null>(null)
  /** The last action's error, by installation id. */
  readonly errorByInstallation = new SvelteMap<string, string>()
  private readonly watchers = new Map<string, Watcher>()
  /** Bumped by each read, so an older answer never overwrites a newer one. */
  private readonly readGenerations = new Map<string, number>()

  hostsFor(serverId: string): ForwardedHost[] | undefined {
    return this.hostsByServer.get(serverId)
  }

  /** Reads the host now, and again on each change and each reconnect. The returned function stops it. */
  watch(serverId: string): () => void {
    const existing = this.watchers.get(serverId)
    if (existing) {
      existing.count++
    } else {
      const stopChanges = serverConnections.eventsFor(serverId).subscribe('host.forwardedHostsChanged', (event) => {
        this.readGenerations.set(serverId, (this.readGenerations.get(serverId) ?? 0) + 1)
        this.apply(serverId, event.hosts)
      })
      const stopReadiness = serverConnections.onReadinessChange((changedId, readiness) => {
        if (changedId === serverId && readiness === 'ready') void this.load(serverId)
      })
      this.watchers.set(serverId, { count: 1, stop: () => { stopChanges(); stopReadiness() } })
    }
    void this.load(serverId)
    return () => {
      const watcher = this.watchers.get(serverId)
      if (!watcher || --watcher.count > 0) return
      watcher.stop()
      this.watchers.delete(serverId)
    }
  }

  async load(serverId: string): Promise<void> {
    const generation = (this.readGenerations.get(serverId) ?? 0) + 1
    this.readGenerations.set(serverId, generation)
    try {
      const forwarded = await serverConnections.apiFor(serverId).hostsListForwarded()
      if (this.readGenerations.get(serverId) === generation) this.apply(serverId, forwarded)
    } catch {
      // An older host without forwards, or one that is not reachable: the section stays hidden.
    }
  }

  async remove(serverId: string, installationId: string, stopRemote: boolean): Promise<boolean> {
    return this.run(installationId, async () => {
      await serverConnections.apiFor(serverId).hostsRemoveForwarded({ installationId, stopRemote })
      // The host sends the new list as well; reading it here shows the change when the event is late.
      await this.load(serverId)
    })
  }

  /** Links the forwarded host to the account with a fresh ticket. The forward stays as a route (D9). */
  async link(serverId: string, installationId: string): Promise<boolean> {
    return this.run(installationId, async () => {
      const link = await uplinkAccountSource()?.issueEnrollmentTicket()
      if (!link) throw new Error('Solus Cloud did not give a link ticket. Sign in and try again.')
      await serverConnections.apiFor(serverId).hostsLinkForwarded({ installationId, link })
      await this.load(serverId)
      void serversStore.refreshDirectory()
    })
  }

  private async run(installationId: string, action: () => Promise<void>): Promise<boolean> {
    if (this.busyInstallationId) return false
    this.busyInstallationId = installationId
    this.errorByInstallation.delete(installationId)
    try {
      await action()
      return true
    } catch (err) {
      this.errorByInstallation.set(installationId, messageFor(err))
      return false
    } finally {
      this.busyInstallationId = null
    }
  }

  private apply(serverId: string, forwarded: ForwardedHost[]): void {
    this.hostsByServer.set(serverId, forwarded)
    // Only the machine that holds the forwards can dial them, so only its saved routes follow them.
    if (serverId !== hosts.device?.id) return
    const next = withForwardedRoutes(loadServers(), forwarded)
    if (!next) return
    saveServers(next)
    serversStore.refreshServers()
    // A connection copies its routes when it is made: re-aim one whose forward moved.
    serverConnections.startCatalogSupervisors()
  }
}

export const forwardedHostsStore = new ForwardedHostsStore()
