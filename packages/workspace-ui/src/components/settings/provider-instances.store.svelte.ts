import { createSubscriber } from 'svelte/reactivity'
import { ProviderInstancesClient } from '@solus/client-core/provider-instances'
import { serverConnections, type ServerConnections } from '@solus/client-core/server-connections'

export class ProviderInstancesStore {
  constructor(private readonly connections: Pick<ServerConnections, 'apiFor' | 'eventsFor' | 'onReadinessChange'> = serverConnections) {}
  // Entries are a stable cache. Only client views notify the renderer.
  private readonly clients = new Map<string, ProviderInstancesClient>()
  private readonly subscriptions = new Map<string, () => void>()
  client(serverId: string): ProviderInstancesClient {
    let client = this.clients.get(serverId)
    if (!client) {
      const created = new ProviderInstancesClient(() => this.connections.apiFor(serverId))
      client = created
      this.clients.set(serverId, created)
      this.subscriptions.set(serverId, createSubscriber((update) => created.subscribe(update)))
    }
    this.subscriptions.get(serverId)?.()
    return client
  }
  view(serverId: string) { return this.client(serverId).current() }
  watch(serverId: string): () => void {
    const client = this.client(serverId)
    void client.load()
    const stopEvents = this.connections.eventsFor(serverId).subscribe('provider-instances.changed', () => { void client.load() })
    const stopConnection = this.connections.onReadinessChange((changed, readiness) => {
      if (changed !== serverId) return
      if (readiness === 'ready') void client.load()
      else client.clear()
    })
    return () => { stopEvents(); stopConnection() }
  }
}
export const providerInstancesStore = new ProviderInstancesStore()
