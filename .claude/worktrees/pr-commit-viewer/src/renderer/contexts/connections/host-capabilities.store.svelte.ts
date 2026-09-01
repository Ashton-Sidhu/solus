import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { serverConnections } from '@client-core/server-connections'
import type { HostCapabilities } from '../../../shared/types'
import type { HostBooleanCapability } from '@client-core/host-capabilities'

class HostCapabilitiesStore {
  private readonly values = new SvelteMap<string, HostCapabilities>()
  private readonly loadingHosts = new SvelteSet<string>()
  private readonly inFlight = new Map<string, Promise<HostCapabilities>>()

  constructor() {
    serverConnections.onConnectionCreated((connection) => {
      void this.load(connection.serverId)
    })
    serverConnections.onStatusChange((serverId, status) => {
      const resolvedServerId = serverConnections.resolveId(serverId)
      if (status === 'reconnecting') this.values.delete(resolvedServerId)
      if (status === 'connected') void this.load(resolvedServerId)
    })
    queueMicrotask(() => {
      for (const serverId of serverConnections.connectedServerIds()) void this.load(serverId)
    })
  }

  for(serverId: string | null | undefined): HostCapabilities | undefined {
    return serverId ? this.values.get(serverConnections.resolveId(serverId)) : undefined
  }

  supports(serverId: string | null | undefined, key: HostBooleanCapability): boolean {
    return this.for(serverId)?.[key] === true
  }

  isLoading(serverId: string | null | undefined): boolean {
    return !!serverId && this.loadingHosts.has(serverConnections.resolveId(serverId))
  }

  load(serverId: string): Promise<HostCapabilities> {
    serverId = serverConnections.resolveId(serverId)
    const pending = this.inFlight.get(serverId)
    if (pending) return pending

    this.loadingHosts.add(serverId)
    const promise = serverConnections.capabilitiesFor(serverId)
      .then((capabilities) => {
        this.values.set(serverId, capabilities)
        return capabilities
      })
      .finally(() => {
        this.loadingHosts.delete(serverId)
        if (this.inFlight.get(serverId) === promise) this.inFlight.delete(serverId)
      })
    this.inFlight.set(serverId, promise)
    return promise
  }
}

export const hostCapabilitiesStore = new HostCapabilitiesStore()
