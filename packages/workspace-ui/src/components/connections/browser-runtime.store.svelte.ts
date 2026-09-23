import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import type { BrowserRuntimeStatus } from '@solus/contracts/browser-runtime'

interface RuntimeEntry {
  status: BrowserRuntimeStatus | null
  pending: boolean
  error: string
  revision: number
}

interface RuntimeWatch {
  count: number
  timer?: ReturnType<typeof setTimeout>
  stop(): void
}

export class BrowserRuntimeStore {
  readonly entries = new SvelteMap<string, RuntimeEntry>()
  private readonly watches = new Map<string, RuntimeWatch>()

  watch(serverId: string): () => void {
    let watch = this.watches.get(serverId)
    if (!watch) {
      watch = {
        count: 0,
        stop: serverConnections.onStatusChange((hostId, status) => {
          if (hostId !== serverId) return
          if (status === 'connected') void this.refresh(serverId)
          else {
            clearTimeout(this.watches.get(serverId)?.timer)
            const entry = this.entries.get(serverId)
            if (entry) {
              entry.revision++
              entry.pending = false
              entry.error = 'Host disconnected. Reconnect to check browser setup.'
            }
          }
        }),
      }
      this.watches.set(serverId, watch)
      void this.refresh(serverId)
    }
    watch.count++
    return () => {
      if (--watch.count > 0) return
      clearTimeout(watch.timer)
      watch.stop()
      this.watches.delete(serverId)
      const entry = this.entries.get(serverId)
      if (entry) entry.revision++
    }
  }

  async refresh(serverId: string, install = false): Promise<void> {
    let entry = this.entries.get(serverId)
    if (!entry) {
      const initial = $state<RuntimeEntry>({ status: null, pending: false, error: '', revision: 0 })
      this.entries.set(serverId, initial)
      entry = this.entries.get(serverId)!
    }
    const revision = ++entry.revision
    entry.pending = true
    entry.error = ''
    const watch = this.watches.get(serverId)
    clearTimeout(watch?.timer)
    try {
      const api = serverConnections.apiFor(serverId)
      const status = await (install ? api.browserRuntimeInstall() : api.browserRuntimeStatus())
      if (entry.revision !== revision) return
      entry.status = status
      if (status.phase === 'installing' && watch) {
        watch.timer = setTimeout(() => void this.refresh(serverId), 1500)
      }
    } catch (error) {
      if (entry.revision !== revision) return
      entry.error = error instanceof Error ? error.message : 'Could not check browser setup. Update or reconnect this host.'
    } finally {
      if (entry.revision === revision) entry.pending = false
    }
  }
}

export const browserRuntimeStore = new BrowserRuntimeStore()
