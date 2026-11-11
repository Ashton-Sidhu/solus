import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import type { AppState } from '@solus/contracts/apps'

export type AppRead =
  | { phase: 'idle' | 'loading' }
  | { phase: 'ready'; state: AppState }
  | { phase: 'error'; message: string }

const IDLE: AppRead = { phase: 'idle' }

/**
 * What the host says of each app (docs/plans/apps.md §7), one entry for each
 * work: its roles, its permissions, its host access, and the network hosts in
 * force. An answer is for one content version: a newer page or a host access
 * decision reads again; a read in flight is shared. A failed read can be
 * retried.
 */
export class AppsStore {
  private readonly values = new SvelteMap<string, AppRead>()
  private readonly reads = new Map<string, Promise<void>>()

  read(workId: string): AppRead {
    return this.values.get(workId) ?? IDLE
  }

  /** Loads the app unless the kept answer already is this content version. */
  load(api: HostApi, workId: string, contentVersion?: number): Promise<void> {
    const pending = this.reads.get(workId)
    if (pending) return pending
    const current = this.values.get(workId)
    if (current?.phase === 'ready' && (contentVersion === undefined || current.state.contentVersion >= contentVersion)) return Promise.resolve()
    return this.run(workId, api.appRead({ workId }))
  }

  /** The host's owner allows what the app asks of the host, or revokes it (§6). */
  decideHostAccess(api: HostApi, workId: string, allow: boolean): Promise<void> {
    return this.run(workId, api.appHostAccessDecide({ workId, allow }))
  }

  /** A ready answer stays while its replacement loads; an error replaces it only when there was none. */
  private run(workId: string, request: Promise<AppState>): Promise<void> {
    const before = this.values.get(workId)
    if (before?.phase !== 'ready') this.values.set(workId, { phase: 'loading' })
    const read = request
      .then(
        (state) => {
          this.values.set(workId, { phase: 'ready', state })
        },
        (error) => {
          if (before?.phase !== 'ready') this.values.set(workId, { phase: 'error', message: error instanceof Error ? error.message : 'Could not load this app.' })
        },
      )
      .finally(() => this.reads.delete(workId))
    this.reads.set(workId, read)
    return read
  }
}

export const appsStore = new AppsStore()
