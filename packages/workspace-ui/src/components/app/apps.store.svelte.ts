import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import type { AppPermissions, AppSnapshot } from '@solus/contracts/apps'

export type AppRead =
  | { phase: 'idle' | 'loading' }
  | { phase: 'ready'; snapshot: AppSnapshot }
  | { phase: 'error'; message: string }

const IDLE: AppRead = { phase: 'idle' }

/**
 * The composed documents of `app` works (docs/plans/apps.md §7), one per
 * work. A snapshot is for one content version: a newer body, or a permissions
 * change, reads again; a read in flight is shared. A failed read can be retried.
 */
export class AppsStore {
  private readonly values = new SvelteMap<string, AppRead>()
  private readonly reads = new Map<string, Promise<void>>()

  read(workId: string): AppRead {
    return this.values.get(workId) ?? IDLE
  }

  /** Loads the app unless the kept snapshot already is this content version. */
  load(api: HostApi, workId: string, contentVersion?: number): Promise<void> {
    const pending = this.reads.get(workId)
    if (pending) return pending
    const current = this.values.get(workId)
    if (current?.phase === 'ready' && (contentVersion === undefined || current.snapshot.contentVersion >= contentVersion)) return Promise.resolve()
    return this.run(workId, api.appRead({ workId }))
  }

  reload(api: HostApi, workId: string): Promise<void> {
    return this.reads.get(workId) ?? this.run(workId, api.appRead({ workId }))
  }

  setPermissions(api: HostApi, workId: string, permissions: AppPermissions): Promise<void> {
    return this.run(workId, api.appPermissionsUpdate({ workId, permissions }))
  }

  /** A ready snapshot stays on screen while its replacement loads; an error replaces it only when there was none. */
  private run(workId: string, request: Promise<AppSnapshot>): Promise<void> {
    const before = this.values.get(workId)
    if (before?.phase !== 'ready') this.values.set(workId, { phase: 'loading' })
    const read = request
      .then(
        (snapshot) => {
          this.values.set(workId, { phase: 'ready', snapshot })
        },
        (error) => {
          this.values.set(workId, { phase: 'error', message: error instanceof Error ? error.message : 'Could not load this app.' })
        },
      )
      .finally(() => this.reads.delete(workId))
    this.reads.set(workId, read)
    return read
  }
}

export const appsStore = new AppsStore()
