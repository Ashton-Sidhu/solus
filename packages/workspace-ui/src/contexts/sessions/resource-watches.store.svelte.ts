import { SvelteMap } from 'svelte/reactivity'
import type { ResourceWatch } from '@solus/contracts/integrations/resource-watch'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'

/**
 * Each session's resource watches (docs/plans/mcp-first-class.md §11.5), by
 * Solus session id, as `mcpTasksStore` keeps MCP tasks. A conversation asks
 * with `ensure`; the store reads the list from the host that runs the session,
 * then follows `integration.resourceWatchChanged`. While a host is not ready
 * its lists are dropped, so no row shows a state the host may no longer have;
 * when it is ready again they are read before a row shows.
 */
export class ResourceWatchesStore {
  private readonly lists = new SvelteMap<string, ResourceWatch[]>()
  private readonly serverIds = new Map<string, string>()
  private readonly reads = new Map<string, number>()
  private stopWatching: (() => void)[] | null = null

  ensure(serverId: string, sessionId: string): void {
    this.watch()
    const known = this.serverIds.get(sessionId)
    this.serverIds.set(sessionId, serverId)
    if (known !== serverId || (!this.lists.has(sessionId) && !this.reads.has(sessionId))) void this.refresh(sessionId)
  }

  watchesFor(sessionId: string | null | undefined): readonly ResourceWatch[] {
    return (sessionId && this.lists.get(sessionId)) || NO_WATCHES
  }

  /** The row ends from the host's event. */
  async stop(watch: Pick<ResourceWatch, 'id' | 'sessionId'>): Promise<void> {
    const serverId = this.serverIds.get(watch.sessionId)
    if (!serverId) throw new Error('This session is not shown here.')
    await serverConnections.apiFor(serverId).integrationResourceWatchStop({ sessionId: watch.sessionId, id: watch.id })
  }

  private watch(): void {
    if (this.stopWatching) return
    this.stopWatching = [
      subscribeAllHosts('integration.resourceWatchChanged', (serverId, { sessionId, watch }) => {
        if (this.serverIds.get(sessionId) !== serverId) return
        const list = this.lists.get(sessionId)
        // A list not read yet is read whole, with this change in it.
        if (!list) return void this.refresh(sessionId)
        const index = list.findIndex((entry) => entry.id === watch.id)
        this.lists.set(sessionId, index === -1 ? [...list, watch] : list.with(index, watch))
      }),
      serverConnections.onReadinessChange((serverId, status) => {
        for (const [sessionId, owner] of this.serverIds) {
          if (owner !== serverId) continue
          if (status === 'ready') void this.refresh(sessionId)
          else {
            this.lists.delete(sessionId)
            this.reads.set(sessionId, (this.reads.get(sessionId) ?? 0) + 1)
          }
        }
      }),
    ]
  }

  private async refresh(sessionId: string): Promise<void> {
    const serverId = this.serverIds.get(sessionId)
    if (!serverId) return
    const read = (this.reads.get(sessionId) ?? 0) + 1
    this.reads.set(sessionId, read)
    const api = serverConnections.apiFor(serverId)
    // An older host has no such method: no row, as for a session without watches.
    const next = await api.integrationResourceWatchList({ sessionId }).catch(() => null)
    if (this.reads.get(sessionId) !== read || serverConnections.apiFor(serverId) !== api || !next) return
    this.lists.set(sessionId, next)
  }
}

const NO_WATCHES: readonly ResourceWatch[] = []

export const resourceWatchesStore = new ResourceWatchesStore()
