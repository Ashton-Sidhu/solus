import { SvelteMap } from 'svelte/reactivity'
import { loadServers, onServerSaved, onServerRemoving, type SavedServer } from '@solus/client-core/server-registry'
import { probeServingOrigin, type OfferedHost } from '../../lib/add-host'
import { probeServer } from '../../lib/connect'

export class HostlessHostsStore {
  servers = $state<SavedServer[]>(loadServers())
  servingHost = $state<OfferedHost | null>(null)
  readonly reachable = new SvelteMap<string, boolean>()
  private generation = 0

  start(origin: string): () => void {
    const generation = ++this.generation
    const refreshServer = async (server: SavedServer) => {
      this.reachable.delete(server.id)
      const health = await probeServer(server.url)
      if (generation === this.generation && this.servers.some((saved) => saved.id === server.id && saved.url === server.url)) {
        this.reachable.set(server.id, health.ok)
      }
    }
    const stopSaved = onServerSaved((server) => {
      this.servers = loadServers()
      void refreshServer(server)
    })
    const stopRemoving = onServerRemoving((server) => {
      const index = this.servers.findIndex((saved) => saved.id === server.id)
      if (index !== -1) this.servers.splice(index, 1)
      this.reachable.delete(server.id)
    })
    void probeServingOrigin(origin).then((host) => {
      if (generation === this.generation) this.servingHost = host
    })
    for (const server of this.servers) void refreshServer(server)
    return () => {
      this.generation += 1
      stopSaved()
      stopRemoving()
    }
  }

}
