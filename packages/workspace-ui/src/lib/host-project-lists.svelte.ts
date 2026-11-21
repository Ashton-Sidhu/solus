import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { onServerRemoving } from '@solus/client-core/server-registry'
import type { HostEventName } from '@solus/contracts/host-events'

interface KeptList<T> {
  /** `loading`: the first read runs. `error`: it failed, or the host is older than the read; the next `ensure` reads again. */
  status: 'loading' | 'loaded' | 'error'
  value: T
}

/** The kept lists of one host, by project folder (`''` for none). */
interface HostLists<T> {
  lists: SvelteMap<string, KeptList<T>>
  /** Bumped by every read of a list, so an older answer does not land. */
  reads: Map<string, number>
  stopWatching: () => void
}

export interface HostProjectListsOptions<T> {
  read(api: HostApi, projectPath: string | undefined): Promise<T>
  /** What a list shows before its first read lands, and when that read fails. */
  empty: T
  /** The host events that read every kept list of that host again. */
  rereadOn: readonly HostEventName[]
}

/**
 * One list for each host and project folder, read when a surface first asks
 * and kept. A reader gets the kept list at once and never waits on the
 * network. The `rereadOn` events and a reconnect read the kept lists of that
 * host again; the old list shows until the new one lands, and a failed read
 * keeps it. A removed host's lists and subscriptions go.
 */
export class HostProjectLists<T> {
  readonly #hosts = new SvelteMap<string, HostLists<T>>()
  readonly #options: HostProjectListsOptions<T>
  #followsRemovals = false

  constructor(options: HostProjectListsOptions<T>) {
    this.#options = options
  }

  /** The kept list; `empty` before the first read. It allocates nothing: the menus read it on each keystroke. */
  listFor(serverId: string, projectPath: string | undefined): T {
    return this.#hosts.get(serverId)?.lists.get(projectPath ?? '')?.value ?? this.#options.empty
  }

  /** Reads the list when it was never read, or its last read failed; a kept list stays fresh through events. */
  ensure(serverId: string, projectPath: string | undefined): void {
    const status = this.#hosts.get(serverId)?.lists.get(projectPath ?? '')?.status
    if (status === 'loading' || status === 'loaded') return
    void this.#load(serverId, projectPath ?? '')
  }

  /** Reads every kept list of the host again. */
  reload(serverId: string): void {
    for (const projectPath of this.#hosts.get(serverId)?.lists.keys() ?? []) void this.#load(serverId, projectPath)
  }

  async #load(serverId: string, projectPath: string): Promise<void> {
    const host = this.#hostLists(serverId)
    const read = (host.reads.get(projectPath) ?? 0) + 1
    host.reads.set(projectPath, read)
    const kept = host.lists.get(projectPath)
    if (kept?.status !== 'loaded') host.lists.set(projectPath, { status: 'loading', value: this.#options.empty })
    const isCurrent = () => this.#hosts.get(serverId) === host && host.reads.get(projectPath) === read
    try {
      const value = await this.#options.read(serverConnections.apiFor(serverId), projectPath || undefined)
      if (isCurrent()) host.lists.set(projectPath, { status: 'loaded', value })
    } catch {
      if (isCurrent() && host.lists.get(projectPath)?.status !== 'loaded') {
        host.lists.set(projectPath, { status: 'error', value: this.#options.empty })
      }
    }
  }

  #hostLists(serverId: string): HostLists<T> {
    const known = this.#hosts.get(serverId)
    if (known) return known
    if (!this.#followsRemovals) {
      this.#followsRemovals = true
      onServerRemoving((server) => this.#forget(server.id))
    }
    const events = serverConnections.eventsFor(serverId)
    const stops = this.#options.rereadOn.map((topic) => events.subscribe(topic, () => this.reload(serverId)))
    stops.push(serverConnections.onReadinessChange((hostId, readiness) => {
      if (hostId === serverId && readiness === 'ready') this.reload(serverId)
    }))
    const host: HostLists<T> = { lists: new SvelteMap(), reads: new Map(), stopWatching: () => { for (const stop of stops) stop() } }
    this.#hosts.set(serverId, host)
    return host
  }

  #forget(serverId: string): void {
    this.#hosts.get(serverId)?.stopWatching()
    this.#hosts.delete(serverId)
  }
}
