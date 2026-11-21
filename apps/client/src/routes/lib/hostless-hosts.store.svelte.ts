import { SvelteMap } from 'svelte/reactivity'
import { preferredRouteUrl } from '@solus/client-core/server-connection'
import { hostCatalog, type AnswerState } from '@solus/client-core/host-catalog'
import type { KnownHost } from '@solus/client-core/known-host'
import { toasts } from '@solus/workspace-ui/lib/toasts'
import { probeServingOrigin, type OfferedHost } from '../../lib/add-host'
import { probeServer } from '../../lib/connect'

export class HostlessHostsStore {
  /** The hosts this browser knows, as the host catalog joins them (plans/033). */
  servers = $state<KnownHost[]>([...hostCatalog.hosts()])
  /** Whether the account directory answered; a failed read offers Retry (§3 Q2). */
  directoryState = $state<AnswerState>(hostCatalog.directoryState())
  servingHost = $state<OfferedHost | null>(null)
  readonly reachable = new SvelteMap<string, boolean>()
  private generation = 0

  start(origin: string): () => void {
    const generation = ++this.generation
    const refreshServer = async (server: KnownHost) => {
      this.reachable.delete(server.id)
      // A directory host has no address of its own: it is probed on the route it would be dialed on.
      const url = preferredRouteUrl(server)
      if (!url) return
      const health = await probeServer(url)
      if (generation === this.generation && this.servers.some((known) => known.id === server.id && preferredRouteUrl(known) === url)) {
        this.reachable.set(server.id, health.ok)
      }
    }
    const stopChanges = hostCatalog.onChange(() => {
      const urlBefore = new Map(this.servers.map((server) => [server.id, preferredRouteUrl(server)]))
      this.servers = [...hostCatalog.hosts()]
      this.directoryState = hostCatalog.directoryState()
      for (const server of this.servers) {
        if (urlBefore.get(server.id) !== preferredRouteUrl(server)) void refreshServer(server)
      }
      for (const serverId of this.reachable.keys()) {
        if (!this.servers.some((server) => server.id === serverId)) this.reachable.delete(serverId)
      }
    })
    void probeServingOrigin(origin).then((serving) => {
      if (generation === this.generation) this.servingHost = serving && !serving.known ? serving.offered : null
    })
    for (const server of this.servers) void refreshServer(server)
    return () => {
      this.generation += 1
      stopChanges()
    }
  }

  /** Keeps a host this browser just paired: its credential, then its listing on the person's list. */
  async keepPaired(server: KnownHost): Promise<void> {
    const { host, listError } = await hostCatalog.pair(server)
    if (listError) toasts.error(`${host.label} is paired here but not yet on your host list`)
  }

  /** Forgets a host here: off the person's list, then its credential. */
  async forget(serverId: string): Promise<void> {
    try {
      await hostCatalog.forget(serverId)
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : String(error))
    }
  }
}
