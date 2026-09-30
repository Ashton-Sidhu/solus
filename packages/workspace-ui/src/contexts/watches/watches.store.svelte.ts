import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import type { Watch, WatchChangedEvent } from '@solus/contracts/watch-types'

/**
 * Renderer cache of watches (docs/plans/watches.md). A surface that shows a
 * session's watches holds `watchSession` while it is mounted; pushed
 * `watch.changed` events keep every loaded watch live through `applyChange`,
 * which both client boots call for every host.
 */
export class WatchesStore {
  /** Every watch this client knows, by id. */
  private readonly watches = new SvelteMap<string, Watch>()
  private readonly hostByWatchId = new Map<string, string>()
  /** Why a session's watches could not be read, by session id. */
  readonly loadErrors = new SvelteMap<string, string>()
  private readonly sessionHolds = new Map<string, { count: number; stop: () => void }>()

  /** Keep one session's watches loaded, and reload them when its host
   *  reconnects, until every holder has released it. */
  watchSession(serverId: string, sessionId: string): () => void {
    const hostId = serverConnections.resolveId(serverId)
    const key = `${hostId}\u0000${sessionId}`
    let hold = this.sessionHolds.get(key)
    if (!hold) {
      const stopStatus = serverConnections.onStatusChange((changedHostId, status) => {
        if (changedHostId !== hostId) return
        if (status === 'connected') void this.load(hostId, sessionId)
        else this.loadErrors.set(sessionId, 'Host disconnected. Watch state may be out of date.')
      })
      hold = { count: 0, stop: stopStatus }
      this.sessionHolds.set(key, hold)
      void this.load(hostId, sessionId)
    }
    hold.count++
    return () => {
      if (--hold.count > 0) return
      hold.stop()
      this.sessionHolds.delete(key)
    }
  }

  async load(serverId: string, sessionId: string): Promise<void> {
    try {
      const list = await serverConnections.apiFor(serverId).watchList(sessionId)
      this.loadErrors.delete(sessionId)
      const liveIds = new Set(list.map((watch) => watch.id))
      for (const watch of list) this.put(serverId, watch)
      // A watch the host no longer has was pruned there.
      for (const watch of this.forSession(sessionId)) {
        if (!liveIds.has(watch.id)) {
          this.watches.delete(watch.id)
          this.hostByWatchId.delete(watch.id)
        }
      }
    } catch (error) {
      console.error('watch list load failed', serverId, sessionId, error)
      this.loadErrors.set(sessionId, 'Watches are unavailable. Reconnect or retry.')
    }
  }

  get(watchId: string): Watch | undefined {
    return this.watches.get(watchId)
  }

  /** Newest first, ended watches included. */
  forSession(sessionId: string): Watch[] {
    return [...this.watches.values()]
      .filter((watch) => watch.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Apply a pushed change. Returns the watch as it was before, so a boot can
   *  tell a transition (an end) from a repeat of the same state. */
  applyChange(serverId: string, event: WatchChangedEvent): Watch | undefined {
    const previous = this.watches.get(event.watch.id)
    this.put(serverConnections.resolveId(serverId), event.watch)
    return previous
  }

  pause(watch: Watch): Promise<void> {
    return this.command(watch, (api) => api.watchPause(watch.sessionId, watch.id))
  }

  resume(watch: Watch): Promise<void> {
    return this.command(watch, (api) => api.watchResume(watch.sessionId, watch.id))
  }

  cancel(watch: Watch): Promise<void> {
    return this.command(watch, (api) => api.watchCancel(watch.sessionId, watch.id))
  }

  private async command(
    watch: Watch,
    run: (api: ReturnType<typeof serverConnections.apiFor>) => Promise<Watch | null>,
  ): Promise<void> {
    const serverId = this.hostByWatchId.get(watch.id)
    if (!serverId) throw new Error('The host of this watch is not known.')
    const updated = await run(serverConnections.apiFor(serverId))
    // Null: the watch already moved on (ended, or not paused). The pushed
    // event carries its real state.
    if (updated) this.put(serverId, updated)
  }

  /** Replace one entry; only readers of that watch invalidate. An older copy
   *  arriving late never replaces a newer one. */
  private put(serverId: string, watch: Watch): void {
    const current = this.watches.get(watch.id)
    if (current && current.updatedAt > watch.updatedAt) return
    this.hostByWatchId.set(watch.id, serverId)
    this.watches.set(watch.id, watch)
  }
}
