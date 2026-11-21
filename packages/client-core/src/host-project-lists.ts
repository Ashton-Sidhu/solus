import type { HostEventName } from '@solus/contracts/host-events'
import type { HostApi } from './host-api'
import type { HostEventSubscriber } from './host-event-subscriber'

export interface KeptList<T> {
  /** `loading`: the first read runs. `error`: it failed, or the host is older than the read; the next `ensure` reads again. */
  status: 'loading' | 'loaded' | 'error'
  value: T
  /** Why the first read failed; set with `error` only. */
  error?: string
}

/** The kept lists of one host, by project folder (`''` for none). */
interface HostLists<T> {
  lists: Map<string, KeptList<T>>
  /** Bumped by every read of a list, so an older answer does not land. */
  reads: Map<string, number>
  stopEvents: () => void
  stopReconnects: () => void
}

/** How one client reaches its hosts. */
export interface HostListsSource {
  /** The host's API and events now; null while this client has no connection that can read. */
  connection(serverId: string): { api: HostApi; events: HostEventSubscriber } | null
  /** Calls `reconnected` each time the host is ready again, so the lists read what the host sent while it was away. */
  watchReconnects(serverId: string, reconnected: () => void): () => void
  /** Calls `forgotten` when this client removes a host. */
  onForgotten(forgotten: (serverId: string) => void): () => void
}

export interface HostProjectListsOptions<T> {
  read(api: HostApi, projectPath: string | undefined): Promise<T>
  /** What a list shows before its first read lands, and when that read fails. */
  empty: T
  /** The host events that read every kept list of that host again. */
  rereadOn: readonly HostEventName[]
}

export interface HostProjectListsDeps<T> extends HostProjectListsOptions<T> {
  source: HostListsSource
  /**
   * Where the lists are kept. A Svelte client gives a `SvelteMap`, so a menu
   * that reads one list wakes for that list only.
   */
  map<V>(): Map<string, V>
  /** After each change of a list, for a client that renders from a snapshot. */
  onChange?(): void
}

/**
 * One list for each host and project folder, read when a surface first asks
 * and kept, with one rule for desktop, web, and mobile. A reader gets the kept
 * list at once and never waits on the network. The `rereadOn` events and a
 * reconnect read the kept lists of that host again; the old list shows until
 * the new one lands, and a failed read keeps it. A removed host's lists and
 * subscriptions go.
 */
export class HostProjectLists<T> {
  private readonly hosts: Map<string, HostLists<T>>
  private stopForgotten: (() => void) | null = null

  constructor(private readonly deps: HostProjectListsDeps<T>) {
    this.hosts = deps.map()
  }

  /** The kept list with its status; undefined before the first ask. It allocates nothing. */
  keptFor(serverId: string, projectPath: string | undefined): KeptList<T> | undefined {
    return this.hosts.get(serverId)?.lists.get(projectPath ?? '')
  }

  /** The kept list; `empty` before the first read. It allocates nothing: the menus read it on each keystroke. */
  listFor(serverId: string, projectPath: string | undefined): T {
    return this.keptFor(serverId, projectPath)?.value ?? this.deps.empty
  }

  /** Reads the list when it was never read, or its last read failed; a kept list stays fresh through events. */
  ensure(serverId: string, projectPath: string | undefined): void {
    const status = this.keptFor(serverId, projectPath)?.status
    if (status === 'loading' || status === 'loaded') return
    void this.load(serverId, projectPath ?? '')
  }

  /** Reads every kept list of the host again. */
  reload(serverId: string): void {
    for (const projectPath of Array.from(this.hosts.get(serverId)?.lists.keys() ?? [])) void this.load(serverId, projectPath)
  }

  private async load(serverId: string, projectPath: string): Promise<void> {
    const host = this.hostLists(serverId)
    const read = (host.reads.get(projectPath) ?? 0) + 1
    host.reads.set(projectPath, read)
    const isCurrent = () => this.hosts.get(serverId) === host && host.reads.get(projectPath) === read
    if (host.lists.get(projectPath)?.status !== 'loaded') {
      host.lists.set(projectPath, { status: 'loading', value: this.deps.empty })
      this.deps.onChange?.()
    }
    // With no connection the list waits as it is: the reconnect reads it.
    const connection = this.deps.source.connection(serverId)
    if (!connection) return
    try {
      const value = await this.deps.read(connection.api, projectPath || undefined)
      if (!isCurrent()) return
      host.lists.set(projectPath, { status: 'loaded', value })
      this.deps.onChange?.()
    } catch (cause) {
      if (!isCurrent() || host.lists.get(projectPath)?.status === 'loaded') return
      host.lists.set(projectPath, { status: 'error', value: this.deps.empty, error: cause instanceof Error ? cause.message : String(cause) })
      this.deps.onChange?.()
    }
  }

  private hostLists(serverId: string): HostLists<T> {
    const known = this.hosts.get(serverId)
    if (known) return known
    this.stopForgotten ??= this.deps.source.onForgotten((forgotten) => this.forget(forgotten))
    const host: HostLists<T> = { lists: this.deps.map(), reads: new Map(), stopEvents: () => {}, stopReconnects: () => {} }
    // A new connection can come with a reconnect, so the events are followed on the current one.
    const followEvents = () => {
      host.stopEvents()
      const events = this.deps.source.connection(serverId)?.events
      const stops = events ? this.deps.rereadOn.map((topic) => events.subscribe(topic, () => this.reload(serverId))) : []
      host.stopEvents = () => { for (const stop of stops) stop() }
    }
    followEvents()
    host.stopReconnects = this.deps.source.watchReconnects(serverId, () => {
      followEvents()
      this.reload(serverId)
    })
    this.hosts.set(serverId, host)
    return host
  }

  private forget(serverId: string): void {
    const host = this.hosts.get(serverId)
    if (!host) return
    host.stopEvents()
    host.stopReconnects()
    this.hosts.delete(serverId)
    this.deps.onChange?.()
  }
}
